/**
 * Main.gs — web app entry points and the action handlers for Flow 1 (raise a PO).
 *
 * The browser sends POST with Content-Type text/plain so it is a "simple" CORS request:
 * Apps Script cannot answer an OPTIONS preflight, so JSON content types would fail.
 */

// Handlers get (req, ctx); ctx is the verified session ({ user, grants, t0, authMs }) and is null
// only for public routes. Wrapped in arrows so functions in other files are looked up at call time.
// `tabs`: Sheet tabs the action needs, read in ONE Sheets API call before the session check
// (Db.gs fastRead_). The session check itself always needs Users, UserEntities and Entities.
const AUTH_TABS = ['Users', 'UserEntities', 'Entities', 'Config'];
const ROUTES = {
  ping: { public: true, fn: () => ({ pong: true, version: APP.VERSION }) },
  login: { public: true, tabs: AUTH_TABS, fn: (req) => actionLogin_(req) },
  logout: { public: true, fn: (req) => actionLogout_(req) },
  me: { tabs: AUTH_TABS, fn: (req, ctx) => actionMe_(req, ctx) },
  refData: { tabs: AUTH_TABS.concat(['PaymentMethods', 'Categories']), fn: (req, ctx) => actionRefData_(req, ctx) },
  suggest: { tabs: AUTH_TABS.concat(['Categories', 'SupplierHistory']), fn: (req, ctx) => actionSuggest_(req, ctx) },
  createSupplier: { tabs: AUTH_TABS, fn: (req, ctx) => actionCreateSupplier_(req, ctx) },
  createPO: { tabs: AUTH_TABS.concat(['PaymentMethods', 'Categories', 'SupplierHistory', 'POs']), fn: (req, ctx) => actionCreatePO_(req, ctx) },
  listPOs: { tabs: AUTH_TABS.concat(['POs', 'PaymentMethods', 'Bills']), fn: (req, ctx) => actionListPOs_(req, ctx) },
  getPO: { tabs: AUTH_TABS.concat(['POs', 'PaymentMethods', 'Bills']), fn: (req, ctx) => actionGetPO_(req, ctx) },
  uploadSlip: { tabs: AUTH_TABS.concat(['POs', 'Bills']), fn: (req, ctx) => actionUploadSlip_(req, ctx) },
  readSlip: { tabs: AUTH_TABS.concat(['POs', 'Bills']), fn: (req, ctx) => actionReadSlip_(req, ctx) },
  getSlip: { tabs: AUTH_TABS.concat(['POs', 'Bills']), fn: (req, ctx) => actionGetSlip_(req, ctx) },
  saveSlipReview: { tabs: AUTH_TABS.concat(['POs', 'Bills']), fn: (req, ctx) => actionSaveSlipReview_(req, ctx) },
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
  startAuditBuffer_();
  try {
    const req = parseRequest_(e);
    const route = Object.prototype.hasOwnProperty.call(ROUTES, req.action) ? ROUTES[req.action] : null;
    if (!route) throw new AppError('UNKNOWN_ACTION', 'Unknown action.');
    if (route.tabs) fastRead_(route.tabs);
    const ctx = route.public ? null : requireSession_(req.token);
    if (ctx) { ctx.t0 = t0; ctx.authMs = Date.now() - t0; }
    envelope = { ok: true, data: route.fn(req, ctx) };
  } catch (err) {
    envelope = { ok: false, error: publicError_(err) };
  } finally {
    flushAudit_();
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
 * Finds the supplier before creating one: first the synced list, then Xero itself, archived contacts
 * included, because Xero refuses a second contact with the same name. Xero's API also refuses to
 * edit archived contacts ("Archived contacts cannot currently be edited via the API", 4 Nov 2026),
 * so an archived match cannot be switched back on from here: the buyer is told to ask an admin.
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
    if (cached) return { supplier: { contactId: cached.contact_id, name: String(cached.name) }, existing: true };

    const t = entityById_(ent).xero_tenant_id;
    const matches = xeroSearchContacts(t, name, xctx).filter(c => normName_(c.Name) === key);
    let contact;
    let existing = false;
    if (matches.length) {
      contact = matches.find(c => c.ContactStatus === 'ACTIVE');
      if (!contact) {
        throw new AppError('SUPPLIER_ARCHIVED', '“' + matches[0].Name + '” is archived in ' + entityById_(ent).short_name +
          '’s Xero. Ask your PO Desk admin to restore it in Xero (Contacts, Archived), or choose another supplier.');
      }
      existing = true;
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
    auditLog({ userId: ctx.user.user_id, entityId: ent, action: 'supplier.create', ok: true, ref: contact.ContactID, detail: { existing: existing } });
    return { supplier: { contactId: contact.ContactID, name: String(contact.Name) }, existing: existing };
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
    // Inside the lock, so a double-tapped Submit waits here and then finds the first PO. Re-read:
    // the copy loaded before the lock may predate another buyer's PO.
    if (!fastRead_(['POs', 'SupplierHistory'], true)) { invalidateTable_('POs'); invalidateTable_('SupplierHistory'); }
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
    }
    let job = null;
    if (!xeroPo) {
      // Composio or Xero unavailable: a provisional reference now, the real PO from the queue later.
      row.status = PO_STATUS.PENDING_XERO;
      row.provisional_ref = nextProvisionalRef_(ent, row.created_at);
      job = {
        job_id: Utilities.getUuid(), type: 'createPO', payload_json: JSON.stringify({ poId: row.po_id, xeroStatus: xeroStatus }),
        attempts: 0, next_run_at: new Date(), last_error: failure ? truncate_(failure.message, 300) : '',
      };
    }
    // The POs row, the queue job and the learnt account choice go out together. The choice is learnt
    // even when Xero is down: it was still the buyer's decision.
    const plan = planChoiceWrites_(ent, supplier.contact_id, accountCode, readTable('SupplierHistory').rows, Number(data.config.historyN));
    let rowWritten = false;
    let choiceDone = false;
    if (!dbCache_.fastOff) {
      try {
        sheetsFetch_([appendReq_('POs', [row])].concat(job ? [appendReq_('Queue', [job])] : [], plan ? plan.reqs : []));
        rowWritten = true;
        choiceDone = !!plan;
      } catch (err) {
        // Some of the parallel writes may have landed. If the POs row did, only add what is provably
        // missing; the account choice is not re-applied (no double count) and the nightly sync
        // rebuilds it from this POs row anyway.
        console.warn('Fast write failed, using SpreadsheetApp: ' + err.message);
        dbCache_.fastOff = true;
        invalidateTable_('POs');
        invalidateTable_('Queue');
        if (readTable('POs').rows.some(r => r.po_id === row.po_id)) {
          rowWritten = true;
          choiceDone = true;
          if (job && !readTable('Queue').rows.some(j => j.job_id === job.job_id)) appendRow('Queue', job);
        }
      }
    }
    if (!rowWritten) {
      if (job) appendRow('Queue', job);
      appendRow('POs', row);
    }
    T.mark('write');
    if (!choiceDone) {
      try { recordChoice(ent, supplier.contact_id, accountCode); } catch (err) { console.warn('recordChoice failed: ' + err.message); }
    }
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
  const bills = billIndex_();
  const rows = readTable('POs').rows
    .filter(r => r.entity_id === ent && String(r.buyer_user_id) === String(ctx.user.user_id) && r.status)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  return { entityId: ent, pos: rows.map(r => poView_(r, data, pms[r.pm_id], bills[r.po_id])) };
}

function actionGetPO_(req, ctx) {
  const poId = str_(req.payload.poId, 60);
  const row = poId ? findBy('POs', 'po_id', poId)[0] : null;
  const g = row ? ctx.grants[row.entity_id] : null;
  const mine = row && String(row.buyer_user_id) === String(ctx.user.user_id);
  // Approvers of that company may look too (they will act on it in Approvals). Anyone else gets
  // "not found", so PO IDs can't be probed across companies.
  if (!row || !g || !(mine || g.canApprove || ctx.user.role === 'admin')) throw new AppError('NOT_FOUND', 'PO not found.');
  return poView_(row, { accounts: getRefData(row.entity_id).accounts }, pmIndex_()[row.pm_id], billIndex_()[row.po_id]);
}

/** The PO as the browser sees it. No internal IDs beyond poId/billId; no bank account details. */
function poView_(row, data, pm, bill) {
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
    slip: bill ? { billId: bill.bill_id, reviewed: Number(bill.total_incl_zar) > 0, billed: !!bill.xero_invoice_id } : null,
  };
}

/** po_id -> its latest Bills row. */
function billIndex_() {
  const out = {};
  readTable('Bills').rows.forEach(b => {
    const cur = out[b.po_id];
    if (!cur || new Date(b.created_at) > new Date(cur.created_at)) out[b.po_id] = b;
  });
  return out;
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

// --- Flow 2: slip capture, storage and extraction (no Xero bill yet) -------------------------

const SLIP_RULES = Object.freeze({
  MAX_BYTES: 6 * 1024 * 1024,      // the browser sends ~0.2–0.8 MB after downscaling; this is a hard cap
  MIN_BYTES: 2000,
  RATE_MAX: 40,                    // uploads per user per hour
  RATE_WINDOW_S: 3600,
  MAX_LINES: 50,
});

/** The PO's own buyer (or an admin of that company) may add its slip. Anyone else gets NOT_FOUND. */
function requireSlipPO_(ctx, poId) {
  const id = str_(poId, 60);
  const po = id ? findBy('POs', 'po_id', id)[0] : null;
  const g = po ? ctx.grants[po.entity_id] : null;
  const mine = po && String(po.buyer_user_id) === String(ctx.user.user_id);
  if (!po || !g || !((mine && g.canBuy) || ctx.user.role === 'admin')) throw new AppError('NOT_FOUND', 'PO not found.');
  return po;
}

function requireSlipBill_(ctx, billId) {
  const id = str_(billId, 60);
  const bill = id ? findBy('Bills', 'bill_id', id)[0] : null;
  if (!bill) throw new AppError('NOT_FOUND', 'Slip not found.');
  const po = requireSlipPO_(ctx, bill.po_id);
  if (bill.xero_invoice_id) throw new AppError('BAD_REQUEST', 'This slip is already on a Xero bill.');
  return { bill: bill, po: po };
}

function slipStatusMessage_(po) {
  return {
    AWAITING_APPROVAL: 'This PO is still waiting for approval. Add the slip once it is approved.',
    PENDING_XERO: 'This PO doesn’t have its Xero number yet. Add the slip once it has.',
    DECLINED: 'This PO was declined.',
    CANCELLED: 'This PO was cancelled.',
    BILLED: 'This PO already has its bill.',
  }[po.status] || 'A slip can’t be added to this PO.';
}

function actionUploadSlip_(req, ctx) {
  const T = stepTimer_(ctx);
  const p = req.payload;
  const po = requireSlipPO_(ctx, p.poId);
  if (po.status !== PO_STATUS.ISSUED) throw new AppError('BAD_REQUEST', slipStatusMessage_(po));
  if (p.mimeType !== 'image/jpeg') throw new AppError('BAD_REQUEST', 'Send the photo as a JPEG.');
  const b64 = String(p.imageBase64 || '');
  if (b64.length > Math.ceil(SLIP_RULES.MAX_BYTES * 4 / 3) + 4) throw new AppError('TOO_LARGE', 'That photo is too large. Please take it again.');
  let bytes;
  try { bytes = Utilities.base64Decode(b64); } catch (err) { throw new AppError('BAD_REQUEST', 'The photo could not be read. Please take it again.'); }
  // Check the content, not just the declared type: a JPEG starts FF D8 FF.
  if (bytes.length < SLIP_RULES.MIN_BYTES || (bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8 || (bytes[2] & 0xff) !== 0xff) {
    throw new AppError('BAD_REQUEST', 'That file isn’t a JPEG photo.');
  }
  rateLimit_('slip', ctx.user.user_id, SLIP_RULES.RATE_MAX, SLIP_RULES.RATE_WINDOW_S);
  T.mark('prep');

  const now = new Date();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  let folder;
  try { folder = slipFolder_(po.entity_id, now); } finally { lock.releaseLock(); }   // folder creation must not race
  const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', slipFileName_(po, Utilities.formatDate(now, APP.TZ, 'yyyy-MM-dd'), null)));
  T.mark('drive');

  let bill;
  let replaced = '';
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) { trashSlip_(file.getId()); throw new AppError('BUSY', 'PO Desk is busy. Please try again.'); }
  try {
    invalidateTable_('Bills');
    // One draft per PO: a retake replaces the photo and clears anything read from the old one.
    const draft = readTable('Bills').rows.find(b => b.po_id === po.po_id && !b.xero_invoice_id);
    if (draft) {
      replaced = String(draft.drive_file_id || '');
      updateRowById('Bills', 'bill_id', draft.bill_id, { drive_file_id: file.getId(), slip_number: '', slip_date: '', supplier_vat_no: '', total_incl_zar: '', vat_zar: '', ocr_json: '', flags: '' });
      bill = draft;
    } else {
      bill = {
        bill_id: Utilities.getUuid(), po_id: po.po_id, entity_id: po.entity_id, xero_invoice_id: '', slip_number: '', slip_date: '',
        supplier_vat_no: '', total_incl_zar: '', vat_zar: '', drive_file_id: file.getId(), ocr_json: '', flags: '',
        created_by: ctx.user.user_id, created_at: now,
      };
      appendRow('Bills', bill);
    }
  } finally {
    lock.releaseLock();
  }
  if (replaced && replaced !== file.getId()) trashSlip_(replaced);
  T.mark('write');
  auditLog({ userId: ctx.user.user_id, entityId: po.entity_id, action: 'slip.upload', ref: bill.bill_id, ok: true, detail: { po: po.po_number, bytes: bytes.length, retake: !!replaced, ms: T.all() } });
  return { billId: bill.bill_id, poId: po.po_id, bytes: bytes.length };
}

function actionReadSlip_(req, ctx) {
  const { bill, po } = requireSlipBill_(ctx, req.payload.billId);
  const ocr = extractSlip(bill.drive_file_id, { userId: ctx.user.user_id, entityId: po.entity_id, ref: bill.bill_id });
  const stored = {
    status: ocr.status, reason: ocr.reason, model: ocr.model, ms: ocr.ms, at: new Date().toISOString(),
    extracted: ocr.fields || null, confidence: ocr.confidence || {}, lowConfidence: ocr.lowConfidence || [], checks: ocr.checks || [],
  };
  // Reading again means starting over from the photo, like a retake: earlier reviewed values go.
  updateRowById('Bills', 'bill_id', bill.bill_id, { ocr_json: JSON.stringify(stored), slip_number: '', slip_date: '', supplier_vat_no: '', total_incl_zar: '', vat_zar: '', flags: '' });
  return slipView_(bill, po, stored, null);
}

function actionGetSlip_(req, ctx) {
  const { bill, po } = requireSlipBill_(ctx, req.payload.billId);
  const stored = parseJson_(bill.ocr_json) || {};
  const view = slipView_(bill, po, stored, stored.reviewed || null);
  if (req.payload.withImage === true) view.image = slipImageBase64_(bill.drive_file_id);
  return view;
}

function actionSaveSlipReview_(req, ctx) {
  const { bill, po } = requireSlipBill_(ctx, req.payload.billId);
  const f = validateSlipFields_(req.payload.fields);
  const flags = slipFlags_(po, f, bill.bill_id);
  const stored = parseJson_(bill.ocr_json) || {};
  const ex = stored.extracted || {};
  const edited = stored.status === 'ok'
    ? ['supplierName', 'supplierVatNumber', 'slipNumber', 'date', 'totalIncl', 'vatAmount'].filter(k => String(ex[k] === null || ex[k] === undefined ? '' : ex[k]) !== String(f[k] === null ? '' : f[k]))
    : [];
  Object.assign(stored, { reviewed: f, reviewedAt: new Date().toISOString(), reviewedBy: ctx.user.user_id, source: stored.status === 'ok' ? 'gemini' : 'manual', edited: edited });
  updateRowById('Bills', 'bill_id', bill.bill_id, {
    slip_number: f.slipNumber, slip_date: new Date(f.date + 'T12:00:00+02:00'), supplier_vat_no: f.supplierVatNumber,
    total_incl_zar: f.totalIncl, vat_zar: f.vatAmount === null ? '' : f.vatAmount,
    ocr_json: JSON.stringify(stored), flags: JSON.stringify(flags.map(x => x.code)),
  });
  const fileName = slipFileName_(po, f.date, f.totalIncl);
  try { renameSlip_(bill.drive_file_id, fileName); } catch (err) { console.warn('Rename failed: ' + err.message); }
  auditLog({ userId: ctx.user.user_id, entityId: po.entity_id, action: 'slip.review', ref: bill.bill_id, ok: true, detail: { po: po.po_number, source: stored.source, edited: edited, flags: flags.map(x => x.code) } });
  return { saved: true, billId: bill.bill_id, poId: po.po_id, flags: flags, fileName: fileName };
}

/** What the review screen needs: values (reviewed, else extracted, else a manual prefill), flags, thresholds. */
function slipView_(bill, po, stored, reviewed) {
  const manual = !reviewed && stored.status !== 'ok';
  let fields = reviewed || stored.extracted;
  if (!fields || manual) {
    // Typing by hand: start from what PO Desk already knows about this supplier.
    const known = getRefData(po.entity_id).suppliers.find(s => s.contact_id === po.contact_id);
    fields = { supplierName: String(po.supplier_name), supplierVatNumber: known && /^4\d{9}$/.test(String(known.vat_number)) ? String(known.vat_number) : '',
      slipNumber: '', date: '', currency: 'ZAR', lineItems: [], subtotalExcl: null, vatAmount: null, totalIncl: null, paymentMethodHint: '' };
  }
  return {
    billId: bill.bill_id,
    po: { poId: po.po_id, poNumber: String(po.po_number), supplierName: String(po.supplier_name), amountInclZar: Number(po.amount_incl_zar), createdAt: po.created_at instanceof Date ? po.created_at.toISOString() : String(po.created_at), entityId: po.entity_id },
    status: reviewed ? 'reviewed' : (stored.status || 'manual'),
    reason: stored.reason || (stored.status ? '' : 'The slip hasn’t been read yet.'),
    fields: fields,
    confidence: reviewed ? {} : (stored.confidence || {}),
    lowConfidence: reviewed || manual ? [] : (stored.lowConfidence || []),
    checks: reviewed || manual ? [] : (stored.checks || []),
    flags: fields.totalIncl ? slipFlags_(po, fields, bill.bill_id) : [],
    thresholds: slipThresholds_(),
  };
}

function slipThresholds_() {
  return {
    variancePct: Number(getConfig('VARIANCE_PCT', 10)),
    varianceZar: Number(getConfig('VARIANCE_ZAR', 500)),
    fullInvoiceZar: Number(getConfig('VAT_FULL_INVOICE_ZAR', 5000)),
    dateDays: Number(getConfig('SLIP_DATE_TOLERANCE_DAYS', 3)),
  };
}

/** Server-side validation of the buyer's reviewed values. Throws BAD_REQUEST with a plain message. */
function validateSlipFields_(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new AppError('BAD_REQUEST', 'Missing slip details.');
  const bad = (m) => { throw new AppError('BAD_REQUEST', m); };
  const text = (v, max) => String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseAmount_(v); return isNaN(n) ? NaN : n; };
  const out = {};
  out.supplierName = text(f.supplierName, 100);
  if (!out.supplierName) bad('Enter the supplier’s name as printed on the slip.');
  out.supplierVatNumber = text(f.supplierVatNumber, 20).replace(/\D/g, '');
  if (out.supplierVatNumber && !/^4\d{9}$/.test(out.supplierVatNumber)) bad('A South African VAT number is 10 digits starting with 4. Leave it empty if the slip has none.');
  out.slipNumber = text(f.slipNumber, 40);
  out.date = text(f.date, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? new Date(out.date + 'T12:00:00Z') : null;
  if (!d || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out.date) bad('Enter the date on the slip.');
  if (d.getUTCFullYear() < 2020 || d.getTime() > Date.now() + 36 * 3600 * 1000) bad('The slip date can’t be in the future or before 2020.');
  out.totalIncl = money(f.totalIncl);
  if (!(out.totalIncl > 0) || out.totalIncl > PO_RULES.MAX_AMOUNT_ZAR) bad('Enter the slip total including VAT, e.g. 245.90.');
  out.vatAmount = money(f.vatAmount);
  if (out.vatAmount !== null && (isNaN(out.vatAmount) || out.vatAmount < 0 || out.vatAmount > out.totalIncl)) bad('The VAT amount must be between 0 and the total.');
  out.currency = 'ZAR';
  out.subtotalExcl = null;
  out.paymentMethodHint = text(f.paymentMethodHint, 10).toUpperCase();
  const lines = Array.isArray(f.lineItems) ? f.lineItems : [];
  if (lines.length > SLIP_RULES.MAX_LINES) bad('A slip can have at most ' + SLIP_RULES.MAX_LINES + ' lines; put the rest into one line.');
  out.lineItems = lines.map((li, i) => {
    const description = text(li && li.description, 200);
    const qty = money(li && li.qty);
    const total = money(li && li.lineTotalIncl);
    if (!description) bad('Line ' + (i + 1) + ' needs a description.');
    if (qty !== null && (isNaN(qty) || qty <= 0 || qty > 100000)) bad('Line ' + (i + 1) + ' has an invalid quantity.');
    if (total === null || isNaN(total)) bad('Line ' + (i + 1) + ' needs an amount.');
    const unit = money(li && li.unitPriceIncl);
    return { description: description, qty: qty === null ? 1 : qty, unitPriceIncl: unit === null || isNaN(unit) ? null : unit, lineTotalIncl: total };
  });
  return out;
}

/**
 * CLAUDE.md Flow 2 step 5: warn, never block. Returns [{ code, message }] for amber notes.
 * The browser shows the same rules live; this is the authoritative copy stored on the Bills row.
 */
function slipFlags_(po, f, billId) {
  const cfg = slipThresholds_();
  const flags = [];
  const poAmount = Number(po.amount_incl_zar);
  const total = Number(f.totalIncl);
  if (total > 0 && poAmount > 0) {
    const diff = Math.round((total - poAmount) * 100) / 100;
    const pct = Math.abs(diff) / poAmount * 100;
    if (Math.abs(diff) > cfg.varianceZar || pct > cfg.variancePct) {
      flags.push({ code: 'VARIANCE', message: 'The slip total ' + randText_(total) + ' is ' + randText_(Math.abs(diff)) + (diff > 0 ? ' more' : ' less') + ' than the PO amount ' + randText_(poAmount) + ' (' + Math.round(pct) + '%).' });
    }
  }
  if (f.supplierName && !namesMatch_(f.supplierName, po.supplier_name)) {
    flags.push({ code: 'SUPPLIER_MISMATCH', message: 'The slip is from “' + f.supplierName + '”, but the PO is for “' + po.supplier_name + '”.' });
  }
  if (!f.supplierVatNumber) flags.push({ code: 'NO_VAT_NUMBER', message: 'No supplier VAT number: the bill will use No VAT, so no VAT can be claimed back on it.' });
  if (total > cfg.fullInvoiceZar) {
    flags.push({ code: 'FULL_TAX_INVOICE', message: 'Over ' + randText_(cfg.fullInvoiceZar) + ': SARS needs a full tax invoice showing ' + entityById_(po.entity_id).legal_name + '’s name, address and VAT number, not only a till slip.' });
  }
  if (f.date) {
    const poDay = Utilities.formatDate(po.created_at instanceof Date ? po.created_at : new Date(po.created_at), APP.TZ, 'yyyy-MM-dd');
    const days = Math.round(Math.abs(new Date(f.date + 'T00:00:00Z') - new Date(poDay + 'T00:00:00Z')) / 86400000);
    if (days > cfg.dateDays) flags.push({ code: 'DATE_GAP', message: 'The slip is dated ' + f.date + ', ' + days + ' days from the PO (' + poDay + ').' });
  }
  const dup = duplicateSlip_(po, f, billId);
  if (dup) flags.push({ code: 'DUPLICATE', message: 'This looks like a slip already captured on ' + (dup.po_number || 'another PO') + ' (same supplier and ' + dup.why + ').' });
  return flags;
}

/** Same supplier and slip number, or same supplier, date and total, on another Bills row. */
function duplicateSlip_(po, f, billId) {
  const posById = {};
  readTable('POs').rows.forEach(r => { posById[r.po_id] = r; });
  const slipNo = String(f.slipNumber || '').replace(/\s+/g, '').toLowerCase();
  for (const b of readTable('Bills').rows) {
    if (b.bill_id === billId || b.entity_id !== po.entity_id) continue;
    const other = posById[b.po_id];
    if (!other || other.contact_id !== po.contact_id || other.status === PO_STATUS.CANCELLED) continue;
    if (slipNo && String(b.slip_number || '').replace(/\s+/g, '').toLowerCase() === slipNo) return { po_number: other.po_number, why: 'slip number' };
    const bDay = b.slip_date instanceof Date ? Utilities.formatDate(b.slip_date, APP.TZ, 'yyyy-MM-dd') : String(b.slip_date || '').slice(0, 10);
    if (f.date && bDay === f.date && Math.abs(Number(b.total_incl_zar) - Number(f.totalIncl)) < 0.005) return { po_number: other.po_number, why: 'date and total' };
  }
  return null;
}

// Words that say nothing about which supplier it is, so they never count as a match on their own.
const GENERIC_NAME_WORDS = Object.freeze(['pty', 'ltd', 'cc', 'inc', 'the', 'and', 'limited', 'company', 'trading', 'group', 'store', 'stores', 'shop',
  'motors', 'services', 'supplies', 'supply', 'market', 'supermarket', 'hardware', 'pharmacy', 'garage', 'station', 'centre', 'center', 'sa', 'south', 'africa']);

/**
 * Loose supplier-name match: "SPAR KLEIN KAROO" matches "Spar Oudtshoorn"; "Engen" does not match "Shell".
 * With fuzzy (the default) small differences pass too, as slips and slip reading misspell names:
 * "R & R PETROLIUM" ~ "R & R Petroleum", "PICKNPAY" ~ "Pick n Pay". Words under 5 letters must match exactly.
 * The slip test scores with fuzzy off, so a misread name is not counted as right.
 */
function namesMatch_(a, b, fuzzy) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\(pty\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return true;
  const words = (s) => s.split(' ').filter(w => w.length >= 3 && GENERIC_NAME_WORDS.indexOf(w) === -1);
  const wa = words(na);
  const wb = words(nb);
  if (wa.some(w => wb.indexOf(w) !== -1)) return true;
  if (fuzzy === false) return false;
  const ca = na.replace(/ /g, '');
  const cb = nb.replace(/ /g, '');
  if (Math.min(ca.length, cb.length) >= 4 && (ca.indexOf(cb) !== -1 || cb.indexOf(ca) !== -1)) return true;
  return nearlySame_(ca, cb) || wa.some(x => wb.some(y => nearlySame_(x, y)));
}

/** True when two words differ by at most 1 letter (5–9 letters) or 2 letters (10 or more). */
function nearlySame_(x, y) {
  const len = Math.min(x.length, y.length);
  const allowed = len < 5 ? 0 : len < 10 ? 1 : 2;
  if (!allowed || Math.abs(x.length - y.length) > allowed) return false;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > allowed) return false;
    prev = cur;
  }
  return prev[y.length] <= allowed;
}

function parseJson_(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (err) { return null; }
}
