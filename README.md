# Private chat

A personal chat app on Cloudflare Workers. Login is Cloudflare Access, models are reached through Cloudflare AI Gateway with provider keys stored on the gateway, and every chat lives in its own Durable Object that is deleted on a per-chat timer (3 hours after the last message by default).

## How it works

- `src/server.ts` is the Worker entry. It verifies the Access token on every request (including static files and WebSocket upgrades), checks the request comes from the app's own origin, and only routes to the caller's own hub.
- `src/user-hub.ts` (`UserHub`, one per user) keeps the list of chats: title, timer and deletion time. It forwards connections to the chats and is the single place that deletes them, either when a timer fires or on request.
- `src/chat-agent.ts` (`ChatAgent`, one per chat) stores the conversation, including images, in its own SQLite storage and streams replies. Deleting a chat wipes this object's storage.
- `src/context.ts` builds the system prompt. In chats with "Context" ticked it includes the About me text from Settings (stored in the hub), the browser's local time and time zone, and an approximate city from Cloudflare's IP lookup.
- `src/models.ts` builds the model list. Anthropic's comes from its Models API through the gateway (the newest active model of each family, refreshed hourly), so new releases appear without a code change; it falls back to a fixed list if that lookup fails. Gemini uses Google's rolling `-latest` aliases.
- Web search is a per-chat switch, off by default. It uses each provider's own search tool (Anthropic web search, Google Search grounding), which runs on the provider's side and is billed by them per search.
- Attachments can be photos, PDFs (up to 10 MB) and text-like files such as notes, CSV or code. Word and Excel files are not supported.
- An attachment is sent to the model in full with the message that carries it. Alongside that reply, the provider's cheapest model (Haiku or Gemini Flash, always the same provider as the chat's model) writes a short summary, stored with the chat. Later messages send only the summary, and the model gets a `read_attachment` tool to see the file again when a question needs it. This keeps a large PDF from being paid for on every message. If a summary cannot be written, the attachment keeps being sent in full.
- Each chat has its own model, effort (how hard the model thinks: the model's default, low, medium or high), context switch, web search switch and timer. A new chat starts from the defaults in Settings ("New chats start with"); changing a default does not touch existing chats.
- `src/pricing.ts` estimates what each reply cost from the token counts the provider reports and a table of list prices. The estimate is shown under each reply, per chat in the header, and as a running total for the calendar month in the sidebar. It is an estimate: the provider's bill is the real figure. Prices are keyed by exact model id, so when a new model appears its replies show token counts without a dollar figure until its price is added to the table. Google's search grounding is counted as free (its first 5,000 requests a month are).
- `src/shared.ts` holds the timer presets, the effort levels and the attachment limits.
- `src/client/` is the React interface.

Built on the Cloudflare Agents SDK (`agents`, `@cloudflare/ai-chat`) and the Vercel AI SDK. The hub uses `RoutedAgents` from `agents/routing`, which the SDK marks experimental; check its changelog when upgrading `agents`.

## Privacy: what is and is not covered

- Chats are stored only in Durable Objects, encrypted at rest by Cloudflare. Deletion drops the object's storage; it is not a hidden flag.
- With web search on, the model writes search queries from your conversation and they go to the provider's search service.
- PDFs and text files are uploaded as they are, including any metadata inside them. Only photos are stripped.
- Photos are re-encoded in the browser before upload (JPEG, long edge at most 1568px), which removes EXIF metadata including GPS location. The original file is never uploaded.
- The browser stores nothing. Each chat's model and other switches are kept with the chat list in the hub.
- The cost total kept per month is a dollar figure only; it holds nothing about what was said and is not on any chat's timer.
- AI Gateway logging and caching are turned off per request (`collectLog: false`, `skipCache: true`) and should also be off in the gateway's settings. Worker request logs are disabled in `wrangler.jsonc`.
- Not covered: Anthropic and Google keep API requests under their own retention terms (typically around 30 days for abuse monitoring unless you have a zero-retention agreement). The self-delete timer cannot reach that. Use a paid-tier Google AI Studio key, since free-tier prompts can be used for training.
- Not covered: the About me text in Settings is kept until you clear it; it is not on any chat's timer. With "Context" ticked, that text, your local time and your approximate city go to the model provider with every message. Untick it for a chat that should carry none of that.
- Not covered: the data is not end-to-end encrypted. The Worker has to read messages to send them to the model.

## Setup

1. AI Gateway: a gateway named `ai-chatbot` (or change `AI_GATEWAY_ID` in `wrangler.jsonc`) with authentication on, logs off, caching off, and Anthropic and Google AI Studio keys added under Provider Keys.
2. Cloudflare Access: a self-hosted application for the app's hostname with a policy allowing only your email. Copy its Application Audience (AUD) tag.
3. In `wrangler.jsonc`, set `TEAM_DOMAIN` to `https://<your-team>.cloudflareaccess.com`, `POLICY_AUD` to the AUD tag, and `routes` to your hostname.
4. `npm run deploy`

The Worker denies every request while `TEAM_DOMAIN` or `POLICY_AUD` is empty.

## Development

```sh
echo 'DEV_USER_EMAIL=dev@localhost' > .dev.vars
npm run dev -- --port 5199 --strictPort
npm test
npm run typecheck
```

`DEV_USER_EMAIL` skips the Access check, and only for requests to `localhost`. It lives in `.dev.vars`, which is git-ignored and never deployed. Model calls in local dev go to the real gateway and are billed by the providers.

Anthropic models update themselves. To change which families are offered or their order, edit `LINE_ORDER` and `newestPerLine` in `src/models.ts`; to add a Gemini model, add a line to `GOOGLE_MODELS` there using Google's own model id.
