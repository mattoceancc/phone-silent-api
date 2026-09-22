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

db.exec(`
CREATE TABLE IF NOT EXISTS launch_signups (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'guest',
  message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function columnNames(table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

function addColumn(table: string, definition: string): void {
  const name = definition.split(/\s+/)[0];
  if (!columnNames(table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

addColumn("venues", "plan TEXT NOT NULL DEFAULT 'free'");
addColumn("venues", "polygon TEXT");
addColumn("venues", "logo_data TEXT");
addColumn("venues", "billing_interval TEXT");

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
