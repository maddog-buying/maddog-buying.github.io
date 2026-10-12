'use strict';

const cfg = window.APP_CONFIG || {};
const DEMO = !cfg.API_URL;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  user: null, statuses: [], tab: null,
  mine: [], all: [], users: [],
  selected: new Set(),
  mineQ: '', adminQ: '', adminStatus: '',
  editing: null, // 正在編輯的貨態編號（null = 新增）
  loaded: {},    // 各分頁是否已載入過資料
};

/* ------------------------------------------------------------------ */
/* 登入 token                                                          */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = 'st_token';
const CACHE_KEY = 'st_cache';
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
  Object.assign(state, { user: null, mine: [], all: [], users: [], loaded: {}, mineQ: '', adminQ: '', adminStatus: '' });
  $$('.tab').forEach(t => (t.innerHTML = ''));
  state.selected.clear();
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
    await switchTab(me.role === 'admin' ? 'admin' : 'mine');
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
  fillStatusSelects();
}

function fillStatusSelects() {
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
    if (tab === 'admin') state.all = await api('listShipments');
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

function render() {
  if (state.tab === 'mine') renderMine();
  if (state.tab === 'admin') renderAdmin();
  if (state.tab === 'users') renderUsers();
}

/* ------------------------------------------------------------------ */
/* 格式                                                                */
/* ------------------------------------------------------------------ */

const TONES = {
  '已送達': 'ok', '已完成': 'ok',
  '已出貨': 'info', '運送中': 'info', '配送中': 'info',
  '處理中': 'warn', '已收件': 'warn',
  '異常': 'bad',
  '已取消': 'muted', '已建立': 'muted',
};
const LOADING = '<div class="empty muted"><p>載入中…</p></div>';
const tone = s => TONES[s] || 'muted';
const badge = s => s ? `<span class="badge ${tone(s)}">${esc(s)}</span>` : `<span class="badge muted">查無資料</span>`;

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

/* ------------------------------------------------------------------ */
/* 我的貨態                                                            */
/* ------------------------------------------------------------------ */

function renderMine() {
  const el = $('#tab-mine');
  const list = state.mine
    .filter(s => match(state.mineQ, s.id, s.status, s.note))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const toolbar = `
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋編號或狀態" data-model="mineQ" value="${esc(state.mineQ)}">
      <button class="btn" data-action="refresh" title="重新整理">↻<span class="hide-sm"> 重新整理</span></button>
      <button class="btn primary" data-action="open-bind">＋ 綁定編號</button>
    </div>`;
  let body;
  if (!state.loaded.mine) {
    body = LOADING;
  } else if (!state.mine.length) {
    body = `<div class="empty"><p>尚未綁定任何貨態編號</p><p class="muted">請點選「綁定編號」，或請管理者協助綁定您的 Google 帳號。</p></div>`;
  } else if (!list.length) {
    body = `<div class="empty"><p>找不到符合「${esc(state.mineQ)}」的貨態</p></div>`;
  } else {
    body = `<div class="cards">${list.map(s => `
      <article class="card ship-card tone-${s.status ? tone(s.status) : 'muted'}">
        <div class="card-head">
          <span class="ship-id">${esc(s.id)}</span>
          <button class="icon-btn" data-action="unbind-mine" data-id="${esc(s.id)}" title="取消綁定" aria-label="取消綁定">✕</button>
        </div>
        <div class="ship-status">${badge(s.status)}</div>
        ${s.note ? `<p class="ship-note">${esc(s.note)}</p>` : ''}
        <p class="ship-time muted" title="${esc(fmtTime(s.updatedAt))}">${s.updatedAt ? '更新於 ' + esc(relTime(s.updatedAt)) : '此編號已不存在'}</p>
      </article>`).join('')}</div>`;
  }
  keepFocus(el, () => (el.innerHTML = toolbar + body));
}

/* ------------------------------------------------------------------ */
/* 貨態管理                                                            */
/* ------------------------------------------------------------------ */

function adminRows() {
  return state.all
    .filter(s => (!state.adminStatus || s.status === state.adminStatus) && match(state.adminQ, s.id, s.note, s.emails.join(' ')))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function renderAdmin() {
  const el = $('#tab-admin');
  const rows = adminRows();
  // 只保留目前看得到的勾選
  const visible = new Set(rows.map(r => r.id));
  [...state.selected].forEach(id => visible.has(id) || state.selected.delete(id));
  const n = state.selected.size;
  const counts = {};
  state.all.forEach(s => (counts[s.status] = (counts[s.status] || 0) + 1));
  const allChecked = rows.length && rows.every(r => state.selected.has(r.id));

  const toolbar = `
    <div class="toolbar">
      <input type="search" class="search" placeholder="搜尋編號、備註、Email" data-model="adminQ" value="${esc(state.adminQ)}">
      <select data-model="adminStatus" class="status-filter">
        <option value="">全部狀態（${state.all.length}）</option>
        ${state.statuses.map(s => `<option value="${esc(s)}" ${s === state.adminStatus ? 'selected' : ''}>${esc(s)}（${counts[s] || 0}）</option>`).join('')}
      </select>
      <button class="btn" data-action="refresh" title="重新整理">↻</button>
      <button class="btn primary" data-action="new-ship">＋ 新增貨態</button>
    </div>
    <div class="bulkbar" ${n ? '' : 'hidden'}>
      <span>已選取 ${n} 筆</span>
      <button class="btn sm primary" data-action="open-batch">批次更新狀態</button>
      <button class="btn sm ghost" data-action="clear-sel">取消選取</button>
    </div>`;

  const table = rows.length ? `
    <table class="table">
      <thead><tr>
        <th class="chk"><input type="checkbox" data-action="check-all" ${allChecked ? 'checked' : ''} aria-label="全選"></th>
        <th>貨態編號</th><th>狀態</th><th>備註</th><th>綁定</th><th>最後更新</th>
      </tr></thead>
      <tbody>${rows.map(s => `
        <tr data-action="edit-ship" data-id="${esc(s.id)}" class="${state.selected.has(s.id) ? 'sel' : ''}">
          <td class="chk"><input type="checkbox" data-action="check" data-id="${esc(s.id)}" ${state.selected.has(s.id) ? 'checked' : ''} aria-label="選取 ${esc(s.id)}"></td>
          <td class="ship-id" data-label="編號">${esc(s.id)}</td>
          <td data-label="狀態">${badge(s.status)}</td>
          <td class="note-cell" data-label="備註">${esc(s.note) || '<span class="muted">—</span>'}</td>
          <td data-label="綁定" title="${esc(s.emails.join('\n'))}">${s.emails.length ? s.emails.length + ' 人' : '<span class="muted">未綁定</span>'}</td>
          <td data-label="更新" class="muted nowrap" title="${esc(s.updatedBy)}">${esc(fmtTime(s.updatedAt))}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : !state.loaded.admin ? LOADING : `<div class="empty"><p>${state.all.length ? '沒有符合條件的貨態' : '還沒有任何貨態，點「新增貨態」開始'}</p></div>`;

  keepFocus(el, () => (el.innerHTML = toolbar + table));
}

function openShip(id) {
  const dlg = $('#dlg-ship');
  const f = $('#form-ship');
  const s = id ? state.all.find(x => x.id === id) : null;
  state.editing = s ? s.id : null;
  f.reset();
  $('#ship-title').textContent = s ? '編輯貨態' : '新增貨態';
  f.id.value = s ? s.id : '';
  f.id.readOnly = !!s;
  f.status.value = s ? s.status : state.statuses[0];
  if (s && !state.statuses.includes(s.status)) {
    f.status.insertAdjacentHTML('beforeend', `<option>${esc(s.status)}</option>`);
    f.status.value = s.status;
  }
  f.note.value = s ? s.note : '';
  f.bindCode.value = s ? s.bindCode : genCode();
  $('#ship-extra').hidden = !s;
  $('#btn-delete').hidden = !s;
  if (s) { renderEmails(s); loadHistory(s.id); }
  if (!dlg.open) dlg.showModal();
  (s ? f.status : f.id).focus();
}

function renderEmails(s) {
  $('#ship-emails').innerHTML = s.emails.length
    ? s.emails.map(e => `<span class="chip">${esc(e)}<button type="button" data-action="remove-email" data-email="${esc(e)}" aria-label="移除 ${esc(e)}">✕</button></span>`).join('')
    : '<span class="muted">尚未綁定任何帳號</span>';
}

async function loadHistory(id) {
  const ol = $('#ship-history');
  ol.innerHTML = '<li class="muted">載入中…</li>';
  try {
    const h = await api('history', { id });
    if (state.editing !== id) return;
    ol.innerHTML = h.length ? h.map(x => `
      <li class="tone-${tone(x.status)}">
        <div>${badge(x.status)} <span class="muted">${esc(fmtTime(x.time))}</span></div>
        ${x.note ? `<div class="tl-note">${esc(x.note)}</div>` : ''}
        <div class="muted small">${esc(x.by)}</div>
      </li>`).join('') : '<li class="muted">沒有歷程紀錄</li>';
  } catch (e) { ol.innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
}

async function saveShip() {
  const f = $('#form-ship');
  const isNew = !state.editing;
  const payload = { mode: isNew ? 'create' : 'update', id: f.id.value, status: f.status.value, note: f.note.value, bindCode: f.bindCode.value };
  try {
    const { id } = await api('saveShipment', payload);
    state.all = await api('listShipments');
    render();
    toast(isNew ? `已新增 ${id}` : `已更新 ${id}`, 'ok');
    if (isNew) openShip(id); // 新增後切到編輯模式，方便綁定帳號
    else $('#dlg-ship').close();
  } catch (e) { fail(e); }
}

async function refreshEditing() {
  state.all = await api('listShipments');
  const s = state.all.find(x => x.id === state.editing);
  if (s) renderEmails(s);
  render();
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
  el.innerHTML = `
    <div class="toolbar"><p class="muted grow">使用者第一次以 Google 登入後會自動出現在這裡。管理者也可以先在貨態中綁定尚未登入過的 Email。</p>
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
        <td data-label="最後登入" class="muted nowrap">${esc(fmtTime(u.lastLogin))}</td>
      </tr>`).join('')}</tbody></table>` : state.loaded.users ? '<div class="empty"><p>沒有使用者</p></div>' : LOADING}`;
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

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.action === 'set-role') {
    try {
      await api('setRole', { email: t.dataset.email, role: t.value });
      toast('已更新角色', 'ok');
      state.users = await api('listUsers');
    } catch (err) { fail(err); }
    renderUsers();
  }
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

    case 'open-bind': $('#form-bind').reset(); return $('#dlg-bind').showModal();
    case 'unbind-mine':
      if (!confirm(`確定要取消綁定 ${id}？`)) return;
      try { await api('unbindMine', { id }); state.mine = state.mine.filter(s => s.id !== id); renderMine(); toast('已取消綁定', 'ok'); }
      catch (err) { fail(err); }
      return;

    case 'new-ship': return openShip(null);
    case 'edit-ship':
      if (e.target.closest('.chk')) return; // 點勾選框不開編輯
      return openShip(id);
    case 'check':
      el.checked ? state.selected.add(id) : state.selected.delete(id);
      return renderAdmin();
    case 'check-all': {
      const rows = adminRows();
      if (el.checked) rows.forEach(r => state.selected.add(r.id)); else state.selected.clear();
      return renderAdmin();
    }
    case 'clear-sel': state.selected.clear(); return renderAdmin();
    case 'open-batch':
      $('#form-batch').reset();
      $('#batch-count').textContent = `將更新 ${state.selected.size} 筆貨態`;
      return $('#dlg-batch').showModal();

    case 'gen-code': $('#form-ship').bindCode.value = genCode(); return;
    case 'add-email': return addEmails();
    case 'remove-email':
      try { await api('unbind', { id: state.editing, email: el.dataset.email }); await refreshEditing(); }
      catch (err) { fail(err); }
      return;
    case 'delete-ship':
      if (!confirm(`確定要刪除 ${state.editing}？\n綁定關係會一併移除，歷程會保留。`)) return;
      try {
        await api('deleteShipment', { id: state.editing });
        state.selected.delete(state.editing);
        $('#dlg-ship').close();
        toast(`已刪除 ${state.editing}`, 'ok');
        state.all = await api('listShipments'); render();
      } catch (err) { fail(err); }
      return;
  }
});

async function addEmails() {
  const input = $('#bind-email');
  const emails = input.value.split(/[,，;\s]+/).filter(Boolean);
  if (!emails.length) return input.focus();
  try {
    await api('bind', { id: state.editing, emails });
    input.value = '';
    await refreshEditing();
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
    try { await handler(); } finally { btn.disabled = false; }
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

onSubmit('#form-ship', saveShip);

onSubmit('#form-batch', async () => {
  const f = $('#form-batch');
  try {
    const r = await api('batchStatus', { ids: [...state.selected], status: f.status.value, note: f.note.value });
    $('#dlg-batch').close();
    state.selected.clear();
    toast(`已更新 ${r.updated} 筆`, 'ok');
    state.all = await api('listShipments'); render();
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
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.title = cfg.APP_NAME || document.title;
if (Auth.token()) enterApp(); else showLogin();
