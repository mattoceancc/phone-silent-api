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

type Json = Record<string, unknown>;

async function call(
  pathname: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
) {
  const response = await app.request(pathname, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.16",
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

async function register(email: string, firstName: string) {
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

    const grace = await register("grace@example.com", "Grace");
    const blocked = await call("/admin/venues", {
      method: "POST",
      token: grace.token,
      body: { ...austin, name: "Other hall" },
    });
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.data.error), /account manager/i);
    assert.equal(blocked.data.ownerEmail, "ada@example.com");
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
    assert.equal(movedOnto.data.ownerEmail, "ada@example.com");
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
