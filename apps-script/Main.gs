/**
 * Main.gs — web app entry points and the action handlers for Flow 1 (raise a PO).
 *
 * The browser sends POST with Content-Type text/plain so it is a "simple" CORS request:
 * Apps Script cannot answer an OPTIONS preflight, so JSON content types would fail.
 */

// Handlers get (req, ctx); ctx is the verified session ({ user, grants, t0, authMs }) and is null
// only for public routes. Wrapped in arrows so functions in other files are looked up at call time.
const ROUTES = {
  ping: { public: true, fn: () => ({ pong: true, version: APP.VERSION }) },
  login: { public: true, fn: (req) => actionLogin_(req) },
  logout: { public: true, fn: (req) => actionLogout_(req) },
  me: { fn: (req, ctx) => actionMe_(req, ctx) },
  refData: { fn: (req, ctx) => actionRefData_(req, ctx) },
  suggest: { fn: (req, ctx) => actionSuggest_(req, ctx) },
  createSupplier: { fn: (req, ctx) => actionCreateSupplier_(req, ctx) },
  createPO: { fn: (req, ctx) => actionCreatePO_(req, ctx) },
  listPOs: { fn: (req, ctx) => actionListPOs_(req, ctx) },
  getPO: { fn: (req, ctx) => actionGetPO_(req, ctx) },
};

const PO_STATUS = Object.freeze({
  ISSUED: 'ISSUED', AWAITING_APPROVAL: 'AWAITING_APPROVAL', DECLINED: 'DECLINED',
  PENDING_XERO: 'PENDING_XERO', BILLED: 'BILLED', CANCELLED: 'CANCELLED',
});

const PO_RULES = Object.freeze({
  MAX_AMOUNT_ZAR: 1000000,
  MAX_DESCRIPTION: 200,
  RATE_MAX: 20,            // POs per user per window
  RATE_WINDOW_S: 600,
  LOCK_WAIT_MS: 20000,
});

function doGet() {
  return json_({ ok: true, version: APP.VERSION });
}

function doPost(e) {
  const t0 = Date.now();
  let envelope;
  try {
    const req = parseRequest_(e);
    const route = Object.prototype.hasOwnProperty.call(ROUTES, req.action) ? ROUTES[req.action] : null;
    if (!route) throw new AppError('UNKNOWN_ACTION', 'Unknown action.');
    const ctx = route.public ? null : requireSession_(req.token);
    if (ctx) { ctx.t0 = t0; ctx.authMs = Date.now() - t0; }
    envelope = { ok: true, data: route.fn(req, ctx) };
  } catch (err) {
    envelope = { ok: false, error: publicError_(err) };
  }
  return json_(envelope);
}

function parseRequest_(e) {
  const raw = e && e.postData && e.postData.contents;
  if (!raw) throw new AppError('BAD_REQUEST', 'Empty request.');
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new AppError('BAD_REQUEST', 'Request is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
    throw new AppError('BAD_REQUEST', 'Missing action.');
  }
  return {
    action: body.action,
    token: typeof body.token === 'string' ? body.token : '',
    payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {},
    idemKey: typeof body.idemKey === 'string' ? body.idemKey : '',
  };
}

/** Only AppErrors carry a message to the browser; anything else is logged server-side and hidden. */
function publicError_(err) {
  if (err instanceof AppError) {
    console.warn('AppError ' + err.code + ': ' + err.message);
    return { code: err.code, message: err.message };
  }
  console.error('Unhandled: ' + (err && err.stack ? err.stack : err));
  return { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// --- suggest ---------------------------------------------------------------------------------

function actionSuggest_(req, ctx) {
  const ent = requireBuyer_(ctx, req.payload.entityId);
  const p = req.payload;
  const s = suggestAccount(ent, str_(p.contactId, 60), str_(p.categoryId, 60), str_(p.description, PO_RULES.MAX_DESCRIPTION));
  return { accountCode: s.accountCode, accountName: s.accountName, taxType: s.taxType, source: s.source, reason: s.reason, needsReview: s.needsReview };
}

// --- createSupplier --------------------------------------------------------------------------

/**
 * Finds the supplier before creating one: first the synced list, then Xero itself (archived
 * contacts included, because Xero refuses a second contact with the same name). An archived match
 * is switched back on rather than duplicated.
 */
function actionCreateSupplier_(req, ctx) {
  const ent = requireBuyer_(ctx, req.payload.entityId);
  const name = String(req.payload.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2) throw new AppError('BAD_REQUEST', 'Enter the supplier’s name.');
  if (name.length > 100) throw new AppError('BAD_REQUEST', 'Keep the supplier name under 100 characters.');
  const vat = String(req.payload.vatNumber || '').replace(/\s+/g, '');
  if (vat && !/^4\d{9}$/.test(vat)) throw new AppError('BAD_REQUEST', 'A South African VAT number is 10 digits starting with 4.');
  rateLimit_('supplier', ctx.user.user_id, 20, 3600);

  const key = normName_(name);
  const xctx = { userId: ctx.user.user_id, ref: 'supplier:' + key.slice(0, 40) };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  try {
    const cached = getRefData(ent).suppliers.find(s => normName_(s.name) === key);
    if (cached) return { supplier: { contactId: cached.contact_id, name: String(cached.name) }, existing: true, reactivated: false };

    const t = entityById_(ent).xero_tenant_id;
    const matches = xeroSearchContacts(t, name, xctx).filter(c => normName_(c.Name) === key);
    let contact;
    let existing = false;
    let reactivated = false;
    if (matches.length) {
      contact = matches.find(c => c.ContactStatus === 'ACTIVE') || matches[0];
      existing = true;
      if (contact.ContactStatus === 'ARCHIVED') {
        xeroSetContactStatus(t, contact.ContactID, 'ACTIVE', xctx);
        reactivated = true;
      }
    } else {
      const fields = { Name: name, IsSupplier: true };
      if (vat) fields.TaxNumber = vat;
      const created = xeroCreateContact(t, fields, xctx);
      if (!created || !created.ContactID) throw new AppError('XERO_FAILED', 'Xero did not return the new supplier.');
      // A Composio tool once answered from the wrong organisation (XERO_GET_CONTACTS), so prove the
      // new contact really exists in THIS company before anyone raises a PO against it.
      let check = null;
      try { check = xeroGetContactById(t, created.ContactID, xctx); } catch (err) { check = null; }
      if (!check || check.ContactID !== created.ContactID) {
        auditLog({ userId: ctx.user.user_id, entityId: ent, action: 'supplier.tenant_mismatch', ok: false, detail: { contactId: created.ContactID } });
        throw new AppError('TENANT_LEAK', 'The new supplier could not be confirmed in ' + ent + '’s Xero. Please tell your PO Desk admin.');
      }
      contact = check;
    }
    addSupplierToRef_(ent, contact);
    auditLog({ userId: ctx.user.user_id, entityId: ent, action: 'supplier.create', ok: true, ref: contact.ContactID, detail: { existing: existing, reactivated: reactivated } });
    return { supplier: { contactId: contact.ContactID, name: String(contact.Name) }, existing: existing, reactivated: reactivated };
  } finally {
    lock.releaseLock();
  }
}

/** Adds a contact to the Suppliers tab and the cached reference data, so it is usable immediately. */
function addSupplierToRef_(ent, contact) {
  const ref = getRefData(ent);
  if (ref.suppliers.some(s => s.contact_id === contact.ContactID)) return;
  const row = { entity_id: ent, contact_id: contact.ContactID, name: contact.Name, vat_number: contact.TaxNumber || '', synced_at: new Date() };
  appendRow('Suppliers', row);
  putRefCache_(ent, { accounts: ref.accounts, taxRates: ref.taxRates, suppliers: ref.suppliers.concat([row]) });
}

// --- createPO --------------------------------------------------------------------------------

/**
 * Flow 1 step 4–6. Everything the browser sends is re-checked against server data; the company,
 * supplier, payment method and account must all belong to that company. The idemKey makes a
 * double-tapped or re-sent Submit return the first PO instead of creating a second one.
 */
function actionCreatePO_(req, ctx) {
  const T = stepTimer_(ctx);
  const ent = requireBuyer_(ctx, req.payload.entityId);
  const p = req.payload;
  const idemKey = req.idemKey;
  if (!isUuid_(idemKey)) throw new AppError('BAD_REQUEST', 'This form is out of date. Reload the page and try again.');

  const data = codingData_(ent);
  const pm = readTable('PaymentMethods').rows.find(r => r.pm_id === p.pmId && r.entity_id === ent && isTrue_(r.active));
  if (!pm) throw new AppError('BAD_REQUEST', 'Choose how you’re paying.');
  const supplier = data.suppliers.find(s => s.contact_id === p.contactId);
  if (!supplier) throw new AppError('BAD_REQUEST', 'Choose a supplier from the list, or add a new one.');
  const description = String(p.description || '').replace(/\s+/g, ' ').trim();
  if (description.length < 2) throw new AppError('BAD_REQUEST', 'Say what you’re buying.');
  if (description.length > PO_RULES.MAX_DESCRIPTION) throw new AppError('BAD_REQUEST', 'Keep the description under ' + PO_RULES.MAX_DESCRIPTION + ' characters.');
  const amount = parseAmount_(p.amountInclZar);
  if (!(amount > 0)) throw new AppError('BAD_REQUEST', 'Enter the amount including VAT.');
  if (amount > PO_RULES.MAX_AMOUNT_ZAR) throw new AppError('BAD_REQUEST', 'That amount is too large for PO Desk.');
  let category = null;
  if (p.categoryId) {
    category = data.categories.find(c => String(c.category_id) === String(p.categoryId) && isTrue_(c.active));
    if (!category) throw new AppError('BAD_REQUEST', 'That category isn’t available any more. Choose another.');
  }
  const allowed = allowedAccounts_(data, ent);
  const accountCode = String(p.accountCode || '').trim();
  const account = allowed[accountCode];
  if (!account) throw new AppError('BAD_REQUEST', 'Choose an account for this purchase.');
  const taxType = pickTaxType_(data, ent, category ? category.tax_type : '', account);
  if (!taxType) throw new AppError('CONFIG_MISSING', 'No VAT type is set up for this account. Please tell your PO Desk admin.');
  const suggestion = suggestAccountWith_(data, ent, supplier.contact_id, category ? category.category_id : '', description);
  const source = suggestion.accountCode === accountCode ? suggestion.source : 'manual';
  const limit = ctx.grants[ent].poLimitZar;
  const needsApproval = amount > limit;
  T.mark('prep');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Tap Try again: it won’t create a second PO.');
  T.mark('lock');
  let row;
  let failure = null;
  try {
    // Inside the lock, so a double-tapped Submit waits here and then finds the first PO.
    invalidateTable_('POs');
    const dup = readTable('POs').rows.find(r => r.idem_key === idemKey);
    if (dup) {
      if (String(dup.buyer_user_id) !== String(ctx.user.user_id)) throw new AppError('FORBIDDEN', 'That request key belongs to someone else.');
      auditLog({ userId: ctx.user.user_id, entityId: ent, action: 'po.create', ref: dup.po_id, ok: true, detail: { duplicate: true, ms: T.all() } });
      return Object.assign(poView_(dup, data, pm), { duplicate: true, serverMs: T.all() });
    }
    rateLimit_('po', ctx.user.user_id, PO_RULES.RATE_MAX, PO_RULES.RATE_WINDOW_S);

    row = {
      po_id: Utilities.getUuid(), idem_key: idemKey, entity_id: ent, xero_po_id: '', po_number: '', provisional_ref: '',
      status: '', buyer_user_id: ctx.user.user_id, pm_id: pm.pm_id, contact_id: supplier.contact_id,
      supplier_name: String(supplier.name), description: description, category_id: category ? category.category_id : '',
      account_code: accountCode, tax_type: taxType, amount_incl_zar: amount, suggestion_source: source,
      created_at: new Date(), approver_user_id: '', decided_at: '', bill_id: '',
    };
    const xeroStatus = needsApproval ? 'SUBMITTED' : 'AUTHORISED';
    let xeroPo = null;
    try {
      xeroPo = createXeroPo_(row, pm, ctx.user.name, xeroStatus, '', { userId: ctx.user.user_id, ref: row.po_id });
    } catch (err) {
      failure = err;
    }
    T.mark('xero');

    if (xeroPo) {
      row.xero_po_id = xeroPo.PurchaseOrderID;
      row.po_number = xeroPo.PurchaseOrderNumber;
      row.status = needsApproval ? PO_STATUS.AWAITING_APPROVAL : PO_STATUS.ISSUED;
    } else if (isXeroRejection_(failure)) {
      // Xero refused the data itself; retrying later would fail the same way, so tell the buyer now.
      auditLog({ userId: ctx.user.user_id, entityId: ent, action: 'po.create', ok: false, detail: { rejected: failure.message, ms: T.all() } });
      throw new AppError('XERO_REJECTED', 'Xero didn’t accept this PO: ' + failure.message);
    } else {
      // Composio or Xero unavailable: a provisional reference now, the real PO from the queue later.
      row.status = PO_STATUS.PENDING_XERO;
      row.provisional_ref = nextProvisionalRef_(ent, row.created_at);
      appendRow('Queue', {
        job_id: Utilities.getUuid(), type: 'createPO', payload_json: JSON.stringify({ poId: row.po_id, xeroStatus: xeroStatus }),
        attempts: 0, next_run_at: new Date(), last_error: failure ? truncate_(failure.message, 300) : '',
      });
    }
    appendRow('POs', row);
    T.mark('write');
    // Learn the buyer's choice even when Xero is down: it was still their decision.
    try { recordChoice(ent, supplier.contact_id, accountCode); } catch (err) { console.warn('recordChoice failed: ' + err.message); }
    T.mark('choice');
  } finally {
    lock.releaseLock();
  }

  let approvers = null;
  if (row.status === PO_STATUS.AWAITING_APPROVAL) approvers = notifyApprovers_(row, ctx.user, account);
  T.mark('notify');
  const ms = T.all();
  auditLog({
    userId: ctx.user.user_id, entityId: ent, action: 'po.create', ref: row.po_id, ok: true,
    detail: { ms: ms, status: row.status, poNumber: row.po_number || row.provisional_ref, needsApproval: needsApproval, source: source, failure: failure ? truncate_(failure.message, 200) : undefined },
  });
  return Object.assign(poView_(row, data, pm), { approvers: approvers, serverMs: ms });
}

/** Builds and sends the Xero PO for a POs row. Used by createPO and by the queue. */
function createXeroPo_(row, pm, buyerName, xeroStatus, provisionalRef, ctx) {
  const date = Utilities.formatDate(row.created_at instanceof Date ? row.created_at : new Date(row.created_at), APP.TZ, 'yyyy-MM-dd');
  return xeroCreatePurchaseOrderInclusive(entityById_(row.entity_id).xero_tenant_id, {
    ContactID: row.contact_id,
    Date: date,
    DeliveryDate: date,
    Reference: poReference_(pm, buyerName, provisionalRef),
    AttentionTo: String(buyerName || ''),
    Status: xeroStatus,
    LineItems: [{
      Description: row.description, Quantity: 1, UnitAmount: Number(row.amount_incl_zar),
      AccountCode: String(row.account_code), TaxType: String(row.tax_type),
    }],
  }, ctx);
}

/** "Cheque card ••9514 · Dawid" (CLAUDE.md), plus the provisional ref when the queue creates it. */
function poReference_(pm, buyerName, provisionalRef) {
  const paidWith = pm.type === 'CARD' && pm.last4 ? pm.label + ' ••' + pm.last4 : String(pm.label);
  const first = String(buyerName || '').split(/\s+/)[0];
  return paidWith + ' · ' + first + (provisionalRef ? ' · ' + provisionalRef : '');
}

/** NHP-P-261104-01: clearly not a Xero PO number, unique per company per day. */
function nextProvisionalRef_(ent, when) {
  const prefix = ent + '-P-' + Utilities.formatDate(when, APP.TZ, 'yyMMdd') + '-';
  const used = readTable('POs').rows.filter(r => String(r.provisional_ref).indexOf(prefix) === 0).length;
  return prefix + String(used + 1).padStart(2, '0');
}

/**
 * True when Xero (or Composio) refused the request itself — a 4xx that is not about auth or rate
 * limits. Those never succeed on retry, so they are shown to the buyer instead of being queued.
 */
function isXeroRejection_(err) {
  if (!err) return false;
  if (err.code === 'XERO_VALIDATION' || err.code === 'BAD_ID' || err.code === 'BAD_REQUEST') return true;
  const d = err.detail || {};
  const code = Number(d.upstream) || Number(d.status) || 0;
  return code >= 400 && code < 500 && [401, 403, 408, 429].indexOf(code) === -1;
}

// --- listPOs / getPO -------------------------------------------------------------------------

function actionListPOs_(req, ctx) {
  const ent = requireBuyer_(ctx, req.payload.entityId);
  const data = { accounts: getRefData(ent).accounts };
  const pms = pmIndex_();
  const rows = readTable('POs').rows
    .filter(r => r.entity_id === ent && String(r.buyer_user_id) === String(ctx.user.user_id) && r.status)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  return { entityId: ent, pos: rows.map(r => poView_(r, data, pms[r.pm_id])) };
}

function actionGetPO_(req, ctx) {
  const poId = str_(req.payload.poId, 60);
  const row = poId ? findBy('POs', 'po_id', poId)[0] : null;
  const g = row ? ctx.grants[row.entity_id] : null;
  const mine = row && String(row.buyer_user_id) === String(ctx.user.user_id);
  // Approvers of that company may look too (they will act on it in Approvals). Anyone else gets
  // "not found", so PO IDs can't be probed across companies.
  if (!row || !g || !(mine || g.canApprove || ctx.user.role === 'admin')) throw new AppError('NOT_FOUND', 'PO not found.');
  return poView_(row, { accounts: getRefData(row.entity_id).accounts }, pmIndex_()[row.pm_id]);
}

/** The PO as the browser sees it. No internal IDs beyond poId; no bank account details. */
function poView_(row, data, pm) {
  const acct = (data.accounts || []).find(a => String(a.code) === String(row.account_code));
  return {
    poId: row.po_id,
    entityId: row.entity_id,
    poNumber: row.po_number ? String(row.po_number) : '',
    provisionalRef: row.provisional_ref ? String(row.provisional_ref) : '',
    status: row.status,
    supplierName: String(row.supplier_name),
    description: String(row.description),
    amountInclZar: Number(row.amount_incl_zar),
    accountCode: String(row.account_code),
    accountName: acct ? String(acct.name) : '',
    paidWith: pm ? (pm.type === 'CARD' && pm.last4 ? pm.label + ' ••' + pm.last4 : String(pm.label)) : '',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function pmIndex_() {
  const out = {};
  readTable('PaymentMethods').rows.forEach(r => { out[r.pm_id] = r; });
  return out;
}

// --- small helpers ---------------------------------------------------------------------------

function str_(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function normName_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Accepts 1234.5, "1234.50", "1 234,50", "R1,234.50". Returns a number rounded to cents, or NaN. */
function parseAmount_(v) {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let s = String(v || '').replace(/[R\s]/gi, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');  // 1,234.50
  else s = s.replace(',', '.');                                       // 1234,50
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

/** Per-step server timings for createPO; "auth" is measured in doPost before the handler runs. */
function stepTimer_(ctx) {
  const t0 = ctx && ctx.t0 ? ctx.t0 : Date.now();
  const ms = { auth: (ctx && ctx.authMs) || 0 };
  let last = Date.now();
  return {
    mark: (name) => { const n = Date.now(); ms[name] = (ms[name] || 0) + (n - last); last = n; },
    all: () => Object.assign({}, ms, { total: Date.now() - t0 }),
  };
}
