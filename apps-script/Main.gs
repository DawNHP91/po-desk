/**
 * Main.gs — web app entry points and the action handlers for Flow 1 (raise a PO) and Flow 2
 * (slip to draft bill).
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
  submitBill: { tabs: AUTH_TABS.concat(['POs', 'Bills', 'Queue']), fn: (req, ctx) => actionSubmitBill_(req, ctx) },
  // Stage 7: approvals, people admin and the emailed Set PIN link.
  listApprovals: { tabs: AUTH_TABS.concat(['POs', 'PaymentMethods', 'Bills']), fn: (req, ctx) => actionListApprovals_(req, ctx) },
  decidePO: { tabs: AUTH_TABS.concat(['POs']), fn: (req, ctx) => actionDecidePO_(req, ctx) },
  listPeople: { tabs: AUTH_TABS, fn: (req, ctx) => actionListPeople_(req, ctx) },
  savePerson: { tabs: AUTH_TABS, fn: (req, ctx) => actionSavePerson_(req, ctx) },
  resetPin: { tabs: AUTH_TABS, fn: (req, ctx) => actionResetPin_(req, ctx) },
  setPersonActive: { tabs: AUTH_TABS, fn: (req, ctx) => actionSetPersonActive_(req, ctx) },
  checkPinToken: { public: true, tabs: AUTH_TABS, fn: (req) => actionCheckPinToken_(req) },
  setPinWithToken: { public: true, tabs: AUTH_TABS, fn: (req) => actionSetPinWithToken_(req) },
  // Stage 10: categories and their keywords (admins only; Coding.gs).
  listKeywords: { tabs: AUTH_TABS.concat(['Categories']), fn: (req, ctx) => actionListKeywords_(req, ctx) },
  saveKeyword: { tabs: AUTH_TABS.concat(['Categories']), fn: (req, ctx) => actionSaveKeyword_(req, ctx) },
  setCategoryActive: { tabs: AUTH_TABS.concat(['Categories']), fn: (req, ctx) => actionSetCategoryActive_(req, ctx) },
  testKeywords: { tabs: AUTH_TABS.concat(['Categories', 'SupplierHistory']), fn: (req, ctx) => actionTestKeywords_(req, ctx) },
  keywordIdeas: { tabs: AUTH_TABS.concat(['Categories']), fn: (req, ctx) => actionKeywordIdeas_(req, ctx) },
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

  const xctx = { userId: ctx.user.user_id, ref: 'supplier:' + normName_(name).slice(0, 40) };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Please try again.');
  try {
    const r = findOrCreateSupplier_(ent, name, vat, xctx);
    return { supplier: { contactId: r.contact.ContactID, name: String(r.contact.Name) }, existing: r.existing };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The synced list first, then Xero itself (archived included), and only then a new contact.
 * Caller holds the script lock, so two buyers adding the same name can't both create it.
 * Returns { contact: { ContactID, Name }, existing }.
 */
function findOrCreateSupplier_(ent, name, vat, xctx) {
  const key = normName_(name);
  const cached = getRefData(ent).suppliers.find(s => normName_(s.name) === key);
  if (cached) return { contact: { ContactID: cached.contact_id, Name: String(cached.name) }, existing: true };

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
      auditLog({ userId: xctx.userId, entityId: ent, action: 'supplier.tenant_mismatch', ok: false, detail: { contactId: created.ContactID } });
      throw new AppError('TENANT_LEAK', 'The new supplier could not be confirmed in ' + ent + '’s Xero. Please tell your PO Desk admin.');
    }
    contact = check;
  }
  addSupplierToRef_(ent, contact);
  auditLog({ userId: xctx.userId, entityId: ent, action: 'supplier.create', ok: true, ref: contact.ContactID, detail: { existing: existing } });
  return { contact: contact, existing: existing };
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
    slip: bill ? Object.assign({ billId: bill.bill_id, reviewed: Number(bill.total_incl_zar) > 0, billed: !!bill.xero_invoice_id }, billView_(bill)) : null,
    decision: row.decided_at ? decisionView_(row) : null,
  };
}

/** Who approved or declined the PO, when, and their note (Stage 7). */
function decisionView_(row) {
  const by = row.approver_user_id ? findBy('Users', 'user_id', row.approver_user_id)[0] : null;
  return {
    by: by ? String(by.name) : '',
    at: row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
    note: String(row.decision_note || ''),
    self: !!by && String(row.approver_user_id) === String(row.buyer_user_id),
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

/** allowLocked: true only for read-only views; a slip that is on its way to Xero can't be changed. */
function requireSlipBill_(ctx, billId, allowLocked) {
  const id = str_(billId, 60);
  const bill = id ? findBy('Bills', 'bill_id', id)[0] : null;
  if (!bill) throw new AppError('NOT_FOUND', 'Slip not found.');
  const po = requireSlipPO_(ctx, bill.po_id);
  if (!allowLocked && isBillLocked_(bill)) {
    throw new AppError('BILL_LOCKED', bill.xero_invoice_id ? 'This slip is already on a Xero bill.' : 'This slip is already being sent to Xero.');
  }
  return { bill: bill, po: po };
}

/** Sent to Xero (or on its way): from then on the photo and details stay as they were sent. */
function isBillLocked_(bill) {
  return !!(bill && (bill.xero_invoice_id || bill.status));
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
    if (draft && isBillLocked_(draft)) { trashSlip_(file.getId()); throw new AppError('BILL_LOCKED', 'This slip is already being sent to Xero.'); }
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
  const { bill, po } = requireSlipBill_(ctx, req.payload.billId, true);
  const stored = parseJson_(bill.ocr_json) || {};
  const view = slipView_(bill, po, stored, stored.reviewed || null);
  if (req.payload.withImage === true) view.image = slipImageBase64_(bill.drive_file_id);
  return view;
}

// Kept for screens still open from before Stage 6; the review screen now saves through submitBill.
function actionSaveSlipReview_(req, ctx) {
  const { bill, po } = requireSlipBill_(ctx, req.payload.billId);
  const f = validateSlipFields_(req.payload.fields);
  const flags = slipFlags_(po, f, bill.bill_id);
  const stored = storeReview_(bill, f, flags, ctx, {});
  const fileName = slipFileName_(po, f.date, f.totalIncl);
  try { renameSlip_(bill.drive_file_id, fileName); } catch (err) { console.warn('Rename failed: ' + err.message); }
  auditLog({ userId: ctx.user.user_id, entityId: po.entity_id, action: 'slip.review', ref: bill.bill_id, ok: true, detail: { po: po.po_number, source: stored.source, edited: stored.edited, flags: flags.map(x => x.code) } });
  return { saved: true, billId: bill.bill_id, poId: po.po_id, flags: flags, fileName: fileName };
}

/** Writes the buyer's checked values (and `extra` columns) to the Bills row. Returns the new ocr_json object. */
function storeReview_(bill, f, flags, ctx, extra) {
  const stored = parseJson_(bill.ocr_json) || {};
  const ex = stored.extracted || {};
  const edited = stored.status === 'ok'
    ? ['supplierName', 'supplierVatNumber', 'slipNumber', 'date', 'totalIncl', 'vatAmount'].filter(k => String(ex[k] === null || ex[k] === undefined ? '' : ex[k]) !== String(f[k] === null ? '' : f[k]))
    : [];
  Object.assign(stored, { reviewed: f, reviewedAt: new Date().toISOString(), reviewedBy: ctx.user.user_id, source: stored.status === 'ok' ? 'gemini' : 'manual', edited: edited });
  updateRowById('Bills', 'bill_id', bill.bill_id, Object.assign({
    slip_number: f.slipNumber, slip_date: new Date(f.date + 'T12:00:00+02:00'), supplier_vat_no: f.supplierVatNumber,
    total_incl_zar: f.totalIncl, vat_zar: f.vatAmount === null ? '' : f.vatAmount,
    ocr_json: JSON.stringify(stored), flags: JSON.stringify(flags.map(x => x.code)),
  }, extra || {}));
  return stored;
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
  if (!reviewed && !manual && (fields.lineItems || []).length) fields = Object.assign({}, fields, { lineItems: itemAccounts_(po, fields.lineItems) });
  const poAcct = getRefData(po.entity_id).accounts.find(a => String(a.code) === String(po.account_code));
  return {
    billId: bill.bill_id,
    po: { poId: po.po_id, poNumber: String(po.po_number), supplierName: String(po.supplier_name), amountInclZar: Number(po.amount_incl_zar), createdAt: po.created_at instanceof Date ? po.created_at.toISOString() : String(po.created_at), entityId: po.entity_id,
      accountCode: String(po.account_code), accountName: poAcct ? String(poAcct.name) : '' },
    status: reviewed ? 'reviewed' : (stored.status || 'manual'),
    reason: stored.reason || (stored.status ? '' : 'The slip hasn’t been read yet.'),
    fields: fields,
    confidence: reviewed ? {} : (stored.confidence || {}),
    lowConfidence: reviewed || manual ? [] : (stored.lowConfidence || []),
    checks: reviewed || manual ? [] : (stored.checks || []),
    flags: fields.totalIncl ? slipFlags_(po, fields, bill.bill_id) : [],
    thresholds: slipThresholds_(),
    bill: billView_(bill),
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
    // Stage 9: the account this item goes to on the bill ('' = the PO's). Checked against the chart in billPlan_.
    const accountCode = text(li && li.accountCode, 12).replace(/[^\w.\-]/g, '');
    return { description: description, qty: qty === null ? 1 : qty, unitPriceIncl: unit === null || isNaN(unit) ? null : unit, lineTotalIncl: total, accountCode: accountCode };
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

// --- Flow 2 step 6: the draft bill in Xero (Stage 6) ------------------------------------------
//
// Xero has no field linking a bill to a PO, so the link is: the PO number in the bill's Reference,
// the same slip attached to both, the PO set to BILLED, a History note on each, and the Bills row.
// Every step is keyed on billId and recorded in Bills.steps_json the moment it succeeds, so a retry
// (by the queue, or the buyer tapping again) only does what is left and never makes a second bill.

const BILL_STATUS = Object.freeze({ POSTING: 'POSTING', QUEUED: 'QUEUED', BILLED: 'BILLED' });
// The bill is BILLED once these are done. History notes are "if reachable": tried twice, never queued alone.
const BILL_STEPS = Object.freeze(['attachBill', 'attachPO', 'poBilled']);
const BILL_NOTE_STEPS = Object.freeze(['noteBill', 'notePO']);
const BILL_RULES = Object.freeze({ NOTE_MAX_TRIES: 2, RATE_MAX: 30, RATE_WINDOW_S: 3600, SAFETY_NET_MIN: 10 });

/**
 * Checks the reviewed values again on the server, settles the supplier, then creates the DRAFT bill
 * and runs the remaining steps. payload: { billId, fields, supplier?: { mode: 'keep' } |
 * { mode: 'existing', contactId } | { mode: 'new' } } — supplier is required when the slip's
 * supplier doesn't match the PO's. Submitting again returns the first bill (duplicate: true).
 * A slip that looks like one already captured needs confirmDuplicate: true (paying twice is the risk).
 */
function actionSubmitBill_(req, ctx) {
  const T = stepTimer_(ctx);
  const p = req.payload;
  const { bill, po } = requireSlipBill_(ctx, p.billId, true);
  if (readTable('Bills').headers.indexOf('steps_json') === -1) throw new AppError('SETUP_ORDER', 'PO Desk needs a quick update before bills can be made. Ask your PO Desk admin to run setupSheets().');
  if (isBillLocked_(bill)) return Object.assign(billResult_(bill, po), { duplicate: true });
  if (po.status !== PO_STATUS.ISSUED) throw new AppError('BAD_REQUEST', slipStatusMessage_(po));
  if (!bill.drive_file_id) throw new AppError('BAD_REQUEST', 'Photograph the slip first.');
  const f = validateSlipFields_(p.fields);
  const flags = slipFlags_(po, f, bill.bill_id);
  billPlan_(po, f, po.contact_id);   // VAT and tax-type problems surface now, before anything reaches Xero
  const mismatch = flags.some(x => x.code === 'SUPPLIER_MISMATCH');
  const choice = p.supplier && typeof p.supplier === 'object' ? p.supplier : null;
  if (mismatch && !choice) {
    throw new AppError('SUPPLIER_CHOICE', 'The slip is from “' + f.supplierName + '”, but the PO is for “' + po.supplier_name + '”. Choose which supplier the bill is for.');
  }
  // Warn, don't block — but a typed-in slip number is only checked here, so ask once before a second bill.
  const dup = flags.find(x => x.code === 'DUPLICATE');
  if (dup && p.confirmDuplicate !== true) throw new AppError('DUPLICATE_CHECK', dup.message + ' Create the bill anyway?');
  rateLimit_('bill', ctx.user.user_id, BILL_RULES.RATE_MAX, BILL_RULES.RATE_WINDOW_S);
  T.mark('prep');

  const xctx = { userId: ctx.user.user_id, ref: bill.bill_id };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PO_RULES.LOCK_WAIT_MS)) throw new AppError('BUSY', 'PO Desk is busy. Tap Create the bill again: it won’t make a second bill.');
  let supplier;
  try {
    // Inside the lock: a double tap waits here, then finds the bill already claimed.
    invalidateTable_('Bills');
    const cur = findBy('Bills', 'bill_id', bill.bill_id)[0];
    if (!cur || String(cur.drive_file_id) !== String(bill.drive_file_id)) throw new AppError('CONFLICT', 'The slip changed while you were checking it. Open it again.');
    if (isBillLocked_(cur)) return Object.assign(billResult_(cur, po), { duplicate: true });
    supplier = mismatch && choice.mode !== 'keep' ? resolveBillSupplier_(po, f, choice, xctx) : { contactId: String(po.contact_id), name: String(po.supplier_name), created: false };
    const plan = billPlan_(po, f, supplier.contactId);
    // A new round per submission, so Xero's stored answer to a refused earlier attempt is never replayed.
    const round = (Number((parseJson_(cur.steps_json) || {}).round) || 0) + 1;
    const steps = {
      v: 1, round: round, reference: plan.reference, contactId: supplier.contactId, supplierName: supplier.name,
      contactChanged: supplier.contactId !== String(po.contact_id), supplierCreated: supplier.created, supplierChoice: mismatch ? choice.mode : '',
      notes: flags.map(x => x.message), buyer: firstName_(ctx.user.name), mode: plan.mode,
      tries: { bill: 1 }, done: {}, startedAt: new Date().toISOString(),
    };
    storeReview_(cur, f, flags, ctx, { status: BILL_STATUS.POSTING, steps_json: JSON.stringify(steps) });
    // Safety net: if this request dies half-way, the queue finishes the job from what was recorded.
    enqueueBillJob_(bill.bill_id, new Date(Date.now() + BILL_RULES.SAFETY_NET_MIN * 60000));
  } finally {
    lock.releaseLock();
  }
  // Final name before attaching, so Xero shows <PO>_<date>_<supplier>_<total>.jpg too.
  try { renameSlip_(bill.drive_file_id, slipFileName_(po, f.date, f.totalIncl)); } catch (err) { console.warn('Rename failed: ' + err.message); }
  T.mark('claim');

  const r = runBillSteps_(bill.bill_id, { userId: ctx.user.user_id, fromSubmit: true });
  T.mark('xero');
  if (r.rejected) {
    dropBillJob_(bill.bill_id);
    auditLog({ userId: ctx.user.user_id, entityId: po.entity_id, action: 'bill.submit', ref: bill.bill_id, ok: false, detail: { rejected: r.rejected, ms: T.all() } });
    throw new AppError('XERO_REJECTED', 'Xero didn’t accept this bill: ' + r.rejected);
  }
  if (r.status === BILL_STATUS.BILLED) dropBillJob_(bill.bill_id);
  else setBillJobDue_(bill.bill_id, new Date(), r.error);   // the next queue run (≤ 5 min) carries on
  T.mark('finish');

  invalidateTable_('Bills');
  invalidateTable_('POs');
  const freshBill = findBy('Bills', 'bill_id', bill.bill_id)[0];
  const freshPo = findBy('POs', 'po_id', po.po_id)[0];
  const ms = T.all();
  auditLog({
    userId: ctx.user.user_id, entityId: po.entity_id, action: 'bill.submit', ref: bill.bill_id, ok: true,
    detail: { po: po.po_number, status: r.status, reference: r.reference, pending: r.pending, supplierChanged: supplier.contactId !== String(po.contact_id), flags: flags.map(x => x.code), ms: ms },
  });
  return Object.assign(billResult_(freshBill, freshPo), { flags: flags, serverMs: ms });
}

/** What the browser gets back from submitBill: the PO, the bill state and where the slip is. */
function billResult_(bill, po) {
  return Object.assign({ billId: bill.bill_id, poId: po.po_id, poNumber: String(po.po_number), poStatus: po.status }, billView_(bill));
}

/** The bill's state as the browser sees it (PO detail, review screen). No Xero IDs. */
function billView_(bill) {
  const steps = parseJson_(bill.steps_json) || {};
  const done = steps.done || {};
  const status = String(bill.status || '');
  const pending = status === BILL_STATUS.QUEUED || status === BILL_STATUS.POSTING
    ? (bill.xero_invoice_id ? [] : ['bill']).concat(BILL_STEPS.filter(k => !done[k]))
    : [];
  const x = steps.xero || {};
  return {
    billStatus: status,
    billRef: steps.reference || '',
    invoiceCreated: !!bill.xero_invoice_id,
    pending: pending,
    xeroTotal: x.total === undefined ? null : x.total,
    xeroVat: x.tax === undefined ? null : x.tax,
    vatMatches: steps.vatMatches === undefined ? null : steps.vatMatches,
    billSupplier: steps.supplierName || '',
    supplierChanged: !!steps.contactChanged,
    billError: status === BILL_STATUS.QUEUED ? truncate_(steps.lastError || '', 200) : '',
    rejected: status ? '' : truncate_(steps.rejected || '', 300),
    // Opens in Google Drive for the account that owns PO Desk only: the file is never shared.
    slipUrl: bill.drive_file_id ? 'https://drive.google.com/file/d/' + encodeURIComponent(bill.drive_file_id) + '/view' : '',
  };
}

/**
 * The supplier the buyer chose when the slip's name didn't match the PO's: one already in the list,
 * or the name on the slip, found by VAT number, by name, in Xero, or else created there.
 */
function resolveBillSupplier_(po, f, choice, xctx) {
  const ent = po.entity_id;
  const suppliers = getRefData(ent).suppliers;
  if (choice.mode === 'existing') {
    const s = suppliers.find(x => String(x.contact_id) === String(choice.contactId));
    if (!s) throw new AppError('BAD_REQUEST', 'That supplier isn’t in ' + ent + '’s list any more. Choose again.');
    return { contactId: String(s.contact_id), name: String(s.name), created: false };
  }
  if (choice.mode !== 'new') throw new AppError('BAD_REQUEST', 'Choose which supplier the bill is for.');
  // A VAT number identifies the business better than a name printed on a till slip.
  if (f.supplierVatNumber) {
    const byVat = suppliers.filter(x => String(x.vat_number || '').replace(/\D/g, '') === f.supplierVatNumber);
    if (byVat.length === 1) return { contactId: String(byVat[0].contact_id), name: String(byVat[0].name), created: false };
  }
  const r = findOrCreateSupplier_(ent, f.supplierName, f.supplierVatNumber, xctx);
  return { contactId: String(r.contact.ContactID), name: String(r.contact.Name), created: !r.existing };
}

/** "<PO number> · <slip number>" (CLAUDE.md Flow 2 step 6). */
function billReference_(po, f) {
  return String(po.po_number) + (f.slipNumber ? ' · ' + f.slipNumber : '');
}

function round2_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * The bill as Xero should get it, worked out from the checked slip. VAT:
 *  - no supplier VAT number, or a slip with R0.00 VAT (fuel is zero-rated): every line at the no-VAT type;
 *  - VAT about rate/(100+rate) of the total (within the slip-reading tolerance): every line at 15%;
 *  - less VAT than that: a mixed slip (e.g. diesel plus a cold drink): one 15% line big enough to
 *    carry exactly the slip's VAT, and one no-VAT line for the rest, since the slip doesn't say which
 *    item is which.
 * Xero works out each line's VAT itself; when the sum misses the slip's VAT by a few cents, the biggest
 * line's TaxAmount is set so the bill's VAT equals the slip's to the cent.
 */
function billPlan_(po, f, contactId) {
  const ent = po.entity_id;
  const rates = {};
  getRefData(ent).taxRates.forEach(r => { if (String(r.status) === 'ACTIVE') rates[String(r.tax_type)] = Number(r.rate); });
  const noVat = String(getConfig('NO_VAT_TAX_TYPE', 'NONE'));
  const poType = String(po.tax_type || '');
  // Keep the PO's own VAT type if it is a standard-rate one (e.g. a capital-goods type); the old 14% never.
  const vatType = rates[poType] > 0 && rates[poType] !== 14 ? poType : String(getConfig('PURCHASE_TAX_TYPE', 'INPUT3'));
  if (!(rates[vatType] > 0) || !(noVat in rates)) throw new AppError('CONFIG_MISSING', 'The VAT types for bills aren’t set up for ' + ent + '. Please tell your PO Desk admin.');
  const rate = rates[vatType];
  const taxOf = (amount) => round2_(amount * rate / (100 + rate));
  const total = round2_(f.totalIncl);
  const vat = f.vatAmount === null || f.vatAmount === undefined ? null : round2_(f.vatAmount);
  const fullVat = taxOf(total);
  const tol = Math.max(OCR.VAT_TOLERANCE_ZAR, fullVat * OCR.VAT_TOLERANCE_PCT / 100);
  let mode;
  if (!f.supplierVatNumber || vat === 0) mode = 'none';
  else if (vat === null || Math.abs(vat - fullVat) <= tol) mode = 'full';
  else if (vat < fullVat) mode = 'mixed';
  else throw new AppError('BAD_REQUEST', 'The VAT on the slip (' + randText_(vat) + ') is more than ' + rate + '% VAT on the total can be (' + randText_(fullVat) + '). Check both amounts.');

  const what = String(po.description);
  // Which account each part goes to (Stage 9): every item carries one (the PO's unless the buyer or a
  // suggestion chose another). Items count only when they add up to the total exactly; then each account
  // gets ONE line listing its items. Items on several accounts that don't add up can't be split: refused.
  const poAccount = String(po.account_code);
  const allowed = allowedAccounts_({ accounts: getRefData(ent).accounts, config: { extraAccounts: getConfig('EXTRA_PURCHASE_ACCOUNTS_' + ent, '') } }, ent);
  const items = (f.lineItems || []).map(li => Object.assign({}, li, { accountCode: String(li.accountCode || poAccount) }));
  items.forEach(li => {
    if (li.accountCode !== poAccount && !allowed[li.accountCode]) throw new AppError('BAD_REQUEST', 'Account ' + li.accountCode + ' can’t be used for “' + li.description + '”. Choose another account for it.');
  });
  const itemSum = round2_(items.reduce((s, li) => s + Number(li.lineTotalIncl), 0));
  const itemsAddUp = items.length > 0 && Math.abs(itemSum - total) < 0.005;
  const accountsUsed = uniq_(items.map(li => li.accountCode));
  if (!itemsAddUp && accountsUsed.length > 1) {
    throw new AppError('BAD_REQUEST', 'The items add up to ' + randText_(itemSum) + ', not the total ' + randText_(total) + '. Correct the amounts, or put the whole slip on one account.');
  }
  const itemName = (li) => li.description + (li.qty && li.qty !== 1 ? ' × ' + li.qty : '');
  let groups;
  if (itemsAddUp) {
    // In the order the accounts first appear on the slip (object keys like "426" would sort numerically).
    const by = {};
    const order = [];
    items.forEach(li => { if (!by[li.accountCode]) { by[li.accountCode] = []; order.push(li.accountCode); } by[li.accountCode].push(li); });
    groups = order.map(code => ({
      code: code, a: round2_(by[code].reduce((s, li) => s + Number(li.lineTotalIncl), 0)),
      d: by[code].length === 1 ? itemName(by[code][0]) : by[code].map(li => itemName(li) + ' ' + randText_(li.lineTotalIncl)).join('; '),
    }));
  } else {
    groups = [{ code: accountsUsed[0] || poAccount, a: total, d: what }];
  }

  let lines;
  if (mode === 'none' || mode === 'full') {
    lines = groups.map(g => ({ d: g.d, a: g.a, t: mode === 'none' ? noVat : vatType, code: g.code }));
  } else {
    // Mixed slip (less VAT than the total would carry). The rule (4 Nov 2026): no VAT on fuel. If the
    // slip's VAT is exactly what the non-fuel accounts carry, that is the split.
    const zero = String(getConfig('ZERO_RATED_ACCOUNTS', '433')).split(/[,;\s]+/).filter(Boolean);
    const fuel = groups.filter(g => zero.indexOf(g.code) !== -1);
    const rest = groups.filter(g => zero.indexOf(g.code) === -1);
    if (fuel.length && rest.length && Math.abs(round2_(rest.reduce((s, g) => s + taxOf(g.a), 0)) - vat) <= tol) {
      lines = groups.map(g => ({ d: g.d, a: g.a, t: zero.indexOf(g.code) !== -1 ? noVat : vatType, code: g.code }));
    } else {
      // Otherwise the part carrying VAT (slip VAT × (100+rate)/rate) is shared over the accounts in
      // proportion, each with its VAT-free remainder: the total VAT is right; the accountant fine-tunes.
      const taxable = Math.min(total, round2_(vat * (100 + rate) / rate));
      const shares = groups.map(g => round2_(g.a * taxable / total));
      const biggest = groups.reduce((bi, g, i) => (g.a > groups[bi].a ? i : bi), 0);
      shares[biggest] = round2_(shares[biggest] + taxable - shares.reduce((s, x) => s + x, 0));
      const one = groups.length === 1;
      lines = [];
      groups.forEach((g, i) => {
        const label = one ? what : g.d;
        if (shares[i] > 0) lines.push({ d: label + ' (items with VAT)', a: shares[i], t: vatType, code: g.code });
        const left = round2_(g.a - shares[i]);
        if (left > 0) lines.push({ d: label + ' (items without VAT: zero-rated or exempt)', a: left, t: noVat, code: g.code });
      });
    }
  }
  lines.forEach(l => { l.tax = l.t === noVat ? 0 : taxOf(l.a); });
  let expectTax = round2_(lines.reduce((s, l) => s + l.tax, 0));
  let overrides = false;
  if (mode !== 'none' && vat !== null && Math.abs(vat - expectTax) >= 0.005) {
    const big = lines.filter(l => l.t !== noVat).sort((a, b) => Math.abs(b.a) - Math.abs(a.a))[0];
    big.tax = round2_(big.tax + vat - expectTax);
    big.override = true;
    overrides = true;
    expectTax = vat;
  }
  const reference = billReference_(po, f);
  const invoice = (withOverrides) => ({
    Contact: { ContactID: contactId }, Date: f.date, DueDate: f.date, InvoiceNumber: reference, Reference: reference,
    LineItems: lines.map(l => {
      const li = { Description: truncate_(l.d, 4000), Quantity: 1, UnitAmount: l.a, AccountCode: l.code, TaxType: l.t };
      if (withOverrides && l.override) li.TaxAmount = l.tax;
      return li;
    }),
  });
  return { reference: reference, mode: mode, total: total, expectTax: expectTax, overrides: overrides, invoice: invoice(true), invoicePlain: overrides ? invoice(false) : null, lines: lines.length, accounts: uniq_(lines.map(l => l.code)) };
}

/** The account each slip item goes to: its own confident suggestion (keyword rules or learned words), else the PO's. */
function itemAccounts_(po, items) {
  const ent = po.entity_id;
  const poAccount = String(po.account_code);
  let data = null;
  try { data = codingData_(ent); } catch (err) { data = null; }
  return items.map(li => {
    if (li.accountCode) return li;
    let code = poAccount;
    if (data) {
      const s = suggestAccountWith_(data, ent, '', '', li.description);
      if (['keyword', 'words', 'borrowed'].indexOf(s.source) !== -1 && s.accountCode) code = s.accountCode;
    }
    return Object.assign({}, li, { accountCode: code });
  });
}

/**
 * Runs whatever is left for one bill: the bill itself, the slip on the bill and on the PO, History
 * notes, then the PO's status. Never throws for a Xero failure: it records it and returns
 * { status, reference, pending, error } or { rejected } when Xero refused the bill's data.
 * opts.fromSubmit: the first run, straight from the buyer's tap (nothing can exist in Xero yet).
 */
function runBillSteps_(billId, opts) {
  opts = opts || {};
  invalidateTable_('Bills');
  invalidateTable_('POs');
  const bill = findBy('Bills', 'bill_id', billId)[0];
  if (!bill) return { status: 'GONE' };
  const po = findBy('POs', 'po_id', bill.po_id)[0];
  const steps = parseJson_(bill.steps_json) || {};
  steps.done = steps.done || {};
  steps.tries = steps.tries || {};
  const errors = {};
  const f = (parseJson_(bill.ocr_json) || {}).reviewed;
  if (!po || !f || !steps.contactId) throw new AppError('BAD_JOB', 'Bill ' + billId + ' has no checked slip or supplier.');
  const t = entityById_(po.entity_id).xero_tenant_id;
  const ctx = { userId: opts.userId || bill.created_by, entityId: po.entity_id, ref: billId };
  const idem = (step) => 'po-desk-' + step + '-' + billId + '-r' + (Number(steps.round) || 1) + '-' + steps.tries[step];

  // 1. The bill.
  let invoiceId = String(bill.xero_invoice_id || '');
  if (!invoiceId) {
    let created = null;
    let adopted = false;
    try {
      const plan = billPlan_(po, f, steps.contactId);
      if (!opts.fromSubmit) {
        // An earlier try may have created the bill and lost the answer: find it before making one.
        steps.tries.bill = (Number(steps.tries.bill) || 1) + 1;
        writeBillState_(billId, steps, {});
        created = xeroFindBillByNumber(t, steps.contactId, plan.reference, ctx);
        adopted = !!created;
      }
      if (!created) created = createBillWithFallback_(t, plan, idem('bill'), steps, ctx);
      steps.xero = { total: round2_(created.Total), tax: round2_(created.TotalTax), number: String(created.InvoiceNumber || '') };
      steps.totalMatches = Math.abs(Number(created.Total) - plan.total) < 0.005;
      steps.vatMatches = Math.abs(Number(created.TotalTax) - plan.expectTax) < 0.005;
    } catch (err) {
      if (isXeroRejection_(err)) {
        steps.rejected = err.message;
        writeBillState_(billId, steps, { status: '' });
        notifyBillRejected_(bill, po, err.message, opts.fromSubmit);
        return { status: '', rejected: err.message };
      }
      steps.lastError = 'Creating the bill: ' + truncate_(err.message, 250);
      writeBillState_(billId, steps, { status: BILL_STATUS.QUEUED });
      return { status: BILL_STATUS.QUEUED, reference: steps.reference, pending: ['bill'].concat(BILL_STEPS), error: steps.lastError };
    }
    invoiceId = String(created.InvoiceID);
    steps.done.bill = new Date().toISOString();
    if (adopted) steps.adopted = true;
    delete steps.rejected;
    markBillCreated_(bill, po, invoiceId, steps);
  }

  // 2. The slip on both records, and the bill's note (independent: in parallel).
  const want = (k) => !steps.done[k] && !(BILL_NOTE_STEPS.indexOf(k) !== -1 && (Number(steps.tries[k]) || 0) >= BILL_RULES.NOTE_MAX_TRIES);
  let file = null;
  if (want('attachBill') || want('attachPO')) {
    file = DriveApp.getFileById(bill.drive_file_id);
    keepSlipPrivate_(file);
  }
  const fileName = file ? file.getName() : '';
  if (file && !opts.fromSubmit) {
    // A lost answer may hide an attachment that did arrive: look before sending the photo again.
    [['attachBill', 'Invoices', invoiceId], ['attachPO', 'PurchaseOrders', String(po.xero_po_id)]].forEach(([k, type, id]) => {
      if (!want(k) || !(Number(steps.tries[k]) > 0)) return;
      try { if (xeroListAttachments(t, type, id, ctx).some(a => a.FileName === fileName)) steps.done[k] = new Date().toISOString(); } catch (err) { /* attach again below */ }
    });
  }
  const blob = file ? file.getBlob() : null;
  const b64 = blob && (want('attachBill') || want('attachPO')) ? Utilities.base64Encode(blob.getBytes()) : '';
  const group1 = [];
  if (want('attachBill')) group1.push(['attachBill', () => xeroAttachmentCall_(t, 'Invoices', invoiceId, fileName, b64, 'image/jpeg', idem('attachBill'))]);
  if (want('attachPO')) group1.push(['attachPO', () => xeroAttachmentCall_(t, 'PurchaseOrders', String(po.xero_po_id), fileName, b64, 'image/jpeg', idem('attachPO'))]);
  if (want('noteBill')) group1.push(['noteBill', () => xeroHistoryCall_(t, 'Invoices', invoiceId, billNoteText_(po, f, steps), idem('noteBill'))]);
  runBillGroup_(group1, steps, errors, ctx);

  // 3. The PO's status once its slip is on it (Xero may refuse attachments on a billed PO), and its note.
  const group2 = [];
  if (want('poBilled') && steps.done.attachPO) group2.push(['poBilled', () => xeroPoUpdateCall_(t, String(po.xero_po_id), 'BILLED', steps.contactChanged ? steps.contactId : '', idem('poBilled'))]);
  if (want('notePO')) group2.push(['notePO', () => xeroHistoryCall_(t, 'PurchaseOrders', String(po.xero_po_id), poNoteText_(f, steps), idem('notePO'))]);
  runBillGroup_(group2, steps, errors, ctx);
  if (errors.poBilled && errors.poBilled.rejected && steps.contactChanged && !steps.poContactRefused) {
    // Moving the PO to the slip's supplier is a nicety; marking it BILLED is not. Try without it.
    steps.poContactRefused = errors.poBilled.message;
    runBillGroup_([['poBilled', () => xeroPoUpdateCall_(t, String(po.xero_po_id), 'BILLED', '', idem('poBilled') + '-nc')]], steps, errors, ctx);
  }
  if (errors.poBilled) {
    // Already BILLED (e.g. the answer was lost last time)? Then the step is done.
    try { const cur = xeroGetPurchaseOrder(t, String(po.xero_po_id), ctx); if (cur && cur.Status === 'BILLED') { steps.done.poBilled = new Date().toISOString(); delete errors.poBilled; } } catch (err) { /* stays pending */ }
  }

  const pending = BILL_STEPS.filter(k => !steps.done[k]);
  const status = pending.length ? BILL_STATUS.QUEUED : BILL_STATUS.BILLED;
  const errText = Object.keys(errors).map(k => k + ': ' + errors[k].message).join(' | ');
  if (errText) steps.lastError = truncate_(errText, 300); else if (!pending.length) delete steps.lastError;
  if (!pending.length) steps.finishedAt = new Date().toISOString();
  writeBillState_(billId, steps, { status: status });
  return { status: status, reference: steps.reference, pending: pending, error: errText, vatMatches: steps.vatMatches };
}

/** Creates the bill; if Xero refuses the cent-level VAT adjustment, creates it without and says so. */
function createBillWithFallback_(t, plan, idemKey, steps, ctx) {
  try {
    return xeroCreateBillInclusive(t, plan.invoice, idemKey, ctx);
  } catch (err) {
    if (!plan.invoicePlain || !isXeroRejection_(err)) throw err;
    steps.taxOverrideRefused = truncate_(err.message, 200);
    return xeroCreateBillInclusive(t, plan.invoicePlain, idemKey + '-plain', ctx);
  }
}

/**
 * Runs [[step, () => call]] in parallel and records each outcome on `steps`, or in `errors` as
 * { message, rejected } (rejected: Xero refused the data itself, so the same request won't succeed).
 */
function runBillGroup_(group, steps, errors, ctx) {
  if (!group.length) return;
  const calls = [];
  group.forEach(([k, make]) => {
    steps.tries[k] = (Number(steps.tries[k]) || 0) + 1;
    try { calls.push([k, make()]); } catch (err) { errors[k] = { message: err.message, rejected: true }; }
  });
  const results = xeroProxyAll_(calls.map(c => c[1]), ctx);
  results.forEach((r, i) => {
    const k = calls[i][0];
    const verr = r.ok ? xeroValidationMessages_(r.data) : [];
    if (r.ok && !verr.length) { steps.done[k] = new Date().toISOString(); delete errors[k]; return; }
    const code = Number(r.upstream) || 0;
    errors[k] = { message: truncate_(verr.join('; ') || r.error || 'failed', 200), rejected: verr.length > 0 || (code >= 400 && code < 500 && [401, 403, 408, 429].indexOf(code) === -1) };
  });
}

function billNoteText_(po, f, steps) {
  const parts = ['PO Desk: bill for purchase order ' + po.po_number + ' (PO amount ' + randText_(Number(po.amount_incl_zar)) + ').',
    'Slip ' + (f.slipNumber || 'without a number') + ' of ' + f.date + ', checked by ' + (steps.buyer || 'the buyer') + '; the photo is attached.'];
  if (steps.contactChanged) parts.push('Supplier changed at the buyer’s choice from the PO’s supplier to ' + steps.supplierName + '.');
  else if (steps.supplierChoice === 'keep') parts.push('The slip names another supplier; the buyer kept the PO’s supplier.');
  if (steps.mode === 'mixed') parts.push('Mixed slip: one line carries the slip’s VAT, the rest is without VAT.');
  if ((steps.notes || []).length) parts.push('Notes: ' + steps.notes.join(' '));
  return parts.join(' ');
}

function poNoteText_(f, steps) {
  return 'PO Desk: billed on draft bill ' + steps.reference + ' (slip total ' + randText_(f.totalIncl) + (f.vatAmount === null ? '' : ', VAT ' + randText_(f.vatAmount)) + ').';
}

/** Bills row and POs row once the bill exists. Under the lock: both tabs are shared with buyers. */
function markBillCreated_(bill, po, invoiceId, steps) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    invalidateTable_('Bills');
    invalidateTable_('POs');
    updateRowById('Bills', 'bill_id', bill.bill_id, { xero_invoice_id: invoiceId, steps_json: JSON.stringify(steps) });
    const patch = { status: PO_STATUS.BILLED, bill_id: bill.bill_id };
    if (steps.contactChanged) { patch.contact_id = steps.contactId; patch.supplier_name = steps.supplierName; }
    updateRowById('POs', 'po_id', po.po_id, patch);
  } finally {
    lock.releaseLock();
  }
}

function writeBillState_(billId, steps, patch) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    invalidateTable_('Bills');
    updateRowById('Bills', 'bill_id', billId, Object.assign({ steps_json: JSON.stringify(steps) }, patch || {}));
  } finally {
    lock.releaseLock();
  }
}

/** Slips are never shared: "View slip" opens only for the Google account that owns PO Desk. */
function keepSlipPrivate_(file) {
  try {
    if (file.getSharingAccess() !== DriveApp.Access.PRIVATE) file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (err) {
    console.warn('Could not check sharing of slip ' + file.getId() + ': ' + err.message);
  }
}

/** One queue job per bill. Caller holds the lock. */
function enqueueBillJob_(billId, when) {
  invalidateTable_('Queue');
  const job = readTable('Queue').rows.find(j => j.type === 'billSteps' && (parseJson_(j.payload_json) || {}).billId === billId);
  if (job) { updateRowById('Queue', 'job_id', job.job_id, { next_run_at: when }); return; }
  appendRow('Queue', { job_id: Utilities.getUuid(), type: 'billSteps', payload_json: JSON.stringify({ billId: billId }), attempts: 0, next_run_at: when, last_error: '' });
}

function setBillJobDue_(billId, when, error) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    invalidateTable_('Queue');
    const job = readTable('Queue').rows.find(j => j.type === 'billSteps' && (parseJson_(j.payload_json) || {}).billId === billId);
    if (job) updateRowById('Queue', 'job_id', job.job_id, { next_run_at: when, last_error: truncate_(error || '', 300) });
    else enqueueBillJob_(billId, when);
  } finally {
    lock.releaseLock();
  }
}

function dropBillJob_(billId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    invalidateTable_('Queue');
    readTable('Queue').rows.filter(j => j.type === 'billSteps' && (parseJson_(j.payload_json) || {}).billId === billId)
      .map(j => j._row).sort((a, b) => b - a).forEach(n => sheet_('Queue').deleteRow(n));
    invalidateTable_('Queue');
  } finally {
    lock.releaseLock();
  }
}

/** A queued bill that Xero then refused: the buyer is told to correct it (and admins, as a backstop). */
function notifyBillRejected_(bill, po, message, buyerIsWaiting) {
  if (buyerIsWaiting) return;   // they see the message on screen
  const buyer = findBy('Users', 'user_id', po.buyer_user_id)[0];
  const body = 'Xero didn’t accept the bill for ' + po.po_number + ' (' + po.supplier_name + '):\n\n' + message +
    '\n\nOpen the PO in PO Desk, correct the slip details and tap Create the bill again.';
  if (buyer) sendMail_(buyer.email, 'PO Desk: the bill for ' + po.po_number + ' needs a correction', body);
  alertAdmins_('a bill was refused by Xero', body);
}
