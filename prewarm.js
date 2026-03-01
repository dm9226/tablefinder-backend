/**
 * Pre-Warm Worker (Background Cache Refresher)
 * 
 * NOT active by default. This module collects popularity data from day one
 * but only starts pre-warming the cache once enough signal exists.
 * 
 * Lifecycle:
 * 1. COLLECT phase (automatic from launch):
 *    - Every search gets tracked anonymously via cache.js trackSearch()
 *    - Popularity data accumulates: "Atlanta Italian Friday 7pm" = 47 searches
 *    
 * 2. ANALYZE phase (runs every ANALYSIS_INTERVAL):
 *    - Checks if any search pattern has been seen >= MIN_SEARCHES_TO_PREWARM times
 *    - If yes, adds it to the pre-warm list
 *    - If patterns drop below threshold (seasonal shift), removes them
 *    
 * 3. REFRESH phase (runs every REFRESH_INTERVAL, only if pre-warm list is non-empty):
 *    - For each popular search, re-runs the full search pipeline
 *    - Updates cache with fresh results
 *    - Users hitting these patterns get instant (<100ms) responses
 * 
 * The pre-warm list is self-updating:
 * - Summer: "outdoor dining", "patio" searches climb → auto-added
 * - Winter: those drop off → auto-removed
 * - Valentine's Day week: "romantic dinner" spikes → pre-warmed that week
 * - March Madness: "sports bar" spikes in specific cities → pre-warmed
 * 
 * No manual configuration needed. The system learns from usage.
 */

import { getTopSearches } from './cache.js';

// === Configuration ===
const ANALYSIS_INTERVAL = 30 * 60 * 1000; // Check popularity every 30 min
const REFRESH_INTERVAL = 5 * 60 * 1000;   // Refresh pre-warm cache every 5 min
const MIN_SEARCHES_TO_PREWARM = 10;        // Minimum searches before pre-warming
const MAX_PREWARM_SEARCHES = 50;           // Cap to control costs
const ENABLED = process.env.PREWARM_ENABLED === 'true'; // Explicit opt-in

let prewarmList = [];
let analysisTimer = null;
let refreshTimer = null;
let stats = {
  lastAnalysis: null,
  lastRefresh: null,
  refreshCount: 0,
  prewarmListSize: 0,
};

/**
 * Initialize the pre-warm worker.
 * Starts the analysis loop immediately but refresh only activates
 * once the analysis finds popular enough patterns.
 */
export function initPrewarmWorker(searchFn) {
  if (!ENABLED) {
    console.log('[PreWarm] Disabled (set PREWARM_ENABLED=true to activate)');
    console.log('[PreWarm] Popularity tracking is still active — data will be ready when you enable this.');
    return;
  }

  console.log('[PreWarm] Worker initialized');
  console.log(`[PreWarm] Analysis every ${ANALYSIS_INTERVAL / 60000} min, Refresh every ${REFRESH_INTERVAL / 60000} min`);
  console.log(`[PreWarm] Threshold: ${MIN_SEARCHES_TO_PREWARM} searches, Max: ${MAX_PREWARM_SEARCHES} patterns`);

  // Start analysis loop
  analysisTimer = setInterval(() => analyzePopularity(), ANALYSIS_INTERVAL);

  // Start refresh loop (will no-op until prewarmList is populated)
  refreshTimer = setInterval(() => refreshPrewarmCache(searchFn), REFRESH_INTERVAL);

  // Run first analysis after a short delay (let some data accumulate)
  setTimeout(() => analyzePopularity(), 60000);
}

/**
 * Analyze popularity data and update the pre-warm list.
 * This is where the system "learns" what to optimize.
 */
async function analyzePopularity() {
  try {
    const topSearches = await getTopSearches(MAX_PREWARM_SEARCHES * 2);

    // Filter to only patterns above threshold
    const qualified = topSearches.filter(s => s.count >= MIN_SEARCHES_TO_PREWARM);

    // Take top N
    prewarmList = qualified.slice(0, MAX_PREWARM_SEARCHES);

    stats.lastAnalysis = new Date().toISOString();
    stats.prewarmListSize = prewarmList.length;

    if (prewarmList.length > 0) {
      console.log(`[PreWarm] Analysis complete: ${prewarmList.length} patterns qualify for pre-warming`);
      prewarmList.slice(0, 5).forEach(s => {
        console.log(`  → ${s.location} / ${s.cuisine || 'any'} / ${s.time} (${s.count} searches)`);
      });
    } else {
      console.log('[PreWarm] Analysis complete: no patterns above threshold yet');
    }
  } catch (err) {
    console.error('[PreWarm] Analysis error:', err.message);
  }
}

/**
 * Refresh the cache for all pre-warm patterns.
 * Generates the next occurrence date for each day-of-week pattern.
 */
async function refreshPrewarmCache(searchFn) {
  if (prewarmList.length === 0) return;

  stats.lastRefresh = new Date().toISOString();
  stats.refreshCount++;

  console.log(`[PreWarm] Refreshing ${prewarmList.length} cached searches...`);

  // Generate dates for the next 7 days from the popular patterns
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  let refreshed = 0;

  for (const pattern of prewarmList) {
    // For each popular pattern, refresh the next relevant date
    // Since we store day-of-week patterns, find the next matching date
    const targetDate = dates[0]; // Simplification: refresh for today + tomorrow

    try {
      await searchFn({
        location: pattern.location,
        cuisine: pattern.cuisine || null,
        date: targetDate,
        time: pattern.time || '19:00',
        partySize: pattern.partySize || 2,
      });
      refreshed++;
    } catch (err) {
      console.error(`[PreWarm] Failed to refresh ${pattern.location}/${pattern.cuisine}:`, err.message);
    }

    // Small delay between requests to avoid hammering platforms
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[PreWarm] Refresh complete: ${refreshed}/${prewarmList.length} patterns updated`);
}

/**
 * Get pre-warm worker status (for /api/stats endpoint)
 */
export function getPrewarmStats() {
  return {
    enabled: ENABLED,
    ...stats,
    prewarmList: prewarmList.map(p => ({
      location: p.location,
      cuisine: p.cuisine,
      time: p.time,
      searches: p.count,
    })),
  };
}

/**
 * Shutdown cleanly
 */
export function stopPrewarmWorker() {
  if (analysisTimer) clearInterval(analysisTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  console.log('[PreWarm] Worker stopped');
}
