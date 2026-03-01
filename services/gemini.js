/**
 * Gemini Flash Parser Service
 * 
 * THE KEY INNOVATION: Instead of brittle CSS selectors that break when
 * sites redesign, we feed the rendered HTML to Gemini Flash and ask it
 * to extract structured reservation data semantically.
 * 
 * If OpenTable changes their layout tomorrow, this still works.
 * The AI reads the page like a human would.
 * 
 * Cost: ~$0.001-0.003 per parse at Gemini 3 Flash pricing ($0.50/1M input tokens)
 * Speed: 1-2 seconds per parse
 */

import fetch from 'node-fetch';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash'; // Fast, cheap, great at structured extraction

/**
 * Parse rendered HTML from a reservation platform and extract
 * structured restaurant availability data.
 */
export async function parseReservationPage(html, platform, searchParams) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const startTime = Date.now();

  // Truncate HTML to avoid token limits — keep the main content area
  // Most reservation data is in the first 100KB of rendered HTML
  const truncatedHtml = truncateHtml(html, 80000);

  const prompt = buildExtractionPrompt(platform, searchParams, truncatedHtml);

  try {
    const response = await fetch(
      `${GEMINI_API}/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1, // Low temperature for consistent structured output
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini API returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.warn(`[Gemini] No text in response for ${platform}`);
      return [];
    }

    // Parse the JSON response
    const parsed = JSON.parse(text);
    const restaurants = Array.isArray(parsed) ? parsed : (parsed.restaurants || []);

    // Normalize and validate
    const results = restaurants
      .filter(r => r.name && r.timeSlots && r.timeSlots.length > 0)
      .map(r => ({
        name: r.name || 'Unknown',
        cuisine: r.cuisine || '',
        rating: r.rating || null,
        priceRange: r.priceRange || r.price || null,
        neighborhood: r.neighborhood || '',
        address: r.address || '',
        timeSlots: (r.timeSlots || []).map(normalizeTimeSlot),
        bookingUrl: r.bookingUrl || r.url || '',
        source: platform,
        sourceIcon: platform === 'opentable' ? '🔴' : '🟡',
        confidence: 'parsed', // AI-extracted, high confidence but not API-confirmed
      }));

    const latency = Date.now() - startTime;
    console.log(`[Gemini] Parsed ${results.length} restaurants from ${platform} in ${latency}ms`);

    return results;
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[Gemini] Parse failed for ${platform} after ${latency}ms:`, err.message);
    return [];
  }
}

function buildExtractionPrompt(platform, searchParams, html) {
  const platformContext = {
    opentable: `This is an OpenTable search results page. Restaurants with available reservations will show specific bookable time slots (like "5:30 PM", "6:00 PM", "7:30 PM"). Each time slot is usually a clickable button. The booking URL for each restaurant typically starts with "https://www.opentable.com/r/" or contains "/booking/".`,
    yelp: `This is a Yelp search results page filtered for restaurants with reservations. Restaurants with Yelp Reservations availability will show time slot buttons near "Available" text. The booking URL is typically the Yelp business page URL (https://www.yelp.com/biz/...). Look for time slots displayed as buttons or links near each restaurant listing.`,
  };

  return `You are a precise data extraction system. Extract restaurant reservation availability from this ${platform} search results page HTML.

CONTEXT: ${platformContext[platform] || ''}
SEARCH: Looking for ${searchParams.cuisine || 'any'} restaurants in ${searchParams.location} for ${searchParams.partySize || 2} people on ${searchParams.date} at ${searchParams.time || '7:00 PM'}.

RULES:
- ONLY include restaurants that show ACTUAL available time slots on the page
- Do NOT include restaurants that just say "Make a reservation" without showing specific times
- Extract the exact time slots shown (e.g., "6:30 PM", "7:00 PM", "8:00 PM")
- Extract the booking/reservation URL for each restaurant if visible
- If no restaurants show actual available time slots, return an empty array []

Return a JSON array of objects with this exact schema:
[
  {
    "name": "Restaurant Name",
    "cuisine": "Italian, Pizza",
    "rating": 4.5,
    "priceRange": "$$",
    "neighborhood": "Midtown",
    "address": "123 Main St",
    "timeSlots": ["6:00 PM", "6:30 PM", "7:00 PM", "8:30 PM"],
    "bookingUrl": "https://..."
  }
]

HTML CONTENT:
${html}`;
}

/**
 * Truncate HTML intelligently — try to keep the main content
 * and strip out scripts, styles, and other noise.
 */
function truncateHtml(html, maxChars) {
  // Remove script and style tags entirely
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ');

  if (cleaned.length <= maxChars) return cleaned;

  // Try to find the main content area
  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                    cleaned.match(/id=["'](?:search-results|results|content|main)[^>]*>([\s\S]*)/i);

  if (mainMatch && mainMatch[1].length > 1000) {
    cleaned = mainMatch[1];
  }

  return cleaned.slice(0, maxChars);
}

/**
 * Normalize time slot strings to consistent format
 */
function normalizeTimeSlot(slot) {
  if (typeof slot !== 'string') return String(slot);

  // Already in good format like "7:00 PM"
  if (/\d{1,2}:\d{2}\s*[AP]M/i.test(slot)) {
    return slot.trim().toUpperCase().replace(/\s+/g, ' ');
  }

  // 24-hour format like "19:00"
  const match24 = slot.match(/(\d{1,2}):(\d{2})/);
  if (match24) {
    let hours = parseInt(match24[1]);
    const mins = match24[2];
    const period = hours >= 12 ? 'PM' : 'AM';
    if (hours > 12) hours -= 12;
    if (hours === 0) hours = 12;
    return `${hours}:${mins} ${period}`;
  }

  return slot.trim();
}
