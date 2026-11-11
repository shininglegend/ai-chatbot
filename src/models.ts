import type { ModelInfo, ModelList } from "./shared";

// Google's rolling aliases, so these follow the newest Gemini Pro and Flash releases.
const GOOGLE_MODELS: ModelInfo[] = [
  { id: "gemini-pro-latest", provider: "google", label: "Gemini Pro" },
  { id: "gemini-flash-latest", provider: "google", label: "Gemini Flash" }
];

/** Used only when Anthropic's model list cannot be fetched. */
const FALLBACK_ANTHROPIC: ModelInfo[] = [
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5" },
  { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5" }
];

/** Model families in the order they are offered; the first one present is the default. */
const LINE_ORDER = ["sonnet", "opus", "haiku"];

type ListedModel = { id: string; display_name: string; created_at: string; line?: string; lifecycle?: string };

function isListedModel(value: unknown): value is ListedModel {
  const m = value as Partial<ListedModel> | null;
  return (
    !!m && typeof m.id === "string" && typeof m.display_name === "string" && typeof m.created_at === "string"
  );
}

/**
 * The newest active model of each family (Sonnet, Opus, Haiku, ...) from Anthropic's
 * `GET /v1/models` response, so a new release shows up without a code change.
 */
export function newestPerLine(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const newest = new Map<string, ListedModel>();
  for (const model of data.filter(isListedModel)) {
    if (model.lifecycle !== undefined && model.lifecycle !== "active") continue;
    const line = model.line ?? model.id;
    const current = newest.get(line);
    if (!current || model.created_at > current.created_at) newest.set(line, model);
  }

  const rank = (line: string) => {
    const index = LINE_ORDER.indexOf(line);
    return index === -1 ? LINE_ORDER.length : index;
  };
  return [...newest.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, model]) => ({ id: model.id, provider: "anthropic", label: model.display_name }));
}

const FRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
let cached: { list: ModelList; until: number } | null = null;

/**
 * The models on offer. Anthropic's come from its Models API, asked through AI Gateway on the
 * same binding route the chat requests use (the gateway adds the stored key), and are
 * remembered for an hour. If that fails, a fixed list is used and the lookup is retried soon.
 */
export async function listModels(env: Pick<Env, "AI" | "AI_GATEWAY_ID">): Promise<ModelList> {
  if (cached && cached.until > Date.now()) return cached.list;

  let anthropic: ModelInfo[] = [];
  try {
    // The binding's typed methods only cover POST calls; `fetch` on it is the route the Agents
    // SDK itself uses for vendor requests, and is not in the published types.
    const response = await (env.AI as unknown as Fetcher).fetch(
      `https://workers-binding.ai/ai-gateway/gateways/${encodeURIComponent(env.AI_GATEWAY_ID)}/anthropic/v1/models?limit=1000`,
      { headers: { "anthropic-version": "2023-06-01", "cf-aig-collect-log": "false", "cf-aig-skip-cache": "true" } }
    );
    if (response.ok) anthropic = newestPerLine(await response.json());
  } catch {
    // Fall through to the fixed list.
  }

  const live = anthropic.length > 0;
  const models = [...(live ? anthropic : FALLBACK_ANTHROPIC), ...GOOGLE_MODELS];
  const list = { models, defaultId: models[0].id };
  cached = { list, until: Date.now() + (live ? FRESH_MS : RETRY_MS) };
  return list;
}

/**
 * The model that writes attachment summaries: the cheapest one from the same provider as the
 * chat's model, so an attachment never goes to a provider the user did not pick.
 */
export function summaryModel(models: ModelInfo[], chatModel: ModelInfo): ModelInfo {
  const cheap = chatModel.provider === "anthropic" ? /haiku/ : /flash/;
  return models.find((m) => m.provider === chatModel.provider && cheap.test(m.id)) ?? chatModel;
}
