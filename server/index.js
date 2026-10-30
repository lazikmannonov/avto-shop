const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('node:util');
const scryptAsync = promisify(crypto.scrypt);

const adminPasswordChangeRequests = new Map();
const adminStatsResetRequests = new Map();

const ADMIN_PASSWORD_CHANGE_TTL_MS = 60 * 1000;
const ADMIN_PASSWORD_CHANGE_MAX_TRIES = 3;

async function hashAdminPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = await scryptAsync(password, salt, 64);

    return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyAdminPasswordHash(password, storedHash) {
    try {
        const [salt, hashHex] = String(storedHash).split(':');

        if (!salt || !/^[a-f0-9]{128}$/i.test(hashHex || '')) {
            return false;
        }

        const expected = Buffer.from(hashHex, 'hex');
        const actual = await scryptAsync(password, salt, 64);

        return expected.length === actual.length &&
            crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}
const { Pool } = require('pg');

// =====================================================
// SOZLAMALAR (Render Environment)
// =====================================================

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

// Domen o'zgarsa SITE_URL env orqali almashtiriladi
const SITE_URL = String(process.env.SITE_URL || 'https://avto-shop.onrender.com')
    .trim()
    .replace(/\/+$/, '');

// Boshqa domendan API'ga murojaat qilishga ruxsat (odatda kerak emas).
// Misol: ALLOWED_ORIGINS=https://uy-joy.uz,https://www.uy-joy.uz
const ALLOWED_ORIGINS = new Set(
    [SITE_URL]
        .concat(
            String(process.env.ALLOWED_ORIGINS || '')
                .split(',')
                .map(s => s.trim().replace(/\/+$/, ''))
        )
        .filter(Boolean)
);

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL topilmadi!');
    process.exit(1);
}

if (!ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD topilmadi!');
    process.exit(1);
}

if (ADMIN_PASSWORD.length < 12) {
    console.warn('OGOHLANTIRISH: ADMIN_PASSWORD 12 belgidan qisqa. Uzunroq parol qo‘ying.');
}

const ADMIN_TG_OK = /^\d+$/.test(ADMIN_TELEGRAM_ID) && Boolean(TELEGRAM_BOT_TOKEN);

if (!ADMIN_TG_OK) {
    console.warn(
        'OGOHLANTIRISH: ADMIN_TELEGRAM_ID (faqat raqam) yoki TELEGRAM_BOT_TOKEN sozlanmagan. ' +
        'Admin panelga kirish kodi yuborilmaydi!'
    );
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

// Bo'sh turgan ulanish uzilsa server yiqilib tushmasligi uchun
pool.on('error', error => {
    console.error('PostgreSQL pool xatosi:', error.message);
});

async function initDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cars (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            price BIGINT NOT NULL DEFAULT 0,
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

    const carColumns = [
        'sold BOOLEAN DEFAULT false',
        "currency TEXT DEFAULT 'UZS'",
        "type TEXT DEFAULT ''",
        "types TEXT DEFAULT '[]'",
        "location TEXT DEFAULT ''",
        "address TEXT DEFAULT ''",
        'rooms INTEGER DEFAULT 0',
        'area INTEGER DEFAULT 0',
        "phone TEXT DEFAULT ''"
    ];

       for (const column of carColumns) {
        await pool.query(
            `ALTER TABLE cars ADD COLUMN IF NOT EXISTS ${column}`
        );
    }

    const priceType = await pool.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_name = 'cars'
          AND column_name = 'price'
    `);

    if (priceType.rows[0] && priceType.rows[0].data_type === 'integer') {
        await pool.query(`ALTER TABLE cars ALTER COLUMN price TYPE BIGINT`);
        console.log('cars.price ustuni BIGINT ga o‘zgartirildi');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS image_files (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            data BYTEA NOT NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS stats (
            id INTEGER PRIMARY KEY DEFAULT 1,
            views INTEGER DEFAULT 0,
            calls INTEGER DEFAULT 0
        )
    `);
    
    await pool.query(`
        INSERT INTO stats (id, views, calls)
        VALUES (1, 0, 0)
        ON CONFLICT (id) DO NOTHING
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_stats (
            stat_date DATE PRIMARY KEY,
            views INTEGER DEFAULT 0,
            calls INTEGER DEFAULT 0
        )
    `);

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
    CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
`);

    await pool.query(`
        INSERT INTO site_settings (id, phone, telegram, whatsapp, instagram, address)
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
    
    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_session_history (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT UNIQUE NOT NULL,
            login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            logout_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'logged_out', 'expired'))
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_admin_session_history_login_at
        ON admin_session_history (login_at DESC)
    `);

    
    await pool.query(`
        ALTER TABLE admin_session_history
        ADD COLUMN IF NOT EXISTS admin_name TEXT
    `);

    await pool.query(`
        ALTER TABLE admin_session_history
        ADD COLUMN IF NOT EXISTS phone TEXT
    `);

    console.log('PostgreSQL database tayyor');
}

// =====================================================
// YORDAMCHI FUNKSIYALAR
// =====================================================

// Foydalanuvchiga ko'rsatish mumkin bo'lgan xato (validatsiya)
class UserError extends Error {}

function sendJson(res, status, data) {

    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });

    res.end(JSON.stringify(data));
}

function sendFile(res, name) {

    const safeName = path.basename(name);
    const file = path.join(__dirname, 'public', safeName);

    if (!fs.existsSync(file)) {

        res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        return res.end('File topilmadi');
    }

    let contentType = 'text/html; charset=utf-8';

    if (safeName.endsWith('.css')) {
        contentType = 'text/css; charset=utf-8';
    }

    if (safeName.endsWith('.js')) {
        contentType = 'application/javascript; charset=utf-8';
    }

    if (safeName.endsWith('.json')) {
        contentType = 'application/json; charset=utf-8';
    }

    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
    });

    res.end(fs.readFileSync(file));
}

// Bo'lak-bo'lak kelgan baytlar yig'ilib, oxirida bir marta UTF-8 ga o'giriladi
// (aks holda o'zbek/rus harflari bo'lak chegarasida buzilishi mumkin edi)

function readBody(req, limit = 36000000) {

    return new Promise((resolve, reject) => {

        const chunks = [];
        let total = 0;
        let finished = false;

        req.on('data', chunk => {

            if (finished) {
                return;
            }

            total += chunk.length;

            if (total > limit) {

                finished = true;

                reject(new UserError("Ma'lumot juda katta"));

                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {

            if (!finished) {

                finished = true;

                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        });

        req.on('error', error => {

            if (!finished) {

                finished = true;

                reject(error);
            }
        });

        req.on('close', () => {

            if (!finished) {

                finished = true;

                reject(new Error('Ulanish uzildi'));
            }
        });
    });
}

// JSON obyekt bo'lishini kafolatlaydi (null, massiv, son kelsa xato beradi)
function parseJsonObject(raw, allowEmpty = true) {

    if (!raw) {

        if (allowEmpty) {
            return {};
        }

        throw new UserError("Ma'lumot formati noto'g'ri");
    }

    const value = JSON.parse(raw);

    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        throw new UserError("Ma'lumot formati noto'g'ri");
    }

    return value;
}

function toInteger(value, fallback = 0) {

    const number = Number(value);

    if (
        !Number.isFinite(number) ||
        !Number.isInteger(number)
    ) {
        return fallback;
    }

    return number;
}

function normalizeCurrency(value) {

    const currency = String(value || 'UZS')
        .trim()
        .toUpperCase();

    return currency === 'USD' ? 'USD' : 'UZS';
}

function prepareImage(dataUrl) {

    if (typeof dataUrl !== 'string') {
        throw new UserError("Rasm formati noto'g'ri");
    }

    const match = /^data:image\/jpeg;base64,(.+)$/i.exec(dataUrl);

    if (!match) {
        throw new UserError("Rasm JPEG formatda bo'lishi kerak");
    }

    const buffer = Buffer.from(match[1], 'base64');

    if (!buffer.length) {
        throw new UserError("Rasm bo'sh");
    }

    if (buffer.length > 3000000) {
        throw new UserError("Bitta rasm 3 MB dan katta bo'lmasligi kerak");
    }

    // Haqiqiy JPEG faylning boshi: FF D8 FF
    if (
        buffer.length < 4 ||
        buffer[0] !== 0xFF ||
        buffer[1] !== 0xD8 ||
        buffer[2] !== 0xFF
    ) {
        throw new UserError("Rasm JPEG formatda bo'lishi kerak");
    }

    return {
        name: crypto.randomBytes(16).toString('hex') + '.jpg',
        buffer
    };
}

function parseImages(row) {

    if (!row || !row.images) {
        return [];
    }

    if (Array.isArray(row.images)) {
        return row.images;
    }

    try {

        const images = JSON.parse(row.images);

        if (Array.isArray(images)) {
            return images.filter(x => typeof x === 'string');
        }

    } catch (e) {}

    return [];
}

function parseTypes(row) {

    if (!row) {
        return [];
    }

    if (
        row.types === null ||
        row.types === undefined ||
        row.types === ''
    ) {
        return row.type ? [String(row.type)] : [];
    }

    try {

        const types = JSON.parse(row.types);

        if (Array.isArray(types)) {

            return types
                .map(x => String(x).trim())
                .filter(Boolean)
                .slice(0, 3);
        }

    } catch (e) {}

    return row.type ? [String(row.type)] : [];
}

function carOut(row) {

    const types = parseTypes(row);
    const currency = normalizeCurrency(row.currency);

    return {
        id: Number(row.id),
        name: row.name || '',
        title: row.name || '',
        price: Number(row.price) || 0,
        currency,
        type: row.type || types[0] || '',
        types,
        location: row.location || row.address || '',
        address: row.address || row.location || '',
        rooms: Number(row.rooms) || 0,
        area: Number(row.area) || 0,
        phone: row.phone || '',
        description: row.description || '',
        images: parseImages(row),
        sold: Boolean(row.sold),
        status: row.sold ? 'sold' : 'available'
    };
}

function settingsOut(row) {

    return {
        phone: row.phone || '',
        telegram: row.telegram || '',
        whatsapp: row.whatsapp || '',
        instagram: row.instagram || '',
        address: row.address || ''
    };
}

// Qo'shish va tahrirlash uchun umumiy maydonlarni yig'ish va tekshirish.
// old === null bo'lsa yangi uy, aks holda mavjud uy tahriri.

function buildCarFields(body, old) {

    const has = key =>
        body[key] !== undefined &&
        body[key] !== null;

    const oldTypes = old ? parseTypes(old) : [];

    const name = String(
        has('name')
            ? body.name
            : (has('title') ? body.title : (old ? old.name : ''))
    ).trim().slice(0, 300);

    const price = has('price')
        ? toInteger(body.price, -1)
        : (old ? toInteger(old.price, -1) : -1);

    const currency = has('currency')
        ? normalizeCurrency(body.currency)
        : normalizeCurrency(old ? old.currency : undefined);

    const type = String(
        has('type')
            ? body.type
            : (old ? (old.type || oldTypes[0] || '') : '')
    ).trim().slice(0, 100);

    let types;

    if (Array.isArray(body.types)) {

        types = body.types
            .map(x => String(x).trim().slice(0, 100))
            .filter(Boolean)
            .slice(0, 3);

    } else {

        types = type ? [type] : oldTypes;
    }

    const location = String(
        has('location')
            ? body.location
            : (has('address') ? body.address : (old ? old.location || '' : ''))
    ).trim().slice(0, 500);

    const address = String(
        has('address')
            ? body.address
            : (has('location') ? body.location : (old ? old.address || '' : ''))
    ).trim().slice(0, 500);

    const rooms = has('rooms')
        ? toInteger(body.rooms, 0)
        : (old ? toInteger(old.rooms, 0) : 0);

    const area = has('area')
        ? toInteger(body.area, 0)
        : (old ? toInteger(old.area, 0) : 0);

    const phone = String(
        has('phone') ? body.phone : (old ? old.phone || '' : '')
    ).trim().slice(0, 100);

    const description = String(
        has('description') ? body.description : (old ? old.description || '' : '')
    ).trim().slice(0, 2000);

    // PostgreSQL INTEGER chegarasidan oshib ketmasligi uchun yuqori chegaralar
    
    if (!name || price <= 0 || price > 1000000000000) {
        throw new UserError("Nom va narxni to'g'ri kiriting");
    }

    if (
        rooms < 0 || rooms > 10000 ||
        area < 0 || area > 100000000
    ) {
        throw new UserError("Xona yoki maydon noto'g'ri");
    }

    return {
        name,
        price,
        currency,
        type: types[0] || '',
        types,
        location,
        address,
        rooms,
        area,
        phone,
        description
    };
}

async function recordDailyStat(type) {

    if (type !== 'views' && type !== 'calls') {
        return;
    }

    await pool.query(
        `
        INSERT INTO daily_stats (stat_date, views, calls)
        VALUES (CURRENT_DATE, $1, $2)
        ON CONFLICT (stat_date)
        DO UPDATE SET
            views = daily_stats.views + EXCLUDED.views,
            calls = daily_stats.calls + EXCLUDED.calls
        `,
        [
            type === 'views' ? 1 : 0,
            type === 'calls' ? 1 : 0
        ]
    );
}

// =====================================================
// ADMIN: PAROL + TELEGRAM KOD + SESSIYA
// =====================================================

const MAX_FAILS = 3;                       
const BLOCK_MS = 15 * 60 * 1000;           
const GLOBAL_MAX_FAILS = 12;               
const CODE_TTL_MS = 60 * 1000;       
const CODE_MAX_TRIES = 3;                  
const CODE_RESEND_MS = 30 * 1000;          
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; 

const failedAttempts = new Map();        
let globalFails = [];
let globalBlockedUntil = 0;

const adminLoginRequests = new Map();     
const adminSessions = new Map();           

const UNAUTHORIZED = {
    error: 'Ruxsat yo‘q yoki sessiya muddati tugagan. Qaytadan kiring.'
};

function sha256(value) {

    return crypto
        .createHash('sha256')
        .update(String(value))
        .digest();
}

function normalizePassword(value) {

    if (value === undefined || value === null) {
        return '';
    }

    return String(value).trim();
}

async function passwordMatches(value) {
    const password = normalizePassword(value);

    if (!password) return false;

    const result = await pool.query(
        'SELECT password_hash FROM admin_credentials WHERE id = 1'
    );

    if (result.rows.length > 0) {
        return verifyAdminPasswordHash(
            password,
            result.rows[0].password_hash
        );
    }

    return crypto.timingSafeEqual(
        sha256(password),
        sha256(ADMIN_PASSWORD)
    );
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
       const parts = String(fwd).split(',').map(s => s.trim()).filter(Boolean);
        return parts[parts.length - 1];
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

    pool.query(
        `UPDATE admin_session_history
         SET status = 'expired'
         WHERE session_id = $1
           AND status = 'active'`,
        [session.sessionId]
    ).catch(error => {
        console.error(
            'Admin sessiyasi tugaganini saqlash xatosi:',
            error
        );
    });

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

   
for (const [token, session] of adminSessions) {
    if (now >= session.expiresAt) {
        adminSessions.delete(token);

        pool.query(
            `UPDATE admin_session_history
             SET status = 'expired'
             WHERE session_id = $1
               AND status = 'active'`,
            [session.sessionId]
        ).catch(error => {
            console.error(
                'Muddati tugagan admin sessiyasini saqlash xatosi:',
                error
            );
        });
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

           const name = cleanAdminName(body.name);

         
          const phoneInput = String(body.phone || '').trim();
          const phoneDigits = phoneInput.replace(/\D/g, '');

          const phone = phoneDigits.startsWith('998')
               ? '+' + phoneDigits
               : '+998' + phoneDigits;

        const password = normalizePassword(body.password);

        if (!name) {
      return sendJson(res, 400, {
        error: 'Ismingizni kiriting.'
    });
}


if (!/^\+998[0-9]{9}$/.test(phone)) {
    return sendJson(res, 400, {
        error: 'Telefon raqamini to‘liq kiriting: +998 dan keyin 9 ta raqam kerak.'
    });
}

const mobileCode = phone.slice(4, 6);

const validMobileCodes = new Set([
    '90', '91', '93', '94', '95', '97', '98', '99',
    '88', '77', '33', '50', '55', '71', '20'
]);

if (!validMobileCodes.has(mobileCode)) {
    return sendJson(res, 400, {
        error: 'Telefon raqami kodi noto‘g‘ri yoki qo‘llab-quvvatlanmaydi.'
    });
}

if (!password) {
    return sendJson(res, 400, {
        error: 'Parolni kiriting.'
    });
}

           if (!(await passwordMatches(password))) {
               
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
                     name,
                     phone
               });
            
            const sent = await telegramApi('sendMessage', {
                chat_id: ADMIN_TELEGRAM_ID,
                text:
                    '🔐 Uy-Joy admin paneliga kirish kodi\n\n' +
                    'Kod: ' + code + '\n\n' +
                    'Ism: ' + name + '\n' +
                    'Telefon: ' + phone + '\n' +
                    'IP: ' + ip + '\n' +
                    '⏳ Kod 60 sekund amal qiladi va bir marta ishlaydi.\n\n' +
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

const sessionId = crypto.randomBytes(16).toString('hex');

try {
   await pool.query(
    `INSERT INTO admin_session_history
        (session_id, admin_name, phone, login_at, expires_at, status)
     VALUES ($1, $2, $3, NOW(), $4, 'active')`,
    [
        sessionId,
        request.name,
        request.phone,
        new Date(expiresAt)
    ]
);

adminSessions.set(sessionToken, {
    expiresAt,
    sessionId,
    adminName: request.name,
    phone: request.phone,
    loginAt: new Date().toISOString(),
    lastSeen: Date.now()
});
    
} catch (error) {
    console.error('Admin sessiyasini tarixga yozish xatosi:', error);

    return sendJson(res, 500, {
        ok: false,
        error: 'Admin sessiyasini yaratishda xatolik yuz berdi.'
    });
}

            return sendJson(res, 200, {
                ok: true,
                status: 'approved',
                sessionToken,
                expiresAt
            });
        }
        
if (
    req.method === 'POST' &&
    url === '/api/admin/password/change/check-current'
) {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, {
            ok: false,
            error: 'Admin sessiyasi tugagan. Qaytadan kiring.'
        });
    }

    try {
        const body = parseJsonObject(await readBody(req));
        const currentPassword = String(body.currentPassword || '');

        if (
            !currentPassword ||
            !(await passwordMatches(currentPassword))
        ) {
            return sendJson(res, 400, {
                ok: false,
                error: 'Joriy parol noto‘g‘ri.'
            });
        }

        return sendJson(res, 200, { ok: true });
    } catch (error) {
        console.error(
            'Joriy admin parolini tekshirish xatosi:',
            error
        );

        return sendJson(res, 500, {
            ok: false,
            error: 'Parolni tekshirishda server xatosi yuz berdi.'
        });
    }
}
    
if (req.method === 'POST' && url === '/api/admin/password/change/request') {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, {
            ok: false,
            error: 'Admin sessiyasi tugagan. Qaytadan kiring.'
        });
    }

    try {
       
const body = parseJsonObject(await readBody(req));

const currentPassword = String(body.currentPassword || '');
const newPassword = String(body.newPassword || '');
const confirmPassword = String(body.confirmPassword || '');

if (!currentPassword ||
    !(await passwordMatches(currentPassword))) {
    return sendJson(res, 400, {
        ok: false,
        error: 'Joriy parol noto‘g‘ri.'
    });
}

        
if (newPassword.length < 8 || newPassword.length > 200) {
    return sendJson(res, 400, {
        ok: false,
        error: 'Yangi parol 8–200 ta belgidan iborat bo‘lishi kerak.'
    });
}

        if (newPassword !== confirmPassword) {
            return sendJson(res, 400, {
                ok: false,
                error: 'Yangi parollar bir xil emas.'
            });
        }

        if (!ADMIN_TG_OK) {
            return sendJson(res, 503, {
                ok: false,
                error: 'Telegram tasdig‘i sozlanmagan.'
            });
        }

        if (await passwordMatches(newPassword)) {
            return sendJson(res, 400, {
                ok: false,
                error: 'Yangi parol joriy paroldan farq qilishi kerak.'
            });
        }

        const sessionToken = String(
            req.headers['x-admin-session'] || ''
        );

        // Shu sessiya uchun oldingi tasdiqlash so‘rovini bekor qilish.
        for (const [id, item] of adminPasswordChangeRequests) {
            if (item.sessionToken === sessionToken) {
                adminPasswordChangeRequests.delete(id);
            }
        }

        // Eskirgan so‘rovlarni tozalash.
        for (const [id, item] of adminPasswordChangeRequests) {
            if (Date.now() >= item.expiresAt) {
                adminPasswordChangeRequests.delete(id);
            }
        }

        if (adminPasswordChangeRequests.size >= 50) {
            return sendJson(res, 429, {
                ok: false,
                error: 'Tasdiqlash so‘rovlari ko‘p. Keyinroq urinib ko‘ring.'
            });
        }

        const code = String(
            crypto.randomInt(100000, 1000000)
        );

        const requestId = crypto.randomBytes(16).toString('hex');
        const passwordHash = await hashAdminPassword(newPassword);

        adminPasswordChangeRequests.set(requestId, {
            codeHash: sha256(code),
            passwordHash,
            sessionToken,
            expiresAt: Date.now() + ADMIN_PASSWORD_CHANGE_TTL_MS,
            tries: 0
        });

        const telegramResult = await telegramApi('sendMessage', {
            chat_id: ADMIN_TELEGRAM_ID,
            text:
                'Uy-Joy admin parolini o‘zgartirish kodi: ' + code +
                '\nKod 60 soniya amal qiladi. Agar bu so‘rov sizdan bo‘lmasa, uni tasdiqlamang.'
        });

        if (!telegramResult) {
            adminPasswordChangeRequests.delete(requestId);

            return sendJson(res, 502, {
                ok: false,
                error: 'Telegramga kod yuborilmadi. Qayta urinib ko‘ring.'
            });
        }

        return sendJson(res, 200, {
            ok: true,
            requestId,
            expiresInSeconds: 60
        });
    } catch (error) {
        console.error('Admin parol almashtirish kodi xatosi:', error);

        return sendJson(res, 500, {
            ok: false,
            error: 'Kod yuborishda server xatosi yuz berdi.'
        });
    }
}
        if (req.method === 'POST' && url === '/api/admin/stats/reset/verify') {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, {
            error: 'Admin sessiyasi tugagan. Qaytadan kiring.'
        });
    }

    try {
        const body = parseJsonObject(await readBody(req));
        const requestId = String(body.requestId || '').trim();
        const code = String(body.code || '').trim();
        const sessionToken = String(req.headers['x-admin-session'] || '');

        if (!/^[a-f0-9]{32}$/.test(requestId) || !/^\d{6}$/.test(code)) {
            return sendJson(res, 400, {
                error: 'Tasdiqlash kodini to‘g‘ri kiriting.'
            });
        }

        const request = adminStatsResetRequests.get(requestId);

        if (!request || request.sessionToken !== sessionToken) {
            return sendJson(res, 400, {
                error: 'Tasdiqlash so‘rovi topilmadi. Yangi kod oling.'
            });
        }

        if (Date.now() > request.expiresAt) {
            adminStatsResetRequests.delete(requestId);

            return sendJson(res, 400, {
                error: 'Kodning amal qilish muddati tugagan. Yangi kod oling.'
            });
        }

        request.tries += 1;

        const expectedHash = Buffer.from(request.codeHash, 'hex');
        const actualHash = Buffer.from(sha256(code), 'hex');

        const codeMatches =
            expectedHash.length === actualHash.length &&
            crypto.timingSafeEqual(expectedHash, actualHash);

        if (!codeMatches) {
            if (request.tries >= 3) {
                adminStatsResetRequests.delete(requestId);

                return sendJson(res, 429, {
                    error: 'Kod 3 marta noto‘g‘ri kiritildi. Yangi kod oling.'
                });
            }

            return sendJson(res, 400, {
                error: 'Tasdiqlash kodi noto‘g‘ri.',
                attemptsLeft: 3 - request.tries
            });
        }

        // Kod bir marta ishlatiladi.
        adminStatsResetRequests.delete(requestId);

        const client = await pool.connect();

try {
    await client.query('BEGIN');

    if (request.resetType === 'history') {
        // Faqat kirishlar tarixini tozalash.
        await client.query(`
            DELETE FROM admin_session_history
        `);

    } else if (request.resetType === 'all') {
        // Ko‘rishlar va qo‘ng‘iroqlarni nolga tushirish.
        await client.query(`
            UPDATE stats
            SET views = 0, calls = 0
            WHERE id = 1
        `);

        // Kunlik statistikani tozalash.
        await client.query(`
            DELETE FROM daily_stats
        `);

        // Kirishlar tarixini ham tozalash.
        await client.query(`
            DELETE FROM admin_session_history
        `);

    } else {
        throw new Error('Noto‘g‘ri statistikani tozalash turi.');
    }

    await client.query('COMMIT');

} catch (error) {
    try {
        await client.query('ROLLBACK');
    } catch (rollbackError) {
        console.error(
            'Statistikani tozalashni bekor qilish xatosi:',
            rollbackError
        );
    }

    throw error;

} finally {
    client.release();
}

return sendJson(res, 200, {
    ok: true,
    resetType: request.resetType,
    message: request.resetType === 'history'
        ? 'Kirishlar tarixi tozalandi.'
        : 'Barcha statistika va kirishlar tarixi tozalandi.'
});
     
    } catch (error) {
        console.error('Statistikani tozalash xatosi:', error);

        return sendJson(res, 500, {
            error: 'Statistikani tozalashda xatolik yuz berdi.'
        });
    }
}
        
if (req.method === 'POST' && url === '/api/admin/stats/reset/request') {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, {
            error: 'Admin sessiyasi tugagan. Qaytadan kiring.'
        });
    }

    try {
        const body = parseJsonObject(await readBody(req));
        const password = String(body.password || '');
        const resetType = String(body.resetType || '');

         if (!['history', 'all'].includes(resetType)) {
         return sendJson(res, 400, {
        error: 'Tozalash turini tanlang.'
    });
}
        const sessionToken = String(req.headers['x-admin-session'] || '');

        if (!password) {
            return sendJson(res, 400, {
                error: 'Joriy admin parolini kiriting.'
            });
        }

        if (!(await passwordMatches(password))) {
            return sendJson(res, 401, {
                error: 'Admin paroli noto‘g‘ri.'
            });
        }

        if (!ADMIN_TG_OK) {
            return sendJson(res, 503, {
                error: 'Telegram tasdiqlash sozlamalari to‘liq emas.'
            });
        }

        // Shu sessiyaning oldingi statistika tozalash so‘rovlarini bekor qilish.
        for (const [id, request] of adminStatsResetRequests) {
            if (request.sessionToken === sessionToken) {
                adminStatsResetRequests.delete(id);
            }
        }

        if (adminStatsResetRequests.size >= 50) {
            return sendJson(res, 429, {
                error: 'So‘rovlar soni ko‘p. Birozdan keyin urinib ko‘ring.'
            });
        }

        const code = String(
            crypto.randomInt(0, 1000000)
        ).padStart(6, '0');

        const requestId = crypto.randomBytes(16).toString('hex');
        const now = Date.now();

        adminStatsResetRequests.set(requestId, {
          codeHash: sha256(code),
          sessionToken,
          resetType,
          expiresAt: now + 60 * 1000,
          tries: 0
       });
        const sent = await telegramApi('sendMessage', {
            chat_id: ADMIN_TELEGRAM_ID,
           text:
                '🔐 Uy-Joy — tasdiqlash\n\n' +
                 'Amal: ' +
                 (resetType === 'history'
                 ? 'Faqat kirishlar tarixini tozalash'
                 : 'Barcha statistikani 0 qilish') +
                 '\n\nTasdiqlash kodi: ' + code +
                 '\n\n⏳ Kod 60 soniya amal qiladi va faqat bir marta ishlaydi.\n\n' +
                 'Agar bu amalni siz boshlamagan bo‘lsangiz, kodni kiritmang.'
             });

        if (!sent) {
            adminStatsResetRequests.delete(requestId);

            return sendJson(res, 502, {
                error: 'Telegramga kod yuborilmadi. Botni tekshiring.'
            });
        }

        return sendJson(res, 200, {
            ok: true,
            requestId,
            expiresInSeconds: 60
        });
    } catch (error) {
        console.error('Statistikani tozalash kodi xatosi:', error);

        return sendJson(res, 500, {
            error: 'Tasdiqlash kodini yuborishda xatolik yuz berdi.'
        });
    }
}

if (req.method === 'POST' && url === '/api/admin/password/change/verify') {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, {
            ok: false,
            error: 'Admin sessiyasi tugagan. Qaytadan kiring.'
        });
    }

    try {
        const body = parseJsonObject(await readBody(req));
        const requestId = String(body.requestId || '');
        const code = String(body.code || '');

        if (!/^[a-f0-9]{32}$/i.test(requestId) ||
            !/^\d{6}$/.test(code)) {
            return sendJson(res, 400, {
                ok: false,
                error: 'So‘rov ID yoki tasdiqlash kodi noto‘g‘ri.'
            });
        }

        const request = adminPasswordChangeRequests.get(requestId);
        const sessionToken = String(
            req.headers['x-admin-session'] || ''
        );

        if (!request || request.sessionToken !== sessionToken) {
            return sendJson(res, 400, {
                ok: false,
                error: 'So‘rov topilmadi. Yangi kod so‘rang.'
            });
        }

        if (Date.now() >= request.expiresAt) {
            adminPasswordChangeRequests.delete(requestId);

            return sendJson(res, 400, {
                ok: false,
                error: 'Kod muddati tugadi. Yangi kod so‘rang.'
            });
        }

        request.tries += 1;

        const suppliedHash = sha256(code);
        const codeMatches = crypto.timingSafeEqual(
            suppliedHash,
            request.codeHash
        );

        if (!codeMatches) {
            if (request.tries >= ADMIN_PASSWORD_CHANGE_MAX_TRIES) {
                adminPasswordChangeRequests.delete(requestId);

                return sendJson(res, 400, {
                    ok: false,
                    error: 'Uchta xato urinish. Yangi kod so‘rang.'
                });
            }

            return sendJson(res, 400, {
                ok: false,
                error: 'Kod noto‘g‘ri. Qayta tekshiring.'
            });
        }

       
        // Parolni saqlash va barcha faol sessiyalarni
        // tarixni o'chirmasdan tugatish.
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Yangi parol xeshini PostgreSQL ga saqlash.
            await client.query(`
                INSERT INTO admin_credentials (
                    id,
                    password_hash,
                    updated_at
                )
                VALUES (1, $1, NOW())
                ON CONFLICT (id)
                DO UPDATE SET
                    password_hash = EXCLUDED.password_hash,
                    updated_at = NOW()
            `, [request.passwordHash]);

        
            await client.query(`
                UPDATE admin_session_history
                SET
                    status = 'logged_out',
                    logout_at = NOW()
                WHERE status = 'active'
            `);

            await client.query('COMMIT');

        } catch (dbError) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error(
                    'Parol almashtirish tranzaksiyasini bekor qilish xatosi:',
                    rollbackError
                );
            }

            throw dbError;

        } finally {
            client.release();
        }

        adminSessions.clear();
        adminLoginRequests.clear();
        adminPasswordChangeRequests.clear();

        return sendJson(res, 200, {
            ok: true,
            message: 'Parol muvaffaqiyatli o‘zgartirildi.'
        });
    } catch (error) {
        console.error('Admin parolini saqlash xatosi:', error);

        return sendJson(res, 500, {
            ok: false,
            error: 'Yangi parolni saqlashda server xatosi yuz berdi.'
        });
    }
}

        // =================================================
        // ADMIN LOGOUT
        // =================================================

      
        if (url === '/api/admin/logout' && req.method === 'POST') {

            const token = String(
                req.headers['x-admin-session'] || ''
            ).trim();

            if (token) {

                const session = adminSessions.get(token);

                // Sessiya avval o'chiriladi, baza xatosi chiqishga to'sqinlik qilmasin
                adminSessions.delete(token);

                if (session) {
                    try {
                        await pool.query(
                            `UPDATE admin_session_history
                             SET logout_at = NOW(), status = 'logged_out'
                             WHERE session_id = $1
                               AND status = 'active'`,
                            [session.sessionId]
                        );
                    } catch (error) {
                        console.error('Admin chiqish tarixini saqlash xatosi:', error);
                    }
                }
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
      
if (
    url === '/api/admin/heartbeat' &&
    req.method === 'POST'
) {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, UNAUTHORIZED);
    }

    const token = String(
        req.headers['x-admin-session'] || ''
    ).trim();

    const session = adminSessions.get(token);

    if (!session) {
        return sendJson(res, 401, UNAUTHORIZED);
    }

    session.lastSeen = Date.now();

    return sendJson(res, 200, {
        ok: true
    });
}
    
        // =================================================
        // ADMIN: SESSIYALAR TARIXI VA STATISTIKASI
        // =================================================

     if (
    url === '/api/admin/session-history' &&
    req.method === 'GET'
) {
    if (!isAdminHeader(req)) {
        return sendJson(res, 401, UNAUTHORIZED);
    }

    try {
        // Sessiya muddati tugaganlarini yangilash.
        await pool.query(`
            UPDATE admin_session_history
            SET status = 'expired'
            WHERE status = 'active'
              AND expires_at <= NOW()
        `);

        // Jami va bugungi kirishlar.
        const counts = await pool.query(`
            SELECT
                COUNT(*)::int AS total_logins,
                COUNT(*) FILTER (
                    WHERE
                        (login_at AT TIME ZONE 'Asia/Tashkent')::date =
                        (NOW() AT TIME ZONE 'Asia/Tashkent')::date
                )::int AS today_logins
            FROM admin_session_history
        `);

        // So'nggi kirishlar tarixi.
        const recent = await pool.query(`
            SELECT
                id,
                admin_name,
                phone,
                login_at,
                expires_at,
                logout_at,
                status
            FROM admin_session_history
            ORDER BY login_at DESC
            LIMIT 50
        `);

        // Faol sessiyalar (sessiyani o'chirmaydi, faqat ko'rsatadi).
        const activeSessions = [...adminSessions.values()]
            .filter(session =>
                session.expiresAt > Date.now() &&
                Date.now() - (session.lastSeen || Date.now()) < 5 * 60_000
            )
            .map(session => ({
                session_id: session.sessionId,
                admin_name: session.adminName || 'Admin',
                phone: session.phone || '',
                login_at: session.loginAt || null,
                expires_at: new Date(session.expiresAt).toISOString(),
                status: 'active'
            }));

        return sendJson(res, 200, {
            ok: true,
            totalLogins: counts.rows[0].total_logins,
            todayLogins: counts.rows[0].today_logins,
            activeSessions,
            recentSessions: recent.rows
        });

    } catch (error) {
        console.error('Admin sessiyalari tarixini olish xatosi:', error);

        return sendJson(res, 500, {
            ok: false,
            error: 'Sessiyalar tarixini yuklab bo‘lmadi.'
        });
    }
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
