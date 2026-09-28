import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { db, id, nowIso } from "./db";

const VERIFY_HOURS = 24;

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

export type AdminPublic = {
  id: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
};

type AdminRow = {
  id: string;
  email: string;
  name: string;
  first_name: string;
  last_name: string;
  password_hash: string;
  email_verified_at: string | null;
};

function displayName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim().slice(0, 80);
}

export function toPublicAdmin(row: {
  id: string;
  email: string;
  name: string;
  first_name: string;
  last_name: string;
  email_verified_at: string | null;
}): AdminPublic {
  const firstName = row.first_name?.trim() || row.name.trim();
  const lastName = row.last_name?.trim() || "";
  return {
    id: row.id,
    email: row.email,
    name: displayName(firstName, lastName) || row.name,
    firstName,
    lastName,
    emailVerified: Boolean(row.email_verified_at),
  };
}

export function createAdmin(input: {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}) {
  const adminId = id("adm");
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  db.prepare(
    `INSERT INTO admins
      (id, email, name, first_name, last_name, password_hash, created_at, email_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    adminId,
    input.email.toLowerCase().trim(),
    displayName(firstName, lastName),
    firstName,
    lastName,
    hashPassword(input.password),
    nowIso(),
  );
  return adminId;
}

export function findAdminByEmail(email: string) {
  return db
    .prepare(
      `SELECT id, email, name, first_name, last_name, password_hash, email_verified_at
       FROM admins WHERE email = ?`,
    )
    .get(email.toLowerCase().trim()) as AdminRow | undefined;
}

export function findAdminById(adminId: string): AdminPublic | undefined {
  const row = db
    .prepare(
      `SELECT id, email, name, first_name, last_name, password_hash, email_verified_at
       FROM admins WHERE id = ?`,
    )
    .get(adminId) as AdminRow | undefined;
  return row ? toPublicAdmin(row) : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(storedHex: string, candidateHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  const candidate = Buffer.from(candidateHex, "hex");
  if (stored.length === 0 || stored.length !== candidate.length) return false;
  return timingSafeEqual(stored, candidate);
}

export function issueEmailVerification(adminId: string): {
  token: string;
  code: string;
  expiresAt: string;
} {
  const token = randomBytes(32).toString("hex");
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const created = nowIso();
  const expiresAt = new Date(Date.now() + VERIFY_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM email_verifications WHERE admin_id = ? AND used_at IS NULL`).run(
    adminId,
  );
  db.prepare(
    `INSERT INTO email_verifications
      (id, admin_id, token_hash, code_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id("emv"), adminId, sha256(token), sha256(code), created, expiresAt);
  return { token, code, expiresAt };
}

function activateSpacesWaitingOnEmail(adminId: string): void {
  const verifiedAt = nowIso();
  db.prepare(
    `UPDATE admins SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL`,
  ).run(verifiedAt, adminId);
  db.prepare(
    `UPDATE venues SET active = 1, activate_on_verify = 0
     WHERE owner_id = ? AND activate_on_verify = 1`,
  ).run(adminId);
}

type VerificationRow = {
  id: string;
  admin_id: string;
  token_hash: string;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
};

export function consumeEmailVerification(input: {
  token?: string;
  adminId?: string;
  code?: string;
}): { ok: true; adminId: string } | { ok: false; error: string } {
  if (input.token) {
    const row = db
      .prepare(
        `SELECT id, admin_id, token_hash, code_hash, expires_at, used_at
         FROM email_verifications WHERE token_hash = ?`,
      )
      .get(sha256(input.token)) as VerificationRow | undefined;
    if (!row) return { ok: false, error: "That verification link is invalid." };
    if (row.used_at) {
      const admin = findAdminById(row.admin_id);
      if (admin?.emailVerified) return { ok: true, adminId: row.admin_id };
      return { ok: false, error: "That verification link was already used." };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false, error: "That verification link has expired. Request a new one." };
    }
    db.prepare(`UPDATE email_verifications SET used_at = ? WHERE id = ?`).run(nowIso(), row.id);
    activateSpacesWaitingOnEmail(row.admin_id);
    return { ok: true, adminId: row.admin_id };
  }

  const code = input.code?.trim();
  if (!input.adminId || !code) {
    return { ok: false, error: "Enter the verification code from your email." };
  }
  const admin = findAdminById(input.adminId);
  if (admin?.emailVerified) return { ok: true, adminId: input.adminId };
  const row = db
    .prepare(
      `SELECT id, admin_id, token_hash, code_hash, expires_at, used_at
       FROM email_verifications
       WHERE admin_id = ? AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(input.adminId) as VerificationRow | undefined;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "That code is incorrect or expired." };
  }
  if (!hashesEqual(row.code_hash, sha256(code))) {
    return { ok: false, error: "That code is incorrect or expired." };
  }
  db.prepare(`UPDATE email_verifications SET used_at = ? WHERE id = ?`).run(nowIso(), row.id);
  activateSpacesWaitingOnEmail(input.adminId);
  return { ok: true, adminId: input.adminId };
}

export function createMobileUser(): string {
  const mobileId = id("mob");
  db.prepare(`INSERT INTO mobile_users (id, created_at) VALUES (?, ?)`).run(
    mobileId,
    nowIso(),
  );
  return mobileId;
}
