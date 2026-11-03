/**
 * Config.gs — static facts, secrets (Script Properties) and editable settings (Config tab).
 */

const APP = Object.freeze({
  VERSION: '0.1.0-stage1',
  TZ: 'Africa/Johannesburg',
});

// The tenant allowlist lives in code, not in the Sheet: it is the last line of defence against
// posting a purchase into the wrong company's books, so nobody should be able to edit it by
// typing into a cell. Changing it is a code change that goes through git.
const ENTITY_SEED = Object.freeze([
  Object.freeze({ entity_id: 'HPB', legal_name: 'HP Biotech Group (Pty) Ltd', short_name: 'HP Biotech', xero_tenant_id: '3b167b1c-1023-4463-a02b-46f44b56fb4a', brand_key: 'HPB' }),
  Object.freeze({ entity_id: 'NHP', legal_name: 'NHP GLOBAL SA (PTY) LTD', short_name: 'NHP Global', xero_tenant_id: '910e6495-b557-4d16-ad76-e0190cd60546', brand_key: 'NHP' }),
  Object.freeze({ entity_id: 'PK', legal_name: 'Pharma Karu', short_name: 'Pharma Karu', xero_tenant_id: '7f209224-7389-441c-ab85-e52a8a393601', brand_key: 'PK' }),
]);

// Nandrea Health Products shares the Composio connection but is out of scope.
const BLOCKED_TENANTS = Object.freeze(['e775d9d3-4807-4163-9941-029493fa272b']);

// Settings the business may tune without a deploy. Seeded once; later edits in the Sheet win.
const CONFIG_DEFAULTS = Object.freeze({
  VARIANCE_PCT: 10,
  VARIANCE_ZAR: 500,
  SUPPLIER_HISTORY_N: 5,
  VAT_FULL_INVOICE_ZAR: 5000,
  GEMINI_MODEL: 'gemini-2.5-flash',
  // Same codes in all three SA orgs (inspectCharts, 3 Nov 2026). Plain INPUT is the OLD 14% rate
  // and is DELETED in NHP, so never rely on an account's default tax type. Confirm with the accountant.
  PURCHASE_TAX_TYPE: 'INPUT3',
  NO_VAT_TAX_TYPE: 'NONE',
  APP_VERSION: APP.VERSION,
  // 'proxy' = Xero Attachments API through Composio's proxy; 'tool' = Composio file upload + XERO_UPLOAD_ATTACHMENT.
  ATTACHMENT_ROUTE: 'proxy',
});

class AppError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }
}

function entityById_(entityId) {
  const id = String(entityId || '').trim().toUpperCase();
  const ent = ENTITY_SEED.find(e => e.entity_id === id);
  if (!ent) throw new AppError('ENTITY_UNKNOWN', 'Unknown company: ' + entityId);
  return ent;
}

function entityByTenant_(tenantId) {
  const t = String(tenantId || '').trim().toLowerCase();
  return ENTITY_SEED.find(e => e.xero_tenant_id === t) || null;
}

function isBlockedTenant_(tenantId) {
  return BLOCKED_TENANTS.indexOf(String(tenantId || '').trim().toLowerCase()) !== -1;
}

/** Secrets: the error names the missing property but never echoes a value. */
function getSecret_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new AppError('CONFIG_MISSING', 'Script Property ' + name + ' is not set.');
  return v;
}

function getOptionalSecret_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

let configCache_ = null;

/** Reads the Config tab once per execution; falls back to CONFIG_DEFAULTS, then to `fallback`. */
function getConfig(key, fallback) {
  if (!configCache_) {
    configCache_ = {};
    try {
      readTable('Config').rows.forEach(r => {
        if (r.key !== '' && r.key !== null) configCache_[String(r.key)] = r.value;
      });
    } catch (err) {
      // Before setupSheets has run there is no Config tab; defaults keep the script usable.
      console.warn('Config tab unavailable: ' + err.message);
    }
  }
  if (Object.prototype.hasOwnProperty.call(configCache_, key) && configCache_[key] !== '') return configCache_[key];
  if (Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) return CONFIG_DEFAULTS[key];
  return fallback;
}

function setConfig(key, value) {
  const existing = findBy('Config', 'key', key)[0];
  if (existing) updateRowById('Config', 'key', key, { value: value });
  else appendRow('Config', { key: key, value: value });
  configCache_ = null;
}

function todayYmd_() {
  return Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
}
