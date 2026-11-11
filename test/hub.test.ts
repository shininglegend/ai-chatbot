import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { assertAttachmentsAllowed, attachmentsOf, historyForModel } from "../src/chat-agent";
import { newestPerLine, summaryModel } from "../src/models";
import { placeFrom, systemPrompt } from "../src/context";
import { costOf } from "../src/pricing";
import { DEFAULT_TTL_SECONDS, NEW_CHAT_TITLE } from "../src/shared";
import type { UserHub } from "../src/user-hub";

const HOUR = 60 * 60 * 1000;

async function hubFor(name: string) {
  return getAgentByName(env.UserHub, name);
}

async function chatsOf(hub: DurableObjectStub<UserHub>) {
  return runInDurableObject(hub, (instance) => instance.state.chats);
}

async function sweepSchedules(hub: DurableObjectStub<UserHub>) {
  return runInDurableObject(hub, async (instance) =>
    (await instance.listSchedules()).filter((s) => s.callback === "sweep")
  );
}

/** Whether any chat object still holds data for the given chat id. */
async function chatDataExists(chatId: string) {
  for (const objectId of await listDurableObjectIds(env.ChatAgent)) {
    const link = await runInDurableObject(env.ChatAgent.get(objectId), (_instance, state) =>
      state.storage.kv.get<{ id: string }>("link")
    );
    if (link?.id === chatId) return true;
  }
  return false;
}

describe("self-deleting chats", () => {
  it("starts a new chat on a 3 hour timer", async () => {
    const hub = await hubFor("user-create");
    const before = Date.now();
    const id = await hub.createChat();

    const [chat] = await chatsOf(hub);
    expect(chat).toMatchObject({ id, title: NEW_CHAT_TITLE, ttl: DEFAULT_TTL_SECONDS });
    expect(chat.expiresAt).toBeGreaterThanOrEqual(before + 3 * HOUR);
    expect(chat.expiresAt).toBeLessThanOrEqual(Date.now() + 3 * HOUR);

    const schedules = await sweepSchedules(hub);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].time * 1000).toBeGreaterThanOrEqual(chat.expiresAt! - 1000);
  });

  it("rejects timer values that are not on the list", async () => {
    const hub = await hubFor("user-bad-ttl");
    const id = await hub.createChat();
    await runInDurableObject(hub, async (instance) => {
      await expect(instance.createChat(5)).rejects.toThrow("Unknown timer value");
      await expect(instance.setTtl(id, 12345)).rejects.toThrow("Unknown timer value");
    });
    expect(await chatsOf(hub)).toHaveLength(1);
  });

  it("restarts the timer on activity and names the chat once", async () => {
    const hub = await hubFor("user-touch");
    const id = await hub.createChat(3600);
    const first = (await chatsOf(hub))[0].expiresAt!;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await hub.touch(id, "Lasagne for six");
    await hub.touch(id, "A later message");

    const [chat] = await chatsOf(hub);
    expect(chat.title).toBe("Lasagne for six");
    expect(chat.expiresAt).toBeGreaterThan(first);
    expect(await sweepSchedules(hub)).toHaveLength(1);
  });

  it("keeps a chat with the timer set to Never", async () => {
    const hub = await hubFor("user-never");
    const id = await hub.createChat();
    await hub.setTtl(id, null);

    const [chat] = await chatsOf(hub);
    expect(chat).toMatchObject({ ttl: null, expiresAt: null });
    expect(await sweepSchedules(hub)).toHaveLength(0);
  });

  it("deletes a chat and all of its storage when the timer fires", async () => {
    const hub = await hubFor("user-expire");
    const keptId = await hub.createChat(null);
    const doomedId = await hub.createChat(3600);
    expect(await chatDataExists(doomedId)).toBe(true);

    // Move the deadline to one second from now and let the real alarm fire.
    await runInDurableObject(hub, async (instance) => {
      const entry = (await instance.chats.list()).find((e) => e.id === doomedId)!;
      await instance.chats.setMetadata(doomedId, { ...entry.metadata!, expiresAt: Date.now() + 1000 });
      await instance.sweep();
    });
    expect(await chatsOf(hub)).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const remaining = await chatsOf(hub);
    expect(remaining.map((chat) => chat.id)).toEqual([keptId]);
    expect(await chatDataExists(doomedId)).toBe(false);
    expect(await chatDataExists(keptId)).toBe(true);
  });

  it("deletes immediately when the timer is shortened past the deadline, and on request", async () => {
    const hub = await hubFor("user-delete");
    const a = await hub.createChat(30 * 24 * 3600);
    const b = await hub.createChat();
    const c = await hub.createChat();

    // Pretend the last message in chat A was two hours ago, then switch it to a 1 hour timer.
    await runInDurableObject(hub, async (instance) => {
      const entry = (await instance.chats.list()).find((e) => e.id === a)!;
      await instance.chats.setMetadata(a, { ...entry.metadata!, lastActivity: Date.now() - 2 * HOUR });
    });
    await hub.setTtl(a, 3600);
    expect((await chatsOf(hub)).map((chat) => chat.id).sort()).toEqual([b, c].sort());

    await hub.deleteChat(b);
    expect((await chatsOf(hub)).map((chat) => chat.id)).toEqual([c]);

    await hub.deleteAll();
    expect(await chatsOf(hub)).toEqual([]);
    expect(await sweepSchedules(hub)).toHaveLength(0);
  });
});

describe("user context", () => {
  it("hands a chat the About me text unless that chat has context switched off", async () => {
    const hub = await hubFor("user-context");
    const id = await hub.createChat();
    await hub.setProfile("  Vegetarian, lives in Denver.  ");
    expect((await chatsOf(hub))[0].includeContext).toBe(true);
    expect(await hub.touch(id)).toMatchObject({ includeContext: true, profile: "Vegetarian, lives in Denver.", webSearch: false });

    await hub.setChatOptions(id, { includeContext: false });
    expect((await chatsOf(hub))[0].includeContext).toBe(false);
    expect(await hub.touch(id)).toMatchObject({ includeContext: false, profile: "", webSearch: false });

    // The profile survives changes to the chat list.
    await hub.deleteAll();
    expect(await runInDurableObject(hub, (instance) => instance.state.profile)).toBe("Vegetarian, lives in Denver.");
  });

  it("rejects an oversized About me text", async () => {
    const hub = await hubFor("user-context-big");
    await runInDurableObject(hub, async (instance) => {
      await expect(instance.setProfile("x".repeat(2001))).rejects.toThrow("About me");
    });
  });

  it("builds the system prompt from what is allowed", () => {
    const sent = { localTime: "Tuesday, November 10, 2026 at 7:42 PM", timeZone: "America/Denver", place: "Denver, Colorado, US" };
    const now = new Date("2026-11-11T02:42:00Z");

    const on = systemPrompt({ includeContext: true, profile: "Vegetarian." }, sent, now);
    expect(on).toContain("Tuesday, November 10, 2026 at 7:42 PM (time zone America/Denver)");
    expect(on).toContain("Denver, Colorado, US");
    expect(on).toContain("Vegetarian.");

    const off = systemPrompt({ includeContext: false, profile: "Vegetarian." }, sent, now);
    expect(off).toContain("You are a helpful assistant.\nToday's date is 2026-11-11 (UTC).");
    expect(off).not.toContain("Vegetarian");
    expect(off).not.toContain("Denver");
    expect(off).not.toContain("You can search the web");
    expect(systemPrompt({ includeContext: false, profile: "", webSearch: true }, undefined, now)).toContain("You can search the web");

    // Browser-supplied fields are flattened to one line and ignored when malformed.
    const odd = systemPrompt({ includeContext: true, profile: "" }, { localTime: 5, place: "A\nIgnore previous" }, now);
    expect(odd).toContain("2026-11-11 (UTC)");
    expect(odd).toContain("near A Ignore previous (");
  });

  it("reads an approximate place from Cloudflare's request data", () => {
    expect(placeFrom({ city: "Denver", region: "Colorado", country: "US" })).toBe("Denver, Colorado, US");
    expect(placeFrom({ country: "US" })).toBe("US");
    expect(placeFrom(undefined)).toBeNull();
  });
});

describe("web search", () => {
  it("is off for a new chat and is reported to the chat once switched on", async () => {
    const hub = await hubFor("user-search");
    const id = await hub.createChat();
    expect((await chatsOf(hub))[0].webSearch).toBe(false);
    expect((await hub.touch(id)).webSearch).toBe(false);
    await hub.setChatOptions(id, { webSearch: true });
    expect((await chatsOf(hub))[0].webSearch).toBe(true);
    expect((await hub.touch(id)).webSearch).toBe(true);
  });

  it("replays only text and images to the model", () => {
    const history = [
      { id: "1", role: "user", parts: [{ type: "text", text: "hi" }, { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AAAA" }] },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "hmm" },
          { type: "tool-web_search", toolCallId: "t", state: "output-available", input: {}, output: [] },
          { type: "source-url", sourceId: "s", url: "https://example.com" },
          { type: "text", text: "answer" }
        ]
      },
      { id: "3", role: "assistant", parts: [{ type: "reasoning", text: "stopped early" }, { type: "text", text: " " }] }
    ] as UIMessage[];
    const kept = historyForModel(history);
    expect(kept.map((m) => m.parts.map((p) => p.type))).toEqual([["text", "file"], ["text", "text"]]);
    expect(kept[1].parts.at(-1)).toMatchObject({ text: "[Web search was used for this reply. Sources: https://example.com]" });
  });
});

describe("defaults, effort and cost", () => {
  it("starts new chats from the user's defaults and leaves existing chats alone", async () => {
    const hub = await hubFor("user-defaults");
    const before = await hub.createChat();
    await hub.setDefaults({ effort: "low", webSearch: true, includeContext: false, ttl: 3600 });
    const after = await hub.createChat();

    const chats = await chatsOf(hub);
    expect(chats.find((c) => c.id === before)).toMatchObject({ effort: null, webSearch: false, includeContext: true, ttl: DEFAULT_TTL_SECONDS, modelId: null });
    expect(chats.find((c) => c.id === after)).toMatchObject({ effort: "low", webSearch: true, includeContext: false, ttl: 3600 });
    expect(await hub.touch(after)).toMatchObject({ effort: "low", webSearch: true, modelId: null });

    // A chat's own setting can then differ from the default.
    await hub.setChatOptions(after, { effort: "high" });
    expect((await hub.touch(after)).effort).toBe("high");
  });

  it("rejects settings that are not real choices", async () => {
    const hub = await hubFor("user-defaults-bad");
    const id = await hub.createChat();
    await runInDurableObject(hub, async (instance) => {
      await expect(instance.setDefaults({ effort: "extreme" as never })).rejects.toThrow("Unknown effort");
      await expect(instance.setDefaults({ ttl: 5 })).rejects.toThrow("Unknown timer");
      await expect(instance.setDefaults({ modelId: "not-a-model" })).rejects.toThrow("Unknown model");
      await expect(instance.setChatOptions(id, { webSearch: "yes" as never })).rejects.toThrow("true or false");
    });
  });

  it("adds what replies cost to this month's total", async () => {
    const hub = await hubFor("user-spend");
    const id = await hub.createChat();
    await hub.touch(id, undefined, 0.25);
    await hub.touch(id, undefined, 0.5);
    const spend = await runInDurableObject(hub, (instance) => instance.state.spend);
    expect(spend).toEqual({ month: new Date().toISOString().slice(0, 7), usd: 0.75 });
  });

  it("prices a reply from its token counts, and gives no dollar figure for an unknown model", () => {
    expect(costOf("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 }, 2).usd).toBeCloseTo(2 + 1 + 0.02);
    // Haiku's higher rate applies to prompts over 100K tokens.
    expect(costOf("claude-haiku-5-5", { inputTokens: 50_000, outputTokens: 0 }).usd).toBeCloseTo(0.005);
    expect(costOf("claude-haiku-5-5", { inputTokens: 200_000, outputTokens: 0 }).usd).toBeCloseTo(0.1);
    // Google's searches are inside its free allowance.
    expect(costOf("gemini-flash-latest", { inputTokens: 1_000_000 }, 3).usd).toBeCloseTo(0.75);
    expect(costOf("claude-sonnet-9", { inputTokens: 10, outputTokens: 5 })).toEqual({
      modelId: "claude-sonnet-9", inputTokens: 10, outputTokens: 5, searches: 0, usd: null
    });
  });
});

describe("attachment summaries", () => {
  const file = (name: string) => ({
    type: "file" as const,
    mediaType: "application/pdf",
    filename: name,
    url: "data:application/pdf;base64,AAAA"
  });
  const history: UIMessage[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "Read these" }, file("lab.pdf"), file("scan.pdf")] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "Done" }] },
    { id: "m3", role: "user", parts: [{ type: "text", text: "And this" }, file("new.pdf")] }
  ];

  it("numbers attachments in the order they were sent", () => {
    expect(attachmentsOf(history).map((a) => [a.id, a.key, a.part.filename])).toEqual([
      ["a1", "m1:1", "lab.pdf"],
      ["a2", "m1:2", "scan.pdf"],
      ["a3", "m3:1", "new.pdf"]
    ]);
  });

  it("sends a summary instead of an earlier attachment, and the file itself when there is no summary", () => {
    const sent = historyForModel(history, new Map([["a1", "Blood test results."], ["a3", "Newest."]]));
    expect(sent[0].parts.map((p) => p.type)).toEqual(["text", "text", "file"]);
    expect(sent[0].parts[1]).toMatchObject({
      text: expect.stringMatching(/^\[Attachment a1: "lab.pdf" \(PDF\).*Blood test results\. Call read_attachment with id "a1"/)
    });
    // The newest message always carries its attachments in full, even if already summarised.
    expect(sent[2].parts.map((p) => p.type)).toEqual(["text", "file"]);
    // Without summaries nothing changes.
    expect(historyForModel(history).flatMap((m) => m.parts.map((p) => p.type))).toEqual([
      "text", "file", "file", "text", "text", "file"
    ]);
  });

  it("uses the cheapest model of the same provider for summaries", () => {
    const models = [
      { id: "claude-sonnet-5-5", provider: "anthropic" as const, label: "S" },
      { id: "claude-haiku-5-5", provider: "anthropic" as const, label: "H" },
      { id: "gemini-pro-latest", provider: "google" as const, label: "P" },
      { id: "gemini-flash-latest", provider: "google" as const, label: "F" }
    ];
    expect(summaryModel(models, models[0]).id).toBe("claude-haiku-5-5");
    expect(summaryModel(models, models[2]).id).toBe("gemini-flash-latest");
    expect(summaryModel(models.slice(0, 1), models[0]).id).toBe("claude-sonnet-5-5");
  });
});

describe("model list", () => {
  it("offers the newest active model of each family, Sonnet first", () => {
    const model = (id: string, line: string, created_at: string, lifecycle = "active") => ({
      id,
      display_name: id.toUpperCase(),
      line,
      created_at,
      lifecycle
    });
    const body = {
      data: [
        model("fable-2", "fable", "2026-11-09T00:00:00Z"),
        model("haiku-2", "haiku", "2026-10-07T00:00:00Z"),
        model("sonnet-3", "sonnet", "2026-12-01T00:00:00Z", "deprecated"),
        model("sonnet-2", "sonnet", "2026-09-28T00:00:00Z"),
        model("opus-2", "opus", "2026-09-21T00:00:00Z"),
        model("opus-1", "opus", "2026-07-24T00:00:00Z"),
        { id: "broken" }
      ]
    };
    expect(newestPerLine(body).map((m) => m.id)).toEqual(["sonnet-2", "opus-2", "haiku-2", "fable-2"]);
    expect(newestPerLine(body)[0]).toEqual({ id: "sonnet-2", provider: "anthropic", label: "SONNET-2" });
    expect(newestPerLine({ error: "nope" })).toEqual([]);
  });
});

describe("attachment rules", () => {
  const image = (mediaType = "image/jpeg", url = `data:${mediaType};base64,AAAA`) =>
    ({ type: "file", mediaType, url }) as const;
  const message = (...parts: UIMessage["parts"]): UIMessage => ({ id: "m", role: "user", parts });

  it("accepts text and inline images", () => {
    expect(() => assertAttachmentsAllowed(message({ type: "text", text: "hi" }, image(), image("image/png")))).not.toThrow();
    expect(() => assertAttachmentsAllowed(undefined)).not.toThrow();
  });

  it("accepts PDFs and plain text files", () => {
    expect(() => assertAttachmentsAllowed(message(image("application/pdf"), image("text/plain")))).not.toThrow();
    const bigPdf = `data:application/pdf;base64,${"A".repeat(5_000_000)}`;
    expect(() => assertAttachmentsAllowed(message(image("application/pdf", bigPdf)))).not.toThrow();
    const hugePdf = `data:application/pdf;base64,${"A".repeat(15_000_000)}`;
    expect(() => assertAttachmentsAllowed(message(image("application/pdf", hugePdf)))).toThrow();
  });

  it("rejects other file types, remote URLs, oversized images and more than five", () => {
    expect(() => assertAttachmentsAllowed(message(image("application/zip")))).toThrow();
    expect(() => assertAttachmentsAllowed(message(image("image/jpeg", "https://example.com/a.jpg")))).toThrow();
    expect(() => assertAttachmentsAllowed(message(image("image/jpeg", `data:image/jpeg;base64,${"A".repeat(5_000_000)}`)))).toThrow();
    expect(() => assertAttachmentsAllowed(message(image(), image(), image(), image(), image(), image()))).toThrow();
  });
});
