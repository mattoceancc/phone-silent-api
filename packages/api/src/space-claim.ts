import { distanceMeters, FREE_RADIUS_METERS, isInsidePolygon } from "@phone-silent/shared";
import type { Coordinates } from "@phone-silent/shared";
import { db } from "./db";
import { configuredWebOrigin } from "./origins";

/** "mattoceancc@gmail.com" -> "ma•••@gmail.com". The owner's address is never shown in full. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return domain ? `${head}•••@${domain}` : `${head}•••`;
}

export class SpaceClaimedError extends Error {
  /** Masked owner email, safe to show. */
  readonly ownerEmail: string;
  readonly supportUrl: string;
  readonly venueId: string;

  constructor(ownerEmail: string, supportUrl: string, venueId: string) {
    const masked = maskEmail(ownerEmail);
    super(
      `This quiet space already has an account manager (${masked}). Contact the owner or support if the claim should be released.`,
    );
    this.name = "SpaceClaimedError";
    this.ownerEmail = masked;
    this.supportUrl = supportUrl;
    this.venueId = venueId;
  }

  toJson() {
    return {
      error: this.message,
      ownerEmail: this.ownerEmail,
      supportUrl: this.supportUrl,
      claimVenueId: this.venueId,
      contactOwner: true,
    };
  }
}

export function supportPageUrl(): string {
  const origin = configuredWebOrigin().replace(/\/$/, "");
  if (origin.startsWith("https://")) return `${origin}/support`;
  return "https://phonesilent.com/support";
}

type ClaimRow = {
  id: string;
  owner_id: string;
  owner_email: string;
  address: string;
  lat: number;
  lng: number;
  radius_meters: number;
  plan: string;
  polygon: string | null;
  claim_released: number;
};

export type ClaimDecision =
  | { kind: "clear" }
  | { kind: "blocked"; ownerEmail: string; supportUrl: string; venueId: string }
  | { kind: "takeover"; venueId: string };

function normalizeAddress(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function polygonOf(raw: string | null): Coordinates[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Coordinates[];
    return Array.isArray(parsed) && parsed.length >= 3 ? parsed : null;
  } catch {
    return null;
  }
}

const PLACEHOLDER_ADDRESSES = new Set([
  "",
  "current location",
  "my location",
  "dropped pin",
  "pin",
  "location",
  "unknown",
  "unknown address",
  "no address",
  "n a",
  "na",
]);

/** Generic or placeholder text ("Current location", "Dropped pin", bare coordinates) is not an address. */
export function isPlaceholderAddress(value: string | null | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (PLACEHOLDER_ADDRESSES.has(normalizeAddress(raw))) return true;
  // Coordinate-only strings like "39.9497, -74.3430" or "39.9497° N, 74.3430° W".
  return /^[\s()\[\]]*-?\d{1,3}(\.\d+)?\s*°?\s*[nsew]?\s*[,;\s]\s*-?\d{1,3}(\.\d+)?\s*°?\s*[nsew]?[\s()\[\]]*$/i.test(
    raw,
  );
}

/**
 * Inside the existing space's real quiet zone, and nothing wider:
 * - paid space with a polygon: the polygon only (not its covering circle);
 * - free space: the 125 ft (FREE_RADIUS_METERS) circle;
 * - paid circle space: its own radius.
 * The iOS 100 m monitored/approach ring and address text never cause a conflict.
 */
export function insideRealZone(
  row: Pick<ClaimRow, "lat" | "lng" | "radius_meters" | "plan" | "polygon">,
  lat: number,
  lng: number,
): boolean {
  const point = { lat, lng };
  const polygon = row.plan === "paid" ? polygonOf(row.polygon) : null;
  if (polygon) return isInsidePolygon(point, polygon);
  const radius = row.plan === "paid" ? Number(row.radius_meters) : FREE_RADIUS_METERS;
  return distanceMeters({ lat: row.lat, lng: row.lng }, point) <= radius;
}

function samePlace(row: ClaimRow, lat: number, lng: number): boolean {
  return insideRealZone(row, lat, lng);
}

/**
 * A quiet space has one account manager. A pin inside a claimed space is rejected.
 * A released claim can be registered again by the next account.
 */
export function evaluateSpaceClaim(input: {
  ownerId: string;
  lat: number;
  lng: number;
  address: string;
  exceptVenueId?: string;
  adoptReleased: boolean;
}): ClaimDecision {
  const rows = db
    .prepare(
      `SELECT v.id, v.owner_id, a.email AS owner_email, v.address, v.lat, v.lng,
              v.radius_meters, v.plan, v.polygon, v.claim_released
       FROM venues v
       JOIN admins a ON a.id = v.owner_id`,
    )
    .all() as ClaimRow[];
  const matches = rows.filter(
    (row) =>
      row.id !== input.exceptVenueId &&
      samePlace(row, input.lat, input.lng),
  );
  const released = (row: ClaimRow) => Number(row.claim_released) === 1;
  if (matches.some((row) => row.owner_id === input.ownerId && !released(row))) {
    return { kind: "clear" };
  }
  const held = matches.find((row) => row.owner_id !== input.ownerId && !released(row));
  if (held) {
    return {
      kind: "blocked",
      venueId: held.id,
      ownerEmail: held.owner_email,
      supportUrl: supportPageUrl(),
    };
  }
  if (!input.adoptReleased) return { kind: "clear" };
  const releasedRows = matches
    .filter((row) => released(row))
    .sort(
      (a, b) =>
        distanceMeters({ lat: a.lat, lng: a.lng }, { lat: input.lat, lng: input.lng }) -
        distanceMeters({ lat: b.lat, lng: b.lng }, { lat: input.lat, lng: input.lng }),
    );
  const next = releasedRows[0];
  if (!next) return { kind: "clear" };
  return { kind: "takeover", venueId: next.id };
}

/**
 * Idempotent create: the same account re-submitting the same space (same place,
 * same name) gets its existing space back instead of a duplicate or a claim error.
 * Covers retries after a dropped connection where the first create succeeded.
 */
export function findOwnSameSpace(input: {
  ownerId: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
}): string | null {
  const rows = db
    .prepare(
      `SELECT v.id, v.owner_id, a.email AS owner_email, v.name, v.address, v.lat, v.lng,
              v.radius_meters, v.plan, v.polygon, v.claim_released
       FROM venues v
       JOIN admins a ON a.id = v.owner_id
       WHERE v.owner_id = ? AND v.claim_released = 0
       ORDER BY v.created_at DESC`,
    )
    .all(input.ownerId) as (ClaimRow & { name: string })[];
  const wanted = normalizeAddress(input.name);
  const hit = rows.find(
    (row) =>
      normalizeAddress(row.name) === wanted &&
      samePlace(row, input.lat, input.lng),
  );
  return hit?.id ?? null;
}
