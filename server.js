// ระบบดูภาพ EKG และผล Out Lab (เรียกดูอย่างเดียว)
// ตั้งค่าใน .env (ดู .env.example) แล้วรัน: npm start

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const hosxp = require('./hosxp');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(__dirname, process.env.UPLOAD_DIR || 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- ฐานข้อมูลแบบไฟล์ JSON ----------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { patients: {}, records: [] };
  }
}
let db = loadDb();
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const TYPES = ['ekg', 'lab'];
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf'];

// ---------- Express ----------
const app = express();
app.use(express.json());

// ---------- Session ----------
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE = Number(process.env.SESSION_MAX_AGE || 8 * 3600) * 1000; // default 8 ชั่วโมง

const needsAuth = !!(process.env.APP_PASSWORD || process.env.HOSXP_DB_HOST);

if (needsAuth) {
  app.use(session({
    store: new FileStore({ path: SESSION_DIR, retries: 1, ttl: SESSION_MAX_AGE / 1000, logFn: () => {} }),
    secret: SESSION_SECRET,
    name: 'ekgsid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.HTTPS === 'true',
      maxAge: SESSION_MAX_AGE,
      sameSite: 'lax',
    },
  }));
}

// ---------- Login Guard ----------
const PUBLIC_PATHS = new Set(['/login.html', '/login.css', '/api/auth/login', '/api/auth/info']);

function requireLogin(req, res, next) {
  if (!needsAuth) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session?.user) return next();

  // API → ตอบ 401 JSON
  if (req.path.startsWith('/api/') || req.path.startsWith('/his/') || req.path.startsWith('/files/')) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน', redirect: '/login.html' });
  }
  // หน้าเว็บ → redirect ไปหน้า login
  const nextUrl = encodeURIComponent(req.originalUrl);
  return res.redirect(`/login.html?next=${nextUrl}`);
}

app.use(requireLogin);

// ---------- Static files ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth API ----------

// ข้อมูล auth mode (ไม่ต้องล็อกอิน)
app.get('/api/auth/info', (req, res) => {
  res.json({ mode: auth.AUTH_MODE, needsAuth });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  if (!needsAuth) return res.json({ ok: true, user: { username: 'guest', name: 'Guest', role: 'admin' } });

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณาระบุ Username และ Password' });
  }

  // Rate limiting แบบง่าย (IP-based, in-memory)
  const ip = req.ip;
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > attempts.resetAt) { attempts.count = 0; attempts.resetAt = now + 60000; }
  if (attempts.count >= 10) {
    return res.status(429).json({ error: 'ล็อกอินผิดหลายครั้ง กรุณารอ 1 นาทีแล้วลองใหม่' });
  }

  const user = await auth.verify(username, password);
  if (!user) {
    attempts.count++;
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: 'Username หรือ Password ไม่ถูกต้อง' });
  }

  // สำเร็จ: ล้าง attempt, สร้าง session
  loginAttempts.delete(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการสร้าง session' });
    req.session.user = user;
    res.json({ ok: true, user: { username: user.username, name: user.name, role: user.role } });
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session?.destroy(() => {});
  res.json({ ok: true });
});

// ข้อมูล user ที่ล็อกอินอยู่
app.get('/api/auth/me', (req, res) => {
  if (!needsAuth) return res.json({ username: 'guest', name: 'Guest', role: 'admin' });
  if (!req.session?.user) return res.status(401).json({ error: 'ยังไม่ได้เข้าสู่ระบบ' });
  const { username, name, role } = req.session.user;
  res.json({ username, name, role });
});

// Rate limiting store (in-memory)
const loginAttempts = new Map();
// ล้าง attempt ที่หมดอายุทุก 5 นาที
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of loginAttempts) if (now > a.resetAt) loginAttempts.delete(ip);
}, 5 * 60 * 1000);

// ---------- Upload ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

const cleanHn = (hn) => String(hn || '').trim().replace(/[^0-9A-Za-z\-\/]/g, '');

// ---------- HOSxP ----------
app.get('/api/config', async (req, res) => {
  res.json({ hosxp: await hosxp.ping() });
});

app.get('/api/his/patient/:hn', async (req, res) => {
  const hn = cleanHn(req.params.hn);
  if (!hosxp.enabled) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าเชื่อม HOSxP' });
  try {
    const p = await hosxp.findPatient(hn);
    if (!p) return res.status(404).json({ error: 'ไม่พบ HN นี้ใน HOSxP' });
    res.json(p);
  } catch (e) {
    console.error('HOSxP error:', e.code || e.message);
    res.status(502).json({ error: 'เชื่อมต่อ HOSxP ไม่ได้' });
  }
});

// 10 HN ล่าสุดที่มีการนำเข้าภาพ (สแกนเข้า HOSxP หรืออัปโหลดในระบบนี้)
let recentCache = { at: 0, data: null };
app.get('/api/recent', async (req, res) => {
  const limit = 10;
  if (recentCache.data && Date.now() - recentCache.at < 30000) return res.json(recentCache.data);
  let his = [], hisError = null;
  try { his = await hosxp.listRecent(limit); }
  catch (e) { console.error('HOSxP recent:', e.code || e.message); hisError = 'ดึงรายการล่าสุดจาก HOSxP ไม่ได้'; }
  const local = [];
  const seen = new Set();
  for (const r of [...db.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (seen.has(r.hn)) continue;
    seen.add(r.hn);
    // createdAt เป็น UTC → แปลงเป็นเวลาไทยรูปแบบเดียวกับ HOSxP
    const th = new Date(new Date(r.createdAt).getTime() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
    local.push({ hn: r.hn, name: db.patients[r.hn]?.name || '', last: th, sources: ['upload'] });
  }
  const merged = new Map();
  for (const x of [...his, ...local].sort((a, b) => b.last.localeCompare(a.last))) {
    const m = merged.get(x.hn);
    if (m) { m.sources = [...new Set([...m.sources, ...x.sources])]; if (!m.name) m.name = x.name; }
    else merged.set(x.hn, { ...x });
  }
  const data = { list: [...merged.values()].slice(0, limit), hisError };
  if (!hisError) recentCache = { at: Date.now(), data };
  res.json(data);
});

// รายชื่อผู้ป่วย (ค้นหาด้วย HN หรือชื่อ)
app.get('/api/patients', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const list = Object.values(db.patients)
    .map((p) => {
      const recs = db.records.filter((r) => r.hn === p.hn);
      return {
        ...p,
        ekgCount: recs.filter((r) => r.type === 'ekg').length,
        labCount: recs.filter((r) => r.type === 'lab').length,
        lastDate: recs.reduce((m, r) => (r.date > m ? r.date : m), ''),
      };
    })
    .filter((p) => !q || p.hn.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q))
    .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
  res.json(list);
});

const localUrl = (r) => ({
  ...r,
  url: '/files/' + encodeURIComponent(r.file),
  thumb: r.mime === 'application/pdf' ? null : '/files/' + encodeURIComponent(r.file) + '/thumb',
});

// ข้อมูลผู้ป่วย + ภาพทั้งหมด (อัปโหลดเอง + สแกนจาก HOSxP)
app.get('/api/patients/:hn', async (req, res) => {
  let hn = cleanHn(req.params.hn);
  if (!hn) return res.status(400).json({ error: 'HN ไม่ถูกต้อง' });
  let his = null, scans = [], hisError = null;
  if (hosxp.enabled) {
    try {
      his = await hosxp.findPatient(hn);
      if (his && !db.patients[hn]) hn = his.hn; // ใช้ HN ตามรูปแบบ HOSxP
      const res2 = await hosxp.listScans(hn);
      scans = res2.items;
      if (res2.errors.length) hisError = 'ดึงภาพจากบางตารางไม่ได้: ' + res2.errors.join(', ');
    } catch (e) {
      console.error('HOSxP error:', e.code || e.message);
      hisError = 'เชื่อมต่อ HOSxP ไม่ได้ — แสดงเฉพาะภาพที่อัปโหลดในระบบนี้';
    }
  }
  const local = db.patients[hn];
  if (!local && !his && !scans.length) {
    return res.status(404).json({ error: hisError || 'ไม่พบผู้ป่วย HN นี้' });
  }
  const patient = {
    hn,
    name: local?.name || his?.name || '',
    sex: his?.sex || null,
    birthday: his?.birthday || null,
    local: !!local,
  };
  const records = db.records.filter((r) => r.hn === hn).map(localUrl);
  const pending = [];
  for (const s of scans) {
    const dt = String(s.datetime || '');
    const isPdf = s.imageType === 'pdf';
    let type = s.type, auto = false;
    if (type === 'scan' && !isPdf && AUTO_SOURCES.test(s.key)) {
      const score = autoScores[s.key];
      if (score === undefined) pending.push(s.key);
      else if (isEkg(score)) { type = 'ekg'; auto = true; }
    }
    records.push({
      id: 'scan-' + s.key,
      hn: s.hn,
      type,
      auto,
      date: dt.slice(0, 10),
      time: dt.slice(11, 16),
      source: (hosxp.SOURCE_LABEL[s.source] || s.source) + (s.typeName ? ' · ' + s.typeName : ''),
      note: [
        s.vn ? 'VN ' + s.vn : '',
        s.pageno ? 'หน้า ' + s.pageno : '',
        s.staff ? 'โดย ' + s.staff : '',
        s.noteText || '',
      ].filter(Boolean).join(' · '),
      mime: isPdf ? 'application/pdf' : 'image/jpeg',
      url: '/his/scan/' + encodeURIComponent(s.key),
      thumb: isPdf ? null : '/his/scan/' + encodeURIComponent(s.key) + '/thumb',
      readonly: true,
      createdAt: dt,
    });
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  enqueueAuto(pending);
  res.json({ patient, records, hisError, autoPending: pending.length });
});

// โหมดเรียกดูอย่างเดียว (ปิดการแก้ไขและอัปโหลด)
app.put('/api/patients/:hn', (req, res) => res.status(403).json({ error: 'ระบบทำงานในโหมดเรียกดูอย่างเดียว' }));
app.post('/api/records', (req, res) => res.status(403).json({ error: 'ระบบทำงานในโหมดเรียกดูอย่างเดียว' }));
app.put('/api/records/:id', (req, res) => res.status(403).json({ error: 'ระบบทำงานในโหมดเรียกดูอย่างเดียว' }));
app.delete('/api/records/:id', (req, res) => res.status(403).json({ error: 'ระบบทำงานในโหมดเรียกดูอย่างเดียว' }));

// ---------- ส่งไฟล์ / ภาพย่อ ----------
let sharp = null;
try { sharp = require('sharp'); } catch { console.log('ไม่พบ sharp — จะส่งภาพเต็มแทนภาพย่อ'); }
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });
const THUMB_WIDTH = 480;

function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return 'image/tiff';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}

async function makeThumb(buf) {
  return sharp(buf, { failOn: 'none' }).rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
}

async function sendThumb(res, cacheName, getBuffer, onThumb) {
  const cached = path.join(THUMB_DIR, cacheName);
  res.set('Cache-Control', 'private, max-age=604800');
  if (fs.existsSync(cached)) return res.type('image/jpeg').sendFile(cached);
  const buf = await getBuffer();
  if (!buf) return res.status(404).end();
  if (!sharp) return res.type(sniffMime(buf)).send(buf);
  const out = await makeThumb(buf);
  fs.writeFile(cached, out, () => {});
  if (onThumb) onThumb(out).catch(() => {});
  res.type('image/jpeg').send(out);
}

// ---------- เดาภาพ EKG อัตโนมัติจากกระดาษกราฟสีชมพู ----------
const EKG_RULE = {
  ratio: Number(process.env.EKG_AUTO_RATIO || 0.06),
  tiles: Number(process.env.EKG_AUTO_TILES || 0.35),
  minRatio: Number(process.env.EKG_AUTO_MIN_RATIO || 0.008),
};
const isEkg = (sc) => !!sc && (sc.r >= EKG_RULE.ratio || (sc.t >= EKG_RULE.tiles && sc.r >= EKG_RULE.minRatio));
const AUTO_SOURCES = /^[pe]/; // key ขึ้นต้นด้วย p (patient_opd_scan) หรือ e (er_image)
const AUTO_FILE = path.join(DATA_DIR, 'ekg', 'auto.json');
fs.mkdirSync(path.dirname(AUTO_FILE), { recursive: true });
let autoScores = {};
try { autoScores = JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')); } catch {}
for (const k of Object.keys(autoScores)) if (typeof autoScores[k] !== 'object') delete autoScores[k];
let autoSaveTimer = null;
function saveAutoScores() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    fs.writeFile(AUTO_FILE + '.tmp', JSON.stringify(autoScores), () => fs.rename(AUTO_FILE + '.tmp', AUTO_FILE, () => {}));
  }, 1000);
}

async function ekgScore(thumbBuf) {
  const { data, info } = await sharp(thumbBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, TX = 8, TY = 10;
  const tPink = new Uint32Array(TX * TY), tTot = new Uint32Array(TX * TY);
  let pink = 0;
  for (let y = 0; y < H; y++) {
    const ty = Math.floor((y * TY) / H) * TX;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, r = data[i], g = data[i + 1], b = data[i + 2];
      const t = ty + Math.floor((x * TX) / W);
      tTot[t]++;
      if (r > 150 && Math.abs(g - b) < 30) {
        const warm = r - (g + b) / 2;
        if (warm > 6) pink++;
        if (warm > 3) tPink[t]++;
      }
    }
  }
  let tiles = 0;
  for (let t = 0; t < TX * TY; t++) if (tTot[t] && tPink[t] / tTot[t] > 0.02) tiles++;
  return { r: +(pink / (W * H)).toFixed(4), t: +(tiles / (TX * TY)).toFixed(3) };
}

async function recordScore(key, thumbBuf) {
  autoScores[key] = await ekgScore(thumbBuf);
  saveAutoScores();
}

// คิวตรวจภาพเบื้องหลัง (ทีละ 3 ภาพ เพื่อไม่ให้ฐาน HOSxP ทำงานหนัก)
const autoQueue = [], autoQueued = new Set();
let autoRunning = 0;
function enqueueAuto(keys) {
  if (!sharp) return;
  for (const k of keys) if (!autoQueued.has(k) && autoScores[k] === undefined) { autoQueued.add(k); autoQueue.push(k); }
  pumpAuto();
}
function pumpAuto() {
  while (autoRunning < 3 && autoQueue.length) {
    const key = autoQueue.shift();
    autoRunning++;
    (async () => {
      const cached = path.join(THUMB_DIR, thumbName(key));
      let thumb;
      if (fs.existsSync(cached)) thumb = await fs.promises.readFile(cached);
      else {
        const scan = await hosxp.getScan(key);
        if (!scan?.data) { autoScores[key] = { r: 0, t: 0 }; return saveAutoScores(); }
        thumb = await makeThumb(scan.data);
        await fs.promises.writeFile(cached, thumb);
      }
      await recordScore(key, thumb);
    })()
      .catch((e) => console.error('EKG auto', key, e.code || e.message))
      .finally(() => { autoRunning--; autoQueued.delete(key); pumpAuto(); });
  }
}

// ภาพสแกนจาก HOSxP (อ่านอย่างเดียว)
// key: ตัวเลข/o<id> = opdscan, p<id> = patient_opd_scan, e<vn>-<1..5> = er_image, l<lab_order_number>-<1..5> = lab_order_image
const scanId = (req) => (/^(o?\d+|p\d+|e[0-9A-Za-z]+-[1-5]|l\d+-[1-5])$/.test(req.params.id) ? req.params.id : null);
const thumbName = (key) => 'scan-' + String(key).replace(/^o(?=\d)/, '') + '.jpg';

app.get('/his/scan/:id', async (req, res, next) => {
  try {
    const id = scanId(req);
    const scan = id && (await hosxp.getScan(id));
    if (!scan) return res.status(404).end();
    let buf = scan.data, mime = sniffMime(buf);
    if (mime === 'image/tiff' && sharp) { buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer(); mime = 'image/jpeg'; }
    res.set('Cache-Control', 'private, max-age=604800');
    res.type(mime).send(buf);
  } catch (e) { next(e); }
});

app.get('/his/scan/:id/thumb', async (req, res, next) => {
  try {
    const id = scanId(req);
    if (!id) return res.status(404).end();
    await sendThumb(res, thumbName(id), async () => (await hosxp.getScan(id))?.data,
      AUTO_SOURCES.test(id) && autoScores[id] === undefined ? (t) => recordScore(id, t) : null);
  } catch (e) { next(e); }
});

// ไฟล์ที่อัปโหลดในระบบนี้
const findLocal = (req) => db.records.find((x) => x.file === path.basename(req.params.file));

app.get('/files/:file', (req, res) => {
  const r = findLocal(req);
  if (!r) return res.status(404).end();
  res.type(r.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(UPLOAD_DIR, r.file));
});

app.get('/files/:file/thumb', async (req, res, next) => {
  try {
    const r = findLocal(req);
    if (!r) return res.status(404).end();
    await sendThumb(res, `local-${r.file}.jpg`, async () => fs.promises.readFile(path.join(UPLOAD_DIR, r.file)));
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 30MB' : 'เกิดข้อผิดพลาด' });
});

app.listen(PORT, HOST, async () => {
  console.log(`EKG/Lab Viewer: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`ข้อมูล: ${DATA_DIR}  |  ไฟล์ภาพ: ${UPLOAD_DIR}`);
  if (needsAuth) {
    console.log(`ระบบ Login: เปิดใช้งาน (mode: ${auth.AUTH_MODE})`);
  } else {
    console.log('คำเตือน: ยังไม่ได้ตั้ง APP_PASSWORD / HOSXP_DB_HOST — ใครเข้าถึงเครือข่ายก็ดูข้อมูลได้');
  }
  const h = await hosxp.ping();
  if (!h.enabled) {
    console.log('HOSxP: ไม่ได้เปิดใช้');
  } else if (h.ok) {
    console.log(`HOSxP: เชื่อมต่อสำเร็จ (ฐานรูป: ${h.imageDb?.database}, ฐานผู้ใช้: ${h.authDb?.database})`);
  } else {
    console.log(`HOSxP: เชื่อมต่อไม่สมบูรณ์ (ฐานรูป: ${h.imageDb?.ok ? 'OK' : h.imageDb?.error}, ฐานผู้ใช้: ${h.authDb?.ok ? 'OK' : h.authDb?.error})`);
  }
});
