const test = require('node:test');
const assert = require('node:assert');
const BotDatabase = require('../database');

function photoSession(extra = {}) {
    return {
        step: 'photo',
        lang: 'ru',
        name: 'Ali',
        phone: '+998901234567',
        location: { latitude: 41.31, longitude: 69.28 },
        knives: 3,
        photos: [],
        ...extra
    };
}

test('addSessionPhoto keeps every photo and enforces the limit', () => {
    const db = new BotDatabase(':memory:');
    db.saveSession(1, photoSession());

    for (let i = 0; i < 12; i++) db.addSessionPhoto(1, `file${i}`, 10);

    assert.strictEqual(db.getSession(1).photos.length, 10);
    assert.strictEqual(db.addSessionPhoto(1, 'extra', 10), null);
    assert.strictEqual(db.addSessionPhoto(2, 'no-session', 10), null);
});

test('placeOrderFromSession removes the session so the order cannot be placed twice', () => {
    const db = new BotDatabase(':memory:');
    db.saveSession(1, photoSession({ photos: ['a'] }));

    const { orderId, shortId } = db.placeOrderFromSession(1, db.getSession(1));

    assert.strictEqual(db.getSession(1), null);
    assert.strictEqual(db.getActiveOrdersCount(), 1);
    assert.strictEqual(db.getOrderByShortId(shortId).orderId, orderId);
});

test('short ids are unique and sequential', () => {
    const db = new BotDatabase(':memory:');
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
        ids.add(db.createOrder(1, photoSession()).shortId);
    }
    assert.strictEqual(ids.size, 50);
    assert.ok(ids.has('000001'));
});

test('short ids skip values held by legacy active orders', () => {
    const db = new BotDatabase(':memory:');
    db.db.prepare(`
        INSERT INTO orders (order_id, user_id, short_id, name, phone, location_lat, location_lng, knives, photos, lang, created_at)
        VALUES ('legacy', 1, '000001', 'A', '+998901234567', 0, 0, 1, '[]', 'ru', 0)
    `).run();

    assert.strictEqual(db.createOrder(1, photoSession()).shortId, '000002');
});

test('completeOrder archives once and returns null afterwards', () => {
    const db = new BotDatabase(':memory:');
    const { orderId } = db.createOrder(1, photoSession());

    assert.ok(db.completeOrder(orderId));
    assert.strictEqual(db.completeOrder(orderId), null);
    assert.strictEqual(db.getActiveOrdersCount(), 0);
    assert.strictEqual(db.getStats().completedOrders, 1);
});

test('session keeps zero coordinates', () => {
    const db = new BotDatabase(':memory:');
    db.saveSession(1, photoSession({ location: { latitude: 0, longitude: 0 } }));
    assert.deepStrictEqual(db.getSession(1).location, { latitude: 0, longitude: 0 });
});

test('checkRateLimit blocks after the limit and flags only the first blocked update', () => {
    const db = new BotDatabase(':memory:');
    const results = [];
    for (let i = 0; i < 5; i++) results.push(db.checkRateLimit(1, 3, 60000));

    assert.deepStrictEqual(results.map(r => r.allowed), [true, true, true, false, false]);
    assert.deepStrictEqual(results.map(r => r.firstBlocked), [false, false, false, true, false]);
});
