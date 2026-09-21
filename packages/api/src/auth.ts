import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, id, nowIso } from "./db";

const SESSION_DAYS = 14;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function createSession(opts: {
  adminId?: string;
  mobileUserId?: string;
}): string {
  const token = randomBytes(24).toString("hex");
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (token, admin_id, mobile_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, opts.adminId ?? null, opts.mobileUserId ?? null, created, expires);
  return token;
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export type SessionRow = {
  token: string;
  admin_id: string | null;
  mobile_user_id: string | null;
  expires_at: string;
};

export function getSession(token: string | undefined | null): SessionRow | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT token, admin_id, mobile_user_id, expires_at FROM sessions WHERE token = ?`,
    )
    .get(token) as SessionRow | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return row;
}

export function createAdmin(email: string, name: string, password: string) {
  const adminId = id("adm");
  db.prepare(
    `INSERT INTO admins (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(adminId, email.toLowerCase().trim(), name, hashPassword(password), nowIso());
  return adminId;
}

export function findAdminByEmail(email: string) {
  return db
    .prepare(`SELECT id, email, name, password_hash FROM admins WHERE email = ?`)
    .get(email.toLowerCase().trim()) as
    | { id: string; email: string; name: string; password_hash: string }
    | undefined;
}

export function findAdminById(adminId: string) {
  return db
    .prepare(`SELECT id, email, name FROM admins WHERE id = ?`)
    .get(adminId) as { id: string; email: string; name: string } | undefined;
}

export function createMobileUser(): string {
  const mobileId = id("mob");
  db.prepare(`INSERT INTO mobile_users (id, created_at) VALUES (?, ?)`).run(
    mobileId,
    nowIso(),
  );
  return mobileId;
}
