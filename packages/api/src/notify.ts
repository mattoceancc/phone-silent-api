import { db, id, nowIso } from "./db";

export type NotifyRole = "guest" | "venue";

export function saveLaunchSignup(input: {
  email: string;
  name: string | null;
  role: NotifyRole;
  message: string | null;
}): { id: string } {
  const email = input.email.trim().toLowerCase();
  const now = nowIso();
  const existing = db
    .prepare(`SELECT id FROM launch_signups WHERE email = ?`)
    .get(email) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE launch_signups
       SET name = ?, role = ?, message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.name, input.role, input.message, now, existing.id);
    return { id: existing.id };
  }

  const signupId = id("signup");
  try {
    db.prepare(
      `INSERT INTO launch_signups (id, email, name, role, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(signupId, email, input.name, input.role, input.message, now, now);
    return { id: signupId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (!message.includes("UNIQUE")) throw err;
    const raced = db
      .prepare(`SELECT id FROM launch_signups WHERE email = ?`)
      .get(email) as { id: string } | undefined;
    if (!raced) throw err;
    db.prepare(
      `UPDATE launch_signups
       SET name = ?, role = ?, message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.name, input.role, input.message, now, raced.id);
    return { id: raced.id };
  }
}
