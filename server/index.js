const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ADMIN_PASSWORD = 'Lazik_0005';
const UPLOAD_DIR = '/data/uploads';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync('/data/pulzarill.db');
db.exec(`CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price INTEGER NOT NULL
)`);
try {
    db.exec('ALTER TABLE cars ADD COLUMN image TEXT');
} catch (e) {
    // ustun allaqachon bor
}
try {
    db.exec('ALTER TABLE cars ADD COLUMN images TEXT');
} catch (e) {
    // ustun allaqachon bor
}
try {
    db.exec('ALTER TABLE cars ADD COLUMN description TEXT');
} catch (e) {
    // ustun allaqachon bor
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function sendFile(res, name) {
    const file = path.join(__dirname, 'public', name);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let tooBig = false;
        req.on('data', (chunk) => {
            if (tooBig) return;
            data += chunk;
            if (data.length > 20000000) {
                tooBig = true;
                reject(new Error('Juda katta'));
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function isAdmin(req) {
    return req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

function saveImage(dataUrl) {
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error("Rasm formati noto'g'ri");
    const buffer = Buffer.from(m[1], 'base64');
    if (buffer.length > 3000000) throw new Error('Rasm juda katta');
    const imageName = crypto.randomBytes(8).toString('hex') + '.jpg';
    fs.writeFileSync(path.join(UPLOAD_DIR, imageName), buffer);
    return imageName;
}

function parseImages(row) {
    if (row.images) {
        try { return JSON.parse(row.images); } catch (e) { /* fall through */ }
    }
    return row.image ? [row.image] : [];
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

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/api/cars' && req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM cars ORDER BY id DESC').all();
        return sendJson(res, 200, rows.map(carOut));
    }

    if (url === '/api/cars' && req.method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: "Parol noto'g'ri" });
        try {
            const body = JSON.parse(await readBody(req));
            const name = String(body.name || '').trim();
            const price = Number(body.price);
            const description = String(body.description || '').trim().slice(0, 2000);
            if (!name || !Number.isInteger(price) || price <= 0) {
                return sendJson(res, 400, { error: "Nom va narxni to'g'ri kiriting" });
            }

            const incomingImages = Array.isArray(body.images) ? body.images : [];
            if (incomingImages.length > 8) {
                return sendJson(res, 400, { error: "Ko'pi bilan 8 ta rasm" });
            }

            const savedNames = incomingImages.map(saveImage);

            db.prepare('INSERT INTO cars (name, price, description, images) VALUES (?, ?, ?, ?)')
                .run(name, price, description, JSON.stringify(savedNames));
            return sendJson(res, 201, { ok: true });
        } catch (e) {
            return sendJson(res, 400, { error: e.message || "Ma'lumot noto'g'ri yoki juda katta" });
        }
    }

    if (url.startsWith('/api/cars/') && req.method === 'DELETE') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: "Parol noto'g'ri" });
        const id = Number(url.split('/')[3]);
        const row = db.prepare('SELECT image, images FROM cars WHERE id = ?').get(id);
        if (row) {
            for (const name of parseImages(row)) {
                try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch (e) { /* fayl allaqachon yo'q */ }
            }
        }
        db.prepare('DELETE FROM cars WHERE id = ?').run(id);
        return sendJson(res, 200, { ok: true });
    }

    if (url.startsWith('/uploads/') && req.method === 'GET') {
        const name = url.slice('/uploads/'.length);
        const file = path.join(UPLOAD_DIR, name);
        if (!/^[a-f0-9]+\.jpg$/.test(name) || !fs.existsSync(file)) {
            res.writeHead(404);
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(file));
    }

    if (url === '/admin') return sendFile(res, 'admin.html');
    return sendFile(res, 'index.html');
});

server.listen(3000, () => console.log('Server 3000-portda'));
