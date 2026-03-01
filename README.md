# TableFinder Backend — POC

Multi-platform restaurant reservation search across **Resy**, **OpenTable**, and **Yelp**.
Returns actual available time slots, not just restaurant listings.

## Architecture

```
User Search Request
       │
       ▼
  ┌─────────┐     Cache Hit?
  │  Cache   │────────────────→ Return instantly (<100ms)
  └─────────┘
       │ Miss
       ▼
  ┌──────────────────────────────────────────┐
  │         Parallel Execution               │
  │                                          │
  │  ┌─────────┐  ┌───────────┐  ┌────────┐ │
  │  │  Resy   │  │ OpenTable │  │  Yelp  │ │
  │  │  API    │  │ Browser+  │  │Browser+│ │
  │  │ (1 sec) │  │ AI Parse  │  │AI Parse│ │
  │  │         │  │ (3-6 sec) │  │(3-6sec)│ │
  │  └────┬────┘  └─────┬─────┘  └───┬────┘ │
  │       │             │             │      │
  └───────┼─────────────┼─────────────┼──────┘
          │             │             │
          ▼             ▼             ▼
     ┌────────────────────────────────────┐
     │  Merge → Deduplicate → Sort → Cache │
     └────────────────────────────────────┘
          │
          ▼
     Return Results (5-8 sec cold, <100ms cached)
          │
          ▼  (fire-and-forget)
     Track Search Anonymously (popularity)
```

### Why This Hybrid?

| Approach | Speed | Resilience | Cost |
|----------|-------|------------|------|
| Pure scraping (CSS selectors) | ⚡ Fast | ❌ Breaks on redesign | Free |
| Pure AI agent (Browser Use) | 🐌 15-60s | ✅ Self-healing | $$ |
| **Hybrid (Browserless + Gemini)** | **⚡ 3-6s** | **✅ AI-resilient** | **$** |

The hybrid skips the slow agent navigation loop. We know the exact URL — we just
need the AI to *read* the rendered page, not *navigate* to it.

## Setup

### 1. Get API Keys (both free tier)

**Browserless.io** — renders JavaScript-heavy pages in stealth Chrome
- Sign up: https://www.browserless.io
- Free tier: 1,000 units/month (~500 searches)
- No credit card required

**Google Gemini** — parses HTML into structured data
- Get key: https://aistudio.google.com/apikey
- Free tier: 1,500 requests/day
- Using Gemini 2.0 Flash (fast + cheap)

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Install & Run

```bash
npm install
npm start
# Server runs on http://localhost:3001
```

### 4. Test

```bash
# Batch search (waits for all platforms)
curl "http://localhost:3001/api/search?location=Atlanta&date=2026-03-06&cuisine=italian&partySize=2"

# Streaming search (SSE — results arrive as each platform responds)
curl "http://localhost:3001/api/search/stream?location=Atlanta&date=2026-03-06&time=19:00"

# Check popularity data
curl "http://localhost:3001/api/popular"

# System stats
curl "http://localhost:3001/api/stats"
```

## Anonymous Popularity Tracking

Every search is tracked anonymously — **zero user data**, just the search pattern:

```
Pattern: "atlanta + italian + friday + 19:00 + party of 2" → count: 47
```

The system stores day-of-week (not specific dates) so patterns aggregate across weeks.
This data feeds the optional pre-warm worker.

### How It Self-Optimizes

1. **Collect** — Every search increments a counter for its pattern
2. **Analyze** — Every 30 min, find patterns above threshold (default: 10 searches)
3. **Refresh** — Every 5 min, re-run top patterns to keep cache hot
4. **Adapt** — As patterns shift (seasonal, events), the pre-warm list auto-updates

Enable pre-warming when you have enough data:
```
PREWARM_ENABLED=true
```

### Viewing Popularity Data

```bash
curl http://localhost:3001/api/popular
```

Returns:
```json
{
  "searches": [
    { "location": "Atlanta, GA", "cuisine": "italian", "time": "19:00", "partySize": 2, "count": 47 },
    { "location": "Atlanta, GA", "cuisine": "sushi", "time": "20:00", "partySize": 4, "count": 31 }
  ],
  "description": "Anonymous search patterns ranked by frequency. No user data is stored."
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | GET | Full search, returns when all platforms complete |
| `/api/search/stream` | GET | SSE stream, sends results as each platform responds |
| `/api/popular` | GET | Anonymous search popularity rankings |
| `/api/stats` | GET | Cache and system statistics |
| `/api/health` | GET | Health check with API key status |

### Search Parameters

| Param | Required | Example | Notes |
|-------|----------|---------|-------|
| `location` | Yes | `Atlanta, GA` | City name |
| `date` | Yes | `2026-03-06` | YYYY-MM-DD format |
| `cuisine` | No | `italian` | Filters results |
| `time` | No | `19:00` | Default: 19:00 |
| `partySize` | No | `2` | Default: 2 |

## Cost Analysis

### Per Search
| Component | Cost |
|-----------|------|
| Resy API | Free |
| Browserless (2 pages) | ~$0.004 |
| Gemini Flash (2 parses) | ~$0.002 |
| **Total per unique search** | **~$0.006** |

### Monthly Projections
| Scale | Unique Searches | Cached Hits | Monthly Cost |
|-------|----------------|-------------|--------------|
| POC | 500 | 2,500 | ~$3 |
| Early users | 2,000 | 15,000 | ~$12 |
| Growth | 10,000 | 80,000 | ~$60 |

## File Structure

```
tablefinder-backend/
├── server.js                 # Express server + API routes
├── services/
│   ├── orchestrator.js       # Parallel search coordinator
│   ├── resy.js               # Resy direct API (confirmed slots)
│   ├── opentable.js          # OpenTable via Browserless + Gemini
│   ├── yelp.js               # Yelp via Browserless + Gemini
│   ├── browserless.js        # Stealth headless browser rendering
│   ├── gemini.js             # AI-powered HTML → structured data
│   ├── cache.js              # Cache + anonymous popularity tracker
│   └── prewarm.js            # Background cache refresher (opt-in)
├── utils/
│   └── url-builder.js        # Platform URL construction
├── frontend/
│   └── page.jsx              # React UI with SSE streaming
├── .env.example              # Environment template
└── package.json
```

## Deployment

Recommended: **Render** ($7/month Web Service)
- Persistent process (not serverless)
- Keeps in-memory cache alive
- Add Render Redis ($7/mo) for durable cache

Alternative: Railway, Fly.io, any VPS

**Not recommended**: Vercel/Netlify serverless (10s timeout, no persistent cache)

## What This POC Validates

1. ✅ Can Browserless render OpenTable search pages with time slots?
2. ✅ Can Browserless render Yelp reservation-filtered pages?
3. ✅ Does Gemini Flash reliably extract structured availability data?
4. ✅ Is end-to-end latency within 5-10 seconds?
5. ✅ Does the parallel architecture work with streaming?
6. ✅ Does anonymous popularity tracking capture useful patterns?
