/**
 * Xero.gs — thin helpers over Composio's Xero tools. Every helper that touches an organisation's
 * data REQUIRES a tenantId and checks it against the code allowlist (Config.gs ENTITY_SEED).
 *
 * Why so strict: when tenant_id is omitted, Composio's Xero tools silently use the first connected
 * org, and the same connection also reaches Nandrea. A missing ID must fail loudly, never default.
 */

const XERO_API = 'https://api.xero.com/api.xro/2.0';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHABLE = Object.freeze(['PurchaseOrders', 'Invoices']);

function assertTenant_(tenantId) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new AppError('TENANT_REQUIRED', 'A Xero tenant ID is required for every Xero call.');
  }
  const t = tenantId.trim().toLowerCase();
  if (isBlockedTenant_(t)) throw new AppError('TENANT_BLOCKED', 'That Xero organisation is out of scope for PO Desk.');
  const ent = entityByTenant_(t);
  if (!ent) throw new AppError('TENANT_UNKNOWN', 'Unknown Xero tenant ID.');
  return { tenantId: t, entityId: ent.entity_id };
}

function assertUuid_(id, what) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new AppError('BAD_ID', (what || 'ID') + ' is not a valid Xero ID.');
  return id;
}

/**
 * tenantParam: most tools take `tenant_id`, but XERO_LIST_INVOICES takes `tenantId`. Sending the
 * wrong key would be ignored by Composio and fall back to the first org, so it is explicit per tool.
 */
// Tools proven to IGNORE tenant_id and answer from the first connected org (HPB). Verified 3 Nov 2026:
// XERO_GET_CONTACTS returned HPB's 97 contacts (same ContactIDs) for HPB, NHP and PK alike.
// Their reads go through the proxy with an explicit xero-tenant-id header instead.
const TENANT_UNSAFE_TOOLS = Object.freeze(['XERO_GET_CONTACTS']);

function xeroTool_(toolSlug, tenantId, args, ctx, tenantParam) {
  if (TENANT_UNSAFE_TOOLS.indexOf(toolSlug) !== -1) throw new AppError('TOOL_UNSAFE', toolSlug + ' ignores tenant_id; use the proxy helper instead.');
  const g = assertTenant_(tenantId);
  const a = Object.assign({}, args || {});
  delete a.tenant_id;
  delete a.tenantId;
  a[tenantParam || 'tenant_id'] = g.tenantId;
  const data = composioExecute(toolSlug, a, Object.assign({}, ctx || {}, { entityId: g.entityId }));
  const body = xeroBody_(data);
  const errs = xeroValidationMessages_(body);
  if (errs.length || body.HasErrors === true) throw new AppError('XERO_VALIDATION', errs.join('; ') || 'Xero reported an error.');
  return body;
}

function xeroProxy_(tenantId, method, path, opts, ctx) {
  const g = assertTenant_(tenantId);
  opts = Object.assign({}, opts || {});
  opts.headers = Object.assign({ Accept: 'application/json' }, opts.headers || {}, { 'xero-tenant-id': g.tenantId });
  return composioProxy(method, XERO_API + path, opts, Object.assign({}, ctx || {}, { entityId: g.entityId }));
}

// --- Response shape helpers -------------------------------------------------------------------
// Composio sometimes nests Xero's body under data.data (e.g. GET_ORGANISATION) and sometimes
// returns it flat (e.g. CREATE_PURCHASE_ORDER), so never assume one shape.

function xeroBody_(data) {
  let d = data;
  for (let i = 0; i < 3; i++) {
    if (d && typeof d === 'object' && !Array.isArray(d) && d.data && typeof d.data === 'object') d = d.data;
    else break;
  }
  return d || {};
}

function xeroList_(body, key) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[key])) return body[key];
  return [];
}

function xeroFirst_(body, key, idField) {
  if (body && Array.isArray(body[key])) return body[key][0] || null;
  if (body && body[idField]) return body;
  return null;
}

/**
 * Fetches every page of a paged list tool. Stops at pagination.pageCount when Xero reports it,
 * otherwise at the first empty page (never at a short page: Composio may cap pageSize silently).
 * deadline (ms epoch) aborts long syncs before Apps Script's 6-minute limit kills them mid-write.
 */
function xeroListAllPages(toolSlug, tenantId, args, key, opts) {
  opts = opts || {};
  const all = [];
  for (let page = 1; page <= (opts.maxPages || 200); page++) {
    if (opts.deadline && Date.now() > opts.deadline) throw new AppError('SYNC_TIMEOUT', toolSlug + ' stopped at page ' + page + ' to stay inside the time limit.');
    const body = xeroTool_(toolSlug, tenantId, Object.assign({}, args || {}, { page: page }), opts.ctx, opts.tenantParam);
    const items = xeroList_(body, key);
    items.forEach(i => all.push(i));
    const pageCount = body.pagination && Number(body.pagination.pageCount);
    if (pageCount ? page >= pageCount : items.length === 0) break;
  }
  return all;
}

// --- Connections and organisation --------------------------------------------------------------

/** The only call without a tenant: it is how tenants are discovered. Callers must filter the result. */
function xeroGetConnections(ctx) {
  const body = xeroBody_(composioExecute('XERO_GET_CONNECTIONS', {}, ctx));
  return xeroList_(body, 'connections').map(c => Object.assign({}, c, {
    blocked: isBlockedTenant_(c.tenantId),
    entity: entityByTenant_(c.tenantId) ? entityByTenant_(c.tenantId).entity_id : null,
  }));
}

function xeroGetOrganisation(tenantId, ctx) {
  return xeroFirst_(xeroTool_('XERO_GET_ORGANISATION', tenantId, {}, ctx), 'Organisations', 'OrganisationID');
}

// --- Reference data ---------------------------------------------------------------------------

function xeroListAccounts(tenantId, where, ctx) {
  const args = { order: 'Code ASC' };
  if (where) args.where = where;
  return xeroList_(xeroTool_('XERO_LIST_ACCOUNTS', tenantId, args, ctx), 'Accounts');
}

function xeroListTaxRates(tenantId, where, ctx) {
  const args = {};
  if (where) args.where = where;
  return xeroList_(xeroTool_('XERO_LIST_TAX_RATES', tenantId, args, ctx), 'TaxRates');
}

// --- Contacts ---------------------------------------------------------------------------------

const CONTACT_QUERY_KEYS = Object.freeze(['page', 'pageSize', 'where', 'order', 'searchTerm', 'includeArchived', 'summaryOnly', 'IDs']);

/**
 * Contacts via the proxy (XERO_GET_CONTACTS ignores tenant_id — see TENANT_UNSAFE_TOOLS).
 * query: { ContactID } for one contact, or any of CONTACT_QUERY_KEYS. Returns an array.
 */
function xeroGetContacts(tenantId, query, ctx) {
  return xeroGetContactsPage_(tenantId, query, ctx).items;
}

function xeroGetContactsPage_(tenantId, query, ctx) {
  query = query || {};
  if (query.ContactID) {
    const one = xeroGetContactById(tenantId, query.ContactID, ctx);
    return { items: one ? [one] : [], pagination: null };
  }
  const qs = CONTACT_QUERY_KEYS.filter(k => query[k] !== undefined && query[k] !== null && query[k] !== '')
    .map(k => k + '=' + encodeURIComponent(Array.isArray(query[k]) ? query[k].join(',') : String(query[k])))
    .join('&');
  const res = xeroProxy_(tenantId, 'GET', '/Contacts' + (qs ? '?' + qs : ''), {}, ctx);
  const body = res.data || {};
  return { items: xeroList_(body, 'Contacts'), pagination: body.pagination || null };
}

/** Every ACTIVE contact of one company, paged through the proxy. */
function xeroListAllContacts(tenantId, opts) {
  opts = opts || {};
  const pageSize = opts.pageSize || 500;
  const all = [];
  for (let page = 1; page <= (opts.maxPages || 100); page++) {
    if (opts.deadline && Date.now() > opts.deadline) throw new AppError('SYNC_TIMEOUT', 'Contacts stopped at page ' + page + ' to stay inside the time limit.');
    const r = xeroGetContactsPage_(tenantId, { page: page, pageSize: pageSize }, opts.ctx);
    r.items.forEach(c => all.push(c));
    const pageCount = r.pagination && Number(r.pagination.pageCount);
    // Xero itself honours pageSize, so a short page is the last one even without pagination info.
    if (pageCount ? page >= pageCount : r.items.length < pageSize) break;
  }
  return all;
}

function xeroCreateContact(tenantId, fields, ctx) {
  if (!fields || !String(fields.Name || '').trim()) throw new AppError('BAD_REQUEST', 'A supplier name is required.');
  const body = xeroTool_('XERO_CREATE_CONTACT', tenantId, Object.assign({ IsSupplier: true }, fields), ctx);
  return xeroFirst_(body, 'Contacts', 'ContactID');
}

// Single-contact and by-name lookups also go through the proxy, which sends xero-tenant-id explicitly
// and returns archived contacts too (needed before creating a "new" supplier whose name Xero holds).

function xeroGetContactById(tenantId, contactId, ctx) {
  assertUuid_(contactId, 'ContactID');
  const res = xeroProxy_(tenantId, 'GET', '/Contacts/' + contactId, {}, ctx);
  return xeroFirst_(res.data || {}, 'Contacts', 'ContactID');
}

/** Exact-name match, including archived contacts. */
function xeroFindContactsByName(tenantId, name, ctx) {
  // Double quotes would end the OData string literal early.
  const safe = String(name || '').replace(/"/g, '').trim();
  if (!safe) throw new AppError('BAD_REQUEST', 'A supplier name is required.');
  const path = '/Contacts?includeArchived=true&where=' + encodeURIComponent('Name=="' + safe + '"');
  const res = xeroProxy_(tenantId, 'GET', path, {}, ctx);
  // Re-check the name here too: callers archive what this returns, so never rely on the filter alone.
  return xeroList_(res.data || {}, 'Contacts').filter(c => normName_(c.Name) === normName_(safe));
}

/** XERO_UPDATE_CONTACT has no ContactStatus field, so archiving goes straight to Xero via the proxy. */
function xeroSetContactStatus(tenantId, contactId, status, ctx) {
  assertUuid_(contactId, 'ContactID');
  if (['ACTIVE', 'ARCHIVED'].indexOf(status) === -1) throw new AppError('BAD_REQUEST', 'Contact status must be ACTIVE or ARCHIVED.');
  const res = xeroProxy_(tenantId, 'POST', '/Contacts/' + contactId, { body: { Contacts: [{ ContactID: contactId, ContactStatus: status }] } }, ctx);
  return xeroFirst_(res.data || {}, 'Contacts', 'ContactID');
}

// --- Purchase orders --------------------------------------------------------------------------

/** po: { ContactID, LineItems, Date, DeliveryDate, Reference, Status }. Returns the PO incl. PurchaseOrderNumber. */
function xeroCreatePurchaseOrder(tenantId, po, ctx) {
  assertUuid_(po && po.ContactID, 'ContactID');
  return xeroFirst_(xeroTool_('XERO_CREATE_PURCHASE_ORDER', tenantId, po, ctx), 'PurchaseOrders', 'PurchaseOrderID');
}

/** Used for fields the create tool lacks (LineAmountTypes, AttentionTo) and for status changes. */
function xeroUpdatePurchaseOrder(tenantId, purchaseOrderId, patch, ctx) {
  assertUuid_(purchaseOrderId, 'PurchaseOrderID');
  const args = Object.assign({}, patch || {}, { purchase_order_id: purchaseOrderId });
  return xeroFirst_(xeroTool_('XERO_UPDATE_PURCHASE_ORDER', tenantId, args, ctx), 'PurchaseOrders', 'PurchaseOrderID');
}

function xeroGetPurchaseOrder(tenantId, purchaseOrderId, ctx) {
  assertUuid_(purchaseOrderId, 'PurchaseOrderID');
  return xeroFirst_(xeroTool_('XERO_GET_PURCHASE_ORDER', tenantId, { purchase_order_id: purchaseOrderId }, ctx), 'PurchaseOrders', 'PurchaseOrderID');
}

/** query: { Status, DateFrom, DateTo, page, order, 'If-Modified-Since' } */
function xeroListPurchaseOrders(tenantId, query, ctx) {
  return xeroList_(xeroTool_('XERO_LIST_PURCHASE_ORDERS', tenantId, query || {}, ctx), 'PurchaseOrders');
}

// --- Bills (ACCPAY invoices) ------------------------------------------------------------------

/** Type is forced to ACCPAY: PO Desk only ever creates supplier bills, never sales invoices. */
function xeroCreateBill(tenantId, bill, ctx) {
  const args = Object.assign({}, bill || {}, { Type: 'ACCPAY' });
  // Xero would UPDATE an existing invoice whose number matches, so never send one.
  delete args.InvoiceNumber;
  return xeroFirst_(xeroTool_('XERO_CREATE_INVOICE', tenantId, args, ctx), 'Invoices', 'InvoiceID');
}

/** patch: fields of one Invoices[] item (Status, LineAmountTypes, LineItems, Reference…). */
function xeroUpdateInvoice(tenantId, invoiceId, patch, ctx) {
  assertUuid_(invoiceId, 'InvoiceID');
  const body = xeroTool_('XERO_POST_INVOICE_UPDATE', tenantId, { InvoiceID: invoiceId, Invoices: [patch || {}] }, ctx);
  return xeroFirst_(body, 'Invoices', 'InvoiceID');
}

function xeroGetInvoice(tenantId, invoiceId, ctx) {
  assertUuid_(invoiceId, 'InvoiceID');
  return xeroFirst_(xeroTool_('XERO_GET_INVOICE', tenantId, { invoice_id: invoiceId }, ctx), 'Invoices', 'InvoiceID');
}

/** query: { where, Statuses, ContactIDs, InvoiceIDs, page, order }. Note this tool's tenant key is `tenantId`. */
function xeroListInvoices(tenantId, query, ctx) {
  return xeroList_(xeroTool_('XERO_LIST_INVOICES', tenantId, query || {}, ctx, 'tenantId'), 'Invoices');
}

// --- Attachments and history ------------------------------------------------------------------

/**
 * Attaches a blob to a PO or bill. route: 'proxy' (default, from Config ATTACHMENT_ROUTE) or 'tool'.
 *  - proxy: one Composio call; bytes go base64 to Xero's Attachments API.
 *  - tool:  Composio file upload (presigned PUT) then XERO_UPLOAD_ATTACHMENT with the s3key.
 */
function xeroUploadAttachment(tenantId, entityType, entityId, blob, opts, ctx) {
  if (ATTACHABLE.indexOf(entityType) === -1) throw new AppError('BAD_REQUEST', 'Attachments are only supported on PurchaseOrders and Invoices.');
  assertUuid_(entityId, 'Record ID');
  const g = assertTenant_(tenantId);
  const route = (opts && opts.route) || String(getConfig('ATTACHMENT_ROUTE', 'proxy'));
  const fileName = String(blob.getName() || 'slip.jpg').replace(/[^\w.\-]+/g, '_');

  if (route === 'tool') {
    const file = composioUploadFile(blob.copyBlob().setName(fileName), 'xero', 'XERO_UPLOAD_ATTACHMENT', Object.assign({}, ctx || {}, { entityId: g.entityId }));
    const body = xeroTool_('XERO_UPLOAD_ATTACHMENT', tenantId, { entity_type: entityType, entity_id: entityId, filename: fileName, file_to_upload: file }, ctx);
    return xeroFirst_(body, 'Attachments', 'AttachmentID');
  }

  const res = xeroProxy_(tenantId, 'PUT', '/' + entityType + '/' + entityId + '/Attachments/' + encodeURIComponent(fileName), {
    binaryBase64: Utilities.base64Encode(blob.getBytes()),
    contentType: blob.getContentType() || 'image/jpeg',
  }, ctx);
  return xeroFirst_(res.data || {}, 'Attachments', 'AttachmentID');
}

function xeroListAttachments(tenantId, entityType, entityId, ctx) {
  if (ATTACHABLE.indexOf(entityType) === -1) throw new AppError('BAD_REQUEST', 'Unsupported record type.');
  assertUuid_(entityId, 'Record ID');
  const res = xeroProxy_(tenantId, 'GET', '/' + entityType + '/' + entityId + '/Attachments', {}, ctx);
  return xeroList_(res.data || {}, 'Attachments');
}

/** Adds a note to the record's History and Notes. Composio has no tool for this, so it uses the proxy. */
function xeroAddHistoryNote(tenantId, entityType, entityId, details, ctx) {
  if (ATTACHABLE.indexOf(entityType) === -1) throw new AppError('BAD_REQUEST', 'Unsupported record type.');
  assertUuid_(entityId, 'Record ID');
  const res = xeroProxy_(tenantId, 'PUT', '/' + entityType + '/' + entityId + '/History', {
    body: { HistoryRecords: [{ Details: truncate_(details, 450) }] },
  }, ctx);
  return xeroFirst_(res.data || {}, 'HistoryRecords', 'Details');
}

// --- Stage 4: one-call PO creation and tenant-safe lookups (proxy) ---------------------------

/**
 * Creates a PO with VAT-inclusive amounts, AttentionTo and its final status in ONE call.
 * The create tool silently drops LineAmountTypes and AttentionTo (Stage 1), so the tool route needs a
 * second update call — 1.2 s more on the buyer's wait, and a window where an AUTHORISED PO sits in
 * Xero with exclusive amounts. Xero's own API takes everything at once through the proxy.
 * po: { ContactID, Date, DeliveryDate, Reference, AttentionTo, Status, LineItems[] }. Returns the PO.
 */
function xeroCreatePurchaseOrderInclusive(tenantId, po, ctx) {
  assertUuid_(po && po.ContactID, 'ContactID');
  if (['DRAFT', 'SUBMITTED', 'AUTHORISED'].indexOf(po.Status) === -1) throw new AppError('BAD_REQUEST', 'Unsupported PO status ' + po.Status + '.');
  const body = {
    PurchaseOrders: [{
      Contact: { ContactID: po.ContactID },
      Date: po.Date,
      DeliveryDate: po.DeliveryDate || po.Date,
      Reference: po.Reference,
      AttentionTo: po.AttentionTo,
      Status: po.Status,
      LineAmountTypes: 'Inclusive',
      LineItems: po.LineItems,
    }],
  };
  const res = xeroProxy_(tenantId, 'PUT', '/PurchaseOrders', { body: body }, ctx);
  const errs = xeroValidationMessages_(res.data);
  const created = xeroFirst_(res.data || {}, 'PurchaseOrders', 'PurchaseOrderID');
  if (errs.length || !created || !created.PurchaseOrderID || !created.PurchaseOrderNumber) {
    throw new AppError('XERO_VALIDATION', errs.join('; ') || 'Xero did not return a PO number.', { upstream: 400 });
  }
  // Backstop: if Xero ever ignores Inclusive, fix it before the number reaches the buyer.
  if (created.LineAmountTypes !== 'Inclusive') {
    const li = (created.LineItems || [])[0] || {};
    const fixed = xeroUpdatePurchaseOrder(tenantId, created.PurchaseOrderID, {
      LineAmountTypes: 'Inclusive',
      LineItems: [Object.assign({ LineItemID: li.LineItemID }, po.LineItems[0])],
    }, ctx);
    return Object.assign({}, created, fixed || {}, { PurchaseOrderNumber: created.PurchaseOrderNumber });
  }
  return created;
}

/** POs dated between two YYYY-MM-DD dates, via the proxy (XERO_LIST_PURCHASE_ORDERS is not yet proven per tenant). */
function xeroListPurchaseOrdersByDate(tenantId, dateFrom, dateTo, ctx) {
  const path = '/PurchaseOrders?DateFrom=' + encodeURIComponent(dateFrom) + '&DateTo=' + encodeURIComponent(dateTo || dateFrom);
  const res = xeroProxy_(tenantId, 'GET', path, {}, ctx);
  return xeroList_(res.data || {}, 'PurchaseOrders');
}

/** Case-insensitive search over names (and other contact fields), archived contacts included. */
function xeroSearchContacts(tenantId, term, ctx) {
  const q = String(term || '').trim();
  if (!q) return [];
  const res = xeroProxy_(tenantId, 'GET', '/Contacts?includeArchived=true&page=1&pageSize=100&searchTerm=' + encodeURIComponent(q), {}, ctx);
  return xeroList_(res.data || {}, 'Contacts');
}
