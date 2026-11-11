import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Me } from "./shared";

export type Identity = Pick<Me, "email" | "key">;

type AuthEnv = {
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  DEV_USER_EMAIL?: string;
};

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

/** A stable, opaque per-user key, so the email never appears in URLs or Durable Object names. */
export async function userKey(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isLocalhost(request: Request): boolean {
  const { hostname } = new URL(request.url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Identify the caller from their Cloudflare Access token. Returns null (deny) for anything
 * that is not a valid, unexpired token for this Access application.
 */
export async function authenticate(request: Request, env: AuthEnv): Promise<Identity | null> {
  // Local development only: DEV_USER_EMAIL lives in .dev.vars and is never set on the deployed Worker.
  if (env.DEV_USER_EMAIL && isLocalhost(request)) {
    return { email: env.DEV_USER_EMAIL, key: await userKey(env.DEV_USER_EMAIL) };
  }

  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;

  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(request, "CF_Authorization");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, jwksFor(env.TEAM_DOMAIN), {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
      algorithms: ["RS256"]
    });
    const email = payload.email;
    if (typeof email !== "string" || !email) return null;
    return { email, key: await userKey(email) };
  } catch {
    return null;
  }
}

/**
 * Browsers attach the Access cookie to cross-site requests, so anything that changes state or
 * opens a WebSocket must come from this app's own origin.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}
