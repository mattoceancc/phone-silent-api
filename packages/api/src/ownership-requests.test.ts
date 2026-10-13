import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "ps-own-")), "test.sqlite");
process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://127.0.0.1:43123";
delete process.env.RESEND_API_KEY;
delete process.env.SITE_ADMIN_EMAILS;
delete process.env.SUPER_ADMIN_EMAILS;

const { app } = await import("./index");

type Json = Record<string, unknown>;
let ipSeq = 1;

async function call(pathname: string, opts: { method?: string; token?: string; body?: unknown; ip?: string } = {}) {
  const response = await app.request(pathname, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? "203.0.113.77",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: response.status, data: (await response.json()) as Json };
}

async function register(email: string, firstName: string) {
  const ip = `198.51.100.${ipSeq++}`;
  const registered = await call("/auth/register", {
    method: "POST",
    ip,
    body: { email, firstName, lastName: "Owner", password: "correcthorsebattery" },
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
  return String(verified.data.token);
}

const space = {
  name: "Chapel",
  address: "9 Lake Rd, Whiting, NJ",
  lat: 39.95,
  lng: -74.34,
  timezone: "America/New_York",
  plan: "free",
  active: true,
};

describe("ownership requests", { concurrency: 1 }, () => {
  test("request, refuse duplicates and self, list, approve and deny", async () => {
    const owner = await register("own-a@example.com", "Ann");
    const created = await call("/admin/venues", { method: "POST", token: owner, body: space });
    assert.equal(created.status, 201);
    const venueId = String((created.data.venue as Json).id);

    const self = await call(`/admin/venues/${venueId}/ownership-request`, { method: "POST", token: owner, body: {} });
    assert.equal(self.status, 400);
    const anon = await call(`/admin/venues/${venueId}/ownership-request`, { method: "POST", body: {} });
    assert.equal(anon.status, 401);

    const keswick = await register("own-b@example.com", "Bo");
    const req = await call(`/admin/venues/${venueId}/ownership-request`, {
      method: "POST",
      token: keswick,
      body: { reason: "This is our building" },
    });
    assert.equal(req.status, 201);
    const requestId = String((req.data.request as Json).id);
    const dup = await call(`/admin/venues/${venueId}/ownership-request`, { method: "POST", token: keswick, body: {} });
    assert.equal(dup.status, 409);

    const notAdmin = await call("/super-admin/ownership-requests", { token: keswick });
    assert.equal(notAdmin.status, 403);
    const matt = await register("mattoceancc@gmail.com", "Matt");
    const listed = await call("/super-admin/ownership-requests", { token: matt });
    assert.equal(listed.status, 200);
    const pending = listed.data.requests as Json[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requesterEmail, "own-b@example.com");
    assert.equal(pending[0].ownerEmail, "own-a@example.com");
    assert.equal(pending[0].reason, "This is our building");

    const approved = await call(`/super-admin/ownership-requests/${requestId}/approve`, { method: "POST", token: matt, body: {} });
    assert.equal(approved.status, 200);
    assert.equal((approved.data.request as Json).status, "approved");
    const again = await call(`/super-admin/ownership-requests/${requestId}/deny`, { method: "POST", token: matt, body: {} });
    assert.equal(again.status, 409);
    const mine = await call("/admin/venues", { token: keswick });
    assert.equal((mine.data.venues as Json[]).some((v) => v.id === venueId), true);
    const theirs = await call("/admin/venues", { token: owner });
    assert.equal((theirs.data.venues as Json[]).some((v) => v.id === venueId), false);

    // Former owner asks back; deny.
    const back = await call(`/admin/venues/${venueId}/ownership-request`, { method: "POST", token: owner, body: {} });
    assert.equal(back.status, 201);
    const denied = await call(`/super-admin/ownership-requests/${String((back.data.request as Json).id)}/deny`, {
      method: "POST",
      token: matt,
      body: { note: "Keswick verified" },
    });
    assert.equal(denied.status, 200);
    assert.equal((denied.data.request as Json).status, "denied");
    const empty = await call("/super-admin/ownership-requests", { token: matt });
    assert.deepEqual(empty.data.requests, []);
  });
});
