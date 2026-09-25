require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const BotDatabase = require('./database');
const {
    MAX_KNIVES,
    MIN_KNIVES,
    normalizeUzbekPhone,
    isValidName,
    parseKnivesCount,
    sanitizeLocation,
} = require('./validation');

// ========== CONSTANTS ==========
const SHORT_ID_LENGTH = 6;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_MESSAGES = 30; // high enough for a 10-photo album plus button taps
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MEDIA_GROUP_MAX_SIZE = 10;
const MAX_PHOTOS_PER_ORDER = 10;
const ALBUM_DEBOUNCE_MS = 1500; // wait for the rest of an album before replying once
const ORDERS_PAGE_SIZE = 10;
const TELEGRAM_RETRY_ATTEMPTS = 3;

// ========== ENVIRONMENT VALIDATION ==========
function validateEnvironment() {
    const required = ['BOT_TOKEN', 'GROUP_CHAT_ID'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        console.error(`❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
        console.error('Please check your .env file and ensure all required variables are set.');
        process.exit(1);
    }

    const groupChatId = process.env.GROUP_CHAT_ID.trim();
    if (!/^-?\d+$/.test(groupChatId)) {
        console.error('❌ FATAL: GROUP_CHAT_ID must be a valid number');
        process.exit(1);
    }

    const adminIds = (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(id => /^\d+$/.test(id))
        .map(Number);

    return {
        botToken: process.env.BOT_TOKEN,
        groupChatId,
        adminIds
    };
}

const config = validateEnvironment();
const bot = new Telegraf(config.botToken);
const db = new BotDatabase(process.env.DB_PATH || 'orders.db');

// ========== LOGGING ==========
// Never log names, phones or coordinates: only ids.
const logger = {
    info: (message, context = {}) => {
        console.log(`[INFO] [${new Date().toISOString()}] ${message}`, context);
    },
    warn: (message, context = {}) => {
        console.warn(`[WARN] [${new Date().toISOString()}] ${message}`, context);
    },
    error: (message, error = null, context = {}) => {
        console.error(`[ERROR] [${new Date().toISOString()}] ${message}`, context);
        if (error && error.stack) {
            console.error(error.stack);
        }
    }
};

// ========== TELEGRAM HELPERS ==========
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Retries a Telegram call when it is rate limited (HTTP 429 with retry_after)
async function withRetry(fn) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const retryAfter = error?.response?.parameters?.retry_after;
            if (!retryAfter || attempt >= TELEGRAM_RETRY_ATTEMPTS) throw error;
            logger.warn('Telegram rate limit, retrying', { retryAfter, attempt });
            await sleep((retryAfter + 1) * 1000);
        }
    }
}

async function safeAnswerCbQuery(ctx, text) {
    try {
        await ctx.answerCbQuery(text);
    } catch (e) {
        // Query too old or already answered
    }
}

function isGroupChat(ctx) {
    return String(ctx.chat?.id) === config.groupChatId;
}

// ========== AUTHORIZATION ==========
function isAdmin(userId) {
    return config.adminIds.length === 0 || config.adminIds.includes(Number(userId));
}

async function requireAdmin(ctx, next) {
    const userId = ctx.from?.id;

    // Must be in admin group
    if (!isGroupChat(ctx)) {
        logger.warn('Admin action attempted outside group', { userId, chatId: ctx.chat?.id });
        if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
        return;
    }

    // Must be authorized admin (if whitelist configured)
    if (!isAdmin(userId)) {
        logger.warn('Unauthorized admin action attempt', { userId });
        const text = '❌ У вас нет прав для выполнения этой команды.';
        return ctx.callbackQuery ? safeAnswerCbQuery(ctx, text) : ctx.reply(text);
    }

    return next();
}

// ========== MESSAGES ==========
const mapsLink = (location) => `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;

const messages = {
    ru: {
        welcome: 'Здравствуйте! Пожалуйста, выберите язык:',
        ask_name: 'Введите ваше имя:',
        ask_phone: 'Введите номер телефона (в формате +998XXXXXXXXX):',
        ask_location: 'Отправьте вашу локацию кнопкой ниже:',
        ask_knives: `Сколько ножей вы хотите заточить? (${MIN_KNIVES}–${MAX_KNIVES})`,
        ask_photo: `Отправьте одно или несколько фото ваших ножей (до ${MAX_PHOTOS_PER_ORDER}):`,
        photo_received: (count) => `📷 Фото получено (${count}/${MAX_PHOTOS_PER_ORDER})`,
        photo_limit: `⚠️ Можно отправить не больше ${MAX_PHOTOS_PER_ORDER} фото. Лишние фото не добавлены.`,
        photo_options: 'Выберите действие:',
        photos_done: 'Готово - Отправить заказ',
        photos_add: 'Добавить ещё фото',
        photos_delete: 'Удалить фото',
        photos_view: 'Посмотреть все фото',
        photos_delete_all: 'Удалить все фото',
        select_photo_delete: 'Выберите фото для удаления:',
        photo_deleted: 'Фото удалено',
        no_photos: 'Нет фотографий',
        confirm_delete_all: 'Вы уверены, что хотите удалить все фото?',
        delete_all_yes: 'Да, удалить все',
        delete_all_no: 'Нет, оставить',
        all_photos_deleted: 'Все фото удалены',
        summary: (data) => `✅ Заявка принята! Наш оператор вам перезвонит озвучить цену.\n\n👤 Имя: ${data.name}\n📞 Телефон: ${data.phone}\n📍 Локация: ${mapsLink(data.location)}\n🔪 Кол-во ножей: ${data.knives}${data.photos && data.photos.length > 0 ? `\n📷 Фото: ${data.photos.length}` : ''}`,
        cancel: 'Заявка отменена. Чтобы начать заново, отправьте /start',
        location_button: 'Отправить локацию',
        phone_button: '📞 Отправить мой номер',
        restart: '🔄 Начать заново',
        cancel_order: 'Отменить заказ',
        order_cancelled: 'Заказ отменён.',
        invalid_phone: '❌ Неверный номер телефона. Введите номер в формате +998XXXXXXXXX',
        invalid_knives: `❌ Введите количество ножей (целое число от ${MIN_KNIVES} до ${MAX_KNIVES})`,
        invalid_name: '❌ Введите корректное имя (от 2 до 100 символов)',
        invalid_location: '❌ Некорректная локация. Попробуйте снова.',
        only_text: '❌ Пожалуйста, отправьте текст, контакт, локацию или фото.',
        session_expired: '⏰ Ваша сессия истекла. Пожалуйста, начните заново с /start',
        rate_limited: '⚠️ Слишком много сообщений. Пожалуйста, подождите минуту.',
        order_sent: (count) => `✅ Заказ успешно отправлен с ${count} фото!`,
        at_least_one_photo: 'Необходимо добавить хотя бы одно фото',
        add_more_photos: '📸 Отправьте ещё одно фото или несколько фото',
        photos_shown: (count) => `📷 Показываю все ваши фото (${count}):`,
        photos_shown_done: '📷 Все фото показаны. Выберите действие:',
        all_deleted_hint: (count) => `🗑️ Все фото удалены (${count}). Добавьте хотя бы одно фото для продолжения`,
        delete_cancelled: (count) => `❌ Удаление отменено. У вас ${count} фото`,
        photo_label: (n) => `Фото ${n}`,
        back: '⬅️ Назад',
        error: '❌ Произошла ошибка. Попробуйте позже или используйте /cancel для сброса.',
    },
    uz: {
        welcome: 'Salom! Iltimos, tilni tanlang:',
        ask_name: 'Ismingizni kiriting:',
        ask_phone: 'Telefon raqamingizni kiriting (+998XXXXXXXXX formatida):',
        ask_location: 'Iltimos, quyidagi tugma orqali joylashuvingizni yuboring:',
        ask_knives: `Nechta pichoqni charxlatmoqchisiz? (${MIN_KNIVES}–${MAX_KNIVES})`,
        ask_photo: `Pichoqlaringizning bir yoki bir nechta fotosuratini yuboring (${MAX_PHOTOS_PER_ORDER} tagacha):`,
        photo_received: (count) => `📷 Foto qabul qilindi (${count}/${MAX_PHOTOS_PER_ORDER})`,
        photo_limit: `⚠️ ${MAX_PHOTOS_PER_ORDER} tadan ortiq foto yuborib bo'lmaydi. Ortiqcha fotolar qo'shilmadi.`,
        photo_options: 'Amalni tanlang:',
        photos_done: 'Tayyor - Buyurtmani yuborish',
        photos_add: 'Yana foto qo\'shish',
        photos_delete: 'Fotoni o\'chirish',
        photos_view: 'Barcha fotolarni ko\'rish',
        photos_delete_all: 'Barcha fotolarni o\'chirish',
        select_photo_delete: 'O\'chirish uchun fotoni tanlang:',
        photo_deleted: 'Foto o\'chirildi',
        no_photos: 'Fotolar yo\'q',
        confirm_delete_all: 'Barcha fotolarni o\'chirishni xohlaysizmi?',
        delete_all_yes: 'Ha, barchasini o\'chirish',
        delete_all_no: 'Yo\'q, qoldirish',
        all_photos_deleted: 'Barcha fotolar o\'chirildi',
        summary: (data) => `✅ Buyurtma qabul qilindi! Bizning operator sizga qo'ng'iroq qilib narxni aytadi.\n\n👤 Ism: ${data.name}\n📞 Telefon: ${data.phone}\n📍 Joylashuv: ${mapsLink(data.location)}\n🔪 Pichoqlar soni: ${data.knives}${data.photos && data.photos.length > 0 ? `\n📷 Foto: ${data.photos.length}` : ''}`,
        cancel: 'Buyurtma bekor qilindi. Qayta boshlash uchun /start ni yuboring',
        location_button: 'Joylashuvni yuborish',
        phone_button: '📞 Raqamni yuborish',
        restart: '🔄 Qayta boshlash',
        cancel_order: 'Buyurtmani bekor qilish',
        order_cancelled: 'Buyurtma bekor qilindi.',
        invalid_phone: '❌ Telefon raqami noto\'g\'ri. +998XXXXXXXXX formatida kiriting.',
        invalid_knives: `❌ Pichoqlar soni noto'g'ri (${MIN_KNIVES} dan ${MAX_KNIVES} gacha butun son).`,
        invalid_name: '❌ To\'g\'ri ismni kiriting (2 dan 100 gacha belgi)',
        invalid_location: '❌ Noto\'g\'ri joylashuv. Qayta urinib ko\'ring.',
        only_text: '❌ Iltimos, matn, kontakt, joylashuv yoki foto yuboring.',
        session_expired: '⏰ Sessiyangiz tugadi. Iltimos, /start bilan qayta boshlang',
        rate_limited: '⚠️ Juda ko\'p xabarlar. Iltimos, bir daqiqa kuting.',
        order_sent: (count) => `✅ Buyurtma ${count} ta foto bilan muvaffaqiyatli yuborildi!`,
        at_least_one_photo: 'Kamida bitta foto qo\'shish kerak',
        add_more_photos: '📸 Yana bir yoki bir nechta foto yuboring',
        photos_shown: (count) => `📷 Barcha fotolaringizni ko'rsatyapman (${count}):`,
        photos_shown_done: '📷 Barcha fotolar ko\'rsatildi. Amalni tanlang:',
        all_deleted_hint: (count) => `🗑️ Barcha fotolar o'chirildi (${count}). Davom etish uchun kamida bitta foto qo'shing`,
        delete_cancelled: (count) => `❌ O'chirish bekor qilindi. Sizda ${count} ta foto bor`,
        photo_label: (n) => `Foto ${n}`,
        back: '⬅️ Orqaga',
        error: '❌ Xatolik yuz berdi. Keyinroq urinib ko\'ring yoki /cancel dan foydalaning.',
    }
};

const LANGUAGE_BUTTONS = { 'Русский 🇷🇺': 'ru', "O'zbek 🇺🇿": 'uz' };

function t(lang) {
    return messages[lang] || messages.ru;
}

// ========== KEYBOARD BUILDERS ==========
function languageKeyboard() {
    return Markup.keyboard([Object.keys(LANGUAGE_BUTTONS)]).oneTime().resize();
}

function locationKeyboard(lang) {
    return Markup.keyboard([
        [Markup.button.locationRequest(t(lang).location_button)]
    ]).oneTime().resize();
}

function phoneKeyboard(lang) {
    return Markup.keyboard([
        [Markup.button.contactRequest(t(lang).phone_button)]
    ]).oneTime().resize();
}

function buildPhotoManagementKeyboard(lang, hasPhotos = true) {
    const m = t(lang);
    if (!hasPhotos) {
        return Markup.inlineKeyboard([
            [Markup.button.callback(m.photos_add, 'photos_add')]
        ]);
    }

    return Markup.inlineKeyboard([
        [Markup.button.callback(m.photos_done, 'photos_done')],
        [
            Markup.button.callback(m.photos_add, 'photos_add'),
            Markup.button.callback(m.photos_view, 'photos_view')
        ],
        [
            Markup.button.callback(m.photos_delete, 'photos_delete'),
            Markup.button.callback(m.photos_delete_all, 'photos_delete_all')
        ]
    ]);
}

// ========== ADMIN FORMATTING (always Russian) ==========
function formatDate(timestamp, options = {}) {
    return new Date(timestamp).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', ...options });
}

function formatOrderForAdmin(order) {
    return `🆔 Заказ #${order.shortId}\n\n` +
        `👤 Клиент: ${order.name}\n` +
        `📞 Телефон: ${order.phone}\n` +
        `📍 Локация: ${mapsLink(order.location)}\n` +
        `🔪 Ножей: ${order.knives}\n` +
        `📷 Фото: ${order.photos ? order.photos.length : 0}\n` +
        `🌐 Язык: ${order.lang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 Узбекский'}\n` +
        `📅 ${formatDate(order.createdAt)}`;
}

function orderReadyKeyboard(orderId) {
    return Markup.inlineKeyboard([
        Markup.button.callback('✅ Заказ готов', `order_ready:${orderId}`)
    ]);
}

async function notifyGroupOrderCancelled(order, reason) {
    const text = `❌ Заказ #${order.shortId} отменён пользователем${reason ? ` (${reason})` : ''}.\n\n` +
        `👤 ${order.name}\n📞 ${order.phone}`;
    try {
        await withRetry(() => bot.telegram.sendMessage(config.groupChatId, text));
    } catch (error) {
        logger.error('Failed to send cancellation to group', error, { orderId: order.orderId });
    }
}

async function sendOrderToGroup(order) {
    const photos = order.photos || [];

    // Photos go as albums (up to 10 per message) to stay within Telegram group limits
    for (let i = 0; i < photos.length; i += MEDIA_GROUP_MAX_SIZE) {
        const chunk = photos.slice(i, i + MEDIA_GROUP_MAX_SIZE);
        const caption = `📷 Заказ #${order.shortId} — фото ${i + 1}–${i + chunk.length} из ${photos.length}`;

        if (chunk.length === 1) {
            await withRetry(() => bot.telegram.sendPhoto(config.groupChatId, chunk[0], { caption }));
        } else {
            const media = chunk.map((fileId, index) => ({
                type: 'photo',
                media: fileId,
                ...(index === 0 ? { caption } : {})
            }));
            await withRetry(() => bot.telegram.sendMediaGroup(config.groupChatId, media));
        }
    }

    await withRetry(() => bot.telegram.sendMessage(
        config.groupChatId,
        formatOrderForAdmin(order),
        orderReadyKeyboard(order.orderId)
    ));

    logger.info('Order sent to group', { orderId: order.orderId, shortId: order.shortId, photoCount: photos.length });
}

function renderOrdersPage(requestedPage) {
    const totalOrders = db.getActiveOrdersCount();
    if (totalOrders === 0) {
        return { text: '📋 Нет активных заказов', keyboard: null, page: 0, totalOrders };
    }

    const lastPage = Math.ceil(totalOrders / ORDERS_PAGE_SIZE) - 1;
    const page = Math.min(Math.max(requestedPage, 0), lastPage);
    const orders = db.getActiveOrders(ORDERS_PAGE_SIZE, page * ORDERS_PAGE_SIZE);

    let text = `📋 Активные заказы (${totalOrders}), стр. ${page + 1}/${lastPage + 1}:\n\n`;
    for (const order of orders) {
        const orderTime = formatDate(order.createdAt, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        text += `🆔 #${order.shortId}\n` +
            `👤 ${order.name}\n` +
            `📞 ${order.phone}\n` +
            `🔪 ${order.knives} ножей\n` +
            `📷 ${order.photos ? order.photos.length : 0} фото\n` +
            `📅 ${orderTime}\n\n`;
    }

    const buttons = [];
    if (page > 0) {
        buttons.push(Markup.button.callback('◀️ Назад', `orders_page:${page - 1}`));
    }
    if (page < lastPage) {
        buttons.push(Markup.button.callback('Вперед ▶️', `orders_page:${page + 1}`));
    }

    return {
        text,
        keyboard: buttons.length > 0 ? Markup.inlineKeyboard([buttons]) : null,
        page,
        totalOrders
    };
}

// ========== ADMIN HANDLERS (group chat) ==========
bot.command('find', requireAdmin, async (ctx) => {
    try {
        const arg = (ctx.payload || '').trim().replace(/^#/, '');
        if (!/^\d+$/.test(arg)) {
            return ctx.reply('Использование: /find 000123\nПример: /find 123');
        }

        const searchId = arg.padStart(SHORT_ID_LENGTH, '0');
        const order = db.getOrderByShortId(searchId);

        if (!order) {
            return ctx.reply(`❌ Заказ #${searchId} не найден или уже завершен.`);
        }

        await ctx.reply(`🔍 Найден заказ\n\n${formatOrderForAdmin(order)}`, orderReadyKeyboard(order.orderId));

        logger.info('Order found by admin', { orderId: order.orderId, shortId: searchId, userId: ctx.from.id });
    } catch (error) {
        logger.error('Error in /find command', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка при поиске заказа.');
    }
});

bot.command('orders', requireAdmin, async (ctx) => {
    try {
        const { text, keyboard, page, totalOrders } = renderOrdersPage(0);
        await ctx.reply(text, keyboard || undefined);
        logger.info('Orders list viewed', { userId: ctx.from.id, page, totalOrders });
    } catch (error) {
        logger.error('Error in /orders command', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка при получении списка заказов.');
    }
});

bot.action(/^orders_page:(\d+)$/, requireAdmin, async (ctx) => {
    try {
        const { text, keyboard, page, totalOrders } = renderOrdersPage(Number(ctx.match[1]));
        try {
            await ctx.editMessageText(text, keyboard || undefined);
        } catch (e) {
            // Message unchanged
        }
        await safeAnswerCbQuery(ctx);
        logger.info('Orders pagination', { userId: ctx.from.id, page, totalOrders });
    } catch (error) {
        logger.error('Error in orders pagination', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action(/^order_ready:(.+)$/, requireAdmin, async (ctx) => {
    try {
        const order = db.completeOrder(ctx.match[1], 'completed');

        if (!order) {
            return safeAnswerCbQuery(ctx, 'Заказ уже обработан или не найден.');
        }

        try {
            await ctx.editMessageText(`${formatOrderForAdmin(order)}\n\n✅ Заказ готов.`);
        } catch (e) {
            logger.error('Error editing message', e, { orderId: order.orderId });
        }

        await safeAnswerCbQuery(ctx, 'Заказ отмечен как готов.');
        logger.info('Order marked ready by admin', { orderId: order.orderId, adminId: ctx.from.id });
    } catch (error) {
        logger.error('Error marking order ready', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

// ========== PRIVATE CHAT ONLY BELOW ==========
// Customer handlers must not react to messages in the admin group or any other chat
bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from) {
        if (ctx.callbackQuery) await safeAnswerCbQuery(ctx);
        return;
    }
    return next();
});

// ========== RATE LIMITING ==========
bot.use(async (ctx, next) => {
    const userId = ctx.from.id;
    const { allowed, firstBlocked } = db.checkRateLimit(userId, RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS);
    if (allowed) return next();

    const lang = db.getSession(userId)?.lang;
    if (ctx.callbackQuery) {
        return safeAnswerCbQuery(ctx, t(lang).rate_limited);
    }
    if (firstBlocked) {
        logger.warn('Rate limit exceeded', { userId });
        return ctx.reply(t(lang).rate_limited);
    }
});

// ========== MESSAGE TYPE FILTERING ==========
bot.on('message', (ctx, next) => {
    const msg = ctx.message;
    const allowed = msg.text || msg.location || msg.contact || msg.photo;
    if (allowed) return next();

    const session = db.getSession(ctx.from.id);
    return ctx.reply(t(session?.lang).only_text);
});

// ========== FLOW HELPERS ==========
// Drops an unfinished draft. Drafts were never sent to admins, so admins are not notified.
async function startNewSession(ctx) {
    db.saveSession(ctx.from.id, { step: 'lang' });
    await ctx.reply(`${messages.ru.welcome}\n${messages.uz.welcome}`, languageKeyboard());
}

async function cancelUserActiveOrders(userId, reason) {
    const activeOrders = db.getUserActiveOrders(userId);
    for (const activeOrder of activeOrders) {
        const archived = db.cancelOrder(activeOrder.orderId);
        if (archived) await notifyGroupOrderCancelled(archived, reason);
    }
    return activeOrders.length;
}

async function sendPhotoStatus(chatId, userId, rejected = false) {
    const session = db.getSession(userId);
    if (!session || session.step !== 'photo') return;

    const m = t(session.lang);
    const count = session.photos.length;
    let text = count > 0 ? m.photo_received(count) : m.ask_photo;
    if (rejected) text += `\n\n${m.photo_limit}`;

    await bot.telegram.sendMessage(chatId, text, buildPhotoManagementKeyboard(session.lang, count > 0));
}

// ========== COMMAND: /start ==========
bot.start(async (ctx) => {
    try {
        await startNewSession(ctx);
        logger.info('User started bot', { userId: ctx.from.id });
    } catch (error) {
        logger.error('Error in /start command', error, { userId: ctx.from?.id });
        await ctx.reply(messages.ru.error);
    }
});

// ========== COMMAND: /cancel ==========
bot.command('cancel', async (ctx) => {
    try {
        db.deleteSession(ctx.from.id);
        await ctx.reply(`${messages.ru.cancel}\n${messages.uz.cancel}`, Markup.removeKeyboard());
        logger.info('User cancelled draft', { userId: ctx.from.id });
    } catch (error) {
        logger.error('Error in /cancel command', error, { userId: ctx.from?.id });
    }
});

// ========== TEXT MESSAGE HANDLER ==========
bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        // Handle restart button
        if ([messages.ru.restart, messages.uz.restart].includes(text)) {
            return startNewSession(ctx);
        }

        if (!session) {
            return ctx.reply('Пожалуйста, начните с /start\nIltimos, /start dan boshlang');
        }

        const m = t(session.lang);

        switch (session.step) {
            case 'lang': {
                const lang = LANGUAGE_BUTTONS[text];
                if (!lang) {
                    return ctx.reply(`${messages.ru.welcome}\n${messages.uz.welcome}`, languageKeyboard());
                }
                session.lang = lang;
                session.step = 'name';
                db.saveSession(userId, session);
                return ctx.reply(messages[lang].ask_name, Markup.removeKeyboard());
            }

            case 'name': {
                if (!isValidName(text)) {
                    return ctx.reply(m.invalid_name);
                }
                session.name = text;
                session.step = 'phone';
                db.saveSession(userId, session);
                return ctx.reply(m.ask_phone, phoneKeyboard(session.lang));
            }

            case 'phone': {
                const phone = normalizeUzbekPhone(text);
                if (!phone) {
                    return ctx.reply(m.invalid_phone, phoneKeyboard(session.lang));
                }
                session.phone = phone;
                session.step = 'location';
                db.saveSession(userId, session);
                return ctx.reply(m.ask_location, locationKeyboard(session.lang));
            }

            case 'location':
                // Text addresses are not accepted: ask for the location button again
                return ctx.reply(m.ask_location, locationKeyboard(session.lang));

            case 'knives': {
                const knives = parseKnivesCount(text);
                if (knives === null) {
                    return ctx.reply(m.invalid_knives);
                }
                session.knives = knives;
                session.step = 'photo';
                session.photos = [];
                db.saveSession(userId, session);
                return ctx.reply(m.ask_photo, Markup.removeKeyboard());
            }

            case 'photo':
                return sendPhotoStatus(ctx.chat.id, userId);

            default:
                return startNewSession(ctx);
        }
    } catch (error) {
        logger.error('Error in text handler', error, { userId: ctx.from?.id });
        await ctx.reply(messages.ru.error);
    }
});

// ========== LOCATION HANDLER ==========
bot.on('location', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session) {
            return ctx.reply(messages.ru.session_expired);
        }

        if (session.step !== 'location') {
            return;
        }

        const location = sanitizeLocation(ctx.message.location);
        if (!location) {
            return ctx.reply(t(session.lang).invalid_location, locationKeyboard(session.lang));
        }

        session.location = location;
        session.step = 'knives';
        db.saveSession(userId, session);
        await ctx.reply(t(session.lang).ask_knives, Markup.removeKeyboard());
    } catch (error) {
        logger.error('Error in location handler', error, { userId: ctx.from?.id });
        await ctx.reply(messages.ru.error);
    }
});

// ========== CONTACT HANDLER ==========
bot.on('contact', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'phone') {
            return;
        }

        const phone = normalizeUzbekPhone(ctx.message.contact.phone_number);
        if (!phone) {
            return ctx.reply(t(session.lang).invalid_phone, phoneKeyboard(session.lang));
        }

        session.phone = phone;
        session.step = 'location';
        db.saveSession(userId, session);
        await ctx.reply(t(session.lang).ask_location, locationKeyboard(session.lang));
    } catch (error) {
        logger.error('Error in contact handler', error, { userId: ctx.from?.id });
        await ctx.reply(messages.ru.error);
    }
});

// ========== PHOTO HANDLER ==========
// Albums arrive as separate updates processed concurrently. Each photo is appended in a
// single DB transaction (no stale read-modify-write), and one status reply is sent per album.
const pendingAlbums = new Map();

bot.on('photo', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return;
        }

        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const count = db.addSessionPhoto(userId, photoId, MAX_PHOTOS_PER_ORDER);
        const rejected = count === null;

        const mediaGroupId = ctx.message.media_group_id;
        if (mediaGroupId) {
            const key = `${userId}:${mediaGroupId}`;
            const entry = pendingAlbums.get(key) || { rejected: false };
            clearTimeout(entry.timer);
            entry.rejected = entry.rejected || rejected;
            entry.timer = setTimeout(() => {
                pendingAlbums.delete(key);
                sendPhotoStatus(ctx.chat.id, userId, entry.rejected)
                    .catch(error => logger.error('Failed to send album status', error, { userId }));
            }, ALBUM_DEBOUNCE_MS);
            pendingAlbums.set(key, entry);
        } else {
            await sendPhotoStatus(ctx.chat.id, userId, rejected);
        }

        logger.info('Photo received', { userId, photoCount: count, rejected });
    } catch (error) {
        logger.error('Error in photo handler', error, { userId: ctx.from?.id });
        await ctx.reply(messages.ru.error);
    }
});

// ========== PHOTO ACTIONS ==========
bot.action('photos_done', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return safeAnswerCbQuery(ctx, messages.ru.session_expired);
        }

        const m = t(session.lang);
        if (!session.photos || session.photos.length === 0) {
            return safeAnswerCbQuery(ctx, m.at_least_one_photo);
        }

        // Synchronous and atomic: a second tap finds no session and cannot create a duplicate
        const { orderId, shortId, createdAt } = db.placeOrderFromSession(userId, session);
        const order = { ...session, orderId, shortId, createdAt, creatorId: userId };

        await safeAnswerCbQuery(ctx);
        try {
            await ctx.editMessageReplyMarkup(undefined);
        } catch (e) {
            // Message too old or already edited
        }

        // The order is already saved, so admins can see it with /orders even if delivery fails
        try {
            await sendOrderToGroup(order);
        } catch (error) {
            logger.error('Failed to send order to group, available via /orders', error, { orderId, shortId });
        }

        await ctx.reply(m.order_sent(session.photos.length));
        await ctx.reply(
            m.summary(order),
            Markup.inlineKeyboard([
                Markup.button.callback(m.cancel_order, `cancel_order:${orderId}`),
                Markup.button.callback(m.restart, 'restart')
            ])
        );

        logger.info('Order placed', { userId, orderId, shortId, photoCount: session.photos.length });
    } catch (error) {
        logger.error('Error completing order', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка при отправке заказа');
        await ctx.reply(messages.ru.error);
    }
});

bot.action('photos_add', async (ctx) => {
    try {
        const session = db.getSession(ctx.from.id);

        if (!session || session.step !== 'photo') {
            return safeAnswerCbQuery(ctx, messages.ru.session_expired);
        }

        await ctx.reply(t(session.lang).add_more_photos);
        await safeAnswerCbQuery(ctx);
    } catch (error) {
        logger.error('Error in photos_add', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action('photos_delete', async (ctx) => {
    try {
        const session = db.getSession(ctx.from.id);

        if (!session || session.step !== 'photo' || session.photos.length === 0) {
            return safeAnswerCbQuery(ctx, t(session?.lang).no_photos);
        }

        const m = t(session.lang);
        const buttons = session.photos.map((_, index) =>
            Markup.button.callback(m.photo_label(index + 1), `delete_photo:${index}`)
        );
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) {
            keyboard.push(buttons.slice(i, i + 2));
        }
        keyboard.push([Markup.button.callback(m.back, 'photos_back')]);

        await ctx.editMessageText(m.select_photo_delete, Markup.inlineKeyboard(keyboard));
        await safeAnswerCbQuery(ctx);
    } catch (error) {
        logger.error('Error in photos_delete', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action(/^delete_photo:(\d+)$/, async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);
        const photoIndex = Number(ctx.match[1]);

        if (!session || session.step !== 'photo' || photoIndex >= session.photos.length) {
            return safeAnswerCbQuery(ctx, t(session?.lang).no_photos);
        }

        session.photos.splice(photoIndex, 1);
        db.saveSession(userId, session);

        const m = t(session.lang);
        const count = session.photos.length;
        await ctx.editMessageText(
            count > 0 ? m.photo_received(count) : m.ask_photo,
            buildPhotoManagementKeyboard(session.lang, count > 0)
        );
        await safeAnswerCbQuery(ctx, m.photo_deleted);

        logger.info('Photo deleted', { userId, photoIndex, remainingCount: count });
    } catch (error) {
        logger.error('Error deleting photo', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action('photos_back', async (ctx) => {
    try {
        const session = db.getSession(ctx.from.id);

        if (!session || session.step !== 'photo') {
            return safeAnswerCbQuery(ctx, messages.ru.session_expired);
        }

        const m = t(session.lang);
        const count = session.photos.length;
        await ctx.editMessageText(
            count > 0 ? m.photo_received(count) : m.ask_photo,
            buildPhotoManagementKeyboard(session.lang, count > 0)
        );
        await safeAnswerCbQuery(ctx);
    } catch (error) {
        logger.error('Error in photos_back', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action('photos_view', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo' || session.photos.length === 0) {
            return safeAnswerCbQuery(ctx, t(session?.lang).no_photos);
        }

        const m = t(session.lang);
        const photos = session.photos;
        await safeAnswerCbQuery(ctx);
        await ctx.reply(m.photos_shown(photos.length));

        for (let i = 0; i < photos.length; i += MEDIA_GROUP_MAX_SIZE) {
            const chunk = photos.slice(i, i + MEDIA_GROUP_MAX_SIZE);
            if (chunk.length === 1) {
                await ctx.replyWithPhoto(chunk[0]);
            } else {
                await ctx.replyWithMediaGroup(chunk.map(photoId => ({ type: 'photo', media: photoId })));
            }
        }

        await ctx.reply(m.photos_shown_done, buildPhotoManagementKeyboard(session.lang, true));
        logger.info('Photos viewed', { userId, photoCount: photos.length });
    } catch (error) {
        logger.error('Error viewing photos', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action('photos_delete_all', async (ctx) => {
    try {
        const session = db.getSession(ctx.from.id);

        if (!session || session.step !== 'photo' || session.photos.length === 0) {
            return safeAnswerCbQuery(ctx, t(session?.lang).no_photos);
        }

        const m = t(session.lang);
        await ctx.reply(m.confirm_delete_all, Markup.inlineKeyboard([
            [
                Markup.button.callback(m.delete_all_yes, 'confirm_delete_all_yes'),
                Markup.button.callback(m.delete_all_no, 'confirm_delete_all_no')
            ]
        ]));
        await safeAnswerCbQuery(ctx);
    } catch (error) {
        logger.error('Error in photos_delete_all', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action('confirm_delete_all_yes', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return safeAnswerCbQuery(ctx, messages.ru.session_expired);
        }

        const m = t(session.lang);
        const photoCount = session.photos.length;
        session.photos = [];
        db.saveSession(userId, session);

        try {
            await ctx.editMessageText(m.all_deleted_hint(photoCount), buildPhotoManagementKeyboard(session.lang, false));
        } catch (e) {
            await ctx.reply(m.all_deleted_hint(photoCount), buildPhotoManagementKeyboard(session.lang, false));
        }
        await safeAnswerCbQuery(ctx, m.all_photos_deleted);

        logger.info('All photos deleted', { userId, deletedCount: photoCount });
    } catch (error) {
        logger.error('Error confirming delete all', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

bot.action('confirm_delete_all_no', async (ctx) => {
    try {
        const session = db.getSession(ctx.from.id);

        if (!session || session.step !== 'photo') {
            return safeAnswerCbQuery(ctx, messages.ru.session_expired);
        }

        const m = t(session.lang);
        const count = session.photos.length;
        try {
            await ctx.editMessageText(m.delete_cancelled(count), buildPhotoManagementKeyboard(session.lang, count > 0));
        } catch (e) {
            await ctx.reply(m.delete_cancelled(count), buildPhotoManagementKeyboard(session.lang, count > 0));
        }
        await safeAnswerCbQuery(ctx);
    } catch (error) {
        logger.error('Error in confirm_delete_all_no', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

// ========== ORDER CANCELLATION BY USER ==========
bot.action(/^cancel_order:(.+)$/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.getOrder(orderId);

        if (!order) {
            return safeAnswerCbQuery(ctx, 'Заказ уже отменён или выполнен.');
        }

        if (String(order.creatorId) !== String(ctx.from.id)) {
            return safeAnswerCbQuery(ctx, 'Вы не можете отменить этот заказ.');
        }

        const archived = db.cancelOrder(orderId);
        if (!archived) {
            return safeAnswerCbQuery(ctx, 'Заказ уже отменён или выполнен.');
        }

        await notifyGroupOrderCancelled(archived);

        const m = t(order.lang);
        try {
            await ctx.editMessageText(m.order_cancelled, Markup.inlineKeyboard([
                Markup.button.callback(m.restart, 'restart')
            ]));
        } catch (e) {
            // Message already edited
        }

        await safeAnswerCbQuery(ctx, m.order_cancelled);
        logger.info('Order cancelled by user', { orderId, userId: ctx.from.id });
    } catch (error) {
        logger.error('Error cancelling order', error, { userId: ctx.from?.id });
        await safeAnswerCbQuery(ctx, '❌ Ошибка');
    }
});

// ========== RESTART ACTION (button under the order summary) ==========
bot.action('restart', async (ctx) => {
    try {
        const userId = ctx.from.id;

        // Cancel all active orders of this user (the button is shown under the order summary)
        const cancelledCount = await cancelUserActiveOrders(userId, 'повторный запуск');

        await safeAnswerCbQuery(ctx);
        try {
            await ctx.deleteMessage();
        } catch (e) {
            // Message can't be deleted
        }

        await startNewSession(ctx);
        logger.info('User restarted', { userId, cancelledCount });
    } catch (error) {
        logger.error('Error in restart action', error, { userId: ctx.from?.id });
    }
});

// ========== ERROR HANDLERS ==========
bot.catch((error, ctx) => {
    logger.error('Bot error', error, {
        userId: ctx.from?.id,
        updateType: ctx.updateType
    });
});

// ========== CLEANUP TASK ==========
function startCleanupTask() {
    return setInterval(() => {
        try {
            const deletedSessions = db.cleanExpiredSessions(SESSION_TIMEOUT_MS);
            const deletedRateLimits = db.cleanOldRateLimits();

            if (deletedSessions > 0 || deletedRateLimits > 0) {
                logger.info('Cleanup completed', { deletedSessions, deletedRateLimits });
            }
        } catch (error) {
            logger.error('Error in cleanup task', error);
        }
    }, CLEANUP_INTERVAL_MS);
}

// ========== GRACEFUL SHUTDOWN ==========
function shutdown(signal, cleanupTimer) {
    logger.info(`${signal} received, shutting down gracefully`);
    clearInterval(cleanupTimer);
    for (const entry of pendingAlbums.values()) clearTimeout(entry.timer);
    bot.stop(signal);
    db.close();
    process.exit(0);
}

// ========== BOT LAUNCH ==========
function main() {
    const cleanupTimer = startCleanupTask();
    process.once('SIGINT', () => shutdown('SIGINT', cleanupTimer));
    process.once('SIGTERM', () => shutdown('SIGTERM', cleanupTimer));

    bot.launch(() => {
        const stats = db.getStats();
        logger.info('Bot started successfully', stats);
        console.log('🤖 Бот запущен...');
        console.log(`📊 Статистика: ${stats.activeSessions} сессий, ${stats.activeOrders} активных заказов, ${stats.completedOrders} завершённых`);
    }).catch((error) => {
        logger.error('Failed to start bot', error);
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}

module.exports = { bot, db };
