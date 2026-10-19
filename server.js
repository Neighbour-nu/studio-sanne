'use strict';
/*
 * Studio Sanne: kleine webserver met beheeromgeving.
 * - Publieke site:   /            (public/index.html)
 * - Beheer:          /beheer      (public/beheer.html)
 * - Foto's:          /fotos/...   (uit DATA_DIR/fotos)
 * Alles wordt bewaard in DATA_DIR (standaard /data): site.json + map fotos/.
 */
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const PHOTO_DIR = path.join(DATA_DIR, 'fotos');
const ORIG_DIR = path.join(DATA_DIR, 'origineel'); // zonder watermerk, niet openbaar
const WATERMARK_FILE = path.join(__dirname, 'assets', 'watermerk.png');
const WATERMARK_VERSION = 2; // ophogen als het watermerk verandert: alle foto's worden dan opnieuw gemaakt
const DB_FILE = path.join(DATA_DIR, 'site.json');
const SECRET_FILE = path.join(DATA_DIR, '.sessiesleutel');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_DAYS = 30;
const MAX_FILE_MB = 30;

if (ADMIN_PASSWORD.length < 8) {
  console.error('FOUT: zet ADMIN_PASSWORD (minimaal 8 tekens) in het .env-bestand.');
  process.exit(1);
}

fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(ORIG_DIR, { recursive: true });

// ---------- sessiesleutel (blijft bewaard, zodat Sanne ingelogd blijft na een herstart) ----------
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  try { SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) { /* nieuw */ }
  if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
  }
}
// Een wachtwoordwijziging logt alle bestaande sessies uit.
const PW_FINGERPRINT = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0, 16);

// ---------- opslag ----------
const DEFAULT_DB = {
  categories: ['Uitgelicht', 'Natuur & dieren', 'Onderweg'],
  photos: [],
  settings: {
    aboutText: "Ik vind het leuk om met mijn camera op pad te gaan. Soms fotografeer ik dieren of bloemen in de natuur, en soms gewoon leuke dingen die ik onderweg zie op straat.\n\nMet deze website laat ik mijn favoriete foto's zien. Ik hoop dat je ze net zo leuk vindt als ik! 💛",
    email: '',
    instagram: ''
  }
};

let db;
function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      categories: Array.isArray(raw.categories) ? raw.categories : DEFAULT_DB.categories.slice(),
      photos: Array.isArray(raw.photos) ? raw.photos : [],
      settings: Object.assign({}, DEFAULT_DB.settings, raw.settings || {})
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Kon site.json niet lezen, start met lege lijst:', e.message);
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    saveDbSync();
  }
}
function saveDbSync() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
// Schrijfacties één voor één afhandelen.
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const result = await fn();
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}
loadDb();

// ---------- helpers ----------
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const publicPhoto = p => ({
  id: p.id, src: `/fotos/${p.file}?v=${p.wm || 0}`, thumb: `/fotos/${p.thumb}?v=${p.wm || 0}`,
  width: p.width, height: p.height, category: p.category, description: p.description
});
// ---------- watermerk ----------
// Tekstlogo rechtsonder: ongeveer 22% van de fotobreedte (bij staande foto's iets breder),
// met een marge van 3% van de kortste zijde.
let watermarkBuf = null;
try { watermarkBuf = fs.readFileSync(WATERMARK_FILE); } catch (_) { console.warn('Geen watermerk gevonden:', WATERMARK_FILE); }
// visibleAspect: als de foto ergens bijgesneden wordt getoond (de galerij toont 4:3),
// komt het watermerk binnen dat zichtbare deel te staan.
async function withWatermark(img, visibleAspect) {
  const meta = await sharp(img).metadata();
  let W = meta.width, H = meta.height, x0 = 0, y0 = 0;
  if (!watermarkBuf || W < 200 || H < 120) return sharp(img);
  if (visibleAspect) {
    if (W / H > visibleAspect) { const vw = Math.round(H * visibleAspect); x0 = Math.floor((W - vw) / 2); W = vw; }
    else { const vh = Math.round(W / visibleAspect); y0 = Math.floor((H - vh) / 2); H = vh; }
  }
  const portrait = H > W;
  const wmW = Math.round(W * (portrait ? 0.32 : (visibleAspect ? 0.26 : 0.22)));
  const wm = await sharp(watermarkBuf).resize({ width: wmW }).png().toBuffer({ resolveWithObject: true });
  const margin = Math.round(Math.min(W, H) * 0.03);
  return sharp(img).composite([{
    input: wm.data,
    left: Math.max(0, x0 + W - wm.info.width - margin),
    top: Math.max(0, y0 + H - wm.info.height - margin)
  }]);
}
// Maakt de openbare grote foto en de kleine versie, beide met watermerk.
async function renderPublic(clean, file, thumb) {
  const info = await (await withWatermark(clean))
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(path.join(PHOTO_DIR, file));
  const small = await sharp(clean)
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .toBuffer();
  await (await withWatermark(small, 4 / 3))
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(path.join(PHOTO_DIR, thumb));
  return info;
}
// Foto's van vóór het watermerk (of een oud watermerk) bijwerken.
async function upgradeWatermarks() {
  const todo = db.photos.filter(p => (p.wm || 0) < WATERMARK_VERSION);
  if (!todo.length || !watermarkBuf) return;
  console.log(`Watermerk toevoegen aan ${todo.length} bestaande foto('s)…`);
  for (const p of todo) {
    try {
      const orig = path.join(ORIG_DIR, p.file);
      if (!fs.existsSync(orig)) await fsp.copyFile(path.join(PHOTO_DIR, p.file), orig);
      await renderPublic(await fsp.readFile(orig), p.file, p.thumb);
      await mutate(() => { const q = db.photos.find(x => x.id === p.id); if (q) q.wm = WATERMARK_VERSION; });
    } catch (e) { console.error('Watermerk mislukt voor', p.file, e.message); }
  }
  console.log('Watermerk klaar.');
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- sessies ----------
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${exp}.${PW_FINGERPRINT}`;
  return `${payload}.${sign(payload)}`;
}
function validToken(tok) {
  if (typeof tok !== 'string') return false;
  const parts = tok.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  return parts[1] === PW_FINGERPRINT && Number(parts[0]) > Date.now();
}
function isAuthed(req) { return validToken(req.cookies && req.cookies.ss_sessie); }
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Je bent niet (meer) ingelogd.' });
  // Extra bescherming tegen verzoeken vanaf andere websites.
  if (req.get('X-Studio-Sanne') !== '1') return res.status(403).json({ error: 'Ongeldig verzoek.' });
  next();
}

// Simpele rem op inlogpogingen: max 10 mislukte pogingen per 15 minuten per IP.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}
function recordFail(ip) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(Date.now()); }

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: '200kb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Publieke gegevens
app.get('/api/site', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({
    categories: db.categories,
    photos: db.photos.map(publicPhoto),
    settings: db.settings
  });
});

// Inloggen / uitloggen
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Te vaak geprobeerd. Wacht een kwartiertje.' });
  const pw = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    recordFail(ip);
    return res.status(401).json({ error: 'Dat wachtwoord klopt niet.' });
  }
  attempts.delete(ip);
  res.cookie('ss_sessie', makeToken(), {
    httpOnly: true, sameSite: 'strict', secure: req.secure,
    maxAge: SESSION_DAYS * 864e5, path: '/'
  });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.clearCookie('ss_sessie', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ loggedIn: isAuthed(req) }));

// Foto's uploaden
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 }
});
app.post('/api/photos', requireAuth, (req, res, next) => {
  upload.single('foto')(req, res, err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Deze foto is groter dan ${MAX_FILE_MB} MB.` : 'Uploaden mislukt.';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) throw new HttpError(400, 'Er is geen foto meegestuurd.');
    const category = clean(req.body.category, 60);
    if (!db.categories.includes(category)) throw new HttpError(400, 'Kies een categorie.');
    const description = clean(req.body.description, 600);

    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}.jpg`, thumb = `${id}-klein.jpg`;
    let info;
    try {
      // .rotate() zet de foto rechtop; metadata (zoals GPS-locatie) wordt NIET meegenomen.
      const clean = await sharp(req.file.buffer, { failOn: 'error' }).rotate()
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
      // Schone versie (zonder watermerk) bewaren buiten de openbare map.
      await fsp.writeFile(path.join(ORIG_DIR, file), clean);
      info = await renderPublic(clean, file, thumb);
    } catch (e) {
      await Promise.all([
        path.join(PHOTO_DIR, file), path.join(PHOTO_DIR, thumb), path.join(ORIG_DIR, file)
      ].map(f => fsp.unlink(f).catch(() => {})));
      throw new HttpError(400, 'Dit bestand kan ik niet lezen als foto. Probeer een JPG of PNG.');
    }
    const photo = {
      id, file, thumb, width: info.width, height: info.height,
      category, description, created: new Date().toISOString(), wm: WATERMARK_VERSION
    };
    await mutate(() => { db.photos.unshift(photo); });
    res.json({ ok: true, photo: publicPhoto(photo) });
  } catch (e) { fail(res, e); }
});

// Foto aanpassen
app.patch('/api/photos/:id', requireAuth, async (req, res) => {
  try {
    const result = await mutate(() => {
      const p = db.photos.find(x => x.id === req.params.id);
      if (!p) throw new HttpError(404, 'Foto niet gevonden.');
      if (req.body.category !== undefined) {
        const c = clean(req.body.category, 60);
        if (!db.categories.includes(c)) throw new HttpError(400, 'Onbekende categorie.');
        p.category = c;
      }
      if (req.body.description !== undefined) p.description = clean(req.body.description, 600);
      return publicPhoto(p);
    });
    res.json({ ok: true, photo: result });
  } catch (e) { fail(res, e); }
});

// Foto verwijderen
app.delete('/api/photos/:id', requireAuth, async (req, res) => {
  try {
    const removed = await mutate(() => {
      const i = db.photos.findIndex(x => x.id === req.params.id);
      if (i < 0) throw new HttpError(404, 'Foto niet gevonden.');
      return db.photos.splice(i, 1)[0];
    });
    await Promise.all([
      path.join(PHOTO_DIR, removed.file), path.join(PHOTO_DIR, removed.thumb), path.join(ORIG_DIR, removed.file)
    ].map(f => fsp.unlink(f).catch(() => {})));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Volgorde
app.post('/api/photos/order', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : null;
    await mutate(() => {
      if (!ids || ids.length !== db.photos.length || new Set(ids).size !== ids.length) {
        throw new HttpError(400, 'De lijst klopt niet meer. Ververs de pagina.');
      }
      const byId = new Map(db.photos.map(p => [p.id, p]));
      if (!ids.every(id => byId.has(id))) throw new HttpError(400, 'De lijst klopt niet meer. Ververs de pagina.');
      db.photos = ids.map(id => byId.get(id));
    });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Categorieën
app.post('/api/categories', requireAuth, async (req, res) => {
  try {
    const name = clean(req.body.name, 40);
    await mutate(() => {
      if (!name) throw new HttpError(400, 'Geef de categorie een naam.');
      if (db.categories.some(c => c.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'Die categorie bestaat al.');
      if (db.categories.length >= 20) throw new HttpError(400, 'Maximaal 20 categorieën.');
      db.categories.push(name);
    });
    res.json({ ok: true, categories: db.categories });
  } catch (e) { fail(res, e); }
});
app.put('/api/categories', requireAuth, async (req, res) => {
  // Hernoemen: { from, to }   of   volgorde: { order: [...] }
  try {
    await mutate(() => {
      if (Array.isArray(req.body.order)) {
        const order = req.body.order.map(String);
        if (order.length !== db.categories.length || !order.every(c => db.categories.includes(c))) {
          throw new HttpError(400, 'De lijst klopt niet meer. Ververs de pagina.');
        }
        db.categories = order;
        return;
      }
      const from = clean(req.body.from, 40), to = clean(req.body.to, 40);
      const i = db.categories.indexOf(from);
      if (i < 0) throw new HttpError(404, 'Categorie niet gevonden.');
      if (!to) throw new HttpError(400, 'Geef de categorie een naam.');
      if (to !== from && db.categories.some(c => c.toLowerCase() === to.toLowerCase())) throw new HttpError(400, 'Die categorie bestaat al.');
      db.categories[i] = to;
      db.photos.forEach(p => { if (p.category === from) p.category = to; });
    });
    res.json({ ok: true, categories: db.categories });
  } catch (e) { fail(res, e); }
});
app.delete('/api/categories', requireAuth, async (req, res) => {
  try {
    const name = clean(req.body.name, 40);
    await mutate(() => {
      if (!db.categories.includes(name)) throw new HttpError(404, 'Categorie niet gevonden.');
      const n = db.photos.filter(p => p.category === name).length;
      if (n) throw new HttpError(400, `Er staan nog ${n} foto('s) in "${name}". Zet die eerst in een andere categorie.`);
      if (db.categories.length <= 1) throw new HttpError(400, 'Je hebt minstens één categorie nodig.');
      db.categories = db.categories.filter(c => c !== name);
    });
    res.json({ ok: true, categories: db.categories });
  } catch (e) { fail(res, e); }
});

// Teksten
app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const s = {};
    if (req.body.aboutText !== undefined) s.aboutText = clean(req.body.aboutText, 3000);
    if (req.body.email !== undefined) {
      const e = clean(req.body.email, 120);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Dat e-mailadres ziet er niet goed uit.');
      s.email = e;
    }
    if (req.body.instagram !== undefined) {
      let ig = clean(req.body.instagram, 200);
      if (ig && !/^https?:\/\//i.test(ig)) ig = 'https://www.instagram.com/' + ig.replace(/^@/, '') + '/';
      s.instagram = ig;
    }
    await mutate(() => { Object.assign(db.settings, s); });
    res.json({ ok: true, settings: db.settings });
  } catch (e) { fail(res, e); }
});

function fail(res, e) {
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Er ging iets mis op de server.' });
}

// Statische bestanden
app.use('/fotos', express.static(PHOTO_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));
app.get(['/beheer', '/beheer/'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.sendFile(path.join(__dirname, 'public', 'beheer.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'], maxAge: '1h' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Studio Sanne draait op poort ${PORT} (data: ${DATA_DIR})`);
  upgradeWatermarks().catch(e => console.error(e));
});
