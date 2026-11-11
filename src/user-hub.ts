import { Agent, callable } from "agents";
import { RoutedAgents } from "agents/routing";
import type { ChatAgent } from "./chat-agent";
import { listModels } from "./models";
import {
  BUILT_IN_DEFAULTS,
  type ChatOptions,
  type Defaults,
  type HubState,
  isEffort,
  isValidTtl,
  MAX_PROFILE_CHARS,
  NEW_CHAT_TITLE,
  type Spend
} from "./shared";

type ChatMeta = {
  title: string;
  ttl: number | null;
  lastActivity: number;
  expiresAt: number | null;
  // Absent on chats created before these settings existed; see optionsOf.
  includeContext?: boolean;
  webSearch?: boolean;
  modelId?: string | null;
  effort?: ChatOptions["effort"];
};

/** What a chat needs from the hub to answer a message. */
export type ChatContext = ChatOptions & { profile: string };

function optionsOf(meta: ChatMeta): ChatOptions {
  return {
    modelId: meta.modelId ?? null,
    effort: meta.effort ?? null,
    includeContext: meta.includeContext ?? true,
    webSearch: meta.webSearch ?? false
  };
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function expiryFor(lastActivity: number, ttl: number | null): number | null {
  return ttl === null ? null : lastActivity + ttl * 1000;
}

/**
 * One per user. Holds the catalog of that user's chats (title and deletion time only; the
 * conversation itself lives in each chat's own Durable Object), routes connections to them,
 * and is the single authority that deletes a chat when its timer runs out.
 */
export class UserHub extends Agent<Env, HubState> {
  initialState: HubState = {
    chats: [],
    profile: "",
    defaults: BUILT_IN_DEFAULTS,
    spend: { month: monthOf(new Date()), usd: 0 }
  };

  /** State saved by an earlier version can lack the newer fields. */
  private get defaults(): Defaults {
    return { ...BUILT_IN_DEFAULTS, ...this.state.defaults };
  }

  private get spend(): Spend {
    const month = monthOf(new Date());
    return this.state.spend?.month === month ? this.state.spend : { month, usd: 0 };
  }

  /** Checks the given option values; throws on anything that is not a known choice. */
  private async validated<T extends Partial<Defaults>>(patch: T): Promise<Partial<Defaults>> {
    if (!patch || typeof patch !== "object") throw new Error("Expected settings to change");
    const clean: Partial<Defaults> = {};
    if ("modelId" in patch) {
      const { models } = await listModels(this.env);
      if (patch.modelId !== null && !models.some((m) => m.id === patch.modelId)) throw new Error("Unknown model");
      clean.modelId = patch.modelId;
    }
    if ("effort" in patch) {
      if (patch.effort !== null && !isEffort(patch.effort)) throw new Error("Unknown effort level");
      clean.effort = patch.effort;
    }
    for (const key of ["includeContext", "webSearch"] as const) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== "boolean") throw new Error("Expected true or false");
      clean[key] = patch[key];
    }
    if ("ttl" in patch) {
      if (!isValidTtl(patch.ttl)) throw new Error("Unknown timer value");
      clean.ttl = patch.ttl;
    }
    return clean;
  }

  readonly chats = new RoutedAgents<ChatAgent, ChatMeta>({
    namespace: this.env.ChatAgent,
    route: "chats"
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.chats);
  }

  async onStart() {
    await this.sweep();
  }

  @callable()
  async createChat(ttl?: number | null): Promise<string> {
    const { ttl: defaultTtl, ...options } = this.defaults;
    if (ttl === undefined) ttl = defaultTtl;
    if (!isValidTtl(ttl)) throw new Error("Unknown timer value");
    const now = Date.now();
    const entry = await this.chats.create({
      metadata: { title: NEW_CHAT_TITLE, ttl, lastActivity: now, expiresAt: expiryFor(now, ttl), ...options }
    });
    const chat = await this.chats.get(entry.id);
    if (!chat) throw new Error("Chat could not be created");
    await chat.link(this.name, entry.id);
    await this.sweep();
    return entry.id;
  }

  @callable()
  async setTtl(id: string, ttl: number | null): Promise<void> {
    if (!isValidTtl(ttl)) throw new Error("Unknown timer value");
    const meta = await this.meta(id);
    if (!meta) return;
    await this.chats.setMetadata(id, { ...meta, ttl, expiresAt: expiryFor(meta.lastActivity, ttl) });
    // If the new deadline is already in the past, this deletes the chat right away.
    await this.sweep();
  }

  /** Change one chat's model, effort, context or web search switch. */
  @callable()
  async setChatOptions(id: string, patch: Partial<ChatOptions>): Promise<void> {
    const { ttl: _notHere, ...options } = await this.validated(patch);
    const meta = await this.meta(id);
    if (!meta) return;
    await this.chats.setMetadata(id, { ...meta, ...options });
    await this.sync();
  }

  /** Change what new chats start with. Existing chats keep their own settings. */
  @callable()
  async setDefaults(patch: Partial<Defaults>): Promise<void> {
    const clean = await this.validated(patch);
    this.setState({ ...this.state, defaults: { ...this.defaults, ...clean } });
  }

  /** The "About me" text. Kept until changed or cleared; it is not on any chat's timer. */
  @callable()
  async setProfile(profile: string): Promise<void> {
    if (typeof profile !== "string" || profile.length > MAX_PROFILE_CHARS) {
      throw new Error(`About me must be text of at most ${MAX_PROFILE_CHARS} characters`);
    }
    this.setState({ ...this.state, profile: profile.trim() });
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    await this.chats.delete(id);
    await this.sync();
  }

  @callable()
  async deleteAll(): Promise<void> {
    for (const entry of await this.chats.list()) await this.chats.delete(entry.id);
    await this.sweep();
  }

  /**
   * Called by a chat (Durable Object RPC, not reachable from the browser) when a message is
   * sent or a reply finishes: restarts that chat's timer, sets its title once, and adds what
   * the reply cost to this month's total. Returns the chat's settings and the user context
   * it may use.
   */
  async touch(id: string, title?: string, usd = 0): Promise<ChatContext> {
    if (usd > 0) {
      const spend = this.spend;
      this.setState({ ...this.state, spend: { month: spend.month, usd: spend.usd + usd } });
    }
    const meta = await this.meta(id);
    if (!meta) return { ...BUILT_IN_DEFAULTS, includeContext: false, profile: "" };
    const now = Date.now();
    await this.chats.setMetadata(id, {
      ...meta,
      title: meta.title === NEW_CHAT_TITLE && title ? title : meta.title,
      lastActivity: now,
      expiresAt: expiryFor(now, meta.ttl)
    });
    await this.sweep();
    const options = optionsOf(meta);
    return { ...options, profile: options.includeContext ? (this.state.profile ?? "") : "" };
  }

  /** Delete every chat whose time is up, then arrange to wake at the next deadline. */
  async sweep(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    let failed = false;

    for (const entry of await this.chats.list()) {
      const expiresAt = entry.metadata?.expiresAt ?? null;
      if (expiresAt === null) continue;
      if (expiresAt <= now) {
        try {
          await this.chats.delete(entry.id);
        } catch {
          failed = true;
        }
      } else if (next === null || expiresAt < next) {
        next = expiresAt;
      }
    }

    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "sweep") await this.cancelSchedule(schedule.id);
    }
    // A failed delete is hidden from the list already; retry it in a minute until it is gone.
    const wakeAt = failed ? Math.min(next ?? Infinity, now + 60_000) : next;
    if (wakeAt !== null) await this.schedule(new Date(wakeAt), "sweep");

    await this.sync();
  }

  private async meta(id: string): Promise<ChatMeta | null> {
    const entry = (await this.chats.list()).find((e) => e.id === id);
    return entry?.metadata ?? null;
  }

  private async sync(): Promise<void> {
    const chats = (await this.chats.list()).flatMap((entry) =>
      entry.metadata ? [{ id: entry.id, ...entry.metadata, ...optionsOf(entry.metadata) }] : []
    );
    this.setState({ profile: this.state.profile ?? "", defaults: this.defaults, spend: this.spend, chats });
  }
}
