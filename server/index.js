const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// =====================================================
// ADMIN PASSWORD
// =====================================================

const ADMIN_PASSWORD = String(
    process.env.ADMIN_PASSWORD || ''
).trim();

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL topilmadi!');
    process.exit(1);
}

if (!ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD topilmadi!');
    process.exit(1);
}

// =====================================================
// DATABASE
// =====================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

// =====================================================
// DATABASE INIT
// =====================================================

async function initDatabase() {

    // -------------------------------------------------
    // CARS
    // -------------------------------------------------

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cars (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            price INTEGER NOT NULL DEFAULT 0,
            description TEXT DEFAULT '',
            images TEXT DEFAULT '[]',
            sold BOOLEAN DEFAULT false,
            currency TEXT DEFAULT 'UZS',
            type TEXT DEFAULT '',
            types TEXT DEFAULT '[]',
            location TEXT DEFAULT '',
            address TEXT DEFAULT '',
            rooms INTEGER DEFAULT 0,
            area INTEGER DEFAULT 0,
            phone TEXT DEFAULT ''
        )
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS sold BOOLEAN DEFAULT false
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'UZS'
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS type TEXT DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS types TEXT DEFAULT '[]'
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS location TEXT DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS address TEXT DEFAULT ''
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS rooms INTEGER DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS area INTEGER DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''
    `);

    // -------------------------------------------------
    // IMAGE FILES
    // -------------------------------------------------

    await pool.query(`
        CREATE TABLE IF NOT EXISTS image_files (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            data BYTEA NOT NULL
        )
    `);

    // -------------------------------------------------
    // TOTAL STATS
    // -------------------------------------------------

    await pool.query(`
        CREATE TABLE IF NOT EXISTS stats (
            id INTEGER PRIMARY KEY DEFAULT 1,
            views INTEGER DEFAULT 0,
            calls INTEGER DEFAULT 0
        )
    `);

    await pool.query(`
        INSERT INTO stats (
            id,
            views,
            calls
        )
        VALUES (
            1,
            0,
            0
        )
        ON CONFLICT (id) DO NOTHING
    `);

    // -------------------------------------------------
    // DAILY STATS
    // -------------------------------------------------

    await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_stats (
            stat_date DATE PRIMARY KEY,
            views INTEGER DEFAULT 0,
            calls INTEGER DEFAULT 0
        )
    `);

    // -------------------------------------------------
    // SITE SETTINGS
    // -------------------------------------------------

    await pool.query(`
        CREATE TABLE IF NOT EXISTS site_settings (
            id INTEGER PRIMARY KEY DEFAULT 1,
            phone TEXT DEFAULT '+998 88 950 00 05',
            telegram TEXT DEFAULT 'https://t.me/',
            whatsapp TEXT DEFAULT 'https://wa.me/',
            instagram TEXT DEFAULT 'https://instagram.com/',
            address TEXT DEFAULT 'Toshkent, O''zbekiston'
        )
    `);

    await pool.query(`
        INSERT INTO site_settings (
            id,
            phone,
            telegram,
            whatsapp,
            instagram,
            address
        )
        VALUES (
            1,
            '+998 88 950 00 05',
            'https://t.me/',
            'https://wa.me/',
            'https://instagram.com/',
            'Toshkent, O''zbekiston'
        )
        ON CONFLICT (id) DO NOTHING
    `);

    console.log('PostgreSQL database tayyor');
}

// =====================================================
// JSON RESPONSE
// =====================================================

function sendJson(res, status, data) {

    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });

    res.end(
        JSON.stringify(data)
    );
}

// =====================================================
// FILE RESPONSE
// =====================================================

function sendFile(res, name) {

    const safeName = path.basename(name);

    const file = path.join(
        __dirname,
        'public',
        safeName
    );

    if (!fs.existsSync(file)) {

        res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        return res.end(
            'File topilmadi'
        );
    }

    let contentType =
        'text/html; charset=utf-8';

    if (safeName.endsWith('.css')) {

        contentType =
            'text/css; charset=utf-8';
    }

    if (safeName.endsWith('.js')) {

        contentType =
            'application/javascript; charset=utf-8';
    }

    if (safeName.endsWith('.json')) {

        contentType =
            'application/json; charset=utf-8';
    }

    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
    });

    res.end(
        fs.readFileSync(file)
    );
}

// =====================================================
// READ BODY
// =====================================================

function readBody(req) {

    return new Promise(
        (resolve, reject) => {

            let data = '';
            let totalLength = 0;
            let finished = false;

            req.on(
                'data',
                chunk => {

                    if (finished) {
                        return;
                    }

                    totalLength += chunk.length;

                    if (totalLength > 30000000) {

                        finished = true;

                        reject(
                            new Error(
                                "Ma'lumot juda katta"
                            )
                        );

                        req.destroy();

                        return;
                    }

                    data += chunk.toString();
                }
            );

            req.on(
                'end',
                () => {

                    if (!finished) {

                        finished = true;

                        resolve(data);
                    }
                }
            );

            req.on(
                'error',
                error => {

                    if (!finished) {

                        finished = true;

                        reject(error);
                    }
                }
            );
        }
    );
}

// =====================================================
// PASSWORD
// =====================================================

function normalizePassword(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return '';
    }

    return String(value).trim();
}

// =====================================================
// SAFE PASSWORD COMPARE
// =====================================================

function passwordMatches(value) {

    const input =
        normalizePassword(value);

    if (!input) {
        return false;
    }

    const a =
        Buffer.from(input);

    const b =
        Buffer.from(ADMIN_PASSWORD);

    if (a.length !== b.length) {
        return false;
    }

    try {

        return crypto.timingSafeEqual(
            a,
            b
        );

    } catch (e) {

        return false;
    }
}

// =====================================================
// ADMIN HEADER
// =====================================================

// =====================================================
// ADMIN (3 TA URINISH)
// =====================================================

const MAX_FAILS = 3;
const BLOCK_MS = 15 * 60 * 1000;
const failedAttempts = new Map();

function getIp(req) {

    const fwd = req.headers['x-forwarded-for'];

    if (fwd) {
        return String(fwd).split(',')[0].trim();
    }

    return req.socket.remoteAddress || 'unknown';
}

function isBlocked(req) {

    const ip = getIp(req);
    const rec = failedAttempts.get(ip);

    if (!rec) {
        return false;
    }

    if (Date.now() - rec.first > BLOCK_MS) {

        failedAttempts.delete(ip);

        return false;
    }

    return rec.count >= MAX_FAILS;
}

function registerFail(req) {

    const ip = getIp(req);
    const rec = failedAttempts.get(ip);

    if (!rec || Date.now() - rec.first > BLOCK_MS) {

        failedAttempts.set(ip, { count: 1, first: Date.now() });

    } else {

        rec.count++;
    }
}

setInterval(() => {

    const now = Date.now();

    for (const [ip, rec] of failedAttempts) {

        if (now - rec.first > BLOCK_MS) {
            failedAttempts.delete(ip);
        }
    }

}, 60 * 1000).unref();

function checkPassword(req, bodyPassword) {

    if (isBlocked(req)) {
        return false;
    }

    const headerPassword = req.headers['x-admin-password'];

    if (
        passwordMatches(headerPassword) ||
        passwordMatches(bodyPassword)
    ) {

        failedAttempts.delete(getIp(req));

        return true;
    }

    // Parol umuman yuborilmagan bo'lsa, xato hisoblanmaydi
    if (
        normalizePassword(headerPassword) ||
        normalizePassword(bodyPassword)
    ) {
        registerFail(req);
    }

    return false;
}

function isAdminHeader(req) {

    return checkPassword(req, '');
}

function isAdmin(req, body = null) {

    const bodyPassword =
        body && typeof body === 'object'
            ? body.password
            : '';

    return checkPassword(req, bodyPassword);
}

// =====================================================
// INTEGER
// =====================================================

function toInteger(value, fallback = 0) {

    const number =
        Number(value);

    if (
        !Number.isFinite(number) ||
        !Number.isInteger(number)
    ) {
        return fallback;
    }

    return number;
}

// =====================================================
// CURRENCY
// =====================================================

function normalizeCurrency(value) {

    const currency =
        String(
            value || 'UZS'
        )
            .trim()
            .toUpperCase();

    if (
        currency === 'USD'
    ) {
        return 'USD';
    }

    return 'UZS';
}

// =====================================================
// IMAGE PREPARE
// =====================================================

function prepareImage(dataUrl) {

    if (
        typeof dataUrl !== 'string'
    ) {

        throw new Error(
            "Rasm formati noto'g'ri"
        );
    }

    const match =
        /^data:image\/jpeg;base64,(.+)$/i
            .exec(dataUrl);

    if (!match) {

        throw new Error(
            "Rasm JPEG formatda bo'lishi kerak"
        );
    }

    let buffer;

    try {

        buffer =
            Buffer.from(
                match[1],
                'base64'
            );

    } catch (e) {

        throw new Error(
            "Rasmni o'qib bo'lmadi"
        );
    }

    if (!buffer.length) {

        throw new Error(
            "Rasm bo'sh"
        );
    }

    if (
        buffer.length >
        3000000
    ) {

        throw new Error(
            "Bitta rasm 3 MB dan katta bo'lmasligi kerak"
        );
    }

    const imageName =
        crypto
            .randomBytes(16)
            .toString('hex') +
        '.jpg';

    return {
        name: imageName,
        buffer
    };
}

// =====================================================
// PARSE IMAGES
// =====================================================

function parseImages(row) {

    if (
        !row ||
        !row.images
    ) {
        return [];
    }

    if (
        Array.isArray(row.images)
    ) {
        return row.images;
    }

    try {

        const images =
            JSON.parse(
                row.images
            );

        if (
            Array.isArray(images)
        ) {

            return images
                .filter(
                    x =>
                        typeof x === 'string'
                );
        }

    } catch (e) {}

    return [];
}

// =====================================================
// PARSE TYPES
// =====================================================

function parseTypes(row) {

    if (!row) {
        return [];
    }

    if (
        row.types === null ||
        row.types === undefined ||
        row.types === ''
    ) {

        return row.type
            ? [String(row.type)]
            : [];
    }

    try {

        const types =
            JSON.parse(
                row.types
            );

        if (
            Array.isArray(types)
        ) {

            return types
                .map(
                    x =>
                        String(x).trim()
                )
                .filter(Boolean)
                .slice(0, 3);
        }

    } catch (e) {}

    return row.type
        ? [String(row.type)]
        : [];
}

// =====================================================
// CAR OUTPUT
// =====================================================

function carOut(row) {

    const types =
        parseTypes(row);

    const currency =
        normalizeCurrency(
            row.currency
        );

    return {

        id:
            Number(row.id),

        name:
            row.name || '',

        title:
            row.name || '',

        price:
            Number(row.price) || 0,

        currency:

        currency,

        type:
            row.type ||
            types[0] ||
            '',

        types:

        types,

        location:
            row.location ||
            row.address ||
            '',

        address:
            row.address ||
            row.location ||
            '',

        rooms:
            Number(row.rooms) || 0,

        area:
            Number(row.area) || 0,

        phone:
            row.phone || '',

        description:
            row.description || '',

        images:
            parseImages(row),

        sold:
            Boolean(row.sold),

        status:
            row.sold
                ? 'sold'
                : 'available'
    };
}

// =====================================================
// SETTINGS OUTPUT
// =====================================================

function settingsOut(row) {

    return {

        phone:
            row.phone || '',

        telegram:
            row.telegram || '',

        whatsapp:
            row.whatsapp || '',

        instagram:
            row.instagram || '',

        address:
            row.address || ''
    };
}

// =====================================================
// DAILY STAT
// =====================================================

async function recordDailyStat(type) {

    if (
        type !== 'views' &&
        type !== 'calls'
    ) {
        return;
    }

    await pool.query(
        `
        INSERT INTO daily_stats (
            stat_date,
            views,
            calls
        )
        VALUES (
            CURRENT_DATE,
            $1,
            $2
        )
        ON CONFLICT (stat_date)
        DO UPDATE SET

            views =
                daily_stats.views +
                EXCLUDED.views,

            calls =
                daily_stats.calls +
                EXCLUDED.calls
        `,
        [
            type === 'views'
                ? 1
                : 0,

            type === 'calls'
                ? 1
                : 0
        ]
    );
}

// =====================================================
// TELEGRAM BOT — PREMIUM UY-JOY BOT
// =====================================================

const TELEGRAM_BOT_TOKEN =
    String(
        process.env.TELEGRAM_BOT_TOKEN || ''
    ).trim();

// Render'dagi hozirgi manzil saqlanadi.
// Keyinchalik domen o'zgarsa SITE_URL env orqali almashtirish mumkin.
const SITE_URL =
    String(
        process.env.SITE_URL ||
        'https://avto-shop.onrender.com'
    )
        .trim()
        .replace(/\/+$/, '');

let telegramOffset = 0;
let telegramRunning = false;
let telegramStopped = false;

// =====================================================
// TELEGRAM USER STATE
// =====================================================

const telegramSearchMode = new Map();
const telegramFavorites = new Map();

// Bir foydalanuvchiga nechta uy ko'rsatilishi
const TELEGRAM_PAGE_SIZE = 5;

// =====================================================
// TELEGRAM API
// =====================================================

async function telegramApi(method, body = {}) {

    if (!TELEGRAM_BOT_TOKEN) {
        return null;
    }

    try {

        const response =
            await fetch(
                `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body:
                        JSON.stringify(body)
                }
            );

        const data =
            await response.json();

        if (!data.ok) {

            console.error(
                'Telegram API ERROR:',
                data.description
            );

            return null;
        }

        return data.result;

    } catch (error) {

        console.error(
            'Telegram API NETWORK ERROR:',
            error.message
        );

        return null;
    }
}

// =====================================================
// HTML ESCAPE
// =====================================================

function telegramEscape(value) {

    return String(
        value ?? ''
    )
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// =====================================================
// PRICE
// =====================================================

function telegramPrice(car) {

    const price =
        Number(car.price) || 0;

    if (
        normalizeCurrency(car.currency) === 'USD'
    ) {

        return '$ ' +
            price.toLocaleString('en-US');
    }

    return price.toLocaleString('uz-UZ') +
        " so'm";
}

// =====================================================
// TYPES
// =====================================================

function telegramTypes(car) {

    const types =
        parseTypes(car);

    if (
        types.length
    ) {

        return types
            .map(
                telegramEscape
            )
            .join(', ');
    }

    return 'Ko‘rsatilmagan';
}

// =====================================================
// FAVORITES
// =====================================================

function telegramGetFavorites(chatId) {

    if (
        !telegramFavorites.has(
            String(chatId)
        )
    ) {

        telegramFavorites.set(
            String(chatId),
            new Set()
        );
    }

    return telegramFavorites.get(
        String(chatId)
    );
}

function telegramIsFavorite(
    chatId,
    houseId
) {

    const favorites =
        telegramGetFavorites(
            chatId
        );

    return favorites.has(
        Number(houseId)
    );
}

function telegramToggleFavorite(
    chatId,
    houseId
) {

    const favorites =
        telegramGetFavorites(
            chatId
        );

    const id =
        Number(houseId);

    if (
        favorites.has(id)
    ) {

        favorites.delete(id);

        return false;
    }

    favorites.add(id);

    return true;
}

// =====================================================
// GET ALL AVAILABLE HOMES
// =====================================================

async function telegramGetCars() {

    const result =
        await pool.query(`
            SELECT *
            FROM cars
            WHERE sold = false
            ORDER BY id DESC
        `);

    return result.rows.map(
        carOut
    );
}

// =====================================================
// GET ONE HOUSE
// =====================================================

async function telegramGetHouse(
    houseId
) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM cars
            WHERE id = $1
            LIMIT 1
            `,
            [
                Number(houseId)
            ]
        );

    if (
        result.rows.length === 0
    ) {

        return null;
    }

    return carOut(
        result.rows[0]
    );
}

// =====================================================
// MAIN MENU
// =====================================================

async function telegramStart(
    chatId,
    firstName = ''
) {

    const name =
        String(firstName || '').trim();

    let greeting =
        '🏠 <b>Uy-Joy</b>';

    if (name) {

        greeting +=
            `\n\nAssalomu alaykum, <b>${telegramEscape(name)}</b>!`;
    }

    const text =
        `${greeting}\n\n` +
        '🏡 Uy, hovli va yerlarni qulay tarzda toping.\n\n' +
        'Kerakli bo‘limni tanlang 👇';

    await telegramApi(
        'sendMessage',
        {
            chat_id: chatId,

            text,

            parse_mode: 'HTML',

            reply_markup: {
                inline_keyboard: [

                    [
                        {
                            text:
                                '🏠 Uylarni ko‘rish',

                            callback_data:
                                'homes'
                        }
                    ],

                    [
                        {
                            text:
                                '🔎 Uy qidirish',

                            callback_data:
                                'search'
                        },

                        {
                            text:
                                '⭐ Saqlanganlar',

                            callback_data:
                                'favorites'
                        }
                    ],

                    [
                        {
                            text:
                                '📢 Yangi e’lonlar',

                            callback_data:
                                'newest'
                        }
                    ],

                    [
                        {
                            text:
                                '📞 Bog‘lanish',

                            callback_data:
                                'contact'
                        },

                        {
                            text:
                                '🌐 Sayt',

                            url:
                                SITE_URL
                        }
                    ]

                ]
            }
        }
    );
}

// =====================================================
// MENU MESSAGE
// =====================================================

async function telegramMenu(
    chatId
) {

    await telegramStart(
        chatId
    );
}

// =====================================================
// HOME LIST MESSAGE
// =====================================================

async function telegramSendHomes(
    chatId,
    page = 0
) {

    const cars =
        await telegramGetCars();

    if (!cars.length) {

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '🏠 <b>Hozircha uylar mavjud emas.</b>\n\n' +
                    'Yangi e’lonlar qo‘shilganda yana tekshirib ko‘ring.',

                parse_mode: 'HTML',

                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text:
                                    '🔄 Yangilash',

                                callback_data:
                                    'homes'
                            }
                        ],
                        [
                            {
                                text:
                                    '🏠 Bosh menyu',

                                callback_data:
                                    'menu'
                            }
                        ]
                    ]
                }
            }
        );

        return;
    }

    const totalPages =
        Math.ceil(
            cars.length /
            TELEGRAM_PAGE_SIZE
        );

    let currentPage =
        Number(page) || 0;

    if (
        currentPage < 0
    ) {
        currentPage = 0;
    }

    if (
        currentPage >= totalPages
    ) {
        currentPage =
            totalPages - 1;
    }

    const start =
        currentPage *
        TELEGRAM_PAGE_SIZE;

    const items =
        cars.slice(
            start,
            start + TELEGRAM_PAGE_SIZE
        );

    let text =
        '🏠 <b>UY-JOY KATALOGI</b>\n\n';

    text +=
        `📊 Jami: <b>${cars.length}</b> ta uy\n`;

    text +=
        `📄 Sahifa: <b>${currentPage + 1}/${totalPages}</b>\n\n`;

    const buttons = [];

    for (
        let i = 0;
        i < items.length;
        i++
    ) {

        const car =
            items[i];

        const number =
            start + i + 1;

        text +=
            `<b>${number}.</b> 🏠 ` +
            `<b>${telegramEscape(
                car.name || 'Uy'
            )}</b>\n`;

        text +=
            `💰 ${telegramEscape(
                telegramPrice(car)
            )}\n`;

        if (
            car.address
        ) {

            text +=
                `📍 ${telegramEscape(
                    car.address
                )}\n`;
        }

        text += '\n';

        buttons.push([
            {
                text:
                    `🏠 ${number}-uy`,

                callback_data:
                    `house_${car.id}`
            }
        ]);
    }

    const navigation = [];

    if (
        currentPage > 0
    ) {

        navigation.push({
            text:
                '◀️ Oldingi',

            callback_data:
                `homes_${currentPage - 1}`
        });
    }

    navigation.push({
        text:
            `📄 ${currentPage + 1}/${totalPages}`,

        callback_data:
            'noop'
    });

    if (
        currentPage <
        totalPages - 1
    ) {

        navigation.push({
            text:
                'Keyingi ▶️',

            callback_data:
                `homes_${currentPage + 1}`
        });
    }

    buttons.push(
        navigation
    );

    buttons.push([
        {
            text:
                '🔎 Qidirish',

            callback_data:
                'search'
        },

        {
            text:
                '⭐ Saqlangan',

            callback_data:
                'favorites'
        }
    ]);

    buttons.push([
        {
            text:
                '🏠 Bosh menyu',

            callback_data:
                'menu'
        }
    ]);

    await telegramApi(
        'sendMessage',
        {
            chat_id: chatId,

            text,

            parse_mode: 'HTML',

            reply_markup: {
                inline_keyboard:
                    buttons
            }
        }
    );
}

// =====================================================
// NEWEST HOMES
// =====================================================

async function telegramNewest(
    chatId
) {

    await telegramSendHomes(
        chatId,
        0
    );
}

// =====================================================
// SEARCH START
// =====================================================

async function telegramSearchStart(
    chatId
) {

    telegramSearchMode.set(
        String(chatId),
        true
    );

    await telegramApi(
        'sendMessage',
        {
            chat_id: chatId,

            text:
                '🔎 <b>Uy qidirish</b>\n\n' +
                'Uy nomi, turi, manzili yoki tavsifidan ' +
                'biror so‘z yozing.\n\n' +
                'Masalan:\n' +
                '• Chilonzor\n' +
                '• hovli\n' +
                '• 4 xona\n' +
                '• Toshkent\n\n' +
                '❌ Bekor qilish uchun /menu yozing.',

            parse_mode: 'HTML'
        }
    );
}

// =====================================================
// SEARCH
// =====================================================

async function telegramSearch(
    chatId,
    query
) {

    const q =
        String(query || '')
            .trim();

    if (!q) {

        await telegramSearchStart(
            chatId
        );

        return;
    }

    telegramSearchMode.delete(
        String(chatId)
    );

    const like =
        `%${q}%`;

    const result =
        await pool.query(
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

    const cars =
        result.rows.map(
            carOut
        );

    if (!cars.length) {

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    `🔎 <b>"${telegramEscape(q)}"</b> bo‘yicha uy topilmadi.\n\n` +
                    'Boshqa so‘z bilan qayta urinib ko‘ring.',

                parse_mode: 'HTML',

                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text:
                                    '🔎 Qayta qidirish',

                                callback_data:
                                    'search'
                            }
                        ],
                        [
                            {
                                text:
                                    '🏠 Uylar',

                                callback_data:
                                    'homes'
                            }
                        ]
                    ]
                }
            }
        );

        return;
    }

    let text =
        `🔎 <b>Qidiruv natijalari</b>\n\n`;

    text +=
        `"<b>${telegramEscape(q)}</b>" bo‘yicha ` +
        `<b>${cars.length}</b> ta natija.\n\n`;

    const buttons = [];

    cars.forEach(
        (car, index) => {

            text +=
                `<b>${index + 1}.</b> ` +
                `🏠 ${telegramEscape(
                    car.name || 'Uy'
                )}\n`;

            text +=
                `💰 ${telegramEscape(
                    telegramPrice(car)
                )}\n`;

            if (
                car.address
            ) {

                text +=
                    `📍 ${telegramEscape(
                        car.address
                    )}\n`;
            }

            text += '\n';

            buttons.push([
                {
                    text:
                        `🏠 ${index + 1}-uy`,

                    callback_data:
                        `house_${car.id}`
                }
            ]);
        }
    );

    buttons.push([
        {
            text:
                '🔎 Yana qidirish',

            callback_data:
                'search'
        }
    ]);

    buttons.push([
        {
            text:
                '🏠 Bosh menyu',

            callback_data:
                'menu'
        }
    ]);

    await telegramApi(
        'sendMessage',
        {
            chat_id: chatId,

            text,

            parse_mode: 'HTML',

            reply_markup: {
                inline_keyboard:
                    buttons
            }
        }
    );
}

// =====================================================
// FAVORITES LIST
// =====================================================

async function telegramFavoritesList(
    chatId
) {

    const favorites =
        telegramGetFavorites(
            chatId
        );

    const ids =
        Array.from(
            favorites
        );

    if (!ids.length) {

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '⭐ <b>Saqlangan uylar</b>\n\n' +
                    'Hozircha saqlangan uylar yo‘q.\n\n' +
                    'Yoqtirgan uyingizni ochib, ' +
                    '⭐ Saqlash tugmasini bosing.',

                parse_mode: 'HTML',

                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text:
                                    '🏠 Uylarni ko‘rish',

                                callback_data:
                                    'homes'
                            }
                        ],
                        [
                            {
                                text:
                                    '🏠 Bosh menyu',

                                callback_data:
                                    'menu'
                            }
                        ]
                    ]
                }
            }
        );

        return;
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM cars
            WHERE id = ANY($1::int[])
              AND sold = false
            ORDER BY id DESC
            `,
            [ids]
        );

    const cars =
        result.rows.map(
            carOut
        );

    if (!cars.length) {

        favorites.clear();

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '⭐ Saqlangan uylar hozircha mavjud emas.',

                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text:
                                    '🏠 Uylarni ko‘rish',

                                callback_data:
                                    'homes'
                            }
                        ]
                    ]
                }
            }
        );

        return;
    }

    let text =
        '⭐ <b>SAQLANGAN UYLAR</b>\n\n';

    const buttons = [];

    cars.forEach(
        (car, index) => {

            text +=
                `<b>${index + 1}.</b> ` +
                `🏠 ${telegramEscape(
                    car.name || 'Uy'
                )}\n`;

            text +=
                `💰 ${telegramEscape(
                    telegramPrice(car)
                )}\n\n`;

            buttons.push([
                {
                    text:
                        `🏠 ${index + 1}-uy`,

                    callback_data:
                        `house_${car.id}`
                }
            ]);
        }
    );

    buttons.push([
        {
            text:
                '🏠 Uylar',

            callback_data:
                'homes'
        },

        {
            text:
                '🏠 Bosh menyu',

            callback_data:
                'menu'
        }
    ]);

    await telegramApi(
        'sendMessage',
        {
            chat_id: chatId,

            text,

            parse_mode: 'HTML',

            reply_markup: {
                inline_keyboard:
                    buttons
            }
        }
    );
}

// =====================================================
// CONTACT
// =====================================================

async function telegramContact(
    chatId
) {

    try {

        const result =
            await pool.query(`
                SELECT
                    phone,
                    telegram,
                    whatsapp,
                    instagram,
                    address
                FROM site_settings
                WHERE id = 1
            `);

        const settings =
            result.rows[0];

        if (!settings) {

            await telegramApi(
                'sendMessage',
                {
                    chat_id: chatId,

                    text:
                        '📞 Bog‘lanish ma’lumotlari mavjud emas.'
                }
            );

            return;
        }

        let text =
            '📞 <b>BOG‘LANISH</b>\n\n';

        if (
            settings.phone
        ) {

            text +=
                `📱 Telefon: <b>${telegramEscape(
                    settings.phone
                )}</b>\n`;
        }

        if (
            settings.address
        ) {

            text +=
                `📍 Manzil: ${telegramEscape(
                    settings.address
                )}\n`;
        }

        const buttons = [];

        if (
            settings.phone
        ) {

            const phone =
                String(
                    settings.phone
                )
                    .replace(
                        /[^\d+]/g,
                        ''
                    );

            if (phone) {

                buttons.push([
                    {
                        text:
                            '📞 Telefon qilish',

                        url:
                            `tel:${phone}`
                    }
                ]);
            }
        }

        if (
            settings.telegram
        ) {

            let link =
                String(
                    settings.telegram
                ).trim();

            if (
                link.startsWith('@')
            ) {

                link =
                    'https://t.me/' +
                    link.slice(1);

            } else if (
                !link.startsWith('http://') &&
                !link.startsWith('https://')
            ) {

                link =
                    'https://t.me/' +
                    link;
            }

            buttons.push([
                {
                    text:
                        '✈️ Telegram orqali yozish',

                    url:
                        link
                }
            ]);
        }

        if (
            settings.whatsapp
        ) {

            let whatsapp =
                String(
                    settings.whatsapp
                ).trim();

            if (
                !whatsapp.startsWith('http://') &&
                !whatsapp.startsWith('https://')
            ) {

                whatsapp =
                    'https://wa.me/' +
                    whatsapp.replace(
                        /\D/g,
                        ''
                    );
            }

            buttons.push([
                {
                    text:
                        '💬 WhatsApp',

                    url:
                        whatsapp
                }
            ]);
        }

        buttons.push([
            {
                text:
                    '🌐 Sayt',

                url:
                    SITE_URL
            }
        ]);

        buttons.push([
            {
                text:
                    '🏠 Bosh menyu',

                callback_data:
                    'menu'
            }
        ]);

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text,

                parse_mode: 'HTML',

                reply_markup: {
                    inline_keyboard:
                        buttons
                }
            }
        );

    } catch (error) {

        console.error(
            'Telegram contact xatosi:',
            error.message
        );

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '❌ Bog‘lanish ma’lumotlarini olishda xatolik yuz berdi.'
            }
        );
    }
}

// =====================================================
// HOUSE DETAILS
// =====================================================

async function telegramHouse(
    chatId,
    houseId
) {

    const car =
        await telegramGetHouse(
            houseId
        );

    if (!car) {

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text:
                    '❌ Bu uy topilmadi.'
            }
        );

        return;
    }

    let text =
        `🏠 <b>${telegramEscape(
            car.name || 'Uy'
        )}</b>\n\n`;

    text +=
        `💰 <b>${telegramEscape(
            telegramPrice(car)
        )}</b>\n`;

    text +=
        `🏷 Turi: ${telegramTypes(car)}\n`;

    if (
        car.rooms > 0
    ) {

        text +=
            `🚪 Xonalar: <b>${car.rooms}</b> ta\n`;
    }

    if (
        car.area > 0
    ) {

        text +=
            `📐 Maydon: <b>${car.area}</b> m²\n`;
    }

    if (
        car.address
    ) {

        text +=
            `📍 Manzil: ${telegramEscape(
                car.address
            )}\n`;
    }

    if (
        car.phone
    ) {

        text +=
            `📞 Telefon: ${telegramEscape(
                car.phone
            )}\n`;
    }

    if (
        car.description
    ) {

        let description =
            String(
                car.description
            )
                .replace(
                    /\s+/g,
                    ' '
                )
                .trim();

        if (
            description
        ) {

            text +=
                `\n📝 <b>Tavsif</b>\n`;

            text +=
                telegramEscape(
                    description.slice(
                        0,
                        700
                    )
                );

            if (
                description.length > 700
            ) {

                text +=
                    '...';
            }

            text += '\n';
        }
    }

    const favorite =
        telegramIsFavorite(
            chatId,
            car.id
        );

    const favoriteText =
        favorite
            ? '💛 Saqlangan'
            : '⭐ Saqlash';

    const buttons = [];

    buttons.push([
        {
            text:
                favoriteText,

            callback_data:
                `fav_${car.id}`
        }
    ]);

    buttons.push([
        {
            text:
                '🌐 Saytda ko‘rish',

            url:
                `${SITE_URL}/?house=${car.id}`
        }
    ]);

    buttons.push([
        {
            text:
                '📞 Bog‘lanish',

            callback_data:
                'contact'
        }
    ]);

    buttons.push([
        {
            text:
                '🏠 Uylar',

            callback_data:
                'homes'
        },

        {
            text:
                '🏠 Bosh menyu',

            callback_data:
                'menu'
        }
    ]);

    const images =
        Array.isArray(
            car.images
        )
            ? car.images
            : [];

    const firstImage =
        images.length
            ? images[0]
            : '';

    if (
        firstImage &&
        SITE_URL
    ) {

        const imageUrl =
            `${SITE_URL}/uploads/${encodeURIComponent(
                firstImage
            )}`;

        await telegramApi(
            'sendPhoto',
            {
                chat_id: chatId,

                photo:
                    imageUrl,

                caption:
                    text,

                parse_mode:
                    'HTML',

                reply_markup: {
                    inline_keyboard:
                        buttons
                }
            }
        );

    } else {

        await telegramApi(
            'sendMessage',
            {
                chat_id: chatId,

                text,

                parse_mode:
                    'HTML',

                reply_markup: {
                    inline_keyboard:
                        buttons
                }
            }
        );
    }
}

// =====================================================
// CALLBACK
// =====================================================

async function telegramCallback(
    query
) {

    const chatId =
        query.message &&
        query.message.chat
            ? query.message.chat.id
            : null;

    if (!chatId) {
        return;
    }

    await telegramApi(
        'answerCallbackQuery',
        {
            callback_query_id:
                query.id
        }
    );

    const data =
        String(
            query.data || ''
        );

    // -----------------------------------------------
    // NOOP
    // -----------------------------------------------

    if (
        data === 'noop'
    ) {
        return;
    }

    // -----------------------------------------------
    // MENU
    // -----------------------------------------------

    if (
        data === 'menu'
    ) {

        await telegramMenu(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // HOMES
    // -----------------------------------------------

    if (
        data === 'homes'
    ) {

        await telegramSendHomes(
            chatId,
            0
        );

        return;
    }

    // -----------------------------------------------
    // PAGINATION
    // -----------------------------------------------

    if (
        data.startsWith('homes_')
    ) {

        const page =
            Number(
                data.replace(
                    'homes_',
                    ''
                )
            );

        await telegramSendHomes(
            chatId,
            Number.isFinite(page)
                ? page
                : 0
        );

        return;
    }

    // -----------------------------------------------
    // SEARCH
    // -----------------------------------------------

    if (
        data === 'search'
    ) {

        await telegramSearchStart(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // FAVORITES
    // -----------------------------------------------

    if (
        data === 'favorites'
    ) {

        await telegramFavoritesList(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // NEWEST
    // -----------------------------------------------

    if (
        data === 'newest'
    ) {

        await telegramNewest(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // CONTACT
    // -----------------------------------------------

    if (
        data === 'contact'
    ) {

        await telegramContact(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // FAVORITE TOGGLE
    // -----------------------------------------------

    if (
        data.startsWith('fav_')
    ) {

        const houseId =
            Number(
                data.replace(
                    'fav_',
                    ''
                )
            );

        if (
            !Number.isInteger(
                houseId
            )
        ) {
            return;
        }

        const state =
            telegramToggleFavorite(
                chatId,
                houseId
            );

        await telegramApi(
            'answerCallbackQuery',
            {
                callback_query_id:
                    query.id,

                text:
                    state
                        ? '⭐ Uy saqlandi'
                        : '🗑 Saqlanganlardan olib tashlandi',

                show_alert: false
            }
        );

        return;
    }

    // -----------------------------------------------
    // HOUSE
    // -----------------------------------------------

    if (
        data.startsWith('house_')
    ) {

        const houseId =
            Number(
                data.replace(
                    'house_',
                    ''
                )
            );

        if (
            !Number.isInteger(
                houseId
            )
        ) {
            return;
        }

        await telegramHouse(
            chatId,
            houseId
        );

        return;
    }
}

// =====================================================
// UPDATE HANDLER
// =====================================================

async function telegramHandleUpdate(
    update
) {

    // -----------------------------------------------
    // CALLBACK
    // -----------------------------------------------

    if (
        update.callback_query
    ) {

        await telegramCallback(
            update.callback_query
        );

        return;
    }

    const message =
        update.message;

    if (!message) {
        return;
    }

    const chatId =
        message.chat.id;

    const firstName =
        message.from &&
        message.from.first_name
            ? message.from.first_name
            : '';

    const originalText =
        String(
            message.text || ''
        ).trim();

    const text =
        originalText.toLowerCase();

    // -----------------------------------------------
    // SEARCH MODE
    // -----------------------------------------------

    if (
        telegramSearchMode.has(
            String(chatId)
        )
    ) {

        if (
            text === '/menu' ||
            text === '/start'
        ) {

            telegramSearchMode.delete(
                String(chatId)
            );

            await telegramStart(
                chatId,
                firstName
            );

            return;
        }

        await telegramSearch(
            chatId,
            originalText
        );

        return;
    }

    // -----------------------------------------------
    // START
    // -----------------------------------------------

    if (
        text === '/start' ||
        text === '/menu'
    ) {

        await telegramStart(
            chatId,
            firstName
        );

        return;
    }

    // -----------------------------------------------
    // UYLAR
    // -----------------------------------------------

    if (
        text === '/uylar' ||
        text === 'uylar'
    ) {

        await telegramSendHomes(
            chatId,
            0
        );

        return;
    }

    // -----------------------------------------------
    // QIDIRUV
    // -----------------------------------------------

    if (
        text === '/qidiruv' ||
        text === '/qidirish' ||
        text === 'qidiruv'
    ) {

        await telegramSearchStart(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // SAQLANGAN
    // -----------------------------------------------

    if (
        text === '/saqlangan' ||
        text === 'saqlangan'
    ) {

        await telegramFavoritesList(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // ALOQA
    // -----------------------------------------------

    if (
        text === '/aloqa' ||
        text === 'aloqa'
    ) {

        await telegramContact(
            chatId
        );

        return;
    }

    // -----------------------------------------------
    // FALLBACK
    // -----------------------------------------------

    await telegramApi(
        'sendMessage',
        {
            chat_id: chatId,

            text:
                '🏠 <b>Uy-Joy</b>\n\n' +
                'Kerakli bo‘limni tanlang 👇',

            parse_mode: 'HTML',

            reply_markup: {
                inline_keyboard: [

                    [
                        {
                            text:
                                '🏠 Uylarni ko‘rish',

                            callback_data:
                                'homes'
                        }
                    ],

                    [
                        {
                            text:
                                '🔎 Uy qidirish',

                            callback_data:
                                'search'
                        },

                        {
                            text:
                                '⭐ Saqlangan',

                            callback_data:
                                'favorites'
                        }
                    ],

                    [
                        {
                            text:
                                '📞 Bog‘lanish',

                            callback_data:
                                'contact'
                        }
                    ],

                    [
                        {
                            text:
                                '🏠 Bosh menyu',

                            callback_data:
                                'menu'
                        }
                    ]

                ]
            }
        }
    );
}

// =====================================================
// BOT COMMANDS
// =====================================================

async function telegramSetCommands() {

    await telegramApi(
        'setMyCommands',
        {
            commands: [
                {
                    command:
                        'start',

                    description:
                        '🏠 Bosh menyu'
                },

                {
                    command:
                        'uylar',

                    description:
                        '🏠 Uylarni ko‘rish'
                },

                {
                    command:
                        'qidiruv',

                    description:
                        '🔎 Uy qidirish'
                },

                {
                    command:
                        'saqlangan',

                    description:
                        '⭐ Saqlangan uylar'
                },

                {
                    command:
                        'aloqa',

                    description:
                        '📞 Bog‘lanish'
                },

                {
                    command:
                        'menu',

                    description:
                        '🏠 Menyu'
                }
            ]
        }
    );
}

// =====================================================
// POLLING
// =====================================================

async function telegramPolling() {

    if (
        telegramRunning ||
        telegramStopped ||
        !TELEGRAM_BOT_TOKEN
    ) {

        if (
            !TELEGRAM_BOT_TOKEN
        ) {

            console.log(
                'TELEGRAM_BOT_TOKEN mavjud emas. Telegram bot ishga tushirilmadi.'
            );
        }

        return;
    }

    telegramRunning = true;

    console.log(
        'Telegram premium bot ishga tushmoqda...'
    );

    try {

        // Eski webhook bo'lsa olib tashlaymiz
        await telegramApi(
            'deleteWebhook',
            {
                drop_pending_updates:
                    false
            }
        );

        // Bot ma'lumotlari
        const me =
            await telegramApi(
                'getMe'
            );

        if (me) {

            console.log(
                `Telegram bot: @${me.username}`
            );
        }

        // Command menu
        await telegramSetCommands();

        console.log(
            'Telegram bot komandalar o‘rnatildi'
        );

        while (
            !telegramStopped
        ) {

            try {

                const updates =
                    await telegramApi(
                        'getUpdates',
                        {
                            offset:
                                telegramOffset,

                            timeout:
                                25,

                            allowed_updates: [
                                'message',
                                'callback_query'
                            ]
                        }
                    );

                if (
                    !Array.isArray(
                        updates
                    )
                ) {

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                3000
                            )
                    );

                    continue;
                }

                for (
                    const update
                    of updates
                ) {

                    telegramOffset =
                        Number(
                            update.update_id
                        ) + 1;

                    try {

                        await telegramHandleUpdate(
                            update
                        );

                    } catch (error) {

                        console.error(
                            'Telegram update xatosi:',
                            error
                        );
                    }
                }

            } catch (error) {

                console.error(
                    'Telegram polling xatosi:',
                    error.message
                );

                if (
                    error.message &&
                    error.message.includes(
                        'Conflict'
                    )
                ) {

                    console.error(
                        'Telegram Conflict: boshqa polling mavjud. Bot to‘xtatildi.'
                    );

                    telegramStopped = true;

                    break;
                }

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            5000
                        )
                );
            }
        }

    } catch (error) {

        console.error(
            'Telegram bot xatosi:',
            error
        );

    } finally {

        telegramRunning = false;
    }
}

// =====================================================
// SERVER
// =====================================================

const server =
    http.createServer(
        async (req, res) => {

            try {

                const url =
                    req.url.split('?')[0];

                // =================================================
                // CORS / OPTIONS
                // =================================================

                if (
                    req.method === 'OPTIONS'
                ) {

                    res.writeHead(
                        204,
                        {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Methods':
                                'GET,POST,PUT,DELETE,OPTIONS',
                            'Access-Control-Allow-Headers':
                                'Content-Type,X-Admin-Password'
                        }
                    );

                    return res.end();
                }

                // =================================================
                // GET CARS
                // =================================================

                if (
                    url === '/api/cars' &&
                    req.method === 'GET'
                ) {

                    const result =
                        await pool.query(`
                            SELECT *
                            FROM cars
                            ORDER BY id DESC
                        `);

                    return sendJson(
                        res,
                        200,
                        result.rows.map(
                            carOut
                        )
                    );
                }

                // =================================================
                // ADD CAR
                // =================================================

                if (
                    url === '/api/cars' &&
                    req.method === 'POST'
                ) {

                    let body;

                    try {

                        body =
                            JSON.parse(
                                await readBody(req)
                            );

                    } catch (e) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "Ma'lumot formati noto'g'ri"
                            }
                        );
                    }

                    if (
                        !isAdmin(
                            req,
                            body
                        )
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const client =
                        await pool.connect();

                    try {

                        const name =
                            String(
                                body.name ??
                                body.title ??
                                ''
                            )
                                .trim()
                                .slice(
                                    0,
                                    300
                                );

                        const price =
                            toInteger(
                                body.price,
                                -1
                            );

                        const currency =
                            normalizeCurrency(
                                body.currency
                            );

                        const type =
                            String(
                                body.type ||
                                ''
                            )
                                .trim()
                                .slice(
                                    0,
                                    100
                                );

                        let types;

                        if (
                            Array.isArray(
                                body.types
                            )
                        ) {

                            types =
                                body.types
                                    .map(
                                        x =>
                                            String(x)
                                                .trim()
                                    )
                                    .filter(
                                        Boolean
                                    )
                                    .slice(
                                        0,
                                        3
                                    );

                        } else {

                            types =
                                type
                                    ? [type]
                                    : [];
                        }

                        const location =
                            String(
                                body.location ??
                                body.address ??
                                ''
                            )
                                .trim()
                                .slice(
                                    0,
                                    500
                                );

                        const address =
                            String(
                                body.address ??
                                body.location ??
                                ''
                            )
                                .trim()
                                .slice(
                                    0,
                                    500
                                );

                        const rooms =
                            toInteger(
                                body.rooms,
                                0
                            );

                        const area =
                            toInteger(
                                body.area,
                                0
                            );

                        const phone =
                            String(
                                body.phone ||
                                ''
                            )
                                .trim()
                                .slice(
                                    0,
                                    100
                                );

                        const description =
                            String(
                                body.description ||
                                ''
                            )
                                .trim()
                                .slice(
                                    0,
                                    2000
                                );

                        if (
                            !name ||
                            price <= 0
                        ) {

                            return sendJson(
                                res,
                                400,
                                {
                                    error:
                                        "Nom va narxni to'g'ri kiriting"
                                }
                            );
                        }

                        if (
                            rooms < 0 ||
                            area < 0
                        ) {

                            return sendJson(
                                res,
                                400,
                                {
                                    error:
                                        "Xona yoki maydon noto'g'ri"
                                }
                            );
                        }

                        const incomingImages =
                            Array.isArray(
                                body.images
                            )
                                ? body.images
                                : [];

                        if (
                            incomingImages.length >
                            8
                        ) {

                            return sendJson(
                                res,
                                400,
                                {
                                    error:
                                        "Ko'pi bilan 8 ta rasm"
                                }
                            );
                        }

                        const preparedImages =
                            incomingImages.map(
                                prepareImage
                            );

                        await client.query(
                            'BEGIN'
                        );

                        const savedNames = [];

                        for (
                            const image
                            of preparedImages
                            ) {

                            await client.query(
                                `
                                INSERT INTO image_files (
                                    name,
                                    data
                                )
                                VALUES (
                                    $1,
                                    $2
                                )
                                `,
                                [
                                    image.name,
                                    image.buffer
                                ]
                            );

                            savedNames.push(
                                image.name
                            );
                        }

                        const inserted =
                            await client.query(
                                `
                                INSERT INTO cars (
                                    name,
                                    price,
                                    description,
                                    images,
                                    sold,
                                    currency,
                                    type,
                                    types,
                                    location,
                                    address,
                                    rooms,
                                    area,
                                    phone
                                )
                                VALUES (
                                    $1,
                                    $2,
                                    $3,
                                    $4,
                                    false,
                                    $5,
                                    $6,
                                    $7,
                                    $8,
                                    $9,
                                    $10,
                                    $11,
                                    $12
                                )
                                RETURNING *
                                `,
                                [
                                    name,
                                    price,
                                    description,
                                    JSON.stringify(
                                        savedNames
                                    ),
                                    currency,
                                    types[0] || '',
                                    JSON.stringify(
                                        types
                                    ),
                                    location,
                                    address,
                                    rooms,
                                    area,
                                    phone
                                ]
                            );

                        await client.query(
                            'COMMIT'
                        );

                        return sendJson(
                            res,
                            201,
                            {
                                ok: true,

                                car:
                                    carOut(
                                        inserted.rows[0]
                                    )
                            }
                        );

                    } catch (e) {

                        try {
                            await client.query(
                                'ROLLBACK'
                            );
                        } catch (_) {}

                        console.error(
                            'ADD CAR ERROR:',
                            e
                        );

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    e.message ||
                                    "Mashina qo'shishda xatolik"
                            }
                        );

                    } finally {

                        client.release();
                    }
                }

                // =================================================
                // EDIT CAR
                // =================================================

                if (
                    /^\/api\/cars\/\d+$/.test(url) &&
                    req.method === 'PUT'
                ) {

                    let body;

                    try {

                        body =
                            JSON.parse(
                                await readBody(req)
                            );

                    } catch (e) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "Ma'lumot formati noto'g'ri"
                            }
                        );
                    }

                    if (
                        !isAdmin(
                            req,
                            body
                        )
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const id =
                        Number(
                            url.split('/')[3]
                        );

                    if (
                        !Number.isInteger(id) ||
                        id <= 0
                    ) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "ID noto'g'ri"
                            }
                        );
                    }

                    const client =
                        await pool.connect();

                    try {

                        const oldResult =
                            await client.query(
                                `
                                SELECT *
                                FROM cars
                                WHERE id = $1
                                `,
                                [id]
                            );

                        if (
                            oldResult.rows.length ===
                            0
                        ) {

                            return sendJson(
                                res,
                                404,
                                {
                                    error:
                                        "Mashina topilmadi"
                                }
                            );
                        }

                        const oldCar =
                            oldResult.rows[0];

                        // -----------------------------------------
                        // NAME
                        // -----------------------------------------

                        const name =
                            String(
                                body.name !== undefined
                                    ? body.name
                                    : (
                                        body.title !== undefined
                                            ? body.title
                                            : oldCar.name
                                    )
                            )
                                .trim()
                                .slice(
                                    0,
                                    300
                                );

                        // -----------------------------------------
                        // PRICE
                        // -----------------------------------------

                        const price =
                            body.price !== undefined
                                ? toInteger(
                                    body.price,
                                    -1
                                )
                                : toInteger(
                                    oldCar.price,
                                    -1
                                );

                        // -----------------------------------------
                        // CURRENCY
                        // -----------------------------------------

                        const currency =
                            body.currency !== undefined
                                ? normalizeCurrency(
                                    body.currency
                                )
                                : normalizeCurrency(
                                    oldCar.currency
                                );

                        // -----------------------------------------
                        // OLD TYPES
                        // -----------------------------------------

                        const oldTypes =
                            parseTypes(
                                oldCar
                            );

                        // -----------------------------------------
                        // TYPE
                        // -----------------------------------------

                        const type =
                            String(
                                body.type !== undefined
                                    ? body.type
                                    : (
                                        oldCar.type ||
                                        oldTypes[0] ||
                                        ''
                                    )
                            )
                                .trim()
                                .slice(
                                    0,
                                    100
                                );

                        // -----------------------------------------
                        // TYPES
                        // -----------------------------------------

                        let types;

                        if (
                            Array.isArray(
                                body.types
                            )
                        ) {

                            types =
                                body.types
                                    .map(
                                        x =>
                                            String(x)
                                                .trim()
                                    )
                                    .filter(
                                        Boolean
                                    )
                                    .slice(
                                        0,
                                        3
                                    );

                        } else {

                            types =
                                type
                                    ? [type]
                                    : oldTypes;
                        }

                        // -----------------------------------------
                        // LOCATION
                        // -----------------------------------------

                        const location =
                            String(
                                body.location !== undefined
                                    ? body.location
                                    : (
                                        body.address !== undefined
                                            ? body.address
                                            : oldCar.location || ''
                                    )
                            )
                                .trim()
                                .slice(
                                    0,
                                    500
                                );

                        // -----------------------------------------
                        // ADDRESS
                        // -----------------------------------------

                        const address =
                            String(
                                body.address !== undefined
                                    ? body.address
                                    : (
                                        body.location !== undefined
                                            ? body.location
                                            : oldCar.address || ''
                                    )
                            )
                                .trim()
                                .slice(
                                    0,
                                    500
                                );

                        // -----------------------------------------
                        // ROOMS
                        // -----------------------------------------

                        const rooms =
                            body.rooms !== undefined
                                ? toInteger(
                                    body.rooms,
                                    0
                                )
                                : toInteger(
                                    oldCar.rooms,
                                    0
                                );

                        // -----------------------------------------
                        // AREA
                        // -----------------------------------------

                        const area =
                            body.area !== undefined
                                ? toInteger(
                                    body.area,
                                    0
                                )
                                : toInteger(
                                    oldCar.area,
                                    0
                                );

                        // -----------------------------------------
                        // PHONE
                        // -----------------------------------------

                        const phone =
                            String(
                                body.phone !== undefined
                                    ? body.phone
                                    : (
                                        oldCar.phone ||
                                        ''
                                    )
                            )
                                .trim()
                                .slice(
                                    0,
                                    100
                                );

                        // -----------------------------------------
                        // DESCRIPTION
                        // -----------------------------------------

                        const description =
                            String(
                                body.description !== undefined
                                    ? body.description
                                    : (
                                        oldCar.description ||
                                        ''
                                    )
                            )
                                .trim()
                                .slice(
                                    0,
                                    2000
                                );

                        // -----------------------------------------
                        // VALIDATION
                        // -----------------------------------------

                        if (
                            !name ||
                            price <= 0
                        ) {

                            return sendJson(
                                res,
                                400,
                                {
                                    error:
                                        "Nom va narxni to'g'ri kiriting"
                                }
                            );
                        }

                        if (
                            rooms < 0 ||
                            area < 0
                        ) {

                            return sendJson(
                                res,
                                400,
                                {
                                    error:
                                        "Xona yoki maydon noto'g'ri"
                                }
                            );
                        }

                        // -----------------------------------------
                        // IMAGES
                        // -----------------------------------------

                        const incomingImages =
                            Array.isArray(
                                body.images
                            )
                                ? body.images
                                : null;

                        await client.query(
                            'BEGIN'
                        );

                        let finalImages =
                            parseImages(
                                oldCar
                            );

                        if (
                            incomingImages !== null
                        ) {

                            if (
                                incomingImages.length >
                                8
                            ) {

                                throw new Error(
                                    "Ko'pi bilan 8 ta rasm"
                                );
                            }

                            const preparedImages =
                                incomingImages.map(
                                    prepareImage
                                );

                            const savedNames = [];

                            for (
                                const image
                                of preparedImages
                                ) {

                                await client.query(
                                    `
                                    INSERT INTO image_files (
                                        name,
                                        data
                                    )
                                    VALUES (
                                        $1,
                                        $2
                                    )
                                    `,
                                    [
                                        image.name,
                                        image.buffer
                                    ]
                                );

                                savedNames.push(
                                    image.name
                                );
                            }

                            for (
                                const oldImage
                                of finalImages
                                ) {

                                if (
                                    typeof oldImage !==
                                    'string'
                                ) {
                                    continue;
                                }

                                await client.query(
                                    `
                                    DELETE FROM image_files
                                    WHERE name = $1
                                    `,
                                    [oldImage]
                                );
                            }

                            finalImages =
                                savedNames;
                        }

                        // -----------------------------------------
                        // UPDATE
                        // -----------------------------------------

                        const updated =
                            await client.query(
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
                                    name,
                                    price,
                                    description,
                                    JSON.stringify(
                                        finalImages
                                    ),
                                    currency,
                                    types[0] || '',
                                    JSON.stringify(
                                        types
                                    ),
                                    location,
                                    address,
                                    rooms,
                                    area,
                                    phone,
                                    id
                                ]
                            );

                        await client.query(
                            'COMMIT'
                        );

                        return sendJson(
                            res,
                            200,
                            {
                                ok: true,

                                car:
                                    carOut(
                                        updated.rows[0]
                                    )
                            }
                        );

                    } catch (e) {

                        try {
                            await client.query(
                                'ROLLBACK'
                            );
                        } catch (_) {}

                        console.error(
                            'EDIT CAR ERROR:',
                            e
                        );

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    e.message ||
                                    "Tahrirlashda xatolik"
                            }
                        );

                    } finally {

                        client.release();
                    }
                }

                // =================================================
                // GET SETTINGS
                // =================================================

                if (
                    url === '/api/settings' &&
                    req.method === 'GET'
                ) {

                    const result =
                        await pool.query(`
                            SELECT
                                phone,
                                telegram,
                                whatsapp,
                                instagram,
                                address
                            FROM site_settings
                            WHERE id = 1
                        `);

                    const row =
                        result.rows[0];

                    if (!row) {

                        return sendJson(
                            res,
                            200,
                            {
                                settings: {
                                    phone:
                                        '+998 88 950 00 05',

                                    telegram:
                                        'https://t.me/',

                                    whatsapp:
                                        'https://wa.me/',

                                    instagram:
                                        'https://instagram.com/',

                                    address:
                                        "Toshkent, O'zbekiston"
                                }
                            }
                        );
                    }

                    return sendJson(
                        res,
                        200,
                        {
                            settings:
                                settingsOut(row)
                        }
                    );
                }

                // =================================================
                // SAVE SETTINGS
                // =================================================

                if (
                    url === '/api/settings' &&
                    req.method === 'POST'
                ) {

                    let body;

                    try {

                        body =
                            JSON.parse(
                                await readBody(req)
                            );

                    } catch (e) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "Ma'lumot formati noto'g'ri"
                            }
                        );
                    }

                    if (
                        !isAdmin(
                            req,
                            body
                        )
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const phone =
                        String(
                            body.phone || ''
                        )
                            .trim()
                            .slice(
                                0,
                                50
                            );

                    const telegram =
                        String(
                            body.telegram || ''
                        )
                            .trim()
                            .slice(
                                0,
                                500
                            );

                    const whatsapp =
                        String(
                            body.whatsapp || ''
                        )
                            .trim()
                            .slice(
                                0,
                                500
                            );

                    const instagram =
                        String(
                            body.instagram || ''
                        )
                            .trim()
                            .slice(
                                0,
                                500
                            );

                    const address =
                        String(
                            body.address || ''
                        )
                            .trim()
                            .slice(
                                0,
                                300
                            );

                    if (!phone) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "Telefon raqamini kiriting"
                            }
                        );
                    }

                    const result =
                        await pool.query(
                            `
                            UPDATE site_settings
                            SET
                                phone = $1,
                                telegram = $2,
                                whatsapp = $3,
                                instagram = $4,
                                address = $5
                            WHERE id = 1
                            RETURNING
                                phone,
                                telegram,
                                whatsapp,
                                instagram,
                                address
                            `,
                            [
                                phone,
                                telegram,
                                whatsapp,
                                instagram,
                                address
                            ]
                        );

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true,

                            settings:
                                settingsOut(
                                    result.rows[0]
                                )
                        }
                    );
                }

                // =================================================
                // TOGGLE SOLD
                // =================================================

                if (
                    /^\/api\/cars\/\d+\/sold$/.test(url) &&
                    req.method === 'POST'
                ) {

                    let body = {};

                    try {

                        const raw =
                            await readBody(req);

                        if (raw) {

                            body =
                                JSON.parse(raw);
                        }

                    } catch (e) {

                        body = {};
                    }

                    if (
                        !isAdmin(
                            req,
                            body
                        )
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const id =
                        Number(
                            url.split('/')[3]
                        );

                    if (
                        !Number.isInteger(id) ||
                        id <= 0
                    ) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "ID noto'g'ri"
                            }
                        );
                    }

                    const result =
                        await pool.query(
                            `
                            UPDATE cars
                            SET sold = NOT sold
                            WHERE id = $1
                            RETURNING *
                            `,
                            [id]
                        );

                    if (
                        result.rows.length === 0
                    ) {

                        return sendJson(
                            res,
                            404,
                            {
                                error:
                                    "Mashina topilmadi"
                            }
                        );
                    }

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true,

                            sold:
                                Boolean(
                                    result.rows[0].sold
                                ),

                            car:
                                carOut(
                                    result.rows[0]
                                )
                        }
                    );
                }

                // =================================================
                // DELETE CAR
                // =================================================

                if (
                    /^\/api\/cars\/\d+$/.test(url) &&
                    req.method === 'DELETE'
                ) {

                    let body = {};

                    try {

                        const raw =
                            await readBody(req);

                        if (raw) {

                            body =
                                JSON.parse(raw);
                        }

                    } catch (e) {

                        body = {};
                    }

                    if (
                        !isAdmin(
                            req,
                            body
                        )
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const id =
                        Number(
                            url.split('/')[3]
                        );

                    if (
                        !Number.isInteger(id) ||
                        id <= 0
                    ) {

                        return sendJson(
                            res,
                            400,
                            {
                                error:
                                    "ID noto'g'ri"
                            }
                        );
                    }

                    const client =
                        await pool.connect();

                    try {

                        await client.query(
                            'BEGIN'
                        );

                        const result =
                            await client.query(
                                `
                                SELECT images
                                FROM cars
                                WHERE id = $1
                                `,
                                [id]
                            );

                        if (
                            result.rows.length === 0
                        ) {

                            await client.query(
                                'ROLLBACK'
                            );

                            return sendJson(
                                res,
                                404,
                                {
                                    error:
                                        "Mashina topilmadi"
                                }
                            );
                        }

                        const images =
                            parseImages(
                                result.rows[0]
                            );

                        for (
                            const name
                            of images
                            ) {

                            await client.query(
                                `
                                DELETE FROM image_files
                                WHERE name = $1
                                `,
                                [name]
                            );
                        }

                        await client.query(
                            `
                            DELETE FROM cars
                            WHERE id = $1
                            `,
                            [id]
                        );

                        await client.query(
                            'COMMIT'
                        );

                        return sendJson(
                            res,
                            200,
                            {
                                ok: true
                            }
                        );

                    } catch (e) {

                        try {
                            await client.query(
                                'ROLLBACK'
                            );
                        } catch (_) {}

                        console.error(
                            'DELETE CAR ERROR:',
                            e
                        );

                        return sendJson(
                            res,
                            500,
                            {
                                error:
                                    "O'chirishda xatolik"
                            }
                        );

                    } finally {

                        client.release();
                    }
                }

                // =================================================
                // GET IMAGE
                // =================================================

                if (
                    url.startsWith('/uploads/') &&
                    req.method === 'GET'
                ) {

                    const name =
                        url.slice(
                            '/uploads/'.length
                        );

                    if (
                        !/^[a-f0-9]{32}\.jpg$/.test(
                            name
                        )
                    ) {

                        res.writeHead(404);

                        return res.end();
                    }

                    const result =
                        await pool.query(
                            `
                            SELECT data
                            FROM image_files
                            WHERE name = $1
                            `,
                            [name]
                        );

                    if (
                        result.rows.length === 0
                    ) {

                        res.writeHead(404);

                        return res.end();
                    }

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'image/jpeg',

                            'Cache-Control':
                                'public, max-age=86400'
                        }
                    );

                    return res.end(
                        result.rows[0].data
                    );
                }

                // =================================================
                // STAT VIEW
                // =================================================

                if (
                    url === '/api/stats/view' &&
                    req.method === 'POST'
                ) {

                    await pool.query(`
                        UPDATE stats
                        SET views = views + 1
                        WHERE id = 1
                    `);

                    await recordDailyStat(
                        'views'
                    );

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true
                        }
                    );
                }

                // =================================================
                // STAT CALL
                // =================================================

                if (
                    url === '/api/stats/call' &&
                    req.method === 'POST'
                ) {

                    await pool.query(`
                        UPDATE stats
                        SET calls = calls + 1
                        WHERE id = 1
                    `);

                    await recordDailyStat(
                        'calls'
                    );

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true
                        }
                    );
                }

                // =================================================
                // TOTAL STATS
                // =================================================

                if (
                    url === '/api/stats' &&
                    req.method === 'GET'
                ) {

                    if (
                        !isAdminHeader(req)
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const result =
                        await pool.query(`
                            SELECT
                                views,
                                calls
                            FROM stats
                            WHERE id = 1
                        `);

                    const row =
                        result.rows[0] || {
                            views: 0,
                            calls: 0
                        };

                    const carsResult =
                        await pool.query(`
                            SELECT
                                COUNT(*)::int AS total,

                                COUNT(*)
                                FILTER (
                                    WHERE sold = true
                                )::int AS sold
                            FROM cars
                        `);

                    const cars =
                        carsResult.rows[0] || {
                            total: 0,
                            sold: 0
                        };

                    return sendJson(
                        res,
                        200,
                        {
                            views:
                                Number(
                                    row.views
                                ) || 0,

                            calls:
                                Number(
                                    row.calls
                                ) || 0,

                            cars:
                                Number(
                                    cars.total
                                ) || 0,

                            sold:
                                Number(
                                    cars.sold
                                ) || 0
                        }
                    );
                }

                // =================================================
                // RESET TOTAL VIEWS
                // =================================================

                if (
                    url === '/api/stats/reset-views' &&
                    req.method === 'POST'
                ) {

                    let body = {};

                    try {

                        const raw =
                            await readBody(req);

                        if (raw) {

                            body =
                                JSON.parse(raw);
                        }

                    } catch (e) {

                        body = {};
                    }

                    // ADMIN PASSWORD
                    if (
                        !isAdmin(
                            req,
                            body
                        )
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    // FAQAT UMUMIY KO'RISHLAR 0 QILINADI.
                    //
                    // daily_stats JADVALIGA TEGILMAYDI.
                    //

                    await pool.query(`
                        UPDATE stats
                        SET views = 0
                        WHERE id = 1
                    `);

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true,
                            views: 0
                        }
                    );
                }

                // =================================================
                // DAILY STATS
                // =================================================

                if (
                    url === '/api/stats/daily' &&
                    req.method === 'GET'
                ) {

                    if (
                        !isAdminHeader(req)
                    ) {

                        return sendJson(
                            res,
                            401,
                            {
                                error:
                                    "Parol noto'g'ri"
                            }
                        );
                    }

                    const result =
                        await pool.query(`
                            SELECT
                                stat_date,
                                views,
                                calls
                            FROM daily_stats
                            WHERE stat_date >=
                                CURRENT_DATE -
                                INTERVAL '29 days'
                            ORDER BY stat_date ASC
                        `);

                    return sendJson(
                        res,
                        200,
                        {
                            days:
                                result.rows.map(
                                    row => ({
                                        date:
                                        row.stat_date,

                                        views:
                                            Number(
                                                row.views
                                            ) || 0,

                                        calls:
                                            Number(
                                                row.calls
                                            ) || 0
                                    })
                                )
                        }
                    );
                }

                // =================================================
                // ADMIN PAGE
                // =================================================

                if (
                    url === '/admin' ||
                    url === '/admin.html'
                ) {

                    return sendFile(
                        res,
                        'admin.html'
                    );
                }

                // =================================================
                // MAIN PAGE
                // =================================================

                if (
                    url === '/' ||
                    url === '/index.html'
                ) {

                    return sendFile(
                        res,
                        'index.html'
                    );
                }

                // =================================================
                // OTHER STATIC FILES
                // =================================================

                if (
                    req.method === 'GET' &&
                    (
                        url.endsWith('.css') ||
                        url.endsWith('.js')
                    )
                ) {

                    const requested =
                        url.replace(
                            /^\/+/,
                            ''
                        );

                    return sendFile(
                        res,
                        requested
                    );
                }

                // =================================================
                // 404
                // =================================================

                return sendJson(
                    res,
                    404,
                    {
                        error:
                            'Sahifa topilmadi'
                    }
                );

            } catch (e) {

                console.error(
                    'SERVER ERROR:',
                    e
                );

                return sendJson(
                    res,
                    500,
                    {
                        error:
                            'Server xatosi'
                    }
                );
            }
        }
    );

// =====================================================
// START SERVER
// =====================================================

async function start() {

    try {

        await initDatabase();

        const PORT =
            Number(
                process.env.PORT
            ) || 3000;

      server.listen(
    PORT,
    () => {

        console.log(
            `Server ${PORT}-portda ishlayapti`
        );

        console.log(
            'Admin password tekshiruvi faol'
        );

       telegramPolling();  
    }
);

    } catch (error) {

        console.error(
            'Database ulanishida xatolik:',
            error
        );

        process.exit(1);
    }
}

start();

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function shutdown(signal) {

    console.log(
        `${signal}: Server to'xtatilmoqda...`
    );

    try {

        server.close();

        await pool.end();

        process.exit(0);

    } catch (e) {

        console.error(
            'Shutdown xatosi:',
            e
        );

        process.exit(1);
    }
}

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);
