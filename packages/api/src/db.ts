import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
// node:sqlite is a Node 22+ preview API; fine for this local MVP.

const here = dirname(fileURLToPath(import.meta.url));
export const dataDir = join(here, "..", "data");
export const dbPath = process.env.DATABASE_PATH ?? join(dataDir, "phone-silent.sqlite");

mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mobile_users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  admin_id TEXT,
  mobile_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admins(id),
  FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id)
);

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_meters INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  join_code TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES admins(id)
);

CREATE TABLE IF NOT EXISTS quiet_windows (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  days TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memberships (
  mobile_user_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (mobile_user_id, venue_id),
  FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id),
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS launch_signups (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (admin_id) REFERENCES admins(id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS space_events (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);
`);

function columnNames(table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

function addColumn(table: string, definition: string): boolean {
  const name = definition.split(/\s+/)[0];
  if (columnNames(table).includes(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
}

addColumn("venues", "plan TEXT NOT NULL DEFAULT 'free'");
addColumn("venues", "polygon TEXT");
addColumn("venues", "logo_data TEXT");
addColumn("venues", "billing_interval TEXT");
addColumn("venues", "activate_on_verify INTEGER NOT NULL DEFAULT 0");
addColumn("venues", "claim_released INTEGER NOT NULL DEFAULT 0");
const addedUpdatedAt = addColumn("venues", "updated_at TEXT");
if (addedUpdatedAt) {
  db.exec(
    `UPDATE venues SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''`,
  );
}
addColumn("admins", "first_name TEXT NOT NULL DEFAULT ''");
addColumn("admins", "last_name TEXT NOT NULL DEFAULT ''");
const addedEmailVerified = addColumn("admins", "email_verified_at TEXT");
if (addedEmailVerified) {
  // Accounts created before verification existed are already in use.
  db.exec(`UPDATE admins SET email_verified_at = created_at WHERE email_verified_at IS NULL`);
}

function backfillAdminNames(): void {
  const rows = db
    .prepare(
      `SELECT id, name FROM admins WHERE first_name = '' AND last_name = '' AND name != ''`,
    )
    .all() as { id: string; name: string }[];
  const update = db.prepare(
    `UPDATE admins SET first_name = ?, last_name = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const parts = row.name.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? "";
    const lastName = parts.slice(1).join(" ");
    if (!firstName && !lastName) continue;
    update.run(firstName, lastName, row.id);
  }
}

backfillAdminNames();

export function nowIso(): string {
  return new Date().toISOString();
}

export function touchVenue(venueId: string): void {
  db.prepare(`UPDATE venues SET updated_at = ? WHERE id = ?`).run(nowIso(), venueId);
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
