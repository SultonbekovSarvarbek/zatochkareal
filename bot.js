require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const BotDatabase = require('./database');

// ========== CONSTANTS ==========
const MAX_KNIVES = 50;
const MIN_KNIVES = 1;
const SHORT_ID_LENGTH = 6;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_MESSAGES = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MEDIA_GROUP_MAX_SIZE = 10;

// ========== ENVIRONMENT VALIDATION ==========
function validateEnvironment() {
    const required = ['BOT_TOKEN', 'GROUP_CHAT_ID'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        console.error(`❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
        console.error('Please check your .env file and ensure all required variables are set.');
        process.exit(1);
    }

    // Validate GROUP_CHAT_ID is a number
    if (isNaN(parseInt(process.env.GROUP_CHAT_ID))) {
        console.error('❌ FATAL: GROUP_CHAT_ID must be a valid number');
        process.exit(1);
    }

    // Parse admin IDs if provided
    const adminIds = process.env.ADMIN_USER_IDS ?
        process.env.ADMIN_USER_IDS.split(',').map(id => parseInt(id.trim())) : [];

    return {
        botToken: process.env.BOT_TOKEN,
        groupChatId: process.env.GROUP_CHAT_ID,
        adminIds: adminIds
    };
}

const config = validateEnvironment();
const bot = new Telegraf(config.botToken);
const db = new BotDatabase();

// ========== LOGGING ==========
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

// ========== VALIDATION HELPERS ==========
function isValidUzbekPhone(phone) {
    const cleaned = phone.replace(/\s+/g, '');
    return /^(\+998|998)\d{9}$/.test(cleaned);
}

function normalizeUzbekPhone(phone) {
    const cleaned = phone.replace(/\s+/g, '').replace(/[^\d+]/g, '');
    if (cleaned.startsWith('998') && !cleaned.startsWith('+')) {
        return '+' + cleaned;
    }
    return cleaned;
}

function isValidName(name) {
    return name && name.trim().length >= 2 && name.trim().length <= 100;
}

function isValidLocation(location) {
    return location &&
        typeof location.latitude === 'number' &&
        typeof location.longitude === 'number' &&
        location.latitude >= -90 && location.latitude <= 90 &&
        location.longitude >= -180 && location.longitude <= 180;
}

function isValidKnivesCount(count) {
    const num = parseInt(count);
    return !isNaN(num) && num >= MIN_KNIVES && num <= MAX_KNIVES;
}

// ========== SANITIZATION ==========
function sanitizeText(text) {
    if (!text) return '';
    // Escape special characters that could break Telegram formatting
    return text.replace(/[<>&]/g, char => {
        switch (char) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            default: return char;
        }
    });
}

function sanitizeLocation(location) {
    if (!location || !isValidLocation(location)) {
        return null;
    }
    // Ensure coordinates are valid numbers
    return {
        latitude: Math.max(-90, Math.min(90, parseFloat(location.latitude))),
        longitude: Math.max(-180, Math.min(180, parseFloat(location.longitude)))
    };
}

// ========== AUTHORIZATION ==========
function isAdmin(userId) {
    return config.adminIds.length === 0 || config.adminIds.includes(parseInt(userId));
}

function requireAdmin(ctx, next) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    // Must be in admin group
    if (String(chatId) !== String(config.groupChatId)) {
        logger.warn('Admin command attempted outside group', { userId, chatId });
        return;
    }

    // Must be authorized admin (if whitelist configured)
    if (!isAdmin(userId)) {
        logger.warn('Unauthorized admin command attempt', { userId });
        return ctx.reply('❌ У вас нет прав для выполнения этой команды.');
    }

    return next();
}

// ========== MESSAGES ==========
const messages = {
    ru: {
        welcome: 'Здравствуйте! Пожалуйста, выберите язык:',
        ask_name: 'Введите ваше имя:',
        ask_phone: 'Введите номер телефона (в формате +998XXXXXXXXX):',
        ask_location: 'Отправьте вашу локацию:',
        ask_knives: `Сколько ножей вы хотите заточить? (${MIN_KNIVES}–${MAX_KNIVES})`,
        ask_photo: 'Отправьте одно или несколько фото ваших ножей:',
        photo_received: (count) => `📷 Фото получено (${count})`,
        photo_options: 'Выберите действие:',
        photos_done: 'Готово - Отправить заказ',
        photos_add: 'Добавить ещё фото',
        photos_delete: 'Удалить фото',
        photos_view: 'Посмотреть все фото',
        photos_delete_all: 'Удалить все фото',
        select_photo_delete: 'Выберите фото для удаления:',
        photo_deleted: 'Фото удалено',
        no_photos: 'Нет фотографий для удаления',
        confirm_delete_all: 'Вы уверены, что хотите удалить все фото?',
        delete_all_yes: 'Да, удалить все',
        delete_all_no: 'Нет, оставить',
        all_photos_deleted: 'Все фото удалены',
        summary: (data) => `✅ Заявка принята! Наш оператор вам перезвонит озвучить цену.\n\n👤 Имя: ${sanitizeText(data.name)}\n📞 Телефон: ${data.phone}\n📍 Локация: https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}\n🔪 Кол-во ножей: ${data.knives}${data.photos && data.photos.length > 0 ? `\n📷 Фото: ${data.photos.length}` : ''}`,
        cancel: 'Заявка отменена. Чтобы начать заново, отправьте /start',
        location_button: 'Отправить локацию',
        restart: '🔄 Начать заново',
        invalid_phone: '❌ Неверный номер телефона. Введите номер в формате +998XXXXXXXXX',
        invalid_knives: `❌ Введите количество ножей (число от ${MIN_KNIVES} до ${MAX_KNIVES})`,
        invalid_name: '❌ Введите корректное имя (минимум 2 символа)',
        only_text: '❌ Ошибка.',
        session_expired: '⏰ Ваша сессия истекла. Пожалуйста, начните заново с /start',
        rate_limited: '⚠️ Слишком много сообщений. Пожалуйста, подождите минуту.',
        order_sent: (count) => `✅ Заказ успешно отправлен с ${count} фото!`,
        at_least_one_photo: 'Необходимо добавить хотя бы одно фото',
    },
    uz: {
        welcome: 'Salom! Iltimos, tilni tanlang:',
        ask_name: 'Ismingizni kiriting:',
        ask_phone: 'Telefon raqamingizni kiriting (+998XXXXXXXXX formatida):',
        ask_location: 'Iltimos, joylashuvingizni yuboring:',
        ask_knives: `Nechta pichoqni charxlatmoqchisiz? (${MIN_KNIVES}–${MAX_KNIVES})`,
        ask_photo: 'Pichoqlaringizning bir yoki bir nechta fotosuratini yuboring:',
        photo_received: (count) => `📷 Foto qabul qilindi (${count})`,
        photo_options: 'Amalni tanlang:',
        photos_done: 'Tayyor - Buyurtmani yuborish',
        photos_add: 'Yana foto qo\'shish',
        photos_delete: 'Fotoni o\'chirish',
        photos_view: 'Barcha fotolarni ko\'rish',
        photos_delete_all: 'Barcha fotolarni o\'chirish',
        select_photo_delete: 'O\'chirish uchun fotoni tanlang:',
        photo_deleted: 'Foto o\'chirildi',
        no_photos: 'O\'chirish uchun fotolar yo\'q',
        confirm_delete_all: 'Barcha fotolarni o\'chirishni xohlaysizmi?',
        delete_all_yes: 'Ha, barchasini o\'chirish',
        delete_all_no: 'Yo\'q, qoldirish',
        all_photos_deleted: 'Barcha fotolar o\'chirildi',
        summary: (data) => `✅ Buyurtma qabul qilindi! Bizning operator sizga qo\'ng\'iroq qilib narxni aytadi.\n\n👤 Ism: ${sanitizeText(data.name)}\n📞 Telefon: ${data.phone}\n📍 Joylashuv: https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}\n🔪 Pichoqlar soni: ${data.knives}${data.photos && data.photos.length > 0 ? `\n📷 Foto: ${data.photos.length}` : ''}`,
        cancel: 'Buyurtma bekor qilindi. Qayta boshlash uchun /start ni yuboring',
        location_button: 'Joylashuvni yuborish',
        restart: '🔄 Qayta boshlash',
        invalid_phone: '❌ Telefon raqami noto\'g\'ri. +998XXXXXXXXX formatida kiriting.',
        invalid_knives: `❌ Pichoqlar soni noto\'g\'ri (${MIN_KNIVES} dan ${MAX_KNIVES} gacha).`,
        invalid_name: '❌ To\'g\'ri ismni kiriting (kamida 2 ta belgi)',
        only_text: '❌ Iltimos, faqat matn yoki joylashuv yuboring.',
        session_expired: '⏰ Sessiyangiz tugadi. Iltimos, /start bilan qayta boshlang',
        rate_limited: '⚠️ Juda ko\'p xabarlar. Iltimos, bir daqiqa kuting.',
        order_sent: (count) => `✅ Buyurtma ${count} ta foto bilan muvaffaqiyatli yuborildi!`,
        at_least_one_photo: 'Kamida bitta foto qo\'shish kerak',
    }
};

// ========== KEYBOARD BUILDER ==========
function buildPhotoManagementKeyboard(lang, hasPhotos = true) {
    if (!hasPhotos) {
        return Markup.inlineKeyboard([
            [Markup.button.callback(messages[lang].photos_add, 'photos_add')]
        ]);
    }

    return Markup.inlineKeyboard([
        [Markup.button.callback(messages[lang].photos_done, 'photos_done')],
        [
            Markup.button.callback(messages[lang].photos_add, 'photos_add'),
            Markup.button.callback(messages[lang].photos_view, 'photos_view')
        ],
        [
            Markup.button.callback(messages[lang].photos_delete, 'photos_delete'),
            Markup.button.callback(messages[lang].photos_delete_all, 'photos_delete_all')
        ]
    ]);
}

// ========== HELPER FUNCTIONS ==========
async function notifyCancellation(session) {
    if (!session || !session.name || !session.phone) return;

    const lang = session.lang || 'ru';
    const cancelMessage = `❌ Заказ отменён пользователем.\n\n👤 ${sanitizeText(session.name)}\n📞 ${session.phone}`;

    try {
        await bot.telegram.sendMessage(config.groupChatId, cancelMessage);
        logger.info('Cancellation notification sent', { name: session.name, phone: session.phone });
    } catch (error) {
        logger.error('Failed to send cancellation notification', error, { session });
    }
}

async function sendOrderToGroup(session, orderId, shortId) {
    try {
        // Send all photos with captions
        if (session.photos && session.photos.length > 0) {
            for (let i = 0; i < session.photos.length; i++) {
                const photoId = session.photos[i];
                const photoCaption = `📷 Фото ${i + 1}/${session.photos.length}\n` +
                    `🆔 Заказ #${shortId}\n` +
                    `👤 ${sanitizeText(session.name)}\n` +
                    `📞 ${session.phone}\n` +
                    `🔪 Ножей: ${session.knives}\n` +
                    `🌐 ${session.lang === 'ru' ? '🇷🇺 RU' : '🇺🇿 UZ'}\n` +
                    `📅 ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })}\n` +
                    `\n💡 ID для поиска: ${orderId}`;

                await bot.telegram.sendPhoto(config.groupChatId, photoId, {
                    caption: photoCaption
                });
            }
        }

        // Send order summary with action button
        const groupMessage = messages[session.lang].summary(session);
        const enhancedGroupMessage = `🆔 Заказ #${shortId}\n\n${groupMessage}`;

        await bot.telegram.sendMessage(
            config.groupChatId,
            enhancedGroupMessage,
            Markup.inlineKeyboard([
                Markup.button.callback(
                    session.lang === 'ru' ? 'Заказ готов' : 'Buyurtma tayyor',
                    `order_ready:${orderId}`
                )
            ])
        );

        logger.info('Order sent to group', { orderId, shortId, photoCount: session.photos?.length || 0 });
    } catch (error) {
        logger.error('Failed to send order to group', error, { orderId, shortId });
        throw error;
    }
}

// ========== RATE LIMITING MIDDLEWARE ==========
// Rate limiting disabled - users can send unlimited messages
// bot.use(async (ctx, next) => {
//     const userId = ctx.from?.id;
//     if (!userId) return next();

//     // Check rate limit
//     const allowed = db.checkRateLimit(userId, RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS);
//     if (!allowed) {
//         const session = db.getSession(userId);
//         const lang = session?.lang || 'ru';
//         logger.warn('Rate limit exceeded', { userId });
//         return ctx.reply(messages[lang].rate_limited);
//     }

//     return next();
// });

// ========== MESSAGE TYPE FILTERING ==========
bot.on('message', (ctx, next) => {
    const msg = ctx.message;
    const allowed = msg.text || msg.location || msg.contact || msg.photo;
    if (allowed) return next();

    const session = db.getSession(ctx.from.id);
    const lang = session?.lang || 'ru';
    const reply = messages[lang]?.only_text || '❌ Ошибка.';
    return ctx.reply(reply);
});

// ========== COMMAND: /start ==========
bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const oldSession = db.getSession(userId);

        // Notify if cancelling existing session
        if (oldSession) {
            await notifyCancellation(oldSession);
        }

        // Create new session
        db.saveSession(userId, { step: 'lang' });

        await ctx.reply(
            `${messages.ru.welcome}\n${messages.uz.welcome}`,
            Markup.keyboard([['Русский 🇷🇺', "O'zbek 🇺🇿"]]).oneTime().resize()
        );

        logger.info('User started bot', { userId });
    } catch (error) {
        logger.error('Error in /start command', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
});

// ========== COMMAND: /find (Admin only) ==========
bot.command('find', requireAdmin, async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            return ctx.reply('Использование: /find 123456\nПример: /find 245891');
        }

        const searchId = args[1].trim();
        const order = db.getOrderByShortId(searchId);

        if (!order) {
            return ctx.reply(`❌ Заказ #${searchId} не найден или уже завершен.`);
        }

        const orderInfo = `🔍 Найден заказ #${searchId}\n\n` +
            `👤 Клиент: ${sanitizeText(order.name)}\n` +
            `📞 Телефон: ${order.phone}\n` +
            `🔪 Ножей: ${order.knives}\n` +
            `🌐 Язык: ${order.lang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 Узбекский'}\n` +
            `📷 Фото: ${order.photos ? order.photos.length : 0}\n` +
            `📍 Локация: https://www.google.com/maps?q=${order.location.latitude},${order.location.longitude}\n` +
            `🆔 Полный ID: ${order.orderId}`;

        await ctx.reply(orderInfo, Markup.inlineKeyboard([
            Markup.button.callback('Заказ готов', `order_ready:${order.orderId}`)
        ]));

        logger.info('Order found by admin', { orderId: order.orderId, shortId: searchId, userId: ctx.from.id });
    } catch (error) {
        logger.error('Error in /find command', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка при поиске заказа.');
    }
});

// ========== COMMAND: /orders (Admin only) ==========
bot.command('orders', requireAdmin, async (ctx) => {
    try {
        const page = 0; // Default to first page
        const pageSize = 10;

        const totalOrders = db.getActiveOrdersCount();

        if (totalOrders === 0) {
            return ctx.reply('📋 Нет активных заказов');
        }

        const orders = db.getActiveOrders(pageSize, page * pageSize);
        let ordersList = `📋 Активные заказы (${totalOrders}):\n\n`;

        orders.forEach(order => {
            const orderTime = new Date(order.createdAt).toLocaleString('ru-RU', {
                timeZone: 'Asia/Tashkent',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            ordersList += `🆔 #${order.shortId}\n` +
                `👤 ${sanitizeText(order.name)}\n` +
                `📞 ${order.phone}\n` +
                `🔪 ${order.knives} ножей\n` +
                `📷 ${order.photos ? order.photos.length : 0} фото\n` +
                `📅 ${orderTime}\n\n`;
        });

        // Add pagination buttons if needed
        const buttons = [];
        if (totalOrders > pageSize) {
            if (page > 0) {
                buttons.push(Markup.button.callback('◀️ Назад', `orders_page:${page - 1}`));
            }
            if ((page + 1) * pageSize < totalOrders) {
                buttons.push(Markup.button.callback('Вперед ▶️', `orders_page:${page + 1}`));
            }
        }

        if (buttons.length > 0) {
            await ctx.reply(ordersList, Markup.inlineKeyboard([buttons]));
        } else {
            await ctx.reply(ordersList);
        }

        logger.info('Orders list viewed', { userId: ctx.from.id, page, totalOrders });
    } catch (error) {
        logger.error('Error in /orders command', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка при получении списка заказов.');
    }
});

// ========== PAGINATION CALLBACK ==========
bot.action(/orders_page:(\d+)/, requireAdmin, async (ctx) => {
    try {
        const page = parseInt(ctx.match[1]);
        const pageSize = 10;

        const totalOrders = db.getActiveOrdersCount();
        const orders = db.getActiveOrders(pageSize, page * pageSize);

        let ordersList = `📋 Активные заказы (${totalOrders}):\n\n`;

        orders.forEach(order => {
            const orderTime = new Date(order.createdAt).toLocaleString('ru-RU', {
                timeZone: 'Asia/Tashkent',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            ordersList += `🆔 #${order.shortId}\n` +
                `👤 ${sanitizeText(order.name)}\n` +
                `📞 ${order.phone}\n` +
                `🔪 ${order.knives} ножей\n` +
                `📷 ${order.photos ? order.photos.length : 0} фото\n` +
                `📅 ${orderTime}\n\n`;
        });

        const buttons = [];
        if (page > 0) {
            buttons.push(Markup.button.callback('◀️ Назад', `orders_page:${page - 1}`));
        }
        if ((page + 1) * pageSize < totalOrders) {
            buttons.push(Markup.button.callback('Вперед ▶️', `orders_page:${page + 1}`));
        }

        await ctx.editMessageText(ordersList, Markup.inlineKeyboard([buttons]));
        await ctx.answerCbQuery();

        logger.info('Orders pagination', { userId: ctx.from.id, page, totalOrders });
    } catch (error) {
        logger.error('Error in orders pagination', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

// ========== COMMAND: /cancel ==========
bot.command('cancel', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const oldSession = db.getSession(userId);

        if (oldSession) {
            await notifyCancellation(oldSession);
            db.deleteSession(userId);
        }

        await ctx.reply(`${messages.ru.cancel}\n${messages.uz.cancel}`, Markup.removeKeyboard());
        logger.info('User cancelled order', { userId });
    } catch (error) {
        logger.error('Error in /cancel command', error, { userId: ctx.from?.id });
    }
});

// ========== TEXT MESSAGE HANDLER ==========
bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        const userId = ctx.from.id;
        let session = db.getSession(userId);

        // Handle restart button
        if ([messages.ru.restart, messages.uz.restart].includes(text)) {
            if (session) {
                await notifyCancellation(session);
            }
            db.saveSession(userId, { step: 'lang' });
            return ctx.reply(
                `${messages.ru.welcome}\n${messages.uz.welcome}`,
                Markup.keyboard([['Русский 🇷🇺', "O'zbek 🇺🇿"]]).oneTime().resize()
            );
        }

        if (!session) {
            return ctx.reply('Пожалуйста, начните с /start\nIltimos, /start dan boshlang');
        }

        // Language selection
        if (session.step === 'lang') {
            const lang = text.includes('Русский') ? 'ru' : 'uz';
            session.lang = lang;
            session.step = 'name';
            db.saveSession(userId, session);
            return ctx.reply(messages[lang].ask_name, Markup.removeKeyboard());
        }

        // Name input
        if (session.step === 'name') {
            if (!isValidName(text)) {
                return ctx.reply(messages[session.lang].invalid_name);
            }
            session.name = sanitizeText(text.trim());
            session.step = 'phone';
            db.saveSession(userId, session);
            return ctx.reply(
                messages[session.lang].ask_phone,
                Markup.keyboard([
                    [Markup.button.contactRequest('📞 ' + (session.lang === 'ru' ? 'Отправить мой номер' : 'Raqamni yuborish'))]
                ]).oneTime().resize()
            );
        }

        // Phone input
        if (session.step === 'phone') {
            if (!isValidUzbekPhone(text)) {
                return ctx.reply(messages[session.lang].invalid_phone);
            }
            session.phone = normalizeUzbekPhone(text);
            session.step = 'location';
            db.saveSession(userId, session);
            return ctx.reply(
                messages[session.lang].ask_location,
                Markup.keyboard([
                    [Markup.button.locationRequest(messages[session.lang].location_button)]
                ]).oneTime().resize()
            );
        }

        // Knives count
        if (session.step === 'knives') {
            if (!isValidKnivesCount(text)) {
                return ctx.reply(messages[session.lang].invalid_knives);
            }
            session.knives = parseInt(text);
            session.step = 'photo';
            session.photos = [];
            db.saveSession(userId, session);
            return ctx.reply(messages[session.lang].ask_photo, Markup.removeKeyboard());
        }
    } catch (error) {
        logger.error('Error in text handler', error, { userId: ctx.from?.id, text: ctx.message?.text });
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже или используйте /cancel для сброса.');
    }
});

// ========== LOCATION HANDLER ==========
bot.on('location', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session) {
            const lang = 'ru';
            return ctx.reply(messages[lang].session_expired);
        }

        if (session.step === 'location') {
            const location = sanitizeLocation(ctx.message.location);
            if (!location) {
                return ctx.reply(session.lang === 'ru' ?
                    '❌ Некорректная локация. Попробуйте снова.' :
                    '❌ Noto\'g\'ri joylashuv. Qayta urinib ko\'ring.');
            }

            session.location = location;
            session.step = 'knives';
            db.saveSession(userId, session);
            await ctx.reply(messages[session.lang].ask_knives, Markup.removeKeyboard());
        }
    } catch (error) {
        logger.error('Error in location handler', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
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

        const phone = ctx.message.contact.phone_number;
        if (!isValidUzbekPhone(phone)) {
            return ctx.reply(messages[session.lang].invalid_phone);
        }

        session.phone = normalizeUzbekPhone(phone);
        session.step = 'location';
        db.saveSession(userId, session);
        await ctx.reply(
            messages[session.lang].ask_location,
            Markup.keyboard([
                [Markup.button.locationRequest(messages[session.lang].location_button)]
            ]).oneTime().resize()
        );
    } catch (error) {
        logger.error('Error in contact handler', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
});

// ========== PHOTO HANDLER (Fixed race condition) ==========
bot.on('photo', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return;
        }

        // Add photo to array
        if (!session.photos) session.photos = [];
        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        session.photos.push(photoId);

        // Save immediately to prevent race conditions
        db.saveSession(userId, session);

        const count = session.photos.length;
        const text = messages[session.lang].photo_received(count);
        const keyboard = buildPhotoManagementKeyboard(session.lang, true);

        // Send new message with buttons
        const msg = await ctx.reply(text, keyboard);
        session.lastPhotoMessageId = msg.message_id;
        db.saveSession(userId, session);

        logger.info('Photo added', { userId, photoCount: count });
    } catch (error) {
        logger.error('Error in photo handler', error, { userId: ctx.from?.id });
        await ctx.reply('❌ Произошла ошибка при загрузке фото. Попробуйте снова.');
    }
});

// ========== PHOTO ACTIONS ==========
bot.action('photos_done', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return ctx.answerCbQuery(messages.ru.session_expired);
        }

        if (!session.photos || session.photos.length === 0) {
            return ctx.answerCbQuery(messages[session.lang].at_least_one_photo);
        }

        // Create order in database
        const { orderId, shortId } = db.createOrder(userId, session);

        // Send confirmation to user
        const successMessage = messages[session.lang].order_sent(session.photos.length);
        await ctx.reply(successMessage);

        // Send order summary to user
        await ctx.reply(
            messages[session.lang].summary(session),
            Markup.inlineKeyboard([
                Markup.button.callback(
                    session.lang === 'ru' ? 'Отменить заказ' : 'Buyurtmani bekor qilish',
                    `cancel_order:${orderId}`
                ),
                Markup.button.callback(
                    messages[session.lang].restart,
                    'restart'
                )
            ])
        );

        // Send to admin group
        await sendOrderToGroup(session, orderId, shortId);

        // Clear session
        db.deleteSession(userId);
        await ctx.answerCbQuery();

        logger.info('Order completed', { userId, orderId, shortId, photoCount: session.photos.length });
    } catch (error) {
        logger.error('Error completing order', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка при отправке заказа');
        await ctx.reply('❌ Произошла ошибка при отправке заказа. Попробуйте позже или обратитесь в поддержку.');
    }
});

bot.action('photos_add', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return ctx.answerCbQuery(messages.ru.session_expired);
        }

        const count = session.photos ? session.photos.length : 0;
        const text = messages[session.lang].photo_received(count);
        const keyboard = buildPhotoManagementKeyboard(session.lang, count > 0);

        try {
            await ctx.editMessageText(text, keyboard);
        } catch (e) {
            // Message unchanged, ignore
        }

        const addPhotoMessage = session.lang === 'ru'
            ? '📸 Отправьте ещё одно фото или несколько фото'
            : '📸 Yana bir yoki bir nechta foto yuboring';
        await ctx.reply(addPhotoMessage, keyboard);
        await ctx.answerCbQuery();
    } catch (error) {
        logger.error('Error in photos_add', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action('photos_delete', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo' || !session.photos || session.photos.length === 0) {
            const lang = session?.lang || 'ru';
            return ctx.answerCbQuery(messages[lang].no_photos);
        }

        const buttons = session.photos.map((_, index) =>
            Markup.button.callback(`Фото ${index + 1}`, `delete_photo:${index}`)
        );
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) {
            keyboard.push(buttons.slice(i, i + 2));
        }
        keyboard.push([Markup.button.callback('⬅️ Назад', 'photos_back')]);

        await ctx.editMessageText(
            messages[session.lang].select_photo_delete,
            Markup.inlineKeyboard(keyboard)
        );
        await ctx.answerCbQuery();
    } catch (error) {
        logger.error('Error in photos_delete', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action(/delete_photo:(\d+)/, async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);
        const photoIndex = parseInt(ctx.match[1]);

        if (!session || session.step !== 'photo' || !session.photos || photoIndex >= session.photos.length) {
            return ctx.answerCbQuery('Ошибка удаления фото');
        }

        session.photos.splice(photoIndex, 1);
        db.saveSession(userId, session);

        const count = session.photos.length;
        const keyboard = buildPhotoManagementKeyboard(session.lang, count > 0);

        await ctx.editMessageText(
            count > 0 ? messages[session.lang].photo_received(count) : messages[session.lang].ask_photo,
            keyboard
        );
        await ctx.answerCbQuery(messages[session.lang].photo_deleted);

        logger.info('Photo deleted', { userId, photoIndex, remainingCount: count });
    } catch (error) {
        logger.error('Error deleting photo', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action('photos_back', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return ctx.answerCbQuery(messages.ru.session_expired);
        }

        const count = session.photos ? session.photos.length : 0;
        const keyboard = buildPhotoManagementKeyboard(session.lang, count > 0);

        await ctx.editMessageText(
            count > 0 ? messages[session.lang].photo_received(count) : messages[session.lang].ask_photo,
            keyboard
        );
        await ctx.answerCbQuery();
    } catch (error) {
        logger.error('Error in photos_back', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action('photos_view', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo' || !session.photos || session.photos.length === 0) {
            return ctx.answerCbQuery('Нет фотографий для просмотра');
        }

        const viewMessage = session.lang === 'ru'
            ? `📷 Показываю все ваши фото (${session.photos.length}):`
            : `📷 Barcha fotolaringizni ko'rsatyapman (${session.photos.length}):`;
        await ctx.reply(viewMessage);

        // Use media groups if possible (up to 10 photos at once)
        const photos = session.photos;
        for (let i = 0; i < photos.length; i += MEDIA_GROUP_MAX_SIZE) {
            const chunk = photos.slice(i, i + MEDIA_GROUP_MAX_SIZE);
            if (chunk.length === 1) {
                await ctx.replyWithPhoto(chunk[0]);
            } else {
                await ctx.replyWithMediaGroup(
                    chunk.map(photoId => ({ type: 'photo', media: photoId }))
                );
            }
        }

        const controlKeyboard = buildPhotoManagementKeyboard(session.lang, true);
        const controlMessage = session.lang === 'ru'
            ? `📷 Все фото показаны. Выберите действие:`
            : `📷 Barcha fotolar ko'rsatildi. Amalni tanlang:`;

        await ctx.reply(controlMessage, controlKeyboard);
        await ctx.answerCbQuery();

        logger.info('Photos viewed', { userId, photoCount: photos.length });
    } catch (error) {
        logger.error('Error viewing photos', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action('photos_delete_all', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo' || !session.photos || session.photos.length === 0) {
            const lang = session?.lang || 'ru';
            return ctx.answerCbQuery(messages[lang].no_photos);
        }

        const confirmKeyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback(messages[session.lang].delete_all_yes, 'confirm_delete_all_yes'),
                Markup.button.callback(messages[session.lang].delete_all_no, 'confirm_delete_all_no')
            ]
        ]);

        await ctx.reply(messages[session.lang].confirm_delete_all, confirmKeyboard);
        await ctx.answerCbQuery();
    } catch (error) {
        logger.error('Error in photos_delete_all', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action('confirm_delete_all_yes', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return ctx.answerCbQuery(messages.ru.session_expired);
        }

        const photoCount = session.photos ? session.photos.length : 0;
        session.photos = [];
        db.saveSession(userId, session);

        const keyboard = buildPhotoManagementKeyboard(session.lang, false);
        const deleteAllMessage = session.lang === 'ru'
            ? `🗑️ Все фото удалены (${photoCount}). Добавьте хотя бы одно фото для продолжения`
            : `🗑️ Barcha fotolar o'chirildi (${photoCount}). Davom etish uchun kamida bitta foto qo'shing`;

        await ctx.reply(deleteAllMessage, keyboard);
        await ctx.answerCbQuery(messages[session.lang].all_photos_deleted);

        logger.info('All photos deleted', { userId, deletedCount: photoCount });
    } catch (error) {
        logger.error('Error confirming delete all', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

bot.action('confirm_delete_all_no', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = db.getSession(userId);

        if (!session || session.step !== 'photo') {
            return ctx.answerCbQuery(messages.ru.session_expired);
        }

        const count = session.photos ? session.photos.length : 0;
        const keyboard = buildPhotoManagementKeyboard(session.lang, count > 0);

        const cancelMessage = session.lang === 'ru'
            ? `❌ Удаление отменено. У вас ${count} фото`
            : `❌ O'chirish bekor qilindi. Sizda ${count} ta foto bor`;

        await ctx.reply(cancelMessage, keyboard);
        await ctx.answerCbQuery();
    } catch (error) {
        logger.error('Error in confirm_delete_all_no', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

// ========== ORDER CANCELLATION BY USER ==========
bot.action(/cancel_order:(.+)/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.getOrder(orderId);

        if (!order) {
            return ctx.answerCbQuery('Заказ уже отменён или не найден.');
        }

        if (String(order.creatorId) !== String(ctx.from.id)) {
            return ctx.answerCbQuery('Вы не можете отменить этот заказ.');
        }

        // Archive as cancelled
        db.cancelOrder(orderId);

        // Notify admin group
        const cancelMessage = order.lang === 'ru'
            ? `❌ Заказ отменён пользователем.\n\n👤 ${sanitizeText(order.name)}\n📞 ${order.phone}`
            : `❌ Buyurtma foydalanuvchi tomonidan bekor qilindi.\n\n👤 ${sanitizeText(order.name)}\n📞 ${order.phone}`;

        try {
            await bot.telegram.sendMessage(config.groupChatId, cancelMessage);
        } catch (error) {
            logger.error('Failed to send cancellation to group', error, { orderId });
        }

        try {
            await ctx.editMessageText(
                order.lang === 'ru' ? 'Заказ отменён.' : 'Buyurtma bekor qilindi.',
                Markup.inlineKeyboard([
                    Markup.button.callback(
                        order.lang === 'ru' ? '🔄 Начать заново' : '🔄 Qayta boshlash',
                        'restart'
                    )
                ])
            );
        } catch (e) {
            // Message already edited
        }

        await ctx.answerCbQuery('Заказ отменён.');
        logger.info('Order cancelled by user', { orderId, userId: ctx.from.id });
    } catch (error) {
        logger.error('Error cancelling order', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

// ========== ORDER COMPLETION BY ADMIN ==========
bot.action(/order_ready:(.+)/, async (ctx) => {
    try {
        const orderId = ctx.match[1];
        const order = db.getOrder(orderId);

        if (!order) {
            return ctx.answerCbQuery('Заказ уже обработан или не найден.');
        }

        // Archive as completed
        db.completeOrder(orderId, 'completed');

        const summaryText = messages[order.lang].summary(order);
        const newText = `${summaryText}\n\n${order.lang === 'ru' ? 'Заказ готов.' : 'Buyurtma tayyor.'}`;

        try {
            await ctx.editMessageText(newText);
        } catch (e) {
            logger.error('Error editing message', e);
        }

        await ctx.answerCbQuery(order.lang === 'ru' ? 'Заказ отмечен как готов.' : 'Buyurtma tayyor deb belgilandi.');
        logger.info('Order marked ready by admin', { orderId, adminId: ctx.from.id });
    } catch (error) {
        logger.error('Error marking order ready', error, { userId: ctx.from?.id });
        await ctx.answerCbQuery('❌ Ошибка');
    }
});

// ========== RESTART ACTION ==========
bot.action('restart', async (ctx) => {
    try {
        const userId = ctx.from.id;

        // Cancel active order if exists
        const activeOrder = db.getUserActiveOrder(userId);
        if (activeOrder) {
            db.cancelOrder(activeOrder.orderId);

            const cancelMessage = activeOrder.lang === 'ru'
                ? `❌ Заказ отменён пользователем через повторный запуск.\n\n👤 ${sanitizeText(activeOrder.name)}\n📞 ${activeOrder.phone}`
                : `❌ Buyurtma foydalanuvchi tomonidan qayta boshlash tufayli bekor qilindi.\n\n👤 ${sanitizeText(activeOrder.name)}\n📞 ${activeOrder.phone}`;

            try {
                await bot.telegram.sendMessage(config.groupChatId, cancelMessage);
            } catch (error) {
                logger.error('Failed to send restart cancellation to group', error);
            }
        }

        // Start new session
        db.saveSession(userId, { step: 'lang' });
        await ctx.answerCbQuery();

        try {
            await ctx.deleteMessage();
        } catch (e) {
            // Message can't be deleted
        }

        await ctx.reply(
            `${messages.ru.welcome}\n${messages.uz.welcome}`,
            Markup.keyboard([['Русский 🇷🇺', "O'zbek 🇺🇿"]]).oneTime().resize()
        );

        logger.info('User restarted', { userId });
    } catch (error) {
        logger.error('Error in restart action', error, { userId: ctx.from?.id });
    }
});

// ========== SESSION CLEANUP TASK ==========
setInterval(() => {
    try {
        const deletedSessions = db.cleanExpiredSessions(SESSION_TIMEOUT_MS);

        if (deletedSessions > 0) {
            logger.info('Cleanup completed', { deletedSessions });
        }
    } catch (error) {
        logger.error('Error in cleanup task', error);
    }
}, CLEANUP_INTERVAL_MS);

// ========== ERROR HANDLERS ==========
bot.catch((error, ctx) => {
    logger.error('Bot error', error, {
        userId: ctx.from?.id,
        updateType: ctx.updateType
    });
});

// ========== GRACEFUL SHUTDOWN ==========
process.once('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    bot.stop('SIGINT');
    db.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    bot.stop('SIGTERM');
    db.close();
    process.exit(0);
});

// ========== BOT LAUNCH ==========
bot.launch()
    .then(() => {
        const stats = db.getStats();
        logger.info('Bot started successfully', stats);
        console.log('🤖 Бот запущен...');
        console.log(`📊 Статистика: ${stats.activeSessions} сессий, ${stats.activeOrders} активных заказов, ${stats.completedOrders} завершённых`);
    })
    .catch((error) => {
        logger.error('Failed to start bot', error);
        process.exit(1);
    });
