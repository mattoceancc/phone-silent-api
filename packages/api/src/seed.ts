import type { Coordinates, DayOfWeek, QuietWindow } from "@phone-silent/shared";
import { FREE_RADIUS_METERS } from "@phone-silent/shared";
import { db, id, nowIso } from "./db";
import { createAdmin, findAdminByEmail } from "./auth";
import { recordEvent, replaceWindows } from "./venues";

export const DEMO_EMAIL = "demo@phonesilent.app";
export const DEMO_PASSWORD = "quiet-demo";

const STMARY_LOGO = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220">
    <rect width="640" height="220" rx="24" fill="#0a1f42"/>
    <text x="320" y="92" text-anchor="middle" fill="#7eb6ff" font-family="Georgia, serif" font-size="28">Cathedral</text>
    <text x="320" y="148" text-anchor="middle" fill="#f4f7ff" font-family="Georgia, serif" font-size="42">St. Mary's</text>
  </svg>`,
).toString("base64")}`;

const STMARY_POLYGON: Coordinates[] = [
  { lat: 30.27195, lng: -97.74025 },
  { lat: 30.27195, lng: -97.73935 },
  { lat: 30.27105, lng: -97.73935 },
  { lat: 30.27105, lng: -97.74025 },
];

export function seedIfEmpty(): { seeded: boolean; adminId: string } {
  let admin = findAdminByEmail(DEMO_EMAIL);
  if (!admin) {
    const adminId = createAdmin(DEMO_EMAIL, "Demo Facility", DEMO_PASSWORD);
    admin = { id: adminId, email: DEMO_EMAIL, name: "Demo Facility", password_hash: "" };
  }

  const count = db.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number | bigint };
  if (Number(count.n) === 0) {
    insertSpace({
      ownerId: admin.id,
      name: "Grace Fellowship",
      address: "501 W 15th St, Austin, TX 78701",
      lat: 30.2776,
      lng: -97.7437,
      joinCode: "GRACE",
      plan: "free",
      radiusMeters: FREE_RADIUS_METERS,
      windows: [],
    });
    const paidId = insertSpace({
      ownerId: admin.id,
      name: "St. Mary's Cathedral",
      address: "203 E 10th St, Austin, TX 78701",
      lat: 30.2715,
      lng: -97.7398,
      joinCode: "STMARY",
      plan: "paid",
      radiusMeters: 100,
      billingInterval: "month",
      polygon: STMARY_POLYGON,
      logoData: STMARY_LOGO,
      windows: [
        { days: [0] as DayOfWeek[], start: "08:00", end: "13:00" },
        { days: [6] as DayOfWeek[], start: "17:00", end: "18:30" },
      ] satisfies QuietWindow[],
    });
    seedDemoMetrics(paidId);
    return { seeded: true, adminId: admin.id };
  }

  syncDemoPlans(admin.id);
  return { seeded: false, adminId: admin.id };
}

function insertSpace(input: {
  ownerId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  joinCode: string;
  plan: "free" | "paid";
  radiusMeters: number;
  windows: QuietWindow[];
  billingInterval?: "month" | "year";
  polygon?: Coordinates[];
  logoData?: string | null;
}): string {
  const venueId = id("ven");
  db.prepare(
    `INSERT INTO venues
      (id, owner_id, name, address, lat, lng, radius_meters, timezone, join_code, active, created_at, plan, billing_interval, polygon, logo_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'America/Chicago', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    venueId,
    input.ownerId,
    input.name,
    input.address,
    input.lat,
    input.lng,
    input.radiusMeters,
    input.joinCode,
    nowIso(),
    input.plan,
    input.plan === "paid" ? (input.billingInterval ?? "month") : null,
    input.plan === "paid" && input.polygon ? JSON.stringify(input.polygon) : null,
    input.plan === "paid" ? (input.logoData ?? null) : null,
  );
  if (input.windows.length) replaceWindows(venueId, input.windows);
  return venueId;
}

function seedDemoMetrics(venueId: string) {
  const existing = db
    .prepare(`SELECT COUNT(*) AS n FROM space_events WHERE venue_id = ?`)
    .get(venueId) as { n: number | bigint };
  if (Number(existing.n) > 0) return;
  const days = ["2026-09-18", "2026-09-19", "2026-09-20"];
  for (const day of days) {
    const at = new Date(`${day}T16:00:00.000Z`);
    for (let i = 0; i < 3; i += 1) recordEvent(venueId, "join", at);
    for (let i = 0; i < 7; i += 1) recordEvent(venueId, "silence", at);
  }
}

function deleteSpace(venueId: string): void {
  db.prepare(`DELETE FROM space_events WHERE venue_id = ?`).run(venueId);
  db.prepare(`DELETE FROM quiet_windows WHERE venue_id = ?`).run(venueId);
  db.prepare(`DELETE FROM memberships WHERE venue_id = ?`).run(venueId);
  db.prepare(`DELETE FROM venues WHERE id = ?`).run(venueId);
}

function syncDemoPlans(ownerId: string): void {
  const grace = db.prepare(`SELECT id FROM venues WHERE join_code = 'GRACE'`).get() as
    | { id: string }
    | undefined;
  if (grace) {
    db.prepare(
      `UPDATE venues SET plan = 'free', radius_meters = ?, polygon = NULL, billing_interval = NULL, logo_data = NULL WHERE id = ?`,
    ).run(FREE_RADIUS_METERS, grace.id);
    replaceWindows(grace.id, []);
  }
  const stmary = db.prepare(`SELECT id FROM venues WHERE join_code = 'STMARY'`).get() as
    | { id: string }
    | undefined;
  if (stmary) {
    db.prepare(
      `UPDATE venues SET plan = 'paid', billing_interval = COALESCE(billing_interval, 'month'),
        polygon = COALESCE(polygon, ?), logo_data = COALESCE(logo_data, ?)
       WHERE id = ?`,
    ).run(JSON.stringify(STMARY_POLYGON), STMARY_LOGO, stmary.id);
    seedDemoMetrics(stmary.id);
  }

  const leftoverSmoke = db
    .prepare(
      `SELECT id FROM venues WHERE owner_id = ? AND (join_code LIKE 'SMOKE%' OR name LIKE 'Smoke %')`,
    )
    .all(ownerId) as { id: string }[];
  for (const row of leftoverSmoke) deleteSpace(row.id);

  const extraFree = db
    .prepare(`SELECT id FROM venues WHERE owner_id = ? AND plan = 'free' AND join_code != 'GRACE'`)
    .all(ownerId) as { id: string }[];
  for (const row of extraFree) {
    db.prepare(`UPDATE venues SET plan = 'paid', billing_interval = 'month' WHERE id = ?`).run(
      row.id,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = seedIfEmpty();
  console.log(
    result.seeded
      ? `Seeded free (GRACE) and paid (STMARY) spaces for ${DEMO_EMAIL}`
      : "Database already has spaces; demo plans synced.",
  );
}
