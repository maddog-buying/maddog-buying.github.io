'use strict';

const cfg = window.APP_CONFIG || {};
// 未設定 API_URL，或網址加上 ?demo 時，使用示範資料
const DEMO = !cfg.API_URL || new URLSearchParams(location.search).has('demo');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  user: null, statuses: [], tab: null,
  mine: [], items: [], batches: [], users: [],
  selected: new Set(),        // 勾選的貨件
  selectedBatches: new Set(), // 勾選的物流單
  itemsView: 'active', batchesView: 'active', // 進行中／已完成
  mineDoneOpen: false,                        // 客人頁「已完成」區是否展開
  dm: [], dmQ: '', dmStatus: '',
  editingDM: null, dmImage: null,             // dmImage：待上傳的圖片 { data, mime, preview }
  // 搜尋與篩選（對應 data-model）
  mineQ: '', itemsQ: '', itemsStatus: '', batchesQ: '', batchesStatus: '',
  editingItem: null,  // 正在編輯的貨件編號（null = 新增）
  editingBatch: null, // 正在編輯的物流編號（null = 新增）
  draftEmails: [],    // 新增貨件時先選好、儲存時才綁定的客人
  loaded: {},         // 各分頁是否已載入過資料
};

/* ------------------------------------------------------------------ */
/* 登入 token                                                          */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = DEMO ? 'st_demo_token' : 'st_token';
const CACHE_KEY = DEMO ? 'st_demo_cache' : 'st_cache';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const Auth = {
  token() {
    const t = store.get(TOKEN_KEY);
    return t && t.exp * 1000 > Date.now() + 30e3 ? t.token : null;
  },
  set(token) {
    const exp = DEMO ? Date.now() / 1000 + 30 * 86400 : decodeJwt(token).exp;
    store.set(TOKEN_KEY, { token, exp });
  },
  clear() { store.del(TOKEN_KEY); },
};

function decodeJwt(t) {
  const b = atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))));
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

let inflight = 0;
function busy(delta) {
  inflight += delta;
  $('#progress').hidden = inflight <= 0;
}

async function api(action, payload = {}) {
  const idToken = Auth.token();
  if (!idToken) { showLogin('登入已逾時，請重新登入'); throw new ApiError(401, '請先登入'); }
  busy(1);
  let res;
  try {
    if (DEMO) {
      res = await MockApi.handle({ action, payload, idToken });
    } else {
      const r = await fetch(cfg.API_URL, {
        method: 'POST',
        // text/plain 可避免 CORS 預檢，Apps Script 才收得到
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload, idToken }),
      });
      res = await r.json();
    }
  } catch {
    throw new ApiError(0, '無法連線到伺服器，請檢查網路');
  } finally {
    busy(-1);
  }
  if (!res.ok) {
    if (res.code === 401) { Auth.clear(); showLogin(res.error); }
    // 前端已更新、但 Apps Script 還是舊版時，給管理者明確的處理方式
    if (res.code === 400 && /^未知的操作/.test(res.error || '')) {
      throw new ApiError(400, '後端版本過舊：請到 Apps Script 貼上最新的 Code.gs，並「部署 → 管理部署作業 → 新版本」');
    }
    throw new ApiError(res.code, res.error);
  }
  return res.data;
}

/* ------------------------------------------------------------------ */
/* 畫面切換                                                            */
/* ------------------------------------------------------------------ */

function showView(name) {
  $$('.view').forEach(v => (v.hidden = v.id !== 'view-' + name));
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3200);
}

function fail(e) {
  if (e && e.code === 401) return;
  toast(e.message || String(e), 'error');
}

let gisLoaded;
function loadGis() {
  gisLoaded = gisLoaded || new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.onload = ok; s.onerror = () => no(new Error('無法載入 Google 登入元件'));
    document.head.append(s);
  });
  return gisLoaded;
}

function showLogin(msg = '') {
  closeDialogs();
  showView('login');
  $('#login-msg').textContent = msg;
  const box = $('#login-actions');
  box.innerHTML = '';
  if (DEMO) {
    box.innerHTML = `
      <p class="demo-note">示範模式：尚未設定 API_URL，資料只存在此瀏覽器。</p>
      <button class="btn primary block" data-demo="admin@demo.local">以「管理者」身分試用</button>
      <button class="btn block" data-demo="user@demo.local">以「一般使用者」身分試用</button>`;
    return;
  }
  if (!cfg.GOOGLE_CLIENT_ID) { box.textContent = '尚未設定 GOOGLE_CLIENT_ID（config.js）'; return; }
  loadGis().then(() => {
    google.accounts.id.initialize({
      client_id: cfg.GOOGLE_CLIENT_ID,
      callback: r => { Auth.set(r.credential); enterApp(); },
      auto_select: true,
      cancel_on_tap_outside: false,
    });
    google.accounts.id.renderButton(box, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'zh-TW', width: 280 });
    google.accounts.id.prompt();
  }).catch(e => (box.textContent = e.message));
}

function logout() {
  Auth.clear();
  store.del(CACHE_KEY);
  if (!DEMO && window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  Object.assign(state, { user: null, mine: [], items: [], batches: [], users: [], loaded: {},
    mineQ: '', itemsQ: '', itemsStatus: '', batchesQ: '', batchesStatus: '',
    itemsView: 'active', batchesView: 'active', mineDoneOpen: false, dm: [], dmQ: '', dmStatus: '' });
  state.selected.clear();
  state.selectedBatches.clear();
  $$('.tab').forEach(t => (t.innerHTML = ''));
  showLogin();
}

async function enterApp() {
  showView('app');
  $('#offline-banner').hidden = true;
  try {
    const me = await api('me');
    state.user = me;
    state.statuses = me.statuses || [];
    renderShell();
    await switchTab(me.role === 'admin' ? 'batches' : 'mine');
  } catch (e) {
    if (e.code === 401) return;
    // 離線時顯示上次查詢結果
    const c = store.get(CACHE_KEY);
    if (c && c.me) {
      state.user = c.me; state.statuses = c.me.statuses || []; state.mine = c.mine || [];
      renderShell();
      showOffline(c.at);
      state.loaded.mine = true;
      await switchTab('mine', false);
    } else {
      $('#tab-mine').hidden = false;
      $('#tab-mine').innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="btn primary" data-action="retry">重試</button></div>`;
    }
  }
}

function showOffline(at) {
  const b = $('#offline-banner');
  b.hidden = false;
  b.textContent = `目前離線，顯示的是 ${fmtTime(at)} 的資料`;
}

function renderShell() {
  const u = state.user;
  $('#me-email').textContent = u.name || u.email;
  $('#me-email').title = u.email;
  $('#me-role').textContent = u.role === 'admin' ? '管理者' : '使用者';
  $('#me-role').className = 'badge ' + (u.role === 'admin' ? 'info' : 'muted');
  const tabs = u.role === 'admin'
    ? [['batches', '物流單'], ['items', '貨件'], ['dm', 'DM'], ['users', '使用者'], ['mine', '我的']]
    : [['mine', '我的貨態'], ['dm', '商品 DM']];
  $('#tabs').innerHTML = tabs.map(([k, label]) => `<button data-tab="${k}">${label}</button>`).join('');
  $('#tabs').hidden = false;
  $$('select[name=status]').forEach(sel => {
    sel.innerHTML = state.statuses.map(s => `<option>${esc(s)}</option>`).join('');
  });
}

async function switchTab(tab, load = true) {
  state.tab = tab;
  $$('#tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach(t => (t.hidden = t.id !== 'tab-' + tab));
  if (!load) return render();
  render(); // 先畫骨架
  try {
    if (tab === 'mine') await loadMine();
    if (tab === 'items' || tab === 'batches') await loadAdmin();
    if (tab === 'users') state.users = await api('listUsers');
    if (tab === 'dm') state.dm = await api('listDM');
    state.loaded[tab] = true;
    $('#offline-banner').hidden = true;
  } catch (e) { fail(e); }
  render();
}

async function loadMine() {
  state.mine = await api('myShipments');
  store.set(CACHE_KEY, { me: state.user, mine: state.mine, at: new Date().toISOString() });
}

async function loadAdmin() {
  [state.items, state.batches, state.users] = await Promise.all([api('listShipments'), api('listBatches'), api('listUsers')]);
  state.loaded.items = state.loaded.batches = state.loaded.users = true;
  const carriers = [...new Set(state.batches.map(b => b.carrier).filter(Boolean))];
  $('#carrier-list').innerHTML = carriers.map(c => `<option value="${esc(c)}">`).join('');
}

function render() {
  if (state.tab === 'mine') renderMine();
  if (state.tab === 'batches') renderBatches();
  if (state.tab === 'items') renderItems();
  if (state.tab === 'users') renderUsers();
  if (state.tab === 'dm') renderDM();
}

/* ------------------------------------------------------------------ */
/* 格式                                                                */
/* ------------------------------------------------------------------ */

const TONES = { '準備中': 'muted', '清關中': 'warn', '抵達瘋狗窩': 'accent', '瘋狗窩已寄出': 'accent', '完成': 'ok' };
const tone = s => TONES[s] || (state.statuses.includes(s) ? 'info' : 'muted');
const badge = s => s ? `<span class="badge ${tone(s)}">${esc(s)}</span>` : `<span class="badge muted">查無資料</span>`;
const LOADING = '<div class="empty muted"><p>載入中…</p></div>';
const qtyTag = q => Number(q) > 1 ? `<span class="qty">×${esc(q)}</span>` : '';

const dtf = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function fmtTime(iso) { return iso ? dtf.format(new Date(iso)) : '—'; }
function relTime(iso) {
  if (!iso) return '';
  const m = (Date.now() - Date.parse(iso)) / 60e3;
  if (m < 1) return '剛剛';
  if (m < 60) return Math.floor(m) + ' 分鐘前';
  if (m < 1440) return Math.floor(m / 60) + ' 小時前';
  if (m < 1440 * 7) return Math.floor(m / 1440) + ' 天前';
  return fmtTime(iso);
}
const match = (q, ...fields) => !q || fields.some(f => String(f || '').toLowerCase().includes(q.toLowerCase()));
const byUpdated = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
const statusRank = s => { const i = state.statuses.indexOf(s); return i < 0 ? 999 : i; };
// 流程最後一個狀態（完成）視為已完成，自動移到「已完成」區
const isDone = s => !!s && s === state.statuses[state.statuses.length - 1];
const inView = (view, s) => (view === 'done') === isDone(s);

/** 進行中／已完成 切換 */
function viewSeg(key, list) {
  const done = list.filter(x => isDone(x.status)).length;
  const btn = (val, label, n) => `<button type="button" data-action="set-view" data-key="${key}" data-val="${val}"
      class="${state[key] === val ? 'on' : ''}" aria-pressed="${state[key] === val}">${label}<span class="count">${n}</span></button>`;
  return `<div class="seg">${btn('active', '進行中', list.length - done)}${btn('done', '已完成', done)}</div>`;
}
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const userOf = email => state.users.find(u => u.email === email) || {};
// 管理者畫面優先顯示暱稱，沒設定暱稱時才用對方的 Google 名稱
const displayName = u => u.nickname || u.name || '';
const custName = email => displayName(userOf(email));
const custShort = email => custName(email) || email;

function statusFilter(model, list, view = 'active') {
  if (view === 'done') return ''; // 已完成區只有一種狀態，不需要篩選
  list = list.filter(x => !isDone(x.status));
  const counts = {};
  list.forEach(x => (counts[x.status] = (counts[x.status] || 0) + 1));
  return `<select data-model="${model}" class="status-filter">
    <option value="">全部狀態（${list.length}）</option>
    ${state.statuses.filter(s => !isDone(s)).map(s => `<option value="${esc(s)}" ${s === state[model] ? 'selected' : ''}>${esc(s)}（${counts[s] || 0}）</option>`).join('')}
  </select>`;
}

/** 進度條：依狀態在流程中的位置 */
function steps(status) {
  const i = state.statuses.indexOf(status), n = state.statuses.length;
  if (i < 0) return '';
  const next = state.statuses[i + 1];
  return `<div class="steps" role="img" aria-label="進度 ${i + 1}/${n}">
      ${state.statuses.map((s, j) => `<span class="${j <= i ? 'on' : ''}" title="${esc(s)}"></span>`).join('')}
    </div>
    <div class="steps-label muted"><span>${i + 1} / ${n}</span><span>${next ? '下一站：' + esc(next) : '已完成 🎉'}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* 我的貨件（使用者）                                                   */
/* ------------------------------------------------------------------ */

function renderMine() {
  const el = $('#tab-mine');
  const list = state.mine.filter(s => match(state.mineQ, s.id, s.product, s.status, s.note))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.id.localeCompare(b.id));
  const toolbar = `
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋商品、編號或狀態" data-model="mineQ" value="${esc(state.mineQ)}">
      <button class="btn" data-action="refresh" title="重新整理">↻<span class="hide-sm"> 重新整理</span></button>
    </div>`;
  let body;
  if (!state.loaded.mine) {
    body = LOADING;
  } else if (!state.mine.length) {
    body = `<div class="empty"><p>目前沒有您的貨件</p><p class="muted">請將您登入用的 Gmail（${esc(state.user.email)}）提供給我們，綁定後就會顯示在這裡。</p></div>`;
  } else if (!list.length) {
    body = `<div class="empty"><p>找不到符合「${esc(state.mineQ)}」的貨件</p></div>`;
  } else {
    const card = s => `
      <article class="card ship-card tone-${s.status ? tone(s.status) : 'muted'}">
        <div class="card-head">
          <h3 class="product">${esc(s.product)} ${qtyTag(s.qty)}</h3>
        </div>
        <div class="ship-id muted">${esc(s.id)}</div>
        <div class="ship-status">${badge(s.status)}</div>
        ${steps(s.status)}
        ${s.note ? `<p class="ship-note">${esc(s.note)}</p>` : ''}
        ${s.updatedAt ? `<p class="ship-time muted" title="${esc(fmtTime(s.updatedAt))}">更新於 ${esc(relTime(s.updatedAt))}</p>` : ''}
      </article>`;
    const active = list.filter(s => !isDone(s.status));
    const done = list.filter(s => isDone(s.status));
    body = (active.length
      ? `<div class="cards">${active.map(card).join('')}</div>`
      : `<div class="empty"><p>目前沒有進行中的貨件</p>${done.length ? '<p class="muted">已完成的貨件在下方</p>' : ''}</div>`)
      + (done.length ? `
      <details class="done-section" ${state.mineDoneOpen || !active.length ? 'open' : ''}>
        <summary>已完成<span class="count">${done.length}</span></summary>
        <div class="cards">${done.map(card).join('')}</div>
      </details>` : '');
  }
  keepFocus(el, () => (el.innerHTML = toolbar + body));
}

/* ------------------------------------------------------------------ */
/* 物流單（管理者）                                                     */
/* ------------------------------------------------------------------ */

function batchRows() {
  return state.batches
    .filter(b => inView(state.batchesView, b.status) &&
      (!state.batchesStatus || b.status === state.batchesStatus) && match(state.batchesQ, b.id, b.carrier, b.note))
    .sort(byUpdated);
}

function renderBatches() {
  const el = $('#tab-batches');
  const rows = batchRows();
  const visible = new Set(rows.map(r => r.id));
  [...state.selectedBatches].forEach(id => visible.has(id) || state.selectedBatches.delete(id));
  const n = state.selectedBatches.size;
  const allChecked = rows.length && rows.every(r => state.selectedBatches.has(r.id));
  const toolbar = `
    ${viewSeg('batchesView', state.batches)}
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋物流編號、上游、備註" data-model="batchesQ" value="${esc(state.batchesQ)}">
      ${statusFilter('batchesStatus', state.batches, state.batchesView)}
      <button class="btn" data-action="refresh" title="重新整理">↻</button>
      <button class="btn primary" data-action="new-batch">＋ 新增物流單</button>
    </div>
    <div class="bulkbar" ${n ? '' : 'hidden'}>
      <span>已選取 ${n} 張物流單</span>
      <button class="btn sm primary" data-action="open-bulk-batch">批次更新狀態</button>
      <button class="btn sm danger" data-action="bulk-delete-batches">批次刪除</button>
      <button class="btn sm ghost" data-action="clear-sel-batch">取消選取</button>
    </div>`;
  const table = rows.length ? `
    <table class="table">
      <thead><tr>
        <th class="chk"><input type="checkbox" data-action="check-all-batch" ${allChecked ? 'checked' : ''} aria-label="全選"></th>
        <th>物流編號</th><th>上游</th><th>狀態</th><th>貨件</th><th>內部備註</th><th>最後更新</th>
      </tr></thead>
      <tbody>${rows.map(b => `
        <tr data-action="edit-batch" data-id="${esc(b.id)}" class="${state.selectedBatches.has(b.id) ? 'sel' : ''}">
          <td class="chk"><input type="checkbox" data-action="check-batch" data-id="${esc(b.id)}" ${state.selectedBatches.has(b.id) ? 'checked' : ''} aria-label="選取 ${esc(b.id)}"></td>
          <td class="ship-id" data-label="物流編號">${esc(b.id)}</td>
          <td data-label="上游">${esc(b.carrier) || '<span class="muted">—</span>'}</td>
          <td data-label="狀態">${badge(b.status)}</td>
          <td data-label="貨件">${b.itemCount ? b.itemCount + ' 筆' : '<span class="muted">0</span>'}</td>
          <td class="note-cell" data-label="備註">${esc(b.note) || '<span class="muted">—</span>'}</td>
          <td data-label="更新" class="muted nowrap" title="${esc(b.updatedBy)}">${esc(fmtTime(b.updatedAt))}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : !state.loaded.batches ? LOADING
      : `<div class="empty"><p>${!state.batches.length ? '還沒有物流單，點「新增物流單」輸入上游的物流編號'
          : state.batchesView === 'done' && !state.batchesQ ? '還沒有已完成的物流單' : '沒有符合條件的物流單'}</p></div>`;
  keepFocus(el, () => (el.innerHTML = toolbar + table));
}

function openBatch(id) {
  const dlg = $('#dlg-batch');
  const f = $('#form-batch');
  const b = id ? state.batches.find(x => x.id === id) : null;
  state.editingBatch = b ? b.id : null;
  f.reset();
  $('#batch-title').textContent = b ? '物流單 ' + b.id : '新增物流單';
  f.id.value = b ? b.id : '';
  f.id.readOnly = !!b;
  f.carrier.value = b ? b.carrier : '';
  setStatus(f.status, b ? b.status : state.statuses[0]);
  f.note.value = b ? b.note : '';
  $('#batch-extra').hidden = !b;
  $('#btn-delete-batch').hidden = !b;
  if (b) renderBatchItems();
  if (!dlg.open) dlg.showModal();
  (b ? f.status : f.id).focus();
}

function renderBatchItems() {
  const list = state.items.filter(i => i.batch === state.editingBatch);
  $('#batch-items-title').textContent = `貨件（${list.length}）`;
  $('#batch-items').innerHTML = list.length ? list.map(i => `
    <li data-action="edit-item" data-id="${esc(i.id)}">
      <div class="grow">
        <div><strong>${esc(i.product)}</strong> ${qtyTag(i.qty)}</div>
        <div class="muted small">${esc(i.id)}・${esc(i.emails.map(custShort).join('、') || '未綁定客人')}</div>
      </div>
      ${badge(i.status)}
    </li>`).join('') : '<li class="muted plain">尚無貨件</li>';
}

async function saveBatch() {
  const f = $('#form-batch');
  const isNew = !state.editingBatch;
  try {
    const r = await api('saveBatch', {
      mode: isNew ? 'create' : 'update', id: f.id.value, carrier: f.carrier.value,
      status: f.status.value, note: f.note.value, syncAll: f.syncAll.checked,
    });
    await loadAdmin();
    render();
    toast(`${isNew ? '已新增' : '已更新'} ${r.id}${r.updated ? `，同步更新 ${r.updated} 筆貨件` : ''}`, 'ok');
    $('#dlg-batch').close();
  } catch (e) { fail(e); }
}

/* ------------------------------------------------------------------ */
/* 貨件（管理者）                                                       */
/* ------------------------------------------------------------------ */

function itemRows() {
  return state.items
    .filter(s => inView(state.itemsView, s.status) && (!state.itemsStatus || s.status === state.itemsStatus) &&
      match(state.itemsQ, s.id, s.product, s.batch, s.note, s.emails.join(' '), s.emails.map(custName).join(' ')))
    .sort(byUpdated);
}

function renderItems() {
  const el = $('#tab-items');
  const rows = itemRows();
  // 只保留目前看得到的勾選
  const visible = new Set(rows.map(r => r.id));
  [...state.selected].forEach(id => visible.has(id) || state.selected.delete(id));
  const n = state.selected.size;
  const allChecked = rows.length && rows.every(r => state.selected.has(r.id));

  const toolbar = `
    ${viewSeg('itemsView', state.items)}
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋商品、編號、物流編號、Email" data-model="itemsQ" value="${esc(state.itemsQ)}">
      ${statusFilter('itemsStatus', state.items, state.itemsView)}
      <button class="btn" data-action="refresh" title="重新整理">↻</button>
      <button class="btn primary" data-action="new-item">＋ 新增貨件</button>
    </div>
    <div class="bulkbar" ${n ? '' : 'hidden'}>
      <span>已選取 ${n} 筆</span>
      <button class="btn sm primary" data-action="open-bulk">批次更新狀態</button>
      <button class="btn sm danger" data-action="bulk-delete-items">批次刪除</button>
      <button class="btn sm ghost" data-action="clear-sel">取消選取</button>
    </div>`;

  const table = rows.length ? `
    <table class="table">
      <thead><tr>
        <th class="chk"><input type="checkbox" data-action="check-all" ${allChecked ? 'checked' : ''} aria-label="全選"></th>
        <th>商品</th><th>貨件編號</th><th>物流單</th><th>客人</th><th>狀態</th><th>最後更新</th>
      </tr></thead>
      <tbody>${rows.map(s => `
        <tr data-action="edit-item" data-id="${esc(s.id)}" class="${state.selected.has(s.id) ? 'sel' : ''}">
          <td class="chk"><input type="checkbox" data-action="check" data-id="${esc(s.id)}" ${state.selected.has(s.id) ? 'checked' : ''} aria-label="選取 ${esc(s.id)}"></td>
          <td class="product-cell" data-label="商品"><strong>${esc(s.product)}</strong> ${qtyTag(s.qty)}</td>
          <td class="ship-id" data-label="編號">${esc(s.id)}</td>
          <td class="ship-id small" data-label="物流單">${esc(s.batch) || '<span class="muted">—</span>'}</td>
          <td data-label="客人" class="email-cell" title="${esc(s.emails.map(e => custName(e) ? custName(e) + ' ' + e : e).join('\n'))}">${s.emails.length ? esc(custShort(s.emails[0])) + (s.emails.length > 1 ? ` +${s.emails.length - 1}` : '') + (s.pending && s.pending.length ? ' <span class="pending-dot" title="有客人尚未登入過">●</span>' : '') : '<span class="muted">未綁定</span>'}</td>
          <td data-label="狀態">${badge(s.status)}</td>
          <td data-label="更新" class="muted nowrap" title="${esc(s.updatedBy)}">${esc(fmtTime(s.updatedAt))}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : !state.loaded.items ? LOADING
      : `<div class="empty"><p>${!state.items.length ? '還沒有貨件，點「新增貨件」開始'
          : state.itemsView === 'done' && !state.itemsQ ? '還沒有已完成的貨件' : '沒有符合條件的貨件'}</p></div>`;

  keepFocus(el, () => (el.innerHTML = toolbar + table));
}

function setStatus(sel, value) {
  if (value && !state.statuses.includes(value) && ![...sel.options].some(o => o.value === value)) {
    sel.insertAdjacentHTML('beforeend', `<option>${esc(value)}</option>`);
  }
  sel.value = value || state.statuses[0];
}

function fillBatchSelect(sel) {
  sel.innerHTML = '<option value="">— 未指定 —</option>' + [...state.batches].sort(byUpdated)
    .map(b => `<option value="${esc(b.id)}">${esc(b.id)}${b.carrier ? '・' + esc(b.carrier) : ''}（${esc(b.status)}）</option>`).join('');
}

function openItem(id, preset = {}) {
  const dlg = $('#dlg-item');
  const f = $('#form-item');
  const s = id ? state.items.find(x => x.id === id) : null;
  state.editingItem = s ? s.id : null;
  f.reset();
  fillBatchSelect(f.batch);
  $('#item-title').textContent = s ? '編輯貨件' : '新增貨件';
  f.product.value = s ? s.product : '';
  f.qty.value = s ? s.qty : 1;
  f.batch.value = s ? s.batch : (preset.batch || '');
  f.id.value = s ? s.id : '';
  f.id.readOnly = !!s;
  const batch = state.batches.find(b => b.id === f.batch.value);
  setStatus(f.status, s ? s.status : (preset.status || (batch && batch.status)));
  f.note.value = s ? s.note : '';
  state.draftEmails = [];
  $('#cust-q').value = '';
  $('#new-cust').hidden = true;
  renderPicker(false);
  renderEmails();
  $('#item-extra').hidden = !s;
  $('#btn-delete-item').hidden = !s;
  $('#btn-save-next').hidden = !!s;
  if (s) loadHistory(s.id);
  if (!dlg.open) dlg.showModal();
  (s ? f.status : f.product).focus();
}

// 新增貨件時，選了物流單就帶入該物流單目前的狀態
$('#form-item').batch.addEventListener('change', e => {
  if (state.editingItem) return;
  const b = state.batches.find(x => x.id === e.target.value);
  if (b) setStatus($('#form-item').status, b.status);
});

const PENDING_TIP = '這個 Email 還沒登入過。客人用此 Gmail 登入後就會看到貨件；若客人說已登入卻看不到，請檢查 Email 是否打錯';
const PENDING_TAG = `<span class="pending" title="${PENDING_TIP}">尚未登入過</span>`;

/** 目前貨件已綁定（編輯）或預計綁定（新增）的客人 */
function boundEmails() {
  const s = state.items.find(x => x.id === state.editingItem);
  return s ? s.emails : state.draftEmails;
}

function renderEmails() {
  const s = state.items.find(x => x.id === state.editingItem);
  const emails = boundEmails();
  const pending = s ? (s.pending || []) : emails.filter(e => !(state.users.find(u => u.email === e) || {}).lastLogin);
  $('#item-emails').innerHTML = emails.length
    ? emails.map(e => `<span class="chip">${custName(e) ? `<b>${esc(custName(e))}</b>` : ''}<span class="chip-email">${esc(e)}</span>${pending.includes(e) ? PENDING_TAG : ''}<button type="button" data-action="remove-email" data-email="${esc(e)}" aria-label="移除 ${esc(e)}">✕</button></span>`).join('')
    : `<span class="muted">${s ? '尚未綁定任何客人' : '可先選好客人，儲存時一併綁定'}</span>`;
}

/* 客人下拉選單：可搜尋名稱或 Email */
let pickIdx = 0;

function pickerOptions() {
  const q = $('#cust-q').value.trim().toLowerCase();
  const taken = new Set(boundEmails());
  return state.users
    .filter(u => !taken.has(u.email) && (!q || [u.nickname, u.name, u.email].some(v => (v || '').toLowerCase().includes(q))))
    .sort((a, b) => (displayName(a) || '\uffff').localeCompare(displayName(b) || '\uffff', 'zh-Hant') || a.email.localeCompare(b.email))
    .slice(0, 50);
}

function renderPicker(open = true) {
  const ul = $('#cust-list'), q = $('#cust-q');
  q.setAttribute('aria-expanded', String(open));
  if (!open) { ul.hidden = true; return; }
  const opts = pickerOptions();
  const typed = q.value.trim();
  pickIdx = Math.max(0, Math.min(pickIdx, opts.length - 1));
  ul.innerHTML = opts.length
    ? opts.map((u, i) => `<li role="option" data-pick="${esc(u.email)}" class="${i === pickIdx ? 'active' : ''}">
        <span class="pick-name">${u.nickname ? esc(u.nickname) : `<span class="muted">${u.name ? esc(u.name) + '（未設定暱稱）' : '（未設定暱稱）'}</span>`}${u.role === 'admin' ? ' <span class="badge info">管理者</span>' : ''}</span>
        <span class="pick-email">${esc(u.email)}</span></li>`).join('')
    : isEmail(typed)
      ? `<li role="option" data-pick="${esc(typed)}" class="active"><span class="pick-name">＋ 綁定新客人</span><span class="pick-email">${esc(typed)}</span></li>`
      : `<li class="plain muted">${state.users.length ? '找不到符合的客人' : '還沒有客人'}，可用下方「＋ 新客戶」新增</li>`;
  ul.hidden = false;
  const active = ul.querySelector('.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

async function pickCustomer(email) {
  $('#cust-q').value = '';
  pickIdx = 0;
  if (!state.editingItem) {
    if (!state.draftEmails.includes(email)) state.draftEmails.push(email);
    renderEmails();
  } else {
    try {
      await api('bind', { id: state.editingItem, emails: [email] });
      await refreshEditingItem();
      toast(`已綁定 ${custShort(email)}`, 'ok');
    } catch (e) { fail(e); }
  }
  if (document.activeElement === $('#cust-q')) renderPicker();
}

const custQ = $('#cust-q');
custQ.addEventListener('focus', () => { pickIdx = 0; renderPicker(); });
custQ.addEventListener('input', () => { pickIdx = 0; renderPicker(); });
custQ.addEventListener('blur', () => setTimeout(() => renderPicker(false), 150));
custQ.addEventListener('keydown', e => {
  const items = $$('#cust-list [data-pick]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    pickIdx = (pickIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
    renderPicker();
  } else if (e.key === 'Enter') {
    e.preventDefault(); // 不要送出整個表單
    const li = $('#cust-list').hidden ? null : $('#cust-list .active[data-pick]');
    if (li) pickCustomer(li.dataset.pick);
  } else if (e.key === 'Escape' && !$('#cust-list').hidden) {
    e.preventDefault(); // 只關選單，不關整個視窗
    renderPicker(false);
  }
});
$('#cust-list').addEventListener('mousedown', e => {
  e.preventDefault(); // 保持輸入框焦點
  const li = e.target.closest('[data-pick]');
  if (li) pickCustomer(li.dataset.pick);
});
$$('#new-cust input').forEach(i => i.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('[data-action=create-cust]').click(); }
}));

async function loadHistory(id) {
  const ol = $('#item-history');
  ol.innerHTML = '<li class="muted">載入中…</li>';
  try {
    const h = await api('history', { id });
    if (state.editingItem !== id) return;
    ol.innerHTML = h.length ? h.map(x => `
      <li class="tone-${tone(x.status)}">
        <div>${badge(x.status)} <span class="muted">${esc(fmtTime(x.time))}</span></div>
        ${x.note ? `<div class="tl-note">${esc(x.note)}</div>` : ''}
        <div class="muted small">${esc(x.by)}</div>
      </li>`).join('') : '<li class="muted">沒有歷程紀錄</li>';
  } catch (e) { ol.innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
}

async function saveItem(next) {
  const f = $('#form-item');
  const isNew = !state.editingItem;
  const payload = {
    mode: isNew ? 'create' : 'update', id: f.id.value, product: f.product.value, qty: f.qty.value,
    batch: f.batch.value, status: f.status.value, note: f.note.value,
  };
  if (isNew) payload.emails = state.draftEmails;
  try {
    const { id } = await api('saveShipment', payload);
    await loadAdmin();
    render();
    refreshBatchDialog();
    toast(isNew ? `已新增 ${id}` : `已更新 ${id}`, 'ok');
    if (isNew && next) openItem(null, { batch: payload.batch, status: payload.status });
    else $('#dlg-item').close();
  } catch (e) { fail(e); }
}

async function refreshEditingItem() {
  await loadAdmin();
  renderEmails();
  render();
  refreshBatchDialog();
}

function refreshBatchDialog() {
  if ($('#dlg-batch').open && state.editingBatch) renderBatchItems();
}

/* ------------------------------------------------------------------ */
/* 商品 DM                                                             */
/* ------------------------------------------------------------------ */

const DM_TONES = { '現貨': 'ok', '預購': 'accent', '售罄': 'muted' };
const todayStr = () => new Date().toLocaleDateString('en-CA'); // 本機日期 yyyy-mm-dd
// 期限當天仍有效，隔天起才算逾期
const isExpired = d => !!d.deadline && d.deadline < todayStr();
const fmtPrice = p => p == null || p === '' ? '' : 'NT$ ' + Number(p).toLocaleString('zh-TW');
const safeImg = u => /^(https:\/\/|data:image\/|icons\/)/i.test(u || '') ? u : '';

function deadlineText(d) {
  if (!d.deadline) return '';
  const days = Math.round((Date.parse(d.deadline) - Date.parse(todayStr())) / 86400e3);
  const md = d.deadline.slice(5).replace('-', '/');
  if (days < 0) return `已截止（${md}）`;
  if (days === 0) return `今天截止（${md}）`;
  return `${md} 截止・剩 ${days} 天`;
}

function dmRows() {
  return state.dm
    .filter(d => (!state.dmStatus || d.status === state.dmStatus) && match(state.dmQ, d.name, d.status))
    .sort((a, b) => isExpired(a) - isExpired(b)
      // 未截止：期限近的在前、沒期限的在後；已截止：最近截止的在前
      || (isExpired(a) ? (b.deadline || '').localeCompare(a.deadline || '')
        : (a.deadline || '9999').localeCompare(b.deadline || '9999'))
      || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function renderDM() {
  const el = $('#tab-dm');
  const admin = state.user.role === 'admin';
  const rows = dmRows();
  const counts = {};
  state.dm.forEach(d => (counts[d.status] = (counts[d.status] || 0) + 1));
  const toolbar = `
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋商品" data-model="dmQ" value="${esc(state.dmQ)}">
      <select data-model="dmStatus" class="status-filter">
        <option value="">全部（${state.dm.length}）</option>
        ${Object.keys(DM_TONES).map(s => `<option value="${s}" ${s === state.dmStatus ? 'selected' : ''}>${s}（${counts[s] || 0}）</option>`).join('')}
      </select>
      <button class="btn" data-action="refresh" title="重新整理">↻</button>
      ${admin ? '<button class="btn primary" data-action="new-dm">＋ 新增 DM</button>' : ''}
    </div>`;
  const body = !state.loaded.dm ? LOADING
    : !rows.length ? `<div class="empty"><p>${state.dm.length ? '沒有符合條件的商品' : admin ? '還沒有 DM，點「新增 DM」上架第一個商品' : '目前沒有商品 DM'}</p></div>`
    : `<div class="dm-grid">${rows.map(d => {
        const img = safeImg(d.imageUrl);
        const expired = isExpired(d);
        return `
        <article class="card dm-card ${expired ? 'expired' : ''} ${d.status === '售罄' ? 'soldout' : ''}" data-action="${admin ? 'edit-dm' : 'view-dm'}" data-id="${esc(d.id)}" tabindex="0">
          <div class="dm-img">
            ${img ? `<img src="${esc(img)}" alt="${esc(d.name)}" loading="lazy" referrerpolicy="no-referrer" data-file="${esc(d.imageFileId || '')}">` : '<span class="dm-noimg">MAD DOG</span>'}
            <span class="badge ${DM_TONES[d.status] || 'muted'} dm-status">${esc(d.status)}</span>
            ${expired ? '<span class="dm-ribbon">已截止</span>' : ''}
          </div>
          <div class="dm-body">
            <h3 class="dm-name">${esc(d.name)}</h3>
            <div class="dm-meta">
              <span class="dm-price">${esc(fmtPrice(d.price))}</span>
              ${d.deadline ? `<span class="dm-deadline ${!expired && Date.parse(d.deadline) - Date.parse(todayStr()) <= 3 * 86400e3 ? 'soon' : ''}">${esc(deadlineText(d))}</span>` : ''}
            </div>
          </div>
        </article>`;
      }).join('')}</div>`;
  keepFocus(el, () => (el.innerHTML = toolbar + body));
}

// 雲端硬碟縮圖網址偶爾失效時，改用另一種網址再試一次
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.file || img.dataset.retried) return;
  img.dataset.retried = '1';
  img.src = `https://lh3.googleusercontent.com/d/${img.dataset.file}=w1200`;
}, true);

function openDMView(id) {
  const d = state.dm.find(x => x.id === id);
  if (!d) return;
  const img = safeImg(d.imageUrl);
  $('#dm-view-body').innerHTML = `
    ${img ? `<img class="dm-view-img ${isExpired(d) ? 'expired' : ''}" src="${esc(img)}" alt="${esc(d.name)}" referrerpolicy="no-referrer" data-file="${esc(d.imageFileId || '')}">` : ''}
    <h2>${esc(d.name)}</h2>
    <div class="dm-meta">
      <span class="badge ${DM_TONES[d.status] || 'muted'}">${esc(d.status)}</span>
      <span class="dm-price">${esc(fmtPrice(d.price))}</span>
    </div>
    ${d.deadline ? `<p class="muted">${esc(deadlineText(d))}</p>` : ''}`;
  $('#dlg-dm-view').showModal();
}

function setDMPreview(src) {
  $('#dm-preview').innerHTML = src
    ? `<img src="${esc(src)}" alt="預覽" referrerpolicy="no-referrer">`
    : '<span class="muted">尚未選擇圖片</span>';
}

function openDM(id) {
  const d = id ? state.dm.find(x => x.id === id) : null;
  const f = $('#form-dm');
  state.editingDM = d ? d.id : null;
  state.dmImage = null;
  f.reset();
  $('#dm-title').textContent = d ? '編輯 DM' : '新增 DM';
  f.name.value = d ? d.name : '';
  f.price.value = d && d.price != null ? d.price : '';
  f.dmStatus.value = d ? d.status : '現貨';
  f.deadline.value = d ? d.deadline || '' : '';
  f.imageUrl.value = d ? d.imageUrl || '' : '';
  // 雲端硬碟上傳的圖片不顯示網址，避免誤改
  f.imageUrl.hidden = !!(d && d.imageFileId);
  setDMPreview(d ? safeImg(d.imageUrl) : '');
  $('#btn-delete-dm').hidden = !d;
  $('#dlg-dm').showModal();
  if (!d) f.name.focus();
}

/** 把選擇的圖片縮小到最長邊 1200px 並轉成 JPEG，加快上傳 */
function compressImage(file, max = 1200, quality = 0.85) {
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000'; // 透明背景補黑色
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL('image/jpeg', quality);
      ok({ data: dataUrl.split(',')[1], mime: 'image/jpeg', preview: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error('無法讀取這張圖片')); };
    img.src = url;
  });
}

$('#dm-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    state.dmImage = await compressImage(file);
    setDMPreview(state.dmImage.preview);
    const f = $('#form-dm');
    f.imageUrl.value = '';
    f.imageUrl.hidden = true;
  } catch (err) { fail(err); }
});

$('#form-dm').imageUrl.addEventListener('input', e => {
  state.dmImage = null;
  setDMPreview(safeImg(e.target.value.trim()));
});

async function saveDM(btn) {
  const f = $('#form-dm');
  const isNew = !state.editingDM;
  const label = btn.textContent;
  if (state.dmImage) btn.textContent = '上傳中…';
  try {
    const d = state.dm.find(x => x.id === state.editingDM);
    let imageUrl = f.imageUrl.value.trim();
    // 網址欄被隱藏、又沒選新圖 → 沿用原本雲端硬碟上的圖片
    if (f.imageUrl.hidden && !state.dmImage && d && d.imageFileId) imageUrl = d.imageUrl;
    const payload = {
      mode: isNew ? 'create' : 'update', id: state.editingDM, name: f.name.value, price: f.price.value,
      status: f.dmStatus.value, deadline: f.deadline.value, imageUrl,
    };
    if (state.dmImage) payload.image = { data: state.dmImage.data, mime: state.dmImage.mime };
    await api('saveDM', payload);
    state.dm = await api('listDM');
    renderDM();
    toast(isNew ? '已新增 DM' : '已更新 DM', 'ok');
    $('#dlg-dm').close();
  } catch (e) { fail(e); }
  finally { btn.textContent = label; }
}

/* ------------------------------------------------------------------ */
/* 使用者管理                                                          */
/* ------------------------------------------------------------------ */

function renderUsers() {
  const el = $('#tab-users');
  const users = [...state.users].sort((a, b) => a.role !== b.role ? (a.role === 'admin' ? -1 : 1)
    : (displayName(a) || '\uffff').localeCompare(displayName(b) || '\uffff', 'zh-Hant') || a.email.localeCompare(b.email));
  const admins = users.filter(u => u.role === 'admin').length;
  el.innerHTML = `
    <div class="card add-admin">
      <h3>新增客戶／管理者</h3>
      <div class="input-row wrap">
        <input id="nu-name" placeholder="暱稱（方便你辨識）" autocomplete="off">
        <input id="nu-email" type="email" placeholder="Google 帳號 Email" autocomplete="off">
        <select id="nu-role"><option value="user">客戶</option><option value="admin">管理者</option></select>
        <button class="btn primary" data-action="add-user">新增</button>
      </div>
      <p class="muted small">對方不需要先登入過。暱稱只有管理者看得到，會顯示在貨件的客人下拉選單中，可隨時在下方表格修改；Google 名稱是對方登入時自動帶入的。目前共 ${admins} 位管理者。</p>
    </div>
    <div class="toolbar"><p class="muted grow">客人第一次用 Google 登入後也會自動出現在這裡。</p>
      <button class="btn" data-action="refresh" title="重新整理">↻</button></div>
    ${users.length ? `<table class="table users">
      <thead><tr><th>Email</th><th>暱稱（管理者用）</th><th>Google 名稱</th><th>角色</th><th>綁定數</th><th>最後登入</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr>
        <td data-label="Email" class="break">${esc(u.email)}</td>
        <td data-label="暱稱"><input class="inline-input" data-action="rename" data-email="${esc(u.email)}" value="${esc(u.nickname)}" placeholder="點此設定暱稱" aria-label="${esc(u.email)} 的暱稱"></td>
        <td data-label="Google 名稱">${esc(u.name) || `<span class="muted">${u.lastLogin ? '—' : '尚未登入'}</span>`}</td>
        <td data-label="角色"><select data-action="set-role" data-email="${esc(u.email)}" ${u.email === state.user.email ? 'disabled title="不能變更自己的角色"' : ''}>
          <option value="user" ${u.role !== 'admin' ? 'selected' : ''}>客戶</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></td>
        <td data-label="綁定數">${u.bound}</td>
        <td data-label="最後登入" class="muted nowrap">${u.lastLogin ? esc(fmtTime(u.lastLogin)) : '尚未登入'}</td>
        <td class="row-actions">${u.email === state.user.email ? '' : `<button class="btn sm danger ghost" data-action="delete-user" data-email="${esc(u.email)}">刪除</button>`}</td>
      </tr>`).join('')}</tbody></table>` : state.loaded.users ? '<div class="empty"><p>沒有使用者</p></div>' : LOADING}`;
}

async function renameUser(email, nickname) {
  try {
    await api('saveUser', { email, nickname });
    const u = state.users.find(x => x.email === email);
    if (u) u.nickname = nickname;
    toast('已更新暱稱', 'ok');
  } catch (err) { fail(err); renderUsers(); }
}

async function setRole(email, role) {
  try {
    await api('setRole', { email, role });
    toast(role === 'admin' ? `已將 ${email} 設為管理者` : '已更新角色', 'ok');
    state.users = await api('listUsers');
  } catch (err) { fail(err); }
  renderUsers();
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

// 重繪時保留搜尋框的焦點與游標位置
function keepFocus(container, paint) {
  const a = document.activeElement;
  const model = a && container.contains(a) && a.dataset.model;
  const pos = model && a.selectionStart;
  paint();
  if (model) {
    const n = container.querySelector(`[data-model="${model}"]`);
    if (n) { n.focus(); if (pos != null && n.setSelectionRange) n.setSelectionRange(pos, pos); }
  }
}

function closeDialogs() { $$('dialog[open]').forEach(d => d.close()); }

document.addEventListener('input', e => {
  const m = e.target.dataset.model;
  if (!m) return;
  state[m] = e.target.value;
  render();
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.action === 'set-role') setRole(t.dataset.email, t.value);
  if (t.dataset.action === 'rename') renameUser(t.dataset.email, t.value.trim());
});

document.addEventListener('click', async e => {
  const demo = e.target.closest('[data-demo]');
  if (demo) { Auth.set('demo:' + demo.dataset.demo); return enterApp(); }

  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return switchTab(tabBtn.dataset.tab);

  if (e.target.closest('[data-close]')) return e.target.closest('dialog').close();

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;

  switch (action) {
    case 'logout': return logout();
    case 'retry': return enterApp();
    case 'refresh': return switchTab(state.tab);

    // 使用者

    // 物流單
    case 'new-batch': return openBatch(null);
    case 'edit-batch':
      if (e.target.closest('.chk')) return;
      return openBatch(id);
    case 'check-batch':
      el.checked ? state.selectedBatches.add(id) : state.selectedBatches.delete(id);
      return renderBatches();
    case 'check-all-batch':
      if (el.checked) batchRows().forEach(r => state.selectedBatches.add(r.id)); else state.selectedBatches.clear();
      return renderBatches();
    case 'clear-sel-batch': state.selectedBatches.clear(); return renderBatches();
    case 'set-view': {
      const key = el.dataset.key;
      if (state[key] === el.dataset.val) return;
      state[key] = el.dataset.val;
      if (key === 'itemsView') { state.itemsStatus = ''; state.selected.clear(); }
      if (key === 'batchesView') { state.batchesStatus = ''; state.selectedBatches.clear(); }
      return render();
    }
    case 'bulk-delete-batches': {
      const ids = [...state.selectedBatches];
      const n = state.items.filter(i => ids.includes(i.batch)).length;
      if (!confirm(`確定要刪除 ${ids.length} 張物流單？${n ? `\n底下的 ${n} 筆貨件與客人綁定也會一併刪除。` : ''}\n歷程會保留，此動作無法復原。`)) return;
      try {
        const r = await api('bulkDeleteBatches', { ids });
        state.selectedBatches.clear();
        toast(`已刪除 ${r.batches} 張物流單${r.items ? `、${r.items} 筆貨件` : ''}`, 'ok');
        await loadAdmin(); render();
      } catch (err) { fail(err); }
      return;
    }
    case 'bulk-delete-items': {
      const ids = [...state.selected];
      if (!confirm(`確定要刪除 ${ids.length} 筆貨件？\n客人的綁定會一併移除，歷程會保留，此動作無法復原。`)) return;
      try {
        const r = await api('bulkDeleteShipments', { ids });
        state.selected.clear();
        toast(`已刪除 ${r.deleted} 筆貨件`, 'ok');
        await loadAdmin(); render(); refreshBatchDialog();
      } catch (err) { fail(err); }
      return;
    }
    case 'open-bulk-batch': {
      $('#form-bulk-batch').reset();
      const ids = [...state.selectedBatches];
      const items = state.items.filter(i => ids.includes(i.batch)).length;
      $('#bulk-batch-count').textContent = `將更新 ${ids.length} 張物流單（共 ${items} 筆貨件）`;
      return $('#dlg-bulk-batch').showModal();
    }
    case 'add-item-to-batch': {
      const b = state.batches.find(x => x.id === state.editingBatch);
      return openItem(null, { batch: state.editingBatch, status: b && b.status });
    }
    case 'delete-batch':
      if (!confirm(`確定要刪除物流單 ${state.editingBatch}？`)) return;
      try {
        await api('deleteBatch', { id: state.editingBatch });
        $('#dlg-batch').close();
        toast(`已刪除 ${state.editingBatch}`, 'ok');
        await loadAdmin(); render();
      } catch (err) { fail(err); }
      return;

    // 貨件
    case 'new-item': return openItem(null);
    case 'edit-item':
      if (e.target.closest('.chk')) return; // 點勾選框不開編輯
      return openItem(id);
    case 'check':
      el.checked ? state.selected.add(id) : state.selected.delete(id);
      return renderItems();
    case 'check-all': {
      const rows = itemRows();
      if (el.checked) rows.forEach(r => state.selected.add(r.id)); else state.selected.clear();
      return renderItems();
    }
    case 'clear-sel': state.selected.clear(); return renderItems();
    case 'open-bulk':
      $('#form-bulk').reset();
      $('#bulk-count').textContent = `將更新 ${state.selected.size} 筆貨件`;
      return $('#dlg-bulk').showModal();
    case 'remove-email':
      if (!state.editingItem) {
        state.draftEmails = state.draftEmails.filter(x => x !== el.dataset.email);
        return renderEmails();
      }
      try { await api('unbind', { id: state.editingItem, email: el.dataset.email }); await refreshEditingItem(); }
      catch (err) { fail(err); }
      return;
    case 'toggle-new-cust':
      $('#new-cust').hidden = !$('#new-cust').hidden;
      if (!$('#new-cust').hidden) $('#new-cust-name').focus();
      return;
    case 'create-cust': {
      const name = $('#new-cust-name').value.trim(), email = $('#new-cust-email').value.trim();
      if (!isEmail(email)) { toast('請輸入正確的 Gmail', 'error'); return $('#new-cust-email').focus(); }
      try {
        const r = await api('saveUser', { email, nickname: name });
        state.users = await api('listUsers');
        $('#new-cust-name').value = $('#new-cust-email').value = '';
        $('#new-cust').hidden = true;
        await pickCustomer(r.email);
      } catch (err) { fail(err); }
      return;
    }
    case 'delete-item':
      if (!confirm(`確定要刪除貨件 ${state.editingItem}？\n客人的綁定會一併移除，歷程會保留。`)) return;
      try {
        await api('deleteShipment', { id: state.editingItem });
        state.selected.delete(state.editingItem);
        $('#dlg-item').close();
        toast(`已刪除 ${state.editingItem}`, 'ok');
        await loadAdmin(); render(); refreshBatchDialog();
      } catch (err) { fail(err); }
      return;

    // 商品 DM
    case 'new-dm': return openDM(null);
    case 'edit-dm': return openDM(id);
    case 'view-dm': return openDMView(id);
    case 'dm-clear-image': {
      state.dmImage = null;
      const f = $('#form-dm');
      f.imageUrl.value = '';
      f.imageUrl.hidden = false;
      return setDMPreview('');
    }
    case 'delete-dm': {
      const d = state.dm.find(x => x.id === state.editingDM);
      if (!d || !confirm(`確定要刪除「${d.name}」？${d.imageFileId ? '\n圖片會移到雲端硬碟的垃圾桶。' : ''}`)) return;
      try {
        await api('deleteDM', { id: d.id });
        $('#dlg-dm').close();
        toast('已刪除 DM', 'ok');
        state.dm = await api('listDM'); renderDM();
      } catch (err) { fail(err); }
      return;
    }

    // 使用者管理
    case 'delete-user': {
      const u = userOf(el.dataset.email);
      const who = displayName(u) ? `${displayName(u)}（${u.email}）` : u.email;
      if (!confirm(`確定要刪除 ${who}？${u.bound ? `\n他的 ${u.bound} 筆貨件綁定也會一併移除。` : ''}`)) return;
      try {
        await api('deleteUser', { email: u.email });
        toast(`已刪除 ${displayName(u) || u.email}`, 'ok');
        state.users = await api('listUsers');
        if (state.loaded.items) state.items = await api('listShipments');
      } catch (err) { fail(err); }
      return renderUsers();
    }
    case 'add-user': {
      const name = $('#nu-name').value.trim(), email = $('#nu-email').value.trim(), role = $('#nu-role').value;
      if (!email) return $('#nu-email').focus();
      try {
        await api('saveUser', { email, nickname: name, role });
        toast(`已新增${role === 'admin' ? '管理者' : '客戶'} ${name || email}`, 'ok');
        state.users = await api('listUsers');
      } catch (err) { fail(err); }
      return renderUsers();
    }
  }
});

function onSubmit(form, handler) {
  $(form).addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter || $(form).querySelector('.btn.primary');
    btn.disabled = true;
    try { await handler(btn); } finally { btn.disabled = false; }
  });
}

onSubmit('#form-batch', saveBatch);
onSubmit('#form-dm', saveDM);
onSubmit('#form-item', btn => saveItem(btn.value === 'next'));

onSubmit('#form-bulk-batch', async () => {
  const f = $('#form-bulk-batch');
  try {
    const r = await api('bulkBatchStatus', { ids: [...state.selectedBatches], status: f.status.value, syncAll: f.syncAll.checked });
    $('#dlg-bulk-batch').close();
    state.selectedBatches.clear();
    toast(`已更新 ${r.batches} 張物流單，同步 ${r.items} 筆貨件`, 'ok');
    await loadAdmin(); render();
  } catch (e) { fail(e); }
});

onSubmit('#form-bulk', async () => {
  const f = $('#form-bulk');
  try {
    const r = await api('batchStatus', { ids: [...state.selected], status: f.status.value, note: f.note.value });
    $('#dlg-bulk').close();
    state.selected.clear();
    toast(`已更新 ${r.updated} 筆`, 'ok');
    await loadAdmin(); render();
  } catch (e) { fail(e); }
});

// 記住客人頁「已完成」區的展開狀態（toggle 事件不會冒泡，所以用捕獲）
document.addEventListener('toggle', e => {
  if (e.target.classList && e.target.classList.contains('done-section')) state.mineDoneOpen = e.target.open;
}, true);

// 點對話框外圍關閉
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

// 回到前景時自動更新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && Auth.token() && !$$('dialog[open]').length) switchTab(state.tab);
});
window.addEventListener('online', () => state.user && switchTab(state.tab));

/* ------------------------------------------------------------------ */
/* 啟動                                                                */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  // 已有舊版快取的使用者：新版接手後自動重新整理一次
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

document.title = cfg.APP_NAME || document.title;
if (Auth.token()) enterApp(); else showLogin();
