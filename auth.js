// auth.js — ระบบ Login ผ่านฐานข้อมูล HOSxP (sys_user / ovst_staff)
// HOSxP เก็บรหัสผ่านเป็น MD5(password) หรือ MD5(MD5(password)) ขึ้นอยู่กับเวอร์ชัน
// ตั้งค่าใน .env: AUTH_MODE=hosxp | local | both

const crypto = require('crypto');
const hosxp = require('./hosxp');

// โหมด:
//   hosxp  = ล็อกอินผ่าน HOSxP เท่านั้น (ต้องตั้ง HOSXP_DB_HOST)
//   local  = ล็อกอินด้วย APP_USER / APP_PASSWORD เท่านั้น (เหมือนเดิม)
//   both   = ลอง HOSxP ก่อน ถ้าไม่ผ่านลอง local
const AUTH_MODE = (process.env.AUTH_MODE || 'both').toLowerCase();

// md5 helper
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

// HOSxP ใช้ MD5 หลายรอบขึ้นอยู่กับเวอร์ชัน
// HOSXP_PASSWORD_HASH=md5         → md5(password)                    (เวอร์ชันเก่า)
// HOSXP_PASSWORD_HASH=md5md5      → md5(md5(password))               (ส่วนใหญ่)
// HOSXP_PASSWORD_HASH=md5upper    → md5(password).toUpperCase()      (บางระบบ)
const HASH_MODE = (process.env.HOSXP_PASSWORD_HASH || 'md5md5').toLowerCase();

function hashPassword(plain) {
  switch (HASH_MODE) {
    case 'md5':      return md5(plain);
    case 'md5upper': return md5(plain).toUpperCase();
    case 'md5md5':
    default:         return md5(md5(plain));
  }
}

// ตรวจสอบ user ใน HOSxP database (ตาราง opduser / sys_user)
async function verifyHosxp(username, password) {
  if (!hosxp.enabled) return null;
  try {
    const user = await hosxp.findUser(username, password);
    return user || null;
  } catch (e) {
    console.error('[auth] HOSxP verify error:', e.code || e.message);
    return null;
  }
}

// ตรวจสอบ local user (APP_USER / APP_PASSWORD จาก .env)
function verifyLocal(username, password) {
  const localUser = process.env.APP_USER || 'staff';
  const localPass = process.env.APP_PASSWORD || '';
  if (!localPass) return null; // ไม่ได้ตั้งรหัส
  if (username !== localUser) return null;
  // ใช้ timingSafeEqual เพื่อป้องกัน timing attack
  const a = Buffer.from(password);
  const b = Buffer.from(localPass);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { username: localUser, name: 'Admin', role: 'admin', source: 'local' };
}

// ฟังก์ชันหลัก — คืน user object หรือ null ถ้า credential ไม่ถูก
async function verify(username, password) {
  if (!username || !password) return null;
  const u = String(username).trim().toLowerCase();
  const p = String(password);

  if (AUTH_MODE === 'hosxp') {
    return verifyHosxp(u, p);
  }
  if (AUTH_MODE === 'local') {
    return verifyLocal(u, p);
  }
  // both: ลอง HOSxP ก่อน
  const hosxpUser = await verifyHosxp(u, p);
  if (hosxpUser) return hosxpUser;
  return verifyLocal(u, p);
}

module.exports = { verify, AUTH_MODE };
