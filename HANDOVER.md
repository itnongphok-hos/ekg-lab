# ส่งมอบงาน: EKG / Out Lab Viewer

> เอกสารนี้สำหรับทีม IT ที่รับงานต่อ — วิธีติดตั้งทีละขั้นอยู่ใน [README.md](README.md)

---

## แอปนี้ทำอะไร

เว็บแอปใน LAN รพ. สำหรับ**ดูภาพ EKG และผล Out Lab** ของผู้ป่วยตาม HN  
เชื่อม HOSxP แบบ **อ่านอย่างเดียว** — ไม่มีการเขียนลงฐาน HOSxP เลย  
Login ด้วยบัญชี HOSxP เดิม (ตาราง `opduser`)

---

## Tech Stack

| รายการ | รายละเอียด |
|---|---|
| Runtime | Node.js ≥22.9, Express 4 |
| DB client | mysql2 (promise) |
| Auth | express-session + session-file-store |
| ภาพย่อ | sharp |
| Rate limit | express-rate-limit (10 req/min/IP บน login) |
| Frontend | Vanilla HTML/CSS/JS (ไม่มี build step) |

---

## สถาปัตยกรรม 2 DB Pool

```
server.js / hosxp.js
    ├── imageDb pool  →  192.168.0.238 / hosimage  (opdscan, patient_opd_scan, er_image, lab_order_image, patient)
    └── authDb  pool  →  192.168.0.246 / hos        (opduser, lab_head, lab_order)
```

- `lab_order_image` อยู่ใน **hosimage** แต่ metadata (HN, วันที่) ต้อง join กับ `lab_head` ใน **hos**  
  → ดึง 2 pool แยกกัน แล้ว join ใน JavaScript (ไม่ใช่ SQL cross-db)

---

## ไฟล์หลักและหน้าที่

| ไฟล์ | หน้าที่ |
|---|---|
| `server.js` | Express server, session, login guard, API routes, read-only (403 บน POST/PUT/DELETE) |
| `hosxp.js` | 2 DB pool, `findUser`, `listScans`, `getScan`, `listLabOrderImage`, `listRecent` |
| `auth.js` | `verify(username, password)` → md5 hash เปรียบกับ `passweb` ใน opduser |
| `public/app.js` | Frontend — ค้น HN, แสดงไทม์ไลน์, viewer, เทียบภาพ, session redirect |
| `ecosystem.config.js` | PM2 config |
| `.env.example` | template ค่าตั้ง |

---

## ระบบ Login

- ตาราง `opduser` ใน hos — คอลัมน์ `loginname`, `passweb`, `account_disable`
- `passweb` = `md5(password)` (lowercase hex 32 ตัว)
- `auth.js` ส่ง plain password มา → `hosxp.findUser()` คำนวณ md5 แล้วเปรียบ
- Fallback: `opduser` → `sys_user` → `ovst_staff` (ถ้าตารางนั้นไม่มีก็ข้ามไป)
- Session เก็บในไฟล์ที่ `DATA_DIR/sessions/` (session-file-store)

---

## Key ของภาพ HOSxP

| Prefix | ตาราง | ตัวอย่าง key |
|---|---|---|
| `o<id>` | opdscan | `o12345` |
| `p<id>` | patient_opd_scan | `p99999` |
| `e<vn>-<1..5>` | er_image | `e1234567-1` |
| `l<lab_order_id>-<1..n>` | lab_order_image | `l685042-1` |

---

## ค่า .env สำคัญ

```
HOSXP_DB_HOST / HOSXP_DB_NAME        # Image DB (hosimage)
HOSXP_AUTH_DB_HOST / HOSXP_AUTH_DB_NAME  # Auth DB (hos)
HOSXP_IMAGE_SOURCES=opdscan,patient_opd_scan,er_image,lab_order_image
HOSXP_USER_TABLE=opduser
HOSXP_PASSWORD_HASH=md5md5
HOSXP_HN_LENGTH=7
SESSION_SECRET=<สุ่ม 32 ตัว>
```

---

## สถานะการทดสอบ

| ส่วน | สถานะ |
|---|---|
| เชื่อม 2 DB (hosimage + hos) | ✅ ทดสอบกับฐานจริงแล้ว |
| Login ด้วย opduser | ✅ ทดสอบแล้ว (account 101725 ผ่าน) |
| ดึงภาพ 4 ตาราง | ✅ ทดสอบแล้ว (HN 4601732 มี lab_order_image 2 ภาพ) |
| Read-only (ไม่มีปุ่ม upload/edit) | ✅ ทั้ง UI และ server (403) |
| UI ในเบราว์เซอร์ | ⚠️ ยังไม่ได้ทดสอบครบทุก feature |
| ติดตั้งบน server รพ. จริง | ⏳ ยังไม่ได้ทำ |

---

## สิ่งที่ต้องทำก่อน Go-Live

1. **สร้าง MySQL user** `ekg_readonly` ที่ hosimage และ hos ตาม SQL ใน README ข้อ 3
2. **ตั้ง SESSION_SECRET** ใหม่ (สุ่ม 32+ ตัวอักษร)
3. **ทดสอบ UI** ในเบราว์เซอร์จริง กับข้อมูล HN จริง
4. ติดตั้ง PM2 บน server และ set auto-start
5. เปิด Firewall เฉพาะพอร์ต 3000 ในวง LAN

---

## ข้อควรระวัง

- `.env` ห้าม commit เข้า git (มีรหัสผ่านจริง)
- ห้ามเปิด port 3000 ออก internet — ใช้ใน LAN เท่านั้น หรือผ่าน VPN
- `lab_order_image` join ข้าม 2 DB ใน JS — ถ้า DB ใดใดหลุด ภาพ Out Lab จะไม่แสดง

---

## งานที่แนะนำให้ทำต่อ

1. ติดตั้งบน server รพ. ตาม README
2. Audit log ว่าใครเปิดดูภาพไหน
3. รองรับผู้ป่วยใหม่ — ชี้ `patient` ไปที่ฐาน hos หลักแทน hosimage
4. เพิ่ม HTTPS ผ่าน reverse proxy (nginx/IIS) ถ้าต้องใช้นอก LAN
