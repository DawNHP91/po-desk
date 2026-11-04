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
    // The tab was loaded before the lock; re-read so concurrent attempts count correctly.
    if (!fastRead_(['Users'], true)) invalidateTable_('Users');
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
  // Deactivation and PIN resets end every session started before them, on every device.
  const validFrom = user.sessions_valid_from ? new Date(user.sessions_valid_from).getTime() : 0;
  if (validFrom && Number(s.createdAt || 0) <= validFrom) { cache.remove(key); throw ended; }
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

// --- People admin (Stage 7) --------------------------------------------------------------------
//
// Admins only, re-checked on the server for every call (ctx.user is re-read from the Sheet on each
// request, so a demoted admin loses these actions on their next tap). Admins never see or set a PIN:
// a new person, or a PIN reset, gets a single-use emailed link; only the link's SHA-256 is stored.

const PEOPLE_RULES = Object.freeze({ LINK_HOURS: 48, NAME_MAX: 80 });

function requireAdmin_(ctx) {
  if (ctx.user.role !== 'admin') {
    auditLog({ userId: ctx.user.user_id, action: 'auth.forbidden', ok: false, detail: { admin: true } });
    throw new AppError('FORBIDDEN', 'Only a PO Desk admin can do that.');
  }
}

function activeAdmins_() {
  return readTable('Users').rows.filter(u => u.role === 'admin' && isTrue_(u.active));
}

/** One person as the People screen shows them. Never a PIN, hash or token. */
function personView_(u, grantsByUser) {
  const now = Date.now();
  const expires = u.pin_token_expires ? new Date(u.pin_token_expires).getTime() : 0;
  const locked = u.locked_until ? new Date(u.locked_until).getTime() : 0;
  const g = grantsByUser[String(u.user_id)] || {};
  return {
    userId: u.user_id, name: String(u.name), email: String(u.email), role: u.role, active: isTrue_(u.active),
    hasPin: !!u.pin_hash, linkPending: !!u.pin_token_hash && expires > now, linkExpires: expires > now ? new Date(expires).toISOString() : '',
    locked: locked > now,
    companies: ENTITY_SEED.map(e => {
      const r = g[e.entity_id];
      return { entityId: e.entity_id, name: e.short_name, canBuy: !!r && isTrue_(r.can_buy), canApprove: !!r && isTrue_(r.can_approve), poLimitZar: r ? Number(r.po_limit_zar) || 0 : 0 };
    }),
  };
}

function grantsByUser_() {
  const out = {};
  readTable('UserEntities').rows.forEach(r => { (out[String(r.user_id)] = out[String(r.user_id)] || {})[r.entity_id] = r; });
  return out;
}

function actionListPeople_(req, ctx) {
  requireAdmin_(ctx);
  const g = grantsByUser_();
  const people = readTable('Users').rows
    .map(u => personView_(u, g))
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  return { people: people, companies: ENTITY_SEED.map(e => ({ entityId: e.entity_id, name: e.short_name })), meId: ctx.user.user_id };
}

/**
 * Adds a person (and emails their Set PIN link) or edits one. payload: { userId?, name, email, role,
 * companies: [{ entityId, canBuy, canApprove, poLimitZar }] }. Emails are unique; the last active
 * admin can't be demoted.
 */
function actionSavePerson_(req, ctx) {
  requireAdmin_(ctx);
  const p = req.payload;
  const name = String(p.name || '').replace(/\s+/g, ' ').trim();
  const email = normEmail_(p.email);
  const role = String(p.role || '');
  if (name.length < 2 || name.length > PEOPLE_RULES.NAME_MAX) throw new AppError('BAD_REQUEST', 'Enter the person’s full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new AppError('BAD_REQUEST', 'Enter a valid email address.');
  if (ROLES.indexOf(role) === -1) throw new AppError('BAD_REQUEST', 'Choose a role: buyer, approver or admin.');
  const wanted = {};
  (Array.isArray(p.companies) ? p.companies : []).forEach(c => {
    const ent = String(c && c.entityId || '').toUpperCase();
    if (!ENTITY_SEED.some(e => e.entity_id === ent)) throw new AppError('BAD_REQUEST', 'Unknown company.');
    const limit = parseAmount_(c.poLimitZar === '' || c.poLimitZar === null || c.poLimitZar === undefined ? 0 : c.poLimitZar);
    if (isNaN(limit) || limit < 0 || limit > PO_RULES.MAX_AMOUNT_ZAR) throw new AppError('BAD_REQUEST', 'Enter the ' + ent + ' limit in rand, e.g. 1500.');
    wanted[ent] = { canBuy: c.canBuy === true, canApprove: c.canApprove === true, limit: limit };
  });
  rateLimit_('people', ctx.user.user_id, 60, 3600);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  let user;
  let created = false;
  const changes = {};
  try {
    if (!fastRead_(['Users', 'UserEntities'], true)) { invalidateTable_('Users'); invalidateTable_('UserEntities'); }
    const existing = p.userId ? findBy('Users', 'user_id', str_(p.userId, 60))[0] : null;
    if (p.userId && !existing) throw new AppError('NOT_FOUND', 'Person not found.');
    const clash = findUserByEmail_(email);
    if (clash && (!existing || String(clash.user_id) !== String(existing.user_id))) throw new AppError('EMAIL_TAKEN', clash.name + ' already uses ' + email + '. Each person needs their own email.');
    if (existing && existing.role === 'admin' && role !== 'admin' && isTrue_(existing.active) && activeAdmins_().length <= 1) {
      throw new AppError('LAST_ADMIN', existing.name + ' is the only active admin. Make someone else an admin first.');
    }
    if (!existing) {
      user = {
        user_id: Utilities.getUuid(), name: name, email: email, pin_hash: '', pin_salt: '', role: role, active: true,
        failed_attempts: 0, locked_until: '', pin_token_hash: '', pin_token_expires: '', created_by: ctx.user.user_id, created_at: new Date(), sessions_valid_from: '',
      };
      appendRow('Users', user);
      created = true;
    } else {
      ['name', 'email', 'role'].forEach(k => { const v = { name: name, email: email, role: role }[k]; if (String(existing[k]) !== v) changes[k] = [String(existing[k]), v]; });
      if (Object.keys(changes).length) updateRowById('Users', 'user_id', existing.user_id, { name: name, email: email, role: role });
      user = findBy('Users', 'user_id', existing.user_id)[0];
    }
    invalidateTable_('UserEntities');
    const have = grantsByUser_()[String(user.user_id)] || {};
    Object.keys(wanted).forEach(ent => {
      const w = wanted[ent];
      const h = have[ent];
      const same = h && isTrue_(h.can_buy) === w.canBuy && isTrue_(h.can_approve) === w.canApprove && Number(h.po_limit_zar) === w.limit;
      if (same || (!h && !w.canBuy && !w.canApprove)) return;
      grantEntity_(user.user_id, ent, w.canBuy, w.canApprove, w.limit, true);
      changes[ent] = (h ? [isTrue_(h.can_buy) ? 'buy' : '-', isTrue_(h.can_approve) ? 'approve' : '-', Number(h.po_limit_zar) || 0].join('/') : 'none') + ' -> ' + [w.canBuy ? 'buy' : '-', w.canApprove ? 'approve' : '-', w.limit].join('/');
    });
  } finally {
    lock.releaseLock();
  }
  let emailed = null;
  if (created) emailed = issuePinLink_(user, ctx.user, 'welcome');
  auditLog({ userId: ctx.user.user_id, action: created ? 'user.create' : 'user.update', ok: true, ref: user.user_id, detail: { email: email, role: role, changes: created ? wanted : changes, linkEmailed: emailed } });
  invalidateTable_('UserEntities');
  return { person: personView_(findBy('Users', 'user_id', user.user_id)[0], grantsByUser_()), created: created, linkEmailed: emailed };
}

/** Emails a new single-use Set PIN link. The old PIN stops working at once and open sessions end. */
function actionResetPin_(req, ctx) {
  requireAdmin_(ctx);
  rateLimit_('pinlink', ctx.user.user_id, 20, 3600);
  const user = findBy('Users', 'user_id', str_(req.payload.userId, 60))[0];
  if (!user) throw new AppError('NOT_FOUND', 'Person not found.');
  if (!isTrue_(user.active)) throw new AppError('BAD_REQUEST', 'Reactivate ' + user.name + ' first.');
  const emailed = issuePinLink_(user, ctx.user, user.pin_hash ? 'reset' : 'welcome');
  auditLog({ userId: ctx.user.user_id, action: 'pin.link', ok: emailed, ref: user.user_id, detail: { reset: !!user.pin_hash, emailed: emailed } });
  return { person: personView_(findBy('Users', 'user_id', user.user_id)[0], grantsByUser_()), linkEmailed: emailed };
}

/** Deactivate (sessions end at once; POs and history stay) or reactivate. Not yourself; never the last admin. */
function actionSetPersonActive_(req, ctx) {
  requireAdmin_(ctx);
  const active = req.payload.active === true;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  let user;
  try {
    if (!fastRead_(['Users'], true)) invalidateTable_('Users');
    user = findBy('Users', 'user_id', str_(req.payload.userId, 60))[0];
    if (!user) throw new AppError('NOT_FOUND', 'Person not found.');
    if (!active && String(user.user_id) === String(ctx.user.user_id)) throw new AppError('BAD_REQUEST', 'You can’t deactivate yourself. Ask another admin.');
    if (!active && user.role === 'admin' && isTrue_(user.active) && activeAdmins_().length <= 1) throw new AppError('LAST_ADMIN', user.name + ' is the only active admin and can’t be deactivated.');
    const patch = { active: active };
    if (!active) patch.sessions_valid_from = new Date();
    updateRowById('Users', 'user_id', user.user_id, patch);
    user = findBy('Users', 'user_id', user.user_id)[0];
  } finally {
    lock.releaseLock();
  }
  auditLog({ userId: ctx.user.user_id, action: active ? 'user.reactivate' : 'user.deactivate', ok: true, ref: user.user_id, detail: { email: user.email } });
  return { person: personView_(user, grantsByUser_()) };
}

/**
 * New single-use link: a 64-hex-character random token, emailed; only its SHA-256 is stored, with a
 * 48-hour expiry. Clears the old PIN and ends open sessions (a reset means the old PIN is not trusted).
 */
function issuePinLink_(user, admin, kind) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const expires = new Date(Date.now() + PEOPLE_RULES.LINK_HOURS * 3600e3);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    invalidateTable_('Users');
    updateRowById('Users', 'user_id', user.user_id, {
      pin_token_hash: sha256Hex_(token), pin_token_expires: expires, pin_hash: '', pin_salt: '',
      failed_attempts: 0, locked_until: '', sessions_valid_from: new Date(),
    });
  } finally {
    lock.releaseLock();
  }
  resetLoginLimits_(user.email);
  const companies = ENTITY_SEED.filter(e => { const g = grantsFor_(user.user_id)[e.entity_id]; return g && (g.canBuy || g.canApprove); }).map(e => e.short_name);
  const link = appUrl_('/set-pin?t=' + token);
  const subject = kind === 'reset' ? 'PO Desk: set a new PIN' : 'PO Desk: set your PIN';
  const body = [
    'Hi ' + firstName_(user.name) + ',',
    '',
    kind === 'reset'
      ? firstName_(admin.name) + ' has reset your PO Desk PIN. Your old PIN no longer works.'
      : firstName_(admin.name) + ' has added you to PO Desk' + (companies.length ? ' for ' + companies.join(', ') : '') + '.',
    '',
    'Choose your 6-digit PIN here (the link works once, for ' + PEOPLE_RULES.LINK_HOURS + ' hours):',
    link,
    '',
    'Then sign in at ' + String(getConfig('APP_URL', 'https://po.pharmakaru.co.za/')) + ' with ' + user.email + ' and your PIN.',
    'If you didn’t expect this email, ignore it and tell ' + firstName_(admin.name) + '.',
  ].join('\n');
  return sendMail_(user.email, subject, body);
}

// --- Set PIN from the emailed link (public: the person isn't signed in) -----------------------

function userByPinToken_(token) {
  const invalid = new AppError('PIN_LINK_INVALID', 'This link has expired or was already used. Ask your PO Desk admin for a new one.');
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw invalid;
  const hash = sha256Hex_(token);
  const user = readTable('Users').rows.find(u => u.pin_token_hash && safeEqual_(String(u.pin_token_hash), hash));
  if (!user || !isTrue_(user.active) || !user.pin_token_expires || new Date(user.pin_token_expires).getTime() < Date.now()) throw invalid;
  return user;
}

function actionCheckPinToken_(req) {
  rateLimit_('pintoken', String(req.payload.token || '').slice(0, 16), 30, 900);
  const user = userByPinToken_(req.payload.token);
  return { firstName: firstName_(user.name), email: String(user.email) };
}

/** Saves the PIN (typed twice) and burns the link. */
function actionSetPinWithToken_(req) {
  const p = req.payload;
  const pin = String(p.pin === undefined ? '' : p.pin);
  rateLimit_('pinset', String(p.token || '').slice(0, 16), 10, 900);
  if (!/^\d{6}$/.test(pin)) throw new AppError('BAD_REQUEST', 'Your PIN must be exactly 6 digits.');
  if (String(p.pin2) !== pin) throw new AppError('BAD_REQUEST', 'The two PINs don’t match. Type the same PIN twice.');
  if (isWeakPin_(pin)) throw new AppError('BAD_REQUEST', 'That PIN is too easy to guess (repeated or sequential digits). Choose another.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let user;
  try {
    if (!fastRead_(['Users'], true)) invalidateTable_('Users');
    user = userByPinToken_(p.token);   // again inside the lock: the link works once
    const salt = newSalt_();
    updateRowById('Users', 'user_id', user.user_id, {
      pin_hash: hashPin_(salt, pin), pin_salt: salt, pin_token_hash: '', pin_token_expires: '', failed_attempts: 0, locked_until: '',
    });
  } finally {
    lock.releaseLock();
  }
  resetLoginLimits_(user.email);
  auditLog({ userId: user.user_id, action: 'pin.set', ok: true, detail: { by: 'link' } });
  return { email: String(user.email), firstName: firstName_(user.name) };
}
