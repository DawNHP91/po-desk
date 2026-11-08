/**
 * Setup.gs — one-off bootstrap, run from the Apps Script editor. Every function is safe to run twice:
 * it only creates what is missing and never overwrites values someone has edited.
 */

const TEXT_COLUMNS = Object.freeze(['last4', 'account_code', 'code', 'po_number', 'provisional_ref', 'slip_number', 'supplier_vat_no', 'vat_number', 'tax_type']);

/** Creates "PO Desk DB" (if SHEET_ID is not set), every tab with headers, Config defaults and Entities rows. */
function setupSheets() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  if (props.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  } else {
    ss = SpreadsheetApp.create('PO Desk DB');
    props.setProperty('SHEET_ID', ss.getId());
    console.log('Created spreadsheet "PO Desk DB": ' + ss.getUrl());
  }
  dbCache_.ss = ss;

  const report = { created: [], columnsAdded: {}, extraColumns: {} };
  Object.keys(TABLES).forEach(name => {
    const want = TABLES[name];
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      report.created.push(name);
    }
    const lastCol = sh.getLastColumn();
    const have = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim()) : [];
    // Never reorder or delete columns: rows may already hold data. Only append what is missing.
    const missing = want.filter(h => have.indexOf(h) === -1);
    if (missing.length) {
      const startCol = have.filter(h => h !== '').length + 1;
      sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
      if (have.length) report.columnsAdded[name] = missing;
    }
    const extra = have.filter(h => h && want.indexOf(h) === -1);
    if (extra.length) report.extraColumns[name] = extra;
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
    // Sheets would turn "0123" into 123 and drop the leading zero of card digits, codes and numbers.
    const headersNow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    headersNow.forEach((h, i) => {
      if (TEXT_COLUMNS.indexOf(h) !== -1) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
    invalidateTable_(name);
  });

  // A new spreadsheet comes with an empty "Sheet1" that is not a table.
  const stray = ss.getSheetByName('Sheet1');
  if (stray && !TABLES.Sheet1 && stray.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(stray);

  const configAdded = [];
  const haveKeys = readTable('Config').rows.map(r => String(r.key));
  Object.keys(CONFIG_DEFAULTS).forEach(k => {
    if (haveKeys.indexOf(k) === -1) { appendRow('Config', { key: k, value: CONFIG_DEFAULTS[k] }); configAdded.push(k); }
  });
  // APP_VERSION tracks the deployed code, so it is the one key setup keeps current.
  updateRowById('Config', 'key', 'APP_VERSION', { value: APP.VERSION });
  // Retired model still at its old default (never customised): move it to the current default.
  const gm = findBy('Config', 'key', 'GEMINI_MODEL')[0];
  if (gm && String(gm.value) === 'gemini-2.5-flash') { updateRowById('Config', 'key', 'GEMINI_MODEL', { value: CONFIG_DEFAULTS.GEMINI_MODEL }); configAdded.push('GEMINI_MODEL -> ' + CONFIG_DEFAULTS.GEMINI_MODEL); }

  const entitiesAdded = [];
  ENTITY_SEED.forEach(e => {
    if (!findBy('Entities', 'entity_id', e.entity_id).length) {
      appendRow('Entities', Object.assign({}, e, { drive_folder_id: '', active: true }));
      entitiesAdded.push(e.entity_id);
    }
  });

  console.log('setupSheets done. ' + JSON.stringify({
    sheet: ss.getUrl(),
    tabsCreated: report.created,
    columnsAdded: report.columnsAdded,
    extraColumns: report.extraColumns,
    configAdded: configAdded,
    entitiesAdded: entitiesAdded,
  }, null, 2));
}

/** Creates My Drive/PO Desk/{HPB,NHP,PK}, stores their IDs in Entities and moves the DB into PO Desk. */
function setupDrive() {
  const props = PropertiesService.getScriptProperties();
  let root = null;
  const rootId = props.getProperty('DRIVE_ROOT_ID');
  if (rootId) {
    root = DriveApp.getFolderById(rootId);
  } else {
    // Only look in My Drive's top level, so a shared folder someone else named "PO Desk" is never adopted.
    const it = DriveApp.getRootFolder().getFoldersByName('PO Desk');
    root = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder('PO Desk');
    props.setProperty('DRIVE_ROOT_ID', root.getId());
  }

  const result = { root: root.getUrl(), folders: {} };
  ENTITY_SEED.forEach(e => {
    const it = root.getFoldersByName(e.entity_id);
    const folder = it.hasNext() ? it.next() : root.createFolder(e.entity_id);
    const row = findBy('Entities', 'entity_id', e.entity_id)[0];
    if (!row) throw new AppError('SETUP_ORDER', 'Entities row ' + e.entity_id + ' is missing. Run setupSheets() first.');
    if (String(row.drive_folder_id) !== folder.getId()) updateRowById('Entities', 'entity_id', e.entity_id, { drive_folder_id: folder.getId() });
    result.folders[e.entity_id] = folder.getId();
  });

  const sheetId = props.getProperty('SHEET_ID');
  if (sheetId) {
    const file = DriveApp.getFileById(sheetId);
    const parents = file.getParents();
    let inRoot = false;
    while (parents.hasNext()) if (parents.next().getId() === root.getId()) inRoot = true;
    if (!inRoot) file.moveTo(root);
  }

  console.log('setupDrive done. ' + JSON.stringify(result, null, 2));
}

// Each card is a cheque (debit) card that clears straight to its company's cheque account.
// Matched by AccountID only: bank account names differ per company and can be renamed in Xero.
const PAYMENT_METHOD_SEED = Object.freeze([
  { entity_id: 'NHP', type: 'CARD', label: 'Cheque card', last4: '9514', holder_name: 'DP Groenewald', xero_bank_account_name: 'FNB CURRENT (…4274)', xero_bank_account_id: 'b97af25a-95f9-46e3-87ba-975bebc6e34f' },
  { entity_id: 'PK', type: 'CARD', label: 'Cheque card', last4: '9581', holder_name: 'DP Groenewald', xero_bank_account_name: 'Pharma Karu Cheque', xero_bank_account_id: '3c6891b1-5d7f-49cb-9100-ce0d46ad7f11' },
  { entity_id: 'HPB', type: 'CARD', label: 'Cheque card', last4: '6358', holder_name: 'RG Duncan', xero_bank_account_name: 'HP Biotech Cheque', xero_bank_account_id: '5052e5c9-0411-4f1c-a509-62a0a802e833' },
  { entity_id: 'NHP', type: 'CASH', label: 'Petty cash', last4: '', holder_name: 'custodian TBC', xero_bank_account_name: 'Petty Cash', xero_bank_account_id: '618f8bfe-9d39-4572-a38f-3637884ebb45' },
  { entity_id: 'PK', type: 'CASH', label: 'Petty cash', last4: '', holder_name: 'custodian TBC', xero_bank_account_name: 'Pharma Karu Petty Cash', xero_bank_account_id: '4016c0c3-7f48-45f0-b0e1-7ff3e3c4524e' },
  { entity_id: 'HPB', type: 'CASH', label: 'Petty cash', last4: '', holder_name: 'custodian TBC', xero_bank_account_name: 'HP Biotech Petty Cash', xero_bank_account_id: 'fc8f7e76-94bd-4871-9076-a53bc4ae8ef7' },
]);

function paymentMethodKey_(r) {
  return [r.entity_id, r.type, r.label, String(r.last4 || '')].join('|');
}

/** Upserts the seed cards and cash floats. Existing rows keep their pm_id and any values edited in the Sheet. */
function seedPaymentMethods() {
  const existing = readTable('PaymentMethods').rows;
  const added = [];
  const filled = [];
  PAYMENT_METHOD_SEED.forEach(seed => {
    const row = existing.find(r => paymentMethodKey_(r) === paymentMethodKey_(seed));
    if (!row) {
      appendRow('PaymentMethods', Object.assign({ pm_id: Utilities.getUuid(), holder_user_id: '', active: true }, seed));
      added.push(paymentMethodKey_(seed));
    } else if (!row.xero_bank_account_id && seed.xero_bank_account_id) {
      updateRowById('PaymentMethods', 'pm_id', row.pm_id, { xero_bank_account_id: seed.xero_bank_account_id, xero_bank_account_name: seed.xero_bank_account_name });
      filled.push(paymentMethodKey_(seed));
    } else if (row.xero_bank_account_id && String(row.xero_bank_account_id) !== seed.xero_bank_account_id) {
      // Never silently overwrite: a different ID in the Sheet may be a deliberate edit.
      console.warn('seedPaymentMethods: ' + paymentMethodKey_(seed) + ' has ' + row.xero_bank_account_id + ' in the Sheet but the seed says ' + seed.xero_bank_account_id + '. Left unchanged.');
    }
  });
  console.log('seedPaymentMethods: added ' + added.length + (added.length ? ' ' + JSON.stringify(added) : '') + '; filled ' + filled.length);
  return { added: added, filled: filled };
}

// --- Stage 2: nightly sync trigger ------------------------------------------------------------

/** Installs exactly one daily syncAll trigger at 02:00 SAST. Safe to run twice: old ones are removed first. */
// --- Scheduled jobs (Stage 7) -------------------------------------------------------------------

const TRIGGERS = Object.freeze([
  { fn: 'nightlySync', what: 'Xero sync, daily 02:00', make: (b) => b.timeBased().atHour(2).everyDays(1).inTimezone(APP.TZ) },
  { fn: 'processQueue', what: 'retry queue and approval reminders, every 5 minutes', make: (b) => b.timeBased().everyMinutes(5) },
  { fn: 'dailyDigest', what: 'admin digest, daily 08:00', make: (b) => b.timeBased().atHour(8).everyDays(1).inTimezone(APP.TZ) },
]);
// Handlers earlier stages installed directly, replaced by the guarded ones above.
const LEGACY_TRIGGER_FNS = Object.freeze(['syncAll']);

/**
 * Installs exactly one trigger per job, removing any copies first. Safe to run any number of times;
 * the jobs themselves also cope with a duplicate trigger (nightlySync and dailyDigest run once a day,
 * processQueue leases its work under the lock).
 */
function installTriggers() {
  const names = TRIGGERS.map(t => t.fn).concat(LEGACY_TRIGGER_FNS);
  const old = ScriptApp.getProjectTriggers().filter(t => names.indexOf(t.getHandlerFunction()) !== -1);
  old.forEach(t => ScriptApp.deleteTrigger(t));
  TRIGGERS.forEach(t => t.make(ScriptApp.newTrigger(t.fn)).create());
  const now = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  console.log('installTriggers: removed ' + old.length + ' old trigger(s). Now:\n' +
    TRIGGERS.map(t => '  ' + t.fn + ' x' + now.filter(n => n === t.fn).length + ' — ' + t.what).join('\n'));
}

/** Earlier stages' names, kept so old instructions still work. */
function installSyncTrigger() { installTriggers(); }

// --- Stage 2: proposed categories -------------------------------------------------------------
// All three charts share one template (checked 3 Nov 2026), so one proposal fits all; codes are
// still validated per company against the synced chart before anything is written.
// Keywords are whole words or phrases; longer matches win, so put specific phrases where needed.
const CATEGORY_PROPOSALS = Object.freeze([
  { sort: 10, name: 'Fuel', code: '433', keywords: 'fuel, petrol, diesel, unleaded, engine oil, motor oil, engen, shell, sasol, bp, caltex, astron, totalenergies' },
  { sort: 20, name: 'Vehicle repairs and tyres', code: '432', keywords: 'tyre, tyres, puncture, wheel alignment, car service, car battery, wiper, wipers, car wash, brake pads, exhaust' },
  { sort: 30, name: 'Lab consumables', code: '312', keywords: 'lab, laboratory, reagent, reagents, pipette, pipettes, pipette tips, petri, swab, swabs, test kit, test strips, beaker, agar, culture media, ph strips' },
  { sort: 40, name: 'Raw materials', code: '313', keywords: 'raw material, raw materials, ingredient, ingredients, bulk powder', note: 'HPB and PK also have 318 Plant Raw Materials (defaults to old 14% VAT).' },
  { sort: 50, name: 'Packaging', code: '311', keywords: 'packaging, carton, cartons, box, boxes, bottle, bottles, jar, jars, lids, caps, sachet, sachets, bubble wrap, packing tape, shrink wrap, pallet wrap' },
  { sort: 60, name: 'Labels', code: '310', keywords: 'label, labels, sticker, stickers, barcode, barcodes, label roll' },
  // Premises and office cleaning. Soap used in production equipment is a factory consumable (below);
  // keyword scoring prefers the longer phrase, so "machine soap" beats "soap".
  { sort: 70, name: 'Cleaning', code: '404', keywords: 'cleaning, detergent, bleach, jik, sanitiser, sanitizer, disinfectant, hand soap, soap, mop, broom, handy andy, dishwashing, toilet paper, refuse bags, bin bags' },
  { sort: 80, name: 'Protective clothing (PPE)', code: '421', keywords: 'ppe, overalls, safety boots, gumboots, goggles, lab coat, apron, hard hat, face shield' },
  // 306 is a direct cost (cost of sales): things used up in production (decided 8 Nov 2026).
  { sort: 85, name: 'Factory consumables', code: '306', keywords: 'gloves, nitrile gloves, disposable gloves, hairnet, hairnets, shoe covers, beard covers, face mask, face masks, masks, machine soap, equipment soap, cip detergent' },
  { sort: 90, name: 'Repairs: building', code: '422', keywords: 'plumber, plumbing, paint, cement, light bulb, globe, globes, tap, padlock, lock, door handle, hardware, builders, silicone' },
  { sort: 100, name: 'Repairs: machinery', code: '423', keywords: 'bearing, bearings, v-belt, drive belt, motor, pump, spares, spare parts, welding, gasket, o-ring, seal, fittings, grease' },
  // 306 Consumables - Factory is a direct cost (cost of sales) for things used up in production, so
  // tools go to machinery repairs instead (decided 8 Nov 2026).
  { sort: 110, name: 'Small tools', code: '423', keywords: 'tool, tools, screwdriver, spanner, drill bit, drill bits, hammer, pliers, tape measure, extension cord, multiplug, cable ties', note: 'No tools account in the chart: mapped to 423 Repairs & Maintenance - Machinery.' },
  { sort: 120, name: 'Staff refreshments', code: '426', keywords: 'coffee, tea, milk, sugar, creamer, biscuits, refreshments, snacks, bottled water, lunch, cake' },
  { sort: 130, name: 'Courier and postage', code: '303', keywords: 'courier, postage, post office, pargo, paxi, aramex, courier guy, dhl, fedex, postnet' },
  { sort: 140, name: 'Office supplies and stationery', code: '420', keywords: 'stationery, a4 paper, paper, pen, pens, printer ink, ink, toner, cartridge, stapler, envelopes, files, printing, notebook' },
]);

/**
 * Writes the proposals to Categories with active = FALSE (one row per company and name; existing rows
 * are never touched, so your corrections survive a re-run) and prints the mapping for review.
 * Run syncAll() first: codes are checked against the synced Accounts tab.
 */
function proposeCategories() { proposeCategories_(false); }

/**
 * Like proposeCategories, but also brings rows that are NOT switched on yet in line with the current
 * proposals (account code, keywords, order). Switched-on rows are the accountant's: never touched.
 */
function updateCategoryProposals() { proposeCategories_(true); }

function proposeCategories_(updateInactive) {
  const purchase = ['EXPENSE', 'DIRECTCOSTS', 'OVERHEADS'];
  const accounts = readTable('Accounts').rows;
  const existing = readTable('Categories').rows;
  const report = {};
  ENTITY_SEED.forEach(e => {
    const chart = {};
    accounts.filter(a => a.entity_id === e.entity_id).forEach(a => { chart[String(a.code)] = a; });
    if (!Object.keys(chart).length) throw new AppError('SETUP_ORDER', 'No synced accounts for ' + e.entity_id + '. Run syncAll() first.');
    report[e.entity_id] = CATEGORY_PROPOSALS.map(p => {
      const acct = chart[p.code];
      const ok = acct && acct.status === 'ACTIVE' && acct.class === 'EXPENSE' && purchase.indexOf(acct.type) !== -1;
      const already = existing.find(c => c.entity_id === e.entity_id && String(c.name).toLowerCase() === p.name.toLowerCase());
      let updated = '';
      if (already && updateInactive && !isTrue_(already.active)) {
        const want = { account_code: ok ? p.code : '', keywords: p.keywords, sort: p.sort };
        const diff = Object.keys(want).filter(k => String(already[k]) !== String(want[k]));
        if (diff.length) { updateRowById('Categories', 'category_id', already.category_id, want); updated = 'updated ' + diff.join(', '); }
      }
      if (!already) {
        appendRow('Categories', {
          category_id: Utilities.getUuid(), entity_id: e.entity_id, name: p.name,
          account_code: ok ? p.code : '', tax_type: getConfig('PURCHASE_TAX_TYPE', 'INPUT3'),
          keywords: p.keywords, sort: p.sort, active: false,
        });
      }
      return {
        sort: p.sort, category: p.name, code: ok ? p.code : '(none)', account: acct ? acct.name : 'NOT IN CHART',
        type: acct ? acct.type : '-', defaultTax: acct ? acct.tax_type : '-',
        row: updated || (already ? 'kept existing (' + (already.account_code || 'blank') + ', active=' + already.active + ')' : 'added, inactive'),
        note: (ok ? '' : 'CODE ' + p.code + ' NOT A VALID PURCHASE ACCOUNT HERE. ') + (p.note || ''),
      };
    });
  });
  Object.keys(report).forEach(ent => out_('Proposed categories: ' + ent, table_(report[ent], ['sort', 'category', 'code', 'account', 'type', 'defaultTax', 'row', 'note'])));
  console.log('Review the Categories tab, correct any account_code, then set active = TRUE on the ones you want.');
}

// --- Stage 3: users ---------------------------------------------------------------------------
// Bootstrap only. Everyone except the first admin is added on the People screen (Stage 7), and
// PINs are always chosen by the person themselves; nothing here prints or stores a PIN in a file.

const ADMIN_SEED = Object.freeze({ name: 'Dawid Groenewald', email: 'dawie@nhpglobalgroup.com', role: 'admin', entities: ['HPB', 'NHP', 'PK'] });
// po_limit_zar per company, confirmed by Dawie on 4 Nov 2026 (CLAUDE.md: ask before seeding).
const ADMIN_PO_LIMIT_ZAR = Object.freeze({ HPB: 1500, NHP: 1500, PK: 1500 });

const TEST_BUYER = Object.freeze({ name: 'Test Buyer NHP', email: 'test.buyer@po-desk.test', role: 'buyer', entity: 'NHP', poLimitZar: 500 });

/** Creates an active user with no PIN. Safe to run twice: an existing email is returned unchanged. */
function createUser(name, email, role) {
  const e = normEmail_(email);
  if (!String(name || '').trim()) throw new AppError('BAD_REQUEST', 'Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AppError('BAD_REQUEST', 'A valid email is required.');
  if (ROLES.indexOf(role) === -1) throw new AppError('BAD_REQUEST', 'Role must be buyer, approver or admin.');
  const existing = findUserByEmail_(e);
  if (existing) {
    console.log('createUser: ' + e + ' already exists (' + existing.user_id + ', role ' + existing.role + '). Left unchanged.');
    return existing;
  }
  const row = {
    user_id: Utilities.getUuid(), name: String(name).trim(), email: e, pin_hash: '', pin_salt: '', role: role,
    active: true, failed_attempts: 0, locked_until: '', pin_token_hash: '', pin_token_expires: '',
    created_by: 'setup', created_at: new Date(),
  };
  appendRow('Users', row);
  auditLog({ userId: row.user_id, action: 'user.create', ok: true, detail: { role: role, by: 'setup' } });
  console.log('createUser: ' + e + ' created as ' + role + ' (' + row.user_id + '). No PIN yet.');
  return findUserByEmail_(e);
}

/** Upserts one UserEntities row. An existing row keeps its values unless `overwrite` is true. */
function grantEntity_(userId, entityId, canBuy, canApprove, poLimitZar, overwrite) {
  const ent = entityById_(entityId).entity_id;
  const row = readTable('UserEntities').rows.find(r => String(r.user_id) === String(userId) && r.entity_id === ent);
  const vals = { user_id: userId, entity_id: ent, can_buy: !!canBuy, can_approve: !!canApprove, po_limit_zar: Number(poLimitZar) || 0 };
  if (!row) { appendRow('UserEntities', vals); return 'added'; }
  if (!overwrite) return 'kept';
  const table = readTable('UserEntities');
  Object.assign(row, vals);
  sheet_('UserEntities').getRange(row._row, 1, 1, table.headers.length).setValues([table.headers.map(h => cell_(row[h]))]);
  return 'updated';
}

/** Sets a PIN. Call it through setMyPin() from the editor, never with a PIN typed into code. */
function setPin(email, pin) {
  const user = findUserByEmail_(email);
  if (!user) throw new AppError('NOT_FOUND', 'No user with that email.');
  pin = String(pin === undefined || pin === null ? '' : pin).trim();
  if (!/^\d{6}$/.test(pin)) throw new AppError('BAD_REQUEST', 'The PIN must be exactly 6 digits.');
  if (isWeakPin_(pin)) throw new AppError('BAD_REQUEST', 'That PIN is too easy to guess (repeated or sequential digits). Choose another.');
  const salt = newSalt_();
  updateRowById('Users', 'user_id', user.user_id, {
    pin_hash: hashPin_(salt, pin), pin_salt: salt, failed_attempts: 0, locked_until: '', pin_token_hash: '', pin_token_expires: '',
  });
  resetLoginLimits_(user.email);
  auditLog({ userId: user.user_id, action: 'pin.set', ok: true, detail: { by: 'setup' } });
  console.log('PIN set for ' + user.email + '.');
}

/**
 * Run from the editor. Reads Script Properties SETPIN_EMAIL and SETPIN_PIN, sets the PIN, then
 * deletes both properties whether or not it worked, so the PIN is never left behind.
 */
function setMyPin() {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('SETPIN_EMAIL');
  const pin = props.getProperty('SETPIN_PIN');
  try {
    if (!email || !pin) throw new AppError('BAD_REQUEST', 'Add Script Properties SETPIN_EMAIL and SETPIN_PIN first.');
    setPin(email, pin);
  } finally {
    props.deleteProperty('SETPIN_PIN');
    props.deleteProperty('SETPIN_EMAIL');
  }
}

/** Creates Dawie as admin with buy + approve on all three companies. Safe to run twice. */
function seedAdmin() {
  const missing = ADMIN_SEED.entities.filter(ent => !(Number(ADMIN_PO_LIMIT_ZAR[ent]) > 0));
  if (missing.length) throw new AppError('SETUP_ORDER', 'ADMIN_PO_LIMIT_ZAR is not confirmed for ' + missing.join(', ') + '. Ask Dawie, set it in Setup.gs, push, then run seedAdmin().');
  const user = createUser(ADMIN_SEED.name, ADMIN_SEED.email, ADMIN_SEED.role);
  const out = ADMIN_SEED.entities.map(ent => ent + ': ' + grantEntity_(user.user_id, ent, true, true, ADMIN_PO_LIMIT_ZAR[ent], false));
  console.log('seedAdmin: ' + ADMIN_SEED.email + ' ' + out.join(', ') + '. Now set your PIN with setMyPin().');
}

/** A buyer limited to NHP, for the Stage 3 access-control and lockout acceptance tests. */
function createTestBuyerNHP() {
  const user = createUser(TEST_BUYER.name, TEST_BUYER.email, TEST_BUYER.role);
  if (!isTrue_(user.active)) updateRowById('Users', 'user_id', user.user_id, { active: true });
  console.log('createTestBuyerNHP: ' + TEST_BUYER.entity + ' ' + grantEntity_(user.user_id, TEST_BUYER.entity, true, false, TEST_BUYER.poLimitZar, true) + '.');
}

/** Switches the test buyer off once testing is done (rows are kept for the audit trail). */
function deactivateTestBuyer() {
  const user = findUserByEmail_(TEST_BUYER.email);
  if (!user) { console.log('No test buyer.'); return; }
  updateRowById('Users', 'user_id', user.user_id, { active: false });
  console.log('Test buyer deactivated.');
}

/** Clears a lockout early (e.g. after testing). Edit the email in unlockTestBuyer or call unlockUser(email). */
function unlockUser(email) {
  const user = findUserByEmail_(email);
  if (user) updateRowById('Users', 'user_id', user.user_id, { failed_attempts: 0, locked_until: '' });
  resetLoginLimits_(email);
  console.log('Unlocked ' + normEmail_(email) + '.');
}

function unlockTestBuyer() { unlockUser(TEST_BUYER.email); }
function unlockAdmin() { unlockUser(ADMIN_SEED.email); }

// --- Stage 4: retry queue trigger -------------------------------------------------------------

function installQueueTrigger() { installTriggers(); }

// --- UAT test accounts (Stage 7) ------------------------------------------------------------------

// Fake .test addresses (no email is ever sent to them). One buyer per company (limit R500) and one
// approver for all three, so "over limit then approved" is decided by someone other than the buyer.
const UAT_ACCOUNTS = Object.freeze([
  { name: 'Test Buyer NHP', email: 'test.buyer@po-desk.test', role: 'buyer', grants: { NHP: [true, false, 500] } },
  { name: 'Test Buyer HPB', email: 'test.buyer.hpb@po-desk.test', role: 'buyer', grants: { HPB: [true, false, 500] } },
  { name: 'Test Buyer PK', email: 'test.buyer.pk@po-desk.test', role: 'buyer', grants: { PK: [true, false, 500] } },
  { name: 'Test Approver', email: 'test.approver@po-desk.test', role: 'approver', grants: { HPB: [false, true, 0], NHP: [false, true, 0], PK: [false, true, 0] } },
]);

/**
 * Creates (or re-activates) the UAT accounts with their grants and one shared PIN. Put the PIN in
 * Script Property UAT_PIN first; it is deleted afterwards whether or not this worked.
 */
function createUatAccounts() {
  const props = PropertiesService.getScriptProperties();
  const pin = props.getProperty('UAT_PIN');
  try {
    if (!pin) throw new AppError('BAD_REQUEST', 'Add Script Property UAT_PIN (6 digits) first.');
    const out = UAT_ACCOUNTS.map(a => {
      const u = createUser(a.name, a.email, a.role);
      updateRowById('Users', 'user_id', u.user_id, { active: true, role: a.role });
      const grants = Object.keys(a.grants).map(ent => ent + ' ' + grantEntity_(u.user_id, ent, a.grants[ent][0], a.grants[ent][1], a.grants[ent][2], true));
      setPin(a.email, pin);
      return a.email + ': ' + grants.join(', ');
    });
    console.log('createUatAccounts:\n  ' + out.join('\n  '));
  } finally {
    props.deleteProperty('UAT_PIN');
  }
}

/** Switches every UAT account off after testing; their open sessions end at once. Rows stay for the audit trail. */
function deactivateUatAccounts() {
  UAT_ACCOUNTS.forEach(a => {
    const u = findUserByEmail_(a.email);
    if (u) updateRowById('Users', 'user_id', u.user_id, { active: false, sessions_valid_from: new Date() });
  });
  console.log('deactivateUatAccounts: ' + UAT_ACCOUNTS.map(a => a.email).join(', ') + ' are off.');
}

/**
 * Run from the editor when a permission is missing (e.g. "Send email as you" was unticked on the
 * consent screen, so no email goes out). Google then asks for every permission PO Desk needs.
 */
function grantPermissions() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  console.log('All permissions granted. Emails left today: ' + MailApp.getRemainingDailyQuota() + '. Now run checkEmail.');
}

/**
 * A PO (and its bill) deleted directly in Xero: PO Desk doesn't read PO statuses back from Xero, so
 * its record would still say Issued or Billed. Put "<company> <PO number>" (e.g. "NHP PO-0184") in
 * Script Property CANCEL_PO and run this: it checks Xero really has the PO and its bills deleted,
 * then marks the PO Desk record CANCELLED. The property is deleted afterwards.
 */
function cancelPoDeletedInXero() {
  const props = PropertiesService.getScriptProperties();
  const raw = String(props.getProperty('CANCEL_PO') || '').trim();
  try {
    const m = /^(HPB|NHP|PK)\s+(\S+)$/i.exec(raw);
    if (!m) throw new AppError('BAD_REQUEST', 'Set Script Property CANCEL_PO to e.g. "NHP PO-0184" first.');
    const ent = m[1].toUpperCase();
    invalidateTable_('POs');
    invalidateTable_('Bills');
    const row = readTable('POs').rows.find(r => r.entity_id === ent && String(r.po_number) === m[2]);
    if (!row) throw new AppError('NOT_FOUND', 'No ' + ent + ' PO ' + m[2] + ' in PO Desk.');
    const t = entityById_(ent).xero_tenant_id;
    const ctx = { ref: 'cancel:' + row.po_id };
    const gone = (s) => s === 'DELETED' || s === 'VOIDED';
    const x = row.xero_po_id ? (xeroGetPurchaseOrder(t, String(row.xero_po_id), ctx) || {}) : {};
    if (row.xero_po_id && !gone(x.Status)) throw new AppError('BAD_REQUEST', m[2] + ' is still ' + x.Status + ' in Xero. Delete it there first (or use the app).');
    const bills = readTable('Bills').rows.filter(b => b.po_id === row.po_id && b.xero_invoice_id);
    bills.forEach(b => {
      const inv = xeroGetInvoiceById(t, String(b.xero_invoice_id), ctx) || {};
      if (!gone(inv.Status)) throw new AppError('BAD_REQUEST', 'Its bill ' + (inv.InvoiceNumber || '') + ' is still ' + inv.Status + ' in Xero. Delete it there first.');
    });
    const was = row.status;
    updateRowById('POs', 'po_id', row.po_id, { status: PO_STATUS.CANCELLED });
    auditLog({ entityId: ent, action: 'po.cancel_deleted_in_xero', ok: true, ref: row.po_id, detail: { po: m[2], was: was, bills: bills.length } });
    console.log(ent + ' ' + m[2] + ': ' + was + ' -> CANCELLED (Xero: PO ' + (x.Status || 'none') + ', ' + bills.length + ' bill(s) deleted).');
  } finally {
    props.deleteProperty('CANCEL_PO');
  }
}
