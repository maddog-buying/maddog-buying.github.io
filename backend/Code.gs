/**
 * 貨態查詢系統 — Google Apps Script 後端
 *
 * 部署方式：在 Google 試算表中「擴充功能 → Apps Script」，貼上本檔，
 * 先執行一次 setup()，再「部署 → 新增部署作業 → 網頁應用程式」。
 * 詳細步驟請見 README.md。
 */

const CONFIG = {
  // Google Cloud Console 建立的 OAuth 用戶端 ID（需與前端 config.js 相同）
  GOOGLE_CLIENT_ID: '673711843673-78ota4tlqcsa0ghgp1gk2r2pi8t74pd3.apps.googleusercontent.com',
  // 可選的貨態狀態，依需求增減
  STATUSES: ['已建立', '已收件', '處理中', '已出貨', '運送中', '配送中', '已送達', '異常', '已取消'],
};

// 每張工作表的欄位：[程式用 key, 試算表標題]
const SHEETS = {
  shipments: {
    name: '貨態',
    cols: [['id', '貨態編號'], ['status', '目前狀態'], ['note', '備註'], ['bindCode', '綁定碼'],
           ['updatedAt', '最後更新'], ['updatedBy', '更新者'], ['createdAt', '建立時間']],
  },
  history: {
    name: '歷程',
    cols: [['time', '時間'], ['id', '貨態編號'], ['status', '狀態'], ['note', '備註'], ['by', '操作者']],
  },
  bindings: {
    name: '綁定',
    cols: [['id', '貨態編號'], ['email', 'Email'], ['boundAt', '綁定時間'], ['boundBy', '綁定者']],
  },
  users: {
    name: '使用者',
    cols: [['email', 'Email'], ['name', '名稱'], ['role', '角色'], ['createdAt', '建立時間'], ['lastLogin', '最後登入']],
  },
};

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/** 第一次使用時手動執行：建立工作表，並把執行者設為管理者 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.values(SHEETS).forEach(def => {
    let sh = ss.getSheetByName(def.name);
    if (!sh) sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map(c => c[1])]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 文字欄位設為純文字，避免編號開頭的 0 被吃掉
    def.cols.forEach(([key], i) => {
      if (!/At$|^time$/.test(key)) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const email = Session.getEffectiveUser().getEmail().toLowerCase();
  const users = readAll_('users');
  if (!users.some(u => u.email === email)) {
    append_('users', { email, name: '', role: 'admin', createdAt: new Date(), lastLogin: '' });
  }
  Logger.log('完成！管理者：' + email);
}

/* ------------------------------------------------------------------ */
/* HTTP 入口                                                           */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, data: '貨態 API 運作中' });
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e.postData && e.postData.contents) || '{}');
    const route = ROUTES[req.action];
    if (!route) throw apiError_(400, '未知的操作：' + req.action);
    const user = authenticate_(req.idToken);
    if (route.admin && user.role !== 'admin') throw apiError_(403, '需要管理者權限');
    const run = () => route.fn(req.payload || {}, user);
    res = { ok: true, data: route.write ? withLock_(run) : run() };
  } catch (err) {
    res = err.code
      ? { ok: false, code: err.code, error: err.message }
      : { ok: false, code: 500, error: '伺服器錯誤：' + err.message };
  }
  return json_(res);
}

const ROUTES = {
  // 所有登入者
  me:            { fn: me_ },
  myShipments:   { fn: myShipments_ },
  bindByCode:    { fn: bindByCode_, write: true },
  unbindMine:    { fn: unbindMine_, write: true },
  // 管理者
  listShipments: { fn: listShipments_, admin: true },
  saveShipment:  { fn: saveShipment_, admin: true, write: true },
  batchStatus:   { fn: batchStatus_, admin: true, write: true },
  deleteShipment:{ fn: deleteShipment_, admin: true, write: true },
  history:       { fn: history_, admin: true },
  bind:          { fn: bind_, admin: true, write: true },
  unbind:        { fn: unbind_, admin: true, write: true },
  listUsers:     { fn: listUsers_, admin: true },
  setRole:       { fn: setRole_, admin: true, write: true },
};

/* ------------------------------------------------------------------ */
/* 驗證                                                                */
/* ------------------------------------------------------------------ */

function authenticate_(idToken) {
  if (!idToken) throw apiError_(401, '請先登入');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  let info = cache.get(key);
  if (info) {
    info = JSON.parse(info);
  } else {
    const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw apiError_(401, '登入已失效，請重新登入');
    const t = JSON.parse(r.getContentText());
    if (t.aud !== CONFIG.GOOGLE_CLIENT_ID) throw apiError_(401, '登入憑證不屬於本系統');
    if (String(t.email_verified) !== 'true') throw apiError_(401, 'Google 帳號 Email 尚未驗證');
    info = { email: String(t.email).toLowerCase(), name: t.name || '' };
    const ttl = Number(t.exp) - Math.floor(Date.now() / 1000) - 30;
    if (ttl > 0) cache.put(key, JSON.stringify(info), Math.min(ttl, 21600));
    touchUser_(info);
  }
  const u = readAll_('users').find(x => x.email === info.email);
  return { email: info.email, name: (u && u.name) || info.name, role: (u && u.role) || 'user' };
}

/** 首次登入自動建立使用者，並更新最後登入時間 */
function touchUser_(info) {
  withLock_(() => {
    const u = readAll_('users').find(x => x.email === info.email);
    if (u) update_('users', u._row, { name: u.name || info.name, lastLogin: new Date() });
    else append_('users', { email: info.email, name: info.name, role: 'user', createdAt: new Date(), lastLogin: new Date() });
  });
}

/* ------------------------------------------------------------------ */
/* 一般使用者                                                          */
/* ------------------------------------------------------------------ */

function me_(p, user) {
  return Object.assign({}, user, { statuses: CONFIG.STATUSES });
}

function myShipments_(p, user) {
  const ids = readAll_('bindings').filter(b => b.email === user.email).map(b => b.id);
  const map = indexBy_(readAll_('shipments'), 'id');
  return unique_(ids).map(id => map[id]
    ? { id, status: map[id].status, note: map[id].note, updatedAt: iso_(map[id].updatedAt) }
    : { id, status: null, note: '', updatedAt: null });
}

function bindByCode_(p, user) {
  const id = normId_(p.id);
  const code = String(p.code || '').trim();
  const s = readAll_('shipments').find(x => x.id === id);
  // 不論編號不存在或綁定碼錯誤都回相同訊息，避免被猜編號
  if (!s || !s.bindCode || String(s.bindCode) !== code) throw apiError_(400, '貨態編號或綁定碼錯誤');
  const exists = readAll_('bindings').some(b => b.id === id && b.email === user.email);
  if (!exists) append_('bindings', { id, email: user.email, boundAt: new Date(), boundBy: user.email });
  return { id };
}

function unbindMine_(p, user) {
  removeWhere_('bindings', b => b.id === normId_(p.id) && b.email === user.email);
  return true;
}

/* ------------------------------------------------------------------ */
/* 管理者                                                              */
/* ------------------------------------------------------------------ */

function listShipments_() {
  const byId = {};
  readAll_('bindings').forEach(b => (byId[b.id] = byId[b.id] || []).push(b.email));
  return readAll_('shipments').map(s => ({
    id: s.id, status: s.status, note: s.note, bindCode: s.bindCode,
    updatedAt: iso_(s.updatedAt), updatedBy: s.updatedBy, createdAt: iso_(s.createdAt),
    emails: unique_(byId[s.id] || []),
  }));
}

function saveShipment_(p, user) {
  const id = normId_(p.id);
  if (!id) throw apiError_(400, '請輸入貨態編號');
  const status = String(p.status || '').trim();
  if (!status) throw apiError_(400, '請選擇狀態');
  const note = String(p.note || '').trim();
  const bindCode = String(p.bindCode || '').trim();
  const now = new Date();
  const existing = readAll_('shipments').find(s => s.id === id);

  if (p.mode === 'create') {
    if (existing) throw apiError_(409, '貨態編號已存在：' + id);
    append_('shipments', { id, status, note, bindCode, updatedAt: now, updatedBy: user.email, createdAt: now });
    append_('history', { time: now, id, status, note, by: user.email });
  } else {
    if (!existing) throw apiError_(404, '找不到貨態編號：' + id);
    const changed = existing.status !== status || existing.note !== note;
    update_('shipments', existing._row, changed
      ? { status, note, bindCode, updatedAt: now, updatedBy: user.email }
      : { bindCode });
    if (changed) append_('history', { time: now, id, status, note, by: user.email });
  }
  return { id };
}

function batchStatus_(p, user) {
  const ids = unique_((p.ids || []).map(normId_));
  const status = String(p.status || '').trim();
  const note = String(p.note || '').trim();
  if (!ids.length || !status) throw apiError_(400, '請選擇貨態與狀態');
  const now = new Date();
  const want = new Set(ids);
  const rows = readAll_('shipments').filter(s => want.has(s.id));
  rows.forEach(s => update_('shipments', s._row, { status, note, updatedAt: now, updatedBy: user.email }));
  appendMany_('history', rows.map(s => ({ time: now, id: s.id, status, note, by: user.email })));
  return { updated: rows.length };
}

function deleteShipment_(p, user) {
  const id = normId_(p.id);
  removeWhere_('shipments', s => s.id === id);
  removeWhere_('bindings', b => b.id === id);
  append_('history', { time: new Date(), id, status: '（已刪除）', note: '', by: user.email });
  return true;
}

function history_(p) {
  const id = normId_(p.id);
  return readAll_('history').filter(h => h.id === id)
    .map(h => ({ time: iso_(h.time), status: h.status, note: h.note, by: h.by }))
    .sort((a, b) => (b.time || '').localeCompare(a.time || ''));
}

function bind_(p, user) {
  const id = normId_(p.id);
  if (!readAll_('shipments').some(s => s.id === id)) throw apiError_(404, '找不到貨態編號：' + id);
  const emails = unique_((p.emails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
  const bad = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad.length) throw apiError_(400, 'Email 格式錯誤：' + bad.join(', '));
  const have = new Set(readAll_('bindings').filter(b => b.id === id).map(b => b.email));
  const now = new Date();
  appendMany_('bindings', emails.filter(e => !have.has(e)).map(email => ({ id, email, boundAt: now, boundBy: user.email })));
  return true;
}

function unbind_(p) {
  const id = normId_(p.id);
  const email = String(p.email || '').toLowerCase();
  removeWhere_('bindings', b => b.id === id && b.email === email);
  return true;
}

function listUsers_() {
  const counts = {};
  readAll_('bindings').forEach(b => (counts[b.email] = (counts[b.email] || 0) + 1));
  return readAll_('users').map(u => ({
    email: u.email, name: u.name, role: u.role || 'user',
    createdAt: iso_(u.createdAt), lastLogin: iso_(u.lastLogin), bound: counts[u.email] || 0,
  }));
}

function setRole_(p, user) {
  const email = String(p.email || '').toLowerCase();
  const role = p.role === 'admin' ? 'admin' : 'user';
  if (email === user.email && role !== 'admin') throw apiError_(400, '不能移除自己的管理者權限');
  const u = readAll_('users').find(x => x.email === email);
  if (u) update_('users', u._row, { role });
  else append_('users', { email, name: '', role, createdAt: new Date(), lastLogin: '' });
  return true;
}

/* ------------------------------------------------------------------ */
/* 試算表存取                                                          */
/* ------------------------------------------------------------------ */

function sheet_(key) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS[key].name);
  if (!sh) throw new Error('找不到工作表「' + SHEETS[key].name + '」，請先執行 setup()');
  return sh;
}

function readAll_(key) {
  const sh = sheet_(key);
  const cols = SHEETS[key].cols;
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach(([k], j) => (o[k] = r[j] instanceof Date ? r[j] : String(r[j]).trim()));
    if (o.id !== undefined) o.id = normId_(o.id);
    if (o.email !== undefined) o.email = o.email.toLowerCase();
    return o;
  }).filter(o => Object.keys(o).some(k => k !== '_row' && o[k] !== ''));
}

function toRow_(key, obj) {
  return SHEETS[key].cols.map(([k]) => cell_(obj[k]));
}

function append_(key, obj) {
  appendMany_(key, [obj]);
}

function appendMany_(key, objs) {
  if (!objs.length) return;
  const sh = sheet_(key);
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, SHEETS[key].cols.length)
    .setValues(objs.map(o => toRow_(key, o)));
}

function update_(key, row, patch) {
  const sh = sheet_(key);
  SHEETS[key].cols.forEach(([k], i) => {
    if (k in patch) sh.getRange(row, i + 1).setValue(cell_(patch[k]));
  });
}

function removeWhere_(key, pred) {
  const sh = sheet_(key);
  readAll_(key).filter(pred).map(o => o._row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_(503, '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 防止使用者輸入被當成公式執行 */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function normId_(v) { return String(v || '').trim().toUpperCase(); }
function iso_(d) { return d instanceof Date ? d.toISOString() : (d || null); }
function unique_(a) { return Array.from(new Set(a)); }
function indexBy_(arr, k) { const m = {}; arr.forEach(o => (m[o[k]] = o)); return m; }
function apiError_(code, msg) { const e = new Error(msg); e.code = code; return e; }
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
