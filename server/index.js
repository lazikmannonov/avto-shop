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

// =========================
// DATABASE
// =========================

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cars (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            price INTEGER NOT NULL,
            description TEXT DEFAULT '',
            images TEXT DEFAULT '[]'
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS image_files (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            data BYTEA NOT NULL
        )
    `);

    console.log('PostgreSQL database tayyor');
}

// =========================
// HELPERS
// =========================

function sendJson(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8'
    });

    res.end(JSON.stringify(data));
}

function sendFile(res, name) {
    const file = path.join(__dirname, 'public', name);

    if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('File topilmadi');
    }

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
    });

    res.end(fs.readFileSync(file));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let tooBig = false;

        req.on('data', (chunk) => {
            if (tooBig) return;

            data += chunk;

            // 30 MB
            if (data.length > 30000000) {
                tooBig = true;
                reject(new Error('Ma\'lumot juda katta'));
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

function isAdmin(req) {
    return req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

// =========================
// IMAGE
// =========================

function prepareImage(dataUrl) {
    const match = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl);

    if (!match) {
        throw new Error("Rasm formati noto'g'ri");
    }

    const buffer = Buffer.from(match[1], 'base64');

    if (buffer.length > 3000000) {
        throw new Error('Bitta rasm 3 MB dan katta bo\'lmasligi kerak');
    }

    const imageName =
        crypto.randomBytes(8).toString('hex') + '.jpg';

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
        const images = JSON.parse(row.images);

        if (Array.isArray(images)) {
            return images;
        }

        return [];
    } catch (e) {
        return [];
    }
}

function carOut(row) {
    return {
        id: row.id,
        name: row.name,
        price: row.price,
        description: row.description || '',
        images: parseImages(row)
    };
}

// =========================
// SERVER
// =========================

const server = http.createServer(async (req, res) => {
    try {
        const url = req.url.split('?')[0];

        // =========================
        // GET CARS
        // =========================

        if (url === '/api/cars' && req.method === 'GET') {
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

        // =========================
        // ADD CAR
        // =========================

        if (url === '/api/cars' && req.method === 'POST') {
            if (!isAdmin(req)) {
                return sendJson(res, 401, {
                    error: "Parol noto'g'ri"
                });
            }

            const client = await pool.connect();

            try {
                const body = JSON.parse(await readBody(req));

                const name = String(body.name || '').trim();
                const price = Number(body.price);

                const description =
                    String(body.description || '')
                        .trim()
                        .slice(0, 2000);

                if (
                    !name ||
                    !Number.isInteger(price) ||
                    price <= 0
                ) {
                    return sendJson(res, 400, {
                        error: "Nom va narxni to'g'ri kiriting"
                    });
                }

                const incomingImages =
                    Array.isArray(body.images)
                        ? body.images
                        : [];

                if (incomingImages.length > 8) {
                    return sendJson(res, 400, {
                        error: "Ko'pi bilan 8 ta rasm"
                    });
                }

                // Rasmlarni oldindan tayyorlaymiz
                const preparedImages =
                    incomingImages.map(prepareImage);

                await client.query('BEGIN');

                const savedNames = [];

                // Rasmlarni PostgreSQL'ga saqlash
                for (const image of preparedImages) {
                    await client.query(
                        `
                        INSERT INTO image_files
                        (name, data)
                        VALUES ($1, $2)
                        `,
                        [
                            image.name,
                            image.buffer
                        ]
                    );

                    savedNames.push(image.name);
                }

                // Mashinani saqlash
                await client.query(
                    `
                    INSERT INTO cars
                    (name, price, description, images)
                    VALUES ($1, $2, $3, $4)
                    `,
                    [
                        name,
                        price,
                        description,
                        JSON.stringify(savedNames)
                    ]
                );

                await client.query('COMMIT');

                return sendJson(res, 201, {
                    ok: true
                });

            } catch (e) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error(e);

                return sendJson(res, 400, {
                    error:
                        e.message ||
                        "Ma'lumot noto'g'ri yoki juda katta"
                });

            } finally {
                client.release();
            }
        }

        // =========================
        // DELETE CAR
        // =========================

        if (
            url.startsWith('/api/cars/') &&
            req.method === 'DELETE'
        ) {
            if (!isAdmin(req)) {
                return sendJson(res, 401, {
                    error: "Parol noto'g'ri"
                });
            }

            const id = Number(url.split('/')[3]);

            if (!Number.isInteger(id)) {
                return sendJson(res, 400, {
                    error: "ID noto'g'ri"
                });
            }

            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                const result = await client.query(
                    `
                    SELECT images
                    FROM cars
                    WHERE id = $1
                    `,
                    [id]
                );

                if (result.rows.length > 0) {
                    const images =
                        parseImages(result.rows[0]);

                    for (const name of images) {
                        await client.query(
                            `
                            DELETE FROM image_files
                            WHERE name = $1
                            `,
                            [name]
                        );
                    }
                }

                await client.query(
                    `
                    DELETE FROM cars
                    WHERE id = $1
                    `,
                    [id]
                );

                await client.query('COMMIT');

                return sendJson(res, 200, {
                    ok: true
                });

            } catch (e) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {}

                console.error(e);

                return sendJson(res, 500, {
                    error: 'O\'chirishda xatolik'
                });

            } finally {
                client.release();
            }
        }

        // =========================
        // GET IMAGE
        // =========================

        if (
            url.startsWith('/uploads/') &&
            req.method === 'GET'
        ) {
            const name =
                url.slice('/uploads/'.length);

            if (!/^[a-f0-9]+\.jpg$/.test(name)) {
                res.writeHead(404);
                return res.end();
            }

            const result = await pool.query(
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

            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Cache-Control':
                    'public, max-age=86400'
            });

            return res.end(result.rows[0].data);
        }

        // =========================
        // ADMIN
        // =========================

        if (url === '/admin') {
            return sendFile(res, 'admin.html');
        }

        // =========================
        // MAIN PAGE
        // =========================

        return sendFile(res, 'index.html');

    } catch (e) {
        console.error(e);

        return sendJson(res, 500, {
            error: 'Server xatosi'
        });
    }
});

// =========================
// START
// =========================

async function start() {
    try {
        await initDatabase();

        server.listen(3000, () => {
            console.log('Server 3000-portda ishlayapti');
        });

    } catch (error) {
        console.error(
            'Database ulanishida xatolik:',
            error
        );

        process.exit(1);
    }
}

start();

// =========================
// SHUTDOWN
// =========================

process.on('SIGTERM', async () => {
    console.log('Server to\'xtatilmoqda...');

    await pool.end();

    process.exit(0);
});
