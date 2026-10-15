import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATABASE_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "ps-paid-")),
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

describe("paid space defaults", () => {
  test("new paid space is active, 125 ft, and quiet at all hours until hours are set", async () => {
    const { token } = await register("paid-defaults@example.com", "Paige", "203.0.113.40");
    const created = await call("/admin/venues", {
      method: "POST",
      token,
      ip: "203.0.113.40",
      body: {
        name: "Chapel",
        address: "1 Church St, Denver, CO",
        lat: 39.74,
        lng: -104.99,
        timezone: "America/Denver",
        plan: "paid",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const venue = created.data.venue as Json;
    assert.equal(venue.plan, "paid");
    assert.equal(venue.active, true);
    assert.equal(venue.radiusMeters, 38.1);
    assert.deepEqual(venue.windows, []);
    assert.equal(venue.alwaysOn, true);

    const updated = await call(`/admin/venues/${String(venue.id)}`, {
      method: "PATCH",
      token,
      ip: "203.0.113.40",
      body: { windows: [{ days: [0], start: "09:00", end: "12:00" }] },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    const withHours = updated.data.venue as Json;
    assert.equal(withHours.alwaysOn, false);
    assert.equal((withHours.windows as unknown[]).length, 1);

    const cleared = await call(`/admin/venues/${String(venue.id)}`, {
      method: "PATCH",
      token,
      ip: "203.0.113.40",
      body: { windows: [] },
    });
    assert.equal((cleared.data.venue as Json).alwaysOn, true);
  });
});
