# EKG / Out Lab Viewer

เว็บแอปสำหรับดูภาพ EKG และผล **Out Lab** (ผลแลบนอก) ของผู้ป่วยตาม HN  
เชื่อมฐานข้อมูล HOSxP แบบ **อ่านอย่างเดียว** — ไม่มีการเขียนหรือแก้ไขข้อมูลใน HOSxP เลย

---

## ความสามารถ

- ค้นหาผู้ป่วยด้วย HN — ดึงชื่อ เพศ วันเกิดจาก HOSxP ให้เองอัตโนมัติ
- ไทม์ไลน์ภาพเรียงตามวันที่ กรองได้ตามประเภท (EKG / Out Lab / สแกน OPD / ER)
- ดึงภาพจาก HOSxP 4 ตาราง รวมในไทม์ไลน์เดียว:
  - `opdscan` — สแกน OPD card (ขาวดำ)
  - `patient_opd_scan` — สแกนเอกสารแนบ (สี) — EKG ส่วนใหญ่อยู่ที่นี่
  - `er_image` — ภาพ ER (เชื่อม HN ผ่าน `ovst.vn`)
  - `lab_order_image` — ภาพ Out Lab (ผลแลบนอก)
- **ตัวดูภาพ**: ซูม (ล้อเมาส์ / pinch / ดับเบิลคลิก), ลาก, หมุน, ปรับความสว่าง/คอนทราสต์, กลับสี
- **เทียบ EKG 2 ภาพ** ข้างกัน (ติ๊กเลือก 2 ภาพ → "เทียบภาพ") พร้อมโหมดซูม/เลื่อนพร้อมกัน
- คีย์ลัด: `+` `-` `0` (พอดีจอ) `R` (หมุน) `I` (กลับสี) `←` `→` (ภาพก่อน/ถัดไป) `Esc`
- **ระบบ Login** ใช้บัญชี HOSxP (ตาราง `opduser`) รหัสเข้าระบบเดียวกับที่ใช้ใน HOSxP

---

## สถาปัตยกรรม (Architecture)

```
เบราว์เซอร์  ←→  Node.js/Express (server.js)  ←→  MySQL hosimage  (ภาพ, patient)
                                                 ←→  MySQL hos      (auth, lab_head, lab_order)
```

- **Image DB** (`hosimage` / `192.168.0.238`): `opdscan`, `patient_opd_scan`, `er_image`, `lab_order_image`, `patient`
- **Auth DB** (`hos` / `192.168.0.246`): `opduser` (login), `lab_head`, `lab_order` (metadata Out Lab)

---

## ความต้องการของระบบ

| รายการ | เวอร์ชันขั้นต่ำ |
|---|---|
| Node.js | 22.9 ขึ้นไป (แนะนำ 24 LTS) |
| MySQL / MariaDB HOSxP | HOSxP 3 / 4 |
| OS | Windows Server 2016+ หรือ Ubuntu 20.04+ |

---

## ขั้นตอนการติดตั้ง

### 1. โคลน/คัดลอกโปรเจกต์

```bash
git clone https://github.com/itnongphok-hos/ekg-lab.git
cd ekg-lab
```

หรือดาวน์โหลด ZIP แล้วแตกไฟล์ไปที่ server เช่น `D:\ekg-lab`

---

### 2. ติดตั้ง dependencies

```bash
npm install --omit=dev
```

> **หมายเหตุ**: ไม่ต้องคัดลอก `node_modules/`, `data/`, `uploads/` ไปพร้อมโปรเจกต์

---

### 3. สร้าง user อ่านอย่างเดียวใน HOSxP (ให้ DBA ทำ)

ต้องกำหนดสิทธิ์ MySQL user ที่จะใช้กับแอปนี้ ให้อ่านได้เฉพาะตารางที่จำเป็น  
รันคำสั่ง SQL ต่อไปนี้บน HOSxP MariaDB (แก้ IP ให้ตรงกับ server ที่รันแอป):

**สำหรับ hosimage (Image DB):**
```sql
CREATE USER IF NOT EXISTS 'ekg_readonly'@'192.168.0.X' IDENTIFIED BY 'รหัสผ่าน';
GRANT SELECT (hn, pid, fname, lname, sex, birthday)
  ON hosimage.patient TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hosimage.opdscan TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hosimage.scan_type TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hosimage.patient_opd_scan TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hosimage.er_image TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hosimage.lab_order_image TO 'ekg_readonly'@'192.168.0.X';
FLUSH PRIVILEGES;
```

**สำหรับ hos (Auth DB):**
```sql
GRANT SELECT (loginname, name, passweb, account_disable)
  ON hos.opduser TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hos.lab_head TO 'ekg_readonly'@'192.168.0.X';
GRANT SELECT ON hos.lab_order TO 'ekg_readonly'@'192.168.0.X';
FLUSH PRIVILEGES;
```

---

### 4. ตั้งค่า `.env`

```bash
# Windows
copy .env.example .env

# Linux/Mac
cp .env.example .env
```

แก้ค่าใน `.env` ให้ตรงกับระบบของ รพ.:

| ค่า | ความหมาย | ตัวอย่าง |
|---|---|---|
| `PORT` | พอร์ตเว็บ | `3000` |
| `SESSION_SECRET` | สุ่มตัวอักษร 32 ตัวสำหรับ session | `abc123...` |
| `HOSXP_DB_HOST` | IP ของ Image DB | `192.168.0.238` |
| `HOSXP_DB_NAME` | ชื่อ Image DB | `hosimage` |
| `HOSXP_DB_USER` | MySQL user | `ekg_readonly` |
| `HOSXP_DB_PASSWORD` | MySQL password | |
| `HOSXP_DB_CHARSET` | charset | `TIS620_THAI_CI` |
| `HOSXP_AUTH_DB_HOST` | IP ของ Auth DB | `192.168.0.246` |
| `HOSXP_AUTH_DB_NAME` | ชื่อ Auth DB | `hos` |
| `HOSXP_AUTH_DB_USER` | MySQL user (Auth) | `ekg_readonly` |
| `HOSXP_AUTH_DB_PASSWORD` | MySQL password (Auth) | |
| `HOSXP_HN_LENGTH` | ความยาว HN ใน HOSxP | `7` |
| `HOSXP_IMAGE_SOURCES` | ตารางภาพที่ดึง | `opdscan,patient_opd_scan,er_image,lab_order_image` |
| `HOSXP_USER_TABLE` | ตารางผู้ใช้ HOSxP | `opduser` |
| `HOSXP_PASSWORD_HASH` | วิธี hash รหัส | `md5md5` |
| `AUTH_MODE` | โหมด login | `both` |
| `DATA_DIR` | ที่เก็บข้อมูล session/cache | `./data` |

---

### 5. ทดสอบการเชื่อมต่อ

```bash
npm run check-hosxp
```

ผลที่ต้องการ:
```json
{ "enabled": true, "ok": true }
```

ถ้า `ok: false` ให้ตรวจสอบ IP, user/password, charset, และสิทธิ์ MySQL

---

### 6. รันแอป

**ทดลองรัน (dev):**
```bash
npm start
# เปิด http://localhost:3000
```

**รันด้วย PM2 (แนะนำสำหรับ production):**

ติดตั้ง PM2 ครั้งแรก:
```bash
npm install -g pm2
```

สำหรับ **Windows** (ให้รันอัตโนมัติตอน boot):
```bash
npm install -g pm2-windows-startup
pm2-startup install
pm2 start ecosystem.config.js
pm2 save
```

สำหรับ **Linux** (systemd):
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # ทำตามคำสั่งที่แสดงขึ้นมา
```

คำสั่งที่ใช้บ่อย:
```bash
pm2 status                    # ดูสถานะ
pm2 logs ekg-lab-viewer       # ดู log
pm2 restart ekg-lab-viewer    # รีสตาร์ท
pm2 stop ekg-lab-viewer       # หยุด
```

---

### 7. เปิด Firewall และเข้าใช้งาน

เปิดพอร์ต 3000 เฉพาะวง LAN ของ รพ.:

**Windows Firewall:**
```
Windows Defender Firewall → Inbound Rules → New Rule → Port 3000
```

**Linux (ufw):**
```bash
sudo ufw allow from 192.168.0.0/16 to any port 3000
```

เข้าใช้งาน: `http://<IP server>:3000`

> ⚠️ **ห้ามเปิดออกอินเทอร์เน็ตตรงๆ** ถ้าต้องใช้นอก รพ. ให้ผ่าน VPN

---

## การ Login

ใช้บัญชี HOSxP เดิม (ชื่อผู้ใช้และรหัสผ่านเดียวกับที่ login HOSxP)  
ระบบตรวจสอบกับตาราง `opduser` ใน HOSxP โดยอัตโนมัติ

---

## การตรวจสอบสิทธิ์ MySQL (PM2 บน Windows)

ถ้า PM2 ขึ้น error `connect EPERM \\.\pipe\rpc.sock` แสดงว่า PM2 daemon ยังไม่ทำงาน ให้รัน:
```bash
pm2 kill
pm2 start ecosystem.config.js
```

ถ้ายังไม่หาย ให้รันด้วย Administrator

---

## โครงสร้างไฟล์

```
ekg-lab/
├── server.js              Express server + API + auth guard
├── hosxp.js               เชื่อม 2 DB pool, query ภาพ HOSxP
├── auth.js                ระบบ login + ตรวจสอบ HOSxP user
├── ecosystem.config.js    ตั้งค่า PM2
├── package.json
├── .env.example           ตัวอย่างค่าตั้ง
├── public/
│   ├── index.html         หน้าหลัก
│   ├── login.html         หน้า login
│   ├── app.js             frontend logic
│   ├── style.css
│   └── login.css
└── data/                  (สร้างเอง ตอนรัน) session, cache
```
