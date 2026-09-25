const Database = require('better-sqlite3');
const path = require('path');

const SHORT_ID_MIN_LENGTH = 6;

class BotDatabase {
    constructor(dbPath = 'orders.db') {
        const resolved = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
        // SQL tracing prints bound values (names, phones, coordinates), so it is opt-in only
        const options = process.env.DEBUG_SQL === '1' ? { verbose: console.log } : {};
        this.db = new Database(resolved, options);
        this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
        this.initSchema();
    }

    initSchema() {
        // Sessions table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                user_id INTEGER PRIMARY KEY,
                step TEXT NOT NULL,
                lang TEXT,
                name TEXT,
                phone TEXT,
                location_lat REAL,
                location_lng REAL,
                knives INTEGER,
                photos TEXT, -- JSON array of file_ids
                last_photo_message_id INTEGER, -- legacy, no longer used
                updated_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_updated
                ON sessions(updated_at);
        `);

        // Active orders table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                short_id TEXT NOT NULL,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                location_lat REAL NOT NULL,
                location_lng REAL NOT NULL,
                knives INTEGER NOT NULL,
                photos TEXT, -- JSON array of file_ids
                lang TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_orders_short_id
                ON orders(short_id);
            CREATE INDEX IF NOT EXISTS idx_orders_user_id
                ON orders(user_id);
            CREATE INDEX IF NOT EXISTS idx_orders_phone
                ON orders(phone);
        `);

        // Completed orders table (archive)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS completed_orders (
                order_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                short_id TEXT NOT NULL,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                location_lat REAL NOT NULL,
                location_lng REAL NOT NULL,
                knives INTEGER NOT NULL,
                photos TEXT, -- JSON array of file_ids
                lang TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                status TEXT DEFAULT 'completed' -- 'completed' or 'cancelled'
            );

            CREATE INDEX IF NOT EXISTS idx_completed_orders_created
                ON completed_orders(created_at);
        `);

        // Rate limiting table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS rate_limits (
                user_id INTEGER PRIMARY KEY,
                message_count INTEGER NOT NULL DEFAULT 1,
                window_start INTEGER NOT NULL
            );
        `);

        // Monotonic counters (used for short order ids)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS counters (
                name TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );
        `);
    }

    // ========== SESSION OPERATIONS ==========

    getSession(userId) {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE user_id = ?');
        const row = stmt.get(userId);
        if (!row) return null;

        return {
            step: row.step,
            lang: row.lang,
            name: row.name,
            phone: row.phone,
            location: row.location_lat != null && row.location_lng != null ? {
                latitude: row.location_lat,
                longitude: row.location_lng
            } : null,
            knives: row.knives,
            photos: row.photos ? JSON.parse(row.photos) : [],
            updatedAt: row.updated_at,
            createdAt: row.created_at
        };
    }

    saveSession(userId, session) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO sessions (
                user_id, step, lang, name, phone, location_lat, location_lng,
                knives, photos, updated_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                step = excluded.step,
                lang = excluded.lang,
                name = excluded.name,
                phone = excluded.phone,
                location_lat = excluded.location_lat,
                location_lng = excluded.location_lng,
                knives = excluded.knives,
                photos = excluded.photos,
                updated_at = excluded.updated_at
        `);

        stmt.run(
            userId,
            session.step,
            session.lang ?? null,
            session.name ?? null,
            session.phone ?? null,
            session.location?.latitude ?? null,
            session.location?.longitude ?? null,
            session.knives ?? null,
            session.photos ? JSON.stringify(session.photos) : null,
            now,
            session.createdAt ?? now
        );
    }

    /**
     * Atomically appends a photo to the session's photo list.
     * Returns the new photo count, or null if the photo was rejected
     * (no session, wrong step, or limit reached).
     */
    addSessionPhoto(userId, fileId, maxPhotos) {
        const tx = this.db.transaction(() => {
            const session = this.getSession(userId);
            if (!session || session.step !== 'photo') return null;
            if (session.photos.length >= maxPhotos) return null;
            session.photos.push(fileId);
            this.saveSession(userId, session);
            return session.photos.length;
        });
        return tx();
    }

    deleteSession(userId) {
        const stmt = this.db.prepare('DELETE FROM sessions WHERE user_id = ?');
        stmt.run(userId);
    }

    cleanExpiredSessions(timeoutMs = 30 * 60 * 1000) {
        const cutoffTime = Date.now() - timeoutMs;
        const stmt = this.db.prepare('DELETE FROM sessions WHERE updated_at < ?');
        const result = stmt.run(cutoffTime);
        return result.changes;
    }

    // ========== ORDER OPERATIONS ==========

    _nextShortId() {
        const bump = this.db.prepare(`
            INSERT INTO counters (name, value) VALUES ('order_short_id', 1)
            ON CONFLICT(name) DO UPDATE SET value = value + 1
            RETURNING value
        `);
        const exists = this.db.prepare('SELECT 1 FROM orders WHERE short_id = ?');

        // Skip ids still held by active orders (e.g. legacy timestamp-based ids)
        for (;;) {
            const shortId = String(bump.get().value).padStart(SHORT_ID_MIN_LENGTH, '0');
            if (!exists.get(shortId)) return shortId;
        }
    }

    createOrder(userId, orderData) {
        const tx = this.db.transaction(() => {
            const createdAt = Date.now();
            const shortId = this._nextShortId();
            const orderId = `${userId}_${createdAt}_${shortId}`;

            this.db.prepare(`
                INSERT INTO orders (
                    order_id, user_id, short_id, name, phone,
                    location_lat, location_lng, knives, photos, lang, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                orderId,
                userId,
                shortId,
                orderData.name,
                orderData.phone,
                orderData.location.latitude,
                orderData.location.longitude,
                orderData.knives,
                JSON.stringify(orderData.photos || []),
                orderData.lang,
                createdAt
            );

            return { orderId, shortId, createdAt };
        });
        return tx();
    }

    /**
     * Creates an order from the session and deletes the session in one transaction,
     * so a repeated "submit" cannot produce a second order.
     */
    placeOrderFromSession(userId, session) {
        const tx = this.db.transaction(() => {
            const result = this.createOrder(userId, session);
            this.deleteSession(userId);
            return result;
        });
        return tx();
    }

    getOrder(orderId) {
        const stmt = this.db.prepare('SELECT * FROM orders WHERE order_id = ?');
        const row = stmt.get(orderId);
        if (!row) return null;

        return this._orderRowToObject(row);
    }

    getOrderByShortId(shortId) {
        const stmt = this.db.prepare('SELECT * FROM orders WHERE short_id = ? ORDER BY created_at DESC LIMIT 1');
        const row = stmt.get(shortId);
        if (!row) return null;

        return this._orderRowToObject(row);
    }

    getActiveOrders(limit = 100, offset = 0) {
        const stmt = this.db.prepare(`
            SELECT * FROM orders
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `);
        const rows = stmt.all(limit, offset);
        return rows.map(row => this._orderRowToObject(row));
    }

    getActiveOrdersCount() {
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM orders');
        return stmt.get().count;
    }

    getUserActiveOrders(userId) {
        const stmt = this.db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at');
        return stmt.all(userId).map(row => this._orderRowToObject(row));
    }

    /**
     * Moves an active order to the archive. Returns the archived order,
     * or null if it was not active (already completed/cancelled).
     */
    completeOrder(orderId, status = 'completed') {
        const tx = this.db.transaction(() => {
            const order = this.getOrder(orderId);
            if (!order) return null;

            this.db.prepare(`
                INSERT INTO completed_orders (
                    order_id, user_id, short_id, name, phone,
                    location_lat, location_lng, knives, photos, lang,
                    created_at, completed_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                order.orderId,
                order.creatorId,
                order.shortId,
                order.name,
                order.phone,
                order.location.latitude,
                order.location.longitude,
                order.knives,
                JSON.stringify(order.photos || []),
                order.lang,
                order.createdAt || Date.now(),
                Date.now(),
                status
            );

            this.db.prepare('DELETE FROM orders WHERE order_id = ?').run(orderId);
            return order;
        });
        return tx();
    }

    cancelOrder(orderId) {
        return this.completeOrder(orderId, 'cancelled');
    }

    _orderRowToObject(row) {
        return {
            orderId: row.order_id,
            creatorId: row.user_id,
            shortId: row.short_id,
            name: row.name,
            phone: row.phone,
            location: {
                latitude: row.location_lat,
                longitude: row.location_lng
            },
            knives: row.knives,
            photos: row.photos ? JSON.parse(row.photos) : [],
            lang: row.lang,
            createdAt: row.created_at
        };
    }

    // ========== RATE LIMITING ==========

    /**
     * Counts one update for the user in a fixed window.
     * `allowed` is false once the limit is exceeded; `firstBlocked` is true only for
     * the first rejected update in the window, so the bot warns the user once.
     */
    checkRateLimit(userId, maxMessages = 30, windowMs = 60000) {
        const tx = this.db.transaction(() => {
            const now = Date.now();
            const entry = this.db.prepare('SELECT * FROM rate_limits WHERE user_id = ?').get(userId);

            if (!entry || entry.window_start <= now - windowMs) {
                this.db.prepare(`
                    INSERT INTO rate_limits (user_id, message_count, window_start)
                    VALUES (?, 1, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        message_count = 1,
                        window_start = excluded.window_start
                `).run(userId, now);
                return { allowed: true, firstBlocked: false };
            }

            const count = entry.message_count + 1;
            this.db.prepare('UPDATE rate_limits SET message_count = ? WHERE user_id = ?').run(count, userId);
            return { allowed: count <= maxMessages, firstBlocked: count === maxMessages + 1 };
        });
        return tx();
    }

    cleanOldRateLimits(olderThanMs = 3600000) {
        const cutoffTime = Date.now() - olderThanMs;
        const stmt = this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?');
        return stmt.run(cutoffTime).changes;
    }

    // ========== UTILITY ==========

    close() {
        this.db.close();
    }

    // Get database stats
    getStats() {
        const stats = {
            activeSessions: this.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
            activeOrders: this.db.prepare('SELECT COUNT(*) as count FROM orders').get().count,
            completedOrders: this.db.prepare('SELECT COUNT(*) as count FROM completed_orders').get().count,
        };
        return stats;
    }
}

module.exports = BotDatabase;
