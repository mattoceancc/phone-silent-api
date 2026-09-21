import { db } from "./db";
import { findAdminByEmail } from "./auth";

const DEMO_EMAIL = "demo@phonesilent.app";
const DEMO_JOIN_CODES = ["GRACE", "STMARY"] as const;

/**
 * Do not create demo/test spaces. Real admins register themselves.
 * If an older boot seeded Grace Fellowship / St. Mary's, strip those rows
 * and the demo facility account.
 */
export function seedIfEmpty(): { seeded: boolean } {
  removeDemoSpaces();
  removeDemoAdmin();
  return { seeded: false };
}

function deleteSpace(venueId: string): void {
  db.prepare(`DELETE FROM space_events WHERE venue_id = ?`).run(venueId);
  db.prepare(`DELETE FROM quiet_windows WHERE venue_id = ?`).run(venueId);
  db.prepare(`DELETE FROM memberships WHERE venue_id = ?`).run(venueId);
  db.prepare(`DELETE FROM venues WHERE id = ?`).run(venueId);
}

function removeDemoSpaces(): void {
  const rows = db
    .prepare(
      `SELECT id FROM venues WHERE join_code IN (${DEMO_JOIN_CODES.map(() => "?").join(", ")})`,
    )
    .all(...DEMO_JOIN_CODES) as { id: string }[];
  for (const row of rows) deleteSpace(row.id);
}

function removeDemoAdmin(): void {
  const admin = findAdminByEmail(DEMO_EMAIL);
  if (!admin) return;
  const leftover = db
    .prepare(`SELECT id FROM venues WHERE owner_id = ?`)
    .all(admin.id) as { id: string }[];
  for (const row of leftover) deleteSpace(row.id);
  db.prepare(`DELETE FROM sessions WHERE admin_id = ?`).run(admin.id);
  db.prepare(`DELETE FROM admins WHERE id = ?`).run(admin.id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedIfEmpty();
  console.log("Demo spaces are not seeded. Facility owners register from the web app.");
}
