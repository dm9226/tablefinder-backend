/**
 * TableFinder Backend Server
 * 
 * Endpoints:
 *   GET /api/search  — Main search across all platforms (parallel)
 *   GET /api/popular — Top anonymous search patterns
 *   GET /api/stats   — Cache and system statistics
 *   GET /api/health  — Health check
 * 
 * Deploy to: Render ($7/mo), Railway, Fly.io, or any Node host.
 * NOT designed for Vercel serverless (needs persistent process for caching).
 */

import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { searchAll } from './services/orchestrator.js';
import { initCache, getCacheStats, getTopSearches } from './services/cache.js';

config(); // Load .env

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow frontend origin
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET'],
}));

app.use(express.json());

// === Initialize cache on startup ===
initCache();

// === MAIN SEARCH ENDPOINT ===
app.get('/api/search', async (req, res) => {
  const startTime = Date.now();

  try {
    const { location, cuisine, date, time, partySize } = req.query;

    // Validate required params
    if (!location) {
      return res.status(400).json({ error: 'location is required' });
    }
    if (!date) {
      return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD format' });
    }

    // Normalize time to HH:MM
    let normalizedTime = time || '19:00';
    if (normalizedTime && !normalizedTime.includes(':')) {
      normalizedTime = normalizedTime.padStart(4, '0');
      normalizedTime = normalizedTime.slice(0, 2) + ':' + normalizedTime.slice(2);
    }

    const params = {
      location: location.trim(),
      cuisine: cuisine?.trim() || null,
      date,
      time: normalizedTime,
      partySize: parseInt(partySize) || 2,
    };

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Search] ${params.location} | ${params.cuisine || 'any'} | ${params.date} ${params.time} | party ${params.partySize}`);
    console.log(`${'='.repeat(60)}`);

    const result = await searchAll(params);

    // Add request metadata
    result.meta.requestLatency = Date.now() - startTime;

    res.json(result);
  } catch (err) {
    console.error('[Search] Unhandled error:', err);
    res.status(500).json({
      error: 'Search failed',
      message: err.message,
      latency: Date.now() - startTime,
    });
  }
});

// === STREAMING SEARCH ENDPOINT (SSE) ===
// Sends results as each platform responds — Resy first (fast), then others.
app.get('/api/search/stream', async (req, res) => {
  const { location, cuisine, date, time, partySize } = req.query;

  if (!location || !date) {
    return res.status(400).json({ error: 'location and date required' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const params = {
    location: location.trim(),
    cuisine: cuisine?.trim() || null,
    date,
    time: time || '19:00',
    partySize: parseInt(partySize) || 2,
  };

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Import individual services for streaming
  const { searchResy } = await import('./services/resy.js');
  const { searchOpenTable } = await import('./services/opentable.js');
  const { searchYelp } = await import('./services/yelp.js');

  sendEvent('status', { message: 'Searching across platforms...', platforms: ['resy', 'opentable', 'yelp'] });

  // Fire all three — send results as each completes
  const promises = [
    searchResy(params).then(r => {
      sendEvent('results', { source: 'resy', results: r.results, latency: r.latency });
      return r;
    }),
    searchOpenTable(params).then(r => {
      sendEvent('results', { source: 'opentable', results: r.results, latency: r.latency, error: r.error });
      return r;
    }),
    searchYelp(params).then(r => {
      sendEvent('results', { source: 'yelp', results: r.results, latency: r.latency, error: r.error });
      return r;
    }),
  ];

  await Promise.allSettled(promises);

  sendEvent('complete', { message: 'All platforms searched' });
  res.end();
});

// === POPULARITY ENDPOINT ===
// Returns anonymous search patterns — no user data, just what people search for
app.get('/api/popular', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 25;
    const topSearches = await getTopSearches(limit);
    res.json({
      searches: topSearches,
      count: topSearches.length,
      description: 'Anonymous search patterns ranked by frequency. No user data is stored.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === STATS ENDPOINT ===
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getCacheStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === HEALTH CHECK ===
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    env: {
      browserless: !!process.env.BROWSERLESS_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      redis: !!process.env.REDIS_URL,
    },
  });
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`\n🍽️  TableFinder Backend running on port ${PORT}`);
  console.log(`   Search:  http://localhost:${PORT}/api/search?location=Atlanta&date=2026-03-05&cuisine=italian&partySize=2`);
  console.log(`   Stream:  http://localhost:${PORT}/api/search/stream?location=Atlanta&date=2026-03-05`);
  console.log(`   Popular: http://localhost:${PORT}/api/popular`);
  console.log(`   Stats:   http://localhost:${PORT}/api/stats`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`\n   API Keys: Browserless=${process.env.BROWSERLESS_API_KEY ? '✅' : '❌'}  Gemini=${process.env.GEMINI_API_KEY ? '✅' : '❌'}  Redis=${process.env.REDIS_URL ? '✅' : '⚪ (in-memory)'}\n`);
});

export default app;
