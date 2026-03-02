/**
 * Resy API Service
 * Direct API — no browser needed, no auth required.
 * Returns confirmed available time slots with booking URLs.
 * ~1 second response time.
 */

import fetch from 'node-fetch';
import { getCityCoords } from '../utils/url-builder.js';

const RESY_API = 'https://api.resy.com';
const RESY_API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5'; // Public widget key

export async function searchResy({ location, cuisine, date, partySize }) {
  const startTime = Date.now();

  try {
    const coords = getCityCoords(location);
    if (!coords) {
      console.log(`[Resy] No coordinates for location: ${location}`);
      return { source: 'resy', results: [], latency: Date.now() - startTime };
    }

    // Step 1: Search for restaurants near location
    const searchParams = new URLSearchParams({
      lat: coords.lat,
      long: coords.lng,
      day: date,
      party_size: partySize || 2,
      offset: 0,
      limit: 20,
    });

    const searchRes = await fetch(`${RESY_API}/4/find?${searchParams}`, {
      headers: {
        'Authorization': `ResyAPI api_key="${RESY_API_KEY}"`,
        'X-Resy-Universal-Auth': '',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!searchRes.ok) {
      console.error(`[Resy] API returned ${searchRes.status}`);
      return { source: 'resy', results: [], latency: Date.now() - startTime, error: `HTTP ${searchRes.status}` };
    }

    const data = await searchRes.json();
    const hits = data?.results?.venues || [];

    // Step 2: Transform results into standard format
    const results = [];

    for (const hit of hits) {
      const venue = hit.venue;
      const slots = hit.slots || [];

      if (slots.length === 0) continue;

      // Filter by cuisine if specified
      if (cuisine) {
        const cuisineLower = cuisine.toLowerCase();
        const venueCuisine = (venue?.cuisine || []).map(c => (c.name || c).toLowerCase());
        const venueType = (venue?.type || '').toLowerCase();
        const matchesCuisine = venueCuisine.some(c => c.includes(cuisineLower)) ||
                               venueType.includes(cuisineLower) ||
                               cuisineLower.includes(venueType);
        if (!matchesCuisine && cuisine.toLowerCase() !== 'all') continue;
      }

      // Extract city slug for booking URL
      const citySlug = venue?.location?.city_slug || '';

      const timeSlots = slots.map(slot => {
        const slotDate = slot.date?.start;
        const time = slotDate ? new Date(slotDate).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }) : slot.shift?.time_start;

        return {
          time: time,
          type: slot.config?.type || 'dining_room',
          token: slot.config?.token || null,
        };
      });

      results.push({
        name: venue?.name || 'Unknown',
        cuisine: (venue?.cuisine || []).map(c => c.name || c).join(', '),
        rating: venue?.rating?.average || null,
        priceRange: venue?.price_range || null,
        neighborhood: venue?.location?.neighborhood || '',
        address: venue?.location?.address_1 || '',
        city: venue?.location?.city || '',
        timeSlots: timeSlots.map(s => s.time),
        bookingUrl: `https://resy.com/cities/${citySlug}/${venue?.url_slug}`,
        source: 'resy',
        sourceIcon: '🟢',
        confidence: 'confirmed', // These are real, bookable slots
      });
    }

    const latency = Date.now() - startTime;
    console.log(`[Resy] Found ${results.length} restaurants with availability in ${latency}ms`);

    return { source: 'resy', results, latency };
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[Resy] Error after ${latency}ms:`, err.message);
    return { source: 'resy', results: [], latency, error: err.message };
  }
}
