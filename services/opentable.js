/**
 * OpenTable Service
 * 
 * Strategy: Construct the exact search URL → Browserless renders it →
 * Gemini Flash extracts structured availability data.
 * 
 * No CSS selectors. No fragile scraping. The AI reads the page.
 * Target: 3-6 seconds end-to-end.
 */

import { fetchRenderedPage } from './browserless.js';
import { parseReservationPage } from './gemini.js';
import { buildOpenTableURL } from '../utils/url-builder.js';

export async function searchOpenTable({ location, cuisine, date, time, partySize }) {
  const startTime = Date.now();

  try {
    // Step 1: Build the parameterized search URL (0ms)
    const url = buildOpenTableURL({ location, cuisine, date, time, partySize });
    console.log(`[OpenTable] Fetching: ${url}`);

    // Step 2: Render the page via Browserless (2-4 sec)
    const html = await fetchRenderedPage(url, {
      waitForSelector: '[data-test="times-702"]', // OT's time slot container — optional hint
      timeout: 12000,
      label: 'OpenTable',
    });

    if (!html || html.length < 1000) {
      console.warn(`[OpenTable] Page too small (${html?.length || 0} bytes), likely blocked or empty`);
      return {
        source: 'opentable',
        results: [],
        latency: Date.now() - startTime,
        error: 'Page returned minimal content — possible bot detection',
      };
    }

    // Step 3: Parse with Gemini Flash (1-2 sec)
    const results = await parseReservationPage(html, 'opentable', {
      location, cuisine, date, time, partySize,
    });

    // Ensure booking URLs are absolute
    const normalized = results.map(r => ({
      ...r,
      bookingUrl: r.bookingUrl?.startsWith('http')
        ? r.bookingUrl
        : r.bookingUrl
          ? `https://www.opentable.com${r.bookingUrl}`
          : '',
    }));

    const latency = Date.now() - startTime;
    console.log(`[OpenTable] ${normalized.length} restaurants found in ${latency}ms`);

    return { source: 'opentable', results: normalized, latency };
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[OpenTable] Failed after ${latency}ms:`, err.message);
    return { source: 'opentable', results: [], latency, error: err.message };
  }
}
