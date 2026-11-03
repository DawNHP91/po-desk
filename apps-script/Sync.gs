/**
 * Sync.gs — pulls each company's reference data from Xero into the Sheet and CacheService.
 *
 * Runs nightly (installSyncTrigger in Setup.gs) so the PO hot path never spends Composio calls on
 * lookups. Each company is fetched completely BEFORE anything is written, so a failure or timeout
 * leaves yesterday's data intact instead of a half-replaced chart.
 */

const SYNC_TIME_BUDGET_MS = 5.5 * 60 * 1000;   // Apps Script kills executions at 6 minutes.
const SYNC_MIN_MS_PER_ENTITY = 75 * 1000;      // Don't start a company with less than this left.
const BILL_HISTORY_MONTHS = 12;
const REF_CACHE_TTL_S = 21600;                 // CacheService maximum (6 h); misses rebuild from the Sheet.
const CACHE_CHUNK_CHARS = 30000;               // ≤ 90 KB even if every char took 3 bytes in UTF-8.
const CACHE_CHUNK_THRESHOLD_BYTES = 90 * 1024;

function syncAll() {
  const started = Date.now();
  const deadline = started + SYNC_TIME_BUDGET_MS;
  const callsBefore = composioStats_.calls;
  const results = [];
  const fetched = {};

  // Fetch every company first, so the cross-company ID check below compares fresh data with fresh data.
  ENTITY_SEED.forEach(e => {
    if (deadline - Date.now() < SYNC_MIN_MS_PER_ENTITY) {
      results.push({ entity: e.entity_id, ok: false, error: 'skipped: not enough time left in this run' });
      return;
    }
    try {
      fetched[e.entity_id] = fetchEntity_(e.entity_id, deadline);
    } catch (err) {
      results.push({ entity: e.entity_id, ok: false, error: err.message });
      console.error('fetch ' + e.entity_id + ' failed: ' + err.message);
    }
  });

  const leaks = isolationProblems_(fetched);
  Object.keys(fetched).forEach(ent => {
    if (leaks[ent]) {
      results.push({ entity: ent, ok: false, error: 'NOT WRITTEN: ' + leaks[ent] });
      console.error('TENANT LEAK ' + ent + ': ' + leaks[ent]);
      return;
    }
    try {
      results.push(Object.assign({ entity: ent, ok: true }, writeEntity_(ent, fetched[ent])));
    } catch (err) {
      results.push({ entity: ent, ok: false, error: err.message });
    }
  });

  const summary = { totalMs: Date.now() - started, composioCalls: composioStats_.calls - callsBefore, results: results };
  PropertiesService.getScriptProperties().setProperty('SYNC_LAST', JSON.stringify({ at: new Date().toISOString(), summary: summary }));
  auditLog({ action: 'sync.all', ok: results.length === ENTITY_SEED.length && results.every(r => r.ok), detail: summary });
  console.log('syncAll ' + JSON.stringify(summary, null, 2));
  return summary;
}

/** One company on its own: its fresh IDs are checked against the other companies' rows in the Sheet. */
function syncEntity(entityId, opts) {
  const ent = entityById_(entityId).entity_id;
  const f = fetchEntity_(ent, (opts && opts.deadline) || (Date.now() + SYNC_TIME_BUDGET_MS));
  const others = {};
  ENTITY_SEED.filter(e => e.entity_id !== ent).forEach(e => {
    others[e.entity_id] = {
      accountRows: readTable('Accounts').rows.filter(r => r.entity_id === e.entity_id),
      supplierRows: readTable('Suppliers').rows.filter(r => r.entity_id === e.entity_id),
    };
  });
  others[ent] = f;
  const leaks = isolationProblems_(others);
  if (leaks[ent]) throw new AppError('TENANT_LEAK', ent + ' not written: ' + leaks[ent]);
  return writeEntity_(ent, f);
}

function fetchEntity_(entityId, deadline) {
  const e = entityById_(entityId);
  const t = e.xero_tenant_id;
  const ctx = { ref: 'sync:' + e.entity_id };
  const t0 = Date.now();
  const callsBefore = composioStats_.calls;
  const now = new Date();

  const accounts = xeroListAccounts(t, 'Status=="ACTIVE"', ctx);
  const taxRates = xeroListTaxRates(t, null, ctx);
  const contacts = xeroListAllContacts(t, { ctx: ctx, deadline: deadline });
  const since = new Date(now.getTime());
  since.setMonth(since.getMonth() - BILL_HISTORY_MONTHS);
  const where = 'Type=="ACCPAY" AND Date>=DateTime(' + Utilities.formatDate(since, APP.TZ, 'yyyy,MM,dd') + ')';
  const bills = xeroListAllPages('XERO_LIST_INVOICES', t, { where: where, Statuses: 'SUBMITTED,AUTHORISED,PAID' }, 'Invoices', { ctx: ctx, deadline: deadline, tenantParam: 'tenantId' });

  const accountRows = accounts.map(a => ({
    entity_id: e.entity_id, account_id: a.AccountID, code: a.Code || '', name: a.Name, type: a.Type,
    class: a.Class, tax_type: a.TaxType || '', status: a.Status, synced_at: now,
  }));
  const taxRows = taxRates.map(r => ({
    entity_id: e.entity_id, tax_type: r.TaxType, name: r.Name,
    rate: r.DisplayTaxRate !== undefined ? r.DisplayTaxRate : r.EffectiveRate, status: r.Status, synced_at: now,
  }));
  // Xero only flags IsSupplier once a contact has a bill, so contacts flagged as neither customer nor
  // supplier (e.g. new ones) are kept too. Archived contacts are not offered to buyers.
  const supplierRows = contacts
    .filter(c => c.ContactStatus !== 'ARCHIVED' && (c.IsSupplier === true || c.IsCustomer !== true))
    .map(c => ({ entity_id: e.entity_id, contact_id: c.ContactID, name: c.Name, vat_number: c.TaxNumber || '', synced_at: now }));

  const events = billEvents_(bills).concat(openPoEvents_(e.entity_id));
  const historyRows = buildSupplierHistory_(events, Number(getConfig('SUPPLIER_HISTORY_N', 5)))
    .map(h => Object.assign({ entity_id: e.entity_id }, h));

  const supplierIds = {};
  supplierRows.forEach(r => { supplierIds[r.contact_id] = true; });
  return {
    accountRows: accountRows, taxRows: taxRows, supplierRows: supplierRows, historyRows: historyRows,
    stats: {
      fetchMs: Date.now() - t0, composioCalls: composioStats_.calls - callsBefore,
      accounts: accountRows.length, taxRates: taxRows.length, contactsFetched: contacts.length, suppliers: supplierRows.length,
      billsScanned: bills.length, billsWithoutCodes: bills.filter(b => !(b.LineItems || []).some(l => l.AccountCode)).length,
      historyRows: historyRows.length,
      suppliersWithHistory: Object.keys(historyRows.reduce((m, r) => { m[r.contact_id] = 1; return m; }, {})).length,
      // Bills come from a tenant-safe tool; if their suppliers are mostly missing from the contact
      // list, the contacts probably came from the wrong org.
      billSuppliersInContactList: uniq_(historyRows.map(r => r.contact_id)).filter(id => supplierIds[id]).length,
    },
  };
}

function writeEntity_(ent, f) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    replaceEntityRows_('Accounts', ent, f.accountRows);
    replaceEntityRows_('TaxRates', ent, f.taxRows);
    replaceEntityRows_('Suppliers', ent, f.supplierRows);
    replaceEntityRows_('SupplierHistory', ent, f.historyRows);
  } finally {
    lock.releaseLock();
  }
  const version = putRefCache_(ent, { accounts: f.accountRows, taxRates: f.taxRows, suppliers: f.supplierRows });
  const res = Object.assign({ cacheVersion: version }, f.stats);
  auditLog({ entityId: ent, action: 'sync.entity', ok: true, detail: res });
  return res;
}

/**
 * Xero AccountIDs and ContactIDs are unique per organisation, so the same ID under two companies
 * means a tool answered from the wrong org. Returns { ENT: problem } for every company involved.
 */
function isolationProblems_(byEntity) {
  const owner = {};
  const problems = {};
  const note = (ent, msg) => { problems[ent] = problems[ent] ? problems[ent] : msg; };
  Object.keys(byEntity).forEach(ent => {
    const f = byEntity[ent];
    [['account', (f.accountRows || []).map(r => r.account_id)], ['contact', (f.supplierRows || []).map(r => r.contact_id)]].forEach(pair => {
      pair[1].forEach(id => {
        const key = pair[0] + ':' + id;
        if (owner[key] && owner[key] !== ent) {
          note(ent, pair[0] + ' ' + id + ' also appears under ' + owner[key]);
          note(owner[key], pair[0] + ' ' + id + ' also appears under ' + ent);
        } else owner[key] = ent;
      });
    });
  });
  return problems;
}

// --- Supplier history ------------------------------------------------------------------------

/** One event per coded bill: { contactId, date, codes[] }. A multi-code bill keeps all its codes. */
function billEvents_(bills) {
  const out = [];
  bills.forEach(b => {
    const contactId = b.Contact && b.Contact.ContactID;
    const codes = uniq_((b.LineItems || []).map(l => String(l.AccountCode || '').trim()).filter(Boolean));
    const date = xeroDate_(b.DateString || b.Date);
    if (contactId && codes.length && date) out.push({ contactId: contactId, date: date, codes: codes });
  });
  return out;
}

/**
 * POs coded in PO Desk but not yet billed. Without these, the nightly rebuild from Xero bills would
 * forget every choice made since the last bill. BILLED POs are excluded: their bill is already counted.
 */
function openPoEvents_(entityId) {
  let rows = [];
  try { rows = readTable('POs').rows; } catch (err) { return []; }
  return rows
    .filter(r => r.entity_id === entityId && r.contact_id && r.account_code && ['ISSUED', 'AWAITING_APPROVAL', 'PENDING_XERO'].indexOf(r.status) !== -1)
    .map(r => ({ contactId: String(r.contact_id), date: r.created_at instanceof Date ? r.created_at : new Date(r.created_at), codes: [String(r.account_code)] }))
    .filter(ev => !isNaN(ev.date.getTime()));
}

/**
 * Keeps only each supplier's last N coded purchases, so "one row for this supplier" means
 * "the last N purchases all used one code" — the rule suggestAccount() applies.
 * Returns [{ contact_id, account_code, uses, last_used }].
 */
function buildSupplierHistory_(events, n) {
  const bySupplier = {};
  events.forEach(ev => { (bySupplier[ev.contactId] = bySupplier[ev.contactId] || []).push(ev); });
  const rows = [];
  Object.keys(bySupplier).forEach(contactId => {
    const recent = bySupplier[contactId].sort((a, b) => b.date - a.date).slice(0, n);
    const tally = {};
    recent.forEach(ev => ev.codes.forEach(code => {
      const t = tally[code] || (tally[code] = { uses: 0, last: ev.date });
      t.uses++;
      if (ev.date > t.last) t.last = ev.date;
    }));
    Object.keys(tally).forEach(code => rows.push({ contact_id: contactId, account_code: code, uses: tally[code].uses, last_used: tally[code].last }));
  });
  return rows;
}

function xeroDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const ms = /\/Date\((\d+)/.exec(String(v));
  if (ms) return new Date(Number(ms[1]));
  const d = new Date(String(v).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

function uniq_(arr) {
  return arr.filter((x, i) => arr.indexOf(x) === i);
}

// --- Sheet writes ----------------------------------------------------------------------------

/** Replaces one company's rows in a shared table with a single clear + setValues. Caller holds the lock. */
function replaceEntityRows_(name, entityId, newRows) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const ei = headers.indexOf('entity_id');
  if (ei === -1) throw new AppError('DB_SCHEMA', name + ' has no entity_id column.');
  const existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues() : [];
  // Re-guard kept rows: values read back as plain text would become formulas again on setValues.
  const keep = existing.filter(r => String(r[ei]) !== entityId && r.some(c => c !== '')).map(r => r.map(cell_));
  const all = keep.concat(newRows.map(o => headers.map(h => cell_(o[h]))));
  if (existing.length) sh.getRange(2, 1, existing.length, headers.length).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, headers.length).setValues(all);
  invalidateTable_(name);
}

// --- Reference-data cache --------------------------------------------------------------------
// Keys: ref:<ENT>:<version>:n (chunk count) and ref:<ENT>:<version>:<i>. A sync writes a new
// version, so stale chunks are never read and simply expire.

function getRefData(entityId) {
  const ent = entityById_(entityId).entity_id;
  const props = PropertiesService.getScriptProperties();
  let version = props.getProperty('REFVER_' + ent);
  if (version) {
    const hit = cacheGetJson_('ref:' + ent + ':' + version);
    if (hit) return Object.assign({ version: version, fromCache: true }, hit);
  }
  // Cache expired (6 h max) or never built: rebuild from the Sheet, not from Xero.
  const data = {
    accounts: readTable('Accounts').rows.filter(r => r.entity_id === ent),
    taxRates: readTable('TaxRates').rows.filter(r => r.entity_id === ent),
    suppliers: readTable('Suppliers').rows.filter(r => r.entity_id === ent),
  };
  version = putRefCache_(ent, data, version);
  return Object.assign({ version: version, fromCache: false }, data);
}

function putRefCache_(entityId, data, keepVersion) {
  const version = keepVersion || String(Date.now());
  cachePutJson_('ref:' + entityId + ':' + version, data);
  if (!keepVersion) PropertiesService.getScriptProperties().setProperty('REFVER_' + entityId, version);
  return version;
}

function invalidateRefCache(entityId) {
  PropertiesService.getScriptProperties().deleteProperty('REFVER_' + entityById_(entityId).entity_id);
}

function cachePutJson_(key, obj) {
  const json = JSON.stringify(obj);
  const chunks = chunkString_(json);
  const map = {};
  map[key + ':n'] = String(chunks.length);
  chunks.forEach((c, i) => { map[key + ':' + i] = c; });
  try {
    CacheService.getScriptCache().putAll(map, REF_CACHE_TTL_S);
  } catch (err) {
    // A full cache must never break a sync: callers fall back to the Sheet.
    console.warn('cachePutJson_ ' + key + ' failed: ' + err.message);
  }
}

function cacheGetJson_(key) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key + ':n'));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = cache.getAll(keys);
  if (keys.some(k => typeof got[k] !== 'string')) return null;   // a chunk was evicted
  try { return JSON.parse(keys.map(k => got[k]).join('')); } catch (err) { return null; }
}

/** Splits only when the UTF-8 size is over 90 KB; chunk size guarantees each piece fits in 100 KB. */
function chunkString_(s) {
  if (Utilities.newBlob(s).getBytes().length <= CACHE_CHUNK_THRESHOLD_BYTES) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += CACHE_CHUNK_CHARS) out.push(s.slice(i, i + CACHE_CHUNK_CHARS));
  return out;
}
