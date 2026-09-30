'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// =====================================================
// SOZLAMALAR
// =====================================================

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL topilmadi!');
    process.exit(1);
}

if (!ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD topilmadi!');
    process.exit(1);
}

if (ADMIN_PASSWORD.length < 12) {
    console.warn(
        "OGOHLANTIRISH: ADMIN_PASSWORD kamida 16 belgi bo'lgani ma'qul"
    );
}

const PORT = Number(process.env.PORT) || 3000;

// Frontend shu serverning o'zidan beriladi. Boshqa domendan
// foydalansangiz, Render'da ALLOWED_ORIGIN ni o'sha domenga qo'ying.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY_BYTES = 40 * 1024 * 1024;   // 8 ta rasm (base64) sig'ishi uchun
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // bitta rasm
const MAX_IMAGES = 8;
const MAX_PRICE = 1000000000000000;

// =====================================================
// DATABASE
// =====================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', err => {
    console.error('DB POOL ERROR:', err);
});

// =====================================================
// XATO SINFI
// Faqat shu turdagi xatolar matni foydalanuvchiga ko'rsatiladi.
// Boshqa (ichki) xatolar faqat logga yoziladi.
// =====================================================

class HttpError extends Error {

    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// =====================================================
// DATABASE INIT
// =====================================================

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

    await pool.query(`
        ALTER TABLE cars
            ADD COLUMN IF NOT EXISTS sold BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'UZS',
            ADD COLUMN IF NOT EXISTS type TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS types TEXT DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS location TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '',
            ADD COLUMN IF NOT EXISTS rooms INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS area INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''
    `);

    // Eski bazada price INTEGER bo'lsa, BIGINT ga o'tkaziladi
    // (2,14 milliarddan katta narxlar uchun). Ma'lumot yo'qolmaydi.
    await pool.query(`
        DO $$
        BEGIN
            IF (
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'cars'
                  AND column_name = 'price'
            ) = 'integer' THEN
                ALTER TABLE cars ALTER COLUMN price TYPE BIGINT;
            END IF;
        END
        $$
    `);

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

    console.log('PostgreSQL database tayyor');
}

// =====================================================
// YORDAMCHI FUNKSIYALAR
// =====================================================

function str(value, max) {

    return String(
        value === undefined || value === null ? '' : value
    )
        .trim()
        .slice(0, max);
}

function toInteger(value, fallback = 0) {

    const number = Number(value);

    if (!Number.isFinite(number) || !Number.isInteger(number)) {
        return fallback;
    }

    return number;
}

function normalizeCurrency(value) {

    const currency = String(value || 'UZS').trim().toUpperCase();

    return currency === 'USD' ? 'USD' : 'UZS';
}

function escapeLike(value) {

    return String(value).replace(/[\\%_]/g, '\\$&');
}

function parseId(url) {

    const id = Number(url.split('/')[3]);

    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
        throw new HttpError(400, "ID noto'g'ri");
    }

    return id;
}

function cleanLink(value, max) {

    const link = str(value, max);

    if (link && !/^https?:\/\//i.test(link)) {

        throw new HttpError(
            400,
            "Havola http:// yoki https:// bilan boshlanishi kerak"
        );
    }

    return link;
}

// =====================================================
// JAVOB YUBORISH
// =====================================================

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
};

function sendJson(res, status, data) {

    if (res.headersSent || res.writableEnded) {
        return;
    }

    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN
    });

    res.end(JSON.stringify(data));
}

// =====================================================
// STATIK FAYLLAR
// =====================================================

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

async function sendFile(res, name) {

    const safeName = path.basename(name);
    const ext = path.extname(safeName).toLowerCase();
    const contentType = MIME[ext];

    if (!contentType) {

        return sendJson(res, 404, { error: 'Fayl topilmadi' });
    }

    let data;

    try {

        data = await fs.promises.readFile(
            path.join(PUBLIC_DIR, safeName)
        );

    } catch (e) {

        return sendJson(res, 404, { error: 'Fayl topilmadi' });
    }

    const isCode =
        ext === '.html' || ext === '.css' || ext === '.js';

    res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': contentType,
        'Cache-Control': isCode
            ? 'no-cache'
            : 'public, max-age=86400'
    });

    res.end(data);
}

// =====================================================
// SO'ROV BODY'SINI O'QISH
// =====================================================

function readBody(req) {

    return new Promise((resolve, reject) => {

        const declared = Number(req.headers['content-length']);

        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {

            return reject(
                new HttpError(413, "Ma'lumot juda katta")
            );
        }

        const chunks = [];
        let total = 0;
        let done = false;

        req.on('data', chunk => {

            if (done) {
                return;
            }

            total += chunk.length;

            if (total > MAX_BODY_BYTES) {

                done = true;

                reject(new HttpError(413, "Ma'lumot juda katta"));

                req.destroy();

                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {

            if (!done) {

                done = true;

                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        });

        req.on('error', error => {

            if (!done) {

                done = true;

                reject(error);
            }
        });
    });
}

async function readJson(req, optional = false) {

    const raw = await readBody(req);

    if (!raw.trim()) {

        if (optional) {
            return {};
        }

        throw new HttpError(400, "Ma'lumot yuborilmadi");
    }

    let data;

    try {

        data = JSON.parse(raw);

    } catch (e) {

        if (optional) {
            return {};
        }

        throw new HttpError(400, "Ma'lumot formati noto'g'ri");
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {

        if (optional) {
            return {};
        }

        throw new HttpError(400, "Ma'lumot formati noto'g'ri");
    }

    return data;
}

// =====================================================
// TRANZAKSIYA
// =====================================================

async function withTransaction(fn) {

    const client = await pool.connect();

    try {

        await client.query('BEGIN');

        const result = await fn(client);

        await client.query('COMMIT');

        return result;

    } catch (e) {

        try {
            await client.query('ROLLBACK');
        } catch (_) {}

        throw e;

    } finally {

        client.release();
    }
}

// =====================================================
// ADMIN AUTH
// Parol faqat X-Admin-Password headerida yuboriladi.
// =====================================================

function normalizePassword(value) {

    if (value === undefined || value === null) {
        return '';
    }

    return String(value).trim();
}

const ADMIN_HASH = crypto
    .createHash('sha256')
    .update(ADMIN_PASSWORD)
    .digest();

// Ikkala tomon ham 32 bayt (sha256), shuning uchun parol uzunligi bilinmaydi
function passwordMatches(value) {

    const input = normalizePassword(value);

    if (!input) {
        return false;
    }

    const hash = crypto
        .createHash('sha256')
        .update(input)
        .digest();

    return crypto.timingSafeEqual(hash, ADMIN_HASH);
}

// -----------------------------------------------------
// URINISHLARNI CHEKLASH
// -----------------------------------------------------

const MAX_FAILS_PER_IP = 3;               // bitta IP dan 3 ta xato
const MAX_FAILS_TOTAL = 100;              // hamma IP lardan jami
const WINDOW_MS = 15 * 60 * 1000;         // blok muddati: 15 daqiqa

const failedAttempts = new Map();
let totalFails = { count: 0, first: Date.now() };

function getIp(req) {

    const fwd = req.headers['x-forwarded-for'];

    if (fwd) {
        return String(fwd).split(',')[0].trim();
    }

    return req.socket.remoteAddress || 'unknown';
}

function isBlocked(req) {

    const now = Date.now();
    const ip = getIp(req);

    if (now - totalFails.first > WINDOW_MS) {
        totalFails = { count: 0, first: now };
    }

    if (totalFails.count >= MAX_FAILS_TOTAL) {
        return true;
    }

    const rec = failedAttempts.get(ip);

    if (!rec) {
        return false;
    }

    if (now - rec.first > WINDOW_MS) {
        failedAttempts.delete(ip);
        return false;
    }

    return rec.count >= MAX_FAILS_PER_IP;
}

function registerFail(req) {

    const ip = getIp(req);
    const now = Date.now();
    const rec = failedAttempts.get(ip);

    totalFails.count++;

    if (!rec || now - rec.first > WINDOW_MS) {
        failedAttempts.set(ip, { count: 1, first: now });
    } else {
        rec.count++;
    }
}

setInterval(() => {

    const now = Date.now();

    for (const [ip, rec] of failedAttempts) {

        if (now - rec.first > WINDOW_MS) {
            failedAttempts.delete(ip);
        }
    }

}, 60 * 1000).unref();

// true qaytsa davom etiladi.
// false qaytsa javob allaqachon yuborilgan (return qiling).
function checkAdmin(req, res) {

    if (isBlocked(req)) {

        sendJson(res, 429, {
            error: "Ko'p xato urinish. Keyinroq qayta urinib ko'ring"
        });

        return false;
    }

    if (passwordMatches(req.headers['x-admin-password'])) {

        // To'g'ri parol: shu IP dagi xatolar tozalanadi
        failedAttempts.delete(getIp(req));

        return true;
    }

    registerFail(req);

    const rec = failedAttempts.get(getIp(req));

    const left = Math.max(
        MAX_FAILS_PER_IP - (rec ? rec.count : 0),
        0
    );

    sendJson(res, 401, {
        error: left > 0
            ? "Parol noto'g'ri. Qolgan urinish: " + left
            : "Parol noto'g'ri. Urinishlar tugadi, 15 daqiqadan keyin qayta urinib ko'ring"
    });

    return false;
}

// =====================================================
// UMUMIY CHEKLOVCHI (statistika spam'iga qarshi)
// =====================================================

function createLimiter(max, windowMs) {

    const hits = new Map();

    setInterval(() => {

        const now = Date.now();

        for (const [key, rec] of hits) {

            if (now - rec.first > windowMs) {
                hits.delete(key);
            }
        }

    }, 60 * 1000).unref();

    return function allow(key) {

        const now = Date.now();
        const rec = hits.get(key);

        if (!rec || now - rec.first > windowMs) {

            hits.set(key, { count: 1, first: now });

            return true;
        }

        rec.count++;

        return rec.count <= max;
    };
}

const viewLimiter = createLimiter(30, 10 * 60 * 1000);
const callLimiter = createLimiter(10, 10 * 60 * 1000);

// =====================================================
// RASMLAR
// =====================================================

const JPEG_PREFIX = 'data:image/jpeg;base64,';

function prepareImage(dataUrl) {

    if (
        typeof dataUrl !== 'string' ||
        dataUrl.slice(0, JPEG_PREFIX.length).toLowerCase() !== JPEG_PREFIX
    ) {

        throw new HttpError(400, "Rasm JPEG formatda bo'lishi kerak");
    }

    const base64 = dataUrl.slice(JPEG_PREFIX.length);

    // base64 hajmi asl hajmdan ~33% katta
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {

        throw new HttpError(
            400,
            "Bitta rasm 3 MB dan katta bo'lmasligi kerak"
        );
    }

    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length) {
        throw new HttpError(400, "Rasm bo'sh");
    }

    if (buffer.length > MAX_IMAGE_BYTES) {

        throw new HttpError(
            400,
            "Bitta rasm 3 MB dan katta bo'lmasligi kerak"
        );
    }

    // Haqiqiy JPEG fayl FF D8 FF bilan boshlanadi
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {

        throw new HttpError(400, "Rasm buzilgan yoki JPEG emas");
    }

    return {
        name: crypto.randomBytes(16).toString('hex') + '.jpg',
        buffer
    };
}

// Kelgan ro'yxatni tayyorlaydi.
// Element yoki yangi rasm (data:image/jpeg;base64,...),
// yoki mavjud rasm ("/uploads/xxxx.jpg" yoki "xxxx.jpg") bo'lishi mumkin.
function resolveImages(incoming, allowedExisting) {

    if (incoming.length > MAX_IMAGES) {

        throw new HttpError(
            400,
            "Ko'pi bilan " + MAX_IMAGES + " ta rasm"
        );
    }

    return incoming.map(item => {

        if (typeof item !== 'string') {
            throw new HttpError(400, "Rasm formati noto'g'ri");
        }

        if (item.startsWith('data:')) {
            return { isNew: true, ...prepareImage(item) };
        }

        const match = /([a-f0-9]{32}\.jpg)$/.exec(item);

        if (!match || !allowedExisting.includes(match[1])) {
            throw new HttpError(400, 'Rasm topilmadi');
        }

        return { isNew: false, name: match[1] };
    });
}

// Yangi rasmlarni bazaga yozadi, oxirgi tartibdagi nomlarni qaytaradi
async function saveNewImages(client, items) {

    const names = [];

    for (const item of items) {

        if (item.isNew) {

            await client.query(
                'INSERT INTO image_files (name, data) VALUES ($1, $2)',
                [item.name, item.buffer]
            );
        }

        names.push(item.name);
    }

    return names;
}

// =====================================================
// MA'LUMOTNI O'QISH
// =====================================================

function parseImages(row) {

    if (!row || !row.images) {
        return [];
    }

    if (Array.isArray(row.images)) {

        return row.images.filter(x => typeof x === 'string');
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

    return {
        id: Number(row.id),
        name: row.name || '',
        title: row.name || '',
        price: Number(row.price) || 0,
        currency: normalizeCurrency(row.currency),
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

// =====================================================
// E'LON MAYDONLARINI YIG'ISH (qo'shish va tahrirlash uchun)
// old = null bo'lsa yangi e'lon, aks holda tahrirlash
// =====================================================

function buildCarFields(body, old) {

    const oldTypes = old ? parseTypes(old) : [];

    const nameKey =
        body.name !== undefined ? 'name'
            : body.title !== undefined ? 'title'
                : null;

    const name = str(
        nameKey ? body[nameKey] : (old ? old.name : ''),
        300
    );

    const price =
        body.price !== undefined
            ? toInteger(body.price, -1)
            : (old ? toInteger(old.price, -1) : -1);

    const currency = normalizeCurrency(
        body.currency !== undefined
            ? body.currency
            : (old ? old.currency : 'UZS')
    );

    const type = str(
        body.type !== undefined
            ? body.type
            : (old ? (old.type || oldTypes[0] || '') : ''),
        100
    );

    let types;

    if (Array.isArray(body.types)) {

        types = body.types
            .map(x => str(x, 100))
            .filter(Boolean)
            .slice(0, 3);

    } else if (body.type !== undefined) {

        types = type ? [type] : [];

    } else {

        types = old ? oldTypes : [];
    }

    const locKey =
        body.location !== undefined ? 'location'
            : body.address !== undefined ? 'address'
                : null;

    const adrKey =
        body.address !== undefined ? 'address'
            : body.location !== undefined ? 'location'
                : null;

    const location = str(
        locKey ? body[locKey] : (old ? old.location : ''),
        500
    );

    const address = str(
        adrKey ? body[adrKey] : (old ? old.address : ''),
        500
    );

    const rooms =
        body.rooms !== undefined
            ? toInteger(body.rooms, 0)
            : (old ? toInteger(old.rooms, 0) : 0);

    const area =
        body.area !== undefined
            ? toInteger(body.area, 0)
            : (old ? toInteger(old.area, 0) : 0);

    const phone = str(
        body.phone !== undefined ? body.phone : (old ? old.phone : ''),
        100
    );

    const description = str(
        body.description !== undefined
            ? body.description
            : (old ? old.description : ''),
        2000
    );

    return {
        name,
        price,
        currency,
        types,
        location,
        address,
        rooms,
        area,
        phone,
        description
    };
}

function validateCar(f) {

    if (!f.name || f.price <= 0 || f.price > MAX_PRICE) {

        throw new HttpError(400, "Nom va narxni to'g'ri kiriting");
    }

    if (f.rooms < 0 || f.rooms > 1000 || f.area < 0 || f.area > 1000000) {

        throw new HttpError(400, "Xona yoki maydon noto'g'ri");
    }
}

// =====================================================
// KUNLIK STATISTIKA
// =====================================================

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
// SO'ROVLARNI QAYTA ISHLASH
// =====================================================

async function handleRequest(req, res) {

    let url;

    try {

        url = new URL(req.url, 'http://localhost').pathname;

    } catch (e) {

        throw new HttpError(400, "So'rov manzili noto'g'ri");
    }

    if (url.length > 1 && url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    const method = req.method;

    // -------------------------------------------------
    // CORS
    // -------------------------------------------------

    if (method === 'OPTIONS') {

        res.writeHead(204, {
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Password',
            'Access-Control-Max-Age': '86400'
        });

        return res.end();
    }

    // -------------------------------------------------
    // SALOMATLIK TEKSHIRUVI
    // -------------------------------------------------

    if (url === '/healthz' && method === 'GET') {

        return sendJson(res, 200, { ok: true });
    }

    // -------------------------------------------------
    // E'LONLAR RO'YXATI + QIDIRUV
    //
    // ?q=matn          nom, manzil, tavsif bo'yicha
    // ?type=kvartira   turi bo'yicha
    // ?currency=USD    valyuta
    // ?minPrice=&maxPrice=
    // ?rooms=3         kamida shuncha xona
    // ?minArea=50      kamida shuncha m2
    // ?available=1     faqat sotilmaganlar
    // ?limit=&offset=  sahifalash (standart 500)
    // -------------------------------------------------

    if (url === '/api/cars' && method === 'GET') {

        const params = new URL(req.url, 'http://localhost').searchParams;

        const values = [];
        const where = [];

        const bind = value => {
            values.push(value);
            return '$' + values.length;
        };

        const q = str(params.get('q'), 100);

        if (q) {

            const p = bind('%' + escapeLike(q) + '%');

            where.push(
                `(name ILIKE ${p} OR location ILIKE ${p} OR address ILIKE ${p} OR description ILIKE ${p})`
            );
        }

        const type = str(params.get('type'), 100);

        if (type) {

            const exact = bind(escapeLike(type));
            const inList = bind('%' + escapeLike(JSON.stringify(type)) + '%');

            where.push(`(type ILIKE ${exact} OR types ILIKE ${inList})`);
        }

        if (params.get('currency')) {

            where.push(
                `currency = ${bind(normalizeCurrency(params.get('currency')))}`
            );
        }

        const minPrice = toInteger(params.get('minPrice'), -1);

        if (minPrice >= 0) {
            where.push(`price >= ${bind(minPrice)}`);
        }

        const maxPrice = toInteger(params.get('maxPrice'), -1);

        if (maxPrice >= 0) {
            where.push(`price <= ${bind(maxPrice)}`);
        }

        const rooms = toInteger(params.get('rooms'), 0);

        if (rooms > 0) {
            where.push(`rooms >= ${bind(rooms)}`);
        }

        const minArea = toInteger(params.get('minArea'), 0);

        if (minArea > 0) {
            where.push(`area >= ${bind(minArea)}`);
        }

        if (params.get('available') === '1') {
            where.push('sold = false');
        }

        const limit = Math.min(
            Math.max(toInteger(params.get('limit'), 500), 1),
            500
        );

        const offset = Math.max(toInteger(params.get('offset'), 0), 0);

        const limitP = bind(limit);
        const offsetP = bind(offset);

        const result = await pool.query(
            `
            SELECT * FROM cars
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY id DESC
            LIMIT ${limitP} OFFSET ${offsetP}
            `,
            values
        );

        return sendJson(res, 200, result.rows.map(carOut));
    }

    // -------------------------------------------------
    // E'LON QO'SHISH
    // -------------------------------------------------

    if (url === '/api/cars' && method === 'POST') {

        if (!checkAdmin(req, res)) return;

        const body = await readJson(req);

        const f = buildCarFields(body, null);

        validateCar(f);

        const items = Array.isArray(body.images)
            ? resolveImages(body.images, [])
            : [];

        const car = await withTransaction(async client => {

            const names = await saveNewImages(client, items);

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
                    f.name,
                    f.price,
                    f.description,
                    JSON.stringify(names),
                    f.currency,
                    f.types[0] || '',
                    JSON.stringify(f.types),
                    f.location,
                    f.address,
                    f.rooms,
                    f.area,
                    f.phone
                ]
            );

            return inserted.rows[0];
        });

        return sendJson(res, 201, { ok: true, car: carOut(car) });
    }

    // -------------------------------------------------
    // E'LONNI TAHRIRLASH
    // -------------------------------------------------

    if (/^\/api\/cars\/\d+$/.test(url) && method === 'PUT') {

        if (!checkAdmin(req, res)) return;

        const id = parseId(url);

        const body = await readJson(req);

        const car = await withTransaction(async client => {

            const oldResult = await client.query(
                'SELECT * FROM cars WHERE id = $1 FOR UPDATE',
                [id]
            );

            if (oldResult.rows.length === 0) {
                throw new HttpError(404, 'Mashina topilmadi');
            }

            const old = oldResult.rows[0];

            const f = buildCarFields(body, old);

            validateCar(f);

            const oldNames = parseImages(old);

            let finalNames = oldNames;

            if (Array.isArray(body.images)) {

                const items = resolveImages(body.images, oldNames);

                finalNames = await saveNewImages(client, items);

                const removed = oldNames.filter(
                    n => !finalNames.includes(n)
                );

                if (removed.length) {

                    await client.query(
                        'DELETE FROM image_files WHERE name = ANY($1::text[])',
                        [removed]
                    );
                }
            }

            const updated = await client.query(
                `
                UPDATE cars SET
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
                    f.name,
                    f.price,
                    f.description,
                    JSON.stringify(finalNames),
                    f.currency,
                    f.types[0] || '',
                    JSON.stringify(f.types),
                    f.location,
                    f.address,
                    f.rooms,
                    f.area,
                    f.phone,
                    id
                ]
            );

            return updated.rows[0];
        });

        return sendJson(res, 200, { ok: true, car: carOut(car) });
    }

    // -------------------------------------------------
    // SOTILDI / SOTILMADI
    // Body'da { "sold": true/false } bo'lsa aynan shu qo'yiladi,
    // bo'lmasa holat almashtiriladi (eski xatti-harakat).
    // -------------------------------------------------

    if (/^\/api\/cars\/\d+\/sold$/.test(url) && method === 'POST') {

        if (!checkAdmin(req, res)) return;

        const id = parseId(url);

        const body = await readJson(req, true);

        const result = typeof body.sold === 'boolean'
            ? await pool.query(
                'UPDATE cars SET sold = $2 WHERE id = $1 RETURNING *',
                [id, body.sold]
            )
            : await pool.query(
                'UPDATE cars SET sold = NOT sold WHERE id = $1 RETURNING *',
                [id]
            );

        if (result.rows.length === 0) {
            throw new HttpError(404, 'Mashina topilmadi');
        }

        return sendJson(res, 200, {
            ok: true,
            sold: Boolean(result.rows[0].sold),
            car: carOut(result.rows[0])
        });
    }

    // -------------------------------------------------
    // E'LONNI O'CHIRISH
    // -------------------------------------------------

    if (/^\/api\/cars\/\d+$/.test(url) && method === 'DELETE') {

        if (!checkAdmin(req, res)) return;

        const id = parseId(url);

        await withTransaction(async client => {

            const result = await client.query(
                'SELECT images FROM cars WHERE id = $1 FOR UPDATE',
                [id]
            );

            if (result.rows.length === 0) {
                throw new HttpError(404, 'Mashina topilmadi');
            }

            const names = parseImages(result.rows[0]);

            if (names.length) {

                await client.query(
                    'DELETE FROM image_files WHERE name = ANY($1::text[])',
                    [names]
                );
            }

            await client.query('DELETE FROM cars WHERE id = $1', [id]);
        });

        return sendJson(res, 200, { ok: true });
    }

    // -------------------------------------------------
    // SAYT SOZLAMALARI
    // -------------------------------------------------

    if (url === '/api/settings' && method === 'GET') {

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

    if (url === '/api/settings' && method === 'POST') {

        if (!checkAdmin(req, res)) return;

        const body = await readJson(req);

        const phone = str(body.phone, 50);
        const telegram = cleanLink(body.telegram, 500);
        const whatsapp = cleanLink(body.whatsapp, 500);
        const instagram = cleanLink(body.instagram, 500);
        const address = str(body.address, 300);

        if (!phone) {
            throw new HttpError(400, 'Telefon raqamini kiriting');
        }

        const result = await pool.query(
            `
            UPDATE site_settings SET
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

    // -------------------------------------------------
    // RASMNI OLISH
    // -------------------------------------------------

    if (url.startsWith('/uploads/') && method === 'GET') {

        const name = url.slice('/uploads/'.length);

        if (!/^[a-f0-9]{32}\.jpg$/.test(name)) {

            res.writeHead(404);

            return res.end();
        }

        const result = await pool.query(
            'SELECT data FROM image_files WHERE name = $1',
            [name]
        );

        if (result.rows.length === 0) {

            res.writeHead(404);

            return res.end();
        }

        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400'
        });

        return res.end(result.rows[0].data);
    }

    // -------------------------------------------------
    // STATISTIKA: KO'RISH VA QO'NG'IROQ
    // Limitdan oshsa ham { ok: true } qaytadi, lekin sanalmaydi.
    // -------------------------------------------------

    if (url === '/api/stats/view' && method === 'POST') {

        if (!viewLimiter(getIp(req))) {

            return sendJson(res, 200, { ok: true, counted: false });
        }

        await pool.query(
            'UPDATE stats SET views = views + 1 WHERE id = 1'
        );

        await recordDailyStat('views');

        return sendJson(res, 200, { ok: true });
    }

    if (url === '/api/stats/call' && method === 'POST') {

        if (!callLimiter(getIp(req))) {

            return sendJson(res, 200, { ok: true, counted: false });
        }

        await pool.query(
            'UPDATE stats SET calls = calls + 1 WHERE id = 1'
        );

        await recordDailyStat('calls');

        return sendJson(res, 200, { ok: true });
    }

    // -------------------------------------------------
    // STATISTIKA: UMUMIY (admin)
    // -------------------------------------------------

    if (url === '/api/stats' && method === 'GET') {

        if (!checkAdmin(req, res)) return;

        const result = await pool.query(
            'SELECT views, calls FROM stats WHERE id = 1'
        );

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

    // -------------------------------------------------
    // KO'RISHLARNI NOLGA TUSHIRISH (admin)
    // daily_stats jadvaliga tegilmaydi.
    // -------------------------------------------------

    if (url === '/api/stats/reset-views' && method === 'POST') {

        if (!checkAdmin(req, res)) return;

        await pool.query(
            'UPDATE stats SET views = 0 WHERE id = 1'
        );

        return sendJson(res, 200, { ok: true, views: 0 });
    }

    // -------------------------------------------------
    // KUNLIK STATISTIKA (admin)
    // -------------------------------------------------

    if (url === '/api/stats/daily' && method === 'GET') {

        if (!checkAdmin(req, res)) return;

        const result = await pool.query(`
            SELECT
                stat_date::text AS stat_date,
                views,
                calls
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

    // -------------------------------------------------
    // SAHIFALAR
    // -------------------------------------------------

    if (
        (url === '/admin' || url === '/admin.html') &&
        method === 'GET'
    ) {

        return sendFile(res, 'admin.html');
    }

    if (
        (url === '/' || url === '/index.html') &&
        method === 'GET'
    ) {

        return sendFile(res, 'index.html');
    }

    // -------------------------------------------------
    // BOSHQA STATIK FAYLLAR (css, js, rasm, shrift, favicon)
    // -------------------------------------------------

    if (method === 'GET') {

        const ext = path.extname(url).toLowerCase();

        if (ext && ext !== '.html' && MIME[ext]) {

            return sendFile(res, url.replace(/^\/+/, ''));
        }
    }

    // -------------------------------------------------
    // 404
    // -------------------------------------------------

    return sendJson(res, 404, { error: 'Sahifa topilmadi' });
}

// =====================================================
// SERVER
// =====================================================

const server = http.createServer(async (req, res) => {

    try {

        await handleRequest(req, res);

    } catch (e) {

        if (e instanceof HttpError) {

            return sendJson(res, e.status, { error: e.message });
        }

        console.error('SERVER ERROR:', e);

        return sendJson(res, 500, { error: 'Server xatosi' });
    }
});

// Render (proksi) orqasida uzilib qolmasligi uchun
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

async function start() {

    try {

        await initDatabase();

        server.listen(PORT, () => {

            console.log(`Server ${PORT}-portda ishlayapti`);
            console.log('Admin password tekshiruvi faol (3 ta urinish)');
        });

    } catch (error) {

        console.error('Database ulanishida xatolik:', error);

        process.exit(1);
    }
}

start();

// =====================================================
// XATOLAR VA TO'XTATISH
// =====================================================

process.on('unhandledRejection', reason => {

    console.error('UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', error => {

    console.error('UNCAUGHT EXCEPTION:', error);

    process.exit(1);
});

async function shutdown(signal) {

    console.log(`${signal}: Server to'xtatilmoqda...`);

    const force = setTimeout(() => process.exit(1), 10000);

    force.unref();

    try {

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
