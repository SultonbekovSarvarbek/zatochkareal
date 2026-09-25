# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram bot (Telegraf 4 + better-sqlite3) for a knife sharpening service ("Zatochka") in Uzbekistan. Customers place orders in a private chat in Russian or Uzbek; orders are stored in SQLite and posted to an admin group.

## Commands

```bash
npm install
npm start          # node bot.js
npm test           # node --test test/*.test.js
```

Node.js 20+ (required by better-sqlite3 12).

## Environment Variables

- `BOT_TOKEN` (required) - token from @BotFather
- `GROUP_CHAT_ID` (required) - admin group chat id
- `ADMIN_USER_IDS` (optional) - comma-separated user ids allowed to use admin commands/buttons. If empty, every member of the admin group is an admin.
- `DB_PATH` (optional, default `orders.db`)
- `DEBUG_SQL=1` (optional) - logs every SQL statement **with bound values (personal data)**; debugging only.

## Files

- `bot.js` - handlers, messages, keyboards. Exports `{ bot, db }`; launches only when run directly (`require.main === module`), so tests can require it.
- `database.js` - `BotDatabase` class, schema and all SQL.
- `validation.js` - pure input validation (phone, name, location, knives count).
- `test/` - `node:test` suites. `bot.test.js` stubs `Telegram.prototype.callApi` and drives the bot via `bot.handleUpdate`.

## Architecture

### Handler order in bot.js (matters)
1. Admin handlers (`/find`, `/orders`, `orders_page:*`, `order_ready:*`) guarded by `requireAdmin` (must be the admin group AND whitelisted user).
2. Private-chat gate: everything below only runs in private chats. Messages in the admin group or other chats are ignored.
3. Rate limit middleware (30 updates/min per user, warns once per window).
4. Message type filter, then customer handlers.

### Concurrency
Telegraf polling handles a batch of updates concurrently (`Promise.all`), and photo albums arrive as separate updates. Rules:
- Never read a session, `await`, then save that same object - concurrent handlers' changes get overwritten. Do read-modify-write synchronously (better-sqlite3 is sync) or in a `db.transaction`.
- Photos are appended with `db.addSessionPhoto` (transaction, enforces `MAX_PHOTOS_PER_ORDER = 10`). Album status replies are debounced per `media_group_id`.
- Placing an order uses `db.placeOrderFromSession` (creates the order and deletes the session in one transaction) before any `await`, so a double tap cannot create two orders.

### Database tables
- `sessions` - in-progress drafts, expire after 30 min of inactivity (cleanup every 5 min)
- `orders` - active orders
- `completed_orders` - archive of completed/cancelled orders (kept indefinitely)
- `rate_limits` - per-user counters (old rows cleaned every 5 min)
- `counters` - sequence for short order ids

### Order ids
- Full id: `${userId}_${timestamp}_${shortId}` (used in callback data; keep callback data under 64 bytes)
- Short id: sequential number zero-padded to 6 digits (`000123`), unique among active orders. `/find 123` pads the input.
- Older orders may have legacy ids `${userId}_${timestamp}` with timestamp-based short ids; both formats work.

### Flow
`lang` → `name` (2-100 chars) → `phone` (normalized to `+998XXXXXXXXX`; text or contact button) → `location` (location button only; text re-asks) → `knives` (whole number 1-50) → `photo` (1-10 photos, management UI).

### Messages and formatting
- No `parse_mode` is used anywhere, so user text is sent as-is. Do not HTML-escape it; if you ever add `parse_mode: 'HTML'`, escape at output time only.
- Customer texts live in `messages.ru` / `messages.uz`; add keys to both. Admin group texts are always Russian (`formatOrderForAdmin`).

### Notifications
- Admin group gets: photos as albums, then the order card with the "✅ Заказ готов" button; user cancellations (by button or by "restart" under the summary).
- Abandoned drafts (`/start`, `/cancel`, restart text) do not notify admins: they never saw them.
- The customer is not notified when an order is marked ready.

### Logging
Log ids only (userId, orderId, shortId). Never log names, phones or coordinates.

## Conventions
- Wrap handler bodies in try/catch; use `safeAnswerCbQuery` for callback queries.
- Use `withRetry` for messages to the admin group (handles Telegram 429 `retry_after`).
- Add a test in `test/` for any bug fix.
