import { distanceMeters, FREE_RADIUS_METERS, isInsidePolygon } from "@phone-silent/shared";
import type { Coordinates } from "@phone-silent/shared";
import { db } from "./db";
import { configuredWebOrigin } from "./origins";

const ADDRESS_MATCH_METERS = 150;

export class SpaceClaimedError extends Error {
  readonly ownerEmail: string;
  readonly supportUrl: string;

  constructor(ownerEmail: string, supportUrl: string) {
    super(
      `This quiet space already has an account manager (${ownerEmail}). Sign in with that account, or contact support if the claim should be released.`,
    );
    this.name = "SpaceClaimedError";
    this.ownerEmail = ownerEmail;
    this.supportUrl = supportUrl;
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
  | { kind: "blocked"; ownerEmail: string; supportUrl: string }
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

/** Same building: inside the quiet zone, or the same address within a short walk. */
function samePlace(row: ClaimRow, lat: number, lng: number, address: string): boolean {
  const point = { lat, lng };
  const center = { lat: row.lat, lng: row.lng };
  const polygon = row.plan === "paid" ? polygonOf(row.polygon) : null;
  if (polygon && isInsidePolygon(point, polygon)) return true;
  const distance = distanceMeters(center, point);
  if (distance <= Math.max(row.radius_meters, FREE_RADIUS_METERS)) return true;
  const left = normalizeAddress(row.address);
  const right = normalizeAddress(address);
  return left.length >= 8 && left === right && distance <= ADDRESS_MATCH_METERS;
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
      samePlace(row, input.lat, input.lng, input.address),
  );
  const released = (row: ClaimRow) => Number(row.claim_released) === 1;
  if (matches.some((row) => row.owner_id === input.ownerId && !released(row))) {
    return { kind: "clear" };
  }
  const held = matches.find((row) => row.owner_id !== input.ownerId && !released(row));
  if (held) {
    return {
      kind: "blocked",
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
