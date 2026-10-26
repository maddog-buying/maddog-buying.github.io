/**
 * 貨態查詢系統 — Google Apps Script 後端
 *
 * 部署方式：在 Google 試算表中「擴充功能 → Apps Script」，貼上本檔，
 * 先執行一次 setup()，再「部署 → 新增部署作業 → 網頁應用程式」。
 * 詳細步驟請見 README.md。
 *
 * 資料模型：
 *   物流單（上游原始物流編號，只有管理者看得到）1 ── N 貨件（自編統一編號＋商品，綁定給客人）
 *   更新物流單狀態時，會把底下「進度落後」的貨件一併推進到該狀態。
 */

const CONFIG = {
  // Google Cloud Console 建立的 OAuth 用戶端 ID（需與前端 config.js 相同）
  GOOGLE_CLIENT_ID: '673711843673-78ota4tlqcsa0ghgp1gk2r2pi8t74pd3.apps.googleusercontent.com',
  // 貨件編號前綴，自動產生格式為 MD261012-001
  ID_PREFIX: 'MD',
  TIMEZONE: 'Asia/Taipei',
  // 狀態依流程先後排列
  // 商品 DM 的販售狀態
  DM_STATUSES: ['現貨', '預購', '售罄'],
  DM_FOLDER_NAME: '瘋狗貨態 DM 圖片',
  STATUSES: ['準備中', '倉庫出倉', '抵達中國港口', '船班發船', '抵達台灣港口', '清關中', '抵達瘋狗窩', '瘋狗窩已寄出', '完成'],
};

// 每張工作表的欄位：[程式用 key, 試算表標題]。新欄位請加在最後，避免舊資料錯位。
const SHEETS = {
  batches: {
    name: '物流單',
    cols: [['id', '物流編號'], ['carrier', '上游'], ['status', '狀態'], ['note', '內部備註'],
           ['updatedAt', '最後更新'], ['updatedBy', '更新者'], ['createdAt', '建立時間']],
  },
  items: {
    name: '貨件',
    cols: [['id', '貨件編號'], ['product', '商品名稱'], ['qty', '數量'], ['batch', '物流編號'],
           ['status', '目前狀態'], ['note', '備註（客戶可見）'],
           ['updatedAt', '最後更新'], ['updatedBy', '更新者'], ['createdAt', '建立時間']],
  },
  history: {
    name: '歷程',
    cols: [['time', '時間'], ['id', '貨件編號'], ['status', '狀態'], ['note', '備註'], ['by', '操作者'], ['batch', '物流編號']],
  },
  bindings: {
    name: '綁定',
    cols: [['id', '貨件編號'], ['email', 'Email'], ['boundAt', '綁定時間'], ['boundBy', '綁定者']],
  },
  users: {
    name: '使用者',
    // name = 使用者自己的 Google 名稱（登入時更新）；nickname = 管理者設定的暱稱（使用者看不到）
    cols: [['email', 'Email'], ['name', 'Google 名稱'], ['role', '角色'], ['createdAt', '建立時間'], ['lastLogin', '最後登入'],
           ['nickname', '暱稱（管理者用）']],
  },
  dm: {
    name: 'DM',
    // deadline 以 yyyy-MM-dd 文字儲存，避免時區造成日期跑掉；imageFileId 是雲端硬碟上的圖片檔
    cols: [['id', 'DM 編號'], ['name', '商品名稱'], ['price', '售價'], ['status', '狀態'], ['deadline', '期限'],
           ['imageUrl', '圖片網址'], ['imageFileId', '圖片檔 ID'], ['updatedAt', '最後更新'], ['updatedBy', '更新者'], ['createdAt', '建立時間']],
  },
};

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/** 第一次使用（或更新版本後）手動執行：建立／更新工作表，並把執行者設為管理者 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  // 舊版「貨件」有綁定碼欄位，已停用：先刪掉該欄，避免後面的欄位錯位
  const itemSheet = ss.getSheetByName(SHEETS.items.name);
  if (itemSheet && itemSheet.getLastColumn() > 0) {
    const col = itemSheet.getRange(1, 1, 1, itemSheet.getLastColumn()).getValues()[0].indexOf('綁定碼');
    if (col >= 0) { itemSheet.deleteColumn(col + 1); Logger.log('已移除「貨件」的綁定碼欄位'); }
  }

  Object.values(SHEETS).forEach(def => {
    let sh = ss.getSheetByName(def.name);
    if (!sh) sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map(c => c[1])]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  ['工作表1', 'Sheet1'].forEach(n => {
    const blank = ss.getSheetByName(n);
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  });

  const email = normEmail_(Session.getEffectiveUser().getEmail());
  if (!readAll_('users').some(u => u.email === email)) {
    append_('users', { email, name: '', role: 'admin', createdAt: new Date(), lastLogin: '' });
  }
  // 舊版把管理者輸入的名稱存在「名稱」欄：還沒登入過的帳號，名稱一定是管理者填的，搬到暱稱欄
  const moved = readAll_('users').filter(u => u.name && !u.nickname && !u.lastLogin);
  updateMany_('users', moved.map(u => ({ row: u._row, patch: { nickname: u.name, name: '' } })));
  if (moved.length) Logger.log('已將 ' + moved.length + ' 筆管理者填寫的名稱移到「暱稱」欄');
  if (ss.getSheetByName('貨態')) Logger.log('提醒：舊版的「貨態」工作表已不再使用，確認不需要後可以刪除。');
  dmFolder_(); // 先建立 DM 圖片資料夾（第一次會要求雲端硬碟授權）
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
  me:             { fn: me_ },
  myShipments:    { fn: myShipments_ },
  // 管理者：物流單
  listBatches:    { fn: listBatches_, admin: true },
  saveBatch:      { fn: saveBatch_, admin: true, write: true },
  deleteBatch:    { fn: deleteBatch_, admin: true, write: true },
  bulkBatchStatus:{ fn: bulkBatchStatus_, admin: true, write: true },
  bulkDeleteBatches:   { fn: bulkDeleteBatches_, admin: true, write: true },
  bulkDeleteShipments: { fn: bulkDeleteShipments_, admin: true, write: true },
  // 管理者：貨件
  listShipments:  { fn: listShipments_, admin: true },
  saveShipment:   { fn: saveShipment_, admin: true, write: true },
  batchStatus:    { fn: batchStatus_, admin: true, write: true },
  deleteShipment: { fn: deleteShipment_, admin: true, write: true },
  history:        { fn: history_, admin: true },
  bind:           { fn: bind_, admin: true, write: true },
  unbind:         { fn: unbind_, admin: true, write: true },
  // 管理者：使用者
  listUsers:      { fn: listUsers_, admin: true },
  // 商品 DM：所有登入者可看，管理者可編輯
  listDM:         { fn: listDM_ },
  saveDM:         { fn: saveDM_, admin: true, write: true },
  deleteDM:       { fn: deleteDM_, admin: true, write: true },
  setRole:        { fn: setRole_, admin: true, write: true },
  saveUser:       { fn: saveUser_, admin: true, write: true },
  deleteUser:     { fn: deleteUser_, admin: true, write: true },
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
    info = { email: normEmail_(t.email), name: t.name || '' };
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
    if (u) update_('users', u._row, { name: info.name, lastLogin: new Date() });
    else append_('users', { email: info.email, name: info.name, role: 'user', createdAt: new Date(), lastLogin: new Date() });
  });
}

/* ------------------------------------------------------------------ */
/* 一般使用者（只能查看，不會回傳物流編號、上游等內部資料）              */
/* ------------------------------------------------------------------ */

function me_(p, user) {
  return Object.assign({}, user, { statuses: CONFIG.STATUSES });
}

function myShipments_(p, user) {
  const ids = unique_(readAll_('bindings').filter(b => b.email === user.email).map(b => b.id));
  const map = indexBy_(readAll_('items'), 'id');
  return ids.filter(id => map[id]).map(id => {
    const s = map[id];
    return { id, product: s.product, qty: s.qty, status: s.status, note: s.note, updatedAt: iso_(s.updatedAt) };
  });
}

/* ------------------------------------------------------------------ */
/* 管理者：物流單                                                      */
/* ------------------------------------------------------------------ */

function listBatches_() {
  const counts = {};
  readAll_('items').forEach(i => { if (i.batch) counts[i.batch] = (counts[i.batch] || 0) + 1; });
  return readAll_('batches').map(b => ({
    id: b.id, carrier: b.carrier, status: b.status, note: b.note,
    updatedAt: iso_(b.updatedAt), updatedBy: b.updatedBy, createdAt: iso_(b.createdAt),
    itemCount: counts[b.id] || 0,
  }));
}

function saveBatch_(p, user) {
  const id = normId_(p.id);
  if (!id) throw apiError_(400, '請輸入物流編號');
  const status = validStatus_(p.status);
  const carrier = str_(p.carrier), note = str_(p.note), now = new Date();
  const ex = readAll_('batches').find(b => b.id === id);
  let statusChanged = true;
  if (p.mode === 'create') {
    if (ex) throw apiError_(409, '物流編號已存在：' + id);
    append_('batches', { id, carrier, status, note, updatedAt: now, updatedBy: user.email, createdAt: now });
  } else {
    if (!ex) throw apiError_(404, '找不到物流編號：' + id);
    statusChanged = ex.status !== status;
    update_('batches', ex._row, Object.assign({ carrier, note },
      statusChanged ? { status, updatedAt: now, updatedBy: user.email } : {}));
  }
  // 狀態有變（或要求強制同步）時，帶動底下的貨件
  const updated = statusChanged || p.syncAll
    ? setItemsStatus_(readAll_('items').filter(i => i.batch === id), status, '（物流單更新）', user, now, !p.syncAll)
    : 0;
  return { id, updated };
}

/** 多張物流單一次改狀態，並帶動底下的貨件（規則同 saveBatch_） */
function bulkBatchStatus_(p, user) {
  const want = new Set((p.ids || []).map(normId_));
  if (!want.size) throw apiError_(400, '請選擇物流單');
  const status = validStatus_(p.status), now = new Date();
  const batches = readAll_('batches').filter(b => want.has(b.id));
  updateMany_('batches', batches.map(b => ({ row: b._row, patch: { status, updatedAt: now, updatedBy: user.email } })));
  const items = readAll_('items').filter(i => want.has(i.batch));
  const updated = setItemsStatus_(items, status, '（物流單批次更新）', user, now, !p.syncAll);
  return { batches: batches.length, items: updated };
}

/** 批次刪除物流單，底下的貨件與客人綁定一併刪除（歷程保留） */
function bulkDeleteBatches_(p, user) {
  const want = new Set((p.ids || []).map(normId_));
  if (!want.size) throw apiError_(400, '請選擇物流單');
  const items = readAll_('items').filter(i => want.has(i.batch));
  const itemIds = new Set(items.map(i => i.id));
  const batches = removeWhere_('batches', b => want.has(b.id));
  removeWhere_('items', i => itemIds.has(i.id));
  removeWhere_('bindings', b => itemIds.has(b.id));
  const now = new Date();
  appendMany_('history', items.map(i => ({ time: now, id: i.id, status: '（已刪除）', note: '隨物流單刪除', by: user.email, batch: i.batch })));
  return { batches, items: items.length };
}

function deleteBatch_(p) {
  const id = normId_(p.id);
  const n = readAll_('items').filter(i => i.batch === id).length;
  if (n) throw apiError_(409, `此物流單還有 ${n} 筆貨件，請先移到其他物流單或刪除`);
  removeWhere_('batches', b => b.id === id);
  return true;
}

/* ------------------------------------------------------------------ */
/* 管理者：貨件                                                        */
/* ------------------------------------------------------------------ */

function listShipments_() {
  const byId = {};
  readAll_('bindings').forEach(b => (byId[b.id] = byId[b.id] || []).push(b.email));
  // 曾經登入過的帳號；綁定了但從沒登入的 Email 會標示出來，方便發現打錯字
  const loggedIn = new Set(readAll_('users').filter(u => u.lastLogin).map(u => u.email));
  return readAll_('items').map(s => ({
    id: s.id, product: s.product, qty: s.qty, batch: s.batch, status: s.status, note: s.note,
    updatedAt: iso_(s.updatedAt), updatedBy: s.updatedBy, createdAt: iso_(s.createdAt),
    emails: unique_(byId[s.id] || []),
    pending: unique_(byId[s.id] || []).filter(e => !loggedIn.has(e)),
  }));
}

function saveShipment_(p, user) {
  const product = str_(p.product);
  if (!product) throw apiError_(400, '請輸入商品名稱');
  const qty = Math.max(1, parseInt(p.qty, 10) || 1);
  const batch = normId_(p.batch);
  if (batch && !readAll_('batches').some(b => b.id === batch)) throw apiError_(404, '找不到物流編號：' + batch);
  const status = validStatus_(p.status);
  const note = str_(p.note), now = new Date();
  const items = readAll_('items');

  if (p.mode === 'create') {
    const id = normId_(p.id) || nextId_(items);
    if (items.some(s => s.id === id)) throw apiError_(409, '貨件編號已存在：' + id);
    append_('items', { id, product, qty, batch, status, note, updatedAt: now, updatedBy: user.email, createdAt: now });
    append_('history', { time: now, id, status, note, by: user.email, batch });
    if (p.emails && p.emails.length) bindEmails_(id, p.emails, user);
    return { id };
  }

  const id = normId_(p.id);
  const ex = items.find(s => s.id === id);
  if (!ex) throw apiError_(404, '找不到貨件編號：' + id);
  const changed = ex.status !== status || ex.note !== note;
  update_('items', ex._row, Object.assign({ product, qty, batch },
    changed ? { status, note, updatedAt: now, updatedBy: user.email } : {}));
  if (changed) append_('history', { time: now, id, status, note, by: user.email, batch });
  return { id };
}

function batchStatus_(p, user) {
  const want = new Set((p.ids || []).map(normId_));
  if (!want.size) throw apiError_(400, '請選擇貨件');
  const status = validStatus_(p.status);
  const items = readAll_('items').filter(s => want.has(s.id));
  return { updated: setItemsStatus_(items, status, str_(p.note), user, new Date(), false, true) };
}

/** 批次刪除貨件與客人綁定（歷程保留） */
function bulkDeleteShipments_(p, user) {
  const want = new Set((p.ids || []).map(normId_));
  if (!want.size) throw apiError_(400, '請選擇貨件');
  const deleted = removeWhere_('items', s => want.has(s.id));
  removeWhere_('bindings', b => want.has(b.id));
  const now = new Date();
  appendMany_('history', [...want].map(id => ({ time: now, id, status: '（已刪除）', note: '', by: user.email, batch: '' })));
  return { deleted };
}

function deleteShipment_(p, user) {
  const id = normId_(p.id);
  removeWhere_('items', s => s.id === id);
  removeWhere_('bindings', b => b.id === id);
  append_('history', { time: new Date(), id, status: '（已刪除）', note: '', by: user.email, batch: '' });
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
  if (!readAll_('items').some(s => s.id === id)) throw apiError_(404, '找不到貨件編號：' + id);
  bindEmails_(id, p.emails || [], user);
  return true;
}

function unbind_(p) {
  const id = normId_(p.id);
  const email = normEmail_(p.email);
  removeWhere_('bindings', b => b.id === id && b.email === email);
  return true;
}

/* ------------------------------------------------------------------ */
/* 商品 DM                                                             */
/* ------------------------------------------------------------------ */

function listDM_() {
  return readAll_('dm').map(d => ({
    id: d.id, name: d.name, price: d.price === '' ? null : Number(d.price), status: d.status,
    deadline: d.deadline instanceof Date ? Utilities.formatDate(d.deadline, CONFIG.TIMEZONE, 'yyyy-MM-dd') : d.deadline,
    imageUrl: d.imageUrl, imageFileId: d.imageFileId, updatedAt: iso_(d.updatedAt), createdAt: iso_(d.createdAt),
  }));
}

function saveDM_(p, user) {
  const name = str_(p.name);
  if (!name) throw apiError_(400, '請輸入商品名稱');
  const status = str_(p.status);
  if (CONFIG.DM_STATUSES.indexOf(status) < 0) throw apiError_(400, '無效的商品狀態：' + status);
  const priceStr = str_(p.price);
  const price = priceStr === '' ? '' : Number(priceStr);
  if (price !== '' && (!isFinite(price) || price < 0)) throw apiError_(400, '售價格式錯誤');
  const deadline = str_(p.deadline);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw apiError_(400, '期限格式錯誤');
  let imageUrl = str_(p.imageUrl);
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw apiError_(400, '圖片網址必須是 https:// 開頭');

  const now = new Date();
  const rows = readAll_('dm');
  const ex = p.mode === 'create' ? null : rows.find(d => d.id === normId_(p.id));
  if (p.mode !== 'create' && !ex) throw apiError_(404, '找不到這筆 DM');

  let imageFileId = ex ? ex.imageFileId : '';
  if (p.image && p.image.data) {
    const saved = saveImage_(p.image, name);
    trashFile_(imageFileId); // 換圖時把舊圖丟到雲端硬碟的垃圾桶（30 天內可還原）
    imageFileId = saved.fileId;
    imageUrl = saved.url;
  } else if (ex && imageUrl !== ex.imageUrl && ex.imageFileId) {
    trashFile_(ex.imageFileId); // 改用外部網址或移除圖片
    imageFileId = '';
  }

  const rec = { name, price, status, deadline, imageUrl, imageFileId, updatedAt: now, updatedBy: user.email };
  if (ex) {
    update_('dm', ex._row, rec);
    return { id: ex.id };
  }
  const id = 'DM' + Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyMMddHHmmss');
  append_('dm', Object.assign({ id, createdAt: now }, rec));
  return { id };
}

function deleteDM_(p) {
  const want = new Set((p.ids || [p.id]).map(normId_));
  const rows = readAll_('dm').filter(d => want.has(d.id));
  rows.forEach(d => trashFile_(d.imageFileId));
  removeWhere_('dm', d => want.has(d.id));
  return { deleted: rows.length };
}

/** 存放 DM 圖片的雲端硬碟資料夾（資料夾 ID 記在指令碼屬性中） */
function dmFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DM_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 資料夾被刪了就重建 */ }
  }
  const folder = DriveApp.createFolder(CONFIG.DM_FOLDER_NAME);
  props.setProperty('DM_FOLDER_ID', folder.getId());
  return folder;
}

function saveImage_(img, name) {
  const mime = str_(img.mime);
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw apiError_(400, '只接受 JPG、PNG、WebP、GIF 圖片');
  const bytes = Utilities.base64Decode(img.data);
  if (bytes.length > 4 * 1024 * 1024) throw apiError_(400, '圖片太大（上限 4MB）');
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const file = dmFolder_().createFile(Utilities.newBlob(bytes, mime, name + '.' + ext));
  // 網頁要能直接顯示圖片，所以設為「知道連結的人可檢視」
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { fileId: file.getId(), url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200' };
}

function trashFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 檔案已不存在 */ }
}

/* ------------------------------------------------------------------ */
/* 管理者：使用者                                                      */
/* ------------------------------------------------------------------ */

function listUsers_() {
  const counts = {};
  readAll_('bindings').forEach(b => (counts[b.email] = (counts[b.email] || 0) + 1));
  return readAll_('users').map(u => ({
    email: u.email, name: u.name, nickname: u.nickname, role: u.role || 'user',
    createdAt: iso_(u.createdAt), lastLogin: iso_(u.lastLogin), bound: counts[u.email] || 0,
  }));
}

/** 新增客戶，或修改暱稱／角色。Google 名稱由使用者登入時自動帶入，這裡不能改 */
function saveUser_(p, user) {
  const email = normEmail_(p.email);
  if (!isEmail_(email)) throw apiError_(400, 'Email 格式錯誤：' + (p.email || ''));
  const role = p.role === 'admin' || p.role === 'user' ? p.role : null;
  if (email === user.email && role === 'user') throw apiError_(400, '不能移除自己的管理者權限');
  const patch = {};
  if ('nickname' in p) patch.nickname = str_(p.nickname);
  if (role) patch.role = role;
  const u = readAll_('users').find(x => x.email === email);
  if (u) update_('users', u._row, patch);
  else append_('users', { email, name: '', nickname: patch.nickname || '', role: role || 'user', createdAt: new Date(), lastLogin: '' });
  return { email };
}

/** 刪除使用者與他的所有貨件綁定（若對方之後再登入，會以一般客戶身分重新建立、沒有任何綁定） */
function deleteUser_(p, user) {
  const email = normEmail_(p.email);
  if (email === user.email) throw apiError_(400, '不能刪除自己');
  const removed = readAll_('bindings').filter(b => b.email === email).length;
  removeWhere_('bindings', b => b.email === email);
  removeWhere_('users', u => u.email === email);
  return { removedBindings: removed };
}

function setRole_(p, user) {
  const email = normEmail_(p.email);
  if (!isEmail_(email)) throw apiError_(400, 'Email 格式錯誤：' + email);
  const role = p.role === 'admin' ? 'admin' : 'user';
  if (email === user.email && role !== 'admin') throw apiError_(400, '不能移除自己的管理者權限');
  const u = readAll_('users').find(x => x.email === email);
  if (u) update_('users', u._row, { role });
  else append_('users', { email, name: '', role, createdAt: new Date(), lastLogin: '' });
  return true;
}

/* ------------------------------------------------------------------ */
/* 共用邏輯                                                            */
/* ------------------------------------------------------------------ */

/**
 * 批次設定貨件狀態並寫入歷程。
 * onlyForward = true 時只推進「進度落後」的貨件，已經寄出／完成的不會被倒退。
 */
function setItemsStatus_(items, status, note, user, now, onlyForward, setNote) {
  const rank = s => CONFIG.STATUSES.indexOf(s);
  const target = items.filter(i => !onlyForward || rank(i.status) < rank(status));
  updateMany_('items', target.map(i => ({
    row: i._row,
    patch: Object.assign({ status, updatedAt: now, updatedBy: user.email }, setNote ? { note } : {}),
  })));
  appendMany_('history', target.map(i => ({ time: now, id: i.id, status, note, by: user.email, batch: i.batch })));
  return target.length;
}

function bindEmails_(id, emails, user) {
  const list = unique_(emails.map(normEmail_).filter(Boolean));
  const bad = list.filter(e => !isEmail_(e));
  if (bad.length) throw apiError_(400, 'Email 格式錯誤：' + bad.join(', '));
  const have = new Set(readAll_('bindings').filter(b => b.id === id).map(b => b.email));
  const now = new Date();
  appendMany_('bindings', list.filter(e => !have.has(e)).map(email => ({ id, email, boundAt: now, boundBy: user.email })));
  // 還不在使用者名單的 Email 先建立起來，之後就會出現在客人下拉選單中
  const known = new Set(readAll_('users').map(u => u.email));
  appendMany_('users', list.filter(e => !known.has(e)).map(email => ({ email, name: '', role: 'user', createdAt: now, lastLogin: '' })));
}

/** 產生當天的下一個貨件編號，例如 MD261012-003 */
function nextId_(items) {
  const prefix = CONFIG.ID_PREFIX + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyMMdd') + '-';
  const max = items.filter(s => s.id.indexOf(prefix) === 0)
    .reduce((m, s) => Math.max(m, parseInt(s.id.slice(prefix.length), 10) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

function validStatus_(s) {
  s = str_(s);
  if (CONFIG.STATUSES.indexOf(s) < 0) throw apiError_(400, '無效的狀態：' + s);
  return s;
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
    if (o.batch !== undefined) o.batch = normId_(o.batch);
    if (o.email !== undefined) o.email = normEmail_(o.email);
    return o;
  }).filter(o => Object.keys(o).some(k => k !== '_row' && o[k] !== ''));
}

function append_(key, obj) {
  appendMany_(key, [obj]);
}

function appendMany_(key, objs) {
  if (!objs.length) return;
  const sh = sheet_(key);
  const cols = SHEETS[key].cols;
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, cols.length)
    .setValues(objs.map(o => cols.map(([k]) => cell_(o[k]))));
}

function update_(key, row, patch) {
  updateMany_(key, [{ row, patch }]);
}

/** 一次讀寫整個資料範圍，避免逐格寫入太慢 */
function updateMany_(key, changes) {
  if (!changes.length) return;
  const sh = sheet_(key);
  const cols = SHEETS[key].cols;
  const range = sh.getRange(2, 1, sh.getLastRow() - 1, cols.length);
  const vals = range.getValues();
  changes.forEach(({ row, patch }) => cols.forEach(([k], j) => {
    if (k in patch) vals[row - 2][j] = patch[k];
  }));
  range.setValues(vals.map(r => r.map(cell_)));
}

/** 刪除符合條件的列，回傳刪除筆數。筆數多時改成整批重寫，避免逐列刪除太慢 */
function removeWhere_(key, pred) {
  const sh = sheet_(key);
  const del = readAll_(key).filter(pred);
  if (del.length <= 3) {
    del.map(o => o._row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
    return del.length;
  }
  const cols = SHEETS[key].cols.length;
  const range = sh.getRange(2, 1, sh.getLastRow() - 1, cols);
  const delRows = new Set(del.map(o => o._row));
  const keep = range.getValues().filter((_, i) => !delRows.has(i + 2));
  range.clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, cols).setValues(keep.map(r => r.map(cell_)));
  return del.length;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_(503, '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}

/**
 * 寫入儲存格前的處理：
 * - 開頭是 = + - @ 的文字加上 '，避免被當成公式
 * - 數字開頭的文字（例如物流編號 0012345）也加上 '，避免被轉成數字而遺失開頭的 0
 */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@\d]/.test(v)) return "'" + v;
  return v;
}

function str_(v) { return String(v == null ? '' : v).trim(); }
function normId_(v) { return str_(v).toUpperCase(); }
function isEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

/**
 * 統一 Email 寫法：轉小寫；Gmail 的點號與 +別名 都是同一個信箱，一併去除。
 * 例如 John.Doe+shop@gmail.com → johndoe@gmail.com
 */
function normEmail_(e) {
  e = str_(e).toLowerCase();
  const m = e.match(/^([^@]+)@(gmail\.com|googlemail\.com)$/);
  return m ? m[1].split('+')[0].replace(/\./g, '') + '@gmail.com' : e;
}

function iso_(d) { return d instanceof Date ? d.toISOString() : (d || null); }
function unique_(a) { return Array.from(new Set(a)); }
function indexBy_(arr, k) { const m = {}; arr.forEach(o => (m[o[k]] = o)); return m; }
function apiError_(code, msg) { const e = new Error(msg); e.code = code; return e; }
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
