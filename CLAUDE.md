# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a production-ready Telegram bot for a knife sharpening service ("Zatochka") in Uzbekistan. The bot handles customer order intake with bilingual support (Russian and Uzbekik), photo management, location tracking, and admin order management. The bot uses SQLite for data persistence and includes comprehensive error handling, rate limiting, and security features.

## Running the Bot

```bash
# Install dependencies
npm install

# Start the bot
node bot.js
```

## Environment Variables

Required in `.env`:
- `BOT_TOKEN` - Telegram bot token from @BotFather
- `GROUP_CHAT_ID` - Telegram group chat ID where admin notifications are sent
- `ADMIN_USER_IDS` (Optional) - Comma-separated list of Telegram user IDs who can use admin commands. If not specified, all group members can use admin commands.

See `.env.example` for a template.

## Architecture

### Database (SQLite)
The bot uses SQLite via `better-sqlite3` for persistent storage. The database is managed through the `BotDatabase` class in `database.js`:

**Tables:**
- `sessions` - Active user sessions with auto-expiration (30 minutes)
- `orders` - Active orders awaiting completion
- `completed_orders` - Archive of completed and cancelled orders (90-day history)
- `rate_limits` - Rate limiting counters per user

**Key Features:**
- WAL mode for better concurrency
- Indexed searches for performance (O(1) lookups by shortId)
- Transaction support for data integrity
- Automatic cleanup of expired sessions (every 5 minutes)

### Session Management
Sessions are stored in the SQLite database and automatically expire after 30 minutes of inactivity. Each session tracks:
- `step` - Current step in the order flow (lang, name, phone, location, knives, photo)
- `lang` - User's selected language (ru/uz)
- `name`, `phone`, `location`, `knives` - Order details
- `photos` - Array of Telegram file_ids for uploaded photos (stored as JSON)
- `lastPhotoMessageId` - Message ID for updating photo management UI

### Order Management
Orders are persisted in SQLite with both full and short IDs:
- Full ID: `${userId}_${timestamp}` for internal use
- Short ID: Last 6 digits of timestamp for admin convenience

Orders are **archived** (not deleted) when completed or cancelled, providing an audit trail.

### Security Features
1. **Environment Validation** - Bot validates all required environment variables on startup and exits with clear error messages if missing
2. **Rate Limiting** - 10 messages per minute per user to prevent DoS attacks
3. **Admin Authorization** - Optional whitelist of admin user IDs for sensitive commands
4. **Input Sanitization** - All user inputs are sanitized to prevent injection attacks
5. **Graceful Shutdown** - Proper cleanup on SIGINT/SIGTERM signals

### Multi-step Flow
1. Language selection (ru/uz)
2. Name input (validated: min 2 chars, max 100 chars)
3. Phone number (validated: +998XXXXXXXXX format, text or contact button)
4. Location (validated: proper coordinates, location button)
5. Number of knives (validated: 1-50)
6. Photo upload with management UI

### Photo Handling
Photos are saved immediately to the database to prevent race conditions. Users can:
- Add multiple photos
- View all uploaded photos (sent as media groups up to 10 at a time)
- Delete individual photos
- Delete all photos
- Submit order when ready

The bot sends all photos to the admin group with captions containing order details and a short 6-digit ID for easy reference.

### Admin Features
Available only in the GROUP_CHAT_ID group chat, with optional user ID whitelist:
- `/find [6-digit-id]` - Search for an active order by its short ID (O(1) database lookup)
- `/orders` - List all active orders with pagination (10 orders per page)
- "Заказ готов" button - Mark an order as complete and archive it

### Callbacks and Actions
The bot uses Telegraf callback actions for interactive buttons:
- `photos_*` - Photo management actions (done, add, delete, view, delete_all)
- `delete_photo:[index]` - Delete specific photo by index
- `cancel_order:[orderId]` - User cancels their own order (archived as cancelled)
- `order_ready:[orderId]` - Admin marks order as complete (archived as completed)
- `orders_page:[pageNum]` - Pagination for orders list
- `restart` - User starts a new order (cancels active order if exists)

### Notifications
- Users receive order confirmations with summary and action buttons
- Admins receive orders in the group chat with photos and order details
- Cancellations notify the admin group
- All Telegram API errors are logged with context

## Key Implementation Details

### Constants
All magic numbers are extracted to constants at the top of bot.js:
- `MAX_KNIVES = 50`
- `MIN_KNIVES = 1`
- `SESSION_TIMEOUT_MS = 30 * 60 * 1000` (30 minutes)
- `CLEANUP_INTERVAL_MS = 5 * 60 * 1000` (5 minutes)
- `RATE_LIMIT_MAX_MESSAGES = 10`
- `RATE_LIMIT_WINDOW_MS = 60 * 1000` (1 minute)
- `MEDIA_GROUP_MAX_SIZE = 10`

### Validation Helpers
Dedicated validation functions ensure data integrity:
- `isValidUzbekPhone(phone)` - Validates +998XXXXXXXXX format
- `normalizeUzbekPhone(phone)` - Normalizes phone to +998XXXXXXXXX
- `isValidName(name)` - Validates name (2-100 chars)
- `isValidLocation(location)` - Validates GPS coordinates
- `isValidKnivesCount(count)` - Validates knives count (1-50)

### Sanitization
All user inputs are sanitized to prevent injection attacks:
- `sanitizeText(text)` - Escapes HTML special characters
- `sanitizeLocation(location)` - Validates and clamps GPS coordinates

### Order IDs
- Full ID: `${userId}_${timestamp}` (stored internally)
- Short ID: Last 6 digits of timestamp (shown to admins for easy reference)

### Timestamps
Uses 'Asia/Tashkent' timezone for all date/time displays

### Logging
Structured logging with log levels (INFO, WARN, ERROR) and timestamps:
- All errors include stack traces and context
- All admin actions are logged for audit
- Rate limit violations are logged

## Common Development Patterns

When adding new features:
1. Update the `messages` object for both `ru` and `uz` languages
2. Add validation helpers for new inputs
3. Add database schema changes if storing new data
4. Use callback actions for interactive buttons with the pattern `action_name:data`
5. Always check session validity in callbacks before proceeding
6. Wrap all ctx.reply/ctx.telegram calls in try-catch
7. Use `ctx.answerCbQuery()` to acknowledge callback queries
8. Log important actions with appropriate log level
9. Test with both languages

When modifying order flow:
1. Consider the session step progression
2. Update both text handlers and callback handlers as needed
3. Update database.js if changing data structure
4. Test notification messages to both user and admin group
5. Ensure order archival properly preserves data

When modifying database:
1. Update the schema in database.js `initSchema()`
2. Add appropriate indexes for performance
3. Update conversion methods (_orderRowToObject, etc.)
4. Test migration from old data if applicable

## Bot Commands

User commands:
- `/start` - Start new order (cancels previous session if exists)
- `/cancel` - Cancel current order

Admin commands (GROUP_CHAT_ID only, with optional ADMIN_USER_IDS whitelist):
- `/find [6-digit-id]` - Search for active order
- `/orders` - List all active orders with pagination

## Database File

The SQLite database is stored in `orders.db` in the project root. This file contains all active orders, sessions, and historical data. To backup data, simply copy this file. To reset the database, delete this file (bot will recreate schema on next start).

## Error Handling

All errors are caught and logged with context. The bot will:
- Never crash on user input errors
- Log all Telegram API errors
- Handle database errors gracefully
- Show friendly error messages to users
- Exit cleanly on SIGINT/SIGTERM
