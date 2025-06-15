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
        summary: (data) => `✅ Заявка принята! Наш оператор вам перезвонит озвучить цену.\n\n👤 Имя: ${data.name}\n📞 Телефон: ${data.phone}\n📍 Локация: https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}\n🔪 Кол-во ножей: ${data.knives}${data.photos && data.photos.length > 0 ? `\n📷 Фото: ${data.photos.length}` : ''}`,
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
        summary: (data) => `✅ Buyurtma qabul qilindi! Bizning operator sizga qo\'ng\'iroq qilib narxni aytadi.\n\n👤 Ism: ${data.name}\n📞 Telefon: ${data.phone}\n📍 Joylashuv: https://www.google.com/maps?q=${data.location.latitude},${data.location.longitude}\n🔪 Pichoqlar soni: ${data.knives}${data.photos && data.photos.length > 0 ? `\n📷 Foto: ${data.photos.length}` : ''}`,
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
    const allowed = msg.text || msg.location || msg.contact || msg.photo;
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

// Команда для поиска заказа по короткому ID (только для админов)
bot.command('find', (ctx) => {
    const chatId = ctx.chat.id;
    const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
    
    // Проверяем, что команда выполняется в админ группе
    if (String(chatId) !== String(GROUP_CHAT_ID)) {
        return; // Игнорируем команду если не в админ группе
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('Использование: /find 123456\nПример: /find 245891');
    }
    
    const searchId = args[1];
    let foundOrder = null;
    
    // Ищем заказ по короткому ID
    for (const orderId in orders) {
        const shortId = orderId.split('_')[1].slice(-6);
        if (shortId === searchId) {
            foundOrder = { id: orderId, ...orders[orderId] };
            break;
        }
    }
    
    if (!foundOrder) {
        return ctx.reply(`❌ Заказ #${searchId} не найден или уже завершен.`);
    }
    
    // Отправляем информацию о найденном заказе
    const orderInfo = `🔍 Найден заказ #${searchId}\n\n` +
        `👤 Клиент: ${foundOrder.name}\n` +
        `📞 Телефон: ${foundOrder.phone}\n` +
        `🔪 Ножей: ${foundOrder.knives}\n` +
        `🌐 Язык: ${foundOrder.lang === 'ru' ? '🇷🇺 Русский' : '🇺🇿 Узбекский'}\n` +
        `📷 Фото: ${foundOrder.photos ? foundOrder.photos.length : 0}\n` +
        `📍 Локация: https://www.google.com/maps?q=${foundOrder.location.latitude},${foundOrder.location.longitude}\n` +
        `🆔 Полный ID: ${foundOrder.id}`;
    
    ctx.reply(orderInfo, Markup.inlineKeyboard([
        Markup.button.callback('Заказ готов', `order_ready:${foundOrder.id}`)
    ]));
});

// Команда для просмотра всех активных заказов (только для админов)
bot.command('orders', (ctx) => {
    const chatId = ctx.chat.id;
    const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
    
    // Проверяем, что команда выполняется в админ группе
    if (String(chatId) !== String(GROUP_CHAT_ID)) {
        return; // Игнорируем команду если не в админ группе
    }
    
    const activeOrders = Object.keys(orders);
    
    if (activeOrders.length === 0) {
        return ctx.reply('📋 Нет активных заказов');
    }
    
    let ordersList = `📋 Активные заказы (${activeOrders.length}):\n\n`;
    
    activeOrders.forEach(orderId => {
        const order = orders[orderId];
        const shortId = orderId.split('_')[1].slice(-6);
        const orderTime = new Date(parseInt(orderId.split('_')[1])).toLocaleString('ru-RU', { 
            timeZone: 'Asia/Tashkent',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        ordersList += `🆔 #${shortId}\n` +
            `👤 ${order.name}\n` +
            `📞 ${order.phone}\n` +
            `🔪 ${order.knives} ножей\n` +
            `📷 ${order.photos ? order.photos.length : 0} фото\n` +
            `📅 ${orderTime}\n\n`;
    });
    
    ctx.reply(ordersList);
});

// Команда /cancel
bot.command('cancel', (ctx) => {
    const oldSession = sessions[ctx.from.id];
    notifyCancellation(ctx, oldSession);
    // Очищаем таймер если есть
    if (sessions[ctx.from.id]?.photoTimer) {
        clearTimeout(sessions[ctx.from.id].photoTimer);
    }
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

    // Количество ножей
    if (session.step === 'knives') {
        const num = parseInt(text);
        if (isNaN(num) || num < 1 || num > 50) {
            return ctx.reply(messages[session.lang].invalid_knives);
        }
        session.knives = num;
        session.step = 'photo';
        session.photos = [];
        return ctx.reply(messages[session.lang].ask_photo, Markup.removeKeyboard());
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

// Обработка фотографий
bot.on('photo', (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo') return;

    console.log(`Photo received from user ${ctx.from.id}, current photos count: ${session.photos ? session.photos.length : 0}`);

    // Очищаем старый таймер если есть
    if (session.photoTimer) {
        clearTimeout(session.photoTimer);
    }

    // Добавляем фото в массив
    if (!session.photos) session.photos = [];
    session.photos.push(ctx.message.photo[ctx.message.photo.length - 1].file_id);

    // Функция для отправки сообщения с кнопками внизу
    const sendPhotoMessage = async () => {
        try {
            const count = session.photos.length;
            const text = messages[session.lang].photo_received(count);
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(messages[session.lang].photos_done, 'photos_done')],
                [
                    Markup.button.callback(messages[session.lang].photos_add, 'photos_add'),
                    Markup.button.callback(messages[session.lang].photos_view, 'photos_view')
                ],
                [
                    Markup.button.callback(messages[session.lang].photos_delete, 'photos_delete'),
                    Markup.button.callback(messages[session.lang].photos_delete_all, 'photos_delete_all')
                ]
            ]);

            console.log(`Sending photo message for user ${ctx.from.id}, photos count: ${count}`);

            // Всегда отправляем новое сообщение внизу для лучшего UX
            const msg = await ctx.reply(text, keyboard);
            session.lastPhotoMessageId = msg.message_id;
            
            console.log(`Sent new message with ID: ${msg.message_id}`);
        } catch (error) {
            console.error('Error in sendPhotoMessage:', error);
        }
    };

    // Устанавливаем таймер для обработки bulk upload
    session.photoTimer = setTimeout(sendPhotoMessage, 500);
});

// Callback для кнопок работы с фотографиями
bot.action('photos_done', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo') {
        return ctx.answerCbQuery('Сессия истекла');
    }

    // Проверяем наличие фотографий
    if (!session.photos || session.photos.length === 0) {
        return ctx.answerCbQuery(
            session.lang === 'ru' 
                ? 'Необходимо добавить хотя бы одно фото' 
                : 'Kamida bitta foto qo\'shish kerak'
        );
    }

    // Очищаем таймер
    if (session.photoTimer) {
        clearTimeout(session.photoTimer);
    }

    // Генерируем уникальный идентификатор заказа и сохраняем данные
    const orderId = `${ctx.from.id}_${Date.now()}`;
    session.orderId = orderId;
    session.creatorId = ctx.from.id;
    orders[orderId] = { ...session };

    // Отправляем уведомление об успешной отправке
    const successMessage = session.lang === 'ru' 
        ? `✅ Заказ успешно отправлен с ${session.photos.length} фото!`
        : `✅ Buyurtma ${session.photos.length} ta foto bilan muvaffaqiyatli yuborildi!`;
    await ctx.reply(successMessage);

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
    
    // Создаем короткий ID для удобства админов
    const shortId = orderId.split('_')[1].slice(-6); // Последние 6 цифр timestamp
    
    // Отправляем все фотографии в группу с подписями
    if (session.photos && session.photos.length > 0) {
        
        for (let i = 0; i < session.photos.length; i++) {
            const photoId = session.photos[i];
            const photoCaption = `📷 Фото ${i + 1}/${session.photos.length}\n` +
                `🆔 Заказ #${shortId}\n` +
                `👤 ${session.name}\n` +
                `📞 ${session.phone}\n` +
                `🔪 Ножей: ${session.knives}\n` +
                `🌐 ${session.lang === 'ru' ? '🇷🇺 RU' : '🇺🇿 UZ'}\n` +
                `📅 ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })}\n` +
                `\n💡 ID для поиска: ${orderId}`;
            
            await bot.telegram.sendPhoto(GROUP_CHAT_ID, photoId, {
                caption: photoCaption
            });
        }
    }
    
    // Добавляем короткий ID к сообщению заказа
    const enhancedGroupMessage = `🆔 Заказ #${shortId}\n\n${groupMessage}`;
    
    bot.telegram.sendMessage(
        GROUP_CHAT_ID,
        enhancedGroupMessage,
        Markup.inlineKeyboard([
            Markup.button.callback(
                session.lang === 'ru' ? 'Заказ готов' : 'Buyurtma tayyor',
                `order_ready:${orderId}`
            )
        ])
    );

    // Очищаем сессию пользователя
    sessions[ctx.from.id] = null;
    ctx.answerCbQuery();
});

bot.action('photos_add', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo') {
        return ctx.answerCbQuery('Сессия истекла');
    }

    // Обновляем сообщение с полной клавиатурой
    const count = session.photos ? session.photos.length : 0;
    const text = messages[session.lang].photo_received(count);
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(messages[session.lang].photos_done, 'photos_done')],
        [
            Markup.button.callback(messages[session.lang].photos_add, 'photos_add'),
            Markup.button.callback(messages[session.lang].photos_view, 'photos_view')
        ],
        [
            Markup.button.callback(messages[session.lang].photos_delete, 'photos_delete'),
            Markup.button.callback(messages[session.lang].photos_delete_all, 'photos_delete_all')
        ]
    ]);
    
    try {
        await ctx.editMessageText(text, keyboard);
        // Обновляем lastPhotoMessageId на текущее сообщение
        session.lastPhotoMessageId = ctx.callbackQuery.message.message_id;
    } catch (error) {
        // Игнорируем ошибку если сообщение не изменилось
    }
    
    // Отправляем уведомление пользователю с кнопками
    const addPhotoMessage = session.lang === 'ru' 
        ? '📸 Отправьте ещё одно фото или несколько фото'
        : '📸 Yana bir yoki bir nechta foto yuboring';
    await ctx.reply(addPhotoMessage, keyboard);
    
    ctx.answerCbQuery();
});

bot.action('photos_delete', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo' || !session.photos || session.photos.length === 0) {
        return ctx.answerCbQuery(messages[session.lang].no_photos);
    }

    const buttons = session.photos.map((_, index) => 
        Markup.button.callback(`Фото ${index + 1}`, `delete_photo:${index}`)
    );
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
    }
    keyboard.push([Markup.button.callback('⬅️ Назад', 'photos_back')]);

    ctx.editMessageText(
        messages[session.lang].select_photo_delete,
        Markup.inlineKeyboard(keyboard)
    );
    
    // Отправляем уведомление пользователю с кнопками навигации
    const selectMessage = session.lang === 'ru' 
        ? `🗑️ Выберите фото для удаления (всего: ${session.photos.length})`
        : `🗑️ O'chirish uchun fotoni tanlang (jami: ${session.photos.length})`;
    
    const backKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Назад к фото', 'photos_back')]
    ]);
    await ctx.reply(selectMessage, backKeyboard);
    
    ctx.answerCbQuery();
});

bot.action(/delete_photo:(\d+)/, async (ctx) => {
    const session = sessions[ctx.from.id];
    const photoIndex = parseInt(ctx.match[1]);
    
    if (!session || session.step !== 'photo' || !session.photos || photoIndex >= session.photos.length) {
        return ctx.answerCbQuery('Ошибка удаления фото');
    }

    session.photos.splice(photoIndex, 1);
    
    const count = session.photos.length;
    let keyboard;
    
    if (count === 0) {
        // Если фото нет, показываем только кнопку "Добавить фото"
        keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(messages[session.lang].photos_add, 'photos_add')]
        ]);
    } else {
        // Если фото есть, показываем все кнопки
        keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(messages[session.lang].photos_done, 'photos_done')],
            [
                Markup.button.callback(messages[session.lang].photos_add, 'photos_add'),
                Markup.button.callback(messages[session.lang].photos_view, 'photos_view')
            ],
            [
                Markup.button.callback(messages[session.lang].photos_delete, 'photos_delete'),
                Markup.button.callback(messages[session.lang].photos_delete_all, 'photos_delete_all')
            ]
        ]);
    }

    ctx.editMessageText(
        count > 0 ? messages[session.lang].photo_received(count) : messages[session.lang].ask_photo,
        keyboard
    );
    
    // Отправляем уведомление пользователю с кнопками
    const deleteMessage = session.lang === 'ru' 
        ? `🗑️ Фото удалено. ${count > 0 ? `Осталось фото: ${count}` : 'Добавьте хотя бы одно фото для продолжения'}`
        : `🗑️ Foto o'chirildi. ${count > 0 ? `Qolgan fotolar: ${count}` : 'Davom etish uchun kamida bitta foto qo\'shing'}`;
    await ctx.reply(deleteMessage, keyboard);
    
    ctx.answerCbQuery();
});

bot.action('photos_back', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo') {
        return ctx.answerCbQuery('Сессия истекла');
    }

    const count = session.photos ? session.photos.length : 0;
    let keyboard;
    
    if (count === 0) {
        // Если фото нет, показываем только кнопку "Добавить фото"
        keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(messages[session.lang].photos_add, 'photos_add')]
        ]);
    } else {
        // Если фото есть, показываем все кнопки
        keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(messages[session.lang].photos_done, 'photos_done')],
            [
                Markup.button.callback(messages[session.lang].photos_add, 'photos_add'),
                Markup.button.callback(messages[session.lang].photos_view, 'photos_view')
            ],
            [
                Markup.button.callback(messages[session.lang].photos_delete, 'photos_delete'),
                Markup.button.callback(messages[session.lang].photos_delete_all, 'photos_delete_all')
            ]
        ]);
    }

    ctx.editMessageText(
        count > 0 ? messages[session.lang].photo_received(count) : messages[session.lang].ask_photo,
        keyboard
    );
    
    // Отправляем кнопки управления внизу для удобства
    const backMessage = session.lang === 'ru' 
        ? `⬅️ Возвращаемся к управлению фото`
        : `⬅️ Foto boshqaruviga qaytamiz`;
    await ctx.reply(backMessage, keyboard);
    
    ctx.answerCbQuery();
});

bot.action('photos_view', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo' || !session.photos || session.photos.length === 0) {
        return ctx.answerCbQuery('Нет фотографий для просмотра');
    }

    // Отправляем уведомление перед показом фото
    const viewMessage = session.lang === 'ru' 
        ? `📷 Показываю все ваши фото (${session.photos.length}):`
        : `📷 Barcha fotolaringizni ko'rsatyapman (${session.photos.length}):`;
    await ctx.reply(viewMessage);

    for (const photoId of session.photos) {
        await ctx.replyWithPhoto(photoId);
    }
    
    // Отправляем кнопки управления после показа всех фото
    const controlMessage = session.lang === 'ru' 
        ? `📷 Все фото показаны. Выберите действие:`
        : `📷 Barcha fotolar ko'rsatildi. Amalni tanlang:`;
    
    const controlKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback(messages[session.lang].photos_done, 'photos_done')],
        [
            Markup.button.callback(messages[session.lang].photos_add, 'photos_add'),
            Markup.button.callback(messages[session.lang].photos_view, 'photos_view')
        ],
        [
            Markup.button.callback(messages[session.lang].photos_delete, 'photos_delete'),
            Markup.button.callback(messages[session.lang].photos_delete_all, 'photos_delete_all')
        ]
    ]);
    await ctx.reply(controlMessage, controlKeyboard);
    ctx.answerCbQuery();
});

// Callback для удаления всех фото
bot.action('photos_delete_all', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo' || !session.photos || session.photos.length === 0) {
        return ctx.answerCbQuery(messages[session.lang].no_photos);
    }

    // Показываем подтверждение
    const confirmMessage = messages[session.lang].confirm_delete_all;
    const confirmKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback(messages[session.lang].delete_all_yes, 'confirm_delete_all_yes'),
            Markup.button.callback(messages[session.lang].delete_all_no, 'confirm_delete_all_no')
        ]
    ]);
    
    await ctx.reply(confirmMessage, confirmKeyboard);
    ctx.answerCbQuery();
});

// Callback для подтверждения удаления всех фото
bot.action('confirm_delete_all_yes', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo') {
        return ctx.answerCbQuery('Сессия истекла');
    }

    const photoCount = session.photos ? session.photos.length : 0;
    
    // Удаляем все фото
    session.photos = [];
    
    // Обновляем клавиатуру - показываем только "Добавить фото"
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(messages[session.lang].photos_add, 'photos_add')]
    ]);
    
    // Отправляем уведомление
    const deleteAllMessage = session.lang === 'ru' 
        ? `🗑️ Все фото удалены (${photoCount}). Добавьте хотя бы одно фото для продолжения`
        : `🗑️ Barcha fotolar o'chirildi (${photoCount}). Davom etish uchun kamida bitta foto qo'shing`;
    
    await ctx.reply(deleteAllMessage, keyboard);
    ctx.answerCbQuery(messages[session.lang].all_photos_deleted);
});

// Callback для отмены удаления всех фото
bot.action('confirm_delete_all_no', async (ctx) => {
    const session = sessions[ctx.from.id];
    if (!session || session.step !== 'photo') {
        return ctx.answerCbQuery('Сессия истекла');
    }

    // Возвращаем к управлению фото
    const count = session.photos ? session.photos.length : 0;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(messages[session.lang].photos_done, 'photos_done')],
        [
            Markup.button.callback(messages[session.lang].photos_add, 'photos_add'),
            Markup.button.callback(messages[session.lang].photos_view, 'photos_view')
        ],
        [
            Markup.button.callback(messages[session.lang].photos_delete, 'photos_delete'),
            Markup.button.callback(messages[session.lang].photos_delete_all, 'photos_delete_all')
        ]
    ]);
    
    const cancelMessage = session.lang === 'ru' 
        ? `❌ Удаление отменено. У вас ${count} фото`
        : `❌ O'chirish bekor qilindi. Sizda ${count} ta foto bor`;
    
    await ctx.reply(cancelMessage, keyboard);
    ctx.answerCbQuery();
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