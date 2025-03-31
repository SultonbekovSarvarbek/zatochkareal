require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);

const sessions = {};
const orders = {}; // Объект для хранения заказов

function notifyCancellation(ctx, session) {
    if (!session || !session.name || !session.phone) return;
    const lang = session.lang || 'ru';
    const cancelMessage = `❌ Заказ отменён пользователем.\n\n👤 ${session.name}\n📞 ${session.phone}`;
    const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
    bot.telegram.sendMessage(GROUP_CHAT_ID, cancelMessage);
}

const messages = {
    ru: {
        welcome: 'Здравствуйте! Пожалуйста, выберите язык:',
        ask_name: 'Введите ваше имя:',
        ask_phone: 'Введите номер телефона (в формате +998XXXXXXXXX):',
        ask_location: 'Отправьте вашу локацию:',
        ask_knives: 'Сколько ножей вы хотите заточить? (1–50)',
        summary: (data) => `✅ Заявка принята!\n\n👤 Имя: ${data.name}\n📞 Телефон: ${data.phone}\n📍 Локация: https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}\n🔪 Кол-во ножей: ${data.knives}`,
        cancel: 'Заявка отменена. Чтобы начать заново, отправьте /start',
        location_button: 'Отправить локацию',
        restart: '🔄 Начать заново',
        invalid_phone: '❌ Неверный номер телефона. Введите номер в формате +998XXXXXXXXX',
        invalid_knives: '❌ Введите количество ножей (число от 1 до 50)',
        only_text: '❌ Ошибка.',
    },
    uz: {
        welcome: 'Salom! Iltimos, tilni tanlang:',
        ask_name: 'Ismingizni kiriting:',
        ask_phone: 'Telefon raqamingizni kiriting (+998XXXXXXXXX formatida):',
        ask_location: 'Iltimos, joylashuvingizni yuboring:',
        ask_knives: 'Nechta pichoqni charxlatmoqchisiz? (1–50)',
        summary: (data) => `✅ Buyurtma qabul qilindi!\n\n👤 Ism: ${data.name}\n📞 Telefon: ${data.phone}\n📍 Joylashuv: https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}\n🔪 Pichoqlar soni: ${data.knives}`,
        cancel: 'Buyurtma bekor qilindi. Qayta boshlash uchun /start ni yuboring',
        location_button: 'Joylashuvni yuborish',
        restart: '🔄 Qayta boshlаsh',
        invalid_phone: '❌ Telefon raqami noto‘g‘ri. +998XXXXXXXXX formatida kiriting.',
        invalid_knives: '❌ Pichoqlar soni noto‘g‘ri (1 dan 50 gacha).',
        only_text: '❌ Iltimos, faqat matn yoki joylashuv yuboring.',
    }
};

// Защита от неразрешённых типов сообщений
bot.on('message', (ctx, next) => {
    const msg = ctx.message;
    const allowed = msg.text || msg.location || msg.contact;
    if (allowed) return next();

    const lang = sessions[ctx.from.id]?.lang || 'ru';
    const reply = messages[lang]?.only_text || '❌ Ошибка.';
    return ctx.reply(reply);
});

// Команда /start
bot.start((ctx) => {
    const oldSession = sessions[ctx.from.id];
    notifyCancellation(ctx, oldSession);
    sessions[ctx.from.id] = { step: 'lang' };
    ctx.reply(
        `${messages.ru.welcome}\n${messages.uz.welcome}`,
        Markup.keyboard([['Русский 🇷🇺', "O‘zbek 🇺🇿"]]).oneTime().resize()
    );
});

// Команда /cancel
bot.command('cancel', (ctx) => {
    const oldSession = sessions[ctx.from.id];
    notifyCancellation(ctx, oldSession);
    sessions[ctx.from.id] = null;
    ctx.reply(`${messages.ru.cancel}\n${messages.uz.cancel}`, Markup.removeKeyboard());
});

// Обработка текстовых сообщений
bot.on('text', (ctx) => {
    const text = ctx.message.text.trim();
    let session = sessions[ctx.from.id] || {};

    // Кнопка "Начать заново"
    if ([messages.ru.restart, messages.uz.restart].includes(text)) {
        sessions[ctx.from.id] = { step: 'lang' };
        return ctx.reply(
            `${messages.ru.welcome}\n${messages.uz.welcome}`,
            Markup.keyboard([['Русский 🇷🇺', "O‘zbek 🇺🇿"]]).oneTime().resize()
        );
    }

    // Выбор языка
    if (session.step === 'lang') {
        const lang = text.includes('Русский') ? 'ru' : 'uz';
        session.lang = lang;
        session.step = 'name';
        sessions[ctx.from.id] = session;
        return ctx.reply(messages[lang].ask_name, Markup.removeKeyboard());
    }

    // Имя
    if (session.step === 'name') {
        session.name = text;
        session.step = 'phone';
        return ctx.reply(
            messages[session.lang].ask_phone,
            Markup.keyboard([
                [Markup.button.contactRequest('📞 ' + (session.lang === 'ru' ? 'Отправить мой номер' : 'Raqamni yuborish'))]
            ]).oneTime().resize()
        );
    }

    // Телефон
    if (session.step === 'phone') {
        const phone = text.replace(/\s+/g, '');
        const isValid = /^(\+998|998)\d{9}$/.test(phone);
        if (!isValid) {
            return ctx.reply(messages[session.lang].invalid_phone);
        }
        session.phone = phone;
        session.step = 'location';
        return ctx.reply(
            messages[session.lang].ask_location,
            Markup.keyboard([
                [Markup.button.locationRequest(messages[session.lang].location_button)]
            ]).oneTime().resize()
        );
    }

    // Количество ножей и отправка заказа
    if (session.step === 'knives') {
        const num = parseInt(text);
        if (isNaN(num) || num < 1 || num > 50) {
            return ctx.reply(messages[session.lang].invalid_knives);
        }
        session.knives = num;
        // Генерируем уникальный идентификатор заказа и сохраняем данные
        const orderId = `${ctx.from.id}_${Date.now()}`;
        session.orderId = orderId;
        session.creatorId = ctx.from.id;
        orders[orderId] = { ...session };

        // Отправляем пользователю сообщение с суммарной информацией и inline-кнопками
        ctx.reply(
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

        // Отправляем сообщение в группу (админку) с кнопкой "Заказ готов"
        const groupMessage = messages[session.lang].summary(session);
        const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
        bot.telegram.sendMessage(
            GROUP_CHAT_ID,
            groupMessage,
            Markup.inlineKeyboard([
                Markup.button.callback(
                    session.lang === 'ru' ? 'Заказ готов' : 'Buyurtma tayyor',
                    `order_ready:${orderId}`
                )
            ])
        );

        // Очищаем сессию пользователя, так как заказ теперь хранится в orders
        sessions[ctx.from.id] = null;
    }
});

// Обработка локации
bot.on('location', (ctx) => {
    const session = sessions[ctx.from.id];
    if (session?.step === 'location') {
        session.location = ctx.message.location;
        session.step = 'knives';
        ctx.reply(messages[session.lang].ask_knives, Markup.removeKeyboard());
    }
});

// Обработка контакта
bot.on('contact', (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'phone') return;
    const phone = ctx.message.contact.phone_number;
    const cleaned = phone.replace(/\D/g, '');
    if (!/^998\d{9}$/.test(cleaned)) {
        return ctx.reply(messages[session.lang].invalid_phone);
    }
    session.phone = '+' + cleaned;
    session.step = 'location';
    ctx.reply(
        messages[session.lang].ask_location,
        Markup.keyboard([
            [Markup.button.locationRequest(messages[session.lang].location_button)]
        ]).oneTime().resize()
    );
});

// Callback для отмены заказа пользователем
bot.action(/cancel_order:(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = orders[orderId];
    if (!order) {
        return ctx.answerCbQuery('Заказ уже отменён или не найден.');
    }
    if (String(order.creatorId) !== String(ctx.from.id)) {
        return ctx.answerCbQuery('Вы не можете отменить этот заказ.');
    }
    // Отправляем уведомление в группу
    const cancelMessage = order.lang === 'ru'
        ? `❌ Заказ отменён пользователем.\n\n👤 ${order.name}\n📞 ${order.phone}`
        : `❌ Buyurtma foydalanuvchi tomonidan bekor qilindi.\n\n👤 ${order.name}\n📞 ${order.phone}`;
    await bot.telegram.sendMessage(process.env.GROUP_CHAT_ID, cancelMessage);
    delete orders[orderId];
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
        // Если сообщение уже изменено – ничего не делаем
    }
    ctx.answerCbQuery('Заказ отменён.');
});

// Callback для отметки заказа как готового администратором
bot.action(/order_ready:(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = orders[orderId];
    if (!order) {
        return ctx.answerCbQuery('Заказ уже обработан или не найден.');
    }
    // Формируем текст с сохранением информации заказа
    const summaryText = messages[order.lang].summary(order);
    const newText = `${summaryText}\n\n${order.lang === 'ru' ? 'Заказ готов.' : 'Buyurtma tayyor.'}`;
    try {
        await ctx.editMessageText(newText);
    } catch (e) {
        console.error('Error editing order_ready message:', e);
    }
    ctx.answerCbQuery(order.lang === 'ru' ? 'Заказ отмечен как готов.' : 'Buyurtma tayyor deb belgilandi.');
    // Удаляем заказ из orders
    delete orders[orderId];
});

// Callback для кнопки "Начать заново"
bot.action('restart', async (ctx) => {
    try {
        // Ищем активный заказ для данного пользователя
        let activeOrderId = null;
        for (const id in orders) {
            if (String(orders[id].creatorId) === String(ctx.from.id)) {
                activeOrderId = id;
                break;
            }
        }
        if (activeOrderId) {
            const order = orders[activeOrderId];
            // Отправляем уведомление в группу о том, что заказ отменён
            const cancelMessage = order.lang === 'ru'
                ? `❌ Заказ отменён пользователем через повторный запуск.\n\n👤 ${order.name}\n📞 ${order.phone}`
                : `❌ Buyurtma foydalanuvchi tomonidan qayta boshlash tufayli bekor qilindi.\n\n👤 ${order.name}\n📞 ${order.phone}`;
            await bot.telegram.sendMessage(process.env.GROUP_CHAT_ID, cancelMessage);
            // Удаляем заказ из orders
            delete orders[activeOrderId];
        }
        // Обновляем сессию для нового заказа
        sessions[ctx.from.id] = { step: 'lang' };
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.error('Error deleting message:', e);
        }
        await ctx.reply(
            `${messages.ru.welcome}\n${messages.uz.welcome}`,
            Markup.keyboard([['Русский 🇷🇺', "O‘zbek 🇺🇿"]]).oneTime().resize()
        );
    } catch (error) {
        console.error('Error in restart callback:', error);
    }
});

bot.launch();
console.log('🤖 Бот запущен...');