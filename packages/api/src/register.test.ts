import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { FREE_RADIUS_METERS } from "@phone-silent/shared";

process.env.DATABASE_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "ps-reg-")),
  "test.sqlite",
);
process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://127.0.0.1:43123";
delete process.env.RESEND_API_KEY;

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
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await response.json()) as Json;
  return { status: response.status, data };
}

const space = {
  name: "Main sanctuary",
  address: "123 Main St, Austin, TX",
  lat: 30.27,
  lng: -97.74,
  timezone: "America/Chicago",
  plan: "free" as const,
  active: true,
};

describe("register a quiet space", { concurrency: 1 }, () => {
  test("stores first and last name and keeps the space inactive until email is verified", async () => {
    const missing = await call("/auth/register", {
      method: "POST",
      body: { email: "ada@example.com", firstName: "Ada", password: "correcthorsebattery" },
    });
    assert.equal(missing.status, 400);
    assert.match(String(missing.data.error), /last name/i);

    const registered = await call("/auth/register", {
      method: "POST",
      body: {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        password: "correcthorsebattery",
      },
    });
    assert.equal(registered.status, 200);
    const admin = registered.data.admin as Json;
    assert.equal(admin.firstName, "Ada");
    assert.equal(admin.lastName, "Lovelace");
    assert.equal(admin.name, "Ada Lovelace");
    assert.equal(admin.emailVerified, false);
    const preview = (registered.data.verification as Json).preview as Json;
    assert.equal(typeof preview.code, "string");
    assert.match(String(preview.url), /\/verify-email\?token=/);
    const token = String(registered.data.token);

    const created = await call("/admin/venues", {
      method: "POST",
      token,
      body: space,
    });
    assert.equal(created.status, 201);
    const venue = created.data.venue as Json;
    assert.equal(venue.active, false);
    assert.equal(venue.accountManagerId, admin.id);
    assert.equal(venue.radiusMeters, FREE_RADIUS_METERS);
    assert.equal(venue.plan, "free");

    const blocked = await call(`/admin/venues/${venue.id}`, {
      method: "PATCH",
      token,
      body: { name: "Renamed" },
    });
    assert.equal(blocked.status, 403);

    const wrong = await call("/auth/verify-email", {
      method: "POST",
      token,
      body: { code: "000000" },
    });
    assert.equal(wrong.status, 400);

    const verified = await call("/auth/verify-email", {
      method: "POST",
      token,
      body: { code: preview.code },
    });
    assert.equal(verified.status, 200);
    assert.equal((verified.data.admin as Json).emailVerified, true);

    const after = await call(`/admin/venues/${venue.id}`, { token: String(verified.data.token) });
    assert.equal((after.data.venue as Json).active, true);

    const renamed = await call(`/admin/venues/${venue.id}`, {
      method: "PATCH",
      token: String(verified.data.token),
      body: { name: "Chapel" },
    });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.data.venue as Json).name, "Chapel");
  });

  test("sends a confirmation once a verified registrant creates a space", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((item) => String(item)).join(" "));
    };
    try {
      const registered = await call("/auth/register", {
        method: "POST",
        body: {
          email: "grace@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          password: "correcthorsebattery",
        },
      });
      const preview = (registered.data.verification as Json).preview as Json;
      const verified = await call("/auth/verify-email", {
        method: "POST",
        token: String(registered.data.token),
        body: { code: preview.code },
      });
      warnings.length = 0;
      const created = await call("/admin/venues", {
        method: "POST",
        token: String(verified.data.token),
        body: {
          ...space,
          name: "Compiler hall",
          address: "1 Broadway, New York, NY",
          lat: 40.705,
          lng: -74.013,
        },
      });
      assert.equal(created.status, 201);
      assert.equal((created.data.venue as Json).active, true);
      const log = warnings.join("\n");
      assert.match(log, /email_logged/);
      assert.match(log, /"kind":"confirm"/);
      assert.match(log, /account manager/i);
      assert.match(log, /Compiler hall/);
    } finally {
      console.warn = original;
    }
  });

  test("does not return the verification code when running in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const registered = await call("/auth/register", {
        method: "POST",
        body: {
          email: "linus@example.com",
          firstName: "Linus",
          lastName: "Torvalds",
          password: "correcthorsebattery",
        },
      });
      assert.equal(registered.status, 200);
      const verification = registered.data.verification as Json;
      assert.equal(verification.sent, false);
      assert.equal(verification.preview, undefined);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
