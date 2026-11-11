import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { AIChatAgent, type ChatResponseResult, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { createAI } from "agents/models/ai-sdk";
import { systemPrompt } from "./context";
import { listModels, summaryModel } from "./models";
import { costOf } from "./pricing";
import type { ChatContext } from "./user-hub";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FileUIPart,
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk
} from "ai";
import {
  DOCUMENT_MEDIA_TYPES,
  IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_DOCUMENT_DATA_URL_CHARS,
  MAX_IMAGE_DATA_URL_CHARS,
  type ModelInfo,
  type ReplyCost
} from "./shared";

type Link = { owner: string; id: string };

// The gateway holds the real provider keys and swaps them in; these placeholders never leave Cloudflare.
const anthropic = createAnthropic({ apiKey: "held-by-ai-gateway" });
const google = createGoogleGenerativeAI({ apiKey: "held-by-ai-gateway" });

function vendorModel(model: ModelInfo) {
  return model.provider === "anthropic" ? anthropic(model.id) : google(model.id);
}

function searchTools(model: ModelInfo): ToolSet {
  return model.provider === "anthropic"
    ? { web_search: anthropic.tools.webSearch_20260209({ maxUses: 5 }) }
    : { google_search: google.tools.googleSearch({}) };
}

/** A reply that shows the user an error instead of an answer; nothing is added to the chat. */
function errorResponse(error: unknown): Response {
  const errorText = error instanceof Error ? error.message : "Something went wrong";
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => writer.write({ type: "error", errorText })
    })
  });
}

/** Throws unless every attachment on the message is a reasonably sized inline image, PDF or text file. */
export function assertAttachmentsAllowed(message: UIMessage | undefined): void {
  if (!message) return;
  const files = message.parts.filter((part) => part.type === "file");
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  }
  for (const file of files) {
    const isImage = IMAGE_MEDIA_TYPES.includes(file.mediaType);
    const okType = isImage || DOCUMENT_MEDIA_TYPES.includes(file.mediaType);
    const okUrl = file.url.startsWith(`data:${file.mediaType};base64,`);
    if (!okType || !okUrl) throw new Error("Only images, PDFs and text files can be attached");
    const limit = isImage ? MAX_IMAGE_DATA_URL_CHARS : MAX_DOCUMENT_DATA_URL_CHARS;
    if (file.url.length > limit) throw new Error("Attachment is too large");
  }
}

/** An attachment in the conversation, with the short id the model uses to ask for it again. */
export type Attachment = { id: string; key: string; messageId: string; part: FileUIPart };

/** Every attachment in the conversation, numbered a1, a2, ... in the order they were sent. */
export function attachmentsOf(messages: UIMessage[]): Attachment[] {
  const found: Attachment[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) => {
      if (part.type !== "file") return;
      found.push({ id: `a${found.length + 1}`, key: `${message.id}:${index}`, messageId: message.id, part });
    });
  }
  return found;
}

function kindOf(part: FileUIPart): string {
  if (part.mediaType.startsWith("image/")) return "image";
  return part.mediaType === "application/pdf" ? "PDF" : "text file";
}

function nameOf(part: FileUIPart): string {
  return (part.filename ?? "").replace(/["\s]+/g, " ").trim().slice(0, 80) || "untitled";
}

/** What stands in for an attachment once it has a summary (see ATTACHMENT_NOTE_HINT in context.ts). */
function attachmentNote(attachment: Attachment, summary: string): string {
  const { id, part } = attachment;
  return `[Attachment ${id}: "${nameOf(part)}" (${kindOf(part)}), not shown again. Summary: ${summary} Call read_attachment with id "${id}" if you need its actual contents.]`;
}

/**
 * The conversation as any model can read it: what was said and the attachments. A reply's
 * private reasoning and tool records are in a format only the provider that wrote them
 * accepts, so they are left out; the reply text that came from them stays, followed by a
 * note of the pages a search drew on (see SEARCH_NOTE_HINT in context.ts).
 *
 * An attachment is sent in full with the message that carries it. On later turns, once it
 * has a summary (`summaries`, by attachment id), only the summary is sent, so a large file
 * is not paid for again on every message; the model can call read_attachment to see it again.
 */
export function historyForModel(messages: UIMessage[], summaries: ReadonlyMap<string, string> = new Map()): UIMessage[] {
  const attachments = new Map(attachmentsOf(messages).map((attachment) => [attachment.key, attachment]));
  const newest = messages.at(-1);
  return messages
    .map((message) => {
      const parts: UIMessage["parts"] = message.parts.flatMap((part, index): UIMessage["parts"] => {
        if (part.type === "text") return part.text.trim() !== "" ? [part] : [];
        if (part.type !== "file") return [];
        const attachment = attachments.get(`${message.id}:${index}`);
        const summary = attachment && summaries.get(attachment.id);
        if (!attachment || !summary || message === newest) return [part];
        return [{ type: "text", text: attachmentNote(attachment, summary) }];
      });
      const urls = [...new Set(message.parts.flatMap((part) => (part.type === "source-url" ? [part.url] : [])))];
      if (parts.length > 0 && urls.length > 0) {
        parts.push({ type: "text", text: `[Web search was used for this reply. Sources: ${urls.slice(0, 10).join(" ")}]` });
      }
      return { ...message, parts };
    })
    .filter((message) => message.parts.length > 0);
}

const SUMMARY_REQUEST =
  "Describe this attachment in at most 60 words: what it is and what information it contains, so that a reader can later decide whether it is relevant to a question. Plain text, no preamble.";

/** Lets the model look again at attachments that are only summarised in the history. */
function readAttachmentTool(hidden: Attachment[]): ToolSet {
  const byId = new Map(hidden.map((attachment) => [attachment.id, attachment]));
  return {
    read_attachment: tool({
      description:
        "Show an earlier attachment again in full. Use it when answering needs the attachment's actual contents rather than its summary.",
      inputSchema: jsonSchema<{ id: string }>({
        type: "object",
        properties: { id: { type: "string", description: 'The attachment id from its note, for example "a1".' } },
        required: ["id"],
        additionalProperties: false
      }),
      // Only the id is recorded in the chat; the file itself is attached when the result goes to the model.
      execute: async ({ id }) => ({ id, found: byId.has(id) }),
      toModelOutput: ({ output }) => {
        const attachment = byId.get(output.id);
        if (!attachment) return { type: "error-text", value: `There is no attachment with id "${output.id}".` };
        const { part } = attachment;
        const data = part.url.slice(part.url.indexOf(",") + 1);
        const label = `Attachment ${attachment.id}, "${nameOf(part)}":`;
        if (part.mediaType === "text/plain") {
          const text = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
          return { type: "content", value: [{ type: "text", text: `${label}\n${text}` }] };
        }
        return {
          type: "content",
          value: [
            { type: "text", text: label },
            { type: "file-data", data, mediaType: part.mediaType, filename: part.filename }
          ]
        };
      }
    })
  };
}

function titleFrom(message: UIMessage | undefined): string | undefined {
  if (!message) return undefined;
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    const file = message.parts.find((part) => part.type === "file");
    if (!file) return undefined;
    return file.mediaType.startsWith("image/") ? "Image" : (file.filename ?? "Attachment").slice(0, 40);
  }
  return text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
}

/**
 * One per chat. Stores the conversation (text and images) in its own SQLite storage, so
 * deleting the chat is deleting this object. Only reachable through its owner's UserHub.
 */
export class ChatAgent extends AIChatAgent<Env> {
  // The instance name is an opaque random id and only its owner can connect, so sharing it is harmless.
  static options = { sendIdentityOnConnect: true };

  /** Called once by the hub right after creation, so the chat can report activity back. */
  link(owner: string, id: string): void {
    this.ctx.storage.kv.put<Link>("link", { owner, id });
  }

  /** Summaries being written during the current reply (resolves to what they cost); awaited before the turn is closed. */
  private pendingSummaries: Promise<number> | undefined;
  /** Estimated cost of the reply in progress, reported to the hub when it finishes. */
  private replyUsd = 0;

  private summaries(attachments: Attachment[]): Map<string, string> {
    const found = new Map<string, string>();
    for (const attachment of attachments) {
      const summary = this.ctx.storage.kv.get<string>(`summary:${attachment.key}`);
      if (summary) found.set(attachment.id, summary);
    }
    return found;
  }

  /**
   * Ask the provider's cheapest model for a short description of each attachment and keep it
   * with the chat (so it is deleted with the chat). A failure only means the attachment keeps
   * being sent in full; it is tried again on the next message.
   */
  private async summarise(ai: ReturnType<typeof createAI>, model: ModelInfo, attachments: Attachment[]): Promise<number> {
    let usd = 0;
    await Promise.all(
      attachments.map(async ({ key, part }) => {
        try {
          const { text, usage } = await generateText({
            model: ai(vendorModel(model)),
            messages: await convertToModelMessages([
              { role: "user", parts: [part, { type: "text", text: SUMMARY_REQUEST }] }
            ]),
            maxOutputTokens: 400
          });
          usd += costOf(model.id, usage).usd ?? 0;
          const summary = text.replace(/[\s\[\]]+/g, " ").trim().slice(0, 600);
          if (summary) this.ctx.storage.kv.put(`summary:${key}`, summary);
        } catch {
          // Keep sending the attachment in full.
        }
      })
    );
    return usd;
  }

  private async touchHub(title?: string, usd?: number): Promise<ChatContext> {
    const link = this.ctx.storage.kv.get<Link>("link");
    if (!link) throw new Error("This chat no longer exists");
    const hub = await getAgentByName(this.env.UserHub, link.owner);
    return hub.touch(link.id, title, usd);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const { models, defaultId } = await listModels(this.env);
    const userMessages = this.messages.filter((m) => m.role === "user");
    let context: ChatContext;
    try {
      // Check every message, not just the newest: the whole history is sent to the model.
      for (const message of this.messages) assertAttachmentsAllowed(message);
      // Restart the self-delete timer; the first message also names the chat.
      context = await this.touchHub(titleFrom(userMessages[0]));
    } catch (error) {
      return errorResponse(error);
    }
    // The chat's own model; the default if it has none or its model is no longer offered.
    const model =
      models.find((m) => m.id === context.modelId) ?? models.find((m) => m.id === defaultId) ?? models[0];

    const ai = createAI({
      binding: this.env.AI,
      id: this.env.AI_GATEWAY_ID,
      // Nothing about the conversation is kept by the gateway.
      collectLog: false,
      skipCache: true
    });

    const attachments = attachmentsOf(this.messages);
    const summaries = this.summaries(attachments);
    const history = historyForModel(this.messages, summaries);
    // Attachments the model now only sees a summary of, which it may ask to read again.
    const newestId = this.messages.at(-1)?.id;
    const hidden = attachments.filter((a) => summaries.has(a.id) && a.messageId !== newestId);
    const tools: ToolSet = {
      // Search runs on the provider's side; the app only switches it on for chats that ask for it.
      ...(context.webSearch ? searchTools(model) : {}),
      ...(hidden.length > 0 ? readAttachmentTool(hidden) : {})
    };

    // Alongside the reply, summarise attachments that have no summary yet.
    this.pendingSummaries = this.summarise(
      ai,
      summaryModel(models, model),
      attachments.filter((a) => !summaries.has(a.id))
    );

    const result = streamText({
      model: ai(vendorModel(model)),
      system: systemPrompt({ ...context, hiddenAttachments: hidden.length > 0 }, options?.body?.context),
      messages: await convertToModelMessages(history),
      tools,
      reasoning: context.effort ?? "provider-default",
      // Room for the model to read an attachment again and then answer.
      stopWhen: stepCountIs(4),
      abortSignal: options?.abortSignal
    });

    // Pass the provider's own message through (for example "model not found") rather than a generic one.
    let searches = 0;
    this.replyUsd = 0;
    let cost: ReplyCost | undefined;
    const stream = result.toUIMessageStream({
      sendSources: true,
      // Sees every part of the reply as it is produced; used here only to count searches and tokens.
      messageMetadata: ({ part }) => {
        if (part.type === "tool-call" && part.toolName === "web_search") searches++;
        if (part.type === "finish") {
          cost = costOf(model.id, part.totalUsage, searches);
          this.replyUsd = cost.usd ?? 0;
        }
        return undefined;
      },
      onError: (error) => (error instanceof Error ? error.message : "The model request failed")
    });

    // Record on the reply what it used and roughly what it cost. This goes out as its own
    // event just before the end, because the chat library replaces the metadata on the final
    // "finish" event with its own before it reaches the browser.
    const withCost = stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === "finish" && cost) controller.enqueue({ type: "message-metadata", messageMetadata: { cost } });
          controller.enqueue(chunk);
        }
      })
    );
    return createUIMessageStreamResponse({ stream: withCost });
  }

  protected async onChatResponse(_result: ChatResponseResult): Promise<void> {
    const usd = this.replyUsd + ((await this.pendingSummaries) ?? 0);
    this.replyUsd = 0;
    this.pendingSummaries = undefined;
    // The timer counts from the last message in either direction.
    await this.touchHub(undefined, usd);
  }
}
