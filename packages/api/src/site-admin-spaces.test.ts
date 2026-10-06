import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATABASE_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "ps-admin-")),
  "test.sqlite",
);
process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://127.0.0.1:43123";
delete process.env.RESEND_API_KEY;
delete process.env.SITE_ADMIN_EMAILS;

const { app } = await import("./index");

type Json = Record<string, unknown>;

const VISITOR_KEYS = new Set(["visitorCounts", "visitorCount", "joins", "silences", "metrics"]);

function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
}

function assertNoVisitorCounts(payload: unknown) {
  const keys = collectKeys(payload);
  for (const key of VISITOR_KEYS) {
    assert.equal(keys.has(key), false, `unexpected visitor field ${key}`);
  }
}

async function call(
  pathname: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
) {
  const response = await app.request(pathname, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.40",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await response.json()) as Json;
  return { status: response.status, data };
}

const austin = {
  name: "Main sanctuary",
  address: "123 Main St, Austin, TX",
  lat: 30.2672,
  lng: -97.7431,
  timezone: "America/Chicago",
  plan: "free" as const,
  active: true,
};

async function register(email: string, firstName: string, verify = true) {
  const registered = await call("/auth/register", {
    method: "POST",
    body: {
      email,
      firstName,
      lastName: "Owner",
      password: "correcthorsebattery",
    },
  });
  assert.equal(registered.status, 200);
  if (!verify) {
    return {
      token: String(registered.data.token),
      admin: registered.data.admin as Json,
    };
  }
  const preview = (registered.data.verification as Json).preview as Json;
  const verified = await call("/auth/verify-email", {
    method: "POST",
    token: String(registered.data.token),
    body: { code: preview.code },
  });
  assert.equal(verified.status, 200);
  return {
    token: String(verified.data.token),
    admin: verified.data.admin as Json,
  };
}

describe("site-admin space list", { concurrency: 1 }, () => {
  test("lists every space with visitor counts for site admins only", async () => {
    const ada = await register("ada@example.com", "Ada");
    const created = await call("/admin/venues", {
      method: "POST",
      token: ada.token,
      body: austin,
    });
    assert.equal(created.status, 201);
    const venueId = String((created.data.venue as Json).id);
    assertNoVisitorCounts(created.data);

    const grace = await register("grace@example.com", "Grace");
    const other = await call("/admin/venues", {
      method: "POST",
      token: grace.token,
      body: {
        ...austin,
        name: "Harbor hall",
        address: "1 Broadway, New York, NY",
        lat: 40.705,
        lng: -74.013,
      },
    });
    assert.equal(other.status, 201);
    const otherId = String((other.data.venue as Json).id);

    const pending = await register("pending@example.com", "Pat", false);
    const waiting = await call("/admin/venues", {
      method: "POST",
      token: pending.token,
      body: {
        ...austin,
        name: "Pending chapel",
        address: "400 Broad St, Seattle, WA",
        lat: 47.6205,
        lng: -122.3493,
      },
    });
    assert.equal(waiting.status, 201);

    const mobile = await call("/mobile/session", { method: "POST" });
    assert.equal(mobile.status, 200);
    const joined = await call("/me/join", {
      method: "POST",
      token: String(mobile.data.token),
      body: { venueId },
    });
    assert.equal(joined.status, 200);
    assertNoVisitorCounts(joined.data);

    const firstSilence = await call("/evaluate", {
      method: "POST",
      body: { lat: austin.lat, lng: austin.lng },
    });
    assert.equal(firstSilence.status, 200);
    assert.equal(firstSilence.data.shouldSilence, true);
    assertNoVisitorCounts(firstSilence.data);
    const secondSilence = await call("/evaluate", {
      method: "POST",
      body: { lat: austin.lat, lng: austin.lng },
    });
    assert.equal(secondSilence.status, 200);

    const signedOut = await call("/site-admin/venues");
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.data.venues, undefined);
    assert.equal(signedOut.data.totals, undefined);
    assert.equal(JSON.stringify(signedOut.data).includes("ada@example.com"), false);

    const outsider = await call("/site-admin/venues", { token: ada.token });
    assert.equal(outsider.status, 403);
    assert.equal(outsider.data.venues, undefined);
    assert.equal(JSON.stringify(outsider.data).includes("grace@example.com"), false);

    const ownerMetrics = await call(`/admin/venues/${venueId}/metrics`, { token: ada.token });
    assert.equal(ownerMetrics.status, 404);
    assertNoVisitorCounts(ownerMetrics.data);

    const upgraded = await call(`/admin/venues/${venueId}/upgrade`, {
      method: "POST",
      token: ada.token,
      body: { interval: "month" },
    });
    assert.equal(upgraded.status, 200);
    assertNoVisitorCounts(upgraded.data);
    const paidMetrics = await call(`/admin/venues/${venueId}/metrics`, { token: ada.token });
    assert.equal(paidMetrics.status, 404);
    assertNoVisitorCounts(paidMetrics.data);

    const ownerList = await call("/admin/venues", { token: ada.token });
    assert.equal(ownerList.status, 200);
    assert.equal((ownerList.data.venues as Json[]).length, 1);
    assertNoVisitorCounts(ownerList.data);

    const ownerOne = await call(`/admin/venues/${venueId}`, { token: ada.token });
    assert.equal(ownerOne.status, 200);
    assertNoVisitorCounts(ownerOne.data);

    const publicList = await call("/venues/public");
    assert.equal(publicList.status, 200);
    assertNoVisitorCounts(publicList.data);

    const signedOutMetrics = await call(`/site-admin/venues/${venueId}/metrics`);
    assert.equal(signedOutMetrics.status, 401);
    assert.equal(signedOutMetrics.data.metrics, undefined);

    const outsiderMetrics = await call(`/site-admin/venues/${venueId}/metrics`, {
      token: grace.token,
    });
    assert.equal(outsiderMetrics.status, 403);
    assert.equal(outsiderMetrics.data.metrics, undefined);

    const matt = await register("mattoceancc@gmail.com", "Matt");
    assert.equal(matt.admin.siteAdmin, true);
    const mine = await call("/admin/venues", { token: matt.token });
    assert.deepEqual(mine.data.venues, []);

    const listed = await call("/site-admin/venues", { token: matt.token });
    assert.equal(listed.status, 200);
    const spaces = listed.data.venues as Json[];
    assert.equal(spaces.length, 3);
    const byId = new Map(spaces.map((space) => [String(space.id), space]));
    assert.equal(byId.has(venueId), true);
    assert.equal(byId.has(otherId), true);

    const sanctuary = byId.get(venueId)!;
    assert.equal(sanctuary.name, "Main sanctuary");
    assert.equal(sanctuary.address, austin.address);
    assert.equal(sanctuary.lat, austin.lat);
    assert.equal(sanctuary.lng, austin.lng);
    assert.equal(sanctuary.ownerId, ada.admin.id);
    assert.equal(sanctuary.ownerEmail, "ada@example.com");
    assert.equal(sanctuary.ownerEmailVerified, true);
    assert.equal(sanctuary.active, true);
    assert.equal(typeof sanctuary.createdAt, "string");
    assert.equal(typeof sanctuary.updatedAt, "string");
    assert.deepEqual(sanctuary.visitorCounts, { joins: 1, silences: 2 });

    const quiet = byId.get(otherId)!;
    assert.equal(quiet.ownerEmail, "grace@example.com");
    assert.deepEqual(quiet.visitorCounts, { joins: 0, silences: 0 });

    const unverified = spaces.find((space) => space.ownerEmail === "pending@example.com");
    assert.ok(unverified);
    assert.equal(unverified.active, false);
    assert.equal(unverified.ownerEmailVerified, false);
    assert.deepEqual(unverified.visitorCounts, { joins: 0, silences: 0 });

    assert.deepEqual(listed.data.totals, { spaces: 3, joins: 1, silences: 2 });

    const filtered = await call("/site-admin/venues?q=harbor", { token: matt.token });
    assert.equal((filtered.data.venues as Json[]).length, 1);
    assert.deepEqual(filtered.data.totals, { spaces: 1, joins: 0, silences: 0 });

    const detail = await call(`/site-admin/venues/${venueId}/metrics`, { token: matt.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.venueId, venueId);
    assert.equal(detail.data.anonymous, true);
    const metrics = detail.data.metrics as Json;
    assert.deepEqual(metrics.totals, { joins: 1, silences: 2 });
    const days = metrics.days as Json[];
    assert.equal(days.length, 1);
    assert.equal(days[0].joins, 1);
    assert.equal(days[0].silences, 2);

    const missing = await call("/site-admin/venues/ven_missing/metrics", { token: matt.token });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.metrics, undefined);

    const before = String(sanctuary.updatedAt);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const renamed = await call(`/admin/venues/${venueId}`, {
      method: "PATCH",
      token: ada.token,
      body: { name: "Main sanctuary west" },
    });
    assert.equal(renamed.status, 200);
    const after = await call("/site-admin/venues?q=sanctuary", { token: matt.token });
    const updated = (after.data.venues as Json[])[0];
    assert.equal(updated.name, "Main sanctuary west");
    assert.ok(String(updated.updatedAt) > before);
    assert.deepEqual(updated.visitorCounts, { joins: 1, silences: 2 });
  });
});
