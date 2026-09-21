import type { Coordinates, DayOfWeek, QuietWindow, Schedule } from "@phone-silent/shared";
import {
  coveringCircle,
  evaluateSilence,
  FREE_RADIUS_METERS,
  FREE_SPACE_LIMIT,
  reasonCopy,
} from "@phone-silent/shared";
import { db, id, nowIso } from "./db";

export type SpacePlan = "free" | "paid";

export type VenueRow = {
  id: string;
  owner_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radius_meters: number;
  timezone: string;
  join_code: string;
  active: number;
  created_at: string;
  plan: string;
  polygon: string | null;
  logo_data: string | null;
  billing_interval: string | null;
};

export type PublicVenue = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  timezone: string;
  joinCode: string;
  active: boolean;
  createdAt: string;
  windows: QuietWindow[];
  plan: SpacePlan;
  alwaysOn: boolean;
  polygon: Coordinates[] | null;
  hasLogo: boolean;
  billingInterval: "month" | "year" | null;
};

function parsePolygon(raw: string | null): Coordinates[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Coordinates[];
    return Array.isArray(parsed) && parsed.length >= 3 ? parsed : null;
  } catch {
    return null;
  }
}

export function windowsFor(venueId: string): QuietWindow[] {
  const rows = db
    .prepare(`SELECT days, start, end FROM quiet_windows WHERE venue_id = ?`)
    .all(venueId) as { days: string; start: string; end: string }[];
  return rows.map((row) => ({
    days: JSON.parse(row.days) as DayOfWeek[],
    start: row.start,
    end: row.end,
  }));
}

export function toPublic(row: VenueRow): PublicVenue {
  const plan: SpacePlan = row.plan === "paid" ? "paid" : "free";
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    radiusMeters: row.radius_meters,
    timezone: row.timezone,
    joinCode: row.join_code,
    active: row.active === 1,
    createdAt: row.created_at,
    windows: plan === "paid" ? windowsFor(row.id) : [],
    plan,
    alwaysOn: plan === "free",
    polygon: plan === "paid" ? parsePolygon(row.polygon) : null,
    hasLogo: plan === "paid" && Boolean(row.logo_data),
    billingInterval:
      row.billing_interval === "year" || row.billing_interval === "month"
        ? row.billing_interval
        : null,
  };
}

export function getVenue(venueId: string): PublicVenue | null {
  const row = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(venueId) as
    | VenueRow
    | undefined;
  return row ? toPublic(row) : null;
}

export function getVenueRow(venueId: string): VenueRow | undefined {
  return db.prepare(`SELECT * FROM venues WHERE id = ?`).get(venueId) as
    | VenueRow
    | undefined;
}

export function getVenueByCode(code: string): PublicVenue | null {
  const row = db
    .prepare(`SELECT * FROM venues WHERE join_code = ?`)
    .get(code.toUpperCase().trim()) as VenueRow | undefined;
  return row ? toPublic(row) : null;
}

export function listVenuesForOwner(ownerId: string): PublicVenue[] {
  const rows = db
    .prepare(`SELECT * FROM venues WHERE owner_id = ? ORDER BY created_at DESC`)
    .all(ownerId) as VenueRow[];
  return rows.map(toPublic);
}

export function countFreeSpaces(ownerId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM venues WHERE owner_id = ? AND plan = 'free'`)
    .get(ownerId) as { n: number | bigint };
  return Number(row.n);
}

export function listPublicVenues(): PublicVenue[] {
  const rows = db
    .prepare(`SELECT * FROM venues WHERE active = 1 ORDER BY name ASC`)
    .all() as VenueRow[];
  return rows.map(toPublic);
}

export function nearbyVenues(lat: number, lng: number, limit = 25): PublicVenue[] {
  const venues = listPublicVenues();
  return venues
    .map((venue) => ({
      venue,
      distance: evaluateSilence({
        geofence: {
          lat: venue.lat,
          lng: venue.lng,
          radiusMeters: venue.radiusMeters,
          polygon: venue.polygon ?? undefined,
        },
        schedule: scheduleOf(venue),
        now: new Date(),
        location: { lat, lng },
        venueActive: venue.active,
      }).distanceMeters,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((item) => item.venue);
}

export function replaceWindows(venueId: string, windows: QuietWindow[]): void {
  db.prepare(`DELETE FROM quiet_windows WHERE venue_id = ?`).run(venueId);
  const insert = db.prepare(
    `INSERT INTO quiet_windows (id, venue_id, days, start, end) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const window of windows) {
    insert.run(id("win"), venueId, JSON.stringify(window.days), window.start, window.end);
  }
}

export function createVenue(input: {
  ownerId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  timezone: string;
  joinCode: string;
  active: boolean;
  plan?: SpacePlan;
  billingInterval?: "month" | "year" | null;
  radiusMeters?: number;
  windows?: QuietWindow[];
  polygon?: Coordinates[] | null;
  logoData?: string | null;
}): PublicVenue {
  const plan: SpacePlan = input.plan === "paid" ? "paid" : "free";
  if (plan === "free" && countFreeSpaces(input.ownerId) >= FREE_SPACE_LIMIT) {
    throw new Error(
      `Free facilities can have ${FREE_SPACE_LIMIT} space. Additional spaces are paid — $39/mo or $390/yr per space.`,
    );
  }
  const venueId = id("ven");
  const radius = plan === "free" ? FREE_RADIUS_METERS : (input.radiusMeters ?? 80);
  db.prepare(
    `INSERT INTO venues
      (id, owner_id, name, address, lat, lng, radius_meters, timezone, join_code, active, created_at, plan, polygon, billing_interval, logo_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    venueId,
    input.ownerId,
    input.name,
    input.address,
    input.lat,
    input.lng,
    radius,
    input.timezone,
    input.joinCode.toUpperCase(),
    input.active ? 1 : 0,
    nowIso(),
    plan,
    plan === "paid" && input.polygon ? JSON.stringify(input.polygon) : null,
    plan === "paid" ? (input.billingInterval ?? "month") : null,
    plan === "paid" ? (input.logoData ?? null) : null,
  );
  if (plan === "paid" && input.windows?.length) {
    replaceWindows(venueId, input.windows);
  }
  return getVenue(venueId)!;
}

export function updateVenue(
  venueId: string,
  patch: Partial<{
    name: string;
    address: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    timezone: string;
    joinCode: string;
    active: boolean;
    windows: QuietWindow[];
    polygon: Coordinates[] | null;
    logoData: string | null;
  }>,
): PublicVenue | null {
  const current = getVenueRow(venueId);
  if (!current) return null;
  const plan: SpacePlan = current.plan === "paid" ? "paid" : "free";
  const nextRadius =
    plan === "free" ? FREE_RADIUS_METERS : (patch.radiusMeters ?? current.radius_meters);
  const nextPolygon =
    plan === "free"
      ? null
      : patch.polygon === undefined
        ? current.polygon
        : patch.polygon
          ? JSON.stringify(patch.polygon)
          : null;
  db.prepare(
    `UPDATE venues SET
      name = ?, address = ?, lat = ?, lng = ?, radius_meters = ?,
      timezone = ?, join_code = ?, active = ?, polygon = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.address ?? current.address,
    patch.lat ?? current.lat,
    patch.lng ?? current.lng,
    nextRadius,
    patch.timezone ?? current.timezone,
    (patch.joinCode ?? current.join_code).toUpperCase(),
    patch.active === undefined ? current.active : patch.active ? 1 : 0,
    nextPolygon,
    venueId,
  );
  if (plan === "paid" && patch.windows) replaceWindows(venueId, patch.windows);
  if (plan === "free") replaceWindows(venueId, []);
  if (plan === "paid" && patch.logoData !== undefined) {
    db.prepare(`UPDATE venues SET logo_data = ? WHERE id = ?`).run(patch.logoData, venueId);
  }
  return getVenue(venueId);
}

export function markPaid(venueId: string, interval: "month" | "year"): PublicVenue | null {
  db.prepare(
    `UPDATE venues SET plan = 'paid', billing_interval = ? WHERE id = ?`,
  ).run(interval, venueId);
  return getVenue(venueId);
}

export function applyWalkFence(venueId: string, points: Coordinates[]): PublicVenue | null {
  const current = getVenueRow(venueId);
  if (!current) return null;
  if (current.plan !== "paid") {
    throw new Error("Walk-to-set fence is a paid feature — $39/mo per space.");
  }
  if (points.length < 3) {
    throw new Error("Walk at least three points, then finish. You can edit the shape afterward.");
  }
  const circle = coveringCircle(points);
  db.prepare(
    `UPDATE venues SET lat = ?, lng = ?, radius_meters = ?, polygon = ? WHERE id = ?`,
  ).run(circle.lat, circle.lng, Math.ceil(circle.radiusMeters), JSON.stringify(points), venueId);
  return getVenue(venueId);
}

export function scheduleOf(venue: PublicVenue): Schedule {
  return {
    timezone: venue.timezone,
    windows: venue.windows,
    alwaysOn: venue.alwaysOn,
  };
}

export function joinVenue(mobileUserId: string, venueId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO memberships (mobile_user_id, venue_id, joined_at) VALUES (?, ?, ?)`,
  ).run(mobileUserId, venueId, nowIso());
}

export function leaveVenue(mobileUserId: string, venueId: string): void {
  db.prepare(
    `DELETE FROM memberships WHERE mobile_user_id = ? AND venue_id = ?`,
  ).run(mobileUserId, venueId);
}

export function joinedVenues(mobileUserId: string): PublicVenue[] {
  const rows = db
    .prepare(
      `SELECT v.* FROM venues v
       JOIN memberships m ON m.venue_id = v.id
       WHERE m.mobile_user_id = ?
       ORDER BY v.name ASC`,
    )
    .all(mobileUserId) as VenueRow[];
  return rows.map(toPublic);
}

export function evaluateFor(
  venues: PublicVenue[],
  lat: number,
  lng: number,
  at: Date,
) {
  // No membership filter: every active space in `venues` can silence the user.
  return venues.map((venue) => {
    const evaluation = evaluateSilence({
      geofence: {
        lat: venue.lat,
        lng: venue.lng,
        radiusMeters: venue.radiusMeters,
        polygon: venue.polygon ?? undefined,
      },
      schedule: scheduleOf(venue),
      now: at,
      location: { lat, lng },
      venueActive: venue.active,
    });
    return {
      venue,
      ...evaluation,
      reasonCopy: reasonCopy(evaluation.reason),
    };
  });
}

export function randomJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const exists = db.prepare(`SELECT id FROM venues WHERE join_code = ?`).get(code);
  return exists ? randomJoinCode() : code;
}

export function recordEvent(venueId: string, kind: "join" | "silence", at = new Date()): void {
  const day = at.toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO space_events (id, venue_id, kind, day, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id("evt"), venueId, kind, day, nowIso());
}

export function metricsFor(venueId: string) {
  const rows = db
    .prepare(
      `SELECT day, kind, COUNT(*) AS n FROM space_events
       WHERE venue_id = ?
       GROUP BY day, kind
       ORDER BY day DESC
       LIMIT 60`,
    )
    .all(venueId) as { day: string; kind: string; n: number | bigint }[];
  const byDay = new Map<string, { day: string; joins: number; silences: number }>();
  for (const row of rows) {
    const current = byDay.get(row.day) ?? { day: row.day, joins: 0, silences: 0 };
    if (row.kind === "join") current.joins = Number(row.n);
    if (row.kind === "silence") current.silences = Number(row.n);
    byDay.set(row.day, current);
  }
  const days = [...byDay.values()];
  return {
    days,
    totals: {
      joins: days.reduce((sum, item) => sum + item.joins, 0),
      silences: days.reduce((sum, item) => sum + item.silences, 0),
    },
  };
}

export function logoData(venueId: string): string | null {
  const row = getVenueRow(venueId);
  if (!row || row.plan !== "paid") return null;
  return row.logo_data;
}
