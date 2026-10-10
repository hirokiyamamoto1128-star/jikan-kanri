// この端末だけで動かすときの保存の仕組み（Firebaseと同じ使い方ができる小さな代役）。
// データはこのブラウザ（localStorage）に保存されます。firebase-config.js を設定すると Firebase に切り替わります。
(function () {
  const KEY = 'shiftapp-local-v1';
  const AUTH_KEY = 'shiftapp-local-auth';
  let store = {}, users = {};
  try { const raw = localStorage.getItem(KEY); if (raw) { const d = JSON.parse(raw); store = d.store || {}; users = d.users || {}; } } catch (_) {}
  const listeners = new Set();
  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  let saveT = null, saveErr = null;
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      saveT = null;
      try { localStorage.setItem(KEY, JSON.stringify({ store, users, savedAt: new Date().toISOString() })); saveErr = null; }
      catch (e) { saveErr = e; console.error('保存できませんでした', e); window.dispatchEvent(new CustomEvent('localdb-error')); }
    }, 150);
  }
  window.addEventListener('pagehide', () => { if (saveT) { clearTimeout(saveT); saveT = null; try { localStorage.setItem(KEY, JSON.stringify({ store, users, savedAt: new Date().toISOString() })); } catch (_) {} } });

  const isDocOf = (p, col) => p.startsWith(col + '/') && p.slice(col.length + 1).indexOf('/') === -1;
  const docSnap = path => { const d = store[path]; return { id: path.split('/').pop(), exists: d !== undefined, data: () => clone(d) }; };
  function colSnap(path, prev) {
    const docs = Object.keys(store).filter(p => isDocOf(p, path)).sort().map(docSnap);
    const changes = [], seen = prev || new Map();
    docs.forEach(d => { if (!seen.has(d.id)) changes.push({ type: 'added', doc: d }); else if (JSON.stringify(seen.get(d.id)) !== JSON.stringify(d.data())) changes.push({ type: 'modified', doc: d }); });
    for (const [id, v] of seen) if (!docs.find(d => d.id === id)) changes.push({ type: 'removed', doc: { id, exists: true, data: () => v } });
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => changes, _map: new Map(docs.map(d => [d.id, d.data()])) };
  }
  function notify() {
    for (const l of listeners) setTimeout(() => {
      if (!listeners.has(l)) return;
      if (l.kind === 'doc') l.cb(docSnap(l.path));
      else { const s = colSnap(l.path, l.prev); if (s.docChanges().length || !l.prev) { l.prev = s._map; l.cb(s); } }
    }, 0);
  }
  function applyFV(target, data) {
    const out = { ...(target || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__op === 'union') { const a = (out[k] || []).slice(); for (const x of v.items) if (!a.some(y => JSON.stringify(y) === JSON.stringify(x))) a.push(x); out[k] = a; }
      else if (v && v.__op === 'remove') out[k] = (out[k] || []).filter(y => !v.items.some(x => JSON.stringify(x) === JSON.stringify(y)));
      else out[k] = clone(v);
    }
    return out;
  }
  async function hashPw(email, pw) {
    const txt = 'local:' + email + ':' + pw;
    try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
    catch (_) { return 'plain:' + txt; }
  }
  const err = code => { const e = new Error(code); e.code = code; return e; };

  function makeApp(name) {
    let current = null, mode = 'local', cbs = [];
    if (name === '[DEFAULT]') {
      try { const a = JSON.parse(localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY) || 'null'); if (a && users[a.email]) current = makeUser(a.email); } catch (_) {}
    }
    function remember() {
      if (name !== '[DEFAULT]') return;
      try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY);
        if (current) (mode === 'local' ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify({ email: current.email })); } catch (_) {}
    }
    function fire() { remember(); cbs.forEach(cb => setTimeout(() => cb(current), 0)); }
    function makeUser(email) {
      return { email, uid: users[email].uid,
        async reauthenticateWithCredential(c) { if (users[c.email].h !== await hashPw(c.email, c.pw)) throw err('auth/wrong-password'); },
        async updatePassword(nw) { users[email].h = await hashPw(email, nw); persist(); } };
    }
    const auth = {
      get currentUser() { return current; },
      async setPersistence(m) { mode = m; },
      onAuthStateChanged(cb) { cbs.push(cb); setTimeout(() => cb(current), 0); return () => { cbs = cbs.filter(x => x !== cb); }; },
      async signInWithEmailAndPassword(email, pw) {
        const u = users[email]; if (!u || u.h !== await hashPw(email, pw)) throw err('auth/invalid-credential');
        current = makeUser(email); fire(); return { user: current };
      },
      async createUserWithEmailAndPassword(email, pw) {
        if (users[email]) throw err('auth/email-already-in-use');
        users[email] = { uid: 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), h: await hashPw(email, pw) };
        persist(); current = makeUser(email); fire(); return { user: current };
      },
      async signOut() { current = null; fire(); }
    };
    const ref = path => ({
      id: path.split('/').pop(), path,
      async get() { return docSnap(path); },
      async set(data, opt) { store[path] = opt && opt.merge ? applyFV(store[path], data) : applyFV({}, data); persist(); notify(); },
      async update(data) { if (store[path] === undefined) throw err('not-found'); store[path] = applyFV(store[path], data); persist(); notify(); },
      async delete() { delete store[path]; persist(); notify(); },
      onSnapshot(cb) { const l = { kind: 'doc', path, cb }; listeners.add(l); setTimeout(() => listeners.has(l) && cb(docSnap(path)), 0); return () => listeners.delete(l); },
      collection(sub) { return col(path + '/' + sub); }
    });
    const col = path => ({
      path, doc: id => ref(path + '/' + (id || Date.now().toString(36))), where() { return this; },
      async get() { return colSnap(path); },
      onSnapshot(cb) { const l = { kind: 'col', path, cb, prev: null }; listeners.add(l); setTimeout(() => { if (!listeners.has(l)) return; const s = colSnap(path, null); l.prev = s._map; cb(s); }, 0); return () => listeners.delete(l); }
    });
    const fs = { doc: ref, collection: col, enablePersistence: async () => {},
      batch() { const ops = []; return { set(r, d) { ops.push([r, d]); }, async commit() { for (const [r, d] of ops) store[r.path] = clone(d); persist(); notify(); } }; } };
    return { name, auth: () => auth, firestore: () => fs };
  }
  const apps = {};
  const firebase = {
    initializeApp(cfg, name = '[DEFAULT]') { if (!apps[name]) apps[name] = makeApp(name); return apps[name]; },
    auth() { return apps['[DEFAULT]'].auth(); },
    firestore() { return apps['[DEFAULT]'].firestore(); }
  };
  firebase.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
  firebase.auth.EmailAuthProvider = { credential: (email, pw) => ({ email, pw }) };
  firebase.firestore.FieldPath = { documentId: () => '__name__' };
  firebase.firestore.FieldValue = { arrayUnion: (...items) => ({ __op: 'union', items }), arrayRemove: (...items) => ({ __op: 'remove', items }) };
  firebase.__local = true;
  firebase.__size = () => { try { return (localStorage.getItem(KEY) || '').length; } catch (_) { return 0; } };
  window.firebase = firebase;
})();
