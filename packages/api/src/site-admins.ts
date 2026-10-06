import { db, nowIso } from "./db";
import { visitorCountsByVenue, type VisitorCounts } from "./venues";

const DEFAULT_SITE_ADMIN = "mattoceancc@gmail.com";

/** Site-owner emails. A blank or missing SITE_ADMIN_EMAILS uses the default. */
export function siteAdminEmails(): string[] {
  const raw = process.env.SITE_ADMIN_EMAILS;
  const source = raw === undefined || raw.trim() === "" ? DEFAULT_SITE_ADMIN : raw;
  return [
    ...new Set(
      source
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function isSiteAdmin(email: string): boolean {
  return siteAdminEmails().includes(email.trim().toLowerCase());
}

export type SiteAdminSpace = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  plan: "free" | "paid";
  active: boolean;
  /** True when the facility account that owns this space has verified email. */
  ownerEmailVerified: boolean;
  claimReleased: boolean;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  createdAt: string;
  updatedAt: string;
  visitorCounts: VisitorCounts;
};

export type SiteAdminSpaceTotals = {
  spaces: number;
  joins: number;
  silences: number;
};

type SpaceRow = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  plan: string;
  active: number;
  claim_released: number;
  created_at: string;
  updated_at: string | null;
  owner_id: string;
  owner_email: string;
  owner_name: string;
  first_name: string;
  last_name: string;
  email_verified_at: string | null;
};

function toSpace(row: SpaceRow, visitorCounts: VisitorCounts): SiteAdminSpace {
  const first = row.first_name?.trim() ?? "";
  const last = row.last_name?.trim() ?? "";
  const ownerName = `${first} ${last}`.trim() || row.owner_name;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    plan: row.plan === "paid" ? "paid" : "free",
    active: Number(row.active) === 1,
    ownerEmailVerified: Boolean(row.email_verified_at),
    claimReleased: Number(row.claim_released) === 1,
    ownerId: row.owner_id,
    ownerName,
    ownerEmail: row.owner_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    visitorCounts,
  };
}

function likePattern(query: string): string {
  const cleaned = query.toLowerCase().replace(/[%_]/g, "").trim();
  return `%${cleaned}%`;
}

export function listSpacesForSiteAdmin(query: string): SiteAdminSpace[] {
  const q = query.trim();
  const pattern = likePattern(q);
  const rows = db
    .prepare(
      `SELECT v.id, v.name, v.address, v.lat, v.lng, v.plan, v.active, v.claim_released,
              v.created_at, v.updated_at, v.owner_id,
              a.email AS owner_email, a.name AS owner_name,
              a.first_name, a.last_name, a.email_verified_at
       FROM venues v
       JOIN admins a ON a.id = v.owner_id
       WHERE ? = ''
          OR lower(v.name) LIKE ?
          OR lower(v.address) LIKE ?
          OR lower(a.email) LIKE ?
       ORDER BY v.name COLLATE NOCASE`,
    )
    .all(q, pattern, pattern, pattern) as SpaceRow[];
  const counts = visitorCountsByVenue();
  return rows.map((row) => toSpace(row, counts.get(row.id) ?? { joins: 0, silences: 0 }));
}

export function summarizeSiteAdminSpaces(spaces: SiteAdminSpace[]): SiteAdminSpaceTotals {
  return spaces.reduce<SiteAdminSpaceTotals>(
    (totals, space) => ({
      spaces: totals.spaces + 1,
      joins: totals.joins + space.visitorCounts.joins,
      silences: totals.silences + space.visitorCounts.silences,
    }),
    { spaces: 0, joins: 0, silences: 0 },
  );
}

export function resetSpaceOwner(venueId: string): SiteAdminSpace | null {
  const existing = db.prepare(`SELECT id FROM venues WHERE id = ?`).get(venueId);
  if (!existing) return null;
  db.prepare(
    `UPDATE venues
     SET active = 0, activate_on_verify = 0, claim_released = 1, updated_at = ?
     WHERE id = ?`,
  ).run(nowIso(), venueId);
  return listSpacesForSiteAdmin("").find((space) => space.id === venueId) ?? null;
}

export function reassignSpaceOwner(
  venueId: string,
  email: string,
):
  | { ok: true; space: SiteAdminSpace }
  | { ok: false; status: 404; error: string } {
  const venue = db.prepare(`SELECT id FROM venues WHERE id = ?`).get(venueId);
  if (!venue) return { ok: false, status: 404, error: "Space not found" };
  const normalized = email.trim().toLowerCase();
  const admin = db
    .prepare(`SELECT id FROM admins WHERE email = ?`)
    .get(normalized) as { id: string } | undefined;
  if (!admin) {
    return { ok: false, status: 404, error: "No facility account uses that email." };
  }
  db.prepare(
    `UPDATE venues SET owner_id = ?, claim_released = 0, updated_at = ? WHERE id = ?`,
  ).run(admin.id, nowIso(), venueId);
  const space = listSpacesForSiteAdmin("").find((item) => item.id === venueId);
  if (!space) return { ok: false, status: 404, error: "Space not found" };
  return { ok: true, space };
}
