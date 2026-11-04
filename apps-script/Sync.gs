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

/** Trigger handler (02:00 daily). A second trigger, or a second run the same day, does nothing. */
function nightlySync() {
  if (!claimDailyRun_('sync')) { console.log('nightlySync: already ran today.'); return 'already ran today'; }
  return syncAll();
}

/**
 * Fetches every company from Xero and rewrites the cached tabs. Run from the editor any time; two
 * runs never overlap (a second one started meanwhile just stops), because both would rewrite the
 * same rows.
 */
function syncAll() {
  if (!claimRunning_('syncAll', 10 * 60)) { console.log('syncAll: another sync is running; this one stops.'); return 'another sync is running'; }
  try {
    return syncAllNow_();
  } finally {
    CacheService.getScriptCache().remove('running:syncAll');
  }
}

/** Marks a long job as running (under the lock), so an overlapping start can step aside. */
function claimRunning_(name, ttlS) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return false;
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('running:' + name)) return false;
    cache.put('running:' + name, String(Date.now()), ttlS);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function syncAllNow_() {
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

// --- Stage 4: retry queue (time trigger every 5 minutes; installQueueTrigger in Setup.gs) ------

const QUEUE_RULES = Object.freeze({
  MAX_ATTEMPTS: 12,                 // about 8 hours of backoff before an admin is emailed
  BUDGET_MS: 4 * 60 * 1000,
  MAX_WAIT_MIN: 60,
});

/**
 * Trigger handler, every 5 minutes: retries queued Xero work, then sends approval reminders that are
 * due. Both are safe with two triggers installed: queue jobs are leased under the lock, and a
 * reminder is marked sent under the lock before it goes out.
 */
function processQueue() {
  const summary = processQueueJobs_();
  try {
    const reminded = sendApprovalReminders_();
    if (reminded.length) console.log('Approval reminders: ' + reminded.join('; '));
  } catch (err) {
    console.error('Approval reminders failed: ' + err.message);
  }
  return summary;
}

function processQueueJobs_() {
  const started = Date.now();
  const lock = LockService.getScriptLock();

  // 1. Claim due jobs under a short lock: a 15-minute lease keeps an overlapping run off them.
  if (!lock.tryLock(10000)) { console.log('processQueue: lock busy; skipping this run.'); return; }
  let claimed = [];
  try {
    invalidateTable_('Queue');
    const now = new Date();
    // Jobs that gave up have a blank next_run_at and are left for an admin.
    const due = readTable('Queue').rows.filter(j => j.job_id && j.next_run_at !== '' && new Date(j.next_run_at) <= now);
    const lease = new Date(now.getTime() + 15 * 60000);
    due.forEach(j => updateRowById('Queue', 'job_id', j.job_id, { next_run_at: lease }));
    claimed = due.map(j => ({ job_id: j.job_id, type: j.type, payload_json: j.payload_json, attempts: Number(j.attempts) || 0 }));
  } finally {
    lock.releaseLock();
  }
  if (!claimed.length) return [];

  // 2. Do the work WITHOUT the lock, so a buyer's createPO never waits behind a Xero call here.
  const results = [];
  claimed.forEach(job => {
    if (Date.now() - started > QUEUE_RULES.BUDGET_MS) { results.push({ job: job.job_id, type: job.type, skipped: true }); return; }
    try {
      results.push({ job: job.job_id, type: job.type, ok: true, result: runQueueJob_(job) });
    } catch (err) {
      results.push({ job: job.job_id, type: job.type, ok: false, attempts: job.attempts + 1, error: err.message, payload: job.payload_json });
    }
  });

  // 3. Record outcomes under a short lock.
  const giveUps = [];
  lock.waitLock(20000);
  try {
    invalidateTable_('Queue');
    const rows = readTable('Queue').rows;
    const doneRows = [];
    results.forEach(r => {
      const row = rows.find(x => x.job_id === r.job);
      if (!row) return;
      if (r.ok) { doneRows.push(row._row); return; }
      if (r.skipped) { updateRowById('Queue', 'job_id', r.job, { next_run_at: new Date() }); return; }
      const giveUp = r.attempts >= QUEUE_RULES.MAX_ATTEMPTS;
      const waitMin = Math.min(QUEUE_RULES.MAX_WAIT_MIN, 5 * Math.pow(2, r.attempts - 1));
      updateRowById('Queue', 'job_id', r.job, {
        attempts: r.attempts,
        next_run_at: giveUp ? '' : new Date(Date.now() + waitMin * 60000),
        last_error: (giveUp ? 'GAVE UP: ' : '') + truncate_(r.error, 300),
      });
      if (giveUp) giveUps.push(r);
    });
    // Bottom-up so earlier row numbers stay valid while deleting.
    doneRows.sort((a, b) => b - a).forEach(n => sheet_('Queue').deleteRow(n));
    invalidateTable_('Queue');
  } finally {
    lock.releaseLock();
  }
  giveUps.forEach(r => alertAdmins_('a queued job gave up', 'Job ' + r.job + ' (' + r.type + ') failed ' + r.attempts + ' times.\nLast error: ' + r.error + '\nPayload: ' + r.payload));

  const summary = results.map(r => ({ job: r.job, type: r.type, ok: !!r.ok, result: r.result, error: r.error, skipped: r.skipped }));
  auditLog({ action: 'queue.run', ok: results.every(r => r.ok), detail: { ms: Date.now() - started, results: summary } });
  console.log('processQueue ' + JSON.stringify(summary, null, 2));
  return summary;
}

function runQueueJob_(job) {
  let payload;
  try { payload = JSON.parse(job.payload_json); } catch (err) { throw new AppError('BAD_JOB', 'Unreadable payload.'); }
  if (job.type === 'createPO') return finishProvisionalPO_(payload);
  if (job.type === 'billSteps') return finishBillSteps_(payload);
  throw new AppError('BAD_JOB', 'Unknown job type ' + job.type + '.');
}

/**
 * Carries on with a bill whose steps didn't all finish when the buyer submitted it (Main.gs
 * runBillSteps_). Throws while something is left, so the queue retries with backoff and emails an
 * admin if it gives up. A bill Xero refused is not retried: the buyer is asked to correct it.
 */
function finishBillSteps_(payload) {
  const r = runBillSteps_(String(payload.billId || ''), {});
  if (r.status === 'GONE') return 'bill row gone; nothing to do';
  if (r.rejected) return 'Xero refused the bill; the buyer was asked to correct it: ' + r.rejected;
  if (r.status !== BILL_STATUS.BILLED) throw new AppError('BILL_PENDING', 'Still to do: ' + r.pending.join(', ') + (r.error ? ' (' + r.error + ')' : ''));
  return 'bill ' + r.reference + ' complete';
}

/** Turns a PENDING_XERO row into a real Xero PO, then tells the buyer (and approvers if needed). */
function finishProvisionalPO_(payload) {
  invalidateTable_('POs');
  const po = findBy('POs', 'po_id', payload.poId)[0];
  if (!po) return 'PO row gone; nothing to do';
  if (po.status !== PO_STATUS.PENDING_XERO) return 'already ' + po.status;
  const ent = entityById_(po.entity_id).entity_id;
  const pm = readTable('PaymentMethods').rows.find(r => r.pm_id === po.pm_id);
  const buyer = findBy('Users', 'user_id', po.buyer_user_id)[0];
  if (!pm || !buyer) throw new AppError('BAD_JOB', 'Payment method or buyer missing for ' + po.po_id + '.');
  const xeroStatus = payload.xeroStatus === 'SUBMITTED' ? 'SUBMITTED' : 'AUTHORISED';
  const ctx = { userId: buyer.user_id, ref: po.po_id };

  // The first attempt may have reached Xero even though its answer was lost; adopt that PO rather
  // than creating a second one for the same purchase.
  let xeroPo = findOrphanXeroPo_(po, pm, buyer, ctx);
  const adopted = !!xeroPo;
  if (!xeroPo) xeroPo = createXeroPo_(po, pm, buyer.name, xeroStatus, po.provisional_ref, ctx);

  const status = xeroStatus === 'SUBMITTED' ? PO_STATUS.AWAITING_APPROVAL : PO_STATUS.ISSUED;
  // The POs tab is shared with createPO, so the write (only) happens under the lock.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let fresh;
  try {
    invalidateTable_('POs');
    const cur = findBy('POs', 'po_id', po.po_id)[0];
    if (!cur || cur.status !== PO_STATUS.PENDING_XERO) return 'already ' + (cur ? cur.status : 'gone') + ' (Xero PO ' + xeroPo.PurchaseOrderNumber + ' left as is)';
    updateRowById('POs', 'po_id', po.po_id, { xero_po_id: xeroPo.PurchaseOrderID, po_number: xeroPo.PurchaseOrderNumber, status: status });
    fresh = findBy('POs', 'po_id', po.po_id)[0];
  } finally {
    lock.releaseLock();
  }
  notifyBuyerConverted_(fresh, buyer);
  if (status === PO_STATUS.AWAITING_APPROVAL) {
    const acct = getRefData(ent).accounts.find(a => String(a.code) === String(po.account_code));
    notifyApprovers_(fresh, buyer, acct);
  }
  auditLog({ userId: buyer.user_id, entityId: ent, action: 'po.provisional_converted', ok: true, ref: po.po_id, detail: { from: po.provisional_ref, to: xeroPo.PurchaseOrderNumber, adopted: adopted } });
  return po.provisional_ref + ' -> ' + xeroPo.PurchaseOrderNumber + (adopted ? ' (adopted existing Xero PO)' : '');
}

/** A Xero PO from the PO's date with the same supplier, total and reference prefix, if one exists. */
function findOrphanXeroPo_(po, pm, buyer, ctx) {
  const t = entityById_(po.entity_id).xero_tenant_id;
  const date = Utilities.formatDate(po.created_at instanceof Date ? po.created_at : new Date(po.created_at), APP.TZ, 'yyyy-MM-dd');
  const refPrefix = poReference_(pm, buyer.name, '');
  const hit = xeroListPurchaseOrdersByDate(t, date, date, ctx).find(x =>
    x.Status !== 'DELETED' &&
    x.Contact && x.Contact.ContactID === po.contact_id &&
    Math.abs(Number(x.Total) - Number(po.amount_incl_zar)) < 0.005 &&
    String(x.Reference || '').indexOf(refPrefix) === 0 &&
    !readTable('POs').rows.some(r => r.xero_po_id === x.PurchaseOrderID));
  return hit || null;
}
