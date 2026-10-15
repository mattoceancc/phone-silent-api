import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATABASE_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "ps-claim-")),
  "test.sqlite",
);
process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://127.0.0.1:43123";
delete process.env.RESEND_API_KEY;
delete process.env.SITE_ADMIN_EMAILS;

const { app } = await import("./index");
const { insideRealZone } = await import("./space-claim");

type Json = Record<string, unknown>;

async function call(
  pathname: string,
  opts: { method?: string; token?: string; body?: unknown; ip?: string } = {},
) {
  const response = await app.request(pathname, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? "203.0.113.16",
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
  lat: 30.27,
  lng: -97.74,
  timezone: "America/Chicago",
  plan: "free" as const,
  active: true,
};

async function register(email: string, firstName: string, ip?: string) {
  const registered = await call("/auth/register", {
    method: "POST",
    ip,
    body: {
      email,
      firstName,
      lastName: "Owner",
      password: "correcthorsebattery",
    },
  });
  assert.equal(registered.status, 200);
  const preview = (registered.data.verification as Json).preview as Json;
  const verified = await call("/auth/verify-email", {
    method: "POST",
    ip,
    token: String(registered.data.token),
    body: { code: preview.code },
  });
  assert.equal(verified.status, 200);
  return {
    token: String(verified.data.token),
    admin: verified.data.admin as Json,
  };
}

describe("one owner per quiet space", { concurrency: 1 }, () => {
  test("blocks a second claim and lets a site admin reset or reassign it", async () => {
    const ada = await register("ada@example.com", "Ada");
    assert.equal(ada.admin.siteAdmin, false);
    const created = await call("/admin/venues", {
      method: "POST",
      token: ada.token,
      body: austin,
    });
    assert.equal(created.status, 201);
    const venueId = String((created.data.venue as Json).id);

    // Retry after a dropped connection: same owner, same space -> existing space, no duplicate.
    const retried = await call("/admin/venues", { method: "POST", token: ada.token, body: austin });
    assert.equal(retried.status, 200);
    assert.equal(retried.data.existing, true);
    assert.equal(String((retried.data.venue as Json).id), venueId);
    const mine = await call("/admin/venues", { token: ada.token });
    assert.equal((mine.data.venues as Json[]).length, 1);

    const grace = await register("grace@example.com", "Grace");
    const blocked = await call("/admin/venues", {
      method: "POST",
      token: grace.token,
      body: { ...austin, name: "Other hall" },
    });
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.data.error), /account manager/i);
    assert.equal(blocked.data.ownerEmail, "ad•••@example.com");
    assert.doesNotMatch(String(blocked.data.error), /ada@example\.com/);
    assert.equal(blocked.data.claimVenueId, venueId);
    assert.equal(blocked.data.contactOwner, true);
    const relayed = await call(`/admin/venues/${venueId}/contact-owner`, {
      method: "POST",
      token: grace.token,
      body: { spaceName: "Other hall", message: "Is this ours?" },
    });
    assert.equal(relayed.status, 200);
    assert.equal(relayed.data.ownerEmail, "ad•••@example.com");
    const self = await call(`/admin/venues/${venueId}/contact-owner`, {
      method: "POST",
      token: ada.token,
      body: {},
    });
    assert.equal(self.status, 400);
    for (let i = 0; i < 4; i += 1) {
      await call(`/admin/venues/${venueId}/contact-owner`, { method: "POST", token: grace.token, body: {} });
    }
    const limited = await call(`/admin/venues/${venueId}/contact-owner`, {
      method: "POST",
      token: grace.token,
      body: {},
    });
    assert.equal(limited.status, 429);
    assert.equal(blocked.data.supportUrl, "https://phonesilent.com/support");

    const linus = await register("linus@example.com", "Linus");
    const far = await call("/admin/venues", {
      method: "POST",
      token: linus.token,
      body: {
        ...austin,
        name: "Compiler hall",
        address: "1 Broadway, New York, NY",
        lat: 40.705,
        lng: -74.013,
      },
    });
    assert.equal(far.status, 201);
    const farId = String((far.data.venue as Json).id);

    const outsider = await call("/site-admin/venues", { token: grace.token });
    assert.equal(outsider.status, 403);
    const signedOut = await call("/site-admin/venues");
    assert.equal(signedOut.status, 401);

    const matt = await register("mattoceancc@gmail.com", "Matt");
    assert.equal(matt.admin.siteAdmin, true);
    const listed = await call("/site-admin/venues?q=sanctuary", { token: matt.token });
    assert.equal(listed.status, 200);
    const spaces = listed.data.venues as Json[];
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0].ownerEmail, "ada@example.com");
    assert.equal(spaces[0].claimReleased, false);
    assert.equal(spaces[0].active, true);

    const reset = await call(`/site-admin/venues/${venueId}/reset-owner`, {
      method: "POST",
      token: matt.token,
      body: {},
    });
    assert.equal(reset.status, 200);
    const paused = reset.data.venue as Json;
    assert.equal(paused.active, false);
    assert.equal(paused.claimReleased, true);
    assert.equal(paused.ownerEmail, "ada@example.com");

    const taken = await call("/admin/venues", {
      method: "POST",
      token: grace.token,
      body: { ...austin, name: "Grace chapel" },
    });
    assert.equal(taken.status, 201);
    const takenVenue = taken.data.venue as Json;
    assert.equal(takenVenue.id, venueId);
    assert.equal(takenVenue.accountManagerId, grace.admin.id);
    assert.equal(takenVenue.active, true);

    const after = await call("/site-admin/venues?q=ada@example.com", { token: matt.token });
    assert.equal((after.data.venues as Json[]).length, 0);
    const now = await call("/site-admin/venues?q=grace@example.com", { token: matt.token });
    const current = (now.data.venues as Json[])[0];
    assert.equal(current.claimReleased, false);
    assert.equal(current.active, true);
    assert.equal(current.ownerName, "Grace Owner");

    const missing = await call(`/site-admin/venues/${venueId}/owner`, {
      method: "POST",
      token: matt.token,
      body: { email: "nobody@example.com" },
    });
    assert.equal(missing.status, 404);

    const reassigned = await call(`/site-admin/venues/${venueId}/owner`, {
      method: "POST",
      token: matt.token,
      body: { email: "Ada@Example.com" },
    });
    assert.equal(reassigned.status, 200);
    const moved = reassigned.data.venue as Json;
    assert.equal(moved.ownerEmail, "ada@example.com");
    assert.equal(moved.active, true);
    assert.equal(moved.claimReleased, false);

    const empty = await call("/site-admin/venues?q=no-such-space", { token: matt.token });
    assert.deepEqual(empty.data.venues, []);

    const movedOnto = await call(`/admin/venues/${farId}`, {
      method: "PATCH",
      token: linus.token,
      body: { lat: austin.lat, lng: austin.lng, address: austin.address },
    });
    assert.equal(movedOnto.status, 409);
    assert.equal(movedOnto.data.ownerEmail, "ad•••@example.com");
  });

  test("placeholder addresses do not match across accounts", async () => {
    const base = { ...austin, name: "Pin A", address: "Current location", lat: 35.0, lng: -80.0 };
    const one = await register("pin-a@example.com", "PinA", "198.51.100.97");
    const first = await call("/admin/venues", { method: "POST", token: one.token, body: base });
    assert.equal(first.status, 201);
    const two = await register("pin-b@example.com", "PinB", "198.51.100.98");
    // ~100 m north: outside the 38.1 m zone.
    const near = { ...base, name: "Pin B", address: "current LOCATION", lat: 35.0009 };
    const second = await call("/admin/venues", { method: "POST", token: two.token, body: near });
    assert.equal(second.status, 201);
    const three = await register("pin-c@example.com", "PinC", "198.51.100.99");
    const coords = { ...base, name: "Pin C", address: "35.0, -80.0009", lng: -80.0009 };
    const third = await call("/admin/venues", { method: "POST", token: three.token, body: coords });
    assert.equal(third.status, 201);
  });

  test("only the real 125 ft zone of a free space blocks, not the 100 m iOS ring", async () => {
    // 1e-5 deg latitude ~= 1.11 m.
    const base = { ...austin, name: "Zone A", address: "500 Zone Ave, Austin, TX", lat: 31.0, lng: -97.0 };
    const owner = await register("zone-a@example.com", "ZoneA", "198.51.100.120");
    assert.equal((await call("/admin/venues", { method: "POST", token: owner.token, body: base })).status, 201);

    const b = await register("zone-b@example.com", "ZoneB", "198.51.100.121");
    // ~30 m north: inside the 38.1 m free zone.
    const at30 = { ...base, name: "Zone B", lat: 31.00027 };
    const blocked = await call("/admin/venues", { method: "POST", token: b.token, body: at30 });
    assert.equal(blocked.status, 409);

    // ~50 m north: outside 38.1 m, inside the 100 m (~328 ft) monitored ring.
    const at50 = { ...base, name: "Zone B", lat: 31.00045 };
    const allowed = await call("/admin/venues", { method: "POST", token: b.token, body: at50 });
    assert.equal(allowed.status, 201);

    // Same street address ~100 m away no longer blocks (old 150 m address match).
    const c = await register("zone-c@example.com", "ZoneC", "198.51.100.122");
    const sameAddr = { ...base, name: "Zone C", lng: -97.00105 };
    const third = await call("/admin/venues", { method: "POST", token: c.token, body: sameAddr });
    assert.equal(third.status, 201);
  });

  test("a paid polygon blocks only inside the polygon, not its covering circle", () => {
    // ~100 m x ~20 m strip centred on (32, -98); covering circle radius ~51 m.
    const polygon = [
      { lat: 31.99955, lng: -98.000106 },
      { lat: 32.00045, lng: -98.000106 },
      { lat: 32.00045, lng: -97.999894 },
      { lat: 31.99955, lng: -97.999894 },
    ];
    const row = { lat: 32, lng: -98, radius_meters: 52, plan: "paid", polygon: JSON.stringify(polygon) };
    assert.equal(insideRealZone(row, 32.00005, -98), true); // inside polygon
    // ~30 m east: outside the strip, inside the 52 m covering circle.
    assert.equal(insideRealZone(row, 32, -97.99968), false);
    // Paid circle (no polygon) uses its own radius.
    const circle = { lat: 32, lng: -98, radius_meters: 80, plan: "paid", polygon: null };
    assert.equal(insideRealZone(circle, 32.0007, -98), true); // ~78 m
    assert.equal(insideRealZone(circle, 32.0008, -98), false); // ~89 m
    // Free space: 38.1 m regardless of stored radius.
    const free = { lat: 32, lng: -98, radius_meters: 100, plan: "free", polygon: null };
    assert.equal(insideRealZone(free, 32.00027, -98), true);
    assert.equal(insideRealZone(free, 32.00045, -98), false);
  });

  test("treats a blank SITE_ADMIN_EMAILS as the default owner", async () => {
    process.env.SITE_ADMIN_EMAILS = "   ";
    try {
      const me = await call("/auth/login", {
        method: "POST",
        body: { email: "mattoceancc@gmail.com", password: "correcthorsebattery" },
      });
      assert.equal(me.status, 200);
      assert.equal((me.data.admin as Json).siteAdmin, true);
    } finally {
      delete process.env.SITE_ADMIN_EMAILS;
    }

    process.env.SITE_ADMIN_EMAILS = "owner@example.com";
    try {
      const me = await call("/auth/login", {
        method: "POST",
        body: { email: "mattoceancc@gmail.com", password: "correcthorsebattery" },
      });
      assert.equal((me.data.admin as Json).siteAdmin, false);
    } finally {
      delete process.env.SITE_ADMIN_EMAILS;
    }
  });
});
