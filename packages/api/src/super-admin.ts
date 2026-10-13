import { db, nowIso, touchVenue } from "./db";
import { getVenue } from "./venues";

type Tier = "paid" | "comped" | "free";

export type SuperAdminUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerified: boolean;
  tier: Tier;
  compedAt: string | null;
  compedBy: string | null;
  spaces: number;
};

export type SuperAdminSpace = {
  id: string;
  name: string;
  address: string;
  ownerId: string;
  ownerEmail: string;
  active: boolean;
  createdAt: string;
  tier: Tier;
  /** comp on the space itself, or inherited from the owner account */
  compedVia: "space" | "owner" | null;
  compedAt: string | null;
  compedBy: string | null;
};

function matches(q: string, values: string[]) {
  const needle = q.trim().toLowerCase();
  return !needle || values.some((v) => v.toLowerCase().includes(needle));
}

export function listSuperAdminUsers(q = ""): SuperAdminUser[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.email, a.name, a.created_at, a.email_verified_at, a.comped_at, a.comped_by,
              (SELECT COUNT(*) FROM venues v WHERE v.owner_id = a.id AND v.claim_released = 0) AS spaces,
              (SELECT COUNT(*) FROM venues v WHERE v.owner_id = a.id AND v.plan = 'paid' AND v.claim_released = 0) AS paid_spaces
       FROM admins a ORDER BY a.created_at DESC`,
    )
    .all() as {
    id: string; email: string; name: string; created_at: string; email_verified_at: string | null;
    comped_at: string | null; comped_by: string | null; spaces: number | bigint; paid_spaces: number | bigint;
  }[];
  return rows
    .filter((r) => matches(q, [r.email, r.name]))
    .map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: r.created_at,
      emailVerified: Boolean(r.email_verified_at),
      tier: Number(r.paid_spaces) > 0 ? "paid" : r.comped_at ? "comped" : "free",
      compedAt: r.comped_at,
      compedBy: r.comped_by,
      spaces: Number(r.spaces),
    }));
}

export function listSuperAdminSpaces(q = ""): SuperAdminSpace[] {
  const rows = db
    .prepare(
      `SELECT v.id, v.name, v.address, v.owner_id, v.active, v.created_at, v.plan,
              v.comped_at, v.comped_by, a.email AS owner_email,
              a.comped_at AS owner_comped_at, a.comped_by AS owner_comped_by
       FROM venues v JOIN admins a ON a.id = v.owner_id ORDER BY v.created_at DESC`,
    )
    .all() as {
    id: string; name: string; address: string; owner_id: string; active: number; created_at: string;
    plan: string; comped_at: string | null; comped_by: string | null; owner_email: string;
    owner_comped_at: string | null; owner_comped_by: string | null;
  }[];
  return rows
    .filter((r) => matches(q, [r.name, r.address, r.owner_email]))
    .map((r) => {
      const via = r.comped_at ? "space" : r.owner_comped_at ? "owner" : null;
      return {
        id: r.id,
        name: r.name,
        address: r.address,
        ownerId: r.owner_id,
        ownerEmail: r.owner_email,
        active: r.active === 1,
        createdAt: r.created_at,
        tier: r.plan === "paid" ? "paid" : via ? "comped" : "free",
        compedVia: via,
        compedAt: r.comped_at ?? r.owner_comped_at,
        compedBy: r.comped_by ?? r.owner_comped_by,
      };
    });
}

export function platformStats(now = new Date()) {
  const users = listSuperAdminUsers();
  const spaces = listSuperAdminSpaces();
  const since = (days: number) => now.getTime() - days * 86_400_000;
  const count = <T>(list: T[], fn: (x: T) => boolean) => list.filter(fn).length;
  return {
    users: users.length,
    spaces: spaces.length,
    usersByTier: {
      paid: count(users, (u) => u.tier === "paid"),
      comped: count(users, (u) => u.tier === "comped"),
      free: count(users, (u) => u.tier === "free"),
    },
    spacesByTier: {
      paid: count(spaces, (s) => s.tier === "paid"),
      comped: count(spaces, (s) => s.tier === "comped"),
      free: count(spaces, (s) => s.tier === "free"),
    },
    signups: {
      last7Days: count(users, (u) => new Date(u.createdAt).getTime() >= since(7)),
      last30Days: count(users, (u) => new Date(u.createdAt).getTime() >= since(30)),
    },
    verification: {
      verified: count(users, (u) => u.emailVerified),
      unverified: count(users, (u) => !u.emailVerified),
    },
  };
}

/** Grant or revoke the paid tier for free. Never touches plan / billing columns. */
export function setComp(kind: "user" | "space", targetId: string, comped: boolean, by: string) {
  const at = comped ? nowIso() : null;
  const actor = comped ? by : null;
  if (kind === "user") {
    const res = db
      .prepare(`UPDATE admins SET comped_at = ?, comped_by = ? WHERE id = ?`)
      .run(at, actor, targetId);
    if (Number(res.changes) === 0) return null;
    return { user: listSuperAdminUsers().find((u) => u.id === targetId) ?? null };
  }
  const res = db
    .prepare(`UPDATE venues SET comped_at = ?, comped_by = ? WHERE id = ?`)
    .run(at, actor, targetId);
  if (Number(res.changes) === 0) return null;
  touchVenue(targetId);
  return {
    space: listSuperAdminSpaces().find((s) => s.id === targetId) ?? null,
    venue: getVenue(targetId),
  };
}
