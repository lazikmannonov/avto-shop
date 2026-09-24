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
            sold BOOLEAN DEFAULT false
        )
    `);

    await pool.query(`
        ALTER TABLE cars
        ADD COLUMN IF NOT EXISTS sold BOOLEAN DEFAULT false
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
        INSERT INTO site_settings
        (
            id,
            phone,
            telegram,
            whatsapp,
            instagram,
            address
        )
        VALUES
        (
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
// RESPONSE
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

    const file = path.join(
        __dirname,
        'public',
        name
    );

    if (!fs.existsSync(file)) {

        res.writeHead(404);

        return res.end(
            'File topilmadi'
        );
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
            let tooBig = false;

            req.on('data', chunk => {

                if (tooBig) {
                    return;
                }

                data += chunk;

                if (data.length > 30000000) {

                    tooBig = true;

                    reject(
                        new Error(
                            "Ma'lumot juda katta"
                        )
                    );
                }
            });

            req.on('end', () => {

                if (!tooBig) {
                    resolve(data);
                }
            });

            req.on('error', reject);
        }
    );
}

// =====================================================
// ADMIN PASSWORD
// =====================================================

// Header orqali tekshirish
function isAdminHeader(req) {

    const password =
        req.headers['x-admin-password'];

    return (
        typeof password === 'string' &&
        password === ADMIN_PASSWORD
    );
}

// Body orqali tekshirish
function isAdminBody(body) {

    if (!body || typeof body !== 'object') {
        return false;
    }

    const password =
        String(body.password || '');

    return password === ADMIN_PASSWORD;
}

// Ikkalasini ham qabul qiladi
function isAdmin(req, body = null) {

    if (isAdminHeader(req)) {
        return true;
    }

    if (isAdminBody(body)) {
        return true;
    }

    return false;
}

// =====================================================
// IMAGE
// =====================================================

function prepareImage(dataUrl) {

    if (typeof dataUrl !== 'string') {

        throw new Error(
            "Rasm formati noto'g'ri"
        );
    }

    const match =
        /^data:image\/jpeg;base64,(.+)$/
            .exec(dataUrl);

    if (!match) {

        throw new Error(
            "Rasm faqat JPEG formatda bo'lishi kerak"
        );
    }

    const buffer =
        Buffer.from(
            match[1],
            'base64'
        );

    if (buffer.length > 3000000) {

        throw new Error(
            "Bitta rasm 3 MB dan katta bo'lmasligi kerak"
        );
    }

    const imageName =
        crypto
            .randomBytes(8)
            .toString('hex') +
        '.jpg';

    return {
        name: imageName,
        buffer
    };
}

function parseImages(row) {

    if (!row.images) {
        return [];
    }

    try {

        const images =
            JSON.parse(row.images);

        if (Array.isArray(images)) {
            return images;
        }

        return [];

    } catch (e) {

        return [];
    }
}

// =====================================================
// CAR OUTPUT
// =====================================================

function carOut(row) {

    return {
        id: row.id,

        name: row.name,

        price: row.price,

        description:
            row.description || '',

        images:
            parseImages(row),

        sold:
            row.sold || false
    };
}

// =====================================================
// SETTINGS
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
// DAILY STATISTICS
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
        INSERT INTO daily_stats
        (
            stat_date,
            views,
            calls
        )
        VALUES
        (
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

const server =
    http.createServer(
        async (req, res) => {

            try {

                const url =
                    req.url.split('?')[0];

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
                        result.rows.map(carOut)
                    );
                }

                // =================================================
                // ADD CAR / ADD HOME
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

                    // MUHIM:
                    // Admin paneldagi password body ichidan ham olinadi
                    if (!isAdmin(req, body)) {

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
                                body.name || ''
                            )
                            .trim();

                        const price =
                            Number(body.price);

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

                        const incomingImages =
                            Array.isArray(
                                body.images
                            )
                                ? body.images
                                : [];

                        if (
                            incomingImages.length > 8
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
                                INSERT INTO image_files
                                (
                                    name,
                                    data
                                )
                                VALUES
                                (
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

                        await client.query(
                            `
                            INSERT INTO cars
                            (
                                name,
                                price,
                                description,
                                images
                            )
                            VALUES
                            (
                                $1,
                                $2,
                                $3,
                                $4
                            )
                            `,
                            [
                                name,
                                price,
                                description,
                                JSON.stringify(
                                    savedNames
                                )
                            ]
                        );

                        await client.query(
                            'COMMIT'
                        );

                        return sendJson(
                            res,
                            201,
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

                    if (!isAdmin(req, body)) {

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
                        .slice(0, 50);

                    const telegram =
                        String(
                            body.telegram || ''
                        )
                        .trim()
                        .slice(0, 500);

                    const whatsapp =
                        String(
                            body.whatsapp || ''
                        )
                        .trim()
                        .slice(0, 500);

                    const instagram =
                        String(
                            body.instagram || ''
                        )
                        .trim()
                        .slice(0, 500);

                    const address =
                        String(
                            body.address || ''
                        )
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
                    url.startsWith('/api/cars/') &&
                    url.endsWith('/sold') &&
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

                    if (!isAdmin(req, body)) {

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
                        !Number.isInteger(id)
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

                            SET sold =
                                NOT sold

                            WHERE id = $1

                            RETURNING sold
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
                                    "Uy topilmadi"
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
                    url.startsWith('/api/cars/') &&
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

                    if (!isAdmin(req, body)) {

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
                        !Number.isInteger(id)
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
                            result.rows.length > 0
                        ) {

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

                        if (
                            deleted.rowCount === 0
                        ) {

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

                    await pool.query(
                        `
                        UPDATE stats

                        SET views =
                            views + 1

                        WHERE id = 1
                        `
                    );

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

                    await pool.query(
                        `
                        UPDATE stats

                        SET calls =
                            calls + 1

                        WHERE id = 1
                        `
                    );

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
                        await pool.query(
                            `
                            SELECT
                                views,
                                calls

                            FROM stats

                            WHERE id = 1
                            `
                        );

                    const row =
                        result.rows[0] || {
                            views: 0,
                            calls: 0
                        };

                    const carsResult =
                        await pool.query(
                            `
                            SELECT

                                COUNT(*)::int
                                AS total,

                                COUNT(*)
                                FILTER (
                                    WHERE sold = true
                                )::int
                                AS sold

                            FROM cars
                            `
                        );

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
                        await pool.query(
                            `
                            SELECT
                                stat_date,
                                views,
                                calls

                            FROM daily_stats

                            WHERE stat_date >=
                                CURRENT_DATE -
                                INTERVAL '29 days'

                            ORDER BY
                                stat_date ASC
                            `
                        );

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
                    url === '/admin'
                ) {

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
        }
    );

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
