import { db, id, nowIso } from "./db";

export type LaunchRole = "guest" | "venue";

export function saveLaunchSignup(input: {
  email: string;
  name?: string;
  role?: LaunchRole;
  message?: string;
}): { id: string } {
  const email = input.email.toLowerCase().trim();
  const name = input.name?.trim() || null;
  const role = input.role ?? "guest";
  const message = input.message?.trim() || null;
  const now = nowIso();
  const existing = db.prepare(`SELECT id FROM launch_signups WHERE email = ?`).get(email) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE launch_signups SET name = ?, role = ?, message = ?, updated_at = ? WHERE id = ?`,
    ).run(name, role, message, now, existing.id);
    return { id: existing.id };
  }
  const signupId = id("lsu");
  db.prepare(
    `INSERT INTO launch_signups (id, email, name, role, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(signupId, email, name, role, message, now, now);
  return { id: signupId };
}
