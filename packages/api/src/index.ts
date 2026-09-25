import type { Context } from "hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  createMobileUser,
  createSession,
  destroySession,
  findAdminByEmail,
  findAdminById,
  getSession,
  createAdmin,
  verifyPassword,
} from "./auth";
import { seedIfEmpty } from "./seed";
import { searchAddresses } from "./geo-search";
import {
  applyWalkFence,
  countFreeSpaces,
  createVenue,
  evaluateFor,
  getVenue,
  getVenueByCode,
  joinedVenues,
  joinVenue,
  leaveVenue,
  listPublicVenues,
  listVenuesForOwner,
  logoData,
  markPaid,
  metricsFor,
  nearbyVenues,
  randomJoinCode,
  recordEvent,
  updateVenue,
} from "./venues";
import { FREE_RADIUS_METERS, UPGRADE_BLURB } from "@phone-silent/shared";
import { sendSupportEmail } from "./email";
import { saveLaunchSignup } from "./notify";
import { corsOrigin, isProduction } from "./origins";
import { clientIp, rateLimit } from "./rate-limit";
import { SUPPORT_TOPICS, saveSupportMessage, type SupportTopic } from "./support";

const PORT = Number(process.env.PORT ?? 43124);
const COOKIE = "ps_session";

const daySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

const windowSchema = z.object({
  days: z.array(daySchema).min(1),
  start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
});

const venueBody = z.object({
  name: z.string().trim().min(2).max(80),
  address: z.string().trim().min(3).max(200),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  radiusMeters: z.number().min(15).max(2000).optional(),
  timezone: z.string().min(3).max(64),
  joinCode: z
    .string()
    .trim()
    .min(4)
    .max(12)
    .regex(/^[A-Za-z0-9]+$/)
    .optional(),
  active: z.boolean().optional(),
  windows: z.array(windowSchema).optional(),
  plan: z.enum(["free", "paid"]).optional(),
  billingInterval: z.enum(["month", "year"]).optional(),
  polygon: z
    .array(z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }))
    .optional(),
  logoData: z.string().max(800_000).nullable().optional(),
});

const seed = seedIfEmpty();

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.header("Access-Control-Request-Private-Network") === "true") {
    c.header("Access-Control-Allow-Private-Network", "true");
  }
  await next();
});

app.use(
  "*",
  cors({
    origin: (origin) => corsOrigin(origin) ?? "",
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

function tokenFrom(c: Context) {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return getCookie(c, COOKIE);
}

function requireAdmin(c: Context) {
  const session = getSession(tokenFrom(c));
  if (!session?.admin_id) return null;
  const admin = findAdminById(session.admin_id);
  return admin ? { session, admin } : null;
}

function requireMobile(c: Context) {
  const session = getSession(tokenFrom(c));
  if (!session?.mobile_user_id) return null;
  return session;
}

function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isProduction(),
    path: "/",
    maxAge: 14 * 24 * 60 * 60,
  });
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "phone-silent-api",
    seededOnBoot: seed.seeded,
  }),
);

const honeypot = z.string().max(500).optional();

const notifyBody = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().max(80).optional(),
  role: z.enum(["guest", "venue"]).optional(),
  message: z.string().trim().max(2000).optional(),
  ps_hp: honeypot,
});

function tooMany(c: Context, bucket: string) {
  const limit = rateLimit(`${bucket}:${clientIp((name) => c.req.header(name))}`);
  if (limit.ok) return null;
  c.header("Retry-After", String(limit.retryAfterSec));
  return c.json(
    { error: "Too many messages. Please wait a few minutes and try again." },
    429,
  );
}

app.post("/notify", async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }
  const body = notifyBody.safeParse(json);
  if (!body.success) {
    const emailIssue = body.error.issues.some((issue) => issue.path[0] === "email");
    return c.json(
      {
        error: emailIssue
          ? "Enter a valid email address."
          : "Check the form and try again.",
      },
      400,
    );
  }

  const limited = tooMany(c, "notify");
  if (limited) return limited;

  if (body.data.ps_hp?.trim()) {
    return c.json({ ok: true });
  }

  const name = body.data.name ? body.data.name : null;
  const message = body.data.message ? body.data.message : null;
  const role = body.data.role ?? "guest";
  try {
    const saved = saveLaunchSignup({
      email: body.data.email,
      name,
      role,
      message,
    });
    const mailed = await sendSupportEmail({
      kind: "notify",
      name,
      email: body.data.email,
      topic: null,
      role,
      message,
    });
    console.info(
      JSON.stringify({
        event: "launch_signup",
        id: saved.id,
        email: body.data.email.trim().toLowerCase(),
        role,
        emailed: mailed.sent,
      }),
    );
    return c.json({ ok: true, id: saved.id });
  } catch (err) {
    console.error(err);
    return c.json({ error: "Could not save your email. Try again in a moment." }, 500);
  }
});

const supportBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  message: z.string().trim().min(1).max(4000),
  topic: z.enum(SUPPORT_TOPICS).optional(),
  ps_hp: honeypot,
});

app.post("/support", async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request" }, 400);
  }
  const body = supportBody.safeParse(json);
  if (!body.success) {
    const field = body.error.issues[0]?.path[0];
    const error =
      field === "email"
        ? "Enter a valid email address."
        : field === "name"
          ? "Name is required."
          : field === "message"
            ? "Message is required."
            : "Check the form and try again.";
    return c.json({ error }, 400);
  }

  const limited = tooMany(c, "support");
  if (limited) return limited;

  if (body.data.ps_hp?.trim()) {
    return c.json({ ok: true });
  }

  const topic: SupportTopic = body.data.topic ?? "General";
  try {
    const saved = saveSupportMessage({
      name: body.data.name,
      email: body.data.email,
      topic,
      message: body.data.message,
    });
    const mailed = await sendSupportEmail({
      kind: "support",
      name: body.data.name,
      email: body.data.email,
      topic,
      role: null,
      message: body.data.message,
    });
    console.info(
      JSON.stringify({
        event: "support_message",
        id: saved.id,
        email: body.data.email.trim().toLowerCase(),
        topic,
        emailed: mailed.sent,
      }),
    );
    return c.json({ ok: true, id: saved.id });
  } catch (err) {
    console.error(err);
    return c.json({ error: "Could not send your message. Try again in a moment." }, 500);
  }
});

app.post("/auth/register", async (c) => {
  const body = z
    .object({
      email: z.string().email(),
      name: z.string().trim().min(2).max(80),
      password: z.string().min(8).max(100),
    })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Invalid registration" }, 400);
  if (findAdminByEmail(body.data.email)) {
    return c.json({ error: "An account with that email already exists" }, 409);
  }
  const adminId = createAdmin(body.data.email, body.data.name, body.data.password);
  const token = createSession({ adminId });
  setSessionCookie(c, token);
  return c.json({
    token,
    admin: { id: adminId, email: body.data.email.toLowerCase(), name: body.data.name },
  });
});

app.post("/auth/login", async (c) => {
  const body = z
    .object({
      email: z.string().email(),
      password: z.string().min(1),
    })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "Invalid login" }, 400);
  const admin = findAdminByEmail(body.data.email);
  if (!admin || !verifyPassword(body.data.password, admin.password_hash)) {
    return c.json({ error: "Email or password is incorrect" }, 401);
  }
  const token = createSession({ adminId: admin.id });
  setSessionCookie(c, token);
  return c.json({
    token,
    admin: { id: admin.id, email: admin.email, name: admin.name },
  });
});

app.post("/auth/logout", (c) => {
  const token = tokenFrom(c);
  if (token) destroySession(token);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/auth/me", (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ admin: null }, 200);
  return c.json({ admin: auth.admin });
});

app.post("/mobile/session", (c) => {
  const mobileUserId = createMobileUser();
  const token = createSession({ mobileUserId });
  return c.json({ token, mobileUserId });
});

app.get("/venues/public", (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return c.json({ venues: nearbyVenues(lat, lng) });
  }
  return c.json({ venues: listPublicVenues() });
});

app.get("/venues/code/:code", (c) => {
  const venue = getVenueByCode(c.req.param("code"));
  if (!venue) return c.json({ error: "No space with that join code" }, 404);
  return c.json({ venue });
});

app.get("/admin/venues", (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  return c.json({
    venues: listVenuesForOwner(auth.admin.id),
    freeUsed: countFreeSpaces(auth.admin.id),
    pricing: { monthly: 39, yearly: 390, per: "space" },
  });
});

app.post("/admin/venues", async (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  const body = venueBody.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: "Check space details", details: body.error.flatten() }, 400);
  }
  const joinCode = body.data.joinCode?.toUpperCase() ?? randomJoinCode();
  if (getVenueByCode(joinCode)) {
    return c.json({ error: "That join code is already in use" }, 409);
  }
  const paid = body.data.plan === "paid";
  try {
    const venue = createVenue({
      ownerId: auth.admin.id,
      name: body.data.name,
      address: body.data.address,
      lat: body.data.lat,
      lng: body.data.lng,
      radiusMeters: body.data.radiusMeters,
      timezone: body.data.timezone,
      joinCode,
      active: body.data.active ?? true,
      plan: paid ? "paid" : "free",
      billingInterval: paid ? (body.data.billingInterval ?? "month") : null,
      windows: paid ? (body.data.windows ?? []) : [],
      polygon: paid ? (body.data.polygon ?? null) : null,
      logoData: paid ? (body.data.logoData ?? null) : null,
    });
    return c.json({ venue }, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : UPGRADE_BLURB, upgrade: true },
      402,
    );
  }
});

app.get("/admin/venues/:id", (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  const venue = getVenue(c.req.param("id"));
  if (!venue) return c.json({ error: "Space not found" }, 404);
  const row = listVenuesForOwner(auth.admin.id).find((item) => item.id === venue.id);
  if (!row) return c.json({ error: "Space not found" }, 404);
  return c.json({ venue });
});

app.patch("/admin/venues/:id", async (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  const existing = getVenue(c.req.param("id"));
  if (!existing) return c.json({ error: "Space not found" }, 404);
  const owned = listVenuesForOwner(auth.admin.id).some((item) => item.id === existing.id);
  if (!owned) return c.json({ error: "Space not found" }, 404);
  const body = venueBody.partial().safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: "Check space details", details: body.error.flatten() }, 400);
  }
  if (body.data.joinCode && getVenueByCode(body.data.joinCode)?.id !== existing.id) {
    return c.json({ error: "That join code is already in use" }, 409);
  }
  if (existing.plan === "free") {
    if (
      body.data.radiusMeters != null &&
      Math.abs(body.data.radiusMeters - FREE_RADIUS_METERS) > 0.2
    ) {
      return c.json({ error: UPGRADE_BLURB, upgrade: true }, 402);
    }
    if (body.data.windows?.length) {
      return c.json({ error: UPGRADE_BLURB, upgrade: true }, 402);
    }
    if (body.data.polygon?.length) {
      return c.json({ error: UPGRADE_BLURB, upgrade: true }, 402);
    }
    if (body.data.logoData) {
      return c.json({ error: UPGRADE_BLURB, upgrade: true }, 402);
    }
  }
  const venue = updateVenue(existing.id, {
    name: body.data.name,
    address: body.data.address,
    lat: body.data.lat,
    lng: body.data.lng,
    radiusMeters: existing.plan === "free" ? FREE_RADIUS_METERS : body.data.radiusMeters,
    timezone: body.data.timezone,
    joinCode: body.data.joinCode,
    active: body.data.active,
    windows: existing.plan === "paid" ? body.data.windows : [],
    polygon: existing.plan === "paid" ? body.data.polygon : null,
    logoData: existing.plan === "paid" ? body.data.logoData : undefined,
  });
  return c.json({ venue });
});

app.post("/admin/venues/:id/upgrade", async (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  const existing = getVenue(c.req.param("id"));
  if (!existing) return c.json({ error: "Space not found" }, 404);
  if (!listVenuesForOwner(auth.admin.id).some((item) => item.id === existing.id)) {
    return c.json({ error: "Space not found" }, 404);
  }
  const body = z
    .object({ interval: z.enum(["month", "year"]).default("month") })
    .safeParse((await c.req.json().catch(() => ({}))) ?? {});
  const interval = body.success ? body.data.interval : "month";
  const venue = markPaid(existing.id, interval);
  return c.json({
    venue,
    billing: {
      stub: true,
      message:
        "Stripe is stubbed in this MVP. This space is marked paid for demo. Plug Stripe Checkout here (price $39/mo or $390/yr per space).",
      amountUsd: interval === "year" ? 390 : 39,
      interval,
    },
  });
});

app.post("/admin/venues/:id/fence-walk", async (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  const existing = getVenue(c.req.param("id"));
  if (!existing) return c.json({ error: "Space not found" }, 404);
  if (!listVenuesForOwner(auth.admin.id).some((item) => item.id === existing.id)) {
    return c.json({ error: "Space not found" }, 404);
  }
  if (existing.plan !== "paid") {
    return c.json({ error: UPGRADE_BLURB, upgrade: true }, 402);
  }
  const body = z
    .object({
      points: z
        .array(z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }))
        .min(3),
    })
    .safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: "Walk at least three GPS points, then finish." }, 400);
  }
  try {
    const venue = applyWalkFence(existing.id, body.data.points);
    return c.json({ venue });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : UPGRADE_BLURB }, 402);
  }
});

app.get("/admin/venues/:id/metrics", (c) => {
  const auth = requireAdmin(c);
  if (!auth) return c.json({ error: "Sign in required" }, 401);
  const existing = getVenue(c.req.param("id"));
  if (!existing) return c.json({ error: "Space not found" }, 404);
  if (!listVenuesForOwner(auth.admin.id).some((item) => item.id === existing.id)) {
    return c.json({ error: "Space not found" }, 404);
  }
  if (existing.plan !== "paid") {
    return c.json({ error: UPGRADE_BLURB, upgrade: true }, 402);
  }
  return c.json({ metrics: metricsFor(existing.id), anonymous: true });
});

app.get("/venues/:id/logo", (c) => {
  const data = logoData(c.req.param("id"));
  if (!data) return c.json({ error: "No logo" }, 404);
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(data);
  if (!match) return c.json({ logoData: data });
  const bytes = Buffer.from(match[2], "base64");
  return new Response(bytes, {
    headers: { "Content-Type": match[1], "Cache-Control": "no-store" },
  });
});

app.get("/me/venues", (c) => {
  const session = requireMobile(c);
  if (!session?.mobile_user_id) return c.json({ error: "Mobile session required" }, 401);
  return c.json({ venues: joinedVenues(session.mobile_user_id) });
});

app.post("/me/join", async (c) => {
  const session = requireMobile(c);
  if (!session?.mobile_user_id) return c.json({ error: "Mobile session required" }, 401);
  const body = z
    .object({
      joinCode: z.string().min(3).optional(),
      venueId: z.string().min(3).optional(),
    })
    .safeParse(await c.req.json());
  if (!body.success || (!body.data.joinCode && !body.data.venueId)) {
    return c.json({ error: "Provide a join code or venue id" }, 400);
  }
  const venue = body.data.venueId
    ? getVenue(body.data.venueId)
    : getVenueByCode(body.data.joinCode!);
  if (!venue) return c.json({ error: "Space not found" }, 404);
  if (!venue.active) return c.json({ error: "This space has paused Phone Silent" }, 409);
  joinVenue(session.mobile_user_id, venue.id);
  recordEvent(venue.id, "join");
  return c.json({ venue, venues: joinedVenues(session.mobile_user_id) });
});

app.post("/me/leave", async (c) => {
  const session = requireMobile(c);
  if (!session?.mobile_user_id) return c.json({ error: "Mobile session required" }, 401);
  const body = z.object({ venueId: z.string() }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "venueId required" }, 400);
  leaveVenue(session.mobile_user_id, body.data.venueId);
  return c.json({ venues: joinedVenues(session.mobile_user_id) });
});

app.post("/evaluate", async (c) => {
  const body = z
    .object({
      lat: z.number().gte(-90).lte(90),
      lng: z.number().gte(-180).lte(180),
      at: z.string().datetime().optional(),
      joinCode: z.string().optional(),
      venueIds: z.array(z.string()).optional(),
    })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "lat, lng required" }, 400);

  const at = body.data.at ? new Date(body.data.at) : new Date();
  // Quiet spaces apply to every app user inside the fence — no join/membership.
  // Optional joinCode / venueIds on the body are ignored (legacy visitor join).
  const venues = nearbyVenues(body.data.lat, body.data.lng, 200);

  const results = evaluateFor(venues, body.data.lat, body.data.lng, at);
  const active = results.filter((item) => item.shouldSilence);
  for (const item of active) {
    recordEvent(item.venue.id, "silence", at);
  }
  return c.json({
    at: at.toISOString(),
    location: { lat: body.data.lat, lng: body.data.lng },
    results,
    shouldSilence: active.length > 0,
    activeVenue: active[0]?.venue ?? null,
  });
});

app.get("/geo/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 3) return c.json({ results: [] });
  const results = await searchAddresses(q);
  return c.json({ results });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Server error" }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Phone Silent API on http://127.0.0.1:${info.port}`);
});
