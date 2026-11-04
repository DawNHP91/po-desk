/**
 * Auth.gs — email + PIN login, sessions, and the permission checks every action goes through.
 *
 * The browser is never trusted: each authenticated call re-reads the user's row and their
 * UserEntities grants from the Sheet, so deactivating someone or removing a company takes effect
 * on their very next request, whatever the browser still has cached.
 */

const AUTH = Object.freeze({
  MAX_FAILURES: 5,
  LOCK_MINUTES: 15,
  SESSION_IDLE_S: 21600,                // CacheService maximum (6 h); refreshed on every authenticated call
  SESSION_MAX_AGE_MS: 12 * 3600 * 1000, // absolute cap, so a token in constant use cannot live for ever
  LOGIN_RATE_MAX: 10,                   // attempts per email per window, on top of the lockout
  LOGIN_RATE_WINDOW_S: 900,
});
const ROLES = Object.freeze(['buyer', 'approver', 'admin']);
const LOGIN_FAILED_MSG = 'Email or PIN is incorrect.';

// --- Actions ---------------------------------------------------------------------------------

function actionLogin_(req) {
  const email = normEmail_(req.payload.email);
  const pin = String(req.payload.pin === undefined ? '' : req.payload.pin);
  if (!email || !/^\d{6}$/.test(pin)) throw new AppError('LOGIN_FAILED', 'Enter your email and 6-digit PIN.');
  rateLimit_('login', email, AUTH.LOGIN_RATE_MAX, AUTH.LOGIN_RATE_WINDOW_S);

  let user;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    user = findUserByEmail_(email);
    // Unknown emails get the same answers (incorrect, then locked) so the login form can't be
    // used to discover who has an account.
    if (!user) failUnknownEmail_(email);

    const now = new Date();
    const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
    if (lockedUntil && !isNaN(lockedUntil.getTime()) && lockedUntil > now) throw lockedError_(lockedUntil, now);

    const ok = isTrue_(user.active) && user.pin_hash && user.pin_salt &&
      safeEqual_(hashPin_(String(user.pin_salt), pin), String(user.pin_hash));
    if (!ok) {
      const fails = (Number(user.failed_attempts) || 0) + 1;
      if (fails >= AUTH.MAX_FAILURES) {
        const until = new Date(now.getTime() + AUTH.LOCK_MINUTES * 60000);
        updateRowById('Users', 'user_id', user.user_id, { failed_attempts: 0, locked_until: until });
        auditLog({ userId: user.user_id, action: 'auth.locked', ok: false, detail: { until: until.toISOString() } });
        throw lockedError_(until, now);
      }
      updateRowById('Users', 'user_id', user.user_id, { failed_attempts: fails });
      auditLog({ userId: user.user_id, action: 'auth.login', ok: false, detail: { failures: fails } });
      throw new AppError('LOGIN_FAILED', LOGIN_FAILED_MSG);
    }
    if (Number(user.failed_attempts) || user.locked_until) {
      updateRowById('Users', 'user_id', user.user_id, { failed_attempts: 0, locked_until: '' });
    }
  } finally {
    lock.releaseLock();
  }

  const token = createSession_(user.user_id);
  auditLog({ userId: user.user_id, action: 'auth.login', ok: true });
  return { token: token, me: buildMe_(user, grantsFor_(user.user_id)) };
}

/** Public on purpose: logging out with an already-expired token should still succeed. */
function actionLogout_(req) {
  if (isUuid_(req.token)) CacheService.getScriptCache().remove(sessionKey_(req.token));
  return { loggedOut: true };
}

function actionMe_(req, ctx) {
  return buildMe_(ctx.user, ctx.grants);
}

/**
 * Everything the New PO screen needs for one company. The company comes from the request, so it
 * is checked against the caller's own grants: a buyer limited to NHP gets FORBIDDEN for HPB no
 * matter how the request is edited.
 */
function actionRefData_(req, ctx) {
  const ent = requireBuyer_(ctx, req.payload.entityId);
  const ref = getRefData(ent);
  const allowed = allowedAccounts_({ accounts: ref.accounts, config: { extraAccounts: getConfig('EXTRA_PURCHASE_ACCOUNTS_' + ent, '') } }, ent);
  return {
    entityId: ent,
    refVersion: ref.version,
    // Bank account names and IDs stay on the server: NHP's account name contains its full account number.
    paymentMethods: readTable('PaymentMethods').rows
      .filter(r => r.entity_id === ent && isTrue_(r.active))
      .map(r => ({ pmId: r.pm_id, type: r.type, label: r.label, last4: String(r.last4 || '') })),
    categories: readTable('Categories').rows
      .filter(r => r.entity_id === ent && isTrue_(r.active))
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .map(r => ({ categoryId: r.category_id, name: r.name })),
    accounts: Object.keys(allowed).sort()
      .map(code => ({ code: code, name: allowed[code].name, type: allowed[code].type })),
    suppliers: ref.suppliers
      .map(s => ({ contactId: s.contact_id, name: String(s.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// --- Sessions and permissions ----------------------------------------------------------------

function createSession_(userId) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify({ userId: userId, createdAt: Date.now() }), AUTH.SESSION_IDLE_S);
  return token;
}

/** The cache key is a hash of the token, so the token itself is never stored anywhere server-side. */
function sessionKey_(token) {
  return 'sess:' + sha256Hex_(token);
}

/** Returns { token, user, grants } or throws AUTH_REQUIRED. */
function requireSession_(token) {
  const ended = new AppError('AUTH_REQUIRED', 'Your session has ended. Please sign in again.');
  if (!isUuid_(token)) throw ended;
  const cache = CacheService.getScriptCache();
  const key = sessionKey_(token);
  const raw = cache.get(key);
  if (!raw) throw ended;
  let s;
  try { s = JSON.parse(raw); } catch (err) { cache.remove(key); throw ended; }
  if (!s.userId || Date.now() - Number(s.createdAt || 0) > AUTH.SESSION_MAX_AGE_MS) { cache.remove(key); throw ended; }
  const user = findBy('Users', 'user_id', s.userId)[0];
  if (!user || !isTrue_(user.active)) { cache.remove(key); throw ended; }
  cache.put(key, raw, AUTH.SESSION_IDLE_S);
  return { token: token, user: user, grants: grantsFor_(user.user_id) };
}

/** entity_id -> { canBuy, canApprove, poLimitZar } for active companies in the code allowlist only. */
function grantsFor_(userId) {
  const activeEntities = {};
  readTable('Entities').rows.forEach(r => { if (isTrue_(r.active)) activeEntities[String(r.entity_id)] = r; });
  const out = {};
  readTable('UserEntities').rows
    .filter(r => String(r.user_id) === String(userId))
    .forEach(r => {
      const ent = String(r.entity_id);
      if (!activeEntities[ent] || !ENTITY_SEED.some(e => e.entity_id === ent)) return;
      out[ent] = { canBuy: isTrue_(r.can_buy), canApprove: isTrue_(r.can_approve), poLimitZar: Number(r.po_limit_zar) || 0 };
    });
  return out;
}

/** Validates an entityId from the browser against the caller's grants. Returns the canonical ID. */
function requireBuyer_(ctx, entityId) {
  if (typeof entityId !== 'string' || !entityId.trim()) throw new AppError('BAD_REQUEST', 'Choose a company.');
  const ent = entityId.trim().toUpperCase();
  const g = ctx.grants[ent];
  if (!g || !g.canBuy) {
    auditLog({ userId: ctx.user.user_id, entityId: ENTITY_SEED.some(e => e.entity_id === ent) ? ent : '', action: 'auth.forbidden', ok: false, detail: { asked: String(entityId).slice(0, 60) } });
    throw new AppError('FORBIDDEN', "You can't buy for that company.");
  }
  return ent;
}

function buildMe_(user, grants) {
  const companies = ENTITY_SEED.filter(e => grants[e.entity_id]).map(e => {
    const g = grants[e.entity_id];
    return { entityId: e.entity_id, name: e.short_name, legalName: e.legal_name, brandKey: e.brand_key, canBuy: g.canBuy, canApprove: g.canApprove, poLimitZar: g.poLimitZar };
  });
  const name = String(user.name || '');
  return {
    user: { userId: user.user_id, name: name, firstName: name.split(/\s+/)[0] || name, email: user.email, role: user.role },
    companies: companies,
    canApproveAny: companies.some(c => c.canApprove),
    isAdmin: user.role === 'admin',
    version: APP.VERSION,
  };
}

// --- Lockout and rate limits -----------------------------------------------------------------

function lockedError_(until, now) {
  const mins = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60000));
  return new AppError('LOCKED', 'Too many wrong PINs. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.');
}

function failUnknownEmail_(email) {
  const cache = CacheService.getScriptCache();
  const id = sha256Hex_(email).slice(0, 40);
  const lockKey = 'll:' + id;
  const lockedAt = Number(cache.get(lockKey));
  if (lockedAt) throw lockedError_(new Date(lockedAt + AUTH.LOCK_MINUTES * 60000), new Date());
  const failKey = 'lf:' + id;
  const fails = (Number(cache.get(failKey)) || 0) + 1;
  if (fails >= AUTH.MAX_FAILURES) {
    cache.put(lockKey, String(Date.now()), AUTH.LOCK_MINUTES * 60);
    cache.remove(failKey);
    throw lockedError_(new Date(Date.now() + AUTH.LOCK_MINUTES * 60000), new Date());
  }
  cache.put(failKey, String(fails), AUTH.LOCK_MINUTES * 60);
  throw new AppError('LOGIN_FAILED', LOGIN_FAILED_MSG);
}

/** Fixed-window counter in CacheService. Throws RATE_LIMITED once `max` is reached in the window. */
function rateLimit_(name, id, max, windowS) {
  const cache = CacheService.getScriptCache();
  const key = rateKey_(name, id, windowS);
  const count = Number(cache.get(key)) || 0;
  if (count >= max) throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.');
  cache.put(key, String(count + 1), windowS + 60);
}

function rateKey_(name, id, windowS) {
  return 'rl:' + name + ':' + sha256Hex_(String(id)).slice(0, 40) + ':' + Math.floor(Date.now() / 1000 / windowS);
}

/** Clears an email's login lock, failure counter and rate-limit bucket (Setup.gs unlockUser, tests). */
function resetLoginLimits_(email) {
  const e = normEmail_(email);
  const id = sha256Hex_(e).slice(0, 40);
  CacheService.getScriptCache().removeAll(['ll:' + id, 'lf:' + id, rateKey_('login', e, AUTH.LOGIN_RATE_WINDOW_S)]);
}

// --- Helpers ---------------------------------------------------------------------------------

function findUserByEmail_(email) {
  const e = normEmail_(email);
  return readTable('Users').rows.find(r => normEmail_(r.email) === e) || null;
}

function normEmail_(e) {
  return String(e || '').trim().toLowerCase();
}

function hashPin_(salt, pin) {
  return sha256Hex_(salt + pin);
}

function newSalt_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/** Compares every character so the time taken doesn't reveal how much of a hash matched. */
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function isUuid_(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Rejects PINs that are one digit repeated or a straight run (123456, 987654). */
function isWeakPin_(pin) {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  const up = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
  const down = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  return up || down;
}
