import { db, id, nowIso } from "./db";
import { escapeHtmlText, sendEmail } from "./email";
import { siteAdminEmails } from "./site-admins";
import { maskEmail } from "./space-claim";

/**
 * Ownership disputes. A signed-in account asks to take over a claimed space;
 * a super-admin approves (transfer) or denies. The current owner is told a
 * request exists, with the requester's email masked: support mediates, so the
 * owner does not get the requester's full address.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS ownership_requests (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ownership_requests_status ON ownership_requests(status, created_at);
`);

export type OwnershipRequest = {
  id: string;
  venueId: string;
  venueName: string;
  venueAddress: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

type Row = {
  id: string;
  venue_id: string;
  venue_name: string;
  venue_address: string;
  requester_id: string;
  requester_email: string;
  requester_first: string;
  requester_last: string;
  owner_id: string;
  owner_email: string;
  owner_first: string;
  owner_last: string;
  reason: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

const SELECT = `SELECT r.id, r.venue_id, v.name AS venue_name, v.address AS venue_address,
    r.requester_id, q.email AS requester_email, q.first_name AS requester_first, q.last_name AS requester_last,
    r.owner_id, o.email AS owner_email, o.first_name AS owner_first, o.last_name AS owner_last,
    r.reason, r.status, r.created_at, r.decided_at, r.decided_by
  FROM ownership_requests r
  JOIN venues v ON v.id = r.venue_id
  JOIN admins q ON q.id = r.requester_id
  JOIN admins o ON o.id = r.owner_id`;

function fullName(first: string, last: string, email: string): string {
  return `${first ?? ""} ${last ?? ""}`.trim() || email;
}

function toRequest(row: Row): OwnershipRequest {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    requesterId: row.requester_id,
    requesterName: fullName(row.requester_first, row.requester_last, row.requester_email),
    requesterEmail: row.requester_email,
    ownerId: row.owner_id,
    ownerName: fullName(row.owner_first, row.owner_last, row.owner_email),
    ownerEmail: row.owner_email,
    reason: row.reason,
    status: row.status === "approved" || row.status === "denied" ? row.status : "pending",
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function getOwnershipRequest(requestId: string): OwnershipRequest | null {
  const row = db.prepare(`${SELECT} WHERE r.id = ?`).get(requestId) as Row | undefined;
  return row ? toRequest(row) : null;
}

export function listOwnershipRequests(status: "pending" | "all" = "pending"): OwnershipRequest[] {
  const rows = (
    status === "all"
      ? db.prepare(`${SELECT} ORDER BY r.created_at DESC LIMIT 200`).all()
      : db.prepare(`${SELECT} WHERE r.status = 'pending' ORDER BY r.created_at ASC`).all()
  ) as Row[];
  return rows.map(toRequest);
}

function lines(html: string[]): string {
  return html.map((line) => (line ? `<p>${escapeHtmlText(line)}</p>` : "")).join("");
}

async function mail(to: string, subject: string, body: string[], replyTo?: string) {
  return sendEmail({ to, subject, text: body.join("\n"), html: lines(body), ...(replyTo ? { replyTo } : {}) }, "ownership");
}

export async function createOwnershipRequest(input: {
  venueId: string;
  requesterId: string;
  reason?: string | null;
}): Promise<
  | { ok: true; request: OwnershipRequest }
  | { ok: false; status: 400 | 404 | 409; error: string }
> {
  const venue = db
    .prepare(`SELECT id, owner_id, claim_released FROM venues WHERE id = ?`)
    .get(input.venueId) as { id: string; owner_id: string; claim_released: number } | undefined;
  if (!venue || Number(venue.claim_released) === 1) {
    return { ok: false, status: 404, error: "Space not found" };
  }
  if (venue.owner_id === input.requesterId) {
    return { ok: false, status: 400, error: "You already manage this space" };
  }
  const pending = db
    .prepare(
      `SELECT id FROM ownership_requests WHERE venue_id = ? AND requester_id = ? AND status = 'pending'`,
    )
    .get(input.venueId, input.requesterId);
  if (pending) {
    return { ok: false, status: 409, error: "You already have a pending ownership request for this space." };
  }
  const requestId = id("own");
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 1000) : null;
  db.prepare(
    `INSERT INTO ownership_requests (id, venue_id, requester_id, owner_id, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(requestId, venue.id, input.requesterId, venue.owner_id, reason, nowIso());
  const request = getOwnershipRequest(requestId)!;

  const review = "Review it at https://phonesilent.com/admin (Ownership requests).";
  for (const admin of siteAdminEmails()) {
    await mail(
      admin,
      `Phone Silent: ownership request for "${request.venueName}"`,
      [
        `${request.requesterName} (${request.requesterEmail}) asked to take over "${request.venueName}" (${request.venueAddress}).`,
        `Current owner: ${request.ownerName} (${request.ownerEmail}).`,
        `Reason: ${reason ?? "(none given)"}`,
        "",
        review,
      ],
      request.requesterEmail,
    );
  }
  await mail(request.ownerEmail, `Phone Silent: someone asked to manage "${request.venueName}"`, [
    `Hi ${request.ownerName},`,
    `An account (${maskEmail(request.requesterEmail)}) asked Phone Silent support to transfer "${request.venueName}" to them.`,
    "Nothing changes unless support approves it. If this space is yours and in use, reply to this email or contact https://phonesilent.com/support so we can hear from you.",
  ]);
  return { ok: true, request };
}

export async function decideOwnershipRequest(input: {
  requestId: string;
  decision: "approve" | "deny";
  decidedBy: string;
  note?: string | null;
}): Promise<
  | { ok: true; request: OwnershipRequest }
  | { ok: false; status: 404 | 409; error: string }
> {
  const request = getOwnershipRequest(input.requestId);
  if (!request) return { ok: false, status: 404, error: "Request not found" };
  if (request.status !== "pending") {
    return { ok: false, status: 409, error: `This request was already ${request.status}.` };
  }
  const now = nowIso();
  const status = input.decision === "approve" ? "approved" : "denied";
  if (input.decision === "approve") {
    db.prepare(
      `UPDATE venues SET owner_id = ?, claim_released = 0, updated_at = ? WHERE id = ?`,
    ).run(request.requesterId, now, request.venueId);
    // Any other pending requests for this space are now moot.
    db.prepare(
      `UPDATE ownership_requests SET status = 'denied', decided_at = ?, decided_by = ?
       WHERE venue_id = ? AND status = 'pending' AND id != ?`,
    ).run(now, input.decidedBy, request.venueId, request.id);
  }
  db.prepare(
    `UPDATE ownership_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
  ).run(status, now, input.decidedBy, request.id);
  const note = input.note?.trim() ? ["", `Note from support: ${input.note.trim().slice(0, 1000)}`] : [];
  if (input.decision === "approve") {
    await mail(request.requesterEmail, `Phone Silent: you now manage "${request.venueName}"`, [
      `Hi ${request.requesterName},`,
      `Your ownership request was approved. "${request.venueName}" is now on your account.`,
      ...note,
    ]);
    await mail(request.ownerEmail, `Phone Silent: "${request.venueName}" was transferred`, [
      `Hi ${request.ownerName},`,
      `After review, Phone Silent support transferred "${request.venueName}" to another account.`,
      "If you think this is a mistake, reply to this email or contact https://phonesilent.com/support.",
      ...note,
    ]);
  } else {
    await mail(request.requesterEmail, `Phone Silent: ownership request for "${request.venueName}"`, [
      `Hi ${request.requesterName},`,
      `Your request to manage "${request.venueName}" was not approved.`,
      "If you have more information, contact https://phonesilent.com/support.",
      ...note,
    ]);
  }
  return { ok: true, request: getOwnershipRequest(request.id)! };
}
