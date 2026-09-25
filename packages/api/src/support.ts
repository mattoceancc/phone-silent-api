import { db, id, nowIso } from "./db";

export const SUPPORT_TOPICS = [
  "General",
  "Venue / Register a quiet space",
  "App problem",
] as const;

export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export function saveSupportMessage(input: {
  name: string;
  email: string;
  topic: SupportTopic;
  message: string;
}): { id: string } {
  const messageId = id("support");
  const now = nowIso();
  db.prepare(
    `INSERT INTO support_messages (id, name, email, topic, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    input.name.trim(),
    input.email.trim().toLowerCase(),
    input.topic,
    input.message.trim(),
    now,
  );
  return { id: messageId };
}
