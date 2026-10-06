import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { normalizeRouteShorthand, searchAddresses } from "./geo-search";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const censusWhiting = {
  result: {
    addressMatches: [
      {
        matchedAddress: "601 CO RD 530, WHITING, NJ, 08759",
        coordinates: { x: -74.340691830176, y: 39.947166947859 },
      },
    ],
  },
};

describe("route shorthand", () => {
  test("expands Rt, Rte, CR, and Hwy when a number follows", () => {
    assert.equal(normalizeRouteShorthand("601 Rt 530 Whiting NJ"), "601 Route 530 Whiting NJ");
    assert.equal(normalizeRouteShorthand("601 Rt. 530, Whiting, NJ"), "601 Route 530, Whiting, NJ");
    assert.equal(normalizeRouteShorthand("601 Rte 530 Whiting NJ"), "601 Route 530 Whiting NJ");
    assert.equal(normalizeRouteShorthand("12 CR 530"), "12 County Road 530");
    assert.equal(normalizeRouteShorthand("12 C.R. 530"), "12 County Road 530");
    assert.equal(normalizeRouteShorthand("9 Co. Rd. 530"), "9 County Road 530");
    assert.equal(normalizeRouteShorthand("9 County Rd 530"), "9 County Road 530");
    assert.equal(normalizeRouteShorthand("US Rt 1"), "US Route 1");
    assert.equal(normalizeRouteShorthand("U.S. Hwy 1"), "US Highway 1");
    assert.equal(normalizeRouteShorthand("SR 530"), "State Route 530");
    assert.equal(normalizeRouteShorthand("Hwy 9"), "Highway 9");
  });

  test("leaves spelled-out routes and ordinary street words alone", () => {
    assert.equal(
      normalizeRouteShorthand("601 Route 530 Whiting NJ"),
      "601 Route 530 Whiting NJ",
    );
    assert.equal(normalizeRouteShorthand("Court St and North Port"), "Court St and North Port");
    assert.equal(normalizeRouteShorthand("Fort Lee"), "Fort Lee");
  });
});

describe("address search fallback", { concurrency: 1 }, () => {
  afterEach(() => {
    mock.restoreAll();
  });

  test("ignores queries shorter than 3 characters", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });
    assert.deepEqual(await searchAddresses("  nj "), []);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("returns a US Nominatim hit without calling Census", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      assert.match(url, /nominatim\.openstreetmap\.org/);
      assert.match(url, /countrycodes=us/);
      assert.match(url, /Route\+530|Route%20530/);
      return jsonResponse([
        { display_name: "Whiting, New Jersey", lat: "39.95", lon: "-74.38" },
      ]);
    });

    const hits = await searchAddresses("601 Rt. 530 Whiting NJ");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, "Whiting, New Jersey");
    assert.equal(hits[0].lat, 39.95);
    assert.equal(hits[0].lng, -74.38);
    assert.equal(calls.length, 1);
  });

  test("biases Photon to the named state and prefers it over Census", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("nominatim")) return jsonResponse([]);
      if (url.includes("photon.komoot.io")) {
        return jsonResponse({
          features: [
            {
              geometry: { coordinates: [-74.38, 39.95] },
              properties: { name: "Whiting", state: "New Jersey", country: "United States" },
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const hits = await searchAddresses("Whiting NJ");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, "Whiting, New Jersey, United States");
    assert.equal(calls.some((url) => url.includes("census")), false);

    const photon = new URL(calls.find((url) => url.includes("photon.komoot.io"))!);
    assert.equal(photon.searchParams.get("countrycode"), "us");
    assert.equal(photon.searchParams.get("location_bias_scale"), "0.1");
    assert.equal(photon.searchParams.get("zoom"), "8");
    assert.equal(photon.searchParams.get("lat"), "40.19");
    assert.equal(photon.searchParams.get("lon"), "-74.67");
  });

  test("keeps the US-center Photon bias when no state is named", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("nominatim")) return jsonResponse([]);
      if (url.includes("photon.komoot.io")) {
        return jsonResponse({
          features: [
            {
              geometry: { coordinates: [-77.04, 38.9] },
              properties: { name: "Washington", country: "United States" },
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await searchAddresses("Springfield");
    const photon = new URL(calls.find((url) => url.includes("photon.komoot.io"))!);
    assert.equal(photon.searchParams.get("lat"), "39.8");
    assert.equal(photon.searchParams.get("lon"), "-98.6");
    assert.equal(photon.searchParams.get("location_bias_scale"), "0.1");
    assert.equal(photon.searchParams.get("countrycode"), "us");
    assert.equal(photon.searchParams.get("zoom"), null);
  });

  test("uses the Census geocoder when Nominatim and Photon are empty", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("nominatim")) return jsonResponse([]);
      if (url.includes("photon.komoot.io")) return jsonResponse({ features: [] });
      if (url.includes("geocoding.geo.census.gov")) return jsonResponse(censusWhiting);
      throw new Error(`unexpected ${url}`);
    });

    const hits = await searchAddresses("601 Rt 530 Whiting NJ");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, "601 CO RD 530, WHITING, NJ, 08759");
    assert.ok(Math.abs(hits[0].lat - 39.947) < 0.001);
    assert.ok(Math.abs(hits[0].lng - -74.341) < 0.001);

    const census = new URL(calls.find((url) => url.includes("geocoding.geo.census.gov"))!);
    assert.equal(census.searchParams.get("benchmark"), "Public_AR_Current");
    assert.equal(census.searchParams.get("format"), "json");
    assert.equal(census.searchParams.get("address"), "601 Route 530 Whiting NJ");
    assert.equal(calls.filter((url) => url.includes("nominatim")).length, 2);
  });

  test("falls through to Census when Nominatim and Photon fail", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("geocoding.geo.census.gov")) return jsonResponse(censusWhiting);
      return jsonResponse({ error: "nope" }, 503);
    });

    const hits = await searchAddresses("601 Route 530 Whiting NJ");
    assert.equal(hits.length, 1);
    assert.ok(Math.abs(hits[0].lat - 39.947166947859) < 1e-9);
    assert.ok(Math.abs(hits[0].lng - -74.340691830176) < 1e-9);
  });

  test("returns no hits when every geocoder fails", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ error: "nope" }, 429));
    assert.deepEqual(await searchAddresses("601 Route 530 Whiting NJ"), []);
  });

  test("skips a Census match that has no coordinates", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("nominatim") || url.includes("photon")) return jsonResponse([]);
      return jsonResponse({
        result: { addressMatches: [{ matchedAddress: "NOWHERE", coordinates: {} }] },
      });
    });
    assert.deepEqual(await searchAddresses("999 Nowhere Rd"), []);
  });
});
