import type { Me } from "../shared";

/**
 * Cloudflare Access sits in front of the app. When its session for this app runs out, requests
 * stop reaching the Worker: Access answers with a redirect to its login page instead. A full
 * page load follows that redirect, and while the overall Access login is still valid it comes
 * straight back signed in, without showing anything.
 */
export type SessionCheck = { status: "ok"; me: Me } | { status: "expired" } | { status: "unreachable" };

export async function checkSession(): Promise<SessionCheck> {
  try {
    // "manual" turns Access's cross-site redirect into a readable answer instead of a CORS error.
    const res = await fetch("/api/me", { redirect: "manual" });
    if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) return { status: "expired" };
    if (!res.ok) return { status: "unreachable" };
    return { status: "ok", me: (await res.json()) as Me };
  } catch {
    return { status: "unreachable" };
  }
}

const RELOAD_KEY = "session-reload-at";
const MIN_RELOAD_GAP_MS = 60_000;

/**
 * Reload the page to renew the Access session, at most once a minute so a sign-in that keeps
 * failing cannot loop. Only the time of the last reload is kept, for this tab only.
 */
export function reloadToRenewSession(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (last && Date.now() - last < MIN_RELOAD_GAP_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked: reload anyway. A failed sign-in stops on Access's login page, where this
    // code does not run, so it cannot loop.
  }
  location.reload();
}
