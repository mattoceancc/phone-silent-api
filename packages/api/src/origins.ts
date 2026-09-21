const PRODUCTION_WEB = [
  "https://phonesilent.com",
  "https://www.phonesilent.com",
  "https://phonesilent.app",
  "https://www.phonesilent.app",
  "https://phone-silent.vercel.app",
];

const LOCAL_WEB = ["http://127.0.0.1:43123", "http://localhost:43123"];

export function configuredWebOrigin(): string {
  return process.env.WEB_ORIGIN?.trim() || LOCAL_WEB[0];
}

/** Browser origins allowed to call the API with credentials. Mobile clients send no Origin. */
export function allowedWebOrigins(): string[] {
  const extra = (process.env.WEB_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([configuredWebOrigin(), ...PRODUCTION_WEB, ...LOCAL_WEB, ...extra])];
}

export function corsOrigin(requestOrigin: string | undefined): string | undefined {
  if (!requestOrigin) return configuredWebOrigin();
  return allowedWebOrigins().includes(requestOrigin) ? requestOrigin : undefined;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
