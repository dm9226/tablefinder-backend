/**
 * Search Orchestrator
 * 
 * The brain of TableFinder. Coordinates parallel searches across
 * Resy, OpenTable, and Yelp with caching and popularity tracking.
 * 
 * Flow:
 * 1. Check cache → hit? Return instantly
 * 2. Cache miss → fire all 3 platforms in parallel
 * 3. Merge, deduplicate, sort results
 * 4. Cache the merged result
 * 5. Track this search pattern anonymously for future optimization
 * 
 * Design for 5-10 second cold response, <100ms cached response.
 */

import { searchResy } from './resy.js';
import { searchOpenTable } from './opentable.js';
import { searchYelp } from './yelp.js';
import { getCached, setCache, buildCacheKey, trackSearch } from './cache.js';

/**
 * Main search function — called by the API endpoint.
 * Returns merged results from all platforms.
 */
export async function searchAll(params) {
  const { location, cuisine, date, time, partySize } = params;
  const searchStart = Date.now();

  // === 1. Check cache ===
  const cacheKey = buildCacheKey(params);
  const cached = await getCached(cacheKey);

  if (cached) {
    console.log(`[Orchestrator] Cache HIT for ${cacheKey}`);
    return {
      ...cached,
      cached: true,
      latency: Date.now() - searchStart,
    };
  }

  console.log(`[Orchestrator] Cache MISS — searching all platforms for: ${location} / ${cuisine || 'any'} / ${date} / ${time} / party ${partySize}`);

  // === 2. Fire all 3 platforms in parallel ===
  const [resyResult, opentableResult, yelpResult] = await Promise.allSettled([
    searchResy({ location, cuisine, date, partySize }),
    searchOpenTable({ location, cuisine, date, time, partySize }),
    searchYelp({ location, cuisine, date, time, partySize }),
  ]);

  // === 3. Collect results and errors ===
  const platformResults = [];
  const platformStatus = {};

  // Resy
  if (resyResult.status === 'fulfilled') {
    platformResults.push(...resyResult.value.results);
    platformStatus.resy = {
      count: resyResult.value.results.length,
      latency: resyResult.value.latency,
      error: resyResult.value.error || null,
    };
  } else {
    platformStatus.resy = { count: 0, latency: 0, error: resyResult.reason?.message };
  }

  // OpenTable
  if (opentableResult.status === 'fulfilled') {
    platformResults.push(...opentableResult.value.results);
    platformStatus.opentable = {
      count: opentableResult.value.results.length,
      latency: opentableResult.value.latency,
      error: opentableResult.value.error || null,
    };
  } else {
    platformStatus.opentable = { count: 0, latency: 0, error: opentableResult.reason?.message };
  }

  // Yelp
  if (yelpResult.status === 'fulfilled') {
    platformResults.push(...yelpResult.value.results);
    platformStatus.yelp = {
      count: yelpResult.value.results.length,
      latency: yelpResult.value.latency,
      error: yelpResult.value.error || null,
    };
  } else {
    platformStatus.yelp = { count: 0, latency: 0, error: yelpResult.reason?.message };
  }

  // === 4. Deduplicate across platforms ===
  const deduplicated = deduplicateResults(platformResults);

  // === 5. Sort: confirmed slots first, then by number of available times ===
  deduplicated.sort((a, b) => {
    // Confirmed (Resy API) before parsed (Browserless+Gemini)
    if (a.confidence === 'confirmed' && b.confidence !== 'confirmed') return -1;
    if (b.confidence === 'confirmed' && a.confidence !== 'confirmed') return 1;
    // More time slots = more availability = higher rank
    return (b.timeSlots?.length || 0) - (a.timeSlots?.length || 0);
  });

  const totalLatency = Date.now() - searchStart;

  const response = {
    results: deduplicated,
    meta: {
      totalResults: deduplicated.length,
      platforms: platformStatus,
      latency: totalLatency,
      cached: false,
      searchParams: { location, cuisine, date, time, partySize },
    },
  };

  // === 6. Cache the response ===
  await setCache(cacheKey, response);

  // === 7. Track popularity anonymously ===
  // Fire-and-forget — don't slow down the response
  trackSearch(params).catch(() => {});

  console.log(`[Orchestrator] Search complete: ${deduplicated.length} results in ${totalLatency}ms`);
  console.log(`[Orchestrator] Platform breakdown: Resy=${platformStatus.resy?.count || 0}, OpenTable=${platformStatus.opentable?.count || 0}, Yelp=${platformStatus.yelp?.count || 0}`);

  return response;
}

/**
 * Deduplicate restaurants that appear on multiple platforms.
 * 
 * Strategy: Fuzzy name matching. If two results from different platforms
 * have very similar names, merge them — keep the one with more time slots,
 * but note all sources.
 */
function deduplicateResults(results) {
  const seen = new Map(); // normalized name → result

  for (const r of results) {
    const key = normalizeName(r.name);

    if (seen.has(key)) {
      const existing = seen.get(key);
      // Merge: keep the one with more time slots, combine sources
      if ((r.timeSlots?.length || 0) > (existing.timeSlots?.length || 0)) {
        seen.set(key, {
          ...r,
          alsoOn: [...(existing.alsoOn || [existing.source]), r.source],
          // Keep the better booking URL (prefer confirmed source)
          bookingUrl: existing.confidence === 'confirmed' ? existing.bookingUrl : r.bookingUrl,
        });
      } else {
        existing.alsoOn = [...(existing.alsoOn || [existing.source]), r.source];
      }
    } else {
      seen.set(key, { ...r });
    }
  }

  return Array.from(seen.values());
}

/**
 * Normalize restaurant name for dedup comparison.
 * "The Capital Grille" and "Capital Grille" and "THE CAPITAL GRILLE" → same.
 */
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
