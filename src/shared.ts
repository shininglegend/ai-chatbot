// Shared by the Worker and the browser. Nothing in here is secret.

export type ModelInfo = {
  /** The vendor's own model id. */
  id: string;
  provider: "anthropic" | "google";
  label: string;
};

/** The models on offer right now (see src/models.ts) and the one a new visitor starts on. */
export type ModelList = { models: ModelInfo[]; defaultId: string };

/** Self-delete timer choices, in seconds since the last message. `null` means never. */
export const TTL_PRESETS: readonly { seconds: number | null; label: string }[] = [
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 3 * 60 * 60, label: "3 hours" },
  { seconds: 24 * 60 * 60, label: "24 hours" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days" },
  { seconds: 30 * 24 * 60 * 60, label: "30 days" },
  { seconds: null, label: "Never" }
];

export const DEFAULT_TTL_SECONDS = 3 * 60 * 60;

export function isValidTtl(ttl: unknown): ttl is number | null {
  return TTL_PRESETS.some((p) => p.seconds === ttl);
}

/** Attachments: what the browser produces and what the server accepts. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_IMAGE_EDGE_PX = 1568;
export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** PDFs go to the model as they are; any text-like file (notes, CSV, code) is sent as plain text. */
export const DOCUMENT_MEDIA_TYPES = ["application/pdf", "text/plain"];
/** Upper bound on one image's data URL (about 3 MB of image). */
export const MAX_IMAGE_DATA_URL_CHARS = 4_200_000;
/** Largest PDF or text file that can be attached. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** The same limit as a base64 data URL, with room for the prefix. */
export const MAX_DOCUMENT_DATA_URL_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 100;

export const NEW_CHAT_TITLE = "New chat";

/** How hard the model thinks before answering. More effort costs more and takes longer. */
export const EFFORTS = [
  { value: "low", label: "Low effort" },
  { value: "medium", label: "Medium effort" },
  { value: "high", label: "High effort" }
] as const;
export type Effort = (typeof EFFORTS)[number]["value"];

export function isEffort(value: unknown): value is Effort {
  return EFFORTS.some((effort) => effort.value === value);
}

/** The switches each chat carries. A new chat starts from the user's defaults. */
export type ChatOptions = {
  /** null = whichever model is first on the list right now. */
  modelId: string | null;
  /** null = the model's own default effort. */
  effort: Effort | null;
  /** Whether replies in this chat are given the user's context (about me, local time, place). */
  includeContext: boolean;
  /** Whether the model may search the web in this chat. */
  webSearch: boolean;
};

/** What a new chat starts with; set in Settings. */
export type Defaults = ChatOptions & {
  /** Seconds after the last message at which a chat deletes itself; null = never. */
  ttl: number | null;
};

export const BUILT_IN_DEFAULTS: Defaults = {
  modelId: null,
  effort: null,
  includeContext: true,
  webSearch: false,
  ttl: DEFAULT_TTL_SECONDS
};

export type ChatSummary = ChatOptions & {
  id: string;
  title: string;
  /** Seconds after the last message at which the chat deletes itself; null = never. */
  ttl: number | null;
  /** Unix ms of the last message. */
  lastActivity: number;
  /** Unix ms at which the chat will be deleted; null = never. */
  expiresAt: number | null;
};

/** Estimated model spend in one calendar month (UTC), e.g. { month: "2026-11", usd: 1.23 }. */
export type Spend = { month: string; usd: number };

/** Stored on each reply: what it used and roughly what it cost. `usd` is null for an unpriced model. */
export type ReplyCost = { modelId: string; inputTokens: number; outputTokens: number; searches: number; usd: number | null };

export type HubState = {
  chats: ChatSummary[];
  /** The user's "About me" text, given to the model in chats that include context. */
  profile: string;
  defaults: Defaults;
  /** A running total only; it holds nothing about what was said. */
  spend: Spend;
};

export const MAX_PROFILE_CHARS = 2000;

/** `place` is an approximate "City, Region, Country" inferred by Cloudflare from the caller's IP. */
export type Me = { email: string; key: string; place: string | null };

/** Sent by the browser with each message in chats that include context. */
export type SentContext = { localTime?: string; timeZone?: string; place?: string };
