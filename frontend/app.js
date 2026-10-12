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
  selected: new Set(),
  // 搜尋與篩選（對應 data-model）
  mineQ: '', itemsQ: '', itemsStatus: '', batchesQ: '', batchesStatus: '',
  editingItem: null,  // 正在編輯的貨件編號（null = 新增）
  editingBatch: null, // 正在編輯的物流編號（null = 新增）
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
    google.accounts.id.renderButton(box, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'zh-TW', width: 280 });
    google.accounts.id.prompt();
  }).catch(e => (box.textContent = e.message));
}

function logout() {
  Auth.clear();
  store.del(CACHE_KEY);
  if (!DEMO && window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  Object.assign(state, { user: null, mine: [], items: [], batches: [], users: [], loaded: {},
    mineQ: '', itemsQ: '', itemsStatus: '', batchesQ: '', batchesStatus: '' });
  state.selected.clear();
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
  $('#tabs').hidden = u.role !== 'admin';
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
  [state.items, state.batches] = await Promise.all([api('listShipments'), api('listBatches')]);
  state.loaded.items = state.loaded.batches = true;
  const carriers = [...new Set(state.batches.map(b => b.carrier).filter(Boolean))];
  $('#carrier-list').innerHTML = carriers.map(c => `<option value="${esc(c)}">`).join('');
}

function render() {
  if (state.tab === 'mine') renderMine();
  if (state.tab === 'batches') renderBatches();
  if (state.tab === 'items') renderItems();
  if (state.tab === 'users') renderUsers();
}

/* ------------------------------------------------------------------ */
/* 格式                                                                */
/* ------------------------------------------------------------------ */

const TONES = { '清關中': 'warn', '抵達瘋狗窩': 'accent', '瘋狗窩已寄出': 'accent', '完成': 'ok' };
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
const splitEmails = s => String(s || '').split(/[,，;\s]+/).filter(Boolean);

function statusFilter(model, list) {
  const counts = {};
  list.forEach(x => (counts[x.status] = (counts[x.status] || 0) + 1));
  return `<select data-model="${model}" class="status-filter">
    <option value="">全部狀態（${list.length}）</option>
    ${state.statuses.map(s => `<option value="${esc(s)}" ${s === state[model] ? 'selected' : ''}>${esc(s)}（${counts[s] || 0}）</option>`).join('')}
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
  const list = state.mine.filter(s => match(state.mineQ, s.id, s.product, s.status, s.note)).sort(byUpdated);
  const toolbar = `
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋商品、編號或狀態" data-model="mineQ" value="${esc(state.mineQ)}">
      <button class="btn" data-action="refresh" title="重新整理">↻<span class="hide-sm"> 重新整理</span></button>
      <button class="btn primary" data-action="open-bind">＋ 綁定貨件</button>
    </div>`;
  let body;
  if (!state.loaded.mine) {
    body = LOADING;
  } else if (!state.mine.length) {
    body = `<div class="empty"><p>尚未綁定任何貨件</p><p class="muted">請點選「綁定貨件」，或請管理者協助綁定您的 Google 帳號。</p></div>`;
  } else if (!list.length) {
    body = `<div class="empty"><p>找不到符合「${esc(state.mineQ)}」的貨件</p></div>`;
  } else {
    body = `<div class="cards">${list.map(s => `
      <article class="card ship-card tone-${s.status ? tone(s.status) : 'muted'}">
        <div class="card-head">
          <h3 class="product">${esc(s.product) || '<span class="muted">（此貨件已不存在）</span>'} ${qtyTag(s.qty)}</h3>
          <button class="icon-btn" data-action="unbind-mine" data-id="${esc(s.id)}" title="取消綁定" aria-label="取消綁定">✕</button>
        </div>
        <div class="ship-id muted">${esc(s.id)}</div>
        <div class="ship-status">${badge(s.status)}</div>
        ${steps(s.status)}
        ${s.note ? `<p class="ship-note">${esc(s.note)}</p>` : ''}
        ${s.updatedAt ? `<p class="ship-time muted" title="${esc(fmtTime(s.updatedAt))}">更新於 ${esc(relTime(s.updatedAt))}</p>` : ''}
      </article>`).join('')}</div>`;
  }
  keepFocus(el, () => (el.innerHTML = toolbar + body));
}

/* ------------------------------------------------------------------ */
/* 物流單（管理者）                                                     */
/* ------------------------------------------------------------------ */

function renderBatches() {
  const el = $('#tab-batches');
  const rows = state.batches
    .filter(b => (!state.batchesStatus || b.status === state.batchesStatus) && match(state.batchesQ, b.id, b.carrier, b.note))
    .sort(byUpdated);
  const toolbar = `
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋物流編號、上游、備註" data-model="batchesQ" value="${esc(state.batchesQ)}">
      ${statusFilter('batchesStatus', state.batches)}
      <button class="btn" data-action="refresh" title="重新整理">↻</button>
      <button class="btn primary" data-action="new-batch">＋ 新增物流單</button>
    </div>`;
  const table = rows.length ? `
    <table class="table">
      <thead><tr><th>物流編號</th><th>上游</th><th>狀態</th><th>貨件</th><th>內部備註</th><th>最後更新</th></tr></thead>
      <tbody>${rows.map(b => `
        <tr data-action="edit-batch" data-id="${esc(b.id)}">
          <td class="ship-id" data-label="物流編號">${esc(b.id)}</td>
          <td data-label="上游">${esc(b.carrier) || '<span class="muted">—</span>'}</td>
          <td data-label="狀態">${badge(b.status)}</td>
          <td data-label="貨件">${b.itemCount ? b.itemCount + ' 筆' : '<span class="muted">0</span>'}</td>
          <td class="note-cell" data-label="備註">${esc(b.note) || '<span class="muted">—</span>'}</td>
          <td data-label="更新" class="muted nowrap" title="${esc(b.updatedBy)}">${esc(fmtTime(b.updatedAt))}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : !state.loaded.batches ? LOADING
      : `<div class="empty"><p>${state.batches.length ? '沒有符合條件的物流單' : '還沒有物流單，點「新增物流單」輸入上游的物流編號'}</p></div>`;
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
        <div class="muted small">${esc(i.id)}・${esc(i.emails.join(', ') || '未綁定客人')}</div>
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
    if (isNew) openBatch(r.id); // 切到編輯模式，方便接著加入貨件
    else $('#dlg-batch').close();
  } catch (e) { fail(e); }
}

/* ------------------------------------------------------------------ */
/* 貨件（管理者）                                                       */
/* ------------------------------------------------------------------ */

function itemRows() {
  return state.items
    .filter(s => (!state.itemsStatus || s.status === state.itemsStatus) &&
      match(state.itemsQ, s.id, s.product, s.batch, s.note, s.emails.join(' ')))
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
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋商品、編號、物流編號、Email" data-model="itemsQ" value="${esc(state.itemsQ)}">
      ${statusFilter('itemsStatus', state.items)}
      <button class="btn" data-action="refresh" title="重新整理">↻</button>
      <button class="btn primary" data-action="new-item">＋ 新增貨件</button>
    </div>
    <div class="bulkbar" ${n ? '' : 'hidden'}>
      <span>已選取 ${n} 筆</span>
      <button class="btn sm primary" data-action="open-bulk">批次更新狀態</button>
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
          <td data-label="客人" class="email-cell" title="${esc(s.emails.join('\n'))}">${s.emails.length ? esc(s.emails[0]) + (s.emails.length > 1 ? ` +${s.emails.length - 1}` : '') : '<span class="muted">未綁定</span>'}</td>
          <td data-label="狀態">${badge(s.status)}</td>
          <td data-label="更新" class="muted nowrap" title="${esc(s.updatedBy)}">${esc(fmtTime(s.updatedAt))}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : !state.loaded.items ? LOADING
      : `<div class="empty"><p>${state.items.length ? '沒有符合條件的貨件' : '還沒有貨件，點「新增貨件」開始'}</p></div>`;

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
  f.bindCode.value = s ? s.bindCode : genCode();
  $('#item-new-emails').hidden = !!s;
  $('#item-extra').hidden = !s;
  $('#btn-delete-item').hidden = !s;
  $('#btn-save-next').hidden = !!s;
  if (s) { renderEmails(s); loadHistory(s.id); }
  if (!dlg.open) dlg.showModal();
  (s ? f.status : f.product).focus();
}

// 新增貨件時，選了物流單就帶入該物流單目前的狀態
$('#form-item').batch.addEventListener('change', e => {
  if (state.editingItem) return;
  const b = state.batches.find(x => x.id === e.target.value);
  if (b) setStatus($('#form-item').status, b.status);
});

function renderEmails(s) {
  $('#item-emails').innerHTML = s.emails.length
    ? s.emails.map(e => `<span class="chip">${esc(e)}<button type="button" data-action="remove-email" data-email="${esc(e)}" aria-label="移除 ${esc(e)}">✕</button></span>`).join('')
    : '<span class="muted">尚未綁定任何客人</span>';
}

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
    batch: f.batch.value, status: f.status.value, note: f.note.value, bindCode: f.bindCode.value,
  };
  if (isNew) payload.emails = splitEmails(f.emails.value);
  try {
    const { id } = await api('saveShipment', payload);
    await loadAdmin();
    render();
    refreshBatchDialog();
    toast(isNew ? `已新增 ${id}` : `已更新 ${id}`, 'ok');
    if (isNew && next) openItem(null, { batch: payload.batch, status: payload.status });
    else if (isNew) openItem(id); // 切到編輯模式，可看歷程、管理綁定
    else $('#dlg-item').close();
  } catch (e) { fail(e); }
}

async function refreshEditingItem() {
  await loadAdmin();
  const s = state.items.find(x => x.id === state.editingItem);
  if (s) renderEmails(s);
  render();
  refreshBatchDialog();
}

function refreshBatchDialog() {
  if ($('#dlg-batch').open && state.editingBatch) renderBatchItems();
}

function genCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
}

/* ------------------------------------------------------------------ */
/* 使用者管理                                                          */
/* ------------------------------------------------------------------ */

function renderUsers() {
  const el = $('#tab-users');
  const users = [...state.users].sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1));
  const admins = users.filter(u => u.role === 'admin').length;
  el.innerHTML = `
    <div class="card add-admin">
      <h3>新增管理者</h3>
      <div class="input-row">
        <input id="admin-email" type="email" placeholder="對方的 Google 帳號 Email">
        <button class="btn primary" data-action="add-admin">設為管理者</button>
      </div>
      <p class="muted small">對方不需要先登入過。管理者可以查看與修改所有物流單、貨件，也可以新增其他管理者。目前共 ${admins} 位管理者。</p>
    </div>
    <div class="toolbar"><p class="muted grow">客人第一次用 Google 登入後，會自動出現在下方列表。</p>
      <button class="btn" data-action="refresh" title="重新整理">↻</button></div>
    ${users.length ? `<table class="table users">
      <thead><tr><th>Email</th><th>名稱</th><th>角色</th><th>綁定數</th><th>最後登入</th></tr></thead>
      <tbody>${users.map(u => `<tr>
        <td data-label="Email" class="break">${esc(u.email)}</td>
        <td data-label="名稱">${esc(u.name) || '<span class="muted">—</span>'}</td>
        <td data-label="角色"><select data-action="set-role" data-email="${esc(u.email)}" ${u.email === state.user.email ? 'disabled title="不能變更自己的角色"' : ''}>
          <option value="user" ${u.role !== 'admin' ? 'selected' : ''}>使用者</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></td>
        <td data-label="綁定數">${u.bound}</td>
        <td data-label="最後登入" class="muted nowrap">${u.lastLogin ? esc(fmtTime(u.lastLogin)) : '尚未登入'}</td>
      </tr>`).join('')}</tbody></table>` : state.loaded.users ? '<div class="empty"><p>沒有使用者</p></div>' : LOADING}`;
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
    case 'open-bind': $('#form-bind').reset(); return $('#dlg-bind').showModal();
    case 'unbind-mine':
      if (!confirm(`確定要取消綁定 ${id}？`)) return;
      try { await api('unbindMine', { id }); state.mine = state.mine.filter(s => s.id !== id); renderMine(); toast('已取消綁定', 'ok'); }
      catch (err) { fail(err); }
      return;

    // 物流單
    case 'new-batch': return openBatch(null);
    case 'edit-batch': return openBatch(id);
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
    case 'gen-code': $('#form-item').bindCode.value = genCode(); return;
    case 'add-email': return addEmails();
    case 'remove-email':
      try { await api('unbind', { id: state.editingItem, email: el.dataset.email }); await refreshEditingItem(); }
      catch (err) { fail(err); }
      return;
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

    // 使用者管理
    case 'add-admin': {
      const email = $('#admin-email').value.trim();
      if (!email) return $('#admin-email').focus();
      return setRole(email, 'admin');
    }
  }
});

async function addEmails() {
  const input = $('#bind-email');
  const emails = splitEmails(input.value);
  if (!emails.length) return input.focus();
  try {
    await api('bind', { id: state.editingItem, emails });
    input.value = '';
    await refreshEditingItem();
    toast('已綁定', 'ok');
  } catch (err) { fail(err); }
}

$('#bind-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addEmails(); }
});

function onSubmit(form, handler) {
  $(form).addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter || $(form).querySelector('.btn.primary');
    btn.disabled = true;
    try { await handler(btn); } finally { btn.disabled = false; }
  });
}

onSubmit('#form-bind', async () => {
  const f = $('#form-bind');
  try {
    const { id } = await api('bindByCode', { id: f.id.value, code: f.code.value });
    $('#dlg-bind').close();
    toast(`已綁定 ${id}`, 'ok');
    await loadMine(); renderMine();
  } catch (e) { fail(e); }
});

onSubmit('#form-batch', saveBatch);
onSubmit('#form-item', btn => saveItem(btn.value === 'next'));

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
