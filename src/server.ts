import { routeAgentRequest } from "agents";
import { authenticate, isSameOrigin } from "./auth";
import { placeFrom } from "./context";
import { listModels } from "./models";
import type { Me } from "./shared";

export { ChatAgent } from "./chat-agent";
export { UserHub } from "./user-hub";

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");

function secured(response: Response, { noStore = true } = {}): Response {
  const out = new Response(response.body, response);
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  // Vite's dev server injects inline scripts for hot reload, which the CSP would block.
  if (!import.meta.env.DEV) out.headers.set("Content-Security-Policy", CSP);
  if (noStore) out.headers.set("Cache-Control", "no-store");
  return out;
}

function deny(status: number, message: string): Response {
  return secured(new Response(message, { status }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const user = await authenticate(request, env);
    if (!user) return deny(403, "Forbidden");

    const url = new URL(request.url);
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if ((isUpgrade || request.method !== "GET") && !isSameOrigin(request)) {
      return deny(403, "Forbidden");
    }

    if (url.pathname === "/api/me") {
      return secured(Response.json({ ...user, place: placeFrom(request.cf) } satisfies Me));
    }

    if (url.pathname === "/api/models") {
      return secured(Response.json(await listModels(env)));
    }

    if (url.pathname.startsWith("/agents/")) {
      // The only door is the caller's own hub, which forwards to that user's chats.
      // ChatAgent instances are never reachable directly.
      const [, , agent, name] = url.pathname.split("/");
      if (agent !== "user-hub" || name !== user.key) return deny(403, "Forbidden");

      const response = await routeAgentRequest(request, env);
      if (!response) return deny(404, "Not found");
      // A WebSocket upgrade response must be passed through untouched.
      return response.status === 101 ? response : secured(response);
    }

    if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "Method not allowed");
    const asset = await env.ASSETS.fetch(request);
    // Hashed build assets are safe to cache; the HTML shell is not.
    return secured(asset, { noStore: !url.pathname.startsWith("/assets/") });
  }
} satisfies ExportedHandler<Env>;
