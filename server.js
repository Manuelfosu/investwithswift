/* =============================================================================
 * SWIFT INVESTMENTS — BACKEND SERVER  (Neon PostgreSQL)
 * =============================================================================
 * Stores users, credentials (as salted scrypt hashes), wallets, plans,
 * transactions, referrals and audit logs in a REAL PostgreSQL database (Neon).
 *
 *   - Set DATABASE_URL to your Neon connection string  -> the app uses Postgres
 *     everywhere (this is the production setup).
 *   - If DATABASE_URL is NOT set, the app transparently falls back to a local
 *     SQLite file (node:sqlite) purely so you can run it offline for testing.
 *
 * Built-ins + ONE dependency:
 *   - node:http   -> the web server
 *   - node:crypto -> secure password hashing + session ids
 *   - pg          -> PostgreSQL driver for Neon            (npm install)
 *
 * Run it with:   npm install && npm start      (see START-HERE.md)
 * ===========================================================================*/

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = !!DATABASE_URL;

/* =============================================================================
 * 0. DATABASE LAYER  — one tiny async API (get/all/run/insert) that works on
 *    BOTH PostgreSQL (Neon) and the local SQLite fallback. SQL is written once
 *    in Postgres style ($1, $2 …) and auto-translated to "?" for SQLite.
 * ===========================================================================*/
let pool = null;   // pg Pool   (Postgres / Neon)
let sdb = null;    // node:sqlite handle (offline fallback)
let DEMO_ID = null;
let ADMIN_ID = null;

async function initDb() {
  if (USE_PG) {
    const { Pool } = require('pg');
    // Some clients trip over "channel_binding=require"; SSL still fully encrypts
    // the connection, so we drop just that hint and let pg negotiate SCRAM.
    const conn = DATABASE_URL.replace(/[?&]channel_binding=require/i, '');
    pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000 });
    await pool.query('SELECT 1');
    console.log('[Swift] Connected to PostgreSQL (Neon).');
  } else {
    let sqlite;
    try {
      sqlite = require('node:sqlite');
    } catch (err) {
      // node:sqlite is gated behind a flag on some Node builds; relaunch once.
      if (!process.env.__SQLITE_REEXEC) {
        const cp = require('node:child_process');
        const result = cp.spawnSync(
          process.execPath,
          ['--no-warnings', '--experimental-sqlite', __filename].concat(process.argv.slice(2)),
          { stdio: 'inherit', env: Object.assign({}, process.env, { __SQLITE_REEXEC: '1' }) }
        );
        process.exit(result.status == null ? 1 : result.status);
      }
      console.error('[Swift] No DATABASE_URL set and node:sqlite is unavailable.');
      console.error('[Swift] Set DATABASE_URL to your Neon connection string, or use Node v22.5+.');
      process.exit(1);
    }
    const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'swift.db');
    sdb = new sqlite.DatabaseSync(DB_FILE);
    console.log('[Swift] No DATABASE_URL set — using local SQLite fallback at ' + DB_FILE + '.');
  }
}

/* Translate Postgres-style $1,$2 placeholders to SQLite "?" (handles reuse). */
function toSqlite(sql, params) {
  const out = [];
  const newSql = String(sql).replace(/\$(\d+)/g, function (_m, d) { out.push(params[Number(d) - 1]); return '?'; });
  return { sql: newSql, params: out };
}
async function all(sql, params) {
  params = params || [];
  if (USE_PG) { const r = await pool.query(sql, params); return r.rows; }
  const q = toSqlite(sql, params);
  return sdb.prepare(q.sql).all.apply(sdb.prepare(q.sql), q.params);
}
async function get(sql, params) {
  params = params || [];
  if (USE_PG) { const r = await pool.query(sql, params); return r.rows[0]; }
  const q = toSqlite(sql, params);
  const stmt = sdb.prepare(q.sql);
  return stmt.get.apply(stmt, q.params);
}
async function run(sql, params) {
  params = params || [];
  if (USE_PG) { const r = await pool.query(sql, params); return { rowCount: r.rowCount, rows: r.rows }; }
  const q = toSqlite(sql, params);
  const stmt = sdb.prepare(q.sql);
  const info = stmt.run.apply(stmt, q.params);
  return { rowCount: Number(info.changes), lastID: info.lastInsertRowid };
}
/* INSERT helper that returns the new row's id on BOTH engines. */
async function insert(sql, params) {
  params = params || [];
  if (USE_PG) {
    const r = await pool.query(/returning/i.test(sql) ? sql : (sql + ' RETURNING id'), params);
    return r.rows[0] ? r.rows[0].id : null;
  }
  const clean = sql.replace(/\s+returning\s+id\s*$/i, '');
  const q = toSqlite(clean, params);
  const stmt = sdb.prepare(q.sql);
  const info = stmt.run.apply(stmt, q.params);
  return Number(info.lastInsertRowid);
}
async function exec(sql) {
  if (USE_PG) { await pool.query(sql); } else { sdb.exec(sql); }
}
async function addColumn(table, col, type) {
  try {
    if (USE_PG) await exec('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS ' + col + ' ' + type);
    else sdb.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + type);
  } catch (e) { /* column already exists */ }
}

/* =============================================================================
 * 1. SCHEMA  — created on first run. __PK__ becomes an auto-increment primary
 *    key in whichever dialect is active.
 * ===========================================================================*/
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id __PK__,
    name TEXT, email TEXT UNIQUE, phone TEXT,
    password_hash TEXT, salt TEXT,
    role TEXT DEFAULT 'user', tier TEXT DEFAULT 'VIP 1',
    joined TEXT, avatar TEXT,
    referral_code TEXT, referred_by INTEGER,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS wallets (
    user_id INTEGER PRIMARY KEY,
    balance DOUBLE PRECISION DEFAULT 0, invested DOUBLE PRECISION DEFAULT 0, available DOUBLE PRECISION DEFAULT 0,
    today_pl DOUBLE PRECISION DEFAULT 0, total_pl DOUBLE PRECISION DEFAULT 0, total_pl_pct DOUBLE PRECISION DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS performance (
    user_id INTEGER, ord INTEGER, label TEXT, value DOUBLE PRECISION
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id __PK__,
    user_id INTEGER, name TEXT, price DOUBLE PRECISION, daily DOUBLE PRECISION, days INTEGER,
    day_of INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
    start TEXT, credited_days INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id __PK__,
    user_id INTEGER, txid TEXT, date TEXT, type TEXT, amount DOUBLE PRECISION, status TEXT
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id __PK__,
    user_id INTEGER, title TEXT, body TEXT, time TEXT, tone TEXT, unread INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, user_id INTEGER, expires BIGINT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id __PK__,
    user_id INTEGER, actor_id INTEGER, action TEXT, detail TEXT, time TEXT
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id __PK__,
    referrer_id INTEGER, referred_id INTEGER, base_amount DOUBLE PRECISION, bonus DOUBLE PRECISION, created_at TEXT
  );
`;
async function initSchema() {
  const pk = USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  await exec(SCHEMA.split('__PK__').join(pk));
  // Idempotent migrations for pre-existing databases.
  await addColumn('users', 'referral_code', 'TEXT');
  await addColumn('users', 'referred_by', 'INTEGER');
  await addColumn('users', 'created_at', 'TEXT');
  await addColumn('subscriptions', 'credited_days', 'INTEGER DEFAULT 0');
  await addColumn('subscriptions', 'start', 'TEXT');
  await addColumn('transactions', 'note', 'TEXT');
}

/* The VIP plans (single source of truth for prices/payouts on the server). */
const PLANS = [
  { name: 'VIP 1',        price: 100,  daily: 20,   days: 30, tag: 'Starter',    accent: 'brand' },
  { name: 'VIP 2',        price: 200,  daily: 40,   days: 30, tag: 'Popular',    accent: 'brand' },
  { name: 'VIP 3',        price: 500,  daily: 125,  days: 30, tag: null,         accent: 'navy'  },
  { name: 'Mega VIP',     price: 1000, daily: 250,  days: 30, tag: null,         accent: 'navy'  },
  { name: 'Super VIP',    price: 2000, daily: 500,  days: 30, tag: null,         accent: 'gold'  },
  { name: 'Ultimate VIP', price: 5000, daily: 1250, days: 30, tag: 'Best value', accent: 'gold'  }
];

/* =============================================================================
 * 2. HELPERS (security, time, referrals, accrual)
 * ===========================================================================*/
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { salt: useSalt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function nextTxId() { return 'TXN-' + Math.floor(10000 + Math.random() * 89999); }
function today() { return new Date().toISOString().slice(0, 10); }
function nowTs() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function dayDiff(fromYmd, toYmd) {
  const a = new Date(String(fromYmd).slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(String(toYmd).slice(0, 10) + 'T00:00:00Z').getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.floor((b - a) / 86400000);
}

const REFERRAL_RATE = 0.20; // referrer earns 20% of each referred member's deposit
async function genRefCode(name) {
  const base = String(name || 'SWIFT').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5) || 'SWIFT';
  let code;
  do { code = base + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(); }
  while (await get('SELECT id FROM users WHERE referral_code = $1', [code]));
  return code;
}
async function ensureRefCode(uid) {
  const u = await get('SELECT referral_code, name FROM users WHERE id = $1', [uid]);
  if (!u) return null;
  if (u.referral_code) return u.referral_code;
  const code = await genRefCode(u.name);
  await run('UPDATE users SET referral_code = $1 WHERE id = $2', [code, uid]);
  return code;
}
async function payReferral(memberId, baseAmount) {
  const m = await get('SELECT referred_by, name, email FROM users WHERE id = $1', [memberId]);
  if (!m || !m.referred_by) return;
  const bonus = Math.round(baseAmount * REFERRAL_RATE * 100) / 100;
  if (!(bonus > 0)) return;
  await run('UPDATE wallets SET balance = balance + $1, available = available + $2 WHERE user_id = $3', [bonus, bonus, m.referred_by]);
  await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [m.referred_by, nextTxId(), today(), 'Referral', bonus, 'Completed']);
  await run('INSERT INTO referrals (referrer_id, referred_id, base_amount, bonus, created_at) VALUES ($1,$2,$3,$4,$5)', [m.referred_by, memberId, baseAmount, bonus, nowTs()]);
  await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [m.referred_by, 'Referral bonus earned', '₵' + bonus.toFixed(2) + ' (20%) from ' + (m.name || m.email || 'your referral') + '’s deposit.', 'now', 'profit']);
  await logAudit(m.referred_by, memberId, 'referral.bonus', '+' + bonus + ' from ' + (m.email || memberId));
}
async function successfulReferrals(uid) {
  const row = await get(
    "SELECT CAST(COUNT(DISTINCT u.id) AS INTEGER) c FROM users u " +
    "JOIN transactions t ON t.user_id = u.id AND t.type = 'Deposit' AND t.status = 'Completed' " +
    "WHERE u.referred_by = $1", [uid]);
  return row ? row.c : 0;
}
async function accrueSubscriptions(uid) {
  const subs = await all("SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active'", [uid]);
  const t = today();
  for (const s of subs) {
    const start = (s.start || t);
    const credited = s.credited_days || 0;
    let elapsed = dayDiff(start, t) + 1;      // purchase day counts as payout #1
    if (elapsed < 0) elapsed = 0;
    if (elapsed > s.days) elapsed = s.days;    // never pay past the plan term
    const due = elapsed - credited;
    if (due <= 0) continue;
    const gain = Math.round(due * s.daily * 100) / 100;
    await run('UPDATE wallets SET balance = balance + $1, available = available + $2, total_pl = total_pl + $3 WHERE user_id = $4', [gain, gain, gain, uid]);
    await run('UPDATE subscriptions SET credited_days = $1, day_of = $2 WHERE id = $3', [elapsed, elapsed, s.id]);
    await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [uid, nextTxId(), t, 'Income', gain, 'Completed']);
    await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [uid, 'Daily income credited', '₵' + gain.toFixed(2) + ' from your ' + s.name + ' plan (day ' + elapsed + ' of ' + s.days + ').', 'now', 'profit']);
    if (elapsed >= s.days) await run("UPDATE subscriptions SET status = 'completed' WHERE id = $1", [s.id]);
  }
  const dr = (await get("SELECT COALESCE(SUM(daily),0) d FROM subscriptions WHERE user_id = $1 AND status = 'active'", [uid])).d;
  await run('UPDATE wallets SET today_pl = $1 WHERE user_id = $2', [dr, uid]);
}
async function accrueAll() {
  const rows = await all("SELECT DISTINCT user_id FROM subscriptions WHERE status = 'active'", []);
  for (const r of rows) await accrueSubscriptions(r.user_id);
}
async function logAudit(userId, actorId, action, detail) {
  try {
    await run('INSERT INTO audit_logs (user_id, actor_id, action, detail, time) VALUES ($1,$2,$3,$4,$5)', [userId == null ? null : userId, actorId == null ? null : actorId, action, detail || '', nowTs()]);
  } catch (e) { /* logging must never break a request */ }
}
async function userRole(uid) {
  const u = await get('SELECT role FROM users WHERE id = $1', [uid]);
  return u ? u.role : null;
}

/* =============================================================================
 * 3. SEED DATA  — demo user, admin, and a demo referral downline (once).
 * ===========================================================================*/
async function seedDemo() {
  const existing = await get('SELECT id FROM users WHERE email = $1', ['demo@swift.io']);
  if (existing) return existing.id;
  const h = hashPassword('demo1234');
  const uid = await insert('INSERT INTO users (name, email, phone, password_hash, salt, role, tier, joined, avatar, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['Emma Highest', 'demo@swift.io', '0541234567', h.hash, h.salt, 'user', 'VIP 2', 'Mar 2024', 'EH', nowTs()]);
  await run('INSERT INTO wallets (user_id, balance, invested, available, today_pl, total_pl, total_pl_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uid, 3250, 2000, 1250, 120, 640, 24.5]);
  const perf = [['Mon', 2610], ['Tue', 2680], ['Wed', 2740], ['Thu', 2810], ['Fri', 2960], ['Sat', 3080], ['Sun', 3250]];
  for (let i = 0; i < perf.length; i++) await run('INSERT INTO performance (user_id, ord, label, value) VALUES ($1,$2,$3,$4)', [uid, i, perf[i][0], perf[i][1]]);
  await run('INSERT INTO subscriptions (user_id, name, price, daily, days, day_of, status, start) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uid, 'VIP 2', 200, 40, 30, 12, 'active', today()]);
  await run('INSERT INTO subscriptions (user_id, name, price, daily, days, day_of, status, start) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uid, 'VIP 1', 100, 20, 30, 24, 'active', today()]);
  const txns = [
    ['TXN-10241', '2026-06-15', 'Income', 60, 'Completed'],
    ['TXN-10238', '2026-06-14', 'Deposit', 500, 'Completed'],
    ['TXN-10231', '2026-06-12', 'Investment', 200, 'Completed'],
    ['TXN-10225', '2026-06-10', 'Withdrawal', 300, 'Pending'],
    ['TXN-10219', '2026-06-08', 'Income', 40, 'Completed'],
    ['TXN-10204', '2026-06-05', 'Withdrawal', 150, 'Failed']
  ];
  for (const t of txns) await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [uid, t[0], t[1], t[2], t[3], t[4]]);
  const notes = [
    ['Daily income credited', '₵60.00 added from your active plans.', '2h', 'profit', 1],
    ['Deposit confirmed', '₵500.00 added to your wallet.', '5h', 'brand', 1],
    ['Withdrawal pending', '₵300.00 withdrawal is under review.', '1d', 'loss', 0]
  ];
  for (const n of notes) await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,$6)', [uid, n[0], n[1], n[2], n[3], n[4]]);
  console.log('Seeded demo account -> email: demo@swift.io  password: demo1234');
  return uid;
}
async function seedAdmin() {
  const existing = await get('SELECT id FROM users WHERE email = $1', ['admin@swift.io']);
  if (existing) { await run("UPDATE users SET role = 'admin' WHERE id = $1", [existing.id]); return existing.id; }
  const h = hashPassword('admin1234');
  const aid = await insert('INSERT INTO users (name, email, phone, password_hash, salt, role, tier, joined, avatar, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['Swift Admin', 'admin@swift.io', '', h.hash, h.salt, 'admin', 'VIP 1', 'Jun 2026', 'AD', nowTs()]);
  await run('INSERT INTO wallets (user_id, balance, invested, available) VALUES ($1,0,0,0)', [aid]);
  console.log('Seeded ADMIN account -> email: admin@swift.io  password: admin1234');
  return aid;
}
async function backfillRefCodes() {
  const rows = await all("SELECT id FROM users WHERE referral_code IS NULL OR referral_code = ''", []);
  for (const r of rows) await ensureRefCode(r.id);
}
async function seedReferrals() {
  const c = (await get('SELECT CAST(COUNT(*) AS INTEGER) c FROM users WHERE referred_by = $1', [DEMO_ID])).c;
  if (c > 0) return;
  const downline = [
    ['Kwabena Osei', 'kwabena@swift.io', 'VIP 2', 600],
    ['Ama Serwaa',   'ama@swift.io',     'VIP 1', 300],
    ['Kojo Antwi',   'kojo@swift.io',    'VIP 3', 1500]
  ];
  for (const d of downline) {
    if (await get('SELECT id FROM users WHERE email = $1', [d[1]])) continue;
    const h = hashPassword('member1234');
    const avatar = d[0].split(' ').map(function (s) { return s[0]; }).join('').slice(0, 2).toUpperCase();
    const code = await genRefCode(d[0]);
    const mid = await insert('INSERT INTO users (name, email, phone, password_hash, salt, role, tier, joined, avatar, referral_code, referred_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [d[0], d[1], '', h.hash, h.salt, 'user', d[2], 'Jun 2026', avatar, code, DEMO_ID, nowTs()]);
    await run('INSERT INTO wallets (user_id, balance, invested, available) VALUES ($1,$2,0,$3)', [mid, d[3], d[3]]);
    await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [mid, nextTxId(), today(), 'Deposit', d[3], 'Completed']);
    await payReferral(mid, d[3]);
  }
  console.log('Seeded referral downline for demo account.');
}

/* =============================================================================
 * 4. SESSIONS + HTTP HELPERS
 * ===========================================================================*/
async function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 days
  await run('INSERT INTO sessions (sid, user_id, expires) VALUES ($1,$2,$3)', [sid, userId, expires]);
  return sid;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
async function currentUserId(req) {
  const sid = parseCookies(req).sid;
  if (sid) {
    const s = await get('SELECT user_id FROM sessions WHERE sid = $1 AND expires > $2', [sid, Date.now()]);
    if (s) return s.user_id;
  }
  return null; // no valid session — the request is unauthenticated
}
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise(function (resolve) {
    let data = '';
    let tooBig = false;
    req.on('data', function (c) {
      if (tooBig) return;
      data += c;
      if (data.length > 1e6) { tooBig = true; data = ''; try { req.destroy(); } catch (e) {} }
    });
    req.on('end', function () { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}
function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}
async function summaryOf(uid) {
  const w = await get('SELECT balance, invested, available, today_pl, total_pl, total_pl_pct FROM wallets WHERE user_id = $1', [uid]) || {};
  return {
    balance: w.balance || 0, invested: w.invested || 0, available: w.available || 0,
    todayPL: w.today_pl || 0, totalPL: w.total_pl || 0, totalPLPct: w.total_pl_pct || 0
  };
}
async function publicUser(uid) {
  const u = await get('SELECT name, email, phone, tier, joined, avatar, role, referral_code FROM users WHERE id = $1', [uid]) || {};
  return { name: u.name, email: u.email, phone: u.phone, tier: u.tier, joined: u.joined, avatar: u.avatar, role: u.role, referralCode: u.referral_code };
}
function cookieHeader(sid) {
  return { 'Set-Cookie': 'sid=' + sid + '; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax' };
}

/* =============================================================================
 * 5. API ROUTES
 * ===========================================================================*/
async function handleApi(req, res, route) {
  const method = req.method;

  // Health check (the host pings this to confirm the app is alive).
  if (route === '/health' && method === 'GET') return sendJson(res, 200, { ok: true, time: Date.now() });

  const uid = await currentUserId(req);
  const isAuthRoute = route.indexOf('/auth/') === 0;
  // Every non-auth endpoint requires a valid session. Without one we return 401
  // so the client can redirect to the login screen (no silent demo fallback).
  if (!isAuthRoute) {
    if (uid == null) return sendJson(res, 401, { error: 'Please log in to continue.' });
    // Bring the user's daily plan income up to date before any read/action.
    await accrueSubscriptions(uid);
  }

  // ---- Auth -----------------------------------------------------------------
  if (route === '/auth/register' && method === 'POST') {
    const b = await readBody(req);
    if (!b.email || !b.password) return sendJson(res, 400, { error: 'Email and password are required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (String(b.password).length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    if (await get('SELECT id FROM users WHERE email = $1', [b.email])) return sendJson(res, 409, { error: 'That email is already registered.' });
    const h = hashPassword(b.password);
    const avatar = (b.name || 'New User').split(' ').map(function (s) { return s[0]; }).join('').slice(0, 2).toUpperCase();
    let referrerId = null;
    if (b.ref) {
      const ref = await get('SELECT id FROM users WHERE referral_code = $1', [String(b.ref).trim().toUpperCase()]);
      if (ref) referrerId = ref.id;
    }
    const refCode = await genRefCode(b.name || 'New User');
    const newId = await insert('INSERT INTO users (name, email, phone, password_hash, salt, tier, joined, avatar, referral_code, referred_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [b.name || 'New User', b.email, b.phone || '', h.hash, h.salt, 'VIP 1', 'Jun 2026', avatar, refCode, referrerId, nowTs()]);
    await run('INSERT INTO wallets (user_id, balance, invested, available) VALUES ($1,0,0,0)', [newId]);
    if (referrerId) {
      await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [referrerId, 'New referral joined', (b.name || 'A new member') + ' signed up with your code. You’ll earn 20% of their deposits.', 'now', 'brand']);
      await logAudit(newId, referrerId, 'referral.signup', (b.email || 'new user') + ' joined via referral');
    }
    const sid = await createSession(newId);
    return sendJson(res, 200, { ok: true, user: await publicUser(newId) }, cookieHeader(sid));
  }

  if (route === '/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const u = await get('SELECT * FROM users WHERE email = $1', [b.email || '']);
    if (!u || !verifyPassword(b.password || '', u.salt, u.password_hash)) {
      return sendJson(res, 401, { error: 'Invalid email or password.' });
    }
    const sid = await createSession(u.id);
    await logAudit(u.id, u.id, 'auth.login', 'Signed in');
    return sendJson(res, 200, { ok: true, user: await publicUser(u.id) }, cookieHeader(sid));
  }

  if (route === '/auth/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) await run('DELETE FROM sessions WHERE sid = $1', [sid]);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }

  // ---- Read endpoints -------------------------------------------------------
  if (route === '/me' && method === 'GET') return sendJson(res, 200, await publicUser(uid));
  if (route === '/me/update' && method === 'POST') {
    const b = await readBody(req);
    const name = (b.name || '').toString().trim();
    const phone = (b.phone || '').toString().trim();
    if (!name) return sendJson(res, 400, { error: 'Please enter your full name.' });
    const avatar = name.split(/\s+/).map(function (s) { return s[0]; }).join('').slice(0, 2).toUpperCase();
    await run('UPDATE users SET name = $1, phone = $2, avatar = $3 WHERE id = $4', [name, phone, avatar, uid]);
    await logAudit(uid, uid, 'profile.update', 'Updated profile details');
    return sendJson(res, 200, { ok: true, user: await publicUser(uid) });
  }
  if (route === '/me/password' && method === 'POST') {
    const b = await readBody(req);
    const cur = (b.currentPassword || '').toString();
    const next = (b.newPassword || '').toString();
    if (next.length < 6) return sendJson(res, 400, { error: 'Your new password must be at least 6 characters.' });
    const u = await get('SELECT * FROM users WHERE id = $1', [uid]);
    if (!u || !verifyPassword(cur, u.salt, u.password_hash)) return sendJson(res, 400, { error: 'Your current password is incorrect.' });
    const h = hashPassword(next);
    await run('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3', [h.hash, h.salt, uid]);
    await logAudit(uid, uid, 'auth.password_change', 'Changed account password');
    return sendJson(res, 200, { ok: true });
  }
  if (route === '/portfolio/summary' && method === 'GET') return sendJson(res, 200, await summaryOf(uid));
  if (route === '/portfolio/performance' && method === 'GET') {
    const rows = await all('SELECT label, value FROM performance WHERE user_id = $1 ORDER BY ord', [uid]);
    return sendJson(res, 200, { labels: rows.map(function (r) { return r.label; }), values: rows.map(function (r) { return r.value; }) });
  }
  if (route === '/plans' && method === 'GET') return sendJson(res, 200, PLANS);
  if (route === '/plans/active' && method === 'GET') {
    const rows = await all("SELECT name, daily, days, day_of FROM subscriptions WHERE user_id = $1 AND status = 'active'", [uid]);
    return sendJson(res, 200, rows.map(function (r) { return { name: r.name, daily: r.daily, days: r.days, dayOf: r.day_of }; }));
  }
  if (route === '/transactions' && method === 'GET') {
    const rows = await all('SELECT txid AS id, date, type, amount, status FROM transactions WHERE user_id = $1 ORDER BY date DESC, id DESC', [uid]);
    return sendJson(res, 200, rows);
  }
  if (route === '/notifications' && method === 'GET') {
    const rows = await all('SELECT id, title, body, time, tone, unread FROM notifications WHERE user_id = $1 ORDER BY id DESC', [uid]);
    return sendJson(res, 200, rows.map(function (r) { return { id: r.id, title: r.title, body: r.body, time: r.time, tone: r.tone, unread: !!r.unread }; }));
  }

  // ---- Referrals — a member's own program -----------------------------------
  if (route === '/referrals/me' && method === 'GET') {
    const code = await ensureRefCode(uid);
    const referred = await all('SELECT id, name, email, joined FROM users WHERE referred_by = $1 ORDER BY id DESC', [uid]);
    const totalEarned = (await get('SELECT COALESCE(SUM(bonus),0) t FROM referrals WHERE referrer_id = $1', [uid])).t;
    const list = [];
    for (const r of referred) {
      const deposited = (await get("SELECT COALESCE(SUM(amount),0) d FROM transactions WHERE user_id = $1 AND type = 'Deposit' AND status = 'Completed'", [r.id])).d;
      const earned = (await get('SELECT COALESCE(SUM(bonus),0) b FROM referrals WHERE referrer_id = $1 AND referred_id = $2', [uid, r.id])).b;
      list.push({ name: r.name, email: r.email, joined: r.joined, deposited: deposited, earned: earned, status: deposited > 0 ? 'active' : 'pending' });
    }
    return sendJson(res, 200, { code: code, rate: REFERRAL_RATE, totalReferred: referred.length, totalEarned: totalEarned, referrals: list });
  }

  // ---- Money actions --------------------------------------------------------
  if (route === '/wallet/deposit' && method === 'POST') {
    const b = await readBody(req);
    const amount = Number(b.amount);
    if (!amount || amount <= 0 || !isFinite(amount) || amount > 1e9) return sendJson(res, 400, { error: 'Enter a valid amount (max 1,000,000,000).' });
    const payerName = (b.name || '').toString().trim();
    const payerMomo = (b.momo || '').toString().replace(/\s+/g, '');
    if (!payerName) return sendJson(res, 400, { error: 'Enter the full name on your Mobile Money account.' });
    if (!/^0\d{9}$/.test(payerMomo)) return sendJson(res, 400, { error: 'Enter a valid 10-digit Mobile Money number.' });
    const note = payerName + ' • ' + payerMomo;
    await run('INSERT INTO transactions (user_id, txid, date, type, amount, status, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uid, nextTxId(), today(), 'Deposit', amount, 'Pending', note]);
    await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [uid, 'Deposit submitted', '₵' + amount.toFixed(2) + ' is pending admin confirmation. It will reflect on your dashboard once approved.', 'now', 'brand']);
    await logAudit(uid, uid, 'wallet.deposit', 'Submitted deposit of ' + amount + ' from ' + note + ' (pending confirmation)');
    return sendJson(res, 200, { ok: true, summary: await summaryOf(uid) });
  }

  if (route === '/wallet/withdraw' && method === 'POST') {
    const b = await readBody(req);
    const amount = Number(b.amount);
    if (!amount || amount <= 0 || !isFinite(amount) || amount > 1e9) return sendJson(res, 400, { error: 'Enter a valid amount (max 1,000,000,000).' });
    if (amount < 100) return sendJson(res, 400, { error: 'The minimum withdrawal is ₵100.' });
    const okRefs = await successfulReferrals(uid);
    if (okRefs < 2) return sendJson(res, 403, { error: 'You need at least 2 successful referrals before you can withdraw. You currently have ' + okRefs + '.' });
    const w = await summaryOf(uid);
    if (amount > w.available) return sendJson(res, 400, { error: 'Amount exceeds your available balance.' });
    await run('UPDATE wallets SET balance = balance - $1, available = available - $2 WHERE user_id = $3', [amount, amount, uid]);
    await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [uid, nextTxId(), today(), 'Withdrawal', amount, 'Pending']);
    await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [uid, 'Withdrawal requested', '₵' + amount.toFixed(2) + ' to ' + (b.account || 'your account') + ' is under review.', 'now', 'loss']);
    await logAudit(uid, uid, 'wallet.withdraw', 'Requested ' + amount + ' to ' + (b.account || 'account'));
    return sendJson(res, 200, { ok: true, summary: await summaryOf(uid) });
  }

  if (route === '/plans/subscribe' && method === 'POST') {
    const b = await readBody(req);
    const planName = b.plan && b.plan.name ? b.plan.name : b.plan;
    const plan = PLANS.find(function (p) { return p.name === planName; });
    if (!plan) return sendJson(res, 400, { error: 'Unknown plan.' });
    const w = await summaryOf(uid);
    if (plan.price > w.available) return sendJson(res, 400, { error: 'Insufficient balance. ' + plan.name + ' costs ₵' + plan.price + ', but you only have ₵' + (w.available || 0) + ' available. Top up your wallet first.' });
    await run('UPDATE wallets SET available = available - $1, invested = invested + $2 WHERE user_id = $3', [plan.price, plan.price, uid]);
    await run('INSERT INTO subscriptions (user_id, name, price, daily, days, day_of, status, start) VALUES ($1,$2,$3,$4,$5,0,$6,$7)', [uid, plan.name, plan.price, plan.daily, plan.days, 'active', today()]);
    await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [uid, nextTxId(), today(), 'Investment', plan.price, 'Completed']);
    await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [uid, 'Plan activated', 'You subscribed to ' + plan.name + '. Daily income of ₵' + plan.daily + ' starts today.', 'now', 'brand']);
    await logAudit(uid, uid, 'plans.subscribe', plan.name);
    await accrueSubscriptions(uid); // credit day 1 immediately
    return sendJson(res, 200, { ok: true, plan: plan, summary: await summaryOf(uid) });
  }

  // ---- ADMIN (full access) — every /admin route requires an admin session ---
  if (route.indexOf('/admin/') === 0) {
    if ((await userRole(uid)) !== 'admin') return sendJson(res, 403, { error: 'Admin access required.' });
    await accrueAll();

    if (route === '/admin/stats' && method === 'GET') {
      const users = (await get('SELECT CAST(COUNT(*) AS INTEGER) c FROM users', [])).c;
      const t = await get('SELECT COALESCE(SUM(balance),0) b, COALESCE(SUM(invested),0) i, COALESCE(SUM(available),0) a FROM wallets', []);
      const pendW = (await get("SELECT CAST(COUNT(*) AS INTEGER) c FROM transactions WHERE status='Pending' AND type='Withdrawal'", [])).c;
      const pendD = (await get("SELECT CAST(COUNT(*) AS INTEGER) c FROM transactions WHERE status='Pending' AND type='Deposit'", [])).c;
      const active = (await get("SELECT CAST(COUNT(*) AS INTEGER) c FROM subscriptions WHERE status='active'", [])).c;
      return sendJson(res, 200, { users: users, totalBalance: t.b, totalInvested: t.i, totalAvailable: t.a, pendingWithdrawals: pendW, pendingDeposits: pendD, activePlans: active });
    }
    if (route === '/admin/users' && method === 'GET') {
      // Full registration / credential record per user (passwords stay hashed and are never returned).
      const rows = await all(
        'SELECT u.id, u.name, u.email, u.phone, u.role, u.tier, u.joined, ' +
        'u.created_at AS "createdAt", u.referral_code AS "code", ru.email AS "referredBy", ' +
        '(SELECT MAX(l.time) FROM audit_logs l WHERE l.user_id = u.id AND l.action = ' + "'auth.login'" + ') AS "lastLogin", ' +
        'COALESCE(w.balance,0) balance, COALESCE(w.invested,0) invested, COALESCE(w.available,0) available ' +
        'FROM users u LEFT JOIN wallets w ON w.user_id = u.id LEFT JOIN users ru ON ru.id = u.referred_by ORDER BY u.id', []);
      return sendJson(res, 200, rows);
    }
    if (route === '/admin/transactions' && method === 'GET') {
      const rows = await all('SELECT t.id, t.txid, t.date, t.type, t.amount, t.status, t.note, u.email AS "user" FROM transactions t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 300', []);
      return sendJson(res, 200, rows);
    }
    if (route === '/admin/subscriptions' && method === 'GET') {
      const rows = await all('SELECT s.id, s.name, s.price, s.daily, s.days, s.day_of AS "dayOf", s.status, u.email AS "user" FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC', []);
      return sendJson(res, 200, rows);
    }
    if (route === '/admin/logs' && method === 'GET') {
      const rows = await all('SELECT l.id, l.action, l.detail, l.time, u.email AS "user", a.email AS "actor" FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN users a ON a.id = l.actor_id ORDER BY l.id DESC LIMIT 200', []);
      return sendJson(res, 200, rows);
    }
    if (route === '/admin/referrals' && method === 'GET') {
      const rows = await all(
        'SELECT u.id, u.name, u.email, u.referral_code AS "code", ' +
        'CAST((SELECT COUNT(*) FROM users x WHERE x.referred_by = u.id) AS INTEGER) AS "referredCount", ' +
        '(SELECT COALESCE(SUM(bonus),0) FROM referrals r WHERE r.referrer_id = u.id) AS "earned", ' +
        'ru.email AS "referredBy" ' +
        'FROM users u LEFT JOIN users ru ON ru.id = u.referred_by ' +
        'ORDER BY "referredCount" DESC, "earned" DESC, u.id', []);
      return sendJson(res, 200, rows);
    }
    if (route === '/admin/wallet/adjust' && method === 'POST') {
      const b = await readBody(req);
      const target = Number(b.userId); const amt = Number(b.amount);
      if (!target || !amt || !isFinite(amt) || Math.abs(amt) > 1e9) return sendJson(res, 400, { error: 'Provide userId and a valid non-zero amount (max 1,000,000,000).' });
      const w = await get('SELECT user_id FROM wallets WHERE user_id = $1', [target]);
      if (!w) return sendJson(res, 404, { error: 'User wallet not found.' });
      await run('UPDATE wallets SET balance = balance + $1, available = available + $2 WHERE user_id = $3', [amt, amt, target]);
      await run('INSERT INTO transactions (user_id, txid, date, type, amount, status) VALUES ($1,$2,$3,$4,$5,$6)', [target, nextTxId(), today(), amt > 0 ? 'Credit' : 'Debit', Math.abs(amt), 'Completed']);
      await logAudit(target, uid, 'admin.wallet.adjust', (amt > 0 ? '+' : '') + amt + (b.note ? (' — ' + b.note) : ''));
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/admin/transaction/status' && method === 'POST') {
      const b = await readBody(req);
      const id = Number(b.id); const action = String(b.status || '');
      if (action !== 'Approved' && action !== 'Rejected') return sendJson(res, 400, { error: 'Status must be Approved or Rejected.' });
      const tx = await get('SELECT * FROM transactions WHERE id = $1', [id]);
      if (!tx) return sendJson(res, 404, { error: 'Transaction not found.' });
      if (tx.type === 'Withdrawal' && tx.status === 'Pending' && action === 'Rejected') {
        await run('UPDATE wallets SET balance = balance + $1, available = available + $2 WHERE user_id = $3', [tx.amount, tx.amount, tx.user_id]);
      }
      if (tx.type === 'Deposit' && tx.status === 'Pending' && action === 'Approved') {
        await run('UPDATE wallets SET balance = balance + $1, available = available + $2 WHERE user_id = $3', [tx.amount, tx.amount, tx.user_id]);
        await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [tx.user_id, 'Deposit confirmed', '₵' + Number(tx.amount).toFixed(2) + ' has been added to your wallet.', 'now', 'profit']);
        await payReferral(tx.user_id, tx.amount);
      }
      if (tx.type === 'Deposit' && tx.status === 'Pending' && action === 'Rejected') {
        await run('INSERT INTO notifications (user_id, title, body, time, tone, unread) VALUES ($1,$2,$3,$4,$5,1)', [tx.user_id, 'Deposit declined', 'Your deposit of ₵' + Number(tx.amount).toFixed(2) + ' could not be confirmed. Please contact support.', 'now', 'loss']);
      }
      const newStatus = action === 'Approved' ? 'Completed' : (action === 'Rejected' ? 'Failed' : action);
      await run('UPDATE transactions SET status = $1 WHERE id = $2', [newStatus, id]);
      await logAudit(tx.user_id, uid, 'admin.tx.status', tx.txid + ' -> ' + newStatus);
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/admin/plan/cancel' && method === 'POST') {
      const b = await readBody(req);
      const sub = await get('SELECT * FROM subscriptions WHERE id = $1', [Number(b.id)]);
      if (!sub) return sendJson(res, 404, { error: 'Subscription not found.' });
      await run("UPDATE subscriptions SET status = 'cancelled' WHERE id = $1", [sub.id]);
      await logAudit(sub.user_id, uid, 'admin.plan.cancel', sub.name);
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/admin/user/role' && method === 'POST') {
      const b = await readBody(req);
      const target = Number(b.userId); const role = b.role === 'admin' ? 'admin' : 'user';
      if (!target) return sendJson(res, 400, { error: 'Provide userId.' });
      await run('UPDATE users SET role = $1 WHERE id = $2', [role, target]);
      await logAudit(target, uid, 'admin.user.role', role);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Unknown admin route: ' + route });
  }

  return sendJson(res, 404, { error: 'Unknown API route: ' + route });
}

/* =============================================================================
 * 6. STATIC FILES  — serve the front-end (public/index.html)
 * ===========================================================================*/
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0].split('#')[0];
  let filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), function (e2, html) {
        if (e2) { res.writeHead(404); return res.end('Not found. Did you copy the front-end into server/public/index.html?'); }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* =============================================================================
 * 7. START THE SERVER
 * ===========================================================================*/
process.on('uncaughtException', function (e) { console.error('[Swift] uncaughtException:', e && e.message ? e.message : e); });
process.on('unhandledRejection', function (e) { console.error('[Swift] unhandledRejection:', e && e.message ? e.message : e); });

const server = http.createServer(async function (req, res) {
  try {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u.pathname.slice(4));
    return serveStatic(req, res, u.pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  }
});

(async function start() {
  await initDb();
  await initSchema();
  DEMO_ID = await seedDemo();
  ADMIN_ID = await seedAdmin();
  await backfillRefCodes();
  await seedReferrals();
  server.listen(PORT, function () {
    console.log('Swift Investments backend running at http://localhost:' + PORT);
    console.log('API base: http://localhost:' + PORT + '/api');
  });
})().catch(function (e) { console.error('[Swift] Startup failed:', e); process.exit(1); });
