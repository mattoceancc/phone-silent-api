export type GeoHit = { label: string; lat: number; lng: number };

const USER_AGENT = "PhoneSilent/1.0 (https://phonesilent.com; support@phonesilent.com)";
const CONTACT_EMAIL = "support@phonesilent.com";

/** Continental-US focus used when the query does not name a state. */
const PHOTON_US_LAT = "39.8";
const PHOTON_US_LON = "-98.6";
/**
 * Photon default is 0.4 (prominence weighs more). Lower values pull results
 * toward the bias point. 0.1 is the tight setting used for address lookup.
 */
const PHOTON_BIAS_SCALE = "0.1";
/** State-sized radius. Photon's default zoom (12) is only a city around the bias point. */
const PHOTON_STATE_ZOOM = "8";

/**
 * Approximate geographic centers, used only to aim Photon's location bias.
 * Not a geocoding result.
 */
const STATE_CENTROIDS: Record<string, readonly [lat: number, lng: number]> = {
  AL: [32.78, -86.83],
  AK: [64.07, -152.28],
  AZ: [34.27, -111.66],
  AR: [34.89, -92.37],
  CA: [37.18, -119.47],
  CO: [39.0, -105.55],
  CT: [41.6, -72.7],
  DE: [38.99, -75.51],
  DC: [38.91, -77.04],
  FL: [28.63, -82.45],
  GA: [32.64, -83.44],
  HI: [20.29, -156.37],
  ID: [44.35, -114.61],
  IL: [40.04, -89.2],
  IN: [39.91, -86.28],
  IA: [42.08, -93.5],
  KS: [38.49, -98.38],
  KY: [37.53, -85.3],
  LA: [31.07, -92.0],
  ME: [45.37, -69.24],
  MD: [39.06, -76.8],
  MA: [42.26, -71.81],
  MI: [44.35, -85.41],
  MN: [46.28, -94.31],
  MS: [32.74, -89.67],
  MO: [38.36, -92.46],
  MT: [47.05, -109.63],
  NE: [41.54, -99.8],
  NV: [39.33, -116.63],
  NH: [43.68, -71.58],
  NJ: [40.19, -74.67],
  NM: [34.41, -106.11],
  NY: [42.95, -75.53],
  NC: [35.56, -79.39],
  ND: [47.45, -100.47],
  OH: [40.29, -82.79],
  OK: [35.59, -97.49],
  OR: [43.93, -120.56],
  PA: [40.88, -77.8],
  RI: [41.68, -71.56],
  SC: [33.92, -80.9],
  SD: [44.44, -100.23],
  TN: [35.86, -86.35],
  TX: [31.48, -99.33],
  UT: [39.32, -111.09],
  VT: [44.07, -72.67],
  VA: [37.52, -78.85],
  WA: [47.38, -120.45],
  WV: [38.64, -80.62],
  WI: [44.62, -89.99],
  WY: [43.0, -107.55],
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const STATE_NAME_ENTRIES = Object.entries(STATE_NAMES).sort((a, b) => b[0].length - a[0].length);

function nominatimHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Geocoder HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function nominatimUrl(q: string, countrycodes?: string): URL {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("email", CONTACT_EMAIL);
  if (countrycodes) url.searchParams.set("countrycodes", countrycodes);
  return url;
}

/**
 * Expand US route abbreviations so Nominatim, Photon, and Census see
 * "Route" / "County Road" / "Highway" instead of Rt, CR, or Hwy.
 * Abbreviations are only rewritten when a route number follows.
 */
export function normalizeRouteShorthand(query: string): string {
  return query
    .replace(/\bu\.?\s*s\.?\s+hwy\b\.?\s*(?=\d)/gi, "US Highway ")
    .replace(/\bu\.?\s*s\.?\s+(?:rte|rt)\b\.?\s*(?=\d)/gi, "US Route ")
    .replace(/\bcounty\s+rd\b\.?\s*(?=\d)/gi, "County Road ")
    .replace(/\bco\b\.?\s*rd\b\.?\s*(?=\d)/gi, "County Road ")
    .replace(/\bc\.?\s*r\b\.?\s*(?=\d)/gi, "County Road ")
    .replace(/\bsr\b\.?\s*(?=\d)/gi, "State Route ")
    .replace(/\b(?:rte|rt)\b\.?\s*(?=\d)/gi, "Route ")
    .replace(/\bhwy\b\.?\s*(?=\d)/gi, "Highway ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Trailing postal abbreviation wins over an earlier state name ("Washington, NJ"). */
function detectUsState(query: string): string | null {
  const cleaned = query.replace(/\./g, " ").replace(/\s+/g, " ").trim();
  const trailing = cleaned.match(/(?:,|\s)([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (trailing) {
    const abbr = trailing[1].toUpperCase();
    if (STATE_CENTROIDS[abbr]) return abbr;
  }
  const lower = cleaned.toLowerCase();
  for (const [name, abbr] of STATE_NAME_ENTRIES) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return abbr;
  }
  return null;
}

function parseNominatim(data: unknown): GeoHit[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      const row = item as { display_name?: string; lat?: string; lon?: string };
      const lat = Number(row.lat);
      const lng = Number(row.lon);
      if (!row.display_name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { label: row.display_name, lat, lng };
    })
    .filter((item): item is GeoHit => Boolean(item));
}

function parsePhoton(data: unknown): GeoHit[] {
  const features = (data as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return [];
  return features
    .map((feature) => {
      const row = feature as {
        geometry?: { coordinates?: number[] };
        properties?: {
          name?: string;
          housenumber?: string;
          street?: string;
          city?: string;
          state?: string;
          postcode?: string;
          country?: string;
        };
      };
      const coords = row.geometry?.coordinates;
      if (!coords || coords.length < 2) return null;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const p = row.properties ?? {};
      const parts = [
        [p.housenumber, p.street].filter(Boolean).join(" "),
        p.name,
        p.city,
        p.state,
        p.postcode,
        p.country,
      ].filter((part) => part && String(part).trim());
      const label = [...new Set(parts)].join(", ");
      if (!label) return null;
      return { label, lat, lng };
    })
    .filter((item): item is GeoHit => Boolean(item));
}

/** Census `coordinates.x` is longitude and `coordinates.y` is latitude. */
function parseCensus(data: unknown): GeoHit[] {
  const matches = (data as { result?: { addressMatches?: unknown[] } })?.result?.addressMatches;
  if (!Array.isArray(matches)) return [];
  const hits: GeoHit[] = [];
  for (const item of matches) {
    const row = item as {
      matchedAddress?: string;
      coordinates?: { x?: number; y?: number };
    };
    const lat = Number(row.coordinates?.y);
    const lng = Number(row.coordinates?.x);
    const label = row.matchedAddress?.trim();
    if (!label || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    hits.push({ label, lat, lng });
    if (hits.length >= 8) break;
  }
  return hits;
}

async function searchNominatim(q: string, countrycodes?: string): Promise<GeoHit[]> {
  const data = await fetchJson(nominatimUrl(q, countrycodes), {
    headers: nominatimHeaders(),
  });
  return parseNominatim(data);
}

function photonUrl(q: string): URL {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "en");
  url.searchParams.set("countrycode", "us");
  url.searchParams.set("location_bias_scale", PHOTON_BIAS_SCALE);
  const state = detectUsState(q);
  if (state) {
    const [lat, lng] = STATE_CENTROIDS[state];
    url.searchParams.set("lat", lat.toFixed(2));
    url.searchParams.set("lon", lng.toFixed(2));
    url.searchParams.set("zoom", PHOTON_STATE_ZOOM);
  } else {
    url.searchParams.set("lat", PHOTON_US_LAT);
    url.searchParams.set("lon", PHOTON_US_LON);
  }
  return url;
}

async function searchPhoton(q: string): Promise<GeoHit[]> {
  const data = await fetchJson(photonUrl(q), {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  return parsePhoton(data);
}

async function searchCensus(q: string): Promise<GeoHit[]> {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", q);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const data = await fetchJson(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  return parseCensus(data);
}

/**
 * US-biased address search.
 * Nominatim (US, then worldwide), then Photon biased to the named state
 * (or the US center), then the Census geocoder for street addresses
 * OpenStreetMap does not have.
 */
export async function searchAddresses(q: string): Promise<GeoHit[]> {
  const raw = q.trim();
  if (raw.length < 3) return [];
  const query = normalizeRouteShorthand(raw);

  try {
    const usHits = await searchNominatim(query, "us");
    if (usHits.length) return usHits;
    const worldwide = await searchNominatim(query);
    if (worldwide.length) return worldwide;
  } catch {
    // Nominatim is often rate-limited or blocked on hosted egress; try Photon.
  }

  try {
    const photonHits = await searchPhoton(query);
    if (photonHits.length) return photonHits;
  } catch {
    // Photon can time out; the Census geocoder still covers US street addresses.
  }

  try {
    return await searchCensus(query);
  } catch {
    return [];
  }
}
