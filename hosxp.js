// เชื่อมฐานข้อมูล HOSxP (MySQL/MariaDB) แบบอ่านอย่างเดียว
// รองรับการแยก 2 ฐานข้อมูล:
// 1. ฐานรูปภาพ/สแกน (เช่น hosimage หรือ opdscan/patient_opd_scan/er_image)
// 2. ฐานผู้ใช้/ตรวจสอบสิทธิ์/คนไข้ (เช่น hos หรือ sys_user/opduser/patient)

const mysql = require('mysql2/promise');
const crypto = require('crypto');

const enabled = !!process.env.HOSXP_DB_HOST;

// 1. Connection pool สำหรับฐานรูปภาพ (Image DB)
let pool = null;
if (enabled) {
  pool = mysql.createPool({
    host: process.env.HOSXP_DB_HOST,
    port: Number(process.env.HOSXP_DB_PORT || 3306),
    user: process.env.HOSXP_DB_USER,
    password: process.env.HOSXP_DB_PASSWORD,
    database: process.env.HOSXP_DB_NAME || 'hosimage',
    charset: process.env.HOSXP_DB_CHARSET || 'UTF8MB4_GENERAL_CI',
    connectionLimit: 6,
    connectTimeout: 5000,
    dateStrings: true,
  });
}

// 2. Connection pool สำหรับฐาน User/Auth/ข้อมูลหลัก (Auth DB)
// ถ้าไม่ได้ระบุ จะใช้ host/user/pass เดียวกับ HOSXP_DB_* แต่เปลี่ยน database (ค่าเริ่มต้นคือ 'hos')
const authDbName = process.env.HOSXP_AUTH_DB_NAME || (process.env.HOSXP_DB_NAME === 'hosimage' ? 'hos' : process.env.HOSXP_DB_NAME || 'hos');
const authDbHost = process.env.HOSXP_AUTH_DB_HOST || process.env.HOSXP_DB_HOST;
const authDbUser = process.env.HOSXP_AUTH_DB_USER || process.env.HOSXP_DB_USER;
const authDbPass = process.env.HOSXP_AUTH_DB_PASSWORD !== undefined ? process.env.HOSXP_AUTH_DB_PASSWORD : process.env.HOSXP_DB_PASSWORD;
const authDbPort = Number(process.env.HOSXP_AUTH_DB_PORT || process.env.HOSXP_DB_PORT || 3306);
const authDbCharset = process.env.HOSXP_AUTH_DB_CHARSET || process.env.HOSXP_DB_CHARSET || 'UTF8MB4_GENERAL_CI';

let authPool = null;
if (enabled) {
  // ถ้าตั้งค่าเหมือน pool ทุกอย่าง (รวม database) ให้แชร์ pool เดียวกันได้เลย
  const isIdentical = (
    authDbHost === process.env.HOSXP_DB_HOST &&
    authDbPort === Number(process.env.HOSXP_DB_PORT || 3306) &&
    authDbUser === process.env.HOSXP_DB_USER &&
    authDbPass === process.env.HOSXP_DB_PASSWORD &&
    authDbName === (process.env.HOSXP_DB_NAME || 'hosimage')
  );

  if (isIdentical) {
    authPool = pool;
  } else {
    authPool = mysql.createPool({
      host: authDbHost,
      port: authDbPort,
      user: authDbUser,
      password: authDbPass,
      database: authDbName,
      charset: authDbCharset,
      connectionLimit: 4,
      connectTimeout: 5000,
      dateStrings: true,
    });
  }
}

// ค้นหาว่าตาราง patient อยู่ในฐานรูป หรือฐาน auth (จำค่าไว้หลังจากตรวจพบครั้งแรก)
let patientPoolCache = null;
async function getPatientPool() {
  if (patientPoolCache) return patientPoolCache;
  if (!pool) return null;

  // ลองดูใน image pool ก่อน
  try {
    await pool.query('SELECT hn FROM patient LIMIT 1');
    patientPoolCache = pool;
    return patientPoolCache;
  } catch (e) {
    // ถ้าไม่มีใน image pool ให้ลองใน auth pool
    if (e.code === 'ER_NO_SUCH_TABLE' && authPool && authPool !== pool) {
      try {
        await authPool.query('SELECT hn FROM patient LIMIT 1');
        patientPoolCache = authPool;
        return patientPoolCache;
      } catch (e2) {}
    }
    // ถ้ายังไม่เจอ ให้คืน pool ตัวหลัก
    patientPoolCache = pool;
    return patientPoolCache;
  }
}

// HOSxP มักเก็บ HN เป็นสตริงเติมศูนย์ เช่น 000012345 (ความยาวตั้งได้ที่ HOSXP_HN_LENGTH)
function hnCandidates(hn) {
  const list = [hn];
  const len = Number(process.env.HOSXP_HN_LENGTH || 9);
  if (/^\d+$/.test(hn)) {
    const padded = hn.padStart(len, '0');
    const stripped = hn.replace(/^0+/, '');
    if (padded !== hn) list.push(padded);
    if (stripped && stripped !== hn) list.push(stripped);
  }
  return list;
}

async function findPatient(hn) {
  if (!enabled) return null;
  const pPool = await getPatientPool();
  const cands = hnCandidates(hn);
  try {
    const [rows] = await pPool.query(
      `SELECT hn, pname, fname, lname, birthday, sex
         FROM patient
        WHERE hn IN (?)
        LIMIT 1`,
      [cands]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      hn: r.hn,
      name: [r.pname, r.fname].filter(Boolean).join('') + (r.lname ? ' ' + r.lname : ''),
      birthday: r.birthday || null,
      sex: r.sex === '1' ? 'ชาย' : r.sex === '2' ? 'หญิง' : null,
    };
  } catch (e) {
    // ถ้าเกิด ER_NO_SUCH_TABLE ลองสลับไปอีก pool ถ้ามี
    if (e.code === 'ER_NO_SUCH_TABLE' && authPool && pPool !== authPool) {
      try {
        const [rows] = await authPool.query(
          `SELECT hn, pname, fname, lname, birthday, sex FROM patient WHERE hn IN (?) LIMIT 1`,
          [cands]
        );
        if (!rows.length) return null;
        patientPoolCache = authPool;
        const r = rows[0];
        return {
          hn: r.hn,
          name: [r.pname, r.fname].filter(Boolean).join('') + (r.lname ? ' ' + r.lname : ''),
          birthday: r.birthday || null,
          sex: r.sex === '1' ? 'ชาย' : r.sex === '2' ? 'หญิง' : null,
        };
      } catch (e2) {}
    }
    throw e;
  }
}

// ---------- ภาพสแกนจาก opdscan ----------
const SCAN_TABLE = process.env.HOSXP_SCAN_TABLE || 'opdscan';
const SCAN_TYPE_MAP = { 3: 'ekg', 6: 'lab' };

const rawSources = (process.env.HOSXP_IMAGE_SOURCES || 'opdscan,patient_opd_scan,er_image,lab_order_image').split(',').map((s) => s.trim());
if (!rawSources.includes('lab_order_image')) rawSources.push('lab_order_image');
const SOURCES = rawSources;
const SOURCE_LABEL = { opdscan: 'OPD Scan', patient_opd_scan: 'Patient OPD Scan', er_image: 'ภาพ ER', lab_order_image: 'Out Lab' };

const lower = (v) => String(v || '').toLowerCase().trim();

async function listOpdscan(hns) {
  const [rows] = await pool.query(
    `SELECT s.scan_id, s.hn, s.scan_date_time, s.pageno, s.image_type, s.vn, s.scan_type_id, t.scan_type_name
       FROM ${SCAN_TABLE} s
       LEFT JOIN scan_type t ON t.scan_type_id = s.scan_type_id
      WHERE s.hn IN (?)`,
    [hns]
  );
  return rows.map((r) => ({
    key: 'o' + r.scan_id,
    source: 'opdscan',
    hn: r.hn,
    datetime: r.scan_date_time,
    pageno: r.pageno,
    imageType: lower(r.image_type),
    vn: r.vn,
    type: SCAN_TYPE_MAP[r.scan_type_id] || 'scan',
    typeName: r.scan_type_name || null,
  }));
}

async function listPatientOpdScan(hns) {
  const [rows] = await pool.query(
    `SELECT patient_opd_scan_id, hn, vn, vstdate, vsttime, scan_date_time, page_no, staff
       FROM patient_opd_scan WHERE hn IN (?)`,
    [hns]
  );
  return rows.map((r) => ({
    key: 'p' + r.patient_opd_scan_id,
    source: 'patient_opd_scan',
    hn: r.hn,
    datetime: r.vstdate ? `${r.vstdate} ${r.vsttime || '00:00:00'}` : r.scan_date_time,
    scanned: r.scan_date_time,
    pageno: r.page_no,
    imageType: 'jpg',
    vn: r.vn,
    staff: r.staff,
    type: 'scan',
  }));
}

async function listErImage(hns) {
  // ลอง query ปกติ
  let querySql = `SELECT e.vn, o.hn, o.vstdate, o.vsttime,
            LENGTH(e.image1) > 0 AS h1, LENGTH(e.image2) > 0 AS h2, LENGTH(e.image3) > 0 AS h3,
            LENGTH(e.image4) > 0 AS h4, LENGTH(e.image5) > 0 AS h5,
            e.image1_note n1, e.image2_note n2, e.image3_note n3, e.image4_note n4, e.image5_note n5
       FROM ovst o JOIN er_image e ON e.vn = o.vn
      WHERE o.hn IN (?)`;

  let rows;
  try {
    const [res] = await pool.query(querySql, [hns]);
    rows = res;
  } catch (e) {
    // ถ้า ovst อยู่ในอีกฐานข้อมูล (บนเซิร์ฟเวอร์เดียวกัน)
    if (e.code === 'ER_NO_SUCH_TABLE' && authDbName && authDbHost === process.env.HOSXP_DB_HOST) {
      const crossSql = querySql.replace('FROM ovst o', `FROM \`${authDbName}\`.ovst o`);
      const [res] = await pool.query(crossSql, [hns]);
      rows = res;
    } else {
      throw e;
    }
  }

  const out = [];
  for (const r of rows) {
    for (let i = 1; i <= 5; i++) {
      if (!r['h' + i]) continue;
      out.push({
        key: `e${r.vn}-${i}`,
        source: 'er_image',
        hn: r.hn,
        datetime: `${r.vstdate} ${r.vsttime || '00:00:00'}`,
        pageno: i,
        imageType: 'jpg',
        vn: r.vn,
        noteText: r['n' + i] || '',
        type: 'scan',
      });
    }
  }
  return out;
}

async function listLabOrderImage(hns) {
  // 1. ค้นหาใบสั่งแล็บของคนไข้ HN นี้จาก lab_head (ฐานหลัก/Auth DB เป็นหลัก)
  let heads = [];
  const headPool = authPool || pool;
  try {
    const [rows] = await headPool.query(
      `SELECT lab_order_number, hn, vn, order_date, order_time, form_name, order_note, lab_head_remark
         FROM lab_head
        WHERE hn IN (?)
        ORDER BY lab_order_number DESC
        LIMIT 100`,
      [hns]
    );
    heads = rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' && pool && headPool !== pool) {
      try {
        const [rows] = await pool.query(
          `SELECT lab_order_number, hn, vn, order_date, order_time, form_name, order_note, lab_head_remark
             FROM lab_head
            WHERE hn IN (?)
            ORDER BY lab_order_number DESC
            LIMIT 100`,
          [hns]
        );
        heads = rows;
      } catch (e2) {}
    }
  }

  if (!heads.length) return [];

  const headMap = new Map();
  const orderNums = [];
  for (const h of heads) {
    headMap.set(h.lab_order_number, h);
    orderNums.push(h.lab_order_number);
  }

  // 2. ตรวจสอบว่าใบสั่งแล็บไหนมีรูปภาพใน lab_order_image (ฐานรูป/Image DB เป็นหลัก)
  let imgRows = [];
  const imgPool = pool || authPool;
  try {
    const [rows] = await imgPool.query(
      `SELECT lab_order_number,
              LENGTH(image1) > 0 AS h1, LENGTH(image2) > 0 AS h2, LENGTH(image3) > 0 AS h3,
              LENGTH(image4) > 0 AS h4, LENGTH(image5) > 0 AS h5,
              image1_note n1, image2_note n2, image3_note n3, image4_note n4, image5_note n5
         FROM lab_order_image
        WHERE lab_order_number IN (?)`,
      [orderNums]
    );
    imgRows = rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' && authPool && imgPool !== authPool) {
      try {
        const [rows] = await authPool.query(
          `SELECT lab_order_number,
                  LENGTH(image1) > 0 AS h1, LENGTH(image2) > 0 AS h2, LENGTH(image3) > 0 AS h3,
                  LENGTH(image4) > 0 AS h4, LENGTH(image5) > 0 AS h5,
                  image1_note n1, image2_note n2, image3_note n3, image4_note n4, image5_note n5
             FROM lab_order_image
            WHERE lab_order_number IN (?)`,
          [orderNums]
        );
        imgRows = rows;
      } catch (e2) {}
    }
  }

  if (!imgRows.length) return [];

  // 3. ดึงรายการย่อยและผลตรวจจาก lab_order เพื่อให้แพทย์อ่านประกอบภาพได้
  const matchedOrderNums = imgRows.map((r) => r.lab_order_number);
  const itemsMap = new Map();
  try {
    const [itemRows] = await headPool.query(
      `SELECT lab_order_number, lab_items_name_ref, lab_order_result
         FROM lab_order
        WHERE lab_order_number IN (?)
        ORDER BY lab_order_number, lab_items_code`,
      [matchedOrderNums]
    );
    for (const it of itemRows) {
      if (!itemsMap.has(it.lab_order_number)) itemsMap.set(it.lab_order_number, []);
      if (it.lab_items_name_ref) {
        const resText = it.lab_order_result ? ': ' + it.lab_order_result : '';
        itemsMap.get(it.lab_order_number).push(`${it.lab_items_name_ref}${resText}`);
      }
    }
  } catch (e) {}

  // 4. ประกอบข้อมูลภาพแต่ละใบ
  const out = [];
  for (const r of imgRows) {
    const h = headMap.get(r.lab_order_number);
    if (!h) continue;

    const dateStr = h.order_date ? String(h.order_date).slice(0, 10) : '';
    const timeStr = h.order_time ? String(h.order_time).slice(0, 8) : '00:00:00';
    const dt = dateStr ? `${dateStr} ${timeStr}` : '0000-00-00 00:00:00';

    const orderItems = itemsMap.get(r.lab_order_number) || [];
    const itemSummary = orderItems.length
      ? orderItems.slice(0, 4).join(' · ') + (orderItems.length > 4 ? ` (และอีก ${orderItems.length - 4} รายการ)` : '')
      : '';

    for (let i = 1; i <= 5; i++) {
      if (!r['h' + i]) continue;
      const notes = [
        `Lab #${h.lab_order_number}`,
        r['n' + i] ? r['n' + i] : '',
        h.order_note ? 'หมายเหตุ: ' + h.order_note : '',
        itemSummary ? 'ผลตรวจ: ' + itemSummary : '',
      ].filter(Boolean).join(' · ');

      out.push({
        key: `l${r.lab_order_number}-${i}`,
        source: 'lab_order_image',
        hn: h.hn,
        datetime: dt,
        pageno: i,
        imageType: 'jpg',
        vn: h.vn,
        noteText: notes,
        type: 'lab',
        typeName: h.form_name || 'Out Lab',
      });
    }
  }
  return out;
}

const LISTERS = { opdscan: listOpdscan, patient_opd_scan: listPatientOpdScan, er_image: listErImage, lab_order_image: listLabOrderImage };

async function listScans(hn) {
  if (!enabled) return { items: [], errors: [] };
  const hns = hnCandidates(hn);
  const items = [], errors = [];
  await Promise.all(
    SOURCES.filter((s) => LISTERS[s]).map(async (s) => {
      try { items.push(...(await LISTERS[s](hns))); }
      catch (e) { console.error(`HOSxP ${s}:`, e.code || e.message); errors.push(s); }
    })
  );
  items.sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)) || (a.pageno || 0) - (b.pageno || 0));
  return { items, errors };
}

async function listRecent(limit = 10) {
  if (!enabled) return [];
  const queries = [];
  if (SOURCES.includes('opdscan'))
    queries.push(pool.query(`SELECT hn, scan_date_time AS dt, 'opdscan' AS src FROM ${SCAN_TABLE} ORDER BY scan_date_time DESC LIMIT 300`));
  if (SOURCES.includes('patient_opd_scan'))
    queries.push(pool.query(`SELECT hn, scan_date_time AS dt, 'patient_opd_scan' AS src FROM patient_opd_scan ORDER BY scan_date_time DESC LIMIT 300`));
  if (SOURCES.includes('lab_order_image')) {
    queries.push((async () => {
      try {
        const imgPool = pool || authPool;
        const [imgNums] = await imgPool.query(`SELECT lab_order_number FROM lab_order_image ORDER BY lab_order_number DESC LIMIT 60`);
        if (!imgNums.length) return [];
        const headPool = authPool || pool;
        const nums = imgNums.map((x) => x.lab_order_number);
        const [heads] = await headPool.query(`SELECT hn, CONCAT(order_date, ' ', COALESCE(order_time, '00:00:00')) AS dt, 'lab_order_image' AS src FROM lab_head WHERE lab_order_number IN (?)`, [nums]);
        return heads;
      } catch (e) {
        console.error('HOSxP recent lab_order_image:', e.code || e.message);
        return [];
      }
    })());
  }

  const rawResults = await Promise.all(queries);
  const rows = rawResults.flatMap((r) => Array.isArray(r[0]) ? r[0] : r).filter((r) => r && r.hn && r.dt);
  rows.sort((a, b) => String(b.dt).localeCompare(String(a.dt)));
  const byHn = new Map();
  for (const r of rows) {
    const x = byHn.get(r.hn) || { hn: r.hn, last: r.dt, sources: new Set(), count: 0 };
    x.sources.add(r.src);
    x.count++;
    byHn.set(r.hn, x);
  }
  const list = [...byHn.values()].slice(0, limit);
  if (list.length) {
    const pPool = await getPatientPool();
    const [names] = await pPool.query('SELECT hn, pname, fname, lname FROM patient WHERE hn IN (?)', [list.map((x) => x.hn)]);
    const nm = Object.fromEntries(names.map((r) => [r.hn, [r.pname, r.fname].filter(Boolean).join('') + (r.lname ? ' ' + r.lname : '')]));
    for (const x of list) x.name = nm[x.hn] || '';
  }
  return list.map((x) => ({ hn: x.hn, name: x.name, last: String(x.last), sources: [...x.sources] }));
}

async function getScan(key) {
  if (!enabled) return null;
  key = String(key);
  let m;
  if ((m = key.match(/^o?(\d+)$/)) && SOURCES.includes('opdscan')) {
    const [rows] = await pool.query(`SELECT image_type, scan_image AS data FROM ${SCAN_TABLE} WHERE scan_id = ?`, [Number(m[1])]);
    return rows[0]?.data ? { imageType: lower(rows[0].image_type), data: rows[0].data } : null;
  }
  if ((m = key.match(/^p(\d+)$/)) && SOURCES.includes('patient_opd_scan')) {
    const [rows] = await pool.query('SELECT image AS data FROM patient_opd_scan WHERE patient_opd_scan_id = ?', [Number(m[1])]);
    return rows[0]?.data ? { imageType: 'jpg', data: rows[0].data } : null;
  }
  if ((m = key.match(/^e([0-9A-Za-z]+)-([1-5])$/)) && SOURCES.includes('er_image')) {
    const col = 'image' + m[2];
    const [rows] = await pool.query(`SELECT ${col} AS data FROM er_image WHERE vn = ?`, [m[1]]);
    return rows[0]?.data ? { imageType: 'jpg', data: rows[0].data } : null;
  }
  if ((m = key.match(/^l(\d+)-([1-5])$/)) && SOURCES.includes('lab_order_image')) {
    const col = 'image' + m[2];
    const imgPool = pool || authPool;
    let [rows] = await imgPool.query(`SELECT ${col} AS data FROM lab_order_image WHERE lab_order_number = ?`, [Number(m[1])]);
    if (!rows[0]?.data && authPool && imgPool !== authPool) {
      const [rows2] = await authPool.query(`SELECT ${col} AS data FROM lab_order_image WHERE lab_order_number = ?`, [Number(m[1])]);
      rows = rows2;
    }
    return rows[0]?.data ? { imageType: 'jpg', data: rows[0].data } : null;
  }
  return null;
}

// ---------- ค้นหา User สำหรับ Login (Auth DB) ----------
// รองรับ opduser (ตารางหลักของ HOSxP ที่เก็บ passweb / password) และ sys_user / ovst_staff
const USER_TABLE = process.env.HOSXP_USER_TABLE || 'opduser';

async function findUser(username, plainPassword) {
  if (!enabled || !authPool) return null;
  const u = String(username || '').trim();
  const p = String(plainPassword || '');
  if (!u || !p) return null;

  const h1 = crypto.createHash('md5').update(p).digest('hex').toLowerCase();
  const h2 = crypto.createHash('md5').update(h1).digest('hex').toLowerCase();

  // 1. ตรวจสอบใน opduser (ตารางมาตรฐานของ HOSxP)
  try {
    const [rows] = await authPool.query(
      `SELECT loginname, name, password, passweb, account_disable, entryposition, groupname
         FROM opduser
        WHERE LOWER(loginname) = LOWER(?)
        LIMIT 1`,
      [u]
    );
    if (rows.length) {
      const row = rows[0];

      // ตรวจสอบสถานะการปิดใช้งานบัญชี
      if (String(row.account_disable).toUpperCase() === 'Y') {
        console.warn(`[auth] ผู้ใช้ ${u} ถูกระงับการใช้งาน (account_disable = Y)`);
        return null;
      }

      const pwWeb = String(row.passweb || '').trim().toLowerCase();
      const pwDb = String(row.password || '').trim().toLowerCase();

      // ตรวจสอบกับ passweb (MD5 หรือ MD5(MD5))
      const matchPassweb = pwWeb && (pwWeb === h1 || pwWeb === h2);
      // ตรวจสอบกับ password ในกรณีที่เก็บเป็น MD5 หรือ plain text
      const matchPassword = pwDb && (pwDb === h1 || pwDb === h2 || row.password === p);

      if (matchPassweb || matchPassword) {
        return {
          username: row.loginname,
          name: row.name || row.loginname,
          role: row.entryposition || row.groupname || 'staff',
          source: 'hosxp',
        };
      }
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') {
      console.error('[hosxp] opduser query error:', e.code || e.message);
    }
  }

  // 2. Fallback: sys_user (ถ้ามีในระบบ)
  try {
    const [rows] = await authPool.query(
      `SELECT loginname, name, password, active, hosxp_right
         FROM sys_user
        WHERE LOWER(loginname) = LOWER(?)
        LIMIT 1`,
      [u]
    );
    if (rows.length) {
      const row = rows[0];
      if (String(row.active) === '0') return null;
      const pwDb = String(row.password || '').trim().toLowerCase();
      if (pwDb === h1 || pwDb === h2 || row.password === p) {
        return {
          username: row.loginname,
          name: row.name || row.loginname,
          role: row.hosxp_right || 'staff',
          source: 'hosxp',
        };
      }
    }
  } catch (e) {}

  // 3. Fallback: ovst_staff
  try {
    const [rows] = await authPool.query(
      `SELECT loginname, name, password, isdel
         FROM ovst_staff
        WHERE LOWER(loginname) = LOWER(?)
        LIMIT 1`,
      [u]
    );
    if (rows.length) {
      const row = rows[0];
      if (String(row.isdel) === '1') return null;
      const pwDb = String(row.password || '').trim().toLowerCase();
      if (pwDb === h1 || pwDb === h2 || row.password === p) {
        return {
          username: row.loginname,
          name: row.name || row.loginname,
          role: 'staff',
          source: 'hosxp',
        };
      }
    }
  } catch (e) {}

  return null;
}

// ---------- Ping / Health Check ทั้ง 2 ฐาน ----------
async function ping() {
  if (!enabled) return { enabled: false };

  const res = {
    enabled: true,
    ok: true,
    imageDb: {
      host: process.env.HOSXP_DB_HOST,
      database: process.env.HOSXP_DB_NAME || 'hosimage',
      ok: false,
    },
    authDb: {
      host: authDbHost,
      database: authDbName,
      ok: false,
    },
    patientTable: null,
  };

  // ตรวจสอบฐานรูป (Image DB)
  try {
    await pool.query('SELECT 1');
    res.imageDb.ok = true;
  } catch (e) {
    res.ok = false;
    res.imageDb.error = e.code || e.message;
  }

  // ตรวจสอบฐาน Auth/User (Auth DB)
  if (authPool) {
    try {
      await authPool.query('SELECT 1');
      res.authDb.ok = true;
    } catch (e) {
      res.ok = false;
      res.authDb.error = e.code || e.message;
    }
  }

  // ตรวจสอบตาราง patient
  try {
    const pPool = await getPatientPool();
    if (pPool) {
      await pPool.query('SELECT hn FROM patient LIMIT 1');
      res.patientTable = { ok: true, foundIn: pPool === authPool ? res.authDb.database : res.imageDb.database };
    }
  } catch (e) {
    res.patientTable = { ok: false, error: e.code || e.message };
  }

  return res;
}

module.exports = {
  enabled,
  findPatient,
  findUser,
  listScans,
  listRecent,
  getScan,
  ping,
  SOURCE_LABEL,
};
