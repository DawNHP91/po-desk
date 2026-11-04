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
    // A previous cleanup archived it, and Xero's API can't un-archive contacts.
    if (c.ContactStatus === 'ARCHIVED') throw new AppError('SPIKE', SPIKE_CONTACT_NAME + ' is archived from an earlier run. Restore it in Xero (Contacts, Archived) to rerun this spike.');
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

// --- Stage 3: auth and access control (run after createTestBuyerNHP) -------------------------

/** Sends a request through doPost exactly as the web app receives it. */
function callApi_(action, token, payload) {
  const out = doPost({ postData: { contents: JSON.stringify({ action: action, token: token || '', payload: payload === undefined ? {} : payload }) } });
  return JSON.parse(out.getContent());
}

/** Acceptance: a buyer limited to NHP cannot get HPB (or PK) data however the request is edited. */
function testAccessControl() {
  const buyer = findUserByEmail_(TEST_BUYER.email);
  if (!buyer) throw new AppError('SETUP_ORDER', 'Run createTestBuyerNHP() first.');
  const lines = [];
  let failures = 0;
  const check = (label, cond, detail) => { if (!cond) failures++; lines.push((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : ' -> ' + detail)); };
  const wasActive = isTrue_(buyer.active);
  if (!wasActive) updateRowById('Users', 'user_id', buyer.user_id, { active: true });
  const token = createSession_(buyer.user_id);
  const nhpSuppliers = readTable('Suppliers').rows.filter(r => r.entity_id === 'NHP').length;
  const nhpCards = readTable('PaymentMethods').rows.filter(r => r.entity_id === 'NHP' && isTrue_(r.active)).length;
  try {
    const me = callApi_('me', token);
    check('me lists NHP only', me.ok && me.data.companies.length === 1 && me.data.companies[0].entityId === 'NHP' && me.data.companies[0].canBuy === true, JSON.stringify(me).slice(0, 300));

    const nhp = callApi_('refData', token, { entityId: 'NHP' });
    check('refData NHP allowed, returns NHP suppliers (' + nhpSuppliers + ') and payment methods (' + nhpCards + ')',
      nhp.ok && nhp.data.entityId === 'NHP' && nhp.data.suppliers.length === nhpSuppliers && nhp.data.paymentMethods.length === nhpCards, JSON.stringify(nhp).slice(0, 300));
    check('refData exposes only pmId/type/label/last4 for payment methods',
      nhp.ok && nhp.data.paymentMethods.every(p => Object.keys(p).sort().join() === 'label,last4,pmId,type'), nhp.ok ? JSON.stringify(nhp.data.paymentMethods) : '');
    check('refData accounts are purchase accounts only', nhp.ok && nhp.data.accounts.length > 0 && nhp.data.accounts.every(a => ['EXPENSE', 'DIRECTCOSTS', 'OVERHEADS'].indexOf(a.type) !== -1), nhp.ok ? nhp.data.accounts.length + ' accounts' : '');

    const forbidden = [
      ['HPB', { entityId: 'HPB' }],
      ['PK', { entityId: 'PK' }],
      ['lower-case "hpb"', { entityId: 'hpb' }],
      ['padded " HPB "', { entityId: ' HPB ' }],
      ['HPB tenant ID instead of entity', { entityId: entityById_('HPB').xero_tenant_id }],
      ['"NHP,HPB"', { entityId: 'NHP,HPB' }],
      ['Nandrea tenant ID', { entityId: BLOCKED_TENANTS[0] }],
    ];
    forbidden.forEach(f => {
      const r = callApi_('refData', token, f[1]);
      check('refData ' + f[0] + ' -> FORBIDDEN', !r.ok && r.error.code === 'FORBIDDEN', JSON.stringify(r).slice(0, 200));
    });
    [['array ["NHP","HPB"]', { entityId: ['NHP', 'HPB'] }], ['object', { entityId: { id: 'HPB' } }], ['missing', {}], ['payload not an object', 'HPB']].forEach(f => {
      const r = callApi_('refData', token, f[1]);
      check('refData ' + f[0] + ' -> BAD_REQUEST', !r.ok && r.error.code === 'BAD_REQUEST', JSON.stringify(r).slice(0, 200));
    });
    const extra = callApi_('refData', token, { entityId: 'NHP', tenantId: entityById_('HPB').xero_tenant_id, entity_id: 'HPB', tenant_id: entityById_('HPB').xero_tenant_id });
    check('extra HPB fields alongside entityId NHP are ignored (still NHP data)', extra.ok && extra.data.entityId === 'NHP' && extra.data.suppliers.length === nhpSuppliers, JSON.stringify(extra).slice(0, 200));

    [['no token', ''], ['forged UUID token', Utilities.getUuid()], ['non-UUID token', 'admin'], ['token with HPB tenant ID', entityById_('HPB').xero_tenant_id]].forEach(t => {
      const r = callApi_('refData', t[1], { entityId: 'NHP' });
      check(t[0] + ' -> AUTH_REQUIRED', !r.ok && r.error.code === 'AUTH_REQUIRED', JSON.stringify(r).slice(0, 200));
    });

    updateRowById('Users', 'user_id', buyer.user_id, { active: false });
    const off = callApi_('refData', token, { entityId: 'NHP' });
    check('deactivated user is refused on the next request', !off.ok && off.error.code === 'AUTH_REQUIRED', JSON.stringify(off).slice(0, 200));
    updateRowById('Users', 'user_id', buyer.user_id, { active: true });
    const after = callApi_('me', token);
    check('…and that session stays ended after reactivation', !after.ok && after.error.code === 'AUTH_REQUIRED', JSON.stringify(after).slice(0, 200));
  } finally {
    updateRowById('Users', 'user_id', buyer.user_id, { active: wasActive || true });
    CacheService.getScriptCache().remove(sessionKey_(token));
  }
  out_('testAccessControl: ' + (failures ? failures + ' FAILURE(S)' : 'all ' + lines.length + ' passed'), lines.join('\n'));
}

/**
 * Acceptance: 5 wrong PINs lock the account for 15 minutes, even against the right PIN.
 * Uses a random PIN on the test buyer (never logged) and restores the buyer's own PIN afterwards.
 */
function testLockout() {
  const buyer = findUserByEmail_(TEST_BUYER.email);
  if (!buyer) throw new AppError('SETUP_ORDER', 'Run createTestBuyerNHP() first.');
  const lines = [];
  let failures = 0;
  const check = (label, cond, detail) => { if (!cond) failures++; lines.push((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : ' -> ' + detail)); };
  const saved = { pin_hash: buyer.pin_hash, pin_salt: buyer.pin_salt, failed_attempts: buyer.failed_attempts, locked_until: buyer.locked_until, active: buyer.active };
  const pin = randomStrongPin_();
  let wrong = randomStrongPin_();
  while (wrong === pin) wrong = randomStrongPin_();
  const unknown = 'nobody.' + Utilities.getUuid().slice(0, 8) + '@po-desk.test';
  const flood = 'flood.' + Utilities.getUuid().slice(0, 8) + '@po-desk.test';
  resetLoginLimits_(TEST_BUYER.email);
  try {
    const salt = newSalt_();
    updateRowById('Users', 'user_id', buyer.user_id, { pin_hash: hashPin_(salt, pin), pin_salt: salt, failed_attempts: 0, locked_until: '', active: true });
    const login = (email, p) => callApi_('login', '', { email: email, pin: p });

    for (let i = 1; i <= 4; i++) {
      const r = login(TEST_BUYER.email, wrong);
      check('wrong PIN ' + i + ' -> LOGIN_FAILED', !r.ok && r.error.code === 'LOGIN_FAILED', JSON.stringify(r));
    }
    const fifth = login(TEST_BUYER.email, wrong);
    check('wrong PIN 5 -> LOCKED ("' + (fifth.error && fifth.error.message) + '")', !fifth.ok && fifth.error.code === 'LOCKED', JSON.stringify(fifth));
    const right = login(TEST_BUYER.email, pin);
    check('correct PIN while locked -> still LOCKED', !right.ok && right.error.code === 'LOCKED', JSON.stringify(right));
    check('locked_until about 15 minutes ahead', (() => { const u = new Date(findUserByEmail_(TEST_BUYER.email).locked_until); const m = (u - new Date()) / 60000; return m > 14 && m <= 15.1; })(), String(findUserByEmail_(TEST_BUYER.email).locked_until));

    updateRowById('Users', 'user_id', buyer.user_id, { locked_until: new Date(Date.now() - 1000) });
    const ok = login(TEST_BUYER.email, pin);
    check('after the lock expires the correct PIN works', ok.ok && isUuid_(ok.data.token) && ok.data.me.companies.length === 1, JSON.stringify(ok).slice(0, 200));
    check('a successful login resets the failure count', Number(findUserByEmail_(TEST_BUYER.email).failed_attempts) === 0, String(findUserByEmail_(TEST_BUYER.email).failed_attempts));
    if (ok.ok) {
      const out = callApi_('logout', ok.data.token);
      const gone = callApi_('me', ok.data.token);
      check('logout ends the session', out.ok && !gone.ok && gone.error.code === 'AUTH_REQUIRED', JSON.stringify(gone));
    }

    const u4 = [1, 2, 3, 4].map(() => login(unknown, wrong));
    const u5 = login(unknown, wrong);
    check('unknown email answers like a real one (4 x LOGIN_FAILED, then LOCKED)', u4.every(r => !r.ok && r.error.code === 'LOGIN_FAILED') && !u5.ok && u5.error.code === 'LOCKED', JSON.stringify(u5));

    const bad = [login(TEST_BUYER.email, '12345'), login(TEST_BUYER.email, 'abcdef'), login('', pin)];
    check('malformed PIN or missing email rejected', bad.every(r => !r.ok && r.error.code === 'LOGIN_FAILED'), JSON.stringify(bad));

    let last;
    for (let i = 0; i <= AUTH.LOGIN_RATE_MAX; i++) last = login(flood, wrong);
    check('attempt ' + (AUTH.LOGIN_RATE_MAX + 1) + ' in 15 minutes -> RATE_LIMITED', !last.ok && last.error.code === 'RATE_LIMITED', JSON.stringify(last));
  } finally {
    updateRowById('Users', 'user_id', buyer.user_id, saved);
    [TEST_BUYER.email, unknown, flood].forEach(resetLoginLimits_);
  }
  out_('testLockout: ' + (failures ? failures + ' FAILURE(S)' : 'all ' + lines.length + ' passed'), lines.join('\n'));
}

function randomStrongPin_() {
  let p;
  do { p = String(Math.floor(Math.random() * 1e6)).padStart(6, '0'); } while (isWeakPin_(p));
  return p;
}

// --- Stage 4: PO acceptance helpers ----------------------------------------------------------

// Test suppliers are named "PO Desk Test Supplier …". Cleanup archives them, and Xero's API can't
// un-archive, so each test run creates a fresh one (testSupplierName()) instead of reusing one.
const TEST_SUPPLIER_NAME = 'PO Desk Test Supplier';
// A second test name for "the slip is from another supplier": it must share no word with the first,
// or the supplier check would call them the same business.
const TEST_SLIP_SUPPLIER_NAME = 'QA Vendor';
function testSupplierName() {
  const name = TEST_SUPPLIER_NAME + ' ' + Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd HHmm');
  console.log('Use this supplier name for the test POs: ' + name);
  return name;
}

/** Arms a one-shot "Composio is down" failure for the next PO creation (see consumeForcedFailure_). */
function armForcedPOFailure() {
  PropertiesService.getScriptProperties().setProperty('TEST_FAIL_NEXT', 'proxy PUT /PurchaseOrders$');
  console.log('Armed: the next PO creation will fail all 3 attempts and get a provisional ref. processQueue converts it.');
}

/** UAT "Composio outage", once per company: the next THREE PO creations fail and get provisional refs. */
function armOutageForUat() {
  PropertiesService.getScriptProperties().setProperty('TEST_FAIL_NEXT', 'proxy PUT /PurchaseOrders$|3');
  console.log('Armed: the next 3 PO creations (one per company in the UAT run) fail and get provisional refs; processQueue converts them.');
}

function disarmForcedPOFailure() {
  PropertiesService.getScriptProperties().deleteProperty('TEST_FAIL_NEXT');
  console.log('Disarmed.');
}

/** Median and worst server time per createPO step over the last n POs (from AuditLog). */
function poTimingReport(n) {
  n = Number(n) || 10;
  const rows = readTable('AuditLog').rows
    .filter(r => r.action === 'po.create' && isTrue_(r.ok))
    .map(r => { try { return JSON.parse(r.detail_json); } catch (e) { return null; } })
    .filter(d => d && d.ms && !d.duplicate && d.ms.xero !== undefined)
    .slice(-n);
  if (!rows.length) { console.log('No PO creations in the AuditLog yet.'); return; }
  const steps = ['auth', 'prep', 'lock', 'xero', 'write', 'choice', 'notify', 'total'];
  const median = a => { const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
  const table = steps.map(st => {
    const vals = rows.map(d => Number(d.ms[st]) || 0);
    return { step: st, median_ms: median(vals), worst_ms: Math.max.apply(null, vals) };
  });
  out_('createPO server time over the last ' + rows.length + ' POs', table_(table, ['step', 'median_ms', 'worst_ms']) +
    '\n\nPer PO (total ms): ' + rows.map(d => d.ms.total + (d.status === 'PENDING_XERO' ? ' (provisional)' : '')).join(', '));
}

/**
 * Deletes every test PO in Xero and marks its row CANCELLED: POs by the test buyer, and POs to the
 * test supplier by anyone. Then removes their queue jobs and the supplier's history, archives the
 * test supplier and drops it from the Suppliers list. Safe to run twice.
 */
function cleanupTestPOs() {
  ENTITY_SEED.forEach(e => cleanupTestPOsFor_(e.entity_id));
}
function cleanupTestPOs_NHP() { cleanupTestPOsFor_('NHP'); }
function cleanupTestPOs_HPB() { cleanupTestPOsFor_('HPB'); }
function cleanupTestPOs_PK() { cleanupTestPOsFor_('PK'); }

/** One company: POs by any UAT account (Setup.gs UAT_ACCOUNTS) or to a test supplier, their bills and slips. */
function cleanupTestPOsFor_(entity) {
  const ent = entityById_(entity).entity_id;
  const testUserIds = UAT_ACCOUNTS.map(a => findUserByEmail_(a.email)).filter(Boolean).map(u => String(u.user_id));
  const t = entityById_(ent).xero_tenant_id;
  const ctx = { ref: 'cleanup:test-pos' };
  const isTestName = n => [TEST_SUPPLIER_NAME, TEST_SLIP_SUPPLIER_NAME].some(p => normName_(n).indexOf(normName_(p)) === 0);
  const supplierIds = readTable('Suppliers').rows.filter(s => s.entity_id === ent && isTestName(s.name)).map(s => s.contact_id);
  const inXero = xeroSearchContacts(t, TEST_SUPPLIER_NAME, ctx).concat(xeroSearchContacts(t, TEST_SLIP_SUPPLIER_NAME, ctx)).filter(c => isTestName(c.Name));
  inXero.forEach(c => { if (supplierIds.indexOf(c.ContactID) === -1) supplierIds.push(c.ContactID); });

  invalidateTable_('POs');
  const targets = readTable('POs').rows.filter(r => r.entity_id === ent && r.status !== PO_STATUS.CANCELLED &&
    (testUserIds.indexOf(String(r.buyer_user_id)) !== -1 || supplierIds.indexOf(r.contact_id) !== -1));
  const report = [];
  invalidateTable_('Bills');
  const billsByPo = {};
  readTable('Bills').rows.forEach(b => { (billsByPo[b.po_id] = billsByPo[b.po_id] || []).push(b); });
  targets.forEach(r => {
    const was = r.status;
    let xeroStatus = '-';
    let billStatus = '-';
    try {
      // Bills first, so a failure halfway never leaves a live bill whose PO is already deleted.
      (billsByPo[r.po_id] || []).filter(b => b.xero_invoice_id).forEach(b => {
        const cur = xeroGetInvoiceById(t, b.xero_invoice_id, ctx) || {};
        if (cur.Status && cur.Status !== 'DELETED' && cur.Status !== 'VOIDED') {
          xeroProxy_(t, 'POST', '/Invoices/' + b.xero_invoice_id, { body: { Invoices: [{ InvoiceID: b.xero_invoice_id, Status: 'DELETED' }] } }, ctx);
        }
        billStatus = (xeroGetInvoiceById(t, b.xero_invoice_id, ctx) || {}).Status;
      });
      if (r.xero_po_id) {
        const cur = xeroGetPurchaseOrder(t, r.xero_po_id, ctx) || {};
        if (cur.Status !== 'DELETED') {
          try {
            xeroUpdatePurchaseOrder(t, r.xero_po_id, { Status: 'DELETED' }, ctx);
          } catch (err) {
            // A billed PO may have to be un-billed before Xero lets it go.
            if (cur.Status !== 'BILLED') throw err;
            xeroUpdatePurchaseOrder(t, r.xero_po_id, { Status: 'AUTHORISED' }, ctx);
            xeroUpdatePurchaseOrder(t, r.xero_po_id, { Status: 'DELETED' }, ctx);
          }
        }
        xeroStatus = (xeroGetPurchaseOrder(t, r.xero_po_id, ctx) || {}).Status;
      }
      updateRowById('POs', 'po_id', r.po_id, { status: PO_STATUS.CANCELLED });
      report.push({ po: r.po_number || r.provisional_ref, amount: r.amount_incl_zar, was: was, bill: billStatus, xero: xeroStatus, row: 'CANCELLED' });
    } catch (err) {
      report.push({ po: r.po_number || r.provisional_ref, amount: r.amount_incl_zar, was: was, bill: billStatus, xero: 'ERROR ' + err.message, row: r.status });
    }
  });

  const poIds = targets.map(r => r.po_id);
  // Slips of test POs: photos to the bin, Bills rows removed.
  invalidateTable_('Bills');
  const testBills = readTable('Bills').rows.filter(b => poIds.indexOf(b.po_id) !== -1);
  const jobRefs = poIds.concat(testBills.map(b => b.bill_id));
  testBills.forEach(b => { if (b.drive_file_id) trashSlip_(b.drive_file_id); });
  testBills.map(b => b._row).sort((a, b) => b - a).forEach(n => sheet_('Bills').deleteRow(n));
  invalidateTable_('Bills');
  invalidateTable_('Queue');
  readTable('Queue').rows.filter(j => jobRefs.some(id => String(j.payload_json).indexOf(id) !== -1)).map(j => j._row)
    .sort((a, b) => b - a).forEach(n => sheet_('Queue').deleteRow(n));
  invalidateTable_('Queue');

  readTable('SupplierHistory').rows.filter(h => h.entity_id === ent && supplierIds.indexOf(h.contact_id) !== -1).map(h => h._row)
    .sort((a, b) => b - a).forEach(n => sheet_('SupplierHistory').deleteRow(n));
  invalidateTable_('SupplierHistory');

  // Only ACTIVE ones: Xero's API refuses to touch a contact that is already archived.
  const contacts = supplierIds.map(id => {
    try {
      const c = xeroGetContactById(t, id, ctx) || {};
      if (c.ContactStatus === 'ACTIVE') xeroSetContactStatus(t, id, 'ARCHIVED', ctx);
      return '"' + c.Name + '" -> ' + (xeroGetContactById(t, id, ctx) || {}).ContactStatus;
    } catch (err) { return id + ' ERROR ' + err.message; }
  });
  const supRows = readTable('Suppliers').rows.filter(s => s.entity_id === ent && supplierIds.indexOf(s.contact_id) !== -1).map(s => s._row);
  supRows.sort((a, b) => b - a).forEach(n => sheet_('Suppliers').deleteRow(n));
  invalidateTable_('Suppliers');
  if (supRows.length) invalidateRefCache(ent);

  out_('cleanupTestPOs ' + ent, table_(report, ['po', 'amount', 'was', 'bill', 'xero', 'row']) + '\n\nContacts: ' + (contacts.join('; ') || 'none') +
    '\nQueue jobs removed for ' + poIds.length + ' PO(s); slips removed: ' + testBills.length + '; supplier history cleared; Suppliers rows removed: ' + supRows.length + '.');
}

/**
 * Proves the Sheets API fast path gives exactly what SpreadsheetApp gives, on the live Sheet:
 * every tab read both ways and compared cell by cell, then one tricky row written the fast way and
 * read back the slow way. Run once after deploying; createPO relies on this equivalence.
 */
function testFastSheets() {
  const lines = [];
  let failures = 0;
  const check = (label, cond, detail) => { if (!cond) failures++; lines.push((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : ' -> ' + detail)); };
  const same = (a, b) => (a instanceof Date || b instanceof Date)
    ? (a instanceof Date && b instanceof Date && Math.abs(a - b) < 1000)
    : String(a) === String(b) && typeof a === typeof b;

  Object.keys(TABLES).forEach(name => {
    invalidateTable_(name);
    const t0 = Date.now();
    const slow = readTable(name);
    const slowMs = Date.now() - t0;
    const t1 = Date.now();
    const ok = fastRead_([name], true);
    const fastMs = Date.now() - t1;
    if (!ok) { check(name + ': fast read available', false, 'fast path is off (see warnings)'); return; }
    const fast = readTable(name);
    let diff = '';
    if (fast.rows.length !== slow.rows.length) diff = 'rows ' + fast.rows.length + ' vs ' + slow.rows.length;
    for (let i = 0; !diff && i < slow.rows.length; i++) {
      if (fast.rows[i]._row !== slow.rows[i]._row) { diff = 'row number ' + fast.rows[i]._row + ' vs ' + slow.rows[i]._row; break; }
      slow.headers.forEach(h => {
        if (!diff && h && !same(fast.rows[i][h], slow.rows[i][h])) diff = 'row ' + slow.rows[i]._row + ' ' + h + ': ' + JSON.stringify(fast.rows[i][h]) + ' (' + typeof fast.rows[i][h] + ') vs ' + JSON.stringify(slow.rows[i][h]) + ' (' + typeof slow.rows[i][h] + ')';
      });
    }
    check(pad_(name, 16) + slow.rows.length + ' rows identical (slow ' + slowMs + ' ms, fast ' + fastMs + ' ms)', !diff, diff);
  });

  const t2 = Date.now();
  fastRead_(['Users', 'UserEntities', 'Entities', 'Config', 'PaymentMethods', 'Categories', 'SupplierHistory', 'POs'], true);
  lines.push('     createPO\'s 8 tabs in one fast read: ' + (Date.now() - t2) + ' ms');

  const when = new Date(Math.floor(Date.now() / 1000) * 1000);
  const marker = 'fastpath-' + Utilities.getUuid().slice(0, 8);
  const probe = { ts: when, user_id: '0123', entity_id: '1/2', action: '=1+1', ref: marker, ok: true, detail_json: '-5' };
  try {
    sheetsFetch_([appendReq_('AuditLog', [probe])]);
    invalidateTable_('AuditLog');
    const back = readTable('AuditLog').rows.find(r => r.ref === marker);
    check('fast write lands', !!back, 'row not found');
    if (back) {
      check('date written fast reads back as the same Date', back.ts instanceof Date && Math.abs(back.ts - when) < 1000, String(back.ts));
      check('"0123", "1/2", "=1+1", "-5" stay text', back.user_id === '0123' && back.entity_id === '1/2' && back.action === '=1+1' && back.detail_json === '-5',
        JSON.stringify([back.user_id, back.entity_id, back.action, back.detail_json]));
      check('boolean stays boolean', back.ok === true, JSON.stringify(back.ok));
      sheet_('AuditLog').deleteRow(back._row);
    }
  } catch (err) {
    check('fast write', false, err.message);
  }
  out_('testFastSheets: ' + (failures ? failures + ' FAILURE(S)' : 'all passed') + ' (sheet timezone ' + (dbCache_.tz || '?') + ')', lines.join('\n'));
}

// --- Stage 5: slip-reading accuracy test ------------------------------------------------------
// Put slip photos in Drive under PO Desk/_test. runSlipTest() reads each one at 1600 px (what the
// app sends) and writes a "SlipTest" tab. Fill the true_* columns ("ok" = the read value is right,
// "none" = not on the slip), then scoreSlipTest() reports accuracy per field.

const SLIP_TEST_TAB = 'SlipTest';
const SLIP_TEST_COLS = ['file', 'sent', 'model', 'ms', 'status', 'reason', 'supplier', 'date', 'total', 'vat', 'vat_number', 'slip_number', 'lines', 'low_confidence', 'checks',
  'true_supplier', 'true_date', 'true_total', 'true_vat', 'true_vat_number', 'true_slip_number'];

function runSlipTest() { runSlipTest_(false); }

/** Re-reads only the slips that came back "manual" (and any new photos); every other row stays exactly as it is. */
function rerunFailedSlips() { runSlipTest_(true); }

function runSlipTest_(onlyFailed) {
  const root = DriveApp.getFolderById(getSecret_('DRIVE_ROOT_ID'));
  const it = root.getFoldersByName('_test');
  if (!it.hasNext()) throw new AppError('SETUP_ORDER', 'Create a folder "_test" inside PO Desk and put the slip photos in it.');
  const files = [];
  const fit = it.next().getFiles();
  while (fit.hasNext()) { const f = fit.next(); if (/^image\//.test(f.getMimeType())) files.push(f); }
  files.sort((a, b) => a.getName().localeCompare(b.getName()));
  if (!files.length) throw new AppError('SETUP_ORDER', 'No images in PO Desk/_test.');

  const ss = db_();
  const sh = ss.getSheetByName(SLIP_TEST_TAB) || ss.insertSheet(SLIP_TEST_TAB);
  const prev = {};
  if (sh.getLastRow() > 1) {
    const vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    const h = vals[0].map(String);
    vals.slice(1).forEach(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); prev[o.file] = o; });
  }
  const rows = [];
  let reads = 0;
  files.forEach((file, i) => {
    const keep = prev[file.getName()] || {};
    if (onlyFailed && keep.status && keep.status !== 'manual') {
      rows.push(SLIP_TEST_COLS.map(c => (keep[c] === undefined || keep[c] === null ? '' : keep[c])));
      return;
    }
    if (reads++ > 0) Utilities.sleep(6500);   // stay well under free-tier requests-per-minute limits
    const sized = slipTestImage_(file);
    const r = extractSlipFromBlob_(sized.blob, { ref: 'slip-test:' + file.getName() });
    const f = r.fields || {};
    // "ok" meant "the old read was right". The new read may differ, so keep the old value itself as the truth.
    const truth = (k) => { const t = String(keep['true_' + k] || '').trim(); return /^ok$/i.test(t) ? (String(keep[k] || '').trim() || 'none') : t; };
    const reason = (r.reason || '') + (r.http ? ' [HTTP ' + r.http + (r.error ? ' ' + r.error : '') + ']' : '');
    rows.push([file.getName(), sized.note, r.model, r.ms, r.status, reason, f.supplierName || '', f.date || '', f.totalIncl === null || f.totalIncl === undefined ? '' : f.totalIncl,
      f.vatAmount === null || f.vatAmount === undefined ? '' : f.vatAmount, f.supplierVatNumber || '', f.slipNumber || '', (f.lineItems || []).length,
      (r.lowConfidence || []).join(', '), (r.checks || []).map(c => c.code).join(', '),
      truth('supplier'), truth('date'), truth('total'), truth('vat'), truth('vat_number'), truth('slip_number')]);
    console.log((i + 1) + '/' + files.length + ' ' + file.getName() + ': ' + r.status + ' ' + (f.supplierName || '-') + ' | ' + (f.date || '-') + ' | ' + (f.totalIncl == null ? '-' : f.totalIncl) + ' (' + r.ms + ' ms, ' + sized.note + ')' + (r.status === 'manual' ? ' — ' + reason : ''));
  });
  if (onlyFailed && !reads) { out_('rerunFailedSlips: nothing to re-read', 'No slip in the "' + SLIP_TEST_TAB + '" tab has status "manual".'); return; }
  sh.clear();
  sh.getRange(1, 1, 1, SLIP_TEST_COLS.length).setValues([SLIP_TEST_COLS]).setFontWeight('bold');
  // Text format, so typed truths like 03/11/2026 or 0123 are never reinterpreted.
  sh.getRange(1, 1, Math.max(rows.length + 1, 50), SLIP_TEST_COLS.length).setNumberFormat('@');
  sh.getRange(2, 1, rows.length, SLIP_TEST_COLS.length).setValues(rows.map(r => r.map(v => typeof v === 'number' ? String(v) : v)));
  sh.setFrozenRows(1);
  out_((onlyFailed ? 'rerunFailedSlips: ' + reads + ' slip(s) re-read' : 'runSlipTest: ' + rows.length + ' slip(s) read'),'Results are in the "' + SLIP_TEST_TAB + '" tab. Fill the true_* columns ("ok" if the read value is right, "none" if it is not on the slip), then run scoreSlipTest().');
}

/** A 1600 px rendition from Drive, like the app's downscale; falls back to the original if Drive has none. */
function slipTestImage_(file) {
  try {
    const token = ScriptApp.getOAuthToken();
    const meta = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '?fields=thumbnailLink', { headers: { Authorization: 'Bearer ' + token } }).getContentText());
    if (!meta.thumbnailLink) throw new Error('no thumbnail');
    const res = UrlFetchApp.fetch(meta.thumbnailLink.replace(/=s\d+$/, '=s1600'), { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('thumbnail ' + res.getResponseCode());
    const blob = res.getBlob();
    return { blob: blob.setContentType(blob.getContentType() || 'image/jpeg'), note: '1600px ' + Math.round(blob.getBytes().length / 1024) + ' KB' };
  } catch (err) {
    const blob = file.getBlob();
    if (blob.getBytes().length > 15 * 1024 * 1024) throw new AppError('TOO_LARGE', file.getName() + ' is over 15 MB and Drive has no smaller rendition.');
    return { blob: blob, note: 'original ' + Math.round(blob.getBytes().length / 1024) + ' KB (' + err.message + ')' };
  }
}

function scoreSlipTest() {
  const sh = db_().getSheetByName(SLIP_TEST_TAB);
  if (!sh || sh.getLastRow() < 2) throw new AppError('SETUP_ORDER', 'Run runSlipTest() first.');
  const vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  const h = vals[0].map(String);
  const rows = vals.slice(1).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i] instanceof Date ? Utilities.formatDate(r[i], APP.TZ, 'yyyy-MM-dd') : String(r[i]).trim(); }); return o; });
  const isoOf = (t) => { const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(t); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); } return t.slice(0, 10); };
  const none = (t) => /^(none|-|n\/a|na)$/i.test(t);
  const FIELDS = {
    supplier: (x, t) => namesMatch_(x, t, false),
    date: (x, t) => x === isoOf(t),
    total: (x, t) => x !== '' && Math.abs(parseAmount_(x) - parseAmount_(t)) < 0.005,
    vat: (x, t) => (none(t) ? x === '' : x !== '' && Math.abs(parseAmount_(x) - parseAmount_(t)) < 0.005),
    vat_number: (x, t) => (none(t) ? x === '' : x === t.replace(/\D/g, '')),
    slip_number: (x, t) => (none(t) ? x === '' : x.replace(/\s+/g, '').toLowerCase() === t.replace(/\s+/g, '').toLowerCase()),
  };
  const tally = {};
  Object.keys(FIELDS).forEach(k => { tally[k] = { right: 0, n: 0, wrong: [] }; });
  let keyAllRight = 0;
  let keyScored = 0;
  const perSlip = rows.map(r => {
    const res = {};
    Object.keys(FIELDS).forEach(k => {
      const t = r['true_' + k];
      if (!t) { res[k] = ''; return; }
      const ok = /^ok$/i.test(t) || FIELDS[k](r[k], t);
      tally[k].n++;
      if (ok) tally[k].right++; else tally[k].wrong.push(r.file + ' (read "' + r[k] + '", true "' + t + '")');
      res[k] = ok ? '✓' : '✗';
    });
    if (res.supplier && res.date && res.total) { keyScored++; if (res.supplier === '✓' && res.date === '✓' && res.total === '✓') keyAllRight++; }
    return Object.assign({ file: r.file, status: r.status }, res);
  });
  const summary = Object.keys(FIELDS).map(k => ({ field: k, accuracy: tally[k].n ? tally[k].right + '/' + tally[k].n + ' (' + Math.round(tally[k].right / tally[k].n * 100) + '%)' : 'not scored' }));
  out_('scoreSlipTest: supplier + date + total all right on ' + keyAllRight + ' of ' + keyScored + ' slips' + (keyScored ? (keyAllRight >= Math.ceil(keyScored * 0.8) ? ' (meets 8 of 10)' : ' (BELOW 8 of 10)') : ''),
    table_(summary, ['field', 'accuracy']) + '\n\n' + table_(perSlip, ['file', 'status', 'supplier', 'date', 'total', 'vat', 'vat_number', 'slip_number']) +
    '\n\nWrong:\n' + Object.keys(FIELDS).map(k => tally[k].wrong.map(w => '  ' + k + ': ' + w).join('\n')).filter(Boolean).join('\n'));
}

/** Arms a one-shot "Gemini unavailable" for the next slip read, to test typing the slip by hand. */
function armGeminiFailure() {
  PropertiesService.getScriptProperties().setProperty('TEST_FAIL_GEMINI', '1');
  console.log('Armed: the next slip read returns "read manually".');
}

// --- Stage 6: draft bills -----------------------------------------------------------------------

/**
 * Acceptance check, read back from Xero itself: for every bill PO Desk made in a company in the last
 * `days` days, the PO number in the bill's Reference, VAT-inclusive amounts, total and VAT equal to
 * the slip, the slip attached to the bill and to the PO, the PO BILLED, and exactly one bill per slip.
 */
function checkBills(entity, days) {
  const ent = entityById_(entity || 'NHP').entity_id;
  const t = entityById_(ent).xero_tenant_id;
  const ctx = { ref: 'check:bills' };
  const since = Date.now() - (days || 1) * 86400000;
  invalidateTable_('Bills');
  invalidateTable_('POs');
  const pos = {};
  readTable('POs').rows.forEach(r => { pos[r.po_id] = r; });
  const bills = readTable('Bills').rows.filter(b => b.entity_id === ent && b.xero_invoice_id && new Date(b.created_at).getTime() >= since);
  const tick = (ok) => (ok ? '✓' : '✗');
  let allOk = 0;
  const rows = bills.map(b => {
    const po = pos[b.po_id] || {};
    const steps = parseJson_(b.steps_json) || {};
    const f = (parseJson_(b.ocr_json) || {}).reviewed || {};
    try {
      const inv = xeroGetInvoiceById(t, b.xero_invoice_id, ctx) || {};
      const billAtt = xeroListAttachments(t, 'Invoices', b.xero_invoice_id, ctx).length;
      const xpo = xeroFirst_(xeroProxy_(t, 'GET', '/PurchaseOrders/' + po.xero_po_id, {}, ctx).data || {}, 'PurchaseOrders', 'PurchaseOrderID') || {};
      const poAtt = xeroListAttachments(t, 'PurchaseOrders', po.xero_po_id, ctx).length;
      const contactId = (inv.Contact || {}).ContactID;
      const copies = xeroList_(xeroProxy_(t, 'GET', '/Invoices?ContactIDs=' + contactId + '&where=' + encodeURIComponent('Type=="ACCPAY"'), {}, ctx).data || {}, 'Invoices')
        .filter(i => i.InvoiceNumber === inv.InvoiceNumber && i.Status !== 'DELETED' && i.Status !== 'VOIDED').length;
      const plan = billPlan_(po, f, contactId);
      const slipVat = f.vatAmount === null || f.vatAmount === undefined ? null : Number(f.vatAmount);
      const refOk = String(inv.InvoiceNumber || '').indexOf(String(po.po_number)) === 0;
      const inclOk = inv.LineAmountTypes === 'Inclusive';
      const totalOk = Math.abs(Number(inv.Total) - Number(f.totalIncl)) < 0.005;
      // With a VAT number the bill's VAT must be the slip's; without one, no VAT can be claimed (R0.00).
      const vatOk = Math.abs(Number(inv.TotalTax) - plan.expectTax) < 0.005 && (plan.mode === 'none' || slipVat === null || Math.abs(Number(inv.TotalTax) - slipVat) < 0.005);
      const ok = inv.Type === 'ACCPAY' && inv.Status === 'DRAFT' && refOk && inclOk && totalOk && vatOk && billAtt >= 1 && xpo.Status === 'BILLED' && poAtt >= 1 && copies === 1;
      if (ok) allOk++;
      return {
        po: po.po_number, reference: inv.InvoiceNumber, bill: inv.Type + ' ' + inv.Status, incl: tick(inclOk), total: Number(inv.Total).toFixed(2) + ' ' + tick(totalOk),
        vat: Number(inv.TotalTax).toFixed(2) + ' vs slip ' + (slipVat === null ? '-' : slipVat.toFixed(2)) + (plan.mode === 'none' ? ' (no VAT)' : plan.mode === 'mixed' ? ' (mixed)' : '') + ' ' + tick(vatOk),
        billSlip: billAtt + ' ' + tick(billAtt >= 1), poStatus: xpo.Status + ' ' + tick(xpo.Status === 'BILLED'), poSlip: poAtt + ' ' + tick(poAtt >= 1), copies: copies + ' ' + tick(copies === 1),
        supplier: String((inv.Contact || {}).Name || '') + (steps.contactChanged ? ' (changed)' : ''), app: b.status, all: tick(ok),
      };
    } catch (err) {
      return { po: po.po_number, reference: steps.reference, bill: 'ERROR ' + err.message, app: b.status, all: '✗' };
    }
  });
  out_('checkBills ' + ent + ': ' + allOk + ' of ' + rows.length + ' bill(s) pass every check',
    table_(rows, ['po', 'reference', 'bill', 'incl', 'total', 'vat', 'billSlip', 'poStatus', 'poSlip', 'copies', 'supplier', 'app', 'all']));
}

function checkBills_NHP() { checkBills('NHP', 1); }
function checkBills_HPB() { checkBills('HPB', 1); }
function checkBills_PK() { checkBills('PK', 1); }
function checkBills_all() { ENTITY_SEED.forEach(e => checkBills(e.entity_id, 1)); }

/** One-shot: the next slip upload to a Xero PO fails, to show the bill finishing from the queue. */
function armBillAttachFailure() {
  PropertiesService.getScriptProperties().setProperty('TEST_FAIL_NEXT', 'proxy PUT /PurchaseOrders/');
  console.log('Armed: the next slip attachment to a PO fails once; the queue (every 5 minutes) finishes it.');
}
