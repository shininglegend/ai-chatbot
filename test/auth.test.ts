import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { userKey } from "../src/auth";
import worker from "../src/server";

const ORIGIN = "https://ai.example.com";
const EMAIL = "me@example.com";

let sign: (claims?: { aud?: string; iss?: string; exp?: string; email?: string | null }) => Promise<string>;
let forged: string;

beforeAll(async () => {
  const real = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(real.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  // Serve the Access signing keys locally instead of calling Cloudflare.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return new Response("unexpected fetch", { status: 500 });
  });

  const make = (key: CryptoKey, claims: Parameters<typeof sign>[0] = {}) => {
    const body = claims.email === null ? {} : { email: claims.email ?? EMAIL };
    return new SignJWT(body)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(claims.iss ?? env.TEAM_DOMAIN)
      .setAudience(claims.aud ?? env.POLICY_AUD)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(key);
  };
  sign = (claims) => make(real.privateKey, claims);
  forged = await make(other.privateKey);
});

/** The environment as deployed: .dev.vars (loaded in tests) is never present in production. */
function deployedEnv(): Env {
  const { DEV_USER_EMAIL: _devOnly, ...deployed } = env;
  return deployed as Env;
}

function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers }), deployedEnv());
}

describe("Access token check", () => {
  it("rejects a request with no token", async () => {
    expect((await get("/")).status).toBe(403);
    expect((await get("/api/me")).status).toBe(403);
  });

  it("rejects malformed, forged, expired, wrong-audience and wrong-issuer tokens", async () => {
    const bad = [
      "not-a-jwt",
      forged,
      await sign({ exp: "-1m" }),
      await sign({ aud: "another-app" }),
      await sign({ iss: "https://evil.cloudflareaccess.com" }),
      await sign({ email: null })
    ];
    for (const token of bad) {
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": token })).status).toBe(403);
    }
  });

  it("accepts a valid token from the header or the Access cookie", async () => {
    const token = await sign();
    const viaHeader = await get("/api/me", { "Cf-Access-Jwt-Assertion": token });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.json()).toEqual({ email: EMAIL, key: await userKey(EMAIL), place: null });
    expect(viaHeader.headers.get("Cache-Control")).toBe("no-store");

    const viaCookie = await get("/api/me", { Cookie: `other=1; CF_Authorization=${token}` });
    expect(viaCookie.status).toBe(200);
  });

  it("only honours the local-dev bypass on localhost with DEV_USER_EMAIL set", async () => {
    const me = (url: string, devEmail?: string) =>
      worker.fetch(new Request(url), { ...env, DEV_USER_EMAIL: devEmail } as Env);
    expect((await me("http://localhost/api/me", undefined)).status).toBe(403);
    expect((await me("http://localhost/api/me", "dev@localhost")).status).toBe(200);
    expect((await me(`${ORIGIN}/api/me`, "dev@localhost")).status).toBe(403);
  });
});

describe("Agent routing", () => {
  it("only lets a user reach their own hub", async () => {
    const auth = { "Cf-Access-Jwt-Assertion": await sign() };
    const otherKey = await userKey("someone-else@example.com");
    expect((await get(`/agents/user-hub/${otherKey}`, auth)).status).toBe(403);
    expect((await get(`/agents/user-hub/${otherKey}/chats/abc/get-messages`, auth)).status).toBe(403);
  });

  it("never exposes chat objects directly", async () => {
    const auth = { "Cf-Access-Jwt-Assertion": await sign() };
    expect((await get("/agents/chat-agent/anything", auth)).status).toBe(403);
    expect((await get("/agents/chat-agent/anything/get-messages", auth)).status).toBe(403);
  });

  it("refuses WebSockets and writes from another origin", async () => {
    const auth = { "Cf-Access-Jwt-Assertion": await sign() };
    const own = `/agents/user-hub/${await userKey(EMAIL)}`;
    const upgrade = { ...auth, Upgrade: "websocket" };
    expect((await get(own, { ...upgrade, Origin: "https://evil.example" })).status).toBe(403);
    expect((await get(own, upgrade)).status).toBe(403);
    expect((await get(own, { ...auth, Origin: "https://evil.example" }, "POST")).status).toBe(403);
  });
});
