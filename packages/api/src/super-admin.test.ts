import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "ps-super-")), "t.sqlite");
process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://127.0.0.1:43123";
delete process.env.RESEND_API_KEY;
delete process.env.SITE_ADMIN_EMAILS;
delete process.env.SUPER_ADMIN_EMAILS;

const { app } = await import("./index");
const { db } = await import("./db");

async function call(p: string, o: { method?: string; token?: string; body?: unknown } = {}) {
  const r = await app.request(p, {
    method: o.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: r.status, data: (await r.json()) as any };
}

async function register(email: string) {
  const r = await call("/auth/register", {
    method: "POST",
    body: { email, firstName: "T", lastName: "U", password: "correcthorsebattery" },
  });
  assert.equal(r.status, 200);
  return { token: r.data.token as string, id: r.data.admin.id as string };
}
const verify = (id: string) =>
  db.prepare(`UPDATE admins SET email_verified_at = ? WHERE id = ?`).run(new Date().toISOString(), id);

const space = {
  name: "Chapel", address: "1 Main St", lat: 30.27, lng: -97.74,
  timezone: "America/Chicago", plan: "free" as const, active: true,
};
const endpoints = ["/super-admin/stats", "/super-admin/users", "/super-admin/spaces"];

describe("super admin", { concurrency: 1 }, () => {
  let boss: { token: string; id: string };
  let owner: { token: string; id: string };
  let venueId = "";

  test("rejects anonymous and non-super-admin owners", async () => {
    owner = await register("owner@example.com");
    verify(owner.id);
    for (const p of endpoints) {
      assert.equal((await call(p)).status, 401);
      assert.equal((await call(p, { token: owner.token })).status, 403);
    }
    const comp = await call("/super-admin/comp", {
      method: "POST", token: owner.token, body: { kind: "user", id: owner.id, comped: true },
    });
    assert.equal(comp.status, 403);
  });

  test("unverified super-admin is blocked until verified", async () => {
    boss = await register("MattOceanCC@gmail.com");
    assert.equal((await call("/super-admin/stats", { token: boss.token })).status, 403);
    verify(boss.id);
    assert.equal((await call("/super-admin/stats", { token: boss.token })).status, 200);
  });

  test("stats, lists, and comp a space without touching plan", async () => {
    const created = await call("/admin/venues", { method: "POST", token: owner.token, body: space });
    assert.equal(created.status, 201);
    venueId = created.data.venue.id;
    let stats = (await call("/super-admin/stats", { token: boss.token })).data.stats;
    assert.equal(stats.users, 2);
    assert.equal(stats.spaces, 1);
    assert.deepEqual(stats.spacesByTier, { paid: 0, comped: 0, free: 1 });
    assert.equal(stats.signups.last7Days, 2);
    assert.deepEqual(stats.verification, { verified: 2, unverified: 0 });

    const comp = await call("/super-admin/comp", {
      method: "POST", token: boss.token, body: { kind: "space", id: venueId, comped: true },
    });
    assert.equal(comp.status, 200);
    assert.equal(comp.data.space.tier, "comped");
    assert.equal(comp.data.space.compedBy, "mattoceancc@gmail.com");
    assert.ok(comp.data.space.compedAt);
    assert.equal(comp.data.venue.plan, "paid");
    assert.equal(comp.data.venue.comped, true);
    const raw = db.prepare(`SELECT plan, billing_interval FROM venues WHERE id = ?`).get(venueId) as any;
    assert.equal(raw.plan, "free");
    assert.equal(raw.billing_interval, null);

    // Owner can now use paid features (quiet hours).
    const patch = await call(`/admin/venues/${venueId}`, {
      method: "PATCH", token: owner.token,
      body: { windows: [{ days: [0], start: "09:00", end: "12:00" }] },
    });
    assert.equal(patch.status, 200);
    stats = (await call("/super-admin/stats", { token: boss.token })).data.stats;
    assert.deepEqual(stats.spacesByTier, { paid: 0, comped: 1, free: 0 });

    const revoke = await call("/super-admin/comp", {
      method: "POST", token: boss.token, body: { kind: "space", id: venueId, comped: false },
    });
    assert.equal(revoke.data.space.tier, "free");
    assert.equal(revoke.data.space.compedAt, null);
    assert.equal(revoke.data.venue.plan, "free");
  });

  test("comp a user covers their spaces; real paid stays separate", async () => {
    const r = await call("/super-admin/comp", {
      method: "POST", token: boss.token, body: { kind: "user", id: owner.id, comped: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.tier, "comped");
    const spaces = (await call("/super-admin/spaces", { token: boss.token })).data.spaces;
    assert.equal(spaces[0].compedVia, "owner");
    await call(`/admin/venues/${venueId}/upgrade`, { method: "POST", token: owner.token, body: {} });
    const after = (await call("/super-admin/spaces", { token: boss.token })).data.spaces;
    assert.equal(after[0].tier, "paid");
    const missing = await call("/super-admin/comp", {
      method: "POST", token: boss.token, body: { kind: "space", id: "nope", comped: true },
    });
    assert.equal(missing.status, 404);
  });

  test("SUPER_ADMIN_EMAILS overrides the default", async () => {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    try {
      assert.equal((await call("/super-admin/stats", { token: owner.token })).status, 200);
      assert.equal((await call("/super-admin/stats", { token: boss.token })).status, 403);
    } finally {
      delete process.env.SUPER_ADMIN_EMAILS;
    }
  });
});
