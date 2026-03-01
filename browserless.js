/**
 * Browserless Service
 * Loads a URL in a stealth headless browser and returns the rendered HTML.
 * Uses Browserless.io's /content endpoint — simplest API, 1 unit per call.
 * 
 * Why not just fetch()? Because OpenTable and Yelp are React/JS-rendered SPAs.
 * A plain HTTP request returns empty shells. Browserless runs real Chrome,
 * executes all JavaScript, and returns the fully rendered page.
 */

import fetch from 'node-fetch';

const BROWSERLESS_URL = 'https://production-sfo.browserless.io';

/**
 * Fetch the fully rendered HTML content of a URL via Browserless.
 * Uses the /content endpoint which returns the page's HTML after JS execution.
 * 
 * @param {string} url - The URL to render
 * @param {object} options - Additional options
 * @returns {string} The rendered HTML content
 */
export async function fetchRenderedPage(url, options = {}) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) {
    throw new Error('BROWSERLESS_API_KEY not set');
  }

  const startTime = Date.now();
  const {
    waitForSelector = null,
    timeout = 15000,
    label = 'page',
  } = options;

  try {
    const payload = {
      url,
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout: timeout,
      },
      // Block unnecessary resources to speed up loading
      rejectResourceTypes: ['image', 'media', 'font'],
      // Wait for dynamic content to load
      waitForTimeout: 2000,
    };

    // If we know a specific selector to wait for, use it
    if (waitForSelector) {
      payload.waitForSelector = {
        selector: waitForSelector,
        timeout: timeout,
      };
    }

    const response = await fetch(
      `${BROWSERLESS_URL}/content?token=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout + 5000),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Browserless returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const html = await response.text();
    const latency = Date.now() - startTime;
    console.log(`[Browserless] ${label} rendered in ${latency}ms (${(html.length / 1024).toFixed(0)}KB)`);

    return html;
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[Browserless] ${label} failed after ${latency}ms:`, err.message);
    throw err;
  }
}

/**
 * Alternative: Use the /scrape endpoint for targeted element extraction.
 * Faster than /content when you know what you're looking for,
 * but less flexible for AI parsing.
 */
export async function scrapeElements(url, selectors, options = {}) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('BROWSERLESS_API_KEY not set');

  const { timeout = 15000, label = 'scrape' } = options;
  const startTime = Date.now();

  try {
    const payload = {
      url,
      elements: selectors.map(s => ({ selector: s })),
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout,
      },
      rejectResourceTypes: ['image', 'media', 'font'],
      waitForTimeout: 2000,
    };

    const response = await fetch(
      `${BROWSERLESS_URL}/scrape?token=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout + 5000),
      }
    );

    if (!response.ok) {
      throw new Error(`Browserless scrape returned ${response.status}`);
    }

    const data = await response.json();
    const latency = Date.now() - startTime;
    console.log(`[Browserless] ${label} scraped in ${latency}ms`);

    return data;
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error(`[Browserless] ${label} scrape failed after ${latency}ms:`, err.message);
    throw err;
  }
}
