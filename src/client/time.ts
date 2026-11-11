import { useEffect, useState } from "react";

/** Re-render on an interval so countdowns stay current. */
export function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** "2h 41m", "12m", "3d 4h"; null when there is no deadline. */
export function timeLeft(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null;
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60_000));
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
