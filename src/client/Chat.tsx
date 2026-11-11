import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { FileUIPart, UIMessage } from "ai";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  type ChatOptions,
  type ChatSummary,
  EFFORTS,
  type Effort,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type ModelList,
  type ReplyCost,
  type SentContext,
  TTL_PRESETS
} from "../shared";
import { formatUsd } from "./format";
import { prepareAttachment } from "./image";
import { timeLeft, useNow } from "./time";

function costOfMessage(message: UIMessage): ReplyCost | null {
  const cost = (message.metadata as { cost?: ReplyCost } | undefined)?.cost;
  return cost && typeof cost.inputTokens === "number" ? cost : null;
}

/** What the browser knows at the moment a message is sent. */
function contextNow(place: string | null): SentContext {
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
    ...(place ? { place } : {})
  };
}

type Props = {
  hubKey: string;
  chat: ChatSummary;
  /** Approximate "City, Region, Country", or null when unknown. */
  place: string | null;
  modelList: ModelList;
  onSetOptions: (patch: Partial<ChatOptions>) => void;
  onOpenSidebar: () => void;
  onSetTtl: (ttl: number | null) => void;
  onDelete: () => void;
};

export function Chat({
  hubKey,
  chat,
  place,
  modelList,
  onSetOptions,
  onOpenSidebar,
  onSetTtl,
  onDelete
}: Props) {
  const agent = useAgent({
    agent: "ChatAgent",
    basePath: `agents/user-hub/${hubKey}/chats/${encodeURIComponent(chat.id)}`
  });

  // The chat's own model; the default if it has none or its model is no longer offered.
  const modelId = modelList.models.find((model) => model.id === chat.modelId)?.id ?? modelList.defaultId;
  // Read at send time, so a change takes effect on the next message. The server applies the
  // same per-chat switch, so nothing here is used when context is off.
  const contextRef = useRef({ include: chat.includeContext, place });
  contextRef.current = { include: chat.includeContext, place };

  const { messages, sendMessage, status, stop, error, clearError } = useAgentChat({
    agent,
    body: () => (contextRef.current.include ? { context: contextNow(contextRef.current.place) } : {})
  });
  const busy = status === "submitted" || status === "streaming";

  const [text, setText] = useState("");
  const [images, setImages] = useState<FileUIPart[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const now = useNow();

  // Keep the newest content in view while a reply streams in.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  const addFiles = async (files: Iterable<File>) => {
    setAttachError(null);
    const picked = Array.from(files);
    if (picked.length === 0) return;
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

  const send = () => {
    const trimmed = text.trim();
    if (busy || (!trimmed && images.length === 0)) return;
    clearError();
    void sendMessage(trimmed ? { text: trimmed, files: images } : { files: images });
    setText("");
    setImages([]);
    setAttachError(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // On touch keyboards Enter makes a new line; the Send button sends.
    const touch = matchMedia("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
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

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
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
  const chatUsd = messages.reduce((sum, message) => sum + (costOfMessage(message)?.usd ?? 0), 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <header className="flex items-center gap-2 border-b border-neutral-200 p-2 dark:border-neutral-800">
        <button
          type="button"
          className="rounded-md px-3 py-2 text-sm hover:bg-neutral-100 md:hidden dark:hover:bg-neutral-900"
          onClick={onOpenSidebar}
        >
          Chats
        </button>
        <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{chat.title}</h1>
        {chatUsd > 0 && (
          <span className="text-xs whitespace-nowrap text-neutral-500" title="Estimated cost of this chat so far, at list prices">
            ≈ {formatUsd(chatUsd)}
          </span>
        )}
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className="hidden sm:inline">{left ? `Deletes in ${left}` : "Kept"}</span>
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
          {messages.map((message) => (
            <Message key={message.id} message={message} modelList={modelList} />
          ))}
          {status === "submitted" && <p className="text-sm text-neutral-500">Thinking…</p>}
          {status === "streaming" && toolActivity(messages.at(-1)) && (
            <p className="text-sm text-neutral-500">{toolActivity(messages.at(-1))}</p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              The reply failed: {error.message || "unknown error"}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t border-neutral-200 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-neutral-800">
        <div className="mx-auto max-w-3xl">
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
              className="block max-h-48 min-h-[3rem] w-full resize-none bg-transparent px-3 pt-3 text-base outline-none placeholder:text-neutral-400"
              rows={2}
              placeholder="Message"
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
                disabled={images.length >= MAX_ATTACHMENTS_PER_MESSAGE}
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
              <div className="flex-1" />
              {busy ? (
                <button
                  type="button"
                  className="rounded-lg border border-neutral-300 px-4 py-1.5 text-sm font-medium dark:border-neutral-700"
                  onClick={() => void stop()}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
                  disabled={!text.trim() && images.length === 0}
                  onClick={send}
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
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

/** What to show while a reply has started a tool call but has not produced any text yet. */
function toolActivity(message: UIMessage | undefined): string | null {
  if (!message || message.role !== "assistant") return null;
  if (message.parts.some((part) => part.type === "text" && part.text.trim() !== "")) return null;
  const tools = message.parts.filter((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool");
  if (tools.length === 0) return null;
  return tools.at(-1)?.type === "tool-read_attachment" ? "Reading the attachment again…" : "Searching the web…";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Message({ message, modelList }: { message: UIMessage; modelList: ModelList }) {
  const cost = costOfMessage(message);
  const isUser = message.role === "user";
  const images = message.parts.filter((part) => part.type === "file" && part.mediaType.startsWith("image/"));
  const documents = message.parts.flatMap((part) =>
    part.type === "file" && !part.mediaType.startsWith("image/") ? [part] : []
  );
  // A reply that searches mid-way arrives as several pieces of text; keep them as separate paragraphs.
  const text = message.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n\n");
  if (!text && images.length === 0 && documents.length === 0) return null;
  // Pages the model drew on when it searched the web, without repeats.
  const sources = new Map<string, string>();
  for (const part of message.parts) {
    if (part.type === "source-url" && /^https?:/.test(part.url) && !sources.has(part.url)) {
      sources.set(part.url, part.title || hostOf(part.url));
    }
  }

  return (
    <div className={isUser ? "flex justify-end" : ""}>
      <div className={isUser ? "max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-2.5 dark:bg-neutral-800" : "min-w-0"}>
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map(
              (part, index) =>
                part.type === "file" && (
                  <img key={index} src={part.url} alt={`Attached image ${index + 1}`} className="max-h-64 rounded-lg" />
                )
            )}
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
                  <span className="text-neutral-400">{hostOf(url)}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
        {cost && (
          <p className="mt-1 text-xs text-neutral-400">
            {cost.usd !== null && `≈ ${formatUsd(cost.usd)} · `}
            {modelList.models.find((model) => model.id === cost.modelId)?.label ?? cost.modelId} ·{" "}
            {cost.inputTokens.toLocaleString()} in, {cost.outputTokens.toLocaleString()} out
            {cost.searches > 0 && `, ${cost.searches} ${cost.searches === 1 ? "search" : "searches"}`}
          </p>
        )}
      </div>
    </div>
  );
}
