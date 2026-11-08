// Category proposals (Setup.gs updateCategoryProposals) against a fake Categories tab, and keyword
// scoring with them switched on.   node tests/offline/categories.js apps-script
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const dir = process.argv[2]; const logs = [];
const T = { Accounts: [], Categories: [] };
const codes = { '433': 'EXPENSE', '432': 'EXPENSE', '312': 'DIRECTCOSTS', '313': 'DIRECTCOSTS', '311': 'DIRECTCOSTS', '310': 'DIRECTCOSTS', '404': 'EXPENSE', '421': 'EXPENSE', '422': 'EXPENSE', '423': 'EXPENSE', '306': 'DIRECTCOSTS', '426': 'EXPENSE', '303': 'DIRECTCOSTS', '420': 'EXPENSE' };
['HPB', 'NHP', 'PK'].forEach(e => Object.keys(codes).forEach(c => T.Accounts.push({ entity_id: e, code: c, name: 'Acct ' + c, type: codes[c], class: 'EXPENSE', status: 'ACTIVE', tax_type: 'INPUT3' })));
const cat = (e, name, code, kw, active) => ({ category_id: crypto.randomUUID(), entity_id: e, name, account_code: code, tax_type: 'INPUT3', keywords: kw, sort: 1, active });
['HPB', 'NHP', 'PK'].forEach(e => T.Categories.push(cat(e, 'Small tools', '306', 'tool, tools', false), cat(e, 'Cleaning', '404', 'cleaning, soap', false), cat(e, 'Fuel', '433', 'my own fuel words', true)));
// Stage 10: an admin added a word on the Keywords screen and removed a proposed one.
Object.assign(T.Categories.find(c => c.entity_id === 'NHP' && c.name === 'Cleaning'), { keywords: 'cleaning, soap, dish washing liquid', removed_keywords: 'jik' });
const ctx = { console: { log: m => logs.push(m), warn: m => logs.push('WARN ' + m) }, Utilities: { getUuid: () => crypto.randomUUID(), newBlob: (s) => ({ getBytes: () => Buffer.from(String(s)) }) } };
vm.createContext(ctx);
const src = ['Config', 'Db', 'Main', 'Auth', 'Approvals', 'Composio', 'Xero', 'Sync', 'Coding', 'Drive', 'Ocr', 'Setup', 'Tests'].map(f => fs.readFileSync(dir + '/' + f + '.gs', 'utf8')).join('\n');
vm.runInContext(src, ctx);
ctx.T = T;
vm.runInContext(`
readTable = n => ({ headers: [], rows: T[n] });
appendRow = (n, o) => { T[n].push(Object.assign({}, o)); };
updateRowById = (n, f, id, p) => { const r = T[n].find(x => x[f] === id); Object.assign(r, p); return r; };
getConfig = (k, d) => (k === 'PURCHASE_TAX_TYPE' ? 'INPUT3' : d);
updateCategoryProposals();
`, ctx);
const P = [];
const check = (label, ok, detail) => P.push((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : ' -> ' + detail));
const get = (e, n) => T.Categories.filter(c => c.entity_id === e && c.name === n);
['HPB', 'NHP', 'PK'].forEach(e => {
  check(e + ': Small tools (inactive) moved 306 -> 423', get(e, 'Small tools')[0].account_code === '423', JSON.stringify(get(e, 'Small tools')));
  check(e + ': Cleaning (inactive) keywords updated, keeps 404', get(e, 'Cleaning')[0].account_code === '404' && /hand soap/.test(get(e, 'Cleaning')[0].keywords), JSON.stringify(get(e, 'Cleaning')));
  if (e === 'NHP') check('NHP: Cleaning keeps the admin’s "dish washing liquid" and doesn’t get back the removed "jik"', /dish washing liquid/.test(get(e, 'Cleaning')[0].keywords) && !/\bjik\b/.test(get(e, 'Cleaning')[0].keywords) && /bleach/.test(get(e, 'Cleaning')[0].keywords), get(e, 'Cleaning')[0].keywords);
  check(e + ': Fuel (switched on) untouched', get(e, 'Fuel')[0].keywords === 'my own fuel words', JSON.stringify(get(e, 'Fuel')));
  check(e + ': Factory consumables added once, inactive, 306', get(e, 'Factory consumables').length === 1 && get(e, 'Factory consumables')[0].account_code === '306' && get(e, 'Factory consumables')[0].active === false, JSON.stringify(get(e, 'Factory consumables')));
  check(e + ': PPE added without gloves', get(e, 'Protective clothing (PPE)').length === 1 && !/gloves/.test(get(e, 'Protective clothing (PPE)')[0].keywords), '');
});
// keyword scoring with these categories switched on: the longer phrase wins
vm.runInContext(`
const acc = T.Accounts.filter(a => a.entity_id === 'NHP');
const cats = T.Categories.filter(c => c.entity_id === 'NHP').map(c => Object.assign({}, c, { active: true }));
const data = { accounts: acc, taxRates: [{ entity_id: 'NHP', tax_type: 'INPUT3', rate: 15, status: 'ACTIVE' }], categories: cats, history: [], words: null, borrowed: null,
  config: { historyN: 5, defaultAccount: '', extraAccounts: '', purchaseTaxType: 'INPUT3', wordMinShare: 0.6 } };
this.r1 = suggestAccountWith_(data, 'NHP', null, null, 'machine soap for the filler').accountCode;
this.r2 = suggestAccountWith_(data, 'NHP', null, null, 'hand soap for the toilets').accountCode;
this.r3 = suggestAccountWith_(data, 'NHP', null, null, 'nitrile gloves').accountCode;
this.r4 = suggestAccountWith_(data, 'NHP', null, null, 'safety boots size 9').accountCode;
this.r5 = suggestAccountWith_(data, 'NHP', null, null, 'cable ties and a hammer').accountCode;
`, ctx);
check('"machine soap" -> 306 (longer phrase beats "soap")', ctx.r1 === '306', ctx.r1);
check('"hand soap" -> 404 Cleaning', ctx.r2 === '404', ctx.r2);
check('"nitrile gloves" -> 306 Factory consumables', ctx.r3 === '306', ctx.r3);
check('"safety boots" -> 421 PPE', ctx.r4 === '421', ctx.r4);
check('"cable ties and a hammer" -> 423 machinery', ctx.r5 === '423', ctx.r5);
const failed = P.filter(x => x.startsWith('FAIL'));
console.log('=== categories: ' + failed.length + ' failure(s) of ' + P.length + ' ===' + (failed.length ? '\n' + failed.join('\n') : ''));
process.exitCode = failed.length ? 1 : 0;
