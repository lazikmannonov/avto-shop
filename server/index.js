```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL topilmadi!');
    process.exit(1);
}

if (!ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD topilmadi!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10
});

// =====================================================
// DATABASE
// =====================================================

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cars (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            price INTEGER NOT NULL,
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

    // Eski database uchun ustunlarni qo'shish
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
        'Cache-Control': 'no-store'
    });

    res.end(JSON.stringify(data));
}

// =====================================================
// FILE
// =====================================================

function sendFile(res, name) {
    const file = path.join(__dirname, 'public', name);

    if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('File topilmadi');
    }

    let contentType = 'text/html; charset=utf-8';

    if (name.endsWith('.css')) {
        contentType = 'text/css; charset=utf-8';
    }

    if (name.endsWith('.js')) {
        contentType = 'application/javascript; charset=utf-8';
    }

    res.writeHead(200, {
        'Content-Type': contentType
    });

    res.end(fs.readFileSync(file));
}

// =====================================================
// READ BODY
// =====================================================

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let tooBig = false;

        req.on('data', chunk => {
            if (tooBig) return;

            data += chunk;

            if (data.length > 30000000) {
                tooBig = true;
                reject(new Error("Ma'lumot juda katta"));
            }
        });

        req.on('end', () => {
            if (!tooBig) {
                resolve(data);
            }
        });

        req.on('error', reject);
    });
}

// =====================================================
// ADMIN
// =====================================================

function isAdminHeader(req) {
    const password = req.headers['x-admin-password'];

    return (
        typeof password === 'string' &&
        password === ADMIN_PASSWORD
    );
}

function isAdminBody(body) {
    if (!body || typeof body !== 'object') {
        return false;
    }

    return String(body.password || '') === ADMIN_PASSWORD;
}

function isAdmin(req, body = null) {
    return isAdminHeader(req) || isAdminBody(body);
}

// =====================================================
// IMAGE
// =====================================================

function prepareImage(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error("Rasm formati noto'g'ri");
    }

    const match =
        /^data:image\/jpeg;base64,(.+)$/i.exec(dataUrl);

    if (!match) {
        throw new Error(
            "Rasm faqat JPEG formatda bo'lishi kerak"
        );
    }

    const buffer = Buffer.from(match[1], 'base64');

    if (buffer.length > 3000000) {
        throw new Error(
            "Bitta rasm 3 MB dan katta bo'lmasligi kerak"
        );
    }

    const imageName =
        crypto.randomBytes(8).toString('hex') + '.jpg';

    return {
        name: imageName,
        buffer
    };
}

function parseImages(row) {
    if (!row || !row.images) {
        return [];
    }

    try {
        const images = JSON.parse(row.images);

        return Array.isArray(images)
            ? images
            : [];
    } catch (e) {
        return [];
    }
}

function parseTypes(row) {
    if (!row) {
        return [];
    }

    if (!row.types) {
        return row.type ? [row.type] : [];
    }

    try {
        const types = JSON.parse(row.types);

        if (Array.isArray(types)) {
            return types;
        }
    } catch (e) {}

    return row.type ? [row.type] : [];
}

// =====================================================
// CAR OUTPUT
// =====================================================

function carOut(row) {
    const types = parseTypes(row);

    return {
        id: row.id,

        name: row.name || '',

        title: row.name || '',

        price: Number(row.price) || 0,

        currency: row.currency || 'UZS',

        type:
            row.type ||
            types[0] ||
            '',

        types,

        location:
            row.location ||
            row.address ||
            '',

        address:
            row.address ||
            row.location ||
            '',

        rooms: Number(row.rooms) || 0,

        area: Number(row.area) || 0,

        phone: row.phone || '',

        description: row.description || '',

        images: parseImages(row),

        sold: Boolean(row.sold),

        status:
            row.sold
                ? 'sold'
                : 'available'
    };
}

// =====================================================
// SETTINGS
// =====================================================

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
// DAILY STATISTICS
// =====================================================

async function recordDailyStat(type) {
    if (type !== 'views' && type !== 'calls') {
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
            type === 'views' ? 1 : 0,
            type === 'calls' ? 1 : 0
        ]
    );
}

// =====================================================
// SERVER
// =====================================================

const server = http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        // =================================================
        // GET CARS
        // =================================================

        if (
            url === '/api/cars' &&
            req.method === 'GET'
        ) {
            const result = await pool.query(`
                SELECT *
                FROM cars
                ORDER BY id DESC
            `);

            return sendJson(
                res,
                200,
                result.rows.map(carOut)
            );
        }

        // =================================================
        // ADD CAR / HOME
        // =================================================

        if (
            url === '/api/cars' &&
            req.method === 'POST'
        ) {
            let body;

            try {
                body = JSON.parse(
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

            if (!isAdmin(req, body)) {
                return sendJson(
                    res,
                    401,
                    {
                        error: "Parol noto'g'ri"
                    }
                );
            }

            const client = await pool.connect();

            try {
                const name =
                    String(
                        body.name ||
                        body.title ||
                        ''
                    )
                    .trim()
                    .slice(0, 300);

                const price = Number(body.price);

                const currency =
                    String(
                        body.currency || 'UZS'
                    ).toUpperCase();

                const type =
                    String(
                        body.type || ''
                    )
                    .trim()
                    .slice(0, 100);

                const types =
                    Array.isArray(body.types)
                        ? body.types
                            .map(x => String(x).trim())
                            .filter(Boolean)
                            .slice(0, 3)
                        : (
                            type
                                ? [type]
                                : []
                        );

                const location =
                    String(
                        body.location ||
                        body.address ||
                        ''
                    )
                    .trim()
                    .slice(0, 500);

                const address =
                    String(
                        body.address ||
                        body.location ||
                        ''
                    )
                    .trim()
                    .slice(0, 500);

                const rooms =
                    Number(body.rooms) || 0;

                const area =
                    Number(body.area) || 0;

                const phone =
                    String(
                        body.phone || ''
                    )
                    .trim()
                    .slice(0, 100);

                const description =
                    String(
                        body.description || ''
                    )
                    .trim()
                    .slice(0, 2000);

                if (
                    !name ||
                    !Number.isInteger(price) ||
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
                    currency !== 'UZS' &&
                    currency !== 'USD'
                ) {
                    return sendJson(
                        res,
                        400,
                        {
                            error:
                                "Valyuta noto'g'ri"
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
                    Array.isArray(body.images)
                        ? body.images
                        : [];

                if (incomingImages.length > 8) {
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
                    incomingImages.map(prepareImage);

                await client.query('BEGIN');

                const savedNames = [];

                for (const image of preparedImages) {
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

                    savedNames.push(image.name);
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
                            JSON.stringify(savedNames),
                            currency,
                            types[0] || '',
                            JSON.stringify(types),
                            location,
                            address,
                            rooms,
                            area,
                            phone
                        ]
                    );

                await client.query('COMMIT');

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
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error(e);

                return sendJson(
                    res,
                    400,
                    {
                        error:
                            e.message ||
                            "Ma'lumot noto'g'ri yoki juda katta"
                    }
                );

            } finally {
                client.release();
            }
        }

        // =================================================
        // EDIT CAR / HOME
        // =================================================

        if (
            /^\/api\/cars\/\d+$/.test(url) &&
            req.method === 'PUT'
        ) {
            let body;

            try {
                body = JSON.parse(
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

            if (!isAdmin(req, body)) {
                return sendJson(
                    res,
                    401,
                    {
                        error: "Parol noto'g'ri"
                    }
                );
            }

            const id =
                Number(url.split('/')[3]);

            if (!Number.isInteger(id)) {
                return sendJson(
                    res,
                    400,
                    {
                        error: "ID noto'g'ri"
                    }
                );
            }

            const client = await pool.connect();

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

                if (oldResult.rows.length === 0) {
                    return sendJson(
                        res,
                        404,
                        {
                            error: "Uy topilmadi"
                        }
                    );
                }

                const oldCar =
                    oldResult.rows[0];

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
                    .slice(0, 300);

                const price =
                    body.price !== undefined
                        ? Number(body.price)
                        : Number(oldCar.price);

                const currency =
                    String(
                        body.currency !== undefined
                            ? body.currency
                            : (
                                oldCar.currency ||
                                'UZS'
                            )
                    ).toUpperCase();

                const oldTypes =
                    parseTypes(oldCar);

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
                    .slice(0, 100);

                const types =
                    Array.isArray(body.types)
                        ? body.types
                            .map(x => String(x).trim())
                            .filter(Boolean)
                            .slice(0, 3)
                        : (
                            type
                                ? [type]
                                : oldTypes
                        );

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
                    .slice(0, 500);

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
                    .slice(0, 500);

                const rooms =
                    body.rooms !== undefined
                        ? Number(body.rooms) || 0
                        : Number(oldCar.rooms) || 0;

                const area =
                    body.area !== undefined
                        ? Number(body.area) || 0
                        : Number(oldCar.area) || 0;

                const phone =
                    String(
                        body.phone !== undefined
                            ? body.phone
                            : oldCar.phone || ''
                    )
                    .trim()
                    .slice(0, 100);

                const description =
                    String(
                        body.description !== undefined
                            ? body.description
                            : oldCar.description || ''
                    )
                    .trim()
                    .slice(0, 2000);

                if (
                    !name ||
                    !Number.isInteger(price) ||
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
                    currency !== 'UZS' &&
                    currency !== 'USD'
                ) {
                    return sendJson(
                        res,
                        400,
                        {
                            error:
                                "Valyuta noto'g'ri"
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
                    Array.isArray(body.images)
                        ? body.images
                        : null;

                await client.query('BEGIN');

                let finalImages =
                    parseImages(oldCar);

                // Agar images yuborilsa,
                // eski rasmlar o'chirilib,
                // yangi rasmlar saqlanadi.
                if (incomingImages !== null) {
                    if (incomingImages.length > 8) {
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
                        await client.query(
                            `
                            DELETE FROM image_files
                            WHERE name = $1
                            `,
                            [oldImage]
                        );
                    }

                    finalImages = savedNames;
                }

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
                            JSON.stringify(finalImages),
                            currency,
                            types[0] || '',
                            JSON.stringify(types),
                            location,
                            address,
                            rooms,
                            area,
                            phone,
                            id
                        ]
                    );

                await client.query('COMMIT');

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
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error(e);

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

            const row = result.rows[0];

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
                body = JSON.parse(
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

            if (!isAdmin(req, body)) {
                return sendJson(
                    res,
                    401,
                    {
                        error: "Parol noto'g'ri"
                    }
                );
            }

            const phone =
                String(body.phone || '')
                    .trim()
                    .slice(0, 50);

            const telegram =
                String(body.telegram || '')
                    .trim()
                    .slice(0, 500);

            const whatsapp =
                String(body.whatsapp || '')
                    .trim()
                    .slice(0, 500);

            const instagram =
                String(body.instagram || '')
                    .trim()
                    .slice(0, 500);

            const address =
                String(body.address || '')
                    .trim()
                    .slice(0, 300);

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
                    body = JSON.parse(raw);
                }
            } catch (e) {
                body = {};
            }

            if (!isAdmin(req, body)) {
                return sendJson(
                    res,
                    401,
                    {
                        error: "Parol noto'g'ri"
                    }
                );
            }

            const parts = url.split('/');
            const id = Number(parts[3]);

            if (!Number.isInteger(id)) {
                return sendJson(
                    res,
                    400,
                    {
                        error: "ID noto'g'ri"
                    }
                );
            }

            const result =
                await pool.query(
                    `
                    UPDATE cars
                    SET sold = NOT sold
                    WHERE id = $1
                    RETURNING sold
                    `,
                    [id]
                );

            if (result.rows.length === 0) {
                return sendJson(
                    res,
                    404,
                    {
                        error: "Uy topilmadi"
                    }
                );
            }

            return sendJson(
                res,
                200,
                {
                    ok: true,
                    sold:
                        result.rows[0].sold
                }
            );
        }

        // =================================================
        // DELETE CAR / HOME
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
                    body = JSON.parse(raw);
                }
            } catch (e) {
                body = {};
            }

            if (!isAdmin(req, body)) {
                return sendJson(
                    res,
                    401,
                    {
                        error: "Parol noto'g'ri"
                    }
                );
            }

            const id =
                Number(url.split('/')[3]);

            if (!Number.isInteger(id)) {
                return sendJson(
                    res,
                    400,
                    {
                        error: "ID noto'g'ri"
                    }
                );
            }

            const client =
                await pool.connect();

            try {
                await client.query('BEGIN');

                const result =
                    await client.query(
                        `
                        SELECT images
                        FROM cars
                        WHERE id = $1
                        `,
                        [id]
                    );

                if (result.rows.length > 0) {
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
                }

                const deleted =
                    await client.query(
                        `
                        DELETE FROM cars
                        WHERE id = $1
                        `,
                        [id]
                    );

                if (deleted.rowCount === 0) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return sendJson(
                        res,
                        404,
                        {
                            error:
                                "Uy topilmadi"
                        }
                    );
                }

                await client.query('COMMIT');

                return sendJson(
                    res,
                    200,
                    {
                        ok: true
                    }
                );

            } catch (e) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error(e);

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
                !/^[a-f0-9]+\.jpg$/.test(name)
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

            if (result.rows.length === 0) {
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

            await recordDailyStat('views');

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

            await recordDailyStat('calls');

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
            if (!isAdminHeader(req)) {
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
                        Number(row.views) || 0,

                    calls:
                        Number(row.calls) || 0,

                    cars:
                        Number(cars.total) || 0,

                    sold:
                        Number(cars.sold) || 0
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
            if (!isAdminHeader(req)) {
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

        if (url === '/admin') {
            return sendFile(
                res,
                'admin.html'
            );
        }

        // =================================================
        // MAIN PAGE
        // =================================================

        return sendFile(
            res,
            'index.html'
        );

    } catch (e) {
        console.error(e);

        return sendJson(
            res,
            500,
            {
                error:
                    'Server xatosi'
            }
        );
    }
});

// =====================================================
// START SERVER
// =====================================================

async function start() {
    try {
        await initDatabase();

        const PORT =
            process.env.PORT || 3000;

        server.listen(
            PORT,
            () => {
                console.log(
                    `Server ${PORT}-portda ishlayapti`
                );
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
// SHUTDOWN
// =====================================================

process.on(
    'SIGTERM',
    async () => {
        console.log(
            "Server to'xtatilmoqda..."
        );

        await pool.end();

        process.exit(0);
    }
);
```
