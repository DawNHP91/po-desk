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
function xeroTool_(toolSlug, tenantId, args, ctx, tenantParam) {
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

/** query: any XERO_GET_CONTACTS argument (where, searchTerm, ContactID, page, pageSize, includeArchived…). */
function xeroGetContacts(tenantId, query, ctx) {
  return xeroList_(xeroTool_('XERO_GET_CONTACTS', tenantId, query || {}, ctx), 'Contacts');
}

function xeroCreateContact(tenantId, fields, ctx) {
  if (!fields || !String(fields.Name || '').trim()) throw new AppError('BAD_REQUEST', 'A supplier name is required.');
  const body = xeroTool_('XERO_CREATE_CONTACT', tenantId, Object.assign({ IsSupplier: true }, fields), ctx);
  return xeroFirst_(body, 'Contacts', 'ContactID');
}

// XERO_GET_CONTACTS never returns ARCHIVED contacts: it ignores includeArchived and 404s on an
// archived ContactID (seen 3 Nov 2026). Xero's own API does return them, so lookups that must see
// archived contacts (e.g. before creating a "new" supplier whose name Xero already holds) use the proxy.

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
  return xeroList_(res.data || {}, 'Contacts');
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
