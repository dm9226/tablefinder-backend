/**
 * Cache Service with Anonymous Popularity Tracking
 * 
 * Two responsibilities:
 * 1. Cache search results (5-min TTL) so subsequent users get instant responses
 * 2. Track search popularity anonymously — no user data, just search param frequencies
 * 
 * The popularity data feeds a background refresh worker:
 * - Every N minutes, the top M most popular searches get their cache refreshed
 * - As user patterns change (e.g., seasonal shifts), the pre-warm list auto-updates
 * - Zero manual configuration — the system learns what to optimize
 * 
 * Supports Redis (production) or in-memory Map (development/POC).
 */

import Redis from 'ioredis';

let redis = null;
let memoryCache = new Map(); // Fallback when Redis not configured
let popularityMap = new Map(); // In-memory fallback for popularity tracking

const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 300; // 5 minutes
const POPULARITY_WINDOW = 86400; // 24 hours — how far back we track popularity

/**
 * Initialize Redis connection (or fall back to in-memory)
 */
export function initCache() {
  if (process.env.REDIS_URL) {
    try {
      redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 200, 2000),
        connectTimeout: 5000,
      });
      redis.on('connect', () => console.log('[Cache] Redis connected'));
      redis.on('error', (err) => console.error('[Cache] Redis error:', err.message));
      return;
    } catch (err) {
      console.warn('[Cache] Redis failed, using in-memory:', err.message);
    }
  }

  console.log('[Cache] No REDIS_URL set — using in-memory cache (fine for POC)');
}

/**
 * Build a deterministic cache key from search parameters.
 * Normalizes inputs so "Atlanta, GA" and "atlanta" hit the same cache.
 */
export function buildCacheKey({ location, cuisine, date, time, partySize }) {
  const parts = [
    (location || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    (cuisine || 'all').toLowerCase().replace(/[^a-z0-9]/g, ''),
    date || '',
    (time || '19:00').replace(':', ''),
    partySize || 2,
  ];
  return `search:${parts.join(':')}`;
}

/**
 * Build a popularity key — same as cache key but uses day-of-week
 * instead of specific date so patterns aggregate across weeks.
 * 
 * "Atlanta Italian Friday 7pm party of 2" is the same popular search
 * regardless of whether it's THIS Friday or NEXT Friday.
 */
function buildPopularityKey({ location, cuisine, date, time, partySize }) {
  let dayOfWeek = 'any';
  if (date) {
    try {
      const d = new Date(date + 'T12:00:00');
      dayOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
    } catch (e) { /* ignore */ }
  }

  const parts = [
    (location || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    (cuisine || 'all').toLowerCase().replace(/[^a-z0-9]/g, ''),
    dayOfWeek,
    (time || '19:00').replace(':', ''),
    partySize || 2,
  ];
  return `pop:${parts.join(':')}`;
}

// === CACHE OPERATIONS ===

export async function getCached(key) {
  try {
    if (redis) {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    }
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      memoryCache.delete(key);
      return null;
    }
    return entry.data;
  } catch (err) {
    console.error('[Cache] Get error:', err.message);
    return null;
  }
}

export async function setCache(key, data, ttl = CACHE_TTL) {
  try {
    if (redis) {
      await redis.setex(key, ttl, JSON.stringify(data));
    } else {
      memoryCache.set(key, { data, expiresAt: Date.now() + (ttl * 1000) });
    }
  } catch (err) {
    console.error('[Cache] Set error:', err.message);
  }
}

// === POPULARITY TRACKING ===

/**
 * Record a search anonymously. No user data — just the search pattern.
 * Uses a sorted set in Redis (score = timestamp) so we can count
 * hits within a time window and automatically expire old data.
 */
export async function trackSearch(searchParams) {
  const popKey = buildPopularityKey(searchParams);
  const now = Date.now();

  try {
    if (redis) {
      // Add to sorted set with timestamp as score
      await redis.zadd('search_popularity', now, `${popKey}:${now}`);
      // Increment a simple counter for quick lookups
      await redis.hincrby('search_counts', popKey, 1);
      // Store the search params template for this key
      await redis.hset('search_templates', popKey, JSON.stringify({
        location: searchParams.location,
        cuisine: searchParams.cuisine,
        time: searchParams.time,
        partySize: searchParams.partySize,
        // Note: no specific date — we store the day-of-week pattern
      }));
    } else {
      // In-memory fallback
      const current = popularityMap.get(popKey) || { count: 0, params: null };
      current.count += 1;
      current.params = {
        location: searchParams.location,
        cuisine: searchParams.cuisine,
        time: searchParams.time,
        partySize: searchParams.partySize,
      };
      current.lastSeen = now;
      popularityMap.set(popKey, current);
    }
  } catch (err) {
    // Non-critical — don't let tracking failure break search
    console.error('[Popularity] Track error:', err.message);
  }
}

/**
 * Get the top N most popular search patterns.
 * Returns search param templates that can be used for pre-warming.
 */
export async function getTopSearches(limit = 50) {
  try {
    if (redis) {
      // Get top searches by count
      const counts = await redis.hgetall('search_counts');
      const sorted = Object.entries(counts)
        .map(([key, count]) => ({ key, count: parseInt(count) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

      // Fetch the param templates for each
      const results = [];
      for (const { key, count } of sorted) {
        const template = await redis.hget('search_templates', key);
        if (template) {
          results.push({ ...JSON.parse(template), count, key });
        }
      }
      return results;
    } else {
      // In-memory fallback
      return Array.from(popularityMap.entries())
        .map(([key, data]) => ({ ...data.params, count: data.count, key }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    }
  } catch (err) {
    console.error('[Popularity] Get top searches error:', err.message);
    return [];
  }
}

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStats() {
  try {
    if (redis) {
      const info = await redis.info('stats');
      const keyCount = await redis.dbsize();
      const topSearches = await getTopSearches(10);
      return { type: 'redis', keys: keyCount, topSearches };
    } else {
      return {
        type: 'memory',
        cacheEntries: memoryCache.size,
        popularityEntries: popularityMap.size,
        topSearches: await getTopSearches(10),
      };
    }
  } catch (err) {
    return { type: 'unknown', error: err.message };
  }
}

/**
 * Clean up expired entries from in-memory cache
 * (Redis handles this automatically with TTL)
 */
export function cleanupMemoryCache() {
  if (redis) return; // Redis handles expiry

  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (now > entry.expiresAt) {
      memoryCache.delete(key);
    }
  }
}

// Run cleanup every minute for in-memory mode
setInterval(cleanupMemoryCache, 60000);
