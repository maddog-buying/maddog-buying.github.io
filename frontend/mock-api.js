// 示範模式用的假後端：與 backend/Code.gs 的 API 行為一致，資料存在 localStorage。
window.MockApi = (() => {
  const KEY = 'st_demo_db_v2';
  const STATUSES = ['倉庫出倉', '抵達中國港口', '船班發船', '抵達台灣港口', '清關中', '抵達瘋狗窩', '瘋狗窩已寄出', '完成'];
  const ADMIN = 'admin@demo.local', USER = 'user@demo.local';
  const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
  const day = (h = 0) => {
    const d = new Date(Date.now() - h * 3600e3);
    return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  };

  function seed() {
    const db = { batches: [], items: [], history: [], bindings: [], users: [
      { email: ADMIN, name: '示範管理者', role: 'admin', createdAt: ago(500), lastLogin: ago(1) },
      { email: USER, name: '示範使用者', role: 'user', createdAt: ago(300), lastLogin: ago(2) },
      { email: 'amy@demo.local', name: 'Amy', role: 'user', createdAt: ago(200), lastLogin: ago(30) },
    ] };
    const batch = (id, carrier, status, h, note = '') =>
      db.batches.push({ id, carrier, status, note, updatedAt: ago(h), updatedBy: ADMIN, createdAt: ago(h + 200) });
    batch('YT7712093345521', '圓通速遞', '清關中', 5, '海關抽驗');
    batch('SF1460023389', '順豐', '抵達瘋狗窩', 20);
    batch('JD0098812734', '京東物流', '倉庫出倉', 2);
    let n = 0;
    const item = (batchId, product, qty, status, h, emails, note = '') => {
      const id = `MD${day(h + 200)}-${String(++n).padStart(3, '0')}`;
      db.items.push({ id, product, qty, batch: batchId, status, note, bindCode: String(100000 + n * 7919).slice(-6),
        updatedAt: ago(h), updatedBy: ADMIN, createdAt: ago(h + 200) });
      STATUSES.slice(0, STATUSES.indexOf(status) + 1).forEach((st, i, arr) =>
        db.history.push({ time: ago(h + (arr.length - 1 - i) * 30), id, status: st, note: '', by: ADMIN, batch: batchId }));
      emails.forEach(email => db.bindings.push({ id, email, boundAt: ago(h + 100), boundBy: ADMIN }));
    };
    item('YT7712093345521', '寶可夢卡 151 補充包 ×20 盒', 20, '清關中', 5, [USER]);
    item('YT7712093345521', '航海王卡牌 OP-09 1 箱', 1, '清關中', 5, ['amy@demo.local']);
    item('SF1460023389', '遊戲王 稀有卡 3 張', 3, '瘋狗窩已寄出', 3, [USER], '黑貓宅急便 9012-3456-7890');
    item('SF1460023389', 'PSA 評級卡套組', 2, '抵達瘋狗窩', 20, ['amy@demo.local']);
    item('JD0098812734', '卡磚收納盒（大）', 5, '倉庫出倉', 2, [USER]);
    item('', '寶可夢 中文版 特典卡', 1, '完成', 60, [USER]);
    return db;
  }

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { return seed(); } };
  const save = db => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const err = (code, msg) => Object.assign(new Error(msg), { code });
  const str = v => String(v ?? '').trim();
  const normId = v => str(v).toUpperCase();
  const uniq = a => [...new Set(a)];
  const now = () => new Date().toISOString();
  const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const normEmail = e => {
    e = str(e).toLowerCase();
    const m = e.match(/^([^@]+)@(gmail\.com|googlemail\.com)$/);
    return m ? m[1].split('+')[0].replace(/\./g, '') + '@gmail.com' : e;
  };
  const rank = s => STATUSES.indexOf(s);
  const valid = s => { s = str(s); if (rank(s) < 0) throw err(400, '無效的狀態：' + s); return s; };

  function setItemsStatus(db, items, status, note, u, t, onlyForward, setNote) {
    const target = items.filter(i => !onlyForward || rank(i.status) < rank(status));
    target.forEach(i => {
      Object.assign(i, { status, updatedAt: t, updatedBy: u.email }, setNote ? { note } : {});
      db.history.push({ time: t, id: i.id, status, note, by: u.email, batch: i.batch });
    });
    return target.length;
  }

  function bindEmails(db, id, emails, u) {
    const list = uniq(emails.map(normEmail).filter(Boolean));
    const bad = list.filter(e => !isEmail(e));
    if (bad.length) throw err(400, 'Email 格式錯誤：' + bad.join(', '));
    list.forEach(email => {
      if (!db.bindings.some(b => b.id === id && b.email === email)) db.bindings.push({ id, email, boundAt: now(), boundBy: u.email });
    });
  }

  const routes = {
    me: (p, u) => ({ ...u, statuses: STATUSES }),
    myShipments: (p, u, db) => uniq(db.bindings.filter(b => b.email === u.email).map(b => b.id)).map(id => {
      const s = db.items.find(x => x.id === id);
      return s ? { id, product: s.product, qty: s.qty, status: s.status, note: s.note, updatedAt: s.updatedAt }
               : { id, product: '', qty: '', status: null, note: '', updatedAt: null };
    }),
    bindByCode: (p, u, db) => {
      const id = normId(p.id), s = db.items.find(x => x.id === id);
      if (!s || !s.bindCode || s.bindCode !== str(p.code)) throw err(400, '貨件編號或綁定碼錯誤');
      bindEmails(db, id, [u.email], u);
      return { id };
    },
    unbindMine: (p, u, db) => { db.bindings = db.bindings.filter(b => !(b.id === normId(p.id) && b.email === u.email)); return true; },

    listBatches: (p, u, db) => db.batches.map(b => ({ ...b, itemCount: db.items.filter(i => i.batch === b.id).length })),
    saveBatch: (p, u, db) => {
      const id = normId(p.id); if (!id) throw err(400, '請輸入物流編號');
      const status = valid(p.status), t = now();
      const ex = db.batches.find(b => b.id === id);
      let changed = true;
      if (p.mode === 'create') {
        if (ex) throw err(409, '物流編號已存在：' + id);
        db.batches.push({ id, carrier: str(p.carrier), status, note: str(p.note), updatedAt: t, updatedBy: u.email, createdAt: t });
      } else {
        if (!ex) throw err(404, '找不到物流編號：' + id);
        changed = ex.status !== status;
        Object.assign(ex, { carrier: str(p.carrier), note: str(p.note) }, changed ? { status, updatedAt: t, updatedBy: u.email } : {});
      }
      const updated = changed || p.syncAll
        ? setItemsStatus(db, db.items.filter(i => i.batch === id), status, '（物流單更新）', u, t, !p.syncAll) : 0;
      return { id, updated };
    },
    deleteBatch: (p, u, db) => {
      const id = normId(p.id), n = db.items.filter(i => i.batch === id).length;
      if (n) throw err(409, `此物流單還有 ${n} 筆貨件，請先移到其他物流單或刪除`);
      db.batches = db.batches.filter(b => b.id !== id);
      return true;
    },

    listShipments: (p, u, db) => db.items.map(s => {
      const emails = uniq(db.bindings.filter(b => b.id === s.id).map(b => b.email));
      return { ...s, emails, pending: emails.filter(e => !db.users.some(x => x.email === e && x.lastLogin)) };
    }),
    saveShipment: (p, u, db) => {
      const product = str(p.product); if (!product) throw err(400, '請輸入商品名稱');
      const qty = Math.max(1, parseInt(p.qty, 10) || 1), batch = normId(p.batch);
      if (batch && !db.batches.some(b => b.id === batch)) throw err(404, '找不到物流編號：' + batch);
      const status = valid(p.status), note = str(p.note), bindCode = str(p.bindCode), t = now();
      if (p.mode === 'create') {
        let id = normId(p.id);
        if (!id) {
          const prefix = 'MD' + day() + '-';
          const max = db.items.filter(s => s.id.startsWith(prefix)).reduce((m, s) => Math.max(m, parseInt(s.id.slice(prefix.length), 10) || 0), 0);
          id = prefix + String(max + 1).padStart(3, '0');
        }
        if (db.items.some(s => s.id === id)) throw err(409, '貨件編號已存在：' + id);
        db.items.push({ id, product, qty, batch, status, note, bindCode, updatedAt: t, updatedBy: u.email, createdAt: t });
        db.history.push({ time: t, id, status, note, by: u.email, batch });
        if (p.emails && p.emails.length) bindEmails(db, id, p.emails, u);
        return { id };
      }
      const id = normId(p.id), ex = db.items.find(s => s.id === id);
      if (!ex) throw err(404, '找不到貨件編號：' + id);
      const changed = ex.status !== status || ex.note !== note;
      Object.assign(ex, { product, qty, batch, bindCode }, changed ? { status, note, updatedAt: t, updatedBy: u.email } : {});
      if (changed) db.history.push({ time: t, id, status, note, by: u.email, batch });
      return { id };
    },
    batchStatus: (p, u, db) => {
      const ids = new Set((p.ids || []).map(normId));
      if (!ids.size) throw err(400, '請選擇貨件');
      return { updated: setItemsStatus(db, db.items.filter(s => ids.has(s.id)), valid(p.status), str(p.note), u, now(), false, true) };
    },
    deleteShipment: (p, u, db) => {
      const id = normId(p.id);
      db.items = db.items.filter(s => s.id !== id);
      db.bindings = db.bindings.filter(b => b.id !== id);
      db.history.push({ time: now(), id, status: '（已刪除）', note: '', by: u.email, batch: '' });
      return true;
    },
    history: (p, u, db) => db.history.filter(h => h.id === normId(p.id)).sort((a, b) => b.time.localeCompare(a.time)),
    bind: (p, u, db) => {
      const id = normId(p.id);
      if (!db.items.some(s => s.id === id)) throw err(404, '找不到貨件編號：' + id);
      bindEmails(db, id, p.emails || [], u);
      return true;
    },
    unbind: (p, u, db) => { db.bindings = db.bindings.filter(b => !(b.id === normId(p.id) && b.email === normEmail(p.email))); return true; },

    listUsers: (p, u, db) => db.users.map(x => ({ ...x, bound: db.bindings.filter(b => b.email === x.email).length })),
    setRole: (p, u, db) => {
      const email = normEmail(p.email), role = p.role === 'admin' ? 'admin' : 'user';
      if (!isEmail(email)) throw err(400, 'Email 格式錯誤：' + email);
      if (email === u.email && role !== 'admin') throw err(400, '不能移除自己的管理者權限');
      const x = db.users.find(y => y.email === email);
      if (x) x.role = role; else db.users.push({ email, name: '', role, createdAt: now(), lastLogin: '' });
      return true;
    },
  };
  const PUBLIC = ['me', 'myShipments', 'bindByCode', 'unbindMine'];

  async function handle({ action, payload, idToken }) {
    await new Promise(r => setTimeout(r, 200 + Math.random() * 250));
    try {
      const email = normEmail(String(idToken || '').replace(/^demo:/, ''));
      if (!email) throw err(401, '請先登入');
      const db = load();
      let user = db.users.find(x => x.email === email);
      if (!user) { user = { email, name: '', role: 'user', createdAt: now(), lastLogin: now() }; db.users.push(user); }
      if (!routes[action]) throw err(400, '未知的操作：' + action);
      if (!PUBLIC.includes(action) && user.role !== 'admin') throw err(403, '需要管理者權限');
      const data = routes[action](payload || {}, { email: user.email, name: user.name, role: user.role }, db);
      save(db);
      return { ok: true, data: JSON.parse(JSON.stringify(data)) };
    } catch (e) {
      return { ok: false, code: e.code || 500, error: e.message };
    }
  }

  return { handle, reset: () => localStorage.removeItem(KEY) };
})();
