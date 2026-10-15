import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "ps-comp-")), "t.sqlite");
process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://127.0.0.1:43123";
delete process.env.RESEND_API_KEY;
delete process.env.SITE_ADMIN_EMAILS;

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

const space = (name: string, lat: number) => ({
  name, address: `${name} St`, lat, lng: -97.74,
  timezone: "America/Chicago", plan: "free" as const, active: true,
});

describe("comped accounts count as paid", { concurrency: 1 }, () => {
  test("no free-space limit and accountPaid for a comped owner", async () => {
    const reg = await call("/auth/register", {
      method: "POST",
      body: { email: "comp@example.com", firstName: "C", lastName: "P", password: "correcthorsebattery" },
    });
    assert.equal(reg.status, 200);
    const { token } = reg.data;
    const id = reg.data.admin.id as string;
    db.prepare(`UPDATE admins SET email_verified_at = ? WHERE id = ?`).run(new Date().toISOString(), id);

    // A free space created before the comp is still stored as plan = 'free'.
    const first = await call("/admin/venues", { method: "POST", token, body: space("One", 30.1) });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    let list = await call("/admin/venues", { token });
    assert.equal(list.data.freeUsed, 1);
    assert.equal(list.data.accountPaid, false);

    db.prepare(`UPDATE admins SET comped_at = ?, comped_by = 'test' WHERE id = ?`).run(new Date().toISOString(), id);
    list = await call("/admin/venues", { token });
    assert.equal(list.data.freeUsed, 0);
    assert.equal(list.data.accountPaid, true);
    assert.ok(list.data.venues.every((v: any) => v.plan === "paid"));

    const second = await call("/admin/venues", { method: "POST", token, body: space("Two", 31.2) });
    assert.equal(second.status, 201, JSON.stringify(second.data));
    assert.equal(second.data.venue.plan, "paid");
  });
});
