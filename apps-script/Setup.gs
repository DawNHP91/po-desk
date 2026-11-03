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
function installSyncTrigger() {
  const removed = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncAll');
  removed.forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncAll').timeBased().atHour(2).everyDays(1).inTimezone(APP.TZ).create();
  const now = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncAll').length;
  console.log('installSyncTrigger: removed ' + removed.length + ', now ' + now + ' syncAll trigger(s), daily 02:00 ' + APP.TZ + '.');
}

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
  { sort: 70, name: 'Cleaning', code: '404', keywords: 'cleaning, detergent, bleach, jik, sanitiser, sanitizer, disinfectant, soap, mop, broom, handy andy, dishwashing, toilet paper, refuse bags, bin bags' },
  { sort: 80, name: 'Protective clothing (PPE)', code: '421', keywords: 'ppe, gloves, nitrile gloves, overalls, safety boots, gumboots, hairnet, hairnets, face mask, masks, goggles, lab coat, apron, hard hat' },
  { sort: 90, name: 'Repairs: building', code: '422', keywords: 'plumber, plumbing, paint, cement, light bulb, globe, globes, tap, padlock, lock, door handle, hardware, builders, silicone' },
  { sort: 100, name: 'Repairs: machinery', code: '423', keywords: 'bearing, bearings, v-belt, drive belt, motor, pump, spares, spare parts, welding, gasket, o-ring, seal, fittings, grease' },
  { sort: 110, name: 'Small tools', code: '306', keywords: 'tool, tools, screwdriver, spanner, drill bit, drill bits, hammer, pliers, tape measure, extension cord, multiplug, cable ties', note: 'No tools account in the chart: mapped to 306 Consumables - Factory. Please review.' },
  { sort: 120, name: 'Staff refreshments', code: '426', keywords: 'coffee, tea, milk, sugar, creamer, biscuits, refreshments, snacks, bottled water, lunch, cake' },
  { sort: 130, name: 'Courier and postage', code: '303', keywords: 'courier, postage, post office, pargo, paxi, aramex, courier guy, dhl, fedex, postnet' },
  { sort: 140, name: 'Office supplies and stationery', code: '420', keywords: 'stationery, a4 paper, paper, pen, pens, printer ink, ink, toner, cartridge, stapler, envelopes, files, printing, notebook' },
]);

/**
 * Writes the proposals to Categories with active = FALSE (one row per company and name; existing rows
 * are never touched, so your corrections survive a re-run) and prints the mapping for review.
 * Run syncAll() first: codes are checked against the synced Accounts tab.
 */
function proposeCategories() {
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
        row: already ? 'kept existing (' + (already.account_code || 'blank') + ', active=' + already.active + ')' : 'added, inactive',
        note: (ok ? '' : 'CODE ' + p.code + ' NOT A VALID PURCHASE ACCOUNT HERE. ') + (p.note || ''),
      };
    });
  });
  Object.keys(report).forEach(ent => out_('Proposed categories: ' + ent, table_(report[ent], ['sort', 'category', 'code', 'account', 'type', 'defaultTax', 'row', 'note'])));
  console.log('Review the Categories tab, correct any account_code, then set active = TRUE on the ones you want.');
}
