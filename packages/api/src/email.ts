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

/** Sends via Resend. Missing API key or a send failure is logged and does not throw. */
export async function sendSupportEmail(
  input: SupportEmailInput,
): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = supportToEmail();
  if (!apiKey) {
    console.warn(
      JSON.stringify({
        event: "support_email_skipped",
        reason: "RESEND_API_KEY is not set",
        kind: input.kind,
        to,
      }),
    );
    return { sent: false };
  }

  const built = buildSupportEmail(input);
  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: supportFromEmail(),
        to: [to],
        reply_to: input.email.trim(),
        subject: built.subject,
        text: built.text,
        html: built.html,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        JSON.stringify({
          event: "support_email_failed",
          kind: input.kind,
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
        event: "support_email_failed",
        kind: input.kind,
        detail: err instanceof Error ? err.message : "request failed",
      }),
    );
    return { sent: false };
  }
}
