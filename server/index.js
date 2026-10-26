const ADMIN_PASSWORD = String(
    process.env.ADMIN_PASSWORD || ''
).trim();

if (!ADMIN_PASSWORD) {
    throw new Error(
        'ADMIN_PASSWORD Render Environment sozlamalarida topilmadi.'
    );
}
const crypto = require('node:crypto');

const UNAUTHORIZED = {
    error: 'Ruxsat yo‘q yoki sessiya muddati tugagan. Qaytadan kiring.'
};

function sha256(value) {

    return crypto
        .createHash('sha256')
        .update(String(value))
        .digest();
}

// PostgreSQL'dagi parol xeshi mavjud bo'lsa, u ENV parolidan ustun turadi.
let activeAdminPasswordHash = sha256(ADMIN_PASSWORD);

function normalizePassword(value) {

    if (value === undefined || value === null) {
        return '';
    }

    return String(value).trim();
}

// Uzunlikdan qat'i nazar bir xil vaqtda solishtiriladi
 
function passwordMatches(value) {
    const input = normalizePassword(value);
    if (!input) return false;

    const expected = activeAdminPasswordHash || sha256(ADMIN_PASSWORD);
    const actual = sha256(input);

    if (!Buffer.isBuffer(expected) || expected.length !== actual.length) {
        return false;
    }

    return crypto.timingSafeEqual(actual, expected);
}

function cleanAdminName(value) {

    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 40);
}

function getIp(req) {

    // Render/Cloudflare o'zi qo'yadigan sarlavhalar birinchi o'rinda
    const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];

    if (cf) {
        return String(cf).trim();
    }

    const fwd = req.headers['x-forwarded-for'];

    if (fwd) {
        return String(fwd).split(',')[0].trim();
    }

    return req.socket.remoteAddress || 'unknown';
}

// Bloklanish tugashiga qolgan millisekund (0 bo'lsa bloklanmagan)
function blockRemainingMs(req) {

    const now = Date.now();
    let remaining = 0;

    if (globalBlockedUntil > now) {
        remaining = globalBlockedUntil - now;
    }

    const rec = failedAttempts.get(getIp(req));

    if (rec && rec.blockedUntil > now) {
        remaining = Math.max(remaining, rec.blockedUntil - now);
    }

    return remaining;
}

function registerFail(req) {

    const ip = getIp(req);
    const now = Date.now();

    let rec = failedAttempts.get(ip);

    const expired =
        !rec ||
        (rec.blockedUntil > 0 && now >= rec.blockedUntil) ||
        (rec.blockedUntil === 0 && now - rec.first > BLOCK_MS);

    if (expired) {
        rec = { count: 0, first: now, blockedUntil: 0 };
    }

    rec.count++;

    if (rec.count >= MAX_FAILS) {
        rec.blockedUntil = now + BLOCK_MS;
    }

    failedAttempts.set(ip, rec);

    // Umumiy himoya: IP almashtirib urinib ko'rishga qarshi
    globalFails = globalFails.filter(t => now - t < BLOCK_MS);
    globalFails.push(now);

    if (globalFails.length >= GLOBAL_MAX_FAILS) {

        globalBlockedUntil = now + BLOCK_MS;
        globalFails = [];
    }
}

function sendBlocked(res, ms) {

    const minutes = Math.max(1, Math.ceil(ms / 60000));

    return sendJson(res, 429, {
        status: 'blocked',
        error:
            'Juda ko‘p noto‘g‘ri urinish. ' +
            minutes +
            ' daqiqadan keyin qayta urinib ko‘ring.',
        retryAfterSeconds: Math.ceil(ms / 1000)
    });
}

function isAdminHeader(req) {

    const token = String(
        req.headers['x-admin-session'] || ''
    ).trim();

    if (!token) {
        return false;
    }

    const session = adminSessions.get(token);

    if (!session) {
        return false;
    }

    if (Date.now() >= session.expiresAt) {

        adminSessions.delete(token);

        return false;
    }

    return true;
}

function isAdmin(req) {
    return isAdminHeader(req);
}

// Eskirgan yozuvlarni tozalash
setInterval(() => {

    const now = Date.now();

    for (const [ip, rec] of failedAttempts) {

        const done = rec.blockedUntil > 0
            ? now >= rec.blockedUntil
            : now - rec.first > BLOCK_MS;

        if (done) {
            failedAttempts.delete(ip);
        }
    }

    for (const [id, request] of adminLoginRequests) {

        if (now - request.createdAt > CODE_TTL_MS) {
            adminLoginRequests.delete(id);
        }
    }

    for (const [id, request] of adminPasswordChangeRequests) {
    if (now - request.createdAt >= ADMIN_PASSWORD_CHANGE_TTL_MS) {
        adminPasswordChangeRequests.delete(id);
    }
}

    for (const [token, session] of adminSessions) {

        if (now >= session.expiresAt) {
            adminSessions.delete(token);
        }
    }

}, 60 * 1000).unref();

// =====================================================
// TELEGRAM BOT
// =====================================================

let telegramOffset = 0;
let telegramRunning = false;
let telegramStopped = false;

const telegramSearchMode = new Map();
const telegramFavorites = new Map();

const TELEGRAM_PAGE_SIZE = 5;

async function telegramApi(method, body = {}) {

    if (!TELEGRAM_BOT_TOKEN) {
        return null;
    }

    try {

        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );

        const data = await response.json();

        if (!data.ok) {

            console.error('Telegram API ERROR:', data.description);

            return null;
        }

        return data.result;

    } catch (error) {

        console.error('Telegram API NETWORK ERROR:', error.message);

        return null;
    }
}

// Qisqa yordamchilar
const btn = (text, data) => ({ text, callback_data: data });

function tgSend(chatId, text, keyboard) {

    const body = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
    };

    if (keyboard) {
        body.reply_markup = { inline_keyboard: keyboard };
    }

    return telegramApi('sendMessage', body);
}

function telegramEscape(value) {

    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function telegramPrice(car) {

    const price = Number(car.price) || 0;

    if (normalizeCurrency(car.currency) === 'USD') {
        return '$ ' + price.toLocaleString('en-US');
    }

    return price.toLocaleString('uz-UZ') + " so'm";
}

function telegramTypes(car) {

    const types = parseTypes(car);

    if (types.length) {
        return types.map(telegramEscape).join(', ');
    }

    return 'Ko‘rsatilmagan';
}

function telegramGetFavorites(chatId) {

    const key = String(chatId);

    if (!telegramFavorites.has(key)) {
        telegramFavorites.set(key, new Set());
    }

    return telegramFavorites.get(key);
}

function telegramIsFavorite(chatId, houseId) {
    return telegramGetFavorites(chatId).has(Number(houseId));
}

function telegramToggleFavorite(chatId, houseId) {

    const favorites = telegramGetFavorites(chatId);
    const id = Number(houseId);

    if (favorites.has(id)) {

        favorites.delete(id);

        return false;
    }

    favorites.add(id);

    return true;
}

async function telegramGetCars() {

    const result = await pool.query(`
        SELECT *
        FROM cars
        WHERE sold = false
        ORDER BY id DESC
    `);

    return result.rows.map(carOut);
}

async function telegramGetHouse(houseId) {

    const result = await pool.query(
        `SELECT * FROM cars WHERE id = $1 LIMIT 1`,
        [Number(houseId)]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return carOut(result.rows[0]);
}

// -----------------------------------------------------
// BOSH MENYU
// -----------------------------------------------------

async function telegramStart(chatId, firstName = '') {

    const name = String(firstName || '').trim();

    let greeting = '🏠 <b>Uy-Joy</b>';

    if (name) {
        greeting += `\n\nAssalomu alaykum, <b>${telegramEscape(name)}</b>!`;
    }

    const text =
        `${greeting}\n\n` +
        '🏡 Uy, hovli va yerlarni qulay tarzda toping.\n\n' +
        'Kerakli bo‘limni tanlang 👇';

    await tgSend(chatId, text, [
        [btn('🏠 Uylarni ko‘rish', 'homes')],
        [btn('🔎 Uy qidirish', 'search'), btn('⭐ Saqlanganlar', 'favorites')],
        [btn('📢 Yangi e’lonlar', 'newest')],
        [
            btn('📞 Bog‘lanish', 'contact'),
            { text: '🌐 Sayt', url: SITE_URL }
        ]
    ]);
}

async function telegramMenu(chatId) {
    await telegramStart(chatId);
}

// -----------------------------------------------------
// UYLAR RO'YXATI
// -----------------------------------------------------

async function telegramSendHomes(chatId, page = 0) {

    const cars = await telegramGetCars();

    if (!cars.length) {

        await tgSend(
            chatId,
            '🏠 <b>Hozircha uylar mavjud emas.</b>\n\n' +
            'Yangi e’lonlar qo‘shilganda yana tekshirib ko‘ring.',
            [
                [btn('🔄 Yangilash', 'homes')],
                [btn('🏠 Bosh menyu', 'menu')]
            ]
        );

        return;
    }

    const totalPages = Math.ceil(cars.length / TELEGRAM_PAGE_SIZE);

    let currentPage = Number(page) || 0;

    if (currentPage < 0) {
        currentPage = 0;
    }

    if (currentPage >= totalPages) {
        currentPage = totalPages - 1;
    }

    const start = currentPage * TELEGRAM_PAGE_SIZE;
    const items = cars.slice(start, start + TELEGRAM_PAGE_SIZE);

    let text = '🏠 <b>UY-JOY KATALOGI</b>\n\n';

    text += `📊 Jami: <b>${cars.length}</b> ta uy\n`;
    text += `📄 Sahifa: <b>${currentPage + 1}/${totalPages}</b>\n\n`;

    const buttons = [];

    for (let i = 0; i < items.length; i++) {

        const car = items[i];
        const number = start + i + 1;

        text += `<b>${number}.</b> 🏠 <b>${telegramEscape(car.name || 'Uy')}</b>\n`;
        text += `💰 ${telegramEscape(telegramPrice(car))}\n`;

        if (car.address) {
            text += `📍 ${telegramEscape(car.address)}\n`;
        }

        text += '\n';

        buttons.push([btn(`🏠 ${number}-uy`, `house_${car.id}`)]);
    }

    const navigation = [];

    if (currentPage > 0) {
        navigation.push(btn('◀️ Oldingi', `homes_${currentPage - 1}`));
    }

    navigation.push(btn(`📄 ${currentPage + 1}/${totalPages}`, 'noop'));

    if (currentPage < totalPages - 1) {
        navigation.push(btn('Keyingi ▶️', `homes_${currentPage + 1}`));
    }

    buttons.push(navigation);
    buttons.push([btn('🔎 Qidirish', 'search'), btn('⭐ Saqlangan', 'favorites')]);
    buttons.push([btn('🏠 Bosh menyu', 'menu')]);

    await tgSend(chatId, text, buttons);
}

async function telegramNewest(chatId) {
    await telegramSendHomes(chatId, 0);
}

// -----------------------------------------------------
// QIDIRUV
// -----------------------------------------------------

async function telegramSearchStart(chatId) {

    telegramSearchMode.set(String(chatId), true);

    await tgSend(
        chatId,
        '🔎 <b>Uy qidirish</b>\n\n' +
        'Uy nomi, turi, manzili yoki tavsifidan biror so‘z yozing.\n\n' +
        'Masalan:\n' +
        '• Chilonzor\n' +
        '• hovli\n' +
        '• 4 xona\n' +
        '• Toshkent\n\n' +
        '❌ Bekor qilish uchun /menu yozing.'
    );
}

async function telegramSearch(chatId, query) {

    const q = String(query || '').trim().slice(0, 100);

    if (!q) {

        await telegramSearchStart(chatId);

        return;
    }

    telegramSearchMode.delete(String(chatId));

    const like = `%${q}%`;

    const result = await pool.query(
        `
        SELECT *
        FROM cars
        WHERE sold = false
          AND (
                name ILIKE $1
                OR description ILIKE $1
                OR location ILIKE $1
                OR address ILIKE $1
                OR type ILIKE $1
                OR types ILIKE $1
          )
        ORDER BY id DESC
        LIMIT 20
        `,
        [like]
    );

    const cars = result.rows.map(carOut);

    if (!cars.length) {

        await tgSend(
            chatId,
            `🔎 <b>"${telegramEscape(q)}"</b> bo‘yicha uy topilmadi.\n\n` +
            'Boshqa so‘z bilan qayta urinib ko‘ring.',
            [
                [btn('🔎 Qayta qidirish', 'search')],
                [btn('🏠 Uylar', 'homes')]
            ]
        );

        return;
    }

    let text = `🔎 <b>Qidiruv natijalari</b>\n\n`;

    text +=
        `"<b>${telegramEscape(q)}</b>" bo‘yicha ` +
        `<b>${cars.length}</b> ta natija.\n\n`;

    const buttons = [];

    cars.forEach((car, index) => {

        text += `<b>${index + 1}.</b> 🏠 ${telegramEscape(car.name || 'Uy')}\n`;
        text += `💰 ${telegramEscape(telegramPrice(car))}\n`;

        if (car.address) {
            text += `📍 ${telegramEscape(car.address)}\n`;
        }

        text += '\n';

        buttons.push([btn(`🏠 ${index + 1}-uy`, `house_${car.id}`)]);
    });

    buttons.push([btn('🔎 Yana qidirish', 'search')]);
    buttons.push([btn('🏠 Bosh menyu', 'menu')]);

    await tgSend(chatId, text, buttons);
}

// -----------------------------------------------------
// SAQLANGANLAR
// -----------------------------------------------------

async function telegramFavoritesList(chatId) {

    const favorites = telegramGetFavorites(chatId);
    const ids = Array.from(favorites);

    if (!ids.length) {

        await tgSend(
            chatId,
            '⭐ <b>Saqlangan uylar</b>\n\n' +
            'Hozircha saqlangan uylar yo‘q.\n\n' +
            'Yoqtirgan uyingizni ochib, ⭐ Saqlash tugmasini bosing.',
            [
                [btn('🏠 Uylarni ko‘rish', 'homes')],
                [btn('🏠 Bosh menyu', 'menu')]
            ]
        );

        return;
    }

    const result = await pool.query(
        `
        SELECT *
        FROM cars
        WHERE id = ANY($1::int[])
          AND sold = false
        ORDER BY id DESC
        `,
        [ids]
    );

    const cars = result.rows.map(carOut);

    if (!cars.length) {

        favorites.clear();

        await tgSend(
            chatId,
            '⭐ Saqlangan uylar hozircha mavjud emas.',
            [[btn('🏠 Uylarni ko‘rish', 'homes')]]
        );
            return;
    }

    let text = '⭐ <b>SAQLANGAN UYLAR</b>\n\n';

    const buttons = [];

    cars.forEach((car, index) => {

        text += `<b>${index + 1}.</b> 🏠 ${telegramEscape(car.name || 'Uy')}\n`;
        text += `💰 ${telegramEscape(telegramPrice(car))}\n\n`;

        buttons.push([btn(`🏠 ${index + 1}-uy`, `house_${car.id}`)]);
    });

    buttons.push([btn('🏠 Uylar', 'homes'), btn('🏠 Bosh menyu', 'menu')]);

    await tgSend(chatId, text, buttons);
}

// -----------------------------------------------------
// BOG'LANISH
// -----------------------------------------------------

async function telegramContact(chatId) {

    try {

        const result = await pool.query(`
            SELECT phone, telegram, whatsapp, instagram, address
            FROM site_settings
            WHERE id = 1
        `);

        const settings = result.rows[0];

        if (!settings) {

            await tgSend(
                chatId,
                '📞 <b>Bog‘lanish ma’lumotlari mavjud emas.</b>'
            );

            return;
        }

        let text = '📞 <b>BOG‘LANISH</b>\n\n';

        if (settings.phone) {
            text += `📱 Telefon: <b>${telegramEscape(settings.phone)}</b>\n`;
        }

        if (settings.address) {
            text += `📍 Manzil: ${telegramEscape(settings.address)}\n`;
        }

        text += '\n👇 <b>Kerakli aloqa usulini tanlang:</b>';

        const buttons = [];

        if (settings.telegram) {

            let link = String(settings.telegram).trim();

            if (link.startsWith('@')) {

                link = 'https://t.me/' + link.slice(1);

            } else if (
                !link.startsWith('http://') &&
                !link.startsWith('https://')
            ) {

                link = 'https://t.me/' + link;
            }

            buttons.push([
                { text: '✈️ Telegram orqali yozish', url: link }
            ]);
        }

        buttons.push([{ text: '🌐 Saytga kirish', url: SITE_URL }]);
        buttons.push([btn('🏠 Bosh menyu', 'menu')]);

        await tgSend(chatId, text, buttons);

    } catch (error) {

        console.error('Telegram contact xatosi:', error);

        await telegramApi('sendMessage', {
            chat_id: chatId,
            text:
                '❌ Bog‘lanish ma’lumotlarini olishda xatolik yuz berdi.\n\n' +
                'Iltimos, keyinroq qayta urinib ko‘ring.'
        });
    }
}

// -----------------------------------------------------
// UY HAQIDA BATAFSIL
// -----------------------------------------------------

async function telegramHouse(chatId, houseId) {

    const car = await telegramGetHouse(houseId);

    if (!car) {

        await telegramApi('sendMessage', {
            chat_id: chatId,
            text: '❌ Bu uy topilmadi.'
        });

        return;
    }

    let text = `🏠 <b>${telegramEscape(car.name || 'Uy')}</b>\n\n`;

    text += `💰 <b>${telegramEscape(telegramPrice(car))}</b>\n`;
    text += `🏷 Turi: ${telegramTypes(car)}\n`;

    if (car.rooms > 0) {
        text += `🚪 Xonalar: <b>${car.rooms}</b> ta\n`;
    }

    if (car.area > 0) {
        text += `📐 Maydon: <b>${car.area}</b> m²\n`;
    }

    if (car.address) {
        text += `📍 Manzil: ${telegramEscape(car.address)}\n`;
    }

    if (car.phone) {
        text += `📞 Telefon: ${telegramEscape(car.phone)}\n`;
    }

    if (car.description) {

        const description = String(car.description)
            .replace(/\s+/g, ' ')
            .trim();

        if (description) {

            text += `\n📝 <b>Tavsif</b>\n`;
            text += telegramEscape(description.slice(0, 700));

            if (description.length > 700) {
                text += '...';
            }

            text += '\n';
        }
    }

    const favoriteText = telegramIsFavorite(chatId, car.id)
        ? '💛 Saqlangan'
        : '⭐ Saqlash';

    const buttons = [
        [btn(favoriteText, `fav_${car.id}`)],
        [{ text: '🌐 Saytda ko‘rish', url: `${SITE_URL}/?house=${car.id}` }],
        [btn('📞 Bog‘lanish', 'contact')],
        [btn('🏠 Uylar', 'homes'), btn('🏠 Bosh menyu', 'menu')]
    ];

    const imageUrls = parseImages(car)
        .filter(Boolean)
        .map(image => {

            const value = String(image);

            if (value.startsWith('http://') || value.startsWith('https://')) {
                return value;
            }

            if (value.startsWith('/')) {
                return `${SITE_URL}${value}`;
            }

            return `${SITE_URL}/uploads/${encodeURIComponent(value)}`;
        })
        .slice(0, 10);

    // Telegram rasm izohi 1024 belgidan oshmasligi kerak
    const captionOk = text.length <= 1000;

    if (imageUrls.length === 0) {

        await tgSend(chatId, text, buttons);

        return;
    }

    if (imageUrls.length === 1) {

        const payload = captionOk
            ? {
                chat_id: chatId,
                photo: imageUrls[0],
                caption: text,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            }
            : {
                chat_id: chatId,
                photo: imageUrls[0]
            };

        const photo = await telegramApi('sendPhoto', payload);

        if (!photo || !captionOk) {
            await tgSend(chatId, text, buttons);
        }

        return;
    }

    const media = imageUrls.map((url, index) => {

        const item = { type: 'photo', media: url };

        if (index === 0 && captionOk) {
            item.caption = text;
            item.parse_mode = 'HTML';
        }

        return item;
    });

    const group = await telegramApi('sendMediaGroup', {
        chat_id: chatId,
        media
    });

    if (!group || !captionOk) {

        await tgSend(chatId, text, buttons);

        return;
    }

    await telegramApi('sendMessage', {
        chat_id: chatId,
        text: '👇 Uy bo‘yicha amallar:',
        reply_markup: { inline_keyboard: buttons }
    });
}

// -----------------------------------------------------
// CALLBACK
// -----------------------------------------------------

async function telegramCallback(query) {

    const chatId =
        query.message && query.message.chat
            ? query.message.chat.id
            : null;

    if (!chatId) {
        return;
    }

    const data = String(query.data || '');

    // "Saqlash" tugmasi o'zi javob (toast) beradi, shuning uchun
    // uni umumiy javobdan oldin chaqirmaymiz
    if (!data.startsWith('fav_')) {

        await telegramApi('answerCallbackQuery', {
            callback_query_id: query.id
        });
    }

    // Eski tasdiqlash tugmalari endi ishlatilmaydi
    if (data.startsWith('admin_')) {
        return;
    }

    if (data === 'noop') {
        return;
    }

    if (data === 'menu') {
        await telegramMenu(chatId);
        return;
    }

    if (data === 'homes') {
        await telegramSendHomes(chatId, 0);
        return;
    }

    if (data.startsWith('homes_')) {

        const page = Number(data.replace('homes_', ''));

        await telegramSendHomes(chatId, Number.isFinite(page) ? page : 0);

        return;
    }

    if (data === 'search') {
        await telegramSearchStart(chatId);
        return;
    }

    if (data === 'favorites') {
        await telegramFavoritesList(chatId);
        return;
    }

    if (data === 'newest') {
        await telegramNewest(chatId);
        return;
    }

    if (data === 'contact') {
        await telegramContact(chatId);
        return;
    }

    if (data.startsWith('fav_')) {

        const houseId = Number(data.replace('fav_', ''));

        if (!Number.isInteger(houseId)) {

            await telegramApi('answerCallbackQuery', {
                callback_query_id: query.id
            });

            return;
        }

        const state = telegramToggleFavorite(chatId, houseId);

        await telegramApi('answerCallbackQuery', {
            callback_query_id: query.id,
            text: state
                ? '⭐ Uy saqlandi'
                : '🗑 Saqlanganlardan olib tashlandi',
            show_alert: false
        });

        return;
    }

    if (data.startsWith('house_')) {

        const houseId = Number(data.replace('house_', ''));

        if (!Number.isInteger(houseId)) {
            return;
        }

        await telegramHouse(chatId, houseId);

        return;
    }
}

// -----------------------------------------------------
// XABARLAR
// -----------------------------------------------------

async function telegramHandleUpdate(update) {

    if (update.callback_query) {

        await telegramCallback(update.callback_query);

        return;
    }

    const message = update.message;

    if (!message || !message.chat) {
        return;
    }

    const chatId = message.chat.id;

    const firstName =
        message.from && message.from.first_name
            ? message.from.first_name
            : '';

    const originalText = String(message.text || '').trim();
    const text = originalText.toLowerCase();

    // O'z Telegram ID'ngizni bilish (ADMIN_TELEGRAM_ID uchun)
    if (text === '/myid') {

        if (
            message.chat.type !== 'private' ||
            !message.from ||
            !message.from.id
        ) {

            await telegramApi('sendMessage', {
                chat_id: chatId,
                text: 'Bu buyruqni bot bilan shaxsiy chatda yuboring.'
            });

            return;
        }

        await telegramApi('sendMessage', {
            chat_id: chatId,
            text:
                `Telegram ID: ${message.from.id}\n\n` +
                'Bu raqam admin kodlari yuboriladigan ADMIN_TELEGRAM_ID uchun kerak.'
        });

        return;
    }

    // Qidiruv rejimi: oddiy matn qidiruv so'zi hisoblanadi,
    // "/" bilan boshlangan buyruq esa rejimni to'xtatadi
    if (telegramSearchMode.has(String(chatId))) {

        if (text.startsWith('/')) {

            telegramSearchMode.delete(String(chatId));

        } else {

            await telegramSearch(chatId, originalText);

            return;
        }
    }

    if (text === '/start' || text === '/menu') {

        await telegramStart(chatId, firstName);

        return;
    }

    if (text === '/uylar' || text === 'uylar') {

        await telegramSendHomes(chatId, 0);

        return;
    }

    if (text === '/qidiruv' || text === '/qidirish' || text === 'qidiruv') {

        await telegramSearchStart(chatId);

        return;
    }

    if (text === '/saqlangan' || text === 'saqlangan') {

        await telegramFavoritesList(chatId);

        return;
    }

    if (text === '/aloqa' || text === 'aloqa') {

        await telegramContact(chatId);

        return;
    }

    await tgSend(
        chatId,
        '🏠 <b>Uy-Joy</b>\n\nKerakli bo‘limni tanlang 👇',
        [
            [btn('🏠 Uylarni ko‘rish', 'homes')],
            [btn('🔎 Uy qidirish', 'search'), btn('⭐ Saqlangan', 'favorites')],
            [btn('📞 Bog‘lanish', 'contact')],
            [btn('🏠 Bosh menyu', 'menu')]
        ]
    );
}

async function telegramSetCommands() {

    await telegramApi('setMyCommands', {
        commands: [
            { command: 'start', description: '🏠 Bosh menyu' },
            { command: 'uylar', description: '🏠 Uylarni ko‘rish' },
            { command: 'qidiruv', description: '🔎 Uy qidirish' },
            { command: 'saqlangan', description: '⭐ Saqlangan uylar' },
            { command: 'aloqa', description: '📞 Bog‘lanish' },
            { command: 'menu', description: '🏠 Menyu' }
        ]
    });
}

async function telegramPolling() {

    if (
        telegramRunning ||
        telegramStopped ||
        !TELEGRAM_BOT_TOKEN
    ) {

        if (!TELEGRAM_BOT_TOKEN) {
            console.log(
                'TELEGRAM_BOT_TOKEN mavjud emas. Telegram bot ishga tushirilmadi.'
            );
        }

        return;
    }

    telegramRunning = true;

    console.log('Telegram premium bot ishga tushmoqda...');

    try {

        await telegramApi('deleteWebhook', {
            drop_pending_updates: false
        });

        const me = await telegramApi('getMe');

        if (me) {
            console.log(`Telegram bot: @${me.username}`);
        }

        await telegramSetCommands();

        console.log('Telegram bot komandalar o‘rnatildi');

        while (!telegramStopped) {

            try {

                const updates = await telegramApi('getUpdates', {
                    offset: telegramOffset,
                    timeout: 25,
                    allowed_updates: ['message', 'callback_query']
                });

                if (!Array.isArray(updates)) {

                    await new Promise(resolve => setTimeout(resolve, 3000));

                    continue;
                }

                for (const update of updates) {

                    telegramOffset = Number(update.update_id) + 1;

                    try {

                        await telegramHandleUpdate(update);

                    } catch (error) {

                        console.error('Telegram update xatosi:', error);
                    }
                }

            } catch (error) {

                console.error('Telegram polling xatosi:', error.message);

                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

    } catch (error) {

        console.error('Telegram bot xatosi:', error);

    } finally {

        telegramRunning = false;
    }
}

// =====================================================
// SERVER
// =====================================================

function applyCommonHeaders(req, res) {

    // CORS: faqat ruxsat berilgan manzillar (sayt o'zi bir manzildan
    // ishlagani uchun oddiy ishlashga ta'sir qilmaydi)
    const origin = req.headers.origin;

    if (origin && ALLOWED_ORIGINS.has(origin)) {

        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

const server = http.createServer(async (req, res) => {

    try {

        const url = req.url.split('?')[0];

        applyCommonHeaders(req, res);

        // =================================================
        // OPTIONS (CORS)
        // =================================================

        if (req.method === 'OPTIONS') {
                        const origin = req.headers.origin;

            if (origin && ALLOWED_ORIGINS.has(origin)) {

                res.writeHead(204, {
                    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Session',
                    'Access-Control-Max-Age': '600'
                });

            } else {

                res.writeHead(204);
            }

            return res.end();
        }

        // =================================================
        // ADMIN LOGIN — 1-BOSQICH: ISM + PAROL, KOD TELEGRAMGA
        // =================================================

        if (url === '/api/admin/login' && req.method === 'POST') {

            const blocked = blockRemainingMs(req);

            if (blocked > 0) {
                return sendBlocked(res, blocked);
            }

            let body;

            try {

                body = parseJsonObject(await readBody(req, 10000));

            } catch (e) {

                return sendJson(res, 400, {
                    error: 'So‘rov ma’lumotlari noto‘g‘ri.'
                });
            }

            // Ism istalgan bo'lishi mumkin, faqat bo'sh bo'lmasin
            const name = cleanAdminName(body.name);
            const password = normalizePassword(body.password);

            if (!name) {
                return sendJson(res, 400, { error: 'Ismingizni kiriting.' });
            }

            if (!password) {
                return sendJson(res, 400, { error: 'Parolni kiriting.' });
            }

            if (!passwordMatches(password)) {

                registerFail(req);

                const remaining = blockRemainingMs(req);

                if (remaining > 0) {
                    return sendBlocked(res, remaining);
                }

                return sendJson(res, 401, { error: 'Parol noto‘g‘ri.' });
            }

            if (!ADMIN_TG_OK) {

                return sendJson(res, 503, {
                    error: 'Telegram tasdiqlash sozlamalari to‘liq emas.'
                });
            }

            const ip = getIp(req);
            const now = Date.now();

            // Telegramni ketma-ket spam qilishdan himoya
            for (const request of adminLoginRequests.values()) {

                if (
                    request.ip === ip &&
                    now - request.createdAt < CODE_RESEND_MS
                ) {

                    return sendJson(res, 429, {
                        error: 'Kod yaqinda yuborilgan. 30 soniyadan keyin qayta urinib ko‘ring.'
                    });
                }
            }

            if (adminLoginRequests.size >= 50) {

                return sendJson(res, 429, {
                    error: 'Hozir so‘rovlar ko‘p. Birozdan keyin urinib ko‘ring.'
                });
            }

            // Shu IP'ning eski kutilayotgan so'rovlari bekor qilinadi
            for (const [id, request] of adminLoginRequests) {

                if (request.ip === ip) {
                    adminLoginRequests.delete(id);
                }
            }

            const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
            const requestId = crypto.randomBytes(16).toString('hex');

            adminLoginRequests.set(requestId, {
                codeHash: sha256(code),
                createdAt: now,
                tries: 0,
                ip,
                name
            });

            const sent = await telegramApi('sendMessage', {
                chat_id: ADMIN_TELEGRAM_ID,
                text:
                    '🔐 Uy-Joy admin paneliga kirish kodi\n\n' +
                    'Kod: ' + code + '\n\n' +
                    'Ism: ' + name + '\n' +
                    'IP: ' + ip + '\n' +
                    '⏳ Kod 5 daqiqa amal qiladi va bir marta ishlaydi.\n\n' +
                    'Agar bu siz bo‘lmasangiz, kodni hech kimga bermang.'
            });

            if (!sent) {

                adminLoginRequests.delete(requestId);

                console.error('Admin Telegram kodi yuborilmadi');

                return sendJson(res, 502, {
                    error: 'Telegramga kod yuborilmadi. Botga /start yozganingizni tekshiring.'
                });
            }

            return sendJson(res, 200, {
                ok: true,
                status: 'code_sent',
                requestId,
                expiresInSeconds: CODE_TTL_MS / 1000
            });
        }

        // =================================================
        // ADMIN LOGIN — 2-BOSQICH: 6 XONALI KODNI TEKSHIRISH
        // =================================================

        if (url === '/api/admin/verify' && req.method === 'POST') {

            const blocked = blockRemainingMs(req);

            if (blocked > 0) {
                return sendBlocked(res, blocked);
            }

            let body;

            try {

                body = parseJsonObject(await readBody(req, 10000));

            } catch (e) {

                return sendJson(res, 400, {
                    error: 'So‘rov ma’lumotlari noto‘g‘ri.'
                });
            }

            const requestId = String(body.requestId || '');
            const code = String(body.code || '').trim();

            if (!/^[a-f0-9]{32}$/.test(requestId)) {

                return sendJson(res, 400, {
                    error: 'So‘rov identifikatori noto‘g‘ri.'
                });
            }

            if (!/^\d{6}$/.test(code)) {

                return sendJson(res, 400, {
                    error: 'Kod 6 ta raqamdan iborat bo‘lishi kerak.'
                });
            }

            const request = adminLoginRequests.get(requestId);

            if (!request) {

                return sendJson(res, 404, {
                    status: 'not_found',
                    error: 'Kirish so‘rovi topilmadi. Qaytadan kiring.'
                });
            }

            if (Date.now() - request.createdAt > CODE_TTL_MS) {

                adminLoginRequests.delete(requestId);

                return sendJson(res, 401, {
                    status: 'expired',
                    error: 'Kod muddati tugadi. Qaytadan kiring.'
                });
            }

            request.tries++;

            const codeOk = crypto.timingSafeEqual(
                request.codeHash,
                sha256(code)
            );

            if (!codeOk) {

                registerFail(req);

                const remaining = blockRemainingMs(req);

                if (remaining > 0) {

                    adminLoginRequests.delete(requestId);

                    return sendBlocked(res, remaining);
                }

                if (request.tries >= CODE_MAX_TRIES) {

                    adminLoginRequests.delete(requestId);

                    return sendJson(res, 401, {
                        status: 'failed',
                        error: 'Kod 3 marta noto‘g‘ri kiritildi. Qaytadan kiring.'
                    });
                }

                return sendJson(res, 401, {
                    status: 'wrong_code',
                    error: 'Kod noto‘g‘ri.',
                    attemptsLeft: CODE_MAX_TRIES - request.tries
                });
            }

            // To'g'ri kod: so'rov o'chiriladi (bir martalik) va sessiya beriladi
            adminLoginRequests.delete(requestId);
            failedAttempts.delete(getIp(req));

            const sessionToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = Date.now() + SESSION_TTL_MS;

            adminSessions.set(sessionToken, { expiresAt });

            return sendJson(res, 200, {
                ok: true,
                status: 'approved',
                sessionToken,
                expiresAt
            });
        }

        // =================================================
        // ADMIN LOGOUT
        // =================================================

        if (url === '/api/admin/logout' && req.method === 'POST') {

            const token = String(
                req.headers['x-admin-session'] || ''
            ).trim();

            if (token) {
                adminSessions.delete(token);
            }

            return sendJson(res, 200, { ok: true });
        }

        // =================================================
        // ADMIN SESSIYA TEKSHIRUVI
        // =================================================

        if (url === '/api/admin/session' && req.method === 'GET') {

            if (!isAdminHeader(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            const token = String(req.headers['x-admin-session']).trim();

            return sendJson(res, 200, {
                ok: true,
                expiresAt: adminSessions.get(token).expiresAt
            });
        }

        // =================================================
        // ADMIN PAROLINI O'ZGARTIRISH — TELEGRAM KODINI SO'RASH
        // =================================================

        if (url === '/api/admin/password/change/request' && req.method === 'POST') {

            if (!isAdminHeader(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            let body;
            try {
                body = parseJsonObject(await readBody(req, 10000));
            } catch (e) {
                return sendJson(res, 400, { error: 'So‘rov ma’lumotlari noto‘g‘ri.' });
            }

            const newPassword = normalizePassword(body.newPassword);
            const confirmPassword = normalizePassword(body.confirmPassword);

            if (newPassword.length < 12) {
                return sendJson(res, 400, { error: 'Yangi parol kamida 12 ta belgidan iborat bo‘lsin.' });
            }
            if (newPassword.length > 200) {
                return sendJson(res, 400, { error: 'Parol juda uzun.' });
            }
            if (newPassword !== confirmPassword) {
                return sendJson(res, 400, { error: 'Yangi parollar bir-biriga mos emas.' });
            }
            if (passwordMatches(newPassword)) {
                return sendJson(res, 400, { error: 'Yangi parol hozirgi paroldan farq qilishi kerak.' });
            }
            if (!ADMIN_TG_OK) {
                return sendJson(res, 503, { error: 'Telegram tasdiqlash sozlamalari to‘liq emas.' });
            }

            const sessionToken = String(req.headers['x-admin-session'] || '').trim();
            const now = Date.now();
            for (const [id, request] of adminPasswordChangeRequests) {
                if (request.sessionToken === sessionToken) adminPasswordChangeRequests.delete(id);
            }
            if (adminPasswordChangeRequests.size >= 50) {
                return sendJson(res, 429, { error: 'Hozir so‘rovlar ko‘p. Keyinroq urinib ko‘ring.' });
            }

            const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
            const requestId = crypto.randomBytes(16).toString('hex');
            adminPasswordChangeRequests.set(requestId, {
                codeHash: sha256(code),
                passwordHash: sha256(newPassword).toString('hex'),
                createdAt: now,
                tries: 0,
                sessionToken
            });

            const sent = await telegramApi('sendMessage', {
                chat_id: ADMIN_TELEGRAM_ID,
                text: '🔐 Uy-Joy admin parolini o‘zgartirish kodi\n\n' +
                    'Kod: ' + code + '\n\n' +
                    '⏳ Kod 60 soniya amal qiladi, bir marta ishlaydi.\n' +
                    'Urinishlar soni: 3.\n\nAgar bu siz bo‘lmasangiz, kodni hech kimga bermang.'
            });

            if (!sent) {
                adminPasswordChangeRequests.delete(requestId);
                console.error('Admin parolni o‘zgartirish kodi Telegramga yuborilmadi');
                return sendJson(res, 502, { error: 'Telegramga kod yuborilmadi. Bot sozlamalarini tekshiring.' });
            }

            return sendJson(res, 200, {
                ok: true,
                requestId,
                expiresInSeconds: ADMIN_PASSWORD_CHANGE_TTL_MS / 1000
            });
        }

        // =================================================
        // ADMIN PAROLINI O'ZGARTIRISH — KODNI TEKSHIRISH VA SAQLASH
        // =================================================

        if (url === '/api/admin/password/change/verify' && req.method === 'POST') {

            if (!isAdminHeader(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            let body;
            try {
                body = parseJsonObject(await readBody(req, 10000));
            } catch (e) {
                return sendJson(res, 400, { error: 'So‘rov ma’lumotlari noto‘g‘ri.' });
            }

            const requestId = String(body.requestId || '');
            const code = String(body.code || '').trim();
            if (!/^[a-f0-9]{32}$/.test(requestId) || !/^\d{6}$/.test(code)) {
                return sendJson(res, 400, { error: 'So‘rov yoki 6 xonali kod noto‘g‘ri.' });
            }

            const request = adminPasswordChangeRequests.get(requestId);
            const sessionToken = String(req.headers['x-admin-session'] || '').trim();
            if (!request || request.sessionToken !== sessionToken) {
                return sendJson(res, 404, { error: 'So‘rov topilmadi. Yangi kod so‘rang.' });
            }
            if (Date.now() - request.createdAt >= ADMIN_PASSWORD_CHANGE_TTL_MS) {
                adminPasswordChangeRequests.delete(requestId);
                return sendJson(res, 401, { status: 'expired', error: 'Kod muddati tugadi. Yangi kod so‘rang.' });
            }

            request.tries++;
            const codeOk = crypto.timingSafeEqual(request.codeHash, sha256(code));
            if (!codeOk) {
                if (request.tries >= ADMIN_PASSWORD_CHANGE_MAX_TRIES) {
                    adminPasswordChangeRequests.delete(requestId);
                    return sendJson(res, 401, { status: 'failed', error: 'Kod 3 marta noto‘g‘ri kiritildi. Yangi kod so‘rang.' });
                }
                return sendJson(res, 401, {
                    status: 'wrong_code',
                    error: 'Kod noto‘g‘ri.',
                    attemptsLeft: ADMIN_PASSWORD_CHANGE_MAX_TRIES - request.tries
                });
            }

            await pool.query(`
                INSERT INTO admin_credentials (id, password_hash, updated_at)
                VALUES (1, $1, NOW())
                ON CONFLICT (id) DO UPDATE
                SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
            `, [request.passwordHash]);

            activeAdminPasswordHash = Buffer.from(request.passwordHash, 'hex');
            adminPasswordChangeRequests.delete(requestId);

            return sendJson(res, 200, { ok: true, message: 'Admin paroli muvaffaqiyatli o‘zgartirildi.' });
        }

        // =================================================
        // GET CARS
        // =================================================

        if (url === '/api/cars' && req.method === 'GET') {

            const result = await pool.query(`
                SELECT *
                FROM cars
                ORDER BY id DESC
            `);

            return sendJson(res, 200, result.rows.map(carOut));
        }

        // =================================================
        // ADD CAR
        // =================================================

        if (url === '/api/cars' && req.method === 'POST') {

            // Avval sessiya tekshiriladi, keyin katta body o'qiladi
            if (!isAdmin(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            let body;

            try {

                body = parseJsonObject(await readBody(req), false);

            } catch (e) {

                return sendJson(res, 400, {
                    error: "Ma'lumot formati noto'g'ri"
                });
            }

            const client = await pool.connect();

            try {

                const fields = buildCarFields(body, null);

                const incomingImages = Array.isArray(body.images)
                    ? body.images
                    : [];

                if (incomingImages.length > 8) {
                    throw new UserError("Ko'pi bilan 8 ta rasm");
                }

                const preparedImages = incomingImages.map(
                    item => prepareImage(item)
                );

                await client.query('BEGIN');

                const savedNames = [];

                for (const image of preparedImages) {

                    await client.query(
                        `INSERT INTO image_files (name, data) VALUES ($1, $2)`,
                        [image.name, image.buffer]
                    );

                    savedNames.push(image.name);
                }

                const inserted = await client.query(
                    `
                    INSERT INTO cars (
                        name, price, description, images, sold, currency,
                        type, types, location, address, rooms, area, phone
                    )
                    VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, $9, $10, $11, $12)
                    RETURNING *
                    `,
                    [
                        fields.name,
                        fields.price,
                        fields.description,
                        JSON.stringify(savedNames),
                        fields.currency,
                        fields.type,
                        JSON.stringify(fields.types),
                        fields.location,
                        fields.address,
                        fields.rooms,
                        fields.area,
                        fields.phone
                    ]
                );

                await client.query('COMMIT');

                return sendJson(res, 201, {
                    ok: true,
                    car: carOut(inserted.rows[0])
                });

            } catch (e) {

                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error('ADD CAR ERROR:', e);

                if (e instanceof UserError) {
                    return sendJson(res, 400, { error: e.message });
                }

                return sendJson(res, 500, {
                    error: "Uy qo'shishda xatolik"
                });

            } finally {

                client.release();
            }
        }

        // =================================================
        // EDIT CAR
        // =================================================

        if (/^\/api\/cars\/\d+$/.test(url) && req.method === 'PUT') {

            if (!isAdmin(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            let body;

            try {

                body = parseJsonObject(await readBody(req), false);

            } catch (e) {

                return sendJson(res, 400, {
                    error: "Ma'lumot formati noto'g'ri"
                });
            }

            const id = Number(url.split('/')[3]);

            if (!Number.isInteger(id) || id <= 0) {
                return sendJson(res, 400, { error: "ID noto'g'ri" });
            }

            const client = await pool.connect();

            try {

                const oldResult = await client.query(
                    `SELECT * FROM cars WHERE id = $1`,
                    [id]
                );

                if (oldResult.rows.length === 0) {
                    return sendJson(res, 404, { error: 'Uy topilmadi' });
                }

                const oldCar = oldResult.rows[0];

                const fields = buildCarFields(body, oldCar);

                // images ko'rsatilmasa — eski rasmlar o'zgarmaydi
                const incomingImages = Array.isArray(body.images)
                    ? body.images
                    : null;

                await client.query('BEGIN');

                let finalImages = parseImages(oldCar);
                let removedImages = [];

                if (incomingImages !== null) {

                    if (incomingImages.length > 8) {
                        throw new UserError("Ko'pi bilan 8 ta rasm");
                                            }

                    const savedNames = [];
                    const oldImageSet = new Set(finalImages);

                    for (const item of incomingImages) {

                        if (typeof item !== 'string' || !item.trim()) {
                            throw new UserError("Rasm ma'lumoti noto'g'ri");
                        }

                        // Eski rasm nomi bo'lsa — saqlab qolamiz (tartib ham saqlanadi)
                        if (!item.startsWith('data:image/')) {

                            if (!oldImageSet.has(item)) {
                                throw new UserError("Noma'lum eski rasm");
                            }

                            if (!savedNames.includes(item)) {
                                savedNames.push(item);
                            }

                            continue;
                        }

                        // Yangi rasm: JPEG ekanligi tekshiriladi
                        const image = prepareImage(item);

                        await client.query(
                            `INSERT INTO image_files (name, data) VALUES ($1, $2)`,
                            [image.name, image.buffer]
                        );

                        savedNames.push(image.name);
                    }

                    removedImages = finalImages.filter(
                        name => !savedNames.includes(name)
                    );

                    finalImages = savedNames;
                }

                const updated = await client.query(
                    `
                    UPDATE cars
                    SET
                        name = $1,
                        price = $2,
                        description = $3,
                        images = $4,
                        currency = $5,
                        type = $6,
                        types = $7,
                        location = $8,
                        address = $9,
                        rooms = $10,
                        area = $11,
                        phone = $12
                    WHERE id = $13
                    RETURNING *
                    `,
                    [
                        fields.name,
                        fields.price,
                        fields.description,
                        JSON.stringify(finalImages),
                        fields.currency,
                        fields.type,
                        JSON.stringify(fields.types),
                        fields.location,
                        fields.address,
                        fields.rooms,
                        fields.area,
                        fields.phone,
                        id
                    ]
                );

                // Olib tashlangan rasmlar bazada qolib ketmasin
                if (removedImages.length) {

                    await client.query(
                        `DELETE FROM image_files WHERE name = ANY($1::text[])`,
                        [removedImages]
                    );
                }

                await client.query('COMMIT');

                return sendJson(res, 200, {
                    ok: true,
                    car: carOut(updated.rows[0])
                });

            } catch (e) {

                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error('EDIT CAR ERROR:', e);

                if (e instanceof UserError) {
                    return sendJson(res, 400, { error: e.message });
                }

                return sendJson(res, 500, {
                    error: 'Tahrirlashda xatolik'
                });

            } finally {

                client.release();
            }
        }

        // =================================================
        // GET SETTINGS
        // =================================================

        if (url === '/api/settings' && req.method === 'GET') {

            const result = await pool.query(`
                SELECT phone, telegram, whatsapp, instagram, address
                FROM site_settings
                WHERE id = 1
            `);

            const row = result.rows[0];

            if (!row) {

                return sendJson(res, 200, {
                    settings: {
                        phone: '+998 88 950 00 05',
                        telegram: 'https://t.me/',
                        whatsapp: 'https://wa.me/',
                        instagram: 'https://instagram.com/',
                        address: "Toshkent, O'zbekiston"
                    }
                });
            }

            return sendJson(res, 200, { settings: settingsOut(row) });
        }

        // =================================================
        // SAVE SETTINGS
        // =================================================

        if (url === '/api/settings' && req.method === 'POST') {

            if (!isAdmin(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            let body;

            try {

                body = parseJsonObject(await readBody(req, 100000), false);

            } catch (e) {

                return sendJson(res, 400, {
                    error: "Ma'lumot formati noto'g'ri"
                });
            }

            const phone = String(body.phone || '').trim().slice(0, 50);
            const telegram = String(body.telegram || '').trim().slice(0, 500);
            const whatsapp = String(body.whatsapp || '').trim().slice(0, 500);
            const instagram = String(body.instagram || '').trim().slice(0, 500);
            const address = String(body.address || '').trim().slice(0, 300);

            if (!phone) {
                return sendJson(res, 400, {
                    error: 'Telefon raqamini kiriting'
                });
            }

            // Havolalarda xavfli sxemalar (javascript: va h.k.) bo'lmasligi kerak
            const unsafeLink = /^\s*(javascript|data|vbscript):/i;

            if (
                unsafeLink.test(telegram) ||
                unsafeLink.test(whatsapp) ||
                unsafeLink.test(instagram)
            ) {
                return sendJson(res, 400, {
                    error: "Havola noto'g'ri"
                });
            }

            const result = await pool.query(
                `
                UPDATE site_settings
                SET
                    phone = $1,
                    telegram = $2,
                    whatsapp = $3,
                    instagram = $4,
                    address = $5
                WHERE id = 1
                RETURNING phone, telegram, whatsapp, instagram, address
                `,
                [phone, telegram, whatsapp, instagram, address]
            );

            return sendJson(res, 200, {
                ok: true,
                settings: settingsOut(result.rows[0])
            });
        }

        // =================================================
        // TOGGLE SOLD
        // =================================================

        if (/^\/api\/cars\/\d+\/sold$/.test(url) && req.method === 'POST') {

            if (!isAdmin(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            const id = Number(url.split('/')[3]);

            if (!Number.isInteger(id) || id <= 0) {
                return sendJson(res, 400, { error: "ID noto'g'ri" });
            }

            const result = await pool.query(
                `
                UPDATE cars
                SET sold = NOT sold
                WHERE id = $1
                RETURNING *
                `,
                [id]
            );

            if (result.rows.length === 0) {
                return sendJson(res, 404, { error: 'Uy topilmadi' });
            }

            return sendJson(res, 200, {
                ok: true,
                sold: Boolean(result.rows[0].sold),
                car: carOut(result.rows[0])
            });
        }

        // =================================================
        // DELETE CAR
        // =================================================

        if (/^\/api\/cars\/\d+$/.test(url) && req.method === 'DELETE') {

            if (!isAdmin(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            const id = Number(url.split('/')[3]);

            if (!Number.isInteger(id) || id <= 0) {
                return sendJson(res, 400, { error: "ID noto'g'ri" });
            }

            const client = await pool.connect();

            try {

                await client.query('BEGIN');

                const result = await client.query(
                    `SELECT images FROM cars WHERE id = $1`,
                    [id]
                );
                               if (result.rows.length === 0) {

                    await client.query('ROLLBACK');

                    return sendJson(res, 404, { error: 'Uy topilmadi' });
                }

                const images = parseImages(result.rows[0]);

                for (const name of images) {

                    await client.query(
                        `DELETE FROM image_files WHERE name = $1`,
                        [name]
                    );
                }

                await client.query(
                    `DELETE FROM cars WHERE id = $1`,
                    [id]
                );

                await client.query('COMMIT');

                return sendJson(res, 200, { ok: true });

            } catch (e) {

                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error('DELETE CAR ERROR:', e);

                return sendJson(res, 500, {
                    error: "O'chirishda xatolik"
                });

            } finally {

                client.release();
            }
        }

        // =================================================
        // GET IMAGE
        // =================================================

        if (url.startsWith('/uploads/') && req.method === 'GET') {

            const name = url.slice('/uploads/'.length);

            if (!/^[a-f0-9]{32}\.jpg$/.test(name)) {

                res.writeHead(404);

                return res.end();
            }

            const result = await pool.query(
                `SELECT data FROM image_files WHERE name = $1`,
                [name]
            );

            if (result.rows.length === 0) {

                res.writeHead(404);

                return res.end();
            }

            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=86400'
            });

            return res.end(result.rows[0].data);
        }

        // =================================================
        // STAT VIEW / CALL
        // =================================================

        if (url === '/api/stats/view' && req.method === 'POST') {

            await pool.query(`
                UPDATE stats SET views = views + 1 WHERE id = 1
            `);

            await recordDailyStat('views');

            return sendJson(res, 200, { ok: true });
        }

        if (url === '/api/stats/call' && req.method === 'POST') {

            await pool.query(`
                UPDATE stats SET calls = calls + 1 WHERE id = 1
            `);

            await recordDailyStat('calls');

            return sendJson(res, 200, { ok: true });
        }

        // =================================================
        // TOTAL STATS
        // =================================================

        if (url === '/api/stats' && req.method === 'GET') {

            if (!isAdminHeader(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            const result = await pool.query(`
                SELECT views, calls FROM stats WHERE id = 1
            `);

            const row = result.rows[0] || { views: 0, calls: 0 };

            const carsResult = await pool.query(`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE sold = true)::int AS sold
                FROM cars
            `);

            const cars = carsResult.rows[0] || { total: 0, sold: 0 };

            return sendJson(res, 200, {
                views: Number(row.views) || 0,
                calls: Number(row.calls) || 0,
                cars: Number(cars.total) || 0,
                sold: Number(cars.sold) || 0
            });
        }

        // =================================================
        // RESET TOTAL VIEWS (daily_stats ga tegilmaydi)
        // =================================================

        if (url === '/api/stats/reset-views' && req.method === 'POST') {

            if (!isAdmin(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            await pool.query(`
                UPDATE stats SET views = 0 WHERE id = 1
            `);

            return sendJson(res, 200, { ok: true, views: 0 });
        }

        // =================================================
        // DAILY STATS
        // =================================================

        if (url === '/api/stats/daily' && req.method === 'GET') {

            if (!isAdminHeader(req)) {
                return sendJson(res, 401, UNAUTHORIZED);
            }

            const result = await pool.query(`
                SELECT stat_date, views, calls
                FROM daily_stats
                WHERE stat_date >= CURRENT_DATE - INTERVAL '29 days'
                ORDER BY stat_date ASC
            `);

            return sendJson(res, 200, {
                days: result.rows.map(row => ({
                    date: row.stat_date,
                    views: Number(row.views) || 0,
                    calls: Number(row.calls) || 0
                }))
            });
        }

        // =================================================
        // SAHIFALAR
        // =================================================

        if (url === '/admin' || url === '/admin.html') {
            return sendFile(res, 'admin.html');
        }

        if (url === '/' || url === '/index.html') {
            return sendFile(res, 'index.html');
        }

        if (
            req.method === 'GET' &&
            (url.endsWith('.css') || url.endsWith('.js'))
        ) {
            return sendFile(res, url.replace(/^\/+/, ''));
        }

        return sendJson(res, 404, { error: 'Sahifa topilmadi' });

    } catch (e) {

        console.error('SERVER ERROR:', e);

        if (res.headersSent) {
            return res.end();
        }

        return sendJson(res, 500, { error: 'Server xatosi' });
    }
});

// =====================================================
// START SERVER
// =====================================================

async function start() {

    try {

        await initDatabase();

        const PORT = Number(process.env.PORT) || 3000;

        server.listen(PORT, () => {

            console.log(`Server ${PORT}-portda ishlayapti`);
            console.log('Admin: parol + Telegram kodi tekshiruvi faol');

            telegramPolling();
        });

    } catch (error) {

        console.error('Database ulanishida xatolik:', error);

        process.exit(1);
    }
}

start();

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function shutdown(signal) {

    console.log(`${signal}: Server to'xtatilmoqda...`);

    try {

        telegramStopped = true;

        server.close();

        await pool.end();

        process.exit(0);

    } catch (e) {

        console.error('Shutdown xatosi:', e);

        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => {
    console.error('UNHANDLED REJECTION:', reason);
}); 
                        
