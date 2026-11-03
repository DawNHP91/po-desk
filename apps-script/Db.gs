/**
 * Db.gs — the "PO Desk DB" Google Sheet as a set of tables (one tab per table, row 1 = headers).
 */

// Single source of truth for the data model in CLAUDE.md. setupSheets() builds tabs from this.
const TABLES = Object.freeze({
  Config: ['key', 'value'],
  Entities: ['entity_id', 'legal_name', 'short_name', 'xero_tenant_id', 'drive_folder_id', 'brand_key', 'active'],
  Users: ['user_id', 'name', 'email', 'pin_hash', 'pin_salt', 'role', 'active', 'failed_attempts', 'locked_until', 'pin_token_hash', 'pin_token_expires', 'created_by', 'created_at'],
  UserEntities: ['user_id', 'entity_id', 'can_buy', 'can_approve', 'po_limit_zar'],
  PaymentMethods: ['pm_id', 'entity_id', 'type', 'label', 'last4', 'holder_name', 'holder_user_id', 'xero_bank_account_id', 'xero_bank_account_name', 'active'],
  Categories: ['category_id', 'entity_id', 'name', 'account_code', 'tax_type', 'keywords', 'sort', 'active'],
  Accounts: ['entity_id', 'account_id', 'code', 'name', 'type', 'class', 'tax_type', 'status', 'synced_at'],
  TaxRates: ['entity_id', 'tax_type', 'name', 'rate', 'status', 'synced_at'],
  Suppliers: ['entity_id', 'contact_id', 'name', 'vat_number', 'synced_at'],
  SupplierHistory: ['entity_id', 'contact_id', 'account_code', 'uses', 'last_used'],
  POs: ['po_id', 'idem_key', 'entity_id', 'xero_po_id', 'po_number', 'provisional_ref', 'status', 'buyer_user_id', 'pm_id', 'contact_id', 'supplier_name', 'description', 'category_id', 'account_code', 'tax_type', 'amount_incl_zar', 'suggestion_source', 'created_at', 'approver_user_id', 'decided_at', 'bill_id'],
  Bills: ['bill_id', 'po_id', 'entity_id', 'xero_invoice_id', 'slip_number', 'slip_date', 'supplier_vat_no', 'total_incl_zar', 'vat_zar', 'drive_file_id', 'ocr_json', 'flags', 'created_by', 'created_at'],
  Queue: ['job_id', 'type', 'payload_json', 'attempts', 'next_run_at', 'last_error'],
  AuditLog: ['ts', 'user_id', 'entity_id', 'action', 'ref', 'ok', 'detail_json'],
});

// Per-execution cache so each tab is read at most once per request.
const dbCache_ = { ss: null, tables: {} };

function db_() {
  if (!dbCache_.ss) dbCache_.ss = SpreadsheetApp.openById(getSecret_('SHEET_ID'));
  return dbCache_.ss;
}

function sheet_(name) {
  const sh = db_().getSheetByName(name);
  if (!sh) throw new AppError('DB_MISSING_TAB', 'Sheet tab "' + name + '" is missing. Run setupSheets().');
  return sh;
}

/** Returns { name, headers, rows }. Each row is a plain object with a hidden _row (1-based sheet row). */
function readTable(name) {
  if (dbCache_.tables[name]) return dbCache_.tables[name];
  const values = sheet_(name).getDataRange().getValues();
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(c => c === '' || c === null)) continue;
    const o = {};
    headers.forEach((h, j) => { if (h) o[h] = r[j]; });
    Object.defineProperty(o, '_row', { value: i + 1, enumerable: false, writable: true });
    rows.push(o);
  }
  const table = { name: name, headers: headers, rows: rows };
  dbCache_.tables[name] = table;
  return table;
}

function invalidateTable_(name) {
  delete dbCache_.tables[name];
}

// setValues turns a leading "=" into a formula; supplier names and OCR text come from outside,
// so neutralise anything that a spreadsheet would execute or reinterpret.
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

/** Appends one row. Uses the live header row so column order in the Sheet is respected. */
function appendRow(name, obj) {
  const sh = sheet_(name);
  const headers = dbCache_.tables[name] ? dbCache_.tables[name].headers : sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  // appendRow (not getLastRow + setValues) because it is atomic against concurrent writers.
  sh.appendRow(headers.map(h => cell_(obj[h])));
  invalidateTable_(name);
  return obj;
}

/** Merges `patch` into the first row where row[idField] == id and writes the whole row back. */
function updateRowById(name, idField, id, patch) {
  const table = readTable(name);
  const row = table.rows.find(r => String(r[idField]) === String(id));
  if (!row) return null;
  Object.keys(patch).forEach(k => { if (table.headers.indexOf(k) !== -1) row[k] = patch[k]; });
  sheet_(name).getRange(row._row, 1, 1, table.headers.length).setValues([table.headers.map(h => cell_(row[h]))]);
  return row;
}

function findBy(name, field, value) {
  return readTable(name).rows.filter(r => String(r[field]) === String(value));
}

/** Audit writes must never break the action being audited. */
function auditLog(entry) {
  const row = {
    ts: new Date(),
    user_id: entry.userId || '',
    entity_id: entry.entityId || '',
    action: entry.action || '',
    ref: entry.ref || '',
    ok: entry.ok === true,
    detail_json: JSON.stringify(entry.detail || {}),
  };
  try {
    if (!getOptionalSecret_('SHEET_ID')) throw new Error('SHEET_ID not set');
    // Bypass appendRow's header lookup: AuditLog's columns are fixed and it is written on every call.
    sheet_('AuditLog').appendRow(TABLES.AuditLog.map(h => cell_(row[h])));
  } catch (err) {
    console.log('AUDIT (sheet unavailable: ' + err.message + ') ' + JSON.stringify(row));
  }
}
