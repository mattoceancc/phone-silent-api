import { configuredWebOrigin } from "./origins";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

const DEFAULT_TO = "mattoceancc@gmail.com";
const DEFAULT_FROM = "Phone Silent <support@phonesilent.com>";

export type SupportEmailInput = {
  kind: "support" | "notify";
  name: string | null;
  email: string;
  topic: string | null;
  role: string | null;
  message: string | null;
};

function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function supportToEmail(): string {
  return envOr("SUPPORT_TO_EMAIL", DEFAULT_TO);
}

export function supportFromEmail(): string {
  return envOr("SUPPORT_FROM_EMAIL", DEFAULT_FROM);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function buildSupportEmail(input: SupportEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const name = input.name?.trim() || "(not provided)";
  const email = input.email.trim();
  const message = input.message?.trim() || "(no message)";
  const lines = [
    input.kind === "support" ? "New support message" : "New launch-list signup",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
  ];
  if (input.kind === "support") {
    lines.push(`Topic: ${input.topic?.trim() || "General"}`);
  }
  if (input.role) {
    lines.push(`Role: ${input.role}`);
  }
  lines.push("", "Message:", message);
  const text = lines.join("\n");

  const subject =
    input.kind === "support"
      ? clip(
          `Phone Silent support: ${oneLine(input.topic?.trim() || "General")} — ${oneLine(name)}`,
          180,
        )
      : clip(`Phone Silent notify: ${oneLine(input.name?.trim() || email)}`, 180);

  const html = `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  return { subject, text, html };
}

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

export type EmailKind = "support" | "notify" | "verify" | "confirm";

/**
 * Sends with the Resend account already used for support mail.
 * Without RESEND_API_KEY, the message is logged and the caller continues.
 */
export async function sendEmail(
  message: OutboundEmail,
  kind: EmailKind,
): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.warn(
      JSON.stringify({
        event: "email_logged",
        reason: "RESEND_API_KEY is not set",
        kind,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    );
    return { sent: false };
  }

  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: supportFromEmail(),
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        JSON.stringify({
          event: "email_failed",
          kind,
          status: response.status,
          detail: detail.slice(0, 500),
        }),
      );
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "email_failed",
        kind,
        detail: err instanceof Error ? err.message : "request failed",
      }),
    );
    return { sent: false };
  }
}

/** Sends via Resend. Missing API key or a send failure is logged and does not throw. */
export async function sendSupportEmail(
  input: SupportEmailInput,
): Promise<{ sent: boolean }> {
  const built = buildSupportEmail(input);
  return sendEmail(
    {
      to: supportToEmail(),
      replyTo: input.email.trim(),
      subject: built.subject,
      text: built.text,
      html: built.html,
    },
    input.kind,
  );
}

export function verificationLink(token: string): string {
  const base = configuredWebOrigin().replace(/\/$/, "");
  return `${base}/verify-email?token=${encodeURIComponent(token)}`;
}

export function buildVerificationEmail(input: {
  firstName: string;
  code: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const firstName = input.firstName.trim() || "there";
  const subject = "Verify your email for Phone Silent";
  const text = [
    `Hi ${firstName},`,
    "",
    "Confirm your email before your quiet space is activated.",
    "",
    `Verification code: ${input.code}`,
    "",
    "Or open this link:",
    input.url,
    "",
    "This code expires in 24 hours.",
  ].join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.5">
<p>Hi ${escapeHtml(firstName)},</p>
<p>Confirm your email before your quiet space is activated.</p>
<p>Verification code: <strong>${escapeHtml(input.code)}</strong></p>
<p><a href="${escapeHtml(input.url)}">Verify your email</a></p>
<p>This code expires in 24 hours.</p>
</div>`;
  return { subject, text, html };
}

export function buildConfirmationEmail(input: {
  firstName: string;
  spaceName: string;
  active: boolean;
}): { subject: string; text: string; html: string } {
  const firstName = input.firstName.trim() || "there";
  const spaceName = input.spaceName.trim() || "Your quiet space";
  const subject = "Your quiet space is registered";
  const status = input.active
    ? "The space is active. You can manage its settings whenever you need to."
    : "The space stays off until you verify your email. After that, you can manage its settings.";
  const text = [
    `Hi ${firstName},`,
    "",
    `${spaceName} is registered on Phone Silent.`,
    "You are the account manager, so you control this space's settings.",
    "",
    "Plan: Free — a 125 ft quiet zone around your pin.",
    status,
  ].join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  return { subject, text, html };
}

export async function sendVerificationEmail(input: {
  to: string;
  firstName: string;
  code: string;
  url: string;
}): Promise<{ sent: boolean }> {
  const built = buildVerificationEmail(input);
  return sendEmail({ to: input.to, ...built }, "verify");
}

export async function sendRegistrationConfirmation(input: {
  to: string;
  firstName: string;
  spaceName: string;
  active: boolean;
}): Promise<{ sent: boolean }> {
  const built = buildConfirmationEmail(input);
  return sendEmail({ to: input.to, ...built }, "confirm");
}
