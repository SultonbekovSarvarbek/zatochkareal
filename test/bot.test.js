const test = require('node:test');
const assert = require('node:assert');

process.env.BOT_TOKEN = '123:test';
process.env.GROUP_CHAT_ID = '-100500';
process.env.ADMIN_USER_IDS = '777';
process.env.DB_PATH = ':memory:';

const { Telegram } = require('telegraf');
const { bot, db } = require('../bot');

// ---- Telegram API stub ----
let calls = [];
let nextMessageId = 1;
bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
Telegram.prototype.callApi = async (method, payload) => {
    calls.push({ method, payload });
    if (method.startsWith('send')) {
        return method === 'sendMediaGroup'
            ? payload.media.map(() => ({ message_id: nextMessageId++ }))
            : { message_id: nextMessageId++ };
    }
    return true;
};

let updateId = 1;
const privateChat = (id) => ({ id, type: 'private', first_name: 'U' });
const groupChat = { id: -100500, type: 'supergroup', title: 'Admins' };
const user = (id) => ({ id, is_bot: false, first_name: 'U' });

function message(fromId, fields, chat = privateChat(fromId)) {
    const msg = { message_id: nextMessageId++, date: 0, chat, from: user(fromId), ...fields };
    if (fields.text && fields.text.startsWith('/')) {
        msg.entities = [{ type: 'bot_command', offset: 0, length: fields.text.split(' ')[0].length }];
    }
    return bot.handleUpdate({ update_id: updateId++, message: msg });
}

function tap(fromId, data, chat = privateChat(fromId)) {
    return bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
            id: String(updateId),
            from: user(fromId),
            chat_instance: '1',
            data,
            message: { message_id: 1, date: 0, chat, from: user(1), text: 'x' }
        }
    });
}

const sentTo = (chatId) => calls.filter(c => c.method.startsWith('send') && String(c.payload.chat_id) === String(chatId));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fillOrderUntilPhotos(userId) {
    await message(userId, { text: '/start' });
    await message(userId, { text: 'Русский 🇷🇺' });
    await message(userId, { text: 'Tom & Jerry' });
    await message(userId, { text: '+998 (90) 123-45-67' });
    await message(userId, { location: { latitude: 41.31, longitude: 69.28 } });
    await message(userId, { text: '3' });
}

test.beforeEach(() => { calls = []; });

test('full order flow: album keeps all photos, one status reply, no HTML escaping', async () => {
    await fillOrderUntilPhotos(10);
    calls = [];

    const album = [1, 2, 3, 4, 5].map(i => message(10, {
        media_group_id: 'album1',
        photo: [{ file_id: `photo${i}`, file_unique_id: `u${i}`, width: 1, height: 1 }]
    }));
    await Promise.all(album);
    await sleep(1700);

    assert.strictEqual(db.getSession(10).photos.length, 5);
    assert.strictEqual(sentTo(10).length, 1, 'one status message per album');

    calls = [];
    await Promise.all([tap(10, 'photos_done'), tap(10, 'photos_done')]);

    assert.strictEqual(db.getActiveOrdersCount(), 1, 'double tap must not create two orders');
    const groupTexts = sentTo(-100500).filter(c => c.method === 'sendMessage').map(c => c.payload.text);
    assert.strictEqual(groupTexts.length, 1);
    assert.match(groupTexts[0], /Tom & Jerry/);
    assert.doesNotMatch(groupTexts[0], /&amp;/);
    assert.strictEqual(sentTo(-100500).filter(c => c.method === 'sendMediaGroup').length, 1);
});

test('order_ready requires a whitelisted admin in the group', async () => {
    const [order] = db.getActiveOrders(1, 0);

    await tap(555, `order_ready:${order.orderId}`, groupChat);
    assert.ok(db.getOrder(order.orderId), 'non-admin must not complete the order');

    await tap(777, `order_ready:${order.orderId}`, privateChat(777));
    assert.ok(db.getOrder(order.orderId), 'admin outside the group must not complete the order');

    await tap(777, `order_ready:${order.orderId}`, groupChat);
    assert.strictEqual(db.getOrder(order.orderId), null);
});

test('bot ignores customer traffic in the admin group', async () => {
    await message(555, { text: 'hello' }, groupChat);
    await message(555, { sticker: { file_id: 's' } }, groupChat);
    await message(555, { text: '/start' }, groupChat);

    assert.strictEqual(calls.filter(c => c.method.startsWith('send')).length, 0);
    assert.strictEqual(db.getSession(555), null);
});

test('/find pads short ids and works for admins', async () => {
    await fillOrderUntilPhotos(20);
    await message(20, { photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] });
    await tap(20, 'photos_done');
    const [order] = db.getUserActiveOrders(20);
    calls = [];

    await message(777, { text: `/find ${Number(order.shortId)}` }, groupChat);

    const reply = sentTo(-100500).find(c => c.method === 'sendMessage');
    assert.match(reply.payload.text, new RegExp(`#${order.shortId}`));
});

test('text on the location step re-asks instead of staying silent', async () => {
    await message(30, { text: '/start' });
    await message(30, { text: 'Русский 🇷🇺' });
    await message(30, { text: 'Ali' });
    await message(30, { text: '901234567' });
    calls = [];

    await message(30, { text: 'Chilonzor 5' });
    assert.strictEqual(sentTo(30).length, 1);
    assert.strictEqual(db.getSession(30).step, 'location');
});

test('abandoning a draft does not notify admins', async () => {
    await message(40, { text: '/start' });
    await message(40, { text: 'Русский 🇷🇺' });
    await message(40, { text: 'Ali' });
    await message(40, { text: '+998901234567' });
    calls = [];

    await message(40, { text: '/start' });
    assert.strictEqual(sentTo(-100500).length, 0);
});

test('rate limit warns once and then stays silent', async () => {
    for (let i = 0; i < 35; i++) await message(50, { text: 'spam' });
    const warnings = sentTo(50).filter(c => /Слишком много/.test(c.payload.text));
    assert.strictEqual(warnings.length, 1);
});
