import { MAX_PROFILE_CHARS } from "./shared";

/** One line of plain text from an untrusted value, or "" if it is not usable. */
function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** "City, Region, Country" from Cloudflare's IP-based lookup; null when it has nothing. */
export function placeFrom(cf: unknown): string | null {
  const { city, region, country } = (cf ?? {}) as Record<string, unknown>;
  const parts = [city, region, country].map((part) => line(part, 60)).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Explains the note that chat-agent.ts adds to earlier replies that used web search. */
const SEARCH_NOTE_HINT =
  "A bracketed note at the end of an earlier reply is an automatic record that the reply was based on a web search, with the pages it used. The search results themselves are not shown again. Never write such a note yourself.";

/** Explains the note that chat-agent.ts puts in place of an attachment from an earlier message. */
const ATTACHMENT_NOTE_HINT =
  "A bracketed attachment note in an earlier message stands for a file or image the user attached then. You saw it in full at the time; now only a short automatic summary is shown. When a question depends on what the attachment actually says or shows, call read_attachment to see it again instead of answering from the summary. Never write such a note yourself.";

/**
 * The system prompt for one reply. `sent` is what the browser attached to the message
 * (local time, time zone, place) and is only used when the chat includes user context.
 */
export function systemPrompt(
  context: { includeContext: boolean; profile: string; webSearch?: boolean; hiddenAttachments?: boolean },
  sent: unknown,
  now = new Date()
): string {
  const lines = ["You are a helpful assistant."];
  const fields = (context.includeContext && sent && typeof sent === "object" ? sent : {}) as Record<string, unknown>;
  const localTime = line(fields.localTime, 80);
  const timeZone = line(fields.timeZone, 60);
  const place = line(fields.place, 200);

  if (localTime) {
    lines.push(`The user's local time is ${localTime}${timeZone ? ` (time zone ${timeZone})` : ""}.`);
  } else {
    lines.push(`Today's date is ${now.toISOString().slice(0, 10)} (UTC).`);
  }
  if (place) {
    lines.push(`The user is probably in or near ${place} (estimated from their network, so it can be off).`);
  }
  const profile = context.includeContext ? context.profile.trim().slice(0, MAX_PROFILE_CHARS) : "";
  if (profile) {
    lines.push(`Use this background only where it is relevant. About the user, in their own words:\n${profile}`);
  }
  lines.push(SEARCH_NOTE_HINT);
  if (context.hiddenAttachments) lines.push(ATTACHMENT_NOTE_HINT);
  if (context.webSearch) {
    lines.push(
      "You can search the web. Search when the answer depends on current, local or specific facts you cannot be sure of; answer directly when it does not. Each search costs the user money: use as few as the question needs, and search again only when the results so far leave a real gap."
    );
  }
  return lines.join("\n");
}
