export type GeoHit = { label: string; lat: number; lng: number };

const USER_AGENT = "PhoneSilent/1.0 (https://phonesilent.com; support@phonesilent.com)";
const CONTACT_EMAIL = "support@phonesilent.com";

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

async function searchNominatim(q: string, countrycodes?: string): Promise<GeoHit[]> {
  const data = await fetchJson(nominatimUrl(q, countrycodes), {
    headers: nominatimHeaders(),
  });
  return parseNominatim(data);
}

async function searchPhoton(q: string): Promise<GeoHit[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "en");
  url.searchParams.set("lat", "39.8");
  url.searchParams.set("lon", "-98.6");
  const data = await fetchJson(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  return parsePhoton(data);
}

/** US-biased address search with Nominatim, then Photon if OSM is blocked or empty. */
export async function searchAddresses(q: string): Promise<GeoHit[]> {
  const query = q.trim();
  if (query.length < 3) return [];

  try {
    const usHits = await searchNominatim(query, "us");
    if (usHits.length) return usHits;
    const worldwide = await searchNominatim(query);
    if (worldwide.length) return worldwide;
  } catch {
    // Nominatim is often rate-limited or blocked on hosted egress; try Photon.
  }

  try {
    return await searchPhoton(query);
  } catch {
    return [];
  }
}
