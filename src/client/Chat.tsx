import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { FileUIPart, UIMessage } from "ai";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  type ChatOptions,
  type ChatSummary,
  type Coords,
  EFFORTS,
  type Effort,
  isMapsUrl,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type ModelList,
  type ReplyCost,
  type SentContext,
  TTL_PRESETS
} from "../shared";
import { formatUsd } from "./format";
import { prepareAttachment } from "./image";
import { Modal } from "./Modal";
import { timeLeft, useNow } from "./time";

/** Unsent text and attachments in a chat's message box. */
export type Draft = { text: string; files: FileUIPart[] };

/** How long before a chat deletes itself the warning appears. */
const WARN_BEFORE_MS = 10 * 60_000;
/** How long the connection may be down before saying so (a normal reconnect is quicker). */
const OFFLINE_GRACE_MS = 2_000;

function costOfMessage(message: UIMessage): ReplyCost | null {
  const cost = (message.metadata as { cost?: ReplyCost } | undefined)?.cost;
  return cost && typeof cost.inputTokens === "number" ? cost : null;
}

/** What the browser knows at the moment a message is sent. */
function contextNow(place: string | null, coords: Coords | null): SentContext {
  return {
    localTime: new Date().toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(place ? { place } : {}),
    ...(coords ? { coords } : {})
  };
}

/** Touch keyboards: Enter makes a new line, and focusing the box would pop the keyboard up. */
function isTouch(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return undefined;
}

function textOf(message: UIMessage): string {
  // A reply that searches mid-way arrives as several pieces of text; keep them as separate paragraphs.
  return message.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n\n");
}

type Props = {
  hubKey: string;
  chat: ChatSummary;
  /** Approximate "City, Region, Country", or null when unknown. */
  place: string | null;
  /** The point matching `place`, used for Google Maps lookups; null when unknown. */
  coords: Coords | null;
  modelList: ModelList;
  onSetOptions: (patch: Partial<ChatOptions>) => void;
  onOpenSidebar: () => void;
  onNew: () => void;
  onSetTtl: (ttl: number | null) => void;
  onRestartTimer: () => void;
  onDelete: () => void;
  /** What was left in the message box when this chat was last open. */
  initialDraft?: Draft;
  onDraftChange: (draft: Draft) => void;
};

export function Chat({
  hubKey,
  chat,
  place,
  coords,
  modelList,
  onSetOptions,
  onOpenSidebar,
  onNew,
  onSetTtl,
  onRestartTimer,
  onDelete,
  initialDraft,
  onDraftChange
}: Props) {
  const agent = useAgent({
    agent: "ChatAgent",
    basePath: `agents/user-hub/${hubKey}/chats/${encodeURIComponent(chat.id)}`
  });

  // The chat's own model; the default if it has none or its model is no longer offered.
  const modelId = modelList.models.find((model) => model.id === chat.modelId)?.id ?? modelList.defaultId;
  // Read at send time, so a change takes effect on the next message. The server applies the
  // same per-chat switch, so nothing here is used when context is off.
  const contextRef = useRef({ include: chat.includeContext, place, coords });
  contextRef.current = { include: chat.includeContext, place, coords };

  const { messages, sendMessage, regenerate, status, stop, error, clearError, isServerStreaming, isRecovering } =
    useAgentChat({
      agent,
      body: () =>
        contextRef.current.include ? { context: contextNow(contextRef.current.place, contextRef.current.coords) } : {}
    });
  const isGemini = modelList.models.find((model) => model.id === modelId)?.provider === "google";
  // Includes a reply still running on the server after a reload or reconnect.
  const busy = status === "submitted" || status === "streaming" || isServerStreaming || isRecovering;

  const [text, setText] = useState(initialDraft?.text ?? "");
  const [images, setImages] = useState<FileUIPart[]>(initialDraft?.files ?? []);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** The user message being edited; sending replaces it and everything after it. */
  const [editing, setEditing] = useState<UIMessage | null>(null);
  /** The draft that was in the box before editing started, put back afterwards. */
  const stashed = useRef<Draft>({ text: "", files: [] });
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const now = useNow();

  // Hand the draft up so switching chats keeps it. While editing, the real draft is the stashed one.
  const draftChange = useRef(onDraftChange);
  draftChange.current = onDraftChange;
  useEffect(() => {
    draftChange.current(editing ? stashed.current : { text, files: images });
  }, [text, images, editing]);

  const focusBox = () => {
    if (!isTouch()) textarea.current?.focus();
  };
  useEffect(focusBox, []);

  // Follow the reply as it streams in, but only while the user is at the bottom: scrolling up
  // to read stops following, and scrolling back down (or "Latest") starts it again.
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    // Catches every growth: new text, a code block highlighting, an image finishing loading.
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollTop < lastTop.current - 1) following.current = false;
    if (distance < 32) following.current = true;
    lastTop.current = el.scrollTop;
    setAwayFromBottom(distance > 200);
  };
  const jumpToLatest = () => {
    following.current = true;
    scrollToBottom(true);
  };

  // Say so when the connection is down for longer than a normal reconnect.
  const connected = agent.identified;
  const [showOffline, setShowOffline] = useState(false);
  useEffect(() => {
    if (connected) {
      setShowOffline(false);
      return;
    }
    const timer = setTimeout(() => setShowOffline(true), OFFLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  // When the current wait started, for the elapsed-time hint.
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => setBusySince(busy ? Date.now() : null), [busy]);

  const addFiles = async (files: Iterable<File>) => {
    setAttachError(null);
    const picked = Array.from(files);
    if (picked.length === 0) return;
    if (editing) {
      setAttachError("Attachments cannot be changed while editing a message.");
      return;
    }
    const room = MAX_ATTACHMENTS_PER_MESSAGE - images.length;
    if (picked.length > room) setAttachError(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
    const results = await Promise.allSettled(picked.slice(0, Math.max(0, room)).map(prepareAttachment));
    const prepared = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      const reason: unknown = failure.reason;
      setAttachError(reason instanceof Error && reason.message ? reason.message : "That file could not be read.");
    }
    setImages((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
  };

  const startEdit = (message: UIMessage) => {
    stashed.current = { text, files: images };
    setEditing(message);
    setText(textOf(message));
    setImages([]);
    setAttachError(null);
    textarea.current?.focus();
  };

  const endEdit = () => {
    setEditing(null);
    setText(stashed.current.text);
    setImages(stashed.current.files);
    stashed.current = { text: "", files: [] };
  };

  const editedFiles = editing?.parts.flatMap((part) => (part.type === "file" ? [part] : [])) ?? [];
  const canSend = !busy && (text.trim() !== "" || images.length > 0 || editedFiles.length > 0);

  const send = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    clearError();
    following.current = true;
    scrollToBottom();
    if (editing) {
      // Keeps the message's attachments; replaces it and drops the reply after it.
      void sendMessage(
        trimmed ? { text: trimmed, files: editedFiles, messageId: editing.id } : { files: editedFiles, messageId: editing.id }
      );
      endEdit();
    } else {
      void sendMessage(trimmed ? { text: trimmed, files: images } : { files: images });
      setText("");
      setImages([]);
    }
    setAttachError(null);
    focusBox();
  };

  const retry = () => {
    clearError();
    following.current = true;
    void regenerate();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && (editing || busy)) {
      event.preventDefault();
      if (editing) endEdit();
      else void stop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !isTouch() && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  // Count enter/leave pairs: dragging over child elements fires both on every boundary.
  const [dragDepth, setDragDepth] = useState(0);
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragDepth(0);
    void addFiles(event.dataTransfer.files);
  };

  const changeTtl = (value: string) => {
    const ttl = value === "never" ? null : Number(value);
    const deadline = ttl === null ? null : chat.lastActivity + ttl * 1000;
    if (deadline !== null && deadline <= Date.now()) {
      if (!confirm("That timer has already run out for this chat, so it will be deleted now. Continue?")) return;
    }
    onSetTtl(ttl);
  };

  const left = timeLeft(chat.expiresAt, now);
  const expiringSoon = chat.expiresAt !== null && chat.expiresAt - now < WARN_BEFORE_MS;
  const ttlLabel = TTL_PRESETS.find((preset) => preset.seconds === chat.ttl)?.label;
  const chatUsd = messages.reduce((sum, message) => sum + (costOfMessage(message)?.usd ?? 0), 0);
  const activity = activityOf(messages, busy, isRecovering);
  const lastUserId = lastWhere(messages, (message) => message.role === "user")?.id;
  const lastId = messages.at(-1)?.id;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => hasFiles(event) && setDragDepth((depth) => depth + 1)}
      onDragLeave={(event) => hasFiles(event) && setDragDepth((depth) => Math.max(0, depth - 1))}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-400 bg-white/85 text-sm text-neutral-600 dark:border-neutral-500 dark:bg-neutral-950/85 dark:text-neutral-300">
          {editing ? "Attachments cannot be changed while editing" : "Drop photos, PDFs or text files to attach them"}
        </div>
      )}

      <header className="flex items-center gap-2 border-b border-neutral-200 p-2 dark:border-neutral-800">
        <button
          type="button"
          className="rounded-md px-3 py-2 text-sm hover:bg-neutral-100 md:hidden dark:hover:bg-neutral-900"
          onClick={onOpenSidebar}
        >
          Chats
        </button>
        {/* On wider screens the sidebar's "New chat" button is always in view. */}
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100 md:hidden dark:text-neutral-300 dark:hover:bg-neutral-900"
          onClick={onNew}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M11 3.5H5.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9" strokeLinecap="round" />
            <path d="M15.5 2.5l2 2-7 7H8.5v-2l7-7z" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{chat.title}</h1>
        {chatUsd > 0 && (
          <span className="text-xs whitespace-nowrap text-neutral-500" title="Estimated cost of this chat so far, at list prices">
            ≈ {formatUsd(chatUsd)}
          </span>
        )}
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className={`hidden sm:inline ${expiringSoon ? "font-medium text-amber-700 dark:text-amber-400" : ""}`}>
            {left ? `Deletes in ${left}` : "Kept"}
          </span>
          <span className="sr-only">Delete this chat after</span>
          <select
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-xs text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
            value={chat.ttl === null ? "never" : String(chat.ttl)}
            onChange={(event) => changeTtl(event.target.value)}
          >
            {TTL_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.seconds === null ? "never" : String(preset.seconds)}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded-md px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          onClick={() => {
            if (confirm("Delete this chat now? This cannot be undone.")) onDelete();
          }}
        >
          Delete
        </button>
      </header>

      {(agent.connectionError || showOffline) && (
        <p role="status" className="bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {agent.connectionError ? (
            <>
              Cannot reach this chat.{" "}
              <button type="button" className="underline" onClick={() => location.reload()}>
                Reload
              </button>
            </>
          ) : (
            "Connection lost. Reconnecting…"
          )}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="h-full overflow-y-auto" onScroll={onScroll}>
          <div ref={content} className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                modelList={modelList}
                onEdit={!busy && message.id === lastUserId && !editing ? () => startEdit(message) : undefined}
                onRetry={!busy && message.id === lastId && message.role === "assistant" ? retry : undefined}
              />
            ))}
            <div role="status" aria-live="polite">
              {activity && (
                <p className="flex items-center gap-2 text-sm text-neutral-500">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-neutral-400" aria-hidden="true" />
                  {activity}
                  {busySince !== null && <Elapsed since={busySince} />}
                </p>
              )}
            </div>
            {error && !busy && (
              <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                The reply failed: {error.message || "unknown error"}{" "}
                {messages.length > 0 && (
                  <button type="button" className="font-medium underline" onClick={retry}>
                    Try again
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {awayFromBottom && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs shadow-sm hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            onClick={jumpToLatest}
          >
            ↓ Latest
          </button>
        )}
      </div>

      <div className="border-t border-neutral-200 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-neutral-800">
        <div className="mx-auto max-w-3xl">
          {expiringSoon && left && (
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <span className="flex-1">This chat deletes itself in {left}.</span>
              <button type="button" className="font-medium underline" onClick={onRestartTimer}>
                {ttlLabel ? `Keep it ${ttlLabel} more` : "Restart the timer"}
              </button>
            </div>
          )}
          {editing && (
            <div className="mb-2 flex items-center gap-3 text-xs text-neutral-500">
              <span className="flex-1">
                Editing your last message. Sending replaces it and the reply after it
                {editedFiles.length > 0 ? "; its attachments stay." : "."}
              </span>
              <button type="button" className="font-medium underline" onClick={endEdit}>
                Cancel
              </button>
            </div>
          )}
          {images.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {images.map((image, index) => (
                <li key={image.url.slice(-48)} className="relative">
                  {image.mediaType.startsWith("image/") ? (
                    <img src={image.url} alt={`Attachment ${index + 1}`} className="h-16 w-16 rounded-md object-cover" />
                  ) : (
                    <FileChip name={image.filename} mediaType={image.mediaType} />
                  )}
                  <button
                    type="button"
                    aria-label={`Remove attachment ${index + 1}`}
                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-xs text-white dark:bg-white dark:text-neutral-900"
                    onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachError && <p className="mb-2 text-xs text-red-600">{attachError}</p>}

          <div className="rounded-2xl border border-neutral-300 focus-within:border-neutral-500 dark:border-neutral-700">
            <textarea
              ref={textarea}
              className="field-sizing-content block max-h-48 min-h-[3rem] w-full resize-none bg-transparent px-3 pt-3 text-base outline-none placeholder:text-neutral-400"
              rows={2}
              placeholder={editing ? "Edit your message" : "Message"}
              aria-label="Message"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf,text/*,.md,.csv,.json,.log,.xml,.yaml,.yml"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Add photos or files"
                title="Add photos, PDFs or text files"
                className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
                disabled={images.length >= MAX_ATTACHMENTS_PER_MESSAGE || editing !== null}
                onClick={() => fileInput.current?.click()}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <rect x="2.5" y="4" width="15" height="12" rx="2" />
                  <circle cx="7" cy="8.5" r="1.5" />
                  <path d="M3 14.5l4-4 3 3 2.5-2.5 4.5 4.5" strokeLinejoin="round" />
                </svg>
              </button>
              <select
                aria-label="Model"
                className="min-w-0 rounded-md bg-transparent px-1 py-1.5 text-sm text-neutral-600 dark:text-neutral-300"
                value={modelId}
                onChange={(event) => onSetOptions({ modelId: event.target.value })}
              >
                {modelList.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Effort"
                title="How hard the model thinks before answering. More effort costs more and takes longer."
                className="min-w-0 rounded-md bg-transparent px-1 py-1.5 text-sm text-neutral-600 dark:text-neutral-300"
                value={chat.effort ?? ""}
                onChange={(event) => onSetOptions({ effort: (event.target.value || null) as Effort | null })}
              >
                <option value="">Default effort</option>
                {EFFORTS.map((effort) => (
                  <option key={effort.value} value={effort.value}>
                    {effort.label}
                  </option>
                ))}
              </select>
              <label
                className="flex items-center gap-1.5 text-sm whitespace-nowrap text-neutral-600 dark:text-neutral-300"
                title="Give the model your About me text, local time and approximate location in this chat"
              >
                <input
                  type="checkbox"
                  checked={chat.includeContext}
                  onChange={(event) => onSetOptions({ includeContext: event.target.checked })}
                />
                Context
              </label>
              <label
                className="flex items-center gap-1.5 text-sm whitespace-nowrap text-neutral-600 dark:text-neutral-300"
                title="Let the model search the web in this chat. Searches are billed by the provider."
              >
                <input
                  type="checkbox"
                  checked={chat.webSearch}
                  onChange={(event) => onSetOptions({ webSearch: event.target.checked })}
                />
                Search
              </label>
              {isGemini && (
                <label
                  className="flex items-center gap-1.5 text-sm whitespace-nowrap text-neutral-600 dark:text-neutral-300"
                  title="Let the model look up places with Google Maps in this chat. Lookups are billed by Google. With Context ticked, your approximate location is sent too."
                >
                  <input type="checkbox" checked={chat.maps} onChange={(event) => onSetOptions({ maps: event.target.checked })} />
                  <span translate="no">Maps</span>
                </label>
              )}
              <div className="flex-1" />
              {busy ? (
                <button
                  type="button"
                  title="Stop the reply (Esc)"
                  className="rounded-lg border border-neutral-300 px-4 py-1.5 text-sm font-medium dark:border-neutral-700"
                  onClick={() => void stop()}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
                  disabled={!canSend}
                  onClick={send}
                >
                  {editing ? "Save & send" : "Send"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** " · 12s" once a wait has gone on long enough to wonder about. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(1_000);
  const seconds = Math.floor((now - since) / 1000);
  if (seconds < 3) return null;
  return (
    <span className="tabular-nums text-neutral-400" aria-hidden="true">
      · {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
    </span>
  );
}

function FileChip({ name, mediaType }: { name?: string; mediaType: string }) {
  return (
    <span className="flex h-16 max-w-48 flex-col justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <span className="truncate">{name ?? "File"}</span>
      <span className="text-xs text-neutral-500">{mediaType === "application/pdf" ? "PDF" : "Text"}</span>
    </span>
  );
}

const PENDING_TOOL_STATES = new Set(["input-streaming", "input-available", "approval-requested"]);

/**
 * What to show while a reply is under way and its text is not visibly growing: before the
 * first token, while the model reasons, while a tool runs, and between steps after a tool
 * has finished. Null while text is streaming in, since that is visible on its own.
 */
function activityOf(messages: UIMessage[], busy: boolean, recovering: boolean): string | null {
  if (recovering) return "Picking the reply back up…";
  if (!busy) return null;
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "Thinking…";
  // The newest part that says something about what the model is doing.
  const part = lastWhere(
    last.parts,
    (p) =>
      p.type === "reasoning" ||
      (p.type === "text" && p.text.trim() !== "") ||
      p.type === "dynamic-tool" ||
      p.type.startsWith("tool-")
  );
  if (!part) return "Thinking…";
  if (part.type === "text") return null;
  if (part.type === "reasoning") return "Thinking…";
  const state = "state" in part ? String(part.state) : "";
  if (!PENDING_TOOL_STATES.has(state)) return "Thinking…";
  if (part.type === "tool-read_attachment") return "Reading the attachment again…";
  if (part.type === "tool-google_maps") return "Looking up places…";
  return "Searching the web…";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="rounded px-1 hover:text-neutral-700 dark:hover:text-neutral-200"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {}
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

type MessageProps = {
  message: UIMessage;
  modelList: ModelList;
  /** Set on the user's last message when it can be edited. */
  onEdit?: () => void;
  /** Set on the last reply when it can be written again. */
  onRetry?: () => void;
};

function Message({ message, modelList, onEdit, onRetry }: MessageProps) {
  const [zoomed, setZoomed] = useState<{ url: string; alt: string } | null>(null);
  const cost = costOfMessage(message);
  const isUser = message.role === "user";
  const images = message.parts.flatMap((part) => (part.type === "file" && part.mediaType.startsWith("image/") ? [part] : []));
  const documents = message.parts.flatMap((part) =>
    part.type === "file" && !part.mediaType.startsWith("image/") ? [part] : []
  );
  const text = textOf(message);
  if (!text && images.length === 0 && documents.length === 0) return null;
  // Pages the model drew on when it searched the web, without repeats.
  const sources = new Map<string, string>();
  for (const part of message.parts) {
    if (part.type === "source-url" && /^https?:/.test(part.url) && !sources.has(part.url)) {
      sources.set(part.url, part.title || hostOf(part.url));
    }
  }
  const actionClass = "rounded px-1 hover:text-neutral-700 dark:hover:text-neutral-200";

  return (
    <div className={isUser ? "flex flex-col items-end" : ""}>
      <div className={isUser ? "max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-2.5 dark:bg-neutral-800" : "min-w-0"}>
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((part, index) => {
              const alt = `Attached image ${index + 1}`;
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={`Show ${alt.toLowerCase()} full size`}
                  className="cursor-zoom-in"
                  onClick={() => setZoomed({ url: part.url, alt })}
                >
                  <img src={part.url} alt={alt} className="max-h-64 rounded-lg" />
                </button>
              );
            })}
          </div>
        )}
        {documents.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {documents.map((part, index) => (
              <FileChip key={index} name={part.filename} mediaType={part.mediaType} />
            ))}
          </div>
        )}
        {isUser ? <p className="break-words whitespace-pre-wrap">{text}</p> : <Streamdown>{text}</Streamdown>}
        {sources.size > 0 && (
          <details className="mt-2 text-sm text-neutral-500">
            <summary className="cursor-pointer">Sources ({sources.size})</summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {[...sources].map(([url, title]) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
                    {title}
                  </a>{" "}
                  {isMapsUrl(url) ? (
                    // Google requires Maps results to be credited exactly like this, untranslated.
                    <span className="whitespace-nowrap text-neutral-400" translate="no">
                      Google Maps
                    </span>
                  ) : (
                    <span className="text-neutral-400">{hostOf(url)}</span>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      {isUser
        ? onEdit && (
            <div className="mt-1 text-xs text-neutral-400">
              <button type="button" className={actionClass} onClick={onEdit}>
                Edit
              </button>
            </div>
          )
        : (text || cost) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
              {text && <CopyButton text={text} />}
              {onRetry && (
                <button type="button" className={actionClass} title="Write this reply again" onClick={onRetry}>
                  Retry
                </button>
              )}
              {cost && (
                <span className="px-1">
                  {cost.usd !== null && `≈ ${formatUsd(cost.usd)} · `}
                  {modelList.models.find((model) => model.id === cost.modelId)?.label ?? cost.modelId} ·{" "}
                  {cost.inputTokens.toLocaleString()} in, {cost.outputTokens.toLocaleString()} out
                  {cost.searches > 0 && `, ${cost.searches} ${cost.searches === 1 ? "search" : "searches"}`}
                </span>
              )}
            </div>
          )}
      {zoomed && (
        <Modal onClose={() => setZoomed(null)} closeOnBackdrop aria-label={zoomed.alt} className="rounded-lg bg-transparent p-0">
          <button type="button" className="block cursor-zoom-out" aria-label="Close" onClick={() => setZoomed(null)}>
            <img src={zoomed.url} alt={zoomed.alt} className="max-h-[calc(100dvh-2rem)] max-w-full object-contain" />
          </button>
        </Modal>
      )}
    </div>
  );
}
