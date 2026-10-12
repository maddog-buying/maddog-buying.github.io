// 示範模式用的假後端：與 backend/Code.gs 的 API 行為一致，資料存在 localStorage。
window.MockApi = (() => {
  const KEY = 'st_demo_db';
  const STATUSES = ['已建立', '已收件', '處理中', '已出貨', '運送中', '配送中', '已送達', '異常', '已取消'];
  const ago = h => new Date(Date.now() - h * 3600e3).toISOString();

  function seed() {
    const s = (id, status, note, h, bindCode = '') =>
      ({ id, status, note, bindCode, updatedAt: ago(h), updatedBy: 'admin@demo.local', createdAt: ago(h + 48) });
    const db = {
      shipments: [
        s('SH20261001', '已送達', '已由管理室代收', 30, '1234'),
        s('SH20261005', '運送中', '預計明日抵達', 3, '5678'),
        s('SH20261008', '處理中', '', 1, '2468'),
        s('SH20261010', '異常', '地址不完整，請聯繫客服', 6, '1357'),
        s('SH20261011', '已建立', '', 0.2, '9999'),
      ],
      history: [],
      bindings: [
        { id: 'SH20261001', email: 'user@demo.local', boundAt: ago(70), boundBy: 'admin@demo.local' },
        { id: 'SH20261005', email: 'user@demo.local', boundAt: ago(40), boundBy: 'admin@demo.local' },
        { id: 'SH20261010', email: 'user@demo.local', boundAt: ago(20), boundBy: 'admin@demo.local' },
      ],
      users: [
        { email: 'admin@demo.local', name: '示範管理者', role: 'admin', createdAt: ago(200), lastLogin: ago(1) },
        { email: 'user@demo.local', name: '示範使用者', role: 'user', createdAt: ago(100), lastLogin: ago(2) },
      ],
    };
    const flow = { '已送達': ['已建立', '已收件', '已出貨', '運送中', '已送達'], '運送中': ['已建立', '已出貨', '運送中'],
      '處理中': ['已建立', '處理中'], '異常': ['已建立', '已出貨', '異常'], '已建立': ['已建立'] };
    db.shipments.forEach(sh => {
      const steps = flow[sh.status];
      steps.forEach((st, i) => db.history.push({
        time: ago(sh.updatedAt ? (steps.length - 1 - i) * 8 + (Date.now() - Date.parse(sh.updatedAt)) / 3600e3 : 0),
        id: sh.id, status: st, note: i === steps.length - 1 ? sh.note : '', by: 'admin@demo.local' }));
    });
    return db;
  }

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { return seed(); } };
  const save = db => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const err = (code, msg) => Object.assign(new Error(msg), { code });
  const normId = v => String(v || '').trim().toUpperCase();
  const uniq = a => [...new Set(a)];
  const now = () => new Date().toISOString();

  const routes = {
    me: (p, u, db) => ({ ...u, statuses: STATUSES }),
    myShipments: (p, u, db) => uniq(db.bindings.filter(b => b.email === u.email).map(b => b.id)).map(id => {
      const s = db.shipments.find(x => x.id === id);
      return s ? { id, status: s.status, note: s.note, updatedAt: s.updatedAt } : { id, status: null, note: '', updatedAt: null };
    }),
    bindByCode: (p, u, db) => {
      const id = normId(p.id); const s = db.shipments.find(x => x.id === id);
      if (!s || !s.bindCode || s.bindCode !== String(p.code || '').trim()) throw err(400, '貨態編號或綁定碼錯誤');
      if (!db.bindings.some(b => b.id === id && b.email === u.email)) db.bindings.push({ id, email: u.email, boundAt: now(), boundBy: u.email });
      return { id };
    },
    unbindMine: (p, u, db) => { db.bindings = db.bindings.filter(b => !(b.id === normId(p.id) && b.email === u.email)); return true; },
    listShipments: (p, u, db) => db.shipments.map(s => ({ ...s, emails: uniq(db.bindings.filter(b => b.id === s.id).map(b => b.email)) })),
    saveShipment: (p, u, db) => {
      const id = normId(p.id); if (!id) throw err(400, '請輸入貨態編號');
      const status = String(p.status || '').trim(); if (!status) throw err(400, '請選擇狀態');
      const note = String(p.note || '').trim(), bindCode = String(p.bindCode || '').trim(), t = now();
      const ex = db.shipments.find(s => s.id === id);
      if (p.mode === 'create') {
        if (ex) throw err(409, '貨態編號已存在：' + id);
        db.shipments.push({ id, status, note, bindCode, updatedAt: t, updatedBy: u.email, createdAt: t });
        db.history.push({ time: t, id, status, note, by: u.email });
      } else {
        if (!ex) throw err(404, '找不到貨態編號：' + id);
        const changed = ex.status !== status || ex.note !== note;
        Object.assign(ex, { bindCode }, changed ? { status, note, updatedAt: t, updatedBy: u.email } : {});
        if (changed) db.history.push({ time: t, id, status, note, by: u.email });
      }
      return { id };
    },
    batchStatus: (p, u, db) => {
      const ids = new Set((p.ids || []).map(normId)), t = now();
      if (!ids.size || !p.status) throw err(400, '請選擇貨態與狀態');
      const rows = db.shipments.filter(s => ids.has(s.id));
      rows.forEach(s => { Object.assign(s, { status: p.status, note: p.note || '', updatedAt: t, updatedBy: u.email });
        db.history.push({ time: t, id: s.id, status: p.status, note: p.note || '', by: u.email }); });
      return { updated: rows.length };
    },
    deleteShipment: (p, u, db) => {
      const id = normId(p.id);
      db.shipments = db.shipments.filter(s => s.id !== id);
      db.bindings = db.bindings.filter(b => b.id !== id);
      db.history.push({ time: now(), id, status: '（已刪除）', note: '', by: u.email });
      return true;
    },
    history: (p, u, db) => db.history.filter(h => h.id === normId(p.id)).sort((a, b) => b.time.localeCompare(a.time)),
    bind: (p, u, db) => {
      const id = normId(p.id);
      if (!db.shipments.some(s => s.id === id)) throw err(404, '找不到貨態編號：' + id);
      const emails = uniq((p.emails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
      const bad = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad.length) throw err(400, 'Email 格式錯誤：' + bad.join(', '));
      emails.forEach(email => { if (!db.bindings.some(b => b.id === id && b.email === email))
        db.bindings.push({ id, email, boundAt: now(), boundBy: u.email }); });
      return true;
    },
    unbind: (p, u, db) => { db.bindings = db.bindings.filter(b => !(b.id === normId(p.id) && b.email === String(p.email).toLowerCase())); return true; },
    listUsers: (p, u, db) => db.users.map(x => ({ ...x, bound: db.bindings.filter(b => b.email === x.email).length })),
    setRole: (p, u, db) => {
      const email = String(p.email || '').toLowerCase(), role = p.role === 'admin' ? 'admin' : 'user';
      if (email === u.email && role !== 'admin') throw err(400, '不能移除自己的管理者權限');
      const x = db.users.find(y => y.email === email);
      if (x) x.role = role; else db.users.push({ email, name: '', role, createdAt: now(), lastLogin: '' });
      return true;
    },
  };
  const ADMIN_ONLY = ['listShipments', 'saveShipment', 'batchStatus', 'deleteShipment', 'history', 'bind', 'unbind', 'listUsers', 'setRole'];

  async function handle({ action, payload, idToken }) {
    await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
    try {
      const email = String(idToken || '').replace(/^demo:/, '');
      if (!email) throw err(401, '請先登入');
      const db = load();
      let user = db.users.find(x => x.email === email);
      if (!user) { user = { email, name: '', role: 'user', createdAt: now(), lastLogin: now() }; db.users.push(user); }
      if (!routes[action]) throw err(400, '未知的操作：' + action);
      if (ADMIN_ONLY.includes(action) && user.role !== 'admin') throw err(403, '需要管理者權限');
      const data = routes[action](payload || {}, { email: user.email, name: user.name, role: user.role }, db);
      save(db);
      return { ok: true, data: JSON.parse(JSON.stringify(data)) };
    } catch (e) {
      return { ok: false, code: e.code || 500, error: e.message };
    }
  }

  return { handle, reset: () => localStorage.removeItem(KEY) };
})();
