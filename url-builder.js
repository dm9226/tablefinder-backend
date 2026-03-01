/**
 * Build parameterized search URLs for each reservation platform.
 * This is the key insight: we don't need an AI agent to navigate —
 * we construct the exact URL and let Browserless render it.
 */

// OpenTable metro IDs for major US cities
const OPENTABLE_METROS = {
  'atlanta': 4,
  'austin': 14,
  'boston': 6,
  'chicago': 3,
  'dallas': 5,
  'denver': 16,
  'houston': 7,
  'las vegas': 15,
  'los angeles': 8,
  'miami': 11,
  'nashville': 22,
  'new york': 2,
  'philadelphia': 10,
  'phoenix': 17,
  'portland': 18,
  'san diego': 13,
  'san francisco': 9,
  'seattle': 1,
  'washington dc': 12,
  'washington': 12,
};

function findMetroId(location) {
  const loc = location.toLowerCase().replace(/,.*/, '').trim();
  for (const [city, id] of Object.entries(OPENTABLE_METROS)) {
    if (loc.includes(city)) return id;
  }
  return null;
}

/**
 * OpenTable search URL with availability filters
 * Returns actual time slots when rendered in browser
 */
export function buildOpenTableURL({ location, cuisine, date, time, partySize }) {
  const params = new URLSearchParams();
  params.set('covers', partySize || 2);
  params.set('dateTime', `${date}T${time || '19:00'}`);
  if (cuisine) params.set('term', cuisine);

  const metroId = findMetroId(location);
  if (metroId) {
    params.set('metroId', metroId);
  } else {
    // Fallback: use location as search term
    params.set('queryText', location);
  }

  params.set('sort', 'Availability');
  return `https://www.opentable.com/s?${params.toString()}`;
}

/**
 * Yelp search URL with reservation filters
 * The reservation_* params trigger Yelp to show actual available slots
 */
export function buildYelpURL({ location, cuisine, date, time, partySize }) {
  const params = new URLSearchParams();
  params.set('find_desc', cuisine || 'restaurants');
  params.set('find_loc', location);
  params.set('attrs', 'Reservations');
  params.set('reservation_date', date);
  // Yelp expects time as HH:MM format
  params.set('reservation_time', time || '19:00');
  params.set('reservation_covers', partySize || 2);
  params.set('sortby', 'recommended');

  return `https://www.yelp.com/search?${params.toString()}`;
}

/**
 * Resy doesn't need a URL — it has a direct API.
 * This helper builds the API params instead.
 */
export function buildResyParams({ location, date, partySize, lat, lng }) {
  return {
    lat: lat || null,
    lng: lng || null,
    day: date,
    party_size: partySize || 2,
    location: location,
  };
}

// Geocoding lookup for Resy (needs lat/lng)
const CITY_COORDS = {
  'atlanta': { lat: 33.749, lng: -84.388 },
  'austin': { lat: 30.267, lng: -97.743 },
  'boston': { lat: 42.360, lng: -71.058 },
  'chicago': { lat: 41.878, lng: -87.629 },
  'dallas': { lat: 32.776, lng: -96.796 },
  'denver': { lat: 39.739, lng: -104.990 },
  'houston': { lat: 29.760, lng: -95.369 },
  'las vegas': { lat: 36.169, lng: -115.139 },
  'los angeles': { lat: 34.052, lng: -118.243 },
  'miami': { lat: 25.761, lng: -80.191 },
  'nashville': { lat: 36.162, lng: -86.774 },
  'new york': { lat: 40.712, lng: -74.006 },
  'philadelphia': { lat: 39.952, lng: -75.163 },
  'phoenix': { lat: 33.448, lng: -112.074 },
  'portland': { lat: 45.523, lng: -122.676 },
  'san diego': { lat: 32.715, lng: -117.161 },
  'san francisco': { lat: 37.774, lng: -122.419 },
  'seattle': { lat: 47.606, lng: -122.332 },
  'washington': { lat: 38.907, lng: -77.036 },
};

export function getCityCoords(location) {
  const loc = location.toLowerCase().replace(/,.*/, '').trim();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (loc.includes(city)) return coords;
  }
  return null;
}
