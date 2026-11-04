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
  if (auditBuffer_.on) { auditBuffer_.rows.push(row); return; }
  try {
    if (!getOptionalSecret_('SHEET_ID')) throw new Error('SHEET_ID not set');
    // Bypass appendRow's header lookup: AuditLog's columns are fixed and it is written on every call.
    sheet_('AuditLog').appendRow(TABLES.AuditLog.map(h => cell_(row[h])));
  } catch (err) {
    console.log('AUDIT (sheet unavailable: ' + err.message + ') ' + JSON.stringify(row));
  }
}

// --- Fast path: Sheets REST API (Stage 4 performance) ----------------------------------------
// The PO hot path needs ~8 tabs. SpreadsheetApp reads them one round trip at a time (~250 ms each;
// measured 4 Nov 2026: 1.1 s before the session was even checked). The Sheets API reads any number
// of tabs in one call and lets independent writes run in parallel (UrlFetchApp.fetchAll).
// Any failure switches this execution back to SpreadsheetApp, so the app never depends on it.

const DATE_COLUMNS = Object.freeze(['locked_until', 'pin_token_expires', 'created_at', 'synced_at', 'last_used', 'decided_at', 'next_run_at', 'ts', 'slip_date']);
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';

/** Runs Sheets REST requests in parallel. req: { method, path, payload }. Returns parsed bodies; throws on any error. */
function sheetsFetch_(reqs) {
  const token = ScriptApp.getOAuthToken();
  const base = SHEETS_API + encodeURIComponent(getSecret_('SHEET_ID'));
  const out = UrlFetchApp.fetchAll(reqs.map(r => ({
    url: base + r.path,
    method: r.method || 'get',
    contentType: 'application/json',
    payload: r.payload ? JSON.stringify(r.payload) : undefined,
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  })));
  return out.map((res, i) => {
    const code = res.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('Sheets API ' + code + ' on ' + reqs[i].path.split('?')[0] + ': ' + truncate_(res.getContentText(), 200));
    return JSON.parse(res.getContentText() || '{}');
  });
}

/** The spreadsheet's timezone offset, so serial date numbers become the same instants getValues() gives. */
function sheetTzOffsetMs_() {
  if (dbCache_.tzOffsetMs !== undefined) return dbCache_.tzOffsetMs;
  const props = PropertiesService.getScriptProperties();
  let tz = props.getProperty('SHEET_TZ');
  if (!tz) { tz = db_().getSpreadsheetTimeZone(); props.setProperty('SHEET_TZ', tz); }
  const z = Utilities.formatDate(new Date(), tz, 'Z');            // e.g. +0200
  const sign = z.charAt(0) === '-' ? -1 : 1;
  dbCache_.tz = tz;
  dbCache_.tzOffsetMs = sign * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))) * 60000;
  return dbCache_.tzOffsetMs;
}

/**
 * Loads tabs into the per-execution cache in one API call. fresh: re-read even if cached (inside a
 * lock, before a write). Returns false if the fast path is unavailable (callers fall back silently).
 */
function fastRead_(names, fresh) {
  const want = fresh ? names.slice() : names.filter(n => !dbCache_.tables[n]);
  if (!want.length) return true;
  if (dbCache_.fastOff) return false;
  try {
    const offset = sheetTzOffsetMs_();
    const qs = want.map(n => 'ranges=' + encodeURIComponent("'" + n + "'")).join('&') +
      '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';
    const res = sheetsFetch_([{ path: '/values:batchGet?' + qs }])[0];
    (res.valueRanges || []).forEach((vr, i) => { dbCache_.tables[want[i]] = tableFromValues_(want[i], vr.values || [], offset); });
    return true;
  } catch (err) {
    dbCache_.fastOff = true;
    console.warn('Fast read unavailable, using SpreadsheetApp: ' + err.message);
    return false;
  }
}

/** Same shape as readTable(): rows are objects with a hidden 1-based _row; dates become Date objects. */
function tableFromValues_(name, values, offsetMs) {
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    if (!r.some(c => c !== '' && c !== null && c !== undefined)) continue;
    const o = {};
    headers.forEach((h, j) => {
      if (!h) return;
      let v = r[j];
      if (v === undefined || v === null) v = '';
      if (typeof v === 'number' && DATE_COLUMNS.indexOf(h) !== -1) v = new Date(Math.round((v - 25569) * 86400000) - offsetMs);
      o[h] = v;
    });
    Object.defineProperty(o, '_row', { value: i + 1, enumerable: false, writable: true });
    rows.push(o);
  }
  return { name: name, headers: headers, rows: rows };
}

/**
 * Converts a value for a USER_ENTERED write. Every string gets a leading apostrophe so Sheets keeps
 * it as text: never a formula, and never "1/2" turned into a date. Dates are written as local
 * date-times so the cell is a real date, as with setValues.
 */
function userEntered_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) { sheetTzOffsetMs_(); return Utilities.formatDate(v, dbCache_.tz, 'yyyy-MM-dd HH:mm:ss'); }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') return "'" + JSON.stringify(v);
  return v === '' ? '' : "'" + String(v);
}

function headersOf_(name) {
  return dbCache_.tables[name] ? dbCache_.tables[name].headers : TABLES[name];
}

/** Request to append whole rows (atomic, grows the sheet as needed). */
function appendReq_(name, objs) {
  const h = headersOf_(name);
  return { method: 'post', path: '/values/' + encodeURIComponent("'" + name + "'!A1") + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    payload: { values: objs.map(o => h.map(k => userEntered_(o[k]))) } };
}

/** Request to overwrite one whole row in place. */
function updateReq_(name, rowNum, obj) {
  const h = headersOf_(name);
  return { method: 'put', path: '/values/' + encodeURIComponent("'" + name + "'!A" + rowNum) + '?valueInputOption=USER_ENTERED',
    payload: { values: [h.map(k => userEntered_(obj[k]))] } };
}

// --- Buffered audit (one write per request instead of one per event) -------------------------

const auditBuffer_ = { on: false, rows: [] };

function startAuditBuffer_() { auditBuffer_.on = true; auditBuffer_.rows = []; }

/** Writes buffered audit rows in one append; falls back to row-by-row writes. Never throws. */
function flushAudit_() {
  const rows = auditBuffer_.rows;
  auditBuffer_.on = false;
  auditBuffer_.rows = [];
  if (!rows.length) return;
  try {
    if (dbCache_.fastOff) throw new Error('fast path off');
    sheetsFetch_([appendReq_('AuditLog', rows)]);
  } catch (err) {
    rows.forEach(r => { try { sheet_('AuditLog').appendRow(TABLES.AuditLog.map(h => cell_(r[h]))); } catch (e) { console.log('AUDIT ' + JSON.stringify(r)); } });
  }
}
