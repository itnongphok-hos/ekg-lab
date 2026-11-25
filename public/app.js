'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_LABEL = { ekg: 'EKG', lab: 'Out Lab', scan: 'สแกน HOSxP' };
const looksLikeHn = (q) => /^[0-9][0-9A-Za-z\-\/]{2,}$/.test(q);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function thaiDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' });
}

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  // ถ้า session หมดอายุ → redirect ไปหน้า login
  if (res.status === 401) {
    location.href = data.redirect || '/login.html';
    throw new Error('session expired');
  }
  if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
  return data;
}

// ---------- User / Logout ----------
(async () => {
  try {
    const me = await fetch('/api/auth/me').then(r => r.json());
    if (me && me.username) {
      const userMenu = $('#userMenu');
      const userDisplay = $('#userDisplay');
      if (userMenu && userDisplay) {
        userDisplay.textContent = me.name || me.username;
        userMenu.classList.remove('hidden');
      }
    }
  } catch {}
})();

document.getElementById('btnLogout')?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

const state = {
  patients: [],
  current: null, // { patient, records }
  filter: 'all',
  selected: [], // ids for compare
};


// ---------------- Patients ----------------
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadPatients, 200);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = $('#search').value.trim();
  if (state.patients.length === 1) openPatient(state.patients[0].hn);
  else if (looksLikeHn(q)) openPatient(q);
});

const SOURCE_SHORT = { opdscan: 'OPD Scan', patient_opd_scan: 'เอกสารแนบ', upload: 'อัปโหลด', lab_order_image: 'Lab นอก', er_image: 'ภาพ ER' };

async function loadPatients() {
  const q = $('#search').value.trim();
  if (!q) return loadRecent();
  state.patients = await api('/api/patients?q=' + encodeURIComponent(q));
  $('#sidebarTitle').textContent = 'ผลการค้นหา';
  const ul = $('#patientList');
  const exact = state.patients.some((p) => p.hn === q || p.hn.replace(/^0+/, '') === q.replace(/^0+/, ''));
  const hisItem = looksLikeHn(q) && !exact
    ? `<li data-hn="${esc(q)}" class="his-item"><div class="hn">HN ${esc(q)}</div><div class="meta">เปิดดูภาพสแกนจาก HOSxP (Enter)</div></li>`
    : '';
  ul.innerHTML = hisItem + state.patients
    .map(
      (p) => `<li data-hn="${esc(p.hn)}" class="${state.current?.patient.hn === p.hn ? 'active' : ''}">
        <div class="hn">HN ${esc(p.hn)}</div>
        <div>${esc(p.name || '-')}</div>
        <div class="meta"><span class="badge ekg">EKG ${p.ekgCount}</span><span class="badge lab">Lab ${p.labCount}</span><span>${thaiDate(p.lastDate)}</span></div>
      </li>`
    )
    .join('');
  $('#emptyPatients').classList.toggle('hidden', state.patients.length > 0 || looksLikeHn(q));
  $('#emptyPatients').textContent = 'ไม่พบในระบบนี้ — พิมพ์ HN แล้วกด Enter เพื่อค้นใน HOSxP';
}

// 10 HN ล่าสุดที่นำเข้าภาพ (แสดงเมื่อช่องค้นหาว่าง)
async function loadRecent() {
  state.patients = [];
  $('#sidebarTitle').textContent = '10 HN นำเข้าล่าสุด';
  let data;
  try { data = await api('/api/recent'); }
  catch (err) { data = { list: [], hisError: err.message }; }
  if ($('#search').value.trim()) return; // ผู้ใช้เริ่มพิมพ์ค้นหาแล้ว
  $('#patientList').innerHTML = data.list
    .map((p) => {
      const [d, t] = String(p.last).split(' ');
      return `<li data-hn="${esc(p.hn)}" class="${state.current?.patient.hn === p.hn ? 'active' : ''}">
        <div class="hn">HN ${esc(p.hn)}</div>
        <div>${esc(p.name || '(ไม่พบชื่อ)')}</div>
        <div class="meta"><span>${thaiDate(d)} ${esc((t || '').slice(0, 5))} น.</span>${p.sources.map((s) => `<span class="badge src">${esc(SOURCE_SHORT[s] || s)}</span>`).join('')}</div>
      </li>`;
    })
    .join('');
  const empty = $('#emptyPatients');
  empty.textContent = data.hisError || 'ยังไม่มีข้อมูลนำเข้า';
  empty.classList.toggle('hidden', data.list.length > 0 && !data.hisError);
}
setInterval(() => { if (!$('#search').value.trim() && !document.hidden) loadRecent(); }, 60000);
$('#btnRefreshRecent').addEventListener('click', () => { $('#search').value = ''; loadPatients(); });
$('#patientList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-hn]');
  if (li) openPatient(li.dataset.hn);
});

async function openPatient(hn) {
  $('#placeholder').innerHTML = '<p>กำลังโหลด…</p>';
  try {
    state.current = await api('/api/patients/' + encodeURIComponent(hn));
  } catch (err) {
    state.current = null;
    $('#patientView').classList.add('hidden');
    $('#placeholder').classList.remove('hidden');
    $('#placeholder').innerHTML = `<p>${esc(err.message)} (HN ${esc(hn)})</p>`;
    return;
  }
  const p = state.current.patient;
  state.selected = [];
  location.hash = 'hn=' + encodeURIComponent(p.hn);
  $('#placeholder').classList.add('hidden');
  $('#patientView').classList.remove('hidden');
  $('#pvHn').textContent = 'HN ' + p.hn;
  const extra = [p.sex, p.birthday ? 'เกิด ' + thaiDate(p.birthday) + ageText(p.birthday) : ''].filter(Boolean).join(' · ');
  $('#pvName').textContent = (p.name || '(ไม่พบชื่อ)') + (extra ? ' · ' + extra : '');
  const banner = $('#hisBanner');
  banner.textContent = state.current.hisError || '';
  banner.classList.toggle('hidden', !state.current.hisError);
  updateTabCounts();
  $$('#patientList li').forEach((li) => li.classList.toggle('active', li.dataset.hn === p.hn));
  renderTimeline();
  scheduleAutoRefresh(0);
}

// ระหว่างที่ server ตรวจหา EKG อัตโนมัติ ให้ดึงข้อมูลใหม่เป็นระยะ (ไม่รีเซ็ตตำแหน่งเลื่อน/ภาพที่เลือก)
let autoTimer = null;
function scheduleAutoRefresh(round) {
  clearTimeout(autoTimer);
  const pending = state.current?.autoPending || 0;
  const el = $('#autoStatus');
  el.textContent = pending ? `กำลังตรวจหา EKG อัตโนมัติ… เหลือ ${pending} ภาพ` : '';
  el.classList.toggle('hidden', !pending);
  if (!pending || round > 40) return;
  const hn = state.current.patient.hn;
  autoTimer = setTimeout(async () => {
    if (state.current?.patient.hn !== hn) return;
    try {
      const fresh = await api('/api/patients/' + encodeURIComponent(hn));
      if (state.current?.patient.hn !== hn) return;
      const sig = (d) => d.records.map((r) => r.id + r.type).join();
      const changed = sig(fresh) !== sig(state.current);
      state.current = fresh;
      if (changed) {
        const y = $('.content').scrollTop;
        updateTabCounts();
        renderTimeline();
        $('.content').scrollTop = y;
      }
    } catch {}
    scheduleAutoRefresh(round + 1);
  }, 2500);
}

function ageText(birthday) {
  const b = new Date(birthday + 'T00:00:00'), n = new Date();
  let y = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y--;
  return isFinite(y) && y >= 0 ? ` (${y} ปี)` : '';
}

function updateTabCounts() {
  const recs = state.current?.records || [];
  $$('#typeTabs button').forEach((b) => {
    const t = b.dataset.type;
    const n = t === 'all' ? recs.length : recs.filter((r) => r.type === t).length;
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = `${b.dataset.label} (${n})`;
  });
}

// ---------------- Timeline ----------------
$('#typeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (!b) return;
  state.filter = b.dataset.type;
  $$('#typeTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderTimeline();
});

function filteredRecords() {
  const recs = state.current?.records || [];
  return state.filter === 'all' ? recs : recs.filter((r) => r.type === state.filter);
}

function renderTimeline() {
  const recs = filteredRecords();
  const groups = {};
  recs.forEach((r) => (groups[r.date] ||= []).push(r));
  const html = Object.keys(groups)
    .sort((a, b) => b.localeCompare(a))
    .map(
      (date) => `<div class="date-group"><h3>${thaiDate(date)} <span class="count">${groups[date].length} ภาพ</span></h3><div class="cards">${groups[date].map(cardHtml).join('')}</div></div>`
    )
    .join('');
  $('#timeline').innerHTML = html || '<p class="muted">ยังไม่มีภาพในหมวดนี้</p>';
  updateCompareBtn();
}

function cardHtml(r) {
  const isPdf = r.mime === 'application/pdf';
  const sel = state.selected.includes(r.id);
  return `<div class="card ${sel ? 'selected' : ''}" data-id="${r.id}">
    ${isPdf ? '' : `<input type="checkbox" class="pick" title="เลือกเพื่อเทียบ" ${sel ? 'checked' : ''} />`}
    <div class="thumb">${isPdf ? '<span class="pdf">PDF</span>' : `<img loading="lazy" decoding="async" src="${esc(r.thumb || r.url)}" alt="" />`}</div>
    <div class="info">
      <div class="row"><span class="badge ${r.type}" ${r.auto ? 'title="ระบบเดาจากกระดาษกราฟสีชมพู — โปรดตรวจสอบ"' : ''}>${TYPE_LABEL[r.type] || r.type}${r.auto ? ' · อัตโนมัติ' : ''}</span>${r.time ? `<span class="time">${esc(r.time)} น.</span>` : ''}</div>
      ${r.source ? `<div class="src">${esc(r.source)}</div>` : ''}
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    </div>
  </div>`;
}

$('#timeline').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const rec = state.current.records.find((r) => r.id === card.dataset.id);
  if (e.target.classList.contains('pick')) {
    togglePick(rec.id, e.target.checked);
  } else if (e.target.closest('.thumb')) {
    openViewer([rec]);
  }
});

function togglePick(id, on) {
  state.selected = state.selected.filter((x) => x !== id);
  if (on) {
    state.selected.push(id);
    if (state.selected.length > 2) state.selected.shift();
  }
  $$('#timeline .card').forEach((c) => {
    const sel = state.selected.includes(c.dataset.id);
    c.classList.toggle('selected', sel);
    const cb = $('.pick', c);
    if (cb) cb.checked = sel;
  });
  updateCompareBtn();
}
function updateCompareBtn() {
  const n = state.selected.length;
  const b = $('#btnCompare');
  b.textContent = `เทียบภาพ (${n}/2)`;
  b.disabled = n !== 2;
}
$('#btnCompare').addEventListener('click', () => {
  const recs = state.selected.map((id) => state.current.records.find((r) => r.id === id)).filter(Boolean);
  recs.sort((a, b) => a.date.localeCompare(b.date)); // เก่า → ใหม่
  if (recs.length === 2) openViewer(recs);
});

// ---------------- Viewer ----------------
const viewer = $('#viewer');
const panesEl = $('#viewerPanes');
let panes = []; // { rec, el, img, s, x, y, rot, bright, contrast, invert }
let activePane = 0;
let sync = true;
let singleList = null; // records for prev/next navigation in single mode

function openViewer(recs) {
  singleList = recs.length === 1 ? filteredRecords() : null;
  panesEl.innerHTML = '';
  panes = recs.map((rec, i) => makePane(rec, i));
  activePane = 0;
  sync = recs.length > 1;
  $('#btnSync').classList.toggle('hidden', recs.length < 2);
  $('#btnSync').classList.toggle('on', sync);
  $('#btnPrev').classList.toggle('hidden', !singleList);
  $('#btnNext').classList.toggle('hidden', !singleList);
  viewer.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  updateViewerTitle();
  syncSliders();
}

function makePane(rec, i) {
  const el = document.createElement('div');
  el.className = 'pane';
  const p = { rec, el, img: null, s: 1, x: 0, y: 0, rot: 0, bright: 100, contrast: 100, invert: false };
  const url = rec.url;
  if (rec.mime === 'application/pdf') {
    el.innerHTML = `<iframe src="${url}"></iframe>`;
    el.style.cursor = 'default';
  } else {
    const img = new Image();
    img.src = url;
    img.draggable = false;
    img.onload = () => fit(p);
    el.appendChild(img);
    p.img = img;
    attachPanZoom(p, i);
  }
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${TYPE_LABEL[rec.type]} · ${thaiDate(rec.date)}${rec.source ? ' · ' + rec.source : ''}`;
  el.appendChild(label);
  el.addEventListener('pointerdown', () => setActive(i));
  panesEl.appendChild(el);
  return p;
}

function setActive(i) {
  activePane = i;
  panes.forEach((p, j) => p.el.classList.toggle('active-pane', panes.length > 1 && j === i));
  syncSliders();
}

function apply(p) {
  if (!p.img) return;
  const w = p.img.naturalWidth, h = p.img.naturalHeight;
  // ตำแหน่ง (x,y) = มุมซ้ายบนของภาพก่อนหมุน; หมุน/ซูมรอบจุดกึ่งกลางภาพ
  p.img.style.transformOrigin = `${w / 2}px ${h / 2}px`;
  p.img.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.rot}deg) scale(${p.s})`;
  p.img.style.filter = `brightness(${p.bright}%) contrast(${p.contrast}%)${p.invert ? ' invert(1)' : ''}`;
}

function fit(p) {
  if (!p.img || !p.img.naturalWidth) return;
  const w = p.img.naturalWidth, h = p.img.naturalHeight;
  const pw = p.el.clientWidth, ph = p.el.clientHeight;
  const sideways = p.rot % 180 !== 0;
  const bw = sideways ? h : w, bh = sideways ? w : h;
  p.s = Math.min(pw / bw, ph / bh) * 0.98;
  p.x = pw / 2 - w / 2;
  p.y = ph / 2 - h / 2;
  apply(p);
}

function zoomAt(p, k, mx, my) {
  if (!p.img) return;
  const ns = Math.min(Math.max(p.s * k, 0.05), 40);
  k = ns / p.s;
  const w = p.img.naturalWidth, h = p.img.naturalHeight;
  const cx = p.x + w / 2, cy = p.y + h / 2;
  const ncx = mx + (cx - mx) * k, ncy = my + (cy - my) * k;
  p.s = ns;
  p.x = ncx - w / 2;
  p.y = ncy - h / 2;
  apply(p);
}

function targets(i) {
  return sync ? panes : [panes[i ?? activePane]];
}

function attachPanZoom(p, i) {
  const el = p.el;
  const pointers = new Map();
  let lastPinch = null;

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    targets(i).forEach((t) => zoomAt(t, k, fx * t.el.clientWidth, fy * t.el.clientHeight));
  }, { passive: false });

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      targets(i).forEach((t) => { t.x += dx; t.y += dy; apply(t); });
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch) {
        const r = el.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        targets(i).forEach((t) => zoomAt(t, dist / lastPinch, mx, my));
      }
      lastPinch = dist;
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinch = null;
    if (!pointers.size) el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', (e) => {
    const r = el.getBoundingClientRect();
    targets(i).forEach((t) => zoomAt(t, 2, e.clientX - r.left, e.clientY - r.top));
  });
}

function syncSliders() {
  const p = panes[activePane];
  if (!p) return;
  $('#brightness').value = p.bright;
  $('#contrast').value = p.contrast;
  $('[data-act="invert"]').classList.toggle('on', p.invert);
}
$('#brightness').addEventListener('input', (e) => targets().forEach((t) => { t.bright = +e.target.value; apply(t); }));
$('#contrast').addEventListener('input', (e) => targets().forEach((t) => { t.contrast = +e.target.value; apply(t); }));

function updateViewerTitle() {
  const p = state.current.patient;
  let t = `HN ${p.hn} ${p.name || ''}`;
  if (panes.length === 1) {
    const r = panes[0].rec;
    t += ` — ${TYPE_LABEL[r.type]} ${thaiDate(r.date)}`;
    if (singleList) t += ` (${singleList.findIndex((x) => x.id === r.id) + 1}/${singleList.length})`;
    $('#btnOpenNew').href = r.url;
    $('#btnOpenNew').classList.remove('hidden');
  } else {
    t += ' — เทียบภาพ (ซ้าย: เก่ากว่า, ขวา: ใหม่กว่า)';
    $('#btnOpenNew').classList.add('hidden');
  }
  $('#viewerTitle').textContent = t;
}

function step(dir) {
  if (!singleList) return;
  const idx = singleList.findIndex((x) => x.id === panes[0].rec.id);
  const next = singleList[idx + dir];
  if (next) openViewer([next]);
}

function closeViewer() {
  viewer.classList.add('hidden');
  panesEl.innerHTML = '';
  panes = [];
  document.body.style.overflow = '';
}

function act(name) {
  const center = (t) => [t.el.clientWidth / 2, t.el.clientHeight / 2];
  switch (name) {
    case 'zoomIn': targets().forEach((t) => zoomAt(t, 1.25, ...center(t))); break;
    case 'zoomOut': targets().forEach((t) => zoomAt(t, 0.8, ...center(t))); break;
    case 'fit': targets().forEach(fit); break;
    case 'rotate': targets().forEach((t) => { t.rot = (t.rot + 90) % 360; fit(t); }); break;
    case 'invert': targets().forEach((t) => { t.invert = !t.invert; apply(t); }); syncSliders(); break;
    case 'reset': targets().forEach((t) => { t.rot = 0; t.bright = 100; t.contrast = 100; t.invert = false; fit(t); }); syncSliders(); break;
    case 'sync': sync = !sync; $('#btnSync').classList.toggle('on', sync); break;
    case 'prev': step(-1); break;
    case 'next': step(1); break;
    case 'close': closeViewer(); break;
  }
}
$('.viewer-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (b) act(b.dataset.act);
});

document.addEventListener('keydown', (e) => {
  if (viewer.classList.contains('hidden') || e.target.matches('input[type=search], textarea')) return;
  const map = { Escape: 'close', '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '0': 'fit', r: 'rotate', R: 'rotate', i: 'invert', I: 'invert', ArrowLeft: 'prev', ArrowRight: 'next' };
  if (map[e.key]) { e.preventDefault(); act(map[e.key]); }
});
window.addEventListener('resize', () => panes.forEach(fit));

// ---------------- HOSxP ----------------
let hisEnabled = false;
async function loadConfig() {
  try {
    const { hosxp } = await api('/api/config');
    hisEnabled = hosxp.enabled;
    const el = $('#hisStatus');
    if (!hosxp.enabled) return;
    el.classList.remove('hidden');
    el.className = 'his-status ' + (hosxp.ok ? 'ok' : 'err');
    el.textContent = hosxp.ok ? '● HOSxP เชื่อมต่อแล้ว' : '● HOSxP เชื่อมต่อไม่ได้';
    el.title = hosxp.ok ? '' : hosxp.error || '';
  } catch {}
}

// ---------------- Init ----------------
(async function init() {
  loadConfig();
  await loadPatients();
  const m = location.hash.match(/hn=([^&]+)/);
  if (m) openPatient(decodeURIComponent(m[1]));
  $('#search').focus();
})();
