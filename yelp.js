/**
 * Yelp Reservation Service
 * 
 * Same hybrid strategy as OpenTable:
 * Parameterized URL → Browserless render → Gemini Flash parse.
 * 
 * Yelp's reservation_* query params trigger availability display
 * directly in search results when restaurants support Yelp Reservations.
 */

import { fetchRenderedPage } from './browserless.js';
import { parseReservationPage } from './gemini.js';
import { buildYelpURL } from '../utils/url-builder.js';

export async function searchYelp({ location, cuisine, date, time, partySize }) {
  const startTime = Date.now();

  try {
    // Step 1: Build the Yelp search URL with reservation filters
    const url = buildYelpURL({ location, cuisine, date, time, partySize });
    console.log(`[Yelp] Fetching: ${url}`);

    // Step 2: Render the page via Browserless
    const html = await fetchRenderedPage(url, {
      timeout: 12000,
      label: 'Yelp',
    });

    if (!html || html.length < 1000) {
      console.warn(`[Yelp] Page too small (${html?.length || 0} bytes), likely blocked or empty`);
      return {
        source: 'yelp',
        results: [],
        latency: Date.now() - startTime,
        error: 'Page returned minimal content — possible bot detection',
      };
    }

    // Check for Yelp's specific block page
    if (html.includes('unusual activity') || html.includes('not a robot')) {
      console.warn(`[Yelp] Bot detection triggered`);
      return {
        source: 'yelp',
        results: [],
        latency: Date.now() - startTime,
        error: 'Yelp bot detection triggered — Browserless stealth mode may need configuration',
      };
    }

    // Step 3: Parse with Gemini Flash
    const results = await parseReservationPage(html, 'yelp', {
      location, cuisine, date, time, partySize,
    });

    // Normalize Yelp URLs
    const normalized = results.map(r => ({
      ...r,
      bookingUrl: r.bookingUrl?.startsWith('http')
        ? r.bookingUrl
        : r.bookingUrl
          ? `https://www.yelp.com${r.bookingUrl}`
          : '',
    }));

    const latency = Date.now() - startTime;
    console.log(`[Yelp] ${normalized.length} restaurants found in ${latency}ms`);

    return { source: 'yelp', results: normalized, latency };
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[Yelp] Failed after ${latency}ms:`, err.message);
    return { source: 'yelp', results: [], latency, error: err.message };
  }
}
