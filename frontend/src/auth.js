// Session state. The token lives in sessionStorage (cleared when the tab or app is closed);
// the remembered email and nothing else lives in localStorage. The server re-checks every
// permission, so the chosen company here only decides what the screens show.
import { call, setToken } from './api.js';

const TOKEN_KEY = 'poDesk.token';
const COMPANY_KEY = 'poDesk.company';
const EMAIL_KEY = 'poDesk.email';

// Storage can throw (private mode, blocked site data); the app must still work without it.
function store(kind) {
  const mem = {};
  const s = () => { try { return window[kind]; } catch { return null; } };
  return {
    get: (k) => { try { const v = s() && s().getItem(k); return v === null || v === undefined ? (mem[k] ?? null) : v; } catch { return mem[k] ?? null; } },
    set: (k, v) => { mem[k] = v; try { s() && s().setItem(k, v); } catch { /* memory only */ } },
    del: (k) => { delete mem[k]; try { s() && s().removeItem(k); } catch { /* ignore */ } },
  };
}
const session = store('sessionStorage');
const local = store('localStorage');

let me = null;
const refCache = new Map();

/** 'ok' | 'signed-out' | 'offline' — offline keeps the token so a retry can still succeed. */
export async function restore() {
  const t = session.get(TOKEN_KEY);
  if (!t) return 'signed-out';
  setToken(t);
  try {
    me = await call('me');
    autoSelect();
    return 'ok';
  } catch (err) {
    if (err.code === 'AUTH_REQUIRED') { clear(); return 'signed-out'; }
    return 'offline';
  }
}

export async function login(email, pin) {
  const data = await call('login', { email, pin });
  session.set(TOKEN_KEY, data.token);
  setToken(data.token);
  me = data.me;
  local.set(EMAIL_KEY, String(email).trim());
  session.del(COMPANY_KEY);
  autoSelect();
  return me;
}

export async function logout() {
  try { await call('logout'); } catch { /* signing out locally is what matters */ }
  clear();
}

export function clear() {
  session.del(TOKEN_KEY);
  session.del(COMPANY_KEY);
  setToken('');
  me = null;
  refCache.clear();
}

export const isSignedIn = () => !!me;
export const getMe = () => me;
export const rememberedEmail = () => local.get(EMAIL_KEY) || '';
export const buyCompanies = () => (me ? me.companies.filter((c) => c.canBuy) : []);

export function selectedCompany() {
  const id = session.get(COMPANY_KEY);
  return buyCompanies().find((c) => c.entityId === id) || null;
}

export function selectCompany(entityId) {
  if (!buyCompanies().some((c) => c.entityId === entityId)) throw new Error('Not a company you can buy for.');
  session.set(COMPANY_KEY, entityId);
}

/** True when the user must pick before Home makes sense. */
export const needsCompanyChoice = () => buyCompanies().length > 1 && !selectedCompany();

function autoSelect() {
  const list = buyCompanies();
  if (list.length === 1) session.set(COMPANY_KEY, list[0].entityId);
}

/** Adds a supplier created on the New PO screen to this session's copy of the list. */
export async function addSupplier(entityId, supplier) {
  if (!refCache.has(entityId)) return;
  const d = await refCache.get(entityId);
  if (!d.suppliers.some((s) => s.contactId === supplier.contactId)) {
    d.suppliers.push(supplier);
    d.suppliers.sort((a, b) => a.name.localeCompare(b.name));
  }
}

// The payment method used last time, per company: a convenience only, kept on this device.
export const lastPm = (entityId) => local.get('poDesk.lastPm.' + entityId) || '';
export const setLastPm = (entityId, pmId) => local.set('poDesk.lastPm.' + entityId, pmId);

/** Reference data for one company, fetched once per session. */
export async function refData(entityId) {
  if (!refCache.has(entityId)) {
    const p = call('refData', { entityId }).catch((err) => { refCache.delete(entityId); throw err; });
    refCache.set(entityId, p);
  }
  return refCache.get(entityId);
}
