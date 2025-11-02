const Database = require('better-sqlite3');
const path = require('path');

class BotDatabase {
    constructor(dbPath = 'orders.db') {
        this.db = new Database(path.resolve(dbPath), { verbose: console.log });
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
                last_photo_message_id INTEGER,
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
            location: row.location_lat && row.location_lng ? {
                latitude: row.location_lat,
                longitude: row.location_lng
            } : null,
            knives: row.knives,
            photos: row.photos ? JSON.parse(row.photos) : [],
            lastPhotoMessageId: row.last_photo_message_id,
            updatedAt: row.updated_at,
            createdAt: row.created_at
        };
    }

    saveSession(userId, session) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO sessions (
                user_id, step, lang, name, phone, location_lat, location_lng,
                knives, photos, last_photo_message_id, updated_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                step = excluded.step,
                lang = excluded.lang,
                name = excluded.name,
                phone = excluded.phone,
                location_lat = excluded.location_lat,
                location_lng = excluded.location_lng,
                knives = excluded.knives,
                photos = excluded.photos,
                last_photo_message_id = excluded.last_photo_message_id,
                updated_at = excluded.updated_at
        `);

        stmt.run(
            userId,
            session.step,
            session.lang || null,
            session.name || null,
            session.phone || null,
            session.location?.latitude || null,
            session.location?.longitude || null,
            session.knives || null,
            session.photos ? JSON.stringify(session.photos) : null,
            session.lastPhotoMessageId || null,
            now,
            session.createdAt || now
        );
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

    createOrder(userId, orderData) {
        const orderId = `${userId}_${Date.now()}`;
        const shortId = orderId.split('_')[1].slice(-6);

        const stmt = this.db.prepare(`
            INSERT INTO orders (
                order_id, user_id, short_id, name, phone,
                location_lat, location_lng, knives, photos, lang, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
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
            Date.now()
        );

        return { orderId, shortId };
    }

    getOrder(orderId) {
        const stmt = this.db.prepare('SELECT * FROM orders WHERE order_id = ?');
        const row = stmt.get(orderId);
        if (!row) return null;

        return this._orderRowToObject(row);
    }

    getOrderByShortId(shortId) {
        const stmt = this.db.prepare('SELECT * FROM orders WHERE short_id = ?');
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

    getUserActiveOrder(userId) {
        const stmt = this.db.prepare('SELECT * FROM orders WHERE user_id = ? LIMIT 1');
        const row = stmt.get(userId);
        if (!row) return null;

        return this._orderRowToObject(row);
    }

    completeOrder(orderId, status = 'completed') {
        const order = this.getOrder(orderId);
        if (!order) return false;

        // Begin transaction
        const transaction = this.db.transaction(() => {
            // Insert into completed_orders
            const insertStmt = this.db.prepare(`
                INSERT INTO completed_orders (
                    order_id, user_id, short_id, name, phone,
                    location_lat, location_lng, knives, photos, lang,
                    created_at, completed_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            insertStmt.run(
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

            // Delete from active orders
            const deleteStmt = this.db.prepare('DELETE FROM orders WHERE order_id = ?');
            deleteStmt.run(orderId);
        });

        transaction();
        return true;
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

    checkRateLimit(userId, maxMessages = 10, windowMs = 60000) {
        const now = Date.now();
        const windowStart = now - windowMs;

        // Get or create rate limit entry
        const getStmt = this.db.prepare('SELECT * FROM rate_limits WHERE user_id = ?');
        let rateLimitEntry = getStmt.get(userId);

        if (!rateLimitEntry || rateLimitEntry.window_start < windowStart) {
            // Reset window
            const upsertStmt = this.db.prepare(`
                INSERT INTO rate_limits (user_id, message_count, window_start)
                VALUES (?, 1, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    message_count = 1,
                    window_start = excluded.window_start
            `);
            upsertStmt.run(userId, now);
            return true; // Allow
        }

        if (rateLimitEntry.message_count >= maxMessages) {
            return false; // Rate limited
        }

        // Increment counter
        const updateStmt = this.db.prepare(`
            UPDATE rate_limits
            SET message_count = message_count + 1
            WHERE user_id = ?
        `);
        updateStmt.run(userId);
        return true; // Allow
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
