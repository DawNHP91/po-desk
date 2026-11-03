/**
 * Tests.gs — Stage 1 checks and the Xero integration spike. Run from the Apps Script editor
 * (pick the function in the toolbar, press Run, read View → Logs / Execution log).
 *
 * The editor cannot pass arguments, so each spike has one wrapper per company (spikePO_NHP …).
 * Spike state (test contact, PO, bill IDs) is kept in Script Property SPIKE_<ENTITY> so the
 * steps can run as separate executions and cleanup() knows what to delete.
 */

const SPIKE_CONTACT_NAME = 'PO Desk Test Supplier';
const SPIKE_LINE_TEXT = 'PO Desk integration test - please ignore';
const SPIKE_ATTENTION = 'PO Desk spike';

// A 96x51 JPEG (the Pharma Karu logo, 2.4 KB) so the spike needs nothing uploaded by hand.
const SPIKE_JPG_B64 = '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';

// --- Wrappers for the editor's Run menu ---------------------------------------------------------
function spikePO_NHP() { return spikePO('NHP'); }
function spikeAttachment_NHP() { return spikeAttachment('NHP'); }
function spikeBill_NHP() { return spikeBill('NHP'); }
function cleanup_NHP() { return cleanup('NHP'); }
function spikePO_HPB() { return spikePO('HPB'); }
function spikeAttachment_HPB() { return spikeAttachment('HPB'); }
function spikeBill_HPB() { return spikeBill('HPB'); }
function cleanup_HPB() { return cleanup('HPB'); }
function spikePO_PK() { return spikePO('PK'); }
function spikeAttachment_PK() { return spikeAttachment('PK'); }
function spikeBill_PK() { return spikeBill('PK'); }
function cleanup_PK() { return cleanup('PK'); }

/** PO → attachment → bill in one run. Cleanup stays separate so the records can be eyeballed in Xero first. */
function spikeAll_NHP() { spikePO('NHP'); spikeAttachment('NHP'); spikeBill('NHP'); }
function spikeAll_HPB() { spikePO('HPB'); spikeAttachment('HPB'); spikeBill('HPB'); }
function spikeAll_PK() { spikePO('PK'); spikeAttachment('PK'); spikeBill('PK'); }

// --- Offline checks (no Composio calls) ------------------------------------------------------

/** Proves the tenant guard rejects blank, unknown and Nandrea tenants before any network call. */
function testTenantGuard() {
  const cases = [
    { label: 'undefined', id: undefined, expect: 'TENANT_REQUIRED' },
    { label: 'empty', id: '', expect: 'TENANT_REQUIRED' },
    { label: 'spaces', id: '   ', expect: 'TENANT_REQUIRED' },
    { label: 'number', id: 12345, expect: 'TENANT_REQUIRED' },
    { label: 'Nandrea', id: 'e775d9d3-4807-4163-9941-029493fa272b', expect: 'TENANT_BLOCKED' },
    { label: 'Nandrea upper-case', id: 'E775D9D3-4807-4163-9941-029493FA272B', expect: 'TENANT_BLOCKED' },
    { label: 'unknown uuid', id: '00000000-0000-0000-0000-000000000000', expect: 'TENANT_UNKNOWN' },
  ].concat(ENTITY_SEED.map(e => ({ label: e.entity_id, id: e.xero_tenant_id, expect: 'OK:' + e.entity_id })));

  let failures = 0;
  const lines = cases.map(c => {
    let got;
    try { got = 'OK:' + assertTenant_(c.id).entityId; } catch (err) { got = err.code || err.message; }
    const pass = got === c.expect;
    if (!pass) failures++;
    return (pass ? 'PASS ' : 'FAIL ') + pad_(c.label, 20) + ' expected ' + pad_(c.expect, 16) + ' got ' + got;
  });
  // Also prove a helper can't be talked into another org through its args.
  let override;
  try {
    xeroTool_('XERO_GET_ORGANISATION', '', { tenant_id: ENTITY_SEED[0].xero_tenant_id });
    override = 'FAIL helper accepted tenant_id from args with a blank tenantId';
    failures++;
  } catch (err) {
    override = (err.code === 'TENANT_REQUIRED' ? 'PASS ' : 'FAIL ') + 'tenant_id in args does not bypass the guard (' + err.code + ')';
    if (err.code !== 'TENANT_REQUIRED') failures++;
  }
  lines.push(override);
  out_('testTenantGuard: ' + (failures ? failures + ' FAILURE(S)' : 'all passed'), lines.join('\n'));
}

/** Run after setupSheets/setupDrive (twice) to prove nothing was duplicated. */
function checkNoDuplicates() {
  const dupes = (rows, keyFn) => {
    const seen = {}; const d = [];
    rows.forEach(r => { const k = keyFn(r); if (seen[k]) d.push(k); seen[k] = true; });
    return d;
  };
  const report = {
    tabs: Object.keys(TABLES).map(n => n + ':' + (db_().getSheetByName(n) ? 'ok' : 'MISSING')).join(', '),
    configDuplicates: dupes(readTable('Config').rows, r => String(r.key)),
    entityDuplicates: dupes(readTable('Entities').rows, r => String(r.entity_id)),
    paymentMethodDuplicates: dupes(readTable('PaymentMethods').rows, paymentMethodKey_),
    entitiesMissingFolder: readTable('Entities').rows.filter(r => !r.drive_folder_id).map(r => r.entity_id),
    driveFolderDuplicates: [],
  };
  const rootId = getOptionalSecret_('DRIVE_ROOT_ID');
  if (rootId) {
    const root = DriveApp.getFolderById(rootId);
    ENTITY_SEED.forEach(e => {
      const it = root.getFoldersByName(e.entity_id); let n = 0;
      while (it.hasNext()) { it.next(); n++; }
      if (n !== 1) report.driveFolderDuplicates.push(e.entity_id + ' x' + n);
    });
    const top = DriveApp.getRootFolder().getFoldersByName('PO Desk'); let n = 0;
    while (top.hasNext()) { top.next(); n++; }
    if (n !== 1) report.driveFolderDuplicates.push('"PO Desk" in My Drive x' + n);
  }
  const clean = !report.configDuplicates.length && !report.entityDuplicates.length && !report.paymentMethodDuplicates.length && !report.driveFolderDuplicates.length;
  out_('checkNoDuplicates: ' + (clean ? 'CLEAN' : 'DUPLICATES FOUND'), report);
}

// --- 5a. Tenants, Entities and petty cash ----------------------------------------------------

function listTenants() {
  const ctx = { ref: 'listTenants' };
  const conns = xeroGetConnections(ctx);

  out_('Xero connections visible to Composio', table_(conns.map(c => ({
    tenantName: c.tenantName,
    tenantId: c.tenantId,
    type: c.tenantType,
    poDesk: c.blocked ? 'BLOCKED (Nandrea)' : (c.entity || 'not mapped - ignored'),
  })), ['tenantName', 'tenantId', 'type', 'poDesk']));

  const orgs = {};
  const mapping = [];
  ENTITY_SEED.forEach(e => {
    const conn = conns.find(c => c.entity === e.entity_id);
    if (!conn) {
      mapping.push({ entity: e.entity_id, xeroName: '-', legalName: '-', tenantId: e.xero_tenant_id, currency: '-', status: 'MISSING from connection' });
      return;
    }
    const org = xeroGetOrganisation(e.xero_tenant_id, ctx) || {};
    orgs[e.entity_id] = org;
    if (!findBy('Entities', 'entity_id', e.entity_id).length) appendRow('Entities', Object.assign({}, e, { drive_folder_id: '', active: true }));
    updateRowById('Entities', 'entity_id', e.entity_id, {
      legal_name: org.LegalName || org.Name || e.legal_name,
      xero_tenant_id: e.xero_tenant_id,
      brand_key: e.brand_key,
      active: true,
    });
    mapping.push({
      entity: e.entity_id, xeroName: org.Name || '?', legalName: org.LegalName || '?', tenantId: e.xero_tenant_id,
      currency: org.BaseCurrency || '?', status: org.OrganisationStatus || 'OK',
    });
  });
  out_('Tenant mapping (written to Entities)', table_(mapping, ['entity', 'xeroName', 'legalName', 'tenantId', 'currency', 'status']));

  seedPaymentMethods();
  invalidateTable_('PaymentMethods');

  // Every seeded card and cash float must be an ACTIVE BANK account in its OWN company. Each list
  // is fetched with that company's tenant, so an ID copied from another org fails here instead
  // of surfacing later as a purchase cleared against the wrong books.
  const banksByEntity = {};
  const bankReport = [];
  ENTITY_SEED.forEach(e => {
    if (!orgs[e.entity_id]) return;
    banksByEntity[e.entity_id] = xeroListAccounts(e.xero_tenant_id, 'Type=="BANK"', ctx);
    banksByEntity[e.entity_id]
      .filter(a => String(a.Name).trim().toUpperCase() !== 'UNUSED')
      .forEach(a => bankReport.push({ entity: e.entity_id, name: a.Name, accountId: a.AccountID, status: a.Status, code: a.Code || '(blank)' }));
  });
  out_('Bank accounts in Xero (UNUSED hidden)', table_(bankReport, ['entity', 'name', 'accountId', 'status', 'code']));

  const checks = [];
  const pms = readTable('PaymentMethods').rows;
  pms.forEach(r => {
    const id = String(r.xero_bank_account_id || '').trim().toLowerCase();
    const banks = banksByEntity[r.entity_id];
    const hit = banks ? banks.find(a => String(a.AccountID).toLowerCase() === id) : null;
    let result;
    if (!banks) result = 'FAIL company not connected';
    else if (!id) result = 'FAIL no AccountID in Sheet';
    else if (!hit) {
      const elsewhere = Object.keys(banksByEntity).find(k => k !== r.entity_id && banksByEntity[k].some(a => String(a.AccountID).toLowerCase() === id));
      result = elsewhere ? 'FAIL belongs to ' + elsewhere + ', not ' + r.entity_id : 'FAIL not a BANK account in ' + r.entity_id;
    } else if (hit.Status !== 'ACTIVE') result = 'FAIL account is ' + hit.Status;
    else if (String(hit.Name).trim().toUpperCase() === 'UNUSED') result = 'FAIL points at UNUSED';
    else result = 'OK';

    // The ID is the key; the name is only a label, so keep it in step with whatever Xero calls it.
    if (result === 'OK' && hit.Name !== r.xero_bank_account_name) {
      updateRowById('PaymentMethods', 'pm_id', r.pm_id, { xero_bank_account_name: hit.Name });
    }
    checks.push({
      entity: r.entity_id, type: r.type, label: r.label, last4: r.last4 || '', accountId: r.xero_bank_account_id || '(blank)',
      xeroName: hit ? hit.Name : '-', xeroStatus: hit ? hit.Status : '-', result: result,
    });
  });

  // One cash float per company, and at least one card.
  ENTITY_SEED.forEach(e => {
    const cash = pms.filter(r => r.entity_id === e.entity_id && r.type === 'CASH' && r.active !== false).length;
    const cards = pms.filter(r => r.entity_id === e.entity_id && r.type === 'CARD' && r.active !== false).length;
    if (cash !== 1) checks.push({ entity: e.entity_id, type: 'CASH', label: '-', last4: '', accountId: '-', xeroName: '-', xeroStatus: '-', result: 'FAIL expected 1 active cash float, found ' + cash });
    if (cards < 1) checks.push({ entity: e.entity_id, type: 'CARD', label: '-', last4: '', accountId: '-', xeroName: '-', xeroStatus: '-', result: 'FAIL no active card' });
  });

  out_('Payment method AccountID check', table_(checks, ['entity', 'type', 'label', 'last4', 'accountId', 'xeroName', 'xeroStatus', 'result']));

  const failed = checks.filter(c => c.result !== 'OK');
  if (!failed.length) {
    console.log('All ' + checks.length + ' payment methods map to an ACTIVE BANK account in the right company.');
  } else {
    out_('STOP', failed.length + ' payment method check(s) failed (' + failed.map(f => f.entity + ' ' + f.type).join(', ') + '). ' +
      'Fix the AccountID in the PaymentMethods tab or in Xero, then run listTenants() again. Do not run the spikes until every row is OK.');
  }
}

// --- 5b. Chart of accounts and tax rates -----------------------------------------------------

function inspectCharts() {
  const ctx = { ref: 'inspectCharts' };
  ENTITY_SEED.forEach(e => {
    const accounts = xeroListAccounts(e.xero_tenant_id, null, ctx);
    const counts = {};
    accounts.filter(a => a.Status === 'ACTIVE').forEach(a => { counts[a.Type] = (counts[a.Type] || 0) + 1; });
    const countRows = Object.keys(counts).sort().map(k => ({ type: k, active: counts[k] }));
    countRows.push({ type: 'TOTAL ACTIVE', active: accounts.filter(a => a.Status === 'ACTIVE').length });
    out_(e.entity_id + ' - ACTIVE accounts by type', table_(countRows, ['type', 'active']));

    const rates = xeroListTaxRates(e.xero_tenant_id, null, ctx);
    out_(e.entity_id + ' - tax rates', table_(rates.map(r => ({
      TaxType: r.TaxType, Name: r.Name, Rate: r.DisplayTaxRate !== undefined ? r.DisplayTaxRate : r.EffectiveRate,
      Status: r.Status, Expenses: r.CanApplyToExpenses === true ? 'yes' : (r.CanApplyToExpenses === false ? 'no' : '?'),
    })), ['TaxType', 'Name', 'Rate', 'Status', 'Expenses']));

    const active = rates.filter(r => r.Status === 'ACTIVE' && r.CanApplyToExpenses !== false);
    const rate = r => Number(r.DisplayTaxRate !== undefined ? r.DisplayTaxRate : r.EffectiveRate);
    console.log(e.entity_id + ' candidates - 15% purchase VAT: ' + active.filter(r => rate(r) === 15).map(r => r.TaxType + ' "' + r.Name + '"').join(', ') +
      ' | no-VAT: ' + active.filter(r => rate(r) === 0).map(r => r.TaxType + ' "' + r.Name + '"').join(', '));
  });
}

// --- 5c. PO spike ----------------------------------------------------------------------------

function spikePO(entity) {
  const e = entityById_(entity);
  const t = e.xero_tenant_id;
  const ctx = { ref: 'spike:' + e.entity_id };
  const state = { entity: e.entity_id, startedAt: new Date().toISOString() };

  const contact = ensureSpikeContact_(t, ctx);
  state.contactId = contact.ContactID;
  const acct = spikeAccount_(t, ctx);
  state.accountCode = acct.Code;
  state.accountDefaultTaxType = acct.TaxType || '';
  // Set explicitly: an account's default may still be the deleted 14% INPUT code.
  state.taxType = String(getConfig('PURCHASE_TAX_TYPE', 'INPUT3'));
  saveSpikeState_(e.entity_id, state);

  const today = todayYmd_();
  const line = spikeLine_(state);
  const base = { ContactID: contact.ContactID, Date: today, DeliveryDate: today, Reference: 'PO Desk spike', Status: 'DRAFT', LineItems: [line] };

  // The create tool's schema has no LineAmountTypes or AttentionTo. Try them anyway: if Composio
  // passes them through, Flow 1 needs one call instead of two.
  let po;
  let firstAttemptError = null;
  let t0 = Date.now();
  try {
    po = xeroCreatePurchaseOrder(t, Object.assign({}, base, { LineAmountTypes: 'Inclusive', AttentionTo: SPIKE_ATTENTION }), ctx);
  } catch (err) {
    firstAttemptError = err.message;
    t0 = Date.now();
    po = xeroCreatePurchaseOrder(t, base, ctx);
  }
  const createMs = Date.now() - t0;
  if (!po || !po.PurchaseOrderID) throw new AppError('SPIKE', 'Create returned no PurchaseOrderID: ' + JSON.stringify(po));
  state.poId = po.PurchaseOrderID;
  state.poNumber = po.PurchaseOrderNumber || '';
  saveSpikeState_(e.entity_id, state);

  const createdInclusive = po.LineAmountTypes === 'Inclusive';
  const createdAttention = po.AttentionTo === SPIKE_ATTENTION;
  let updateMs = null;
  if (!createdInclusive || !createdAttention) {
    const li = (po.LineItems || [])[0] || {};
    t0 = Date.now();
    // Resend the line with its LineItemID, otherwise Xero treats it as a second line.
    xeroUpdatePurchaseOrder(t, po.PurchaseOrderID, {
      LineAmountTypes: 'Inclusive',
      AttentionTo: SPIKE_ATTENTION,
      LineItems: [Object.assign({ LineItemID: li.LineItemID }, line)],
    }, ctx);
    updateMs = Date.now() - t0;
  }

  const check = xeroGetPurchaseOrder(t, po.PurchaseOrderID, ctx) || {};
  state.poNumber = check.PurchaseOrderNumber || state.poNumber;
  saveSpikeState_(e.entity_id, state);

  out_('spikePO ' + e.entity_id, {
    PurchaseOrderNumber: state.poNumber,
    numberInCreateResponse: !!po.PurchaseOrderNumber,
    createMs: createMs,
    updateMs: updateMs,
    poNumberOnScreenTargetMet: createMs <= 3500,
    createAcceptedLineAmountTypes: createdInclusive,
    createAcceptedAttentionTo: createdAttention,
    firstAttemptError: firstAttemptError,
    accountUsed: state.accountCode + ' / ' + state.taxType + ' (account default: ' + (state.accountDefaultTaxType || 'none') + ')',
    lineTaxTypeInXero: ((check.LineItems || [])[0] || {}).TaxType,
    final: {
      Status: check.Status, LineAmountTypes: check.LineAmountTypes, AttentionTo: check.AttentionTo,
      SubTotal: check.SubTotal, TotalTax: check.TotalTax, Total: check.Total, lines: (check.LineItems || []).length,
    },
    inclusiveVerified: check.LineAmountTypes === 'Inclusive' && Number(check.Total) === 1 && (check.LineItems || []).length === 1,
    PurchaseOrderID: state.poId,
  });
}

// --- 5d. Attachment spike --------------------------------------------------------------------

function spikeAttachment(entity) {
  const e = entityById_(entity);
  const t = e.xero_tenant_id;
  const ctx = { ref: 'spike:' + e.entity_id };
  const state = requireSpikeState_(e.entity_id, ['poId']);
  const blob = spikeJpg_();
  const size = blob.getBytes().length;

  const results = {};
  ['proxy', 'tool'].forEach(route => {
    const t0 = Date.now();
    try {
      const a = xeroUploadAttachment(t, 'PurchaseOrders', state.poId, blob.copyBlob().setName('po-desk-spike-' + route + '.jpg'), { route: route }, ctx) || {};
      results[route] = { ok: true, ms: Date.now() - t0, AttachmentID: a.AttachmentID, FileName: a.FileName, ContentLength: a.ContentLength, sizeMatches: Number(a.ContentLength) === size };
    } catch (err) {
      results[route] = { ok: false, ms: Date.now() - t0, error: err.message };
    }
  });

  let onPo;
  try {
    onPo = xeroListAttachments(t, 'PurchaseOrders', state.poId, ctx).map(a => a.FileName + ' (' + a.ContentLength + ' bytes, ' + a.MimeType + ')');
  } catch (err) {
    onPo = 'could not list: ' + err.message;
  }

  const winner = results.proxy.ok ? 'proxy' : (results.tool.ok ? 'tool' : null);
  if (winner) setConfig('ATTACHMENT_ROUTE', winner);
  state.attachmentRoute = winner;
  saveSpikeState_(e.entity_id, state);

  out_('spikeAttachment ' + e.entity_id, {
    po: state.poNumber, jpgBytes: size,
    routeProxy: results.proxy, routeTool: results.tool,
    attachmentsNowOnPO: onPo,
    chosenRoute: winner || 'NONE WORKED - see errors above',
  });
}

// --- 5e. Bill spike --------------------------------------------------------------------------

function spikeBill(entity) {
  const e = entityById_(entity);
  const t = e.xero_tenant_id;
  const ctx = { ref: 'spike:' + e.entity_id };
  const state = requireSpikeState_(e.entity_id, ['poId', 'poNumber', 'contactId', 'accountCode']);
  const today = todayYmd_();
  const line = spikeLine_(state);
  const base = { ContactID: state.contactId, Date: today, DueDate: today, Reference: state.poNumber, Status: 'DRAFT', LineItems: [line] };

  let bill;
  let firstAttemptError = null;
  let t0 = Date.now();
  try {
    bill = xeroCreateBill(t, Object.assign({}, base, { LineAmountTypes: 'Inclusive' }), ctx);
  } catch (err) {
    firstAttemptError = err.message;
    t0 = Date.now();
    bill = xeroCreateBill(t, base, ctx);
  }
  const createMs = Date.now() - t0;
  if (!bill || !bill.InvoiceID) throw new AppError('SPIKE', 'Create returned no InvoiceID: ' + JSON.stringify(bill));
  state.billId = bill.InvoiceID;
  saveSpikeState_(e.entity_id, state);

  const createdInclusive = bill.LineAmountTypes === 'Inclusive';
  let updateMs = null;
  if (!createdInclusive) {
    const li = (bill.LineItems || [])[0] || {};
    t0 = Date.now();
    xeroUpdateInvoice(t, bill.InvoiceID, { LineAmountTypes: 'Inclusive', LineItems: [Object.assign({ LineItemID: li.LineItemID }, line)] }, ctx);
    updateMs = Date.now() - t0;
  }

  let attach;
  const route = state.attachmentRoute || String(getConfig('ATTACHMENT_ROUTE', 'proxy'));
  t0 = Date.now();
  try {
    const a = xeroUploadAttachment(t, 'Invoices', bill.InvoiceID, spikeJpg_().setName('po-desk-spike-bill.jpg'), { route: route }, ctx) || {};
    attach = { ok: true, route: route, ms: Date.now() - t0, AttachmentID: a.AttachmentID, ContentLength: a.ContentLength };
  } catch (err) {
    attach = { ok: false, route: route, ms: Date.now() - t0, error: err.message };
  }

  // Xero's API can't link a bill to a PO, so test whether History notes can carry the cross-reference.
  const notes = {};
  try { xeroAddHistoryNote(t, 'Invoices', bill.InvoiceID, 'PO Desk: bill for purchase order ' + state.poNumber, ctx); notes.onBill = 'ok'; } catch (err) { notes.onBill = 'failed: ' + err.message; }
  try { xeroAddHistoryNote(t, 'PurchaseOrders', state.poId, 'PO Desk: draft bill created (InvoiceID ' + bill.InvoiceID + ')', ctx); notes.onPO = 'ok'; } catch (err) { notes.onPO = 'failed: ' + err.message; }

  const check = xeroGetInvoice(t, bill.InvoiceID, ctx) || {};
  out_('spikeBill ' + e.entity_id, {
    InvoiceID: bill.InvoiceID,
    createMs: createMs, updateMs: updateMs,
    createAcceptedLineAmountTypes: createdInclusive,
    firstAttemptError: firstAttemptError,
    final: {
      Type: check.Type, Status: check.Status, Reference: check.Reference, LineAmountTypes: check.LineAmountTypes,
      SubTotal: check.SubTotal, TotalTax: check.TotalTax, Total: check.Total, HasAttachments: check.HasAttachments, lines: (check.LineItems || []).length,
    },
    inclusiveVerified: check.LineAmountTypes === 'Inclusive' && Number(check.Total) === 1 && (check.LineItems || []).length === 1,
    referenceIsPoNumber: check.Reference === state.poNumber,
    attachment: attach,
    historyNotes: notes,
  });
}

// --- 5f. Cleanup -----------------------------------------------------------------------------

/** Deletes every test PO and bill for the test contact (not only the ones in state), then archives the contact. */
function cleanup(entity) {
  const e = entityById_(entity);
  const t = e.xero_tenant_id;
  const ctx = { ref: 'cleanup:' + e.entity_id };
  const state = spikeState_(e.entity_id);
  const done = { bills: [], pos: [], contact: null, errors: [] };

  let contactId = state.contactId;
  if (!contactId) {
    const c = xeroFindContactsByName(t, SPIKE_CONTACT_NAME, ctx)[0];
    contactId = c && c.ContactID;
  }
  if (!contactId) { out_('cleanup ' + e.entity_id, 'No test contact found - nothing to clean.'); return; }

  // Bills first, so a failure halfway never leaves a live bill whose PO is already deleted.
  const billIds = {};
  if (state.billId) billIds[state.billId] = true;
  xeroListInvoices(t, { ContactIDs: contactId, Statuses: 'DRAFT,SUBMITTED', where: 'Type=="ACCPAY"' }, ctx).forEach(b => { billIds[b.InvoiceID] = true; });
  Object.keys(billIds).forEach(id => {
    try {
      const cur = xeroGetInvoice(t, id, ctx) || {};
      if (cur.Status !== 'DELETED') xeroUpdateInvoice(t, id, { Status: 'DELETED' }, ctx);
      done.bills.push(id + ' -> ' + ((xeroGetInvoice(t, id, ctx) || {}).Status));
    } catch (err) { done.errors.push('bill ' + id + ': ' + err.message); }
  });

  const poIds = {};
  if (state.poId) poIds[state.poId] = true;
  ['DRAFT', 'SUBMITTED', 'AUTHORISED'].forEach(st => {
    xeroListPurchaseOrders(t, { Status: st }, ctx)
      .filter(p => p.Contact && p.Contact.ContactID === contactId)
      .forEach(p => { poIds[p.PurchaseOrderID] = true; });
  });
  Object.keys(poIds).forEach(id => {
    try {
      const cur = xeroGetPurchaseOrder(t, id, ctx) || {};
      if (cur.Status !== 'DELETED') xeroUpdatePurchaseOrder(t, id, { Status: 'DELETED' }, ctx);
      const after = xeroGetPurchaseOrder(t, id, ctx) || {};
      done.pos.push((after.PurchaseOrderNumber || id) + ' -> ' + after.Status);
    } catch (err) { done.errors.push('PO ' + id + ': ' + err.message); }
  });

  try {
    const before = xeroGetContactById(t, contactId, ctx) || {};
    if (before.ContactStatus !== 'ARCHIVED') xeroSetContactStatus(t, contactId, 'ARCHIVED', ctx);
    const c = xeroGetContactById(t, contactId, ctx) || {};
    done.contact = SPIKE_CONTACT_NAME + ' -> ' + c.ContactStatus;
  } catch (err) { done.errors.push('contact: ' + err.message); }

  state.cleanedAt = new Date().toISOString();
  saveSpikeState_(e.entity_id, state);
  out_('cleanup ' + e.entity_id + (done.errors.length ? ' (WITH ERRORS)' : ''), done);
}

// --- Spike helpers ---------------------------------------------------------------------------

function ensureSpikeContact_(tenantId, ctx) {
  const c = xeroFindContactsByName(tenantId, SPIKE_CONTACT_NAME, ctx)[0];
  if (c) {
    // A previous cleanup archives it; Xero won't raise a PO to an archived contact.
    if (c.ContactStatus === 'ARCHIVED') xeroSetContactStatus(tenantId, c.ContactID, 'ACTIVE', ctx);
    return c;
  }
  const created = xeroCreateContact(tenantId, { Name: SPIKE_CONTACT_NAME, IsSupplier: true }, ctx);
  if (!created || !created.ContactID) throw new AppError('SPIKE', 'Could not create the test contact.');
  return created;
}

function spikeAccount_(tenantId, ctx) {
  const acct = xeroListAccounts(tenantId, 'Status=="ACTIVE" AND Type=="EXPENSE"', ctx).find(a => a.Code);
  if (!acct) throw new AppError('SPIKE', 'No ACTIVE EXPENSE account with a code found.');
  return acct;
}

function spikeLine_(state) {
  const line = { Description: SPIKE_LINE_TEXT, Quantity: 1, UnitAmount: 1.00, AccountCode: state.accountCode };
  if (state.taxType) line.TaxType = state.taxType;
  return line;
}

function spikeJpg_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPIKE_JPG_ID');
  if (id) {
    try { return DriveApp.getFileById(id).getBlob(); } catch (err) { /* deleted by hand: recreate */ }
  }
  const root = DriveApp.getFolderById(getSecret_('DRIVE_ROOT_ID'));
  const it = root.getFoldersByName('_spike');
  const folder = it.hasNext() ? it.next() : root.createFolder('_spike');
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(SPIKE_JPG_B64), 'image/jpeg', 'po-desk-spike.jpg'));
  props.setProperty('SPIKE_JPG_ID', file.getId());
  return file.getBlob();
}

function spikeState_(entity) {
  const raw = getOptionalSecret_('SPIKE_' + entity);
  return raw ? JSON.parse(raw) : {};
}

function saveSpikeState_(entity, state) {
  PropertiesService.getScriptProperties().setProperty('SPIKE_' + entity, JSON.stringify(state));
}

function requireSpikeState_(entity, keys) {
  const s = spikeState_(entity);
  const missing = keys.filter(k => !s[k]);
  if (missing.length) throw new AppError('SPIKE_ORDER', 'Run spikePO_' + entity + ' first (missing ' + missing.join(', ') + ').');
  return s;
}

// --- Log formatting --------------------------------------------------------------------------

function out_(title, body) {
  console.log('=== ' + title + ' ===\n' + (typeof body === 'string' ? body : JSON.stringify(body, null, 2)));
}

function pad_(s, n) {
  s = String(s === undefined || s === null ? '' : s);
  return s.length >= n ? s : s + new Array(n - s.length + 1).join(' ');
}

function table_(rows, cols) {
  if (!rows.length) return '(none)';
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] === undefined ? '' : r[c]).length)));
  const line = vals => vals.map((v, i) => pad_(v, w[i])).join(' | ');
  return [line(cols), w.map(n => new Array(n + 1).join('-')).join('-+-')].concat(rows.map(r => line(cols.map(c => r[c])))).join('\n');
}

// --- Stage 2: coding engine unit tests (fixtures only, no Sheet or Composio) -----------------

function codingFixture_() {
  const A = (ent, code, name, type, cls, tax, status) => ({ entity_id: ent, account_id: ent + '-' + code, code: code, name: name, type: type, class: cls || 'EXPENSE', tax_type: tax || 'INPUT3', status: status || 'ACTIVE' });
  const C = (id, ent, name, code, keywords, sort, active) => ({ category_id: id, entity_id: ent, name: name, account_code: code, tax_type: '', keywords: keywords, sort: sort, active: active === undefined ? true : active });
  const H = (ent, contact, code, uses) => ({ entity_id: ent, contact_id: contact, account_code: code, uses: uses, last_used: new Date('2026-10-01') });
  return {
    accounts: [
      A('NHP', '433', 'Vehicle - Petrol and oil', 'EXPENSE'),
      A('NHP', '404', 'Cleaning', 'EXPENSE'),
      A('NHP', '311', 'Packaging', 'DIRECTCOSTS'),
      A('NHP', '312', 'Quality Control', 'DIRECTCOSTS'),
      A('NHP', '421', 'Protective clothing', 'EXPENSE'),
      A('NHP', '465', 'Unallocated Expenses', 'EXPENSE', 'EXPENSE', 'NONE'),
      A('NHP', '409', 'Depreciation', 'DEPRECIATN', 'EXPENSE', 'NONE'),
      A('NHP', '420', 'Printing and stationery', 'EXPENSE', 'EXPENSE', 'INPUT3', 'ARCHIVED'),
      A('NHP', '318', 'Plant Raw Materials', 'DIRECTCOSTS', 'EXPENSE', 'INPUT'),
      A('NHP', '710', 'Office Equipment', 'FIXED', 'ASSET'),
      A('PK', '600', 'PK-only expense', 'EXPENSE'),
    ],
    taxRates: [
      { entity_id: 'NHP', tax_type: 'INPUT3', rate: 15, status: 'ACTIVE' },
      { entity_id: 'NHP', tax_type: 'NONE', rate: 0, status: 'ACTIVE' },
      { entity_id: 'NHP', tax_type: 'INPUT', rate: 14, status: 'ACTIVE' },
    ],
    categories: [
      C('cat-fuel', 'NHP', 'Fuel', '433', 'fuel, petrol, shell', 10),
      C('cat-clean', 'NHP', 'Cleaning', '404', 'cleaning, bleach, jik, mop', 20),
      C('cat-pack', 'NHP', 'Packaging', '311', 'boxes, bottles', 30),
      C('cat-lab', 'NHP', 'Lab consumables', '312', 'lab, reagent', 40),
      C('cat-ppe', 'NHP', 'PPE', '421', 'gloves, lab coat', 50),
      C('cat-stat', 'NHP', 'Stationery', '420', 'paper, pens', 60),
      C('cat-wrong', 'NHP', 'Uses a PK code', '600', 'widget', 70),
      C('cat-raw', 'NHP', 'Raw (old VAT default)', '318', 'raw materials', 80),
      C('cat-off', 'NHP', 'Switched off', '433', 'unicorn', 90, 'FALSE'),
      C('cat-pk', 'PK', 'PK fuel', '600', 'pkfuel', 10),
    ],
    history: [
      H('NHP', 'sup-fuel', '433', 4),
      H('NHP', 'sup-mixed', '433', 2), H('NHP', 'sup-mixed', '404', 3),
      H('NHP', 'sup-archived', '420', 5),
      H('NHP', 'sup-wrongco', '600', 5),
      H('PK', 'sup-pkonly', '600', 5),
    ],
    config: { historyN: 5, defaultAccount: '465', extraAccounts: '', purchaseTaxType: 'INPUT3' },
  };
}

function testCoding() {
  const F = codingFixture_;
  const withConfig = patch => { const d = F(); Object.assign(d.config, patch); return d; };
  const run = (data, contact, cat, desc) => suggestAccountWith_(data, 'NHP', contact, cat, desc);
  const cases = [
    // 1. supplier history
    ['history: unanimous supplier', () => run(F(), 'sup-fuel', null, 'whatever'), { source: 'history', accountCode: '433', reasonHas: 'Last 4 purchases' }],
    ['history: mixed codes fall through to keywords', () => run(F(), 'sup-mixed', null, 'Jik and a mop'), { source: 'keyword', accountCode: '404' }],
    // 2. keywords
    ['keyword: match', () => run(F(), null, null, 'Unleaded PETROL 40L'), { source: 'keyword', accountCode: '433' }],
    ['keyword: whole words only ("shellfish" is not "shell")', () => run(F(), null, null, 'Shellfish platter'), { source: 'fallback', accountCode: '465' }],
    ['keyword: longer phrase wins ("lab coat" beats "lab")', () => run(F(), null, null, 'Lab coat, size M'), { source: 'keyword', accountCode: '421' }],
    ['keyword: beats the chosen category (spec order)', () => run(F(), null, 'cat-pack', 'bleach'), { source: 'keyword', accountCode: '404' }],
    // 3. category default
    ['category: default when no history or keyword', () => run(F(), null, 'cat-pack', 'assorted'), { source: 'category', accountCode: '311' }],
    ['category: switched-off category ignored', () => run(F(), null, 'cat-off', 'unicorn'), { source: 'fallback', accountCode: '465' }],
    // 4. fallback
    ['fallback: flagged needs review, account tax type', () => run(F(), null, null, 'something odd'), { source: 'fallback', accountCode: '465', needsReview: true, taxType: 'NONE' }],
    ['fallback: depreciation (DEPRECIATN) is not a purchase account', () => run(withConfig({ defaultAccount: '409' }), null, null, 'x'), { source: 'none', accountCode: null, needsReview: true }],
    ['fallback: EXTRA_PURCHASE_ACCOUNTS allows a FIXED asset code', () => run(withConfig({ defaultAccount: '710', extraAccounts: '710, 999' }), null, null, 'x'), { source: 'fallback', accountCode: '710' }],
    // archived codes
    ['archived: history code skipped, keyword used', () => run(F(), 'sup-archived', null, 'petrol'), { source: 'keyword', accountCode: '433' }],
    ['archived: keyword category code skipped', () => run(F(), null, null, 'A4 paper'), { source: 'fallback', accountCode: '465' }],
    ['archived: category default skipped', () => run(F(), null, 'cat-stat', 'x'), { source: 'fallback', accountCode: '465' }],
    // wrong company
    ['wrong company: history code that only exists in PK', () => run(F(), 'sup-wrongco', null, 'x'), { source: 'fallback', accountCode: '465' }],
    ['wrong company: PK supplier history not used for NHP', () => run(F(), 'sup-pkonly', null, 'x'), { source: 'fallback', accountCode: '465' }],
    ['wrong company: NHP category mapped to a PK code', () => run(F(), null, 'cat-wrong', 'widget'), { source: 'fallback', accountCode: '465' }],
    ['wrong company: PK category ID passed for NHP', () => run(F(), null, 'cat-pk', 'pkfuel'), { source: 'fallback', accountCode: '465' }],
    ['wrong company: default account that only exists in PK', () => run(withConfig({ defaultAccount: '600' }), null, null, 'x'), { source: 'none', accountCode: null }],
    // tax type
    ['tax: legacy 14% INPUT default replaced by INPUT3', () => run(F(), null, 'cat-raw', 'x'), { source: 'category', accountCode: '318', taxType: 'INPUT3' }],
  ];

  const lines = [];
  let failures = 0;
  cases.forEach(c => {
    let got, problem = '';
    try { got = c[1](); } catch (err) { problem = 'threw ' + err.message; }
    if (!problem) {
      const exp = c[2];
      Object.keys(exp).forEach(k => {
        if (k === 'reasonHas') { if (String(got.reason).indexOf(exp[k]) === -1) problem += ' reason="' + got.reason + '"'; }
        else if (got[k] !== exp[k]) problem += ' ' + k + '=' + JSON.stringify(got[k]) + ' (want ' + JSON.stringify(exp[k]) + ')';
      });
    }
    if (problem) failures++;
    lines.push((problem ? 'FAIL ' : 'PASS ') + c[0] + (problem ? ' ->' + problem : '  [' + got.source + ' ' + got.accountCode + ' ' + got.taxType + ']'));
  });

  // Supplier-history window and recordChoice trimming.
  const d = s => new Date(s);
  const check = (label, cond, detail) => { if (!cond) failures++; lines.push((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : ' -> ' + detail)); };
  const evs = [{ contactId: 'S', date: d('2026-01-01'), codes: ['404'] }]
    .concat([2, 3, 4, 5, 6].map(m => ({ contactId: 'S', date: d('2026-0' + m + '-01'), codes: ['433'] })));
  const h1 = buildSupplierHistory_(evs, 5);
  check('history window: oldest purchase drops out of last 5', h1.length === 1 && h1[0].account_code === '433' && h1[0].uses === 5, JSON.stringify(h1));
  const h2 = buildSupplierHistory_([{ contactId: 'S', date: d('2026-06-01'), codes: ['433', '404'] }], 5);
  check('history window: multi-code bill keeps both codes (not unanimous)', h2.length === 2, JSON.stringify(h2));
  const a1 = applyChoice_([{ account_code: '433', uses: 4, last_used: d('2026-06-01') }, { account_code: '404', uses: 1, last_used: d('2026-01-01') }], '433', d('2026-11-03'), 5);
  check('recordChoice: window trimmed, oldest code removed', a1.length === 1 && a1[0].uses === 5, JSON.stringify(a1));
  const a2 = applyChoice_([{ account_code: '433', uses: 5, last_used: d('2026-06-01') }], '404', d('2026-11-03'), 5);
  check('recordChoice: new code added, total stays at N', a2.length === 2 && a2.find(r => r.account_code === '433').uses === 4 && a2.find(r => r.account_code === '404').uses === 1, JSON.stringify(a2));

  // Cache chunking.
  const big = new Array(9000).join('Pharma Karu é ✓ ');   // multibyte, ~150k chars
  const chunks = chunkString_(big);
  const maxBytes = Math.max.apply(null, chunks.map(c => Utilities.newBlob(c).getBytes().length));
  check('cache: large value split into chunks under 100 KB that rejoin exactly', chunks.length > 1 && maxBytes < 100 * 1024 && chunks.join('') === big, chunks.length + ' chunks, max ' + maxBytes + ' bytes');
  check('cache: small value stays in one chunk', chunkString_('{"a":1}').length === 1, '');

  out_('testCoding: ' + (failures ? failures + ' FAILURE(S)' : 'all ' + lines.length + ' passed'), lines.join('\n'));
}

/** After syncAll: proves the live path (cache → engine) works for each company. */
function testCodingLive() {
  ENTITY_SEED.forEach(e => {
    const t0 = Date.now();
    const ref = getRefData(e.entity_id);
    const r = suggestAccount(e.entity_id, null, null, 'Unleaded petrol');
    console.log(e.entity_id + ': cache ' + (ref.fromCache ? 'HIT' : 'MISS (rebuilt from Sheet)') + ' v' + ref.version + ', ' + ref.accounts.length + ' accounts, ' + ref.suppliers.length + ' suppliers; ' +
      '"Unleaded petrol" -> ' + r.source + ' ' + r.accountCode + ' ' + r.taxType + ' (' + (Date.now() - t0) + ' ms): ' + r.reason);
  });
}

/** Stage 2 guards: the tenant-unsafe tool is refused, and cross-company IDs block a sync write. */
function testSyncGuards() {
  const lines = [];
  let failures = 0;
  const check = (label, cond, detail) => { if (!cond) failures++; lines.push((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : ' -> ' + detail)); };

  let code = '';
  try { xeroTool_('XERO_GET_CONTACTS', ENTITY_SEED[0].xero_tenant_id, {}); } catch (err) { code = err.code; }
  check('XERO_GET_CONTACTS refused before any network call', code === 'TOOL_UNSAFE', code);

  const shared = { supplierRows: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }], accountRows: [{ account_id: 'a-1' }] };
  const leak = isolationProblems_({ HPB: shared, NHP: { supplierRows: [{ contact_id: 'c-1' }], accountRows: [{ account_id: 'a-9' }] }, PK: { supplierRows: [{ contact_id: 'c-7' }], accountRows: [] } });
  check('same ContactID under HPB and NHP flags both', !!leak.HPB && !!leak.NHP && !leak.PK, JSON.stringify(leak));
  const leakAcct = isolationProblems_({ HPB: { accountRows: [{ account_id: 'a-1' }] }, PK: { accountRows: [{ account_id: 'a-1' }] } });
  check('same AccountID under HPB and PK flags both', !!leakAcct.HPB && !!leakAcct.PK, JSON.stringify(leakAcct));
  const clean = isolationProblems_({ HPB: shared, NHP: { supplierRows: [{ contact_id: 'c-3' }], accountRows: [{ account_id: 'a-2' }] } });
  check('distinct IDs pass', Object.keys(clean).length === 0, JSON.stringify(clean));

  out_('testSyncGuards: ' + (failures ? failures + ' FAILURE(S)' : 'all ' + lines.length + ' passed'), lines.join('\n'));
}
