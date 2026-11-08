const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const dir = process.argv[2]; let logs = [];
const cache = new Map(), props = new Map([['COMPOSIO_API_KEY', 'k'], ['COMPOSIO_XERO_ACCOUNT_ID', 'ca_x'], ['SHEET_ID', 's'], ['SHEET_TZ', 'Africa/Johannesburg']]);
let sheetsCalls = 0, sheetsRequests = 0;
const signed = buf => Array.from(buf).map(b => b > 127 ? b - 256 : b);
const sent = [];
// ---- fake Xero, one store per tenant, reached only through a fake Composio REST API ----
const NHP = '910e6495-b557-4d16-ad76-e0190cd60546', HPB = '3b167b1c-1023-4463-a02b-46f44b56fb4a';
const X = { [NHP]: { contacts: [{ ContactID: 'aaaaaaaa-0000-4000-8000-000000000001', Name: 'PO Desk Test Supplier', ContactStatus: 'ARCHIVED', IsSupplier: true }], pos: [] }, [HPB]: { contacts: [], pos: [] } };
let poSeq = 200, xeroCalls = [];
function fakeXero(tenant, method, path, body) {
  const st = X[tenant]; if (!st) return { status: 403, data: { Message: 'no tenant' } };
  xeroCalls.push(method + ' ' + path.split('?')[0] + ' @' + (tenant === NHP ? 'NHP' : tenant === HPB ? 'HPB' : tenant));
  const u = new URL('https://x' + path);
  if (method === 'PUT' && u.pathname === '/PurchaseOrders') {
    const p = body.PurchaseOrders[0];
    if (/REJECTME/.test(p.LineItems[0].Description)) return { status: 400, data: { Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: 'Account code is not valid' }] }] } };
    const po = Object.assign({}, p, { PurchaseOrderID: crypto.randomUUID(), PurchaseOrderNumber: 'PO-0' + (++poSeq), Total: p.LineItems[0].UnitAmount, LineItems: p.LineItems.map(l => Object.assign({ LineItemID: crypto.randomUUID() }, l)) });
    st.pos.push(po); return { status: 200, data: { PurchaseOrders: [po] } };
  }
  if (method === 'GET' && u.pathname === '/PurchaseOrders') return { status: 200, data: { PurchaseOrders: st.pos.filter(p => p.Date >= u.searchParams.get('DateFrom') && p.Date <= u.searchParams.get('DateTo')) } };
  if (method === 'GET' && u.pathname === '/Contacts') { const q = (u.searchParams.get('searchTerm') || '').toLowerCase(); const w = /Name=="(.*)"/.exec(u.searchParams.get('where') || ''); return { status: 200, data: { Contacts: st.contacts.filter(c => c.Name.toLowerCase().includes(q) && (!w || c.Name === w[1]) && (u.searchParams.get('includeArchived') === 'true' || c.ContactStatus === 'ACTIVE')) } }; }
  const m = /^\/Contacts\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (m && method === 'GET') { const c = st.contacts.find(x => x.ContactID === m[1]); return c ? { status: 200, data: { Contacts: [c] } } : { status: 404, data: { Message: 'not found' } }; }
  if (m && method === 'POST') { const c = st.contacts.find(x => x.ContactID === m[1]); if (!c) return { status: 404, data: {} }; if (c.ContactStatus === 'ARCHIVED') return { status: 400, data: { Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: 'The specified contact details matched an archived contact. Archived contacts cannot currently be edited via the API.' }] }] } }; c.ContactStatus = body.Contacts[0].ContactStatus; return { status: 200, data: { Contacts: [c] } }; }
  return { status: 404, data: { Message: 'unhandled ' + method + ' ' + path } };
}
function fakeTool(slug, a) {
  const st = X[a.tenant_id || a.tenantId];
  xeroCalls.push('tool ' + slug + ' @' + ((a.tenant_id || a.tenantId) === NHP ? 'NHP' : 'other'));
  if (slug === 'XERO_CREATE_CONTACT') { const c = { ContactID: crypto.randomUUID(), Name: a.Name, ContactStatus: 'ACTIVE', IsSupplier: true, TaxNumber: a.TaxNumber }; st.contacts.push(c); return { Contacts: [c] }; }
  if (slug === 'XERO_GET_PURCHASE_ORDER') return { PurchaseOrders: [st.pos.find(p => p.PurchaseOrderID === a.purchase_order_id)] };
  if (slug === 'XERO_UPDATE_PURCHASE_ORDER') { const p = st.pos.find(x => x.PurchaseOrderID === a.purchase_order_id); Object.assign(p, a.Status ? { Status: a.Status } : {}); return { PurchaseOrders: [p] }; }
  throw new Error('unhandled tool ' + slug);
}
function fakeSheets(ctxObj, url, opt) {
  const MEM = ctxObj.MEM, TABLES = ctxObj.TABLES;
  const path = decodeURIComponent(url.split('/spreadsheets/s')[1]);
  sheetsRequests++;
  const fromUE = (name, row) => { const o = {}; TABLES[name].forEach((h, i) => { let v = row[i]; if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1); else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) v = new Date(v.replace(' ', 'T') + '+02:00'); o[h] = v === undefined ? '' : v; }); return o; };
  if (path.startsWith('/values:batchGet')) {
    const names = [...path.matchAll(/ranges='([^']+)'/g)].map(m => m[1]);
    const ser = v => v instanceof Date ? (v.getTime() + 2 * 3600e3) / 86400000 + 25569 : v;
    return { valueRanges: names.map(n => ({ values: [TABLES[n]].concat((MEM[n] || []).map(o => TABLES[n].map(h => ser(o[h] === undefined ? '' : o[h])))) })) };
  }
  const m = /^\/values\/'([^']+)'!A(\d+)(:append)?/.exec(path);
  const body = JSON.parse(opt.payload);
  if (m && m[3]) { body.values.forEach(r => MEM[m[1]].push(fromUE(m[1], r))); return {}; }
  if (m) { MEM[m[1]][Number(m[2]) - 2] = fromUE(m[1], body.values[0]); return {}; }
  throw new Error('fake sheets: unhandled ' + path);
}
const drive = { files: {}, folders: {} };
let fid = 0;
function mkFolder(name, parent) { const f = { id: 'fold' + (++fid), name, parent, children: [], getId() { return this.id; }, getName() { return this.name; },
  getFoldersByName(n) { const hits = this.children.filter(c => c.name === n); let i = 0; return { hasNext: () => i < hits.length, next: () => hits[i++] }; },
  createFolder(n) { const c = mkFolder(n, this); this.children.push(c); return c; },
  createFile(blob) { const file = { id: 'file' + (++fid), name: blob.getName(), bytes: blob.getBytes(), mime: blob.getContentType(), folder: this, trashed: false,
    getId() { return this.id; }, getName() { return this.name; }, setName(n) { this.name = n; return this; }, setTrashed(t) { this.trashed = t; return this; }, getMimeType() { return this.mime; },
    getBlob() { return mkBlob(this.bytes, this.mime, this.name); } }; drive.files[file.id] = file; return file; },
  getFiles() { const fs = Object.values(drive.files).filter(f => f.folder === this); let i = 0; return { hasNext: () => i < fs.length, next: () => fs[i++] }; } };
  drive.folders[f.id] = f; return f; }
function mkBlob(bytes, mime, name) { const b = { bytes: Array.from(bytes), mime, name, getBytes() { return this.bytes; }, getContentType() { return this.mime; }, getName() { return this.name; }, setName(n) { this.name = n; return this; }, setContentType(m) { this.mime = m; return this; }, copyBlob() { return mkBlob(this.bytes, this.mime, this.name); } }; return b; }
const entFolders = { NHP: mkFolder('NHP'), HPB: mkFolder('HPB'), PK: mkFolder('PK') };
let geminiMode = 'ok', geminiCalls = [], geminiAnswer = null;
const geminiQueue = [];
function fakeGemini(url, opt) {
  if (geminiQueue.length && geminiQueue.shift() === '503') { geminiCalls.push({ url }); return resp(503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }); }
  geminiCalls.push({ url, body: JSON.parse(opt.payload), key: opt.headers['x-goog-api-key'] });
  const gc = JSON.parse(opt.payload).generationConfig;
  if (geminiMode === '429') return resp(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
  if (geminiMode === '500then200') { geminiMode = 'ok'; return resp(500, { error: 'boom' }); }
  if (geminiMode === '500') return resp(500, { error: 'boom' });
  if (geminiMode === 'oldschema' && gc.responseJsonSchema) return resp(400, { error: { message: 'Invalid JSON payload received. Unknown name "responseJsonSchema" at generation_config' } });
  if (geminiMode === 'blocked') return resp(200, { promptFeedback: { blockReason: 'SAFETY' } });
  if (geminiMode === 'badjson') return resp(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{not json' }] } }] });
  return resp(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(geminiAnswer) }] } }] });
}
const resp = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj), getHeaders: () => ({}) });
const ctx = {
  console: { log: m => logs.push(m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m) },
  Utilities: { getUuid: () => crypto.randomUUID(), sleep: () => {}, DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
    base64Encode: b => Buffer.from(b.map(x => x & 0xff)).toString('base64'), base64Decode: s => { if (!/^[A-Za-z0-9+/=]*$/.test(s)) throw new Error('bad b64'); return signed(Buffer.from(s, 'base64')); }, newBlob: (b, mime, name) => typeof b === 'string' ? { getBytes: () => Buffer.from(b, 'utf8') } : mkBlob(b, mime, name), computeDigest: (alg, s) => signed(crypto.createHash(alg).update(Buffer.from(String(s), 'utf8')).digest()),     formatDate: (d, tz, f) => { const z = new Date(d.getTime() + 2 * 3600e3).toISOString(); if (f === 'Z') return '+0200'; const t = { yyyy: z.slice(0, 4), yy: z.slice(2, 4), MM: z.slice(5, 7), dd: z.slice(8, 10), HH: z.slice(11, 13), mm: z.slice(14, 16), ss: z.slice(17, 19) }; return f.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, k => t[k]); } },
  CacheService: { getScriptCache: () => ({ get: k => cache.has(k) ? cache.get(k) : null, put: (k, v) => cache.set(k, String(v)), remove: k => cache.delete(k), removeAll: ks => ks.forEach(k => cache.delete(k)), putAll: m => Object.keys(m).forEach(k => cache.set(k, m[k])), getAll: ks => { const o = {}; ks.forEach(k => { if (cache.has(k)) o[k] = cache.get(k); }); return o; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.has(k) ? props.get(k) : null, setProperty: (k, v) => props.set(k, v), deleteProperty: k => props.delete(k) }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s }) },
  MailApp: { getRemainingDailyQuota: () => 100, sendEmail: o => sent.push(o) },
  ScriptApp: { getOAuthToken: () => 'tok' },
  DriveApp: { getFolderById: id => drive.folders[id], getFileById: id => { const f = drive.files[id]; if (!f) throw new Error('no file'); return f; } },
  UrlFetchApp: { fetchAll(reqs) { sheetsCalls++; return reqs.map(r => { if (process.env.SHEETS_DOWN) return resp(503, { error: 'down' }); return resp(200, fakeSheets(ctx, r.url, r)); }); }, fetch(url, opt) {
    if (url.indexOf('generativelanguage.googleapis.com') !== -1) return fakeGemini(url, opt);
    if (url.indexOf('/drive/v3/files/') !== -1) return resp(200, {});
    const b = JSON.parse(opt.payload);
    if (url.endsWith('/tools/execute/proxy')) {
      const tenant = (b.parameters || []).find(p => p.name === 'xero-tenant-id').value;
      const r = fakeXero(tenant, b.method, b.endpoint.replace('https://api.xero.com/api.xro/2.0', ''), b.body);
      return resp(200, { status: r.status, data: r.data, headers: {} });
    }
    const slug = url.split('/tools/execute/')[1];
    return resp(200, { successful: true, error: null, data: fakeTool(slug, b.arguments) });
  } },
};
ctx.process_env_FASTOFF = !!process.env.FASTOFF; ctx.drive = drive; ctx.entFolders = entFolders; ctx.props = props; ctx.setGemini = (m, a) => { geminiMode = m; if (a !== undefined) geminiAnswer = a; }; ctx.geminiCalls = () => geminiCalls; ctx.geminiQueue = geminiQueue; ctx.__sheetsCalls = () => sheetsCalls; ctx.__sheetsReqs = () => sheetsRequests; ctx.X = X; ctx.sent = sent; ctx.logs = logs; Object.defineProperty(ctx, "xeroCalls", { get: () => xeroCalls }); vm.createContext(ctx);
const src = ['Config','Db','Main','Auth','Approvals','Composio','Xero','Sync','Coding','Drive','Ocr','Setup','Tests'].map(f => fs.readFileSync(dir + '/' + f + '.gs', 'utf8')).join('\n');
vm.runInContext(src + `
const MEM = { Entities: ENTITY_SEED.map(e => Object.assign({}, e, { active: true })), Users: [], UserEntities: [], PaymentMethods: [], Categories: [], Config: [], POs: [], Queue: [], SupplierHistory: [], AuditLog: [],
  Suppliers: [{ entity_id: 'NHP', contact_id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Engen Rainbow Motors' }, { entity_id: 'HPB', contact_id: 'cccccccc-0000-4000-8000-000000000003', name: 'HPB Only Supplier' }],
  Accounts: [['NHP','433','Vehicle - Petrol and oil','EXPENSE','INPUT3'],['NHP','465','Unallocated Expenses','EXPENSE','NONE'],['HPB','433','Vehicle - Petrol and oil','EXPENSE','INPUT3']].map(a => ({ entity_id: a[0], account_id: a[0] + a[1], code: a[1], name: a[2], type: a[3], class: 'EXPENSE', tax_type: a[4], status: 'ACTIVE' })),
  TaxRates: [['NHP','INPUT3',15],['NHP','NONE',0],['NHP','INPUT',14]].map(t => ({ entity_id: t[0], tax_type: t[1], rate: t[2], status: 'ACTIVE' })) };
globalThis.MEM = MEM; globalThis.TABLES = TABLES;
if (process_env_FASTOFF) dbCache_.fastOff = true;
readTable = n => { const rows = MEM[n] || (MEM[n] = []); rows.forEach((r, i) => Object.defineProperty(r, '_row', { value: i + 2, writable: true, configurable: true, enumerable: false })); return { headers: TABLES[n], rows: rows }; };
invalidateTable_ = () => {};
appendRow = (n, o) => { (MEM[n] = MEM[n] || []).push(Object.assign({}, o)); return o; };
findBy = (n, f, v) => readTable(n).rows.filter(r => String(r[f]) === String(v));
updateRowById = (n, f, id, p) => { const r = (MEM[n] || []).find(x => String(x[f]) === String(id)); if (r) Object.assign(r, p); return r; };
sheet_ = n => ({ deleteRow: k => MEM[n].splice(k - 2, 1), getRange: () => ({ setValues() {} }) });
auditLog = e => MEM.AuditLog.push({ action: e.action, ok: e.ok === true, detail_json: JSON.stringify(e.detail || {}) });
const P = [];
const check = (label, cond, detail) => P.push((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : ' -> ' + detail));
MEM.Entities.forEach(e => { e.drive_folder_id = entFolders[e.entity_id].id; });
props.set('GEMINI_API_KEY', 'gk');
seedPaymentMethods(); createTestBuyerNHP();
const admin = createUser('Dawid Groenewald', 'dawie@nhpglobalgroup.com', 'admin'); grantEntity_(admin.user_id, 'NHP', true, true, 1500, false);
const buyer = findUserByEmail_(TEST_BUYER.email);
const tok = createSession_(buyer.user_id);
const call = (action, payload, t) => JSON.parse(doPost({ postData: { contents: JSON.stringify({ action, token: t || tok, payload, idemKey: Utilities.getUuid() }) } }).getContent());
const card = MEM.PaymentMethods.find(p => p.entity_id === 'NHP' && p.type === 'CARD');
const engen = 'bbbbbbbb-0000-4000-8000-000000000002';
const mkPO = (amount, over) => call('createPO', Object.assign({ entityId: 'NHP', pmId: card.pm_id, contactId: engen, description: 'Diesel', amountInclZar: amount, accountCode: '433' }, over || {}));
const jpeg = () => Utilities.base64Encode([0xff, 0xd8, 0xff, 0xe0].concat(Array(3000).fill(7)).map(x => x > 127 ? x - 256 : x));
const ANSWER = { supplier_name: 'ENGEN RAINBOW MOTORS', supplier_vat_number: '4123 456 789', slip_number: 'T 004512', date: '2026-11-04', currency: 'ZAR',
  line_items: [{ description: 'DIESEL 50PPM', qty: 40.12, unit_price_incl: 2.25, line_total_incl: 90.27 }, { description: 'COKE 500ML', qty: 1, unit_price_incl: 33.18, line_total_incl: 33.18 }],
  subtotal_excl: 107.35, vat_amount: 16.10, total_incl: 123.45, payment_method_hint: 'CARD',
  confidence: { supplier_name: 0.95, supplier_vat_number: 0.9, slip_number: 0.6, date: 0.92, currency: 1, line_items: 0.85, subtotal_excl: 0.8, vat_amount: 0.9, total_incl: 0.97, payment_method_hint: 0.9 } };

// pure helpers
const n1 = normalizeSlip_(ANSWER, 0.7);
check('normalize: VAT digits only, lines+total consistent, low-confidence slip number flagged', n1.fields.supplierVatNumber === '4123456789' && n1.checks.length === 0 && n1.lowConfidence.join() === 'slipNumber' && n1.fields.totalIncl === 123.45, JSON.stringify(n1));
const n2 = normalizeSlip_(Object.assign({}, ANSWER, { total_incl: 130, vat_amount: 5 }), 0.7);
check('normalize: lines not adding up and VAT not 15% both caught, confidence lowered', n2.checks.map(c => c.code).join() === 'LINES_NOT_TOTAL,VAT_NOT_15' && n2.lowConfidence.includes('totalIncl') && n2.lowConfidence.includes('vatAmount'), JSON.stringify(n2.checks));
const n3 = normalizeSlip_(Object.assign({}, ANSWER, { date: '2026-02-30', supplier_vat_number: '2015/123456/07' }), 0.7);
check('normalize: impossible date and company-reg-as-VAT caught', n3.fields.date === '' && n3.checks.some(c => c.code === 'DATE_UNREADABLE') && n3.checks.some(c => c.code === 'VAT_NUMBER_FORMAT'), JSON.stringify(n3.checks));
check('namesMatch_: SPAR KLEIN KAROO ~ Spar Oudtshoorn; Engen !~ Shell; Builders Warehouse ~ BUILDERS', namesMatch_('SPAR KLEIN KAROO', 'Spar Oudtshoorn') && !namesMatch_('Engen Rainbow Motors', 'Shell Garage') && namesMatch_('BUILDERS', 'Builders Warehouse (Pty) Ltd') && !namesMatch_('The Hardware Store', 'Hardware Supplies'), '');

// upload: permissions and validation
const po = mkPO(123.45).data;
const po2 = mkPO(650).data;   // over the R500 limit -> awaiting approval
check('setup: one issued PO and one awaiting approval', po.status === 'ISSUED' && po2.status === 'AWAITING_APPROVAL', JSON.stringify([po.status, po2.status]));
const other = createUser('Other Buyer', 'other@po-desk.test', 'buyer'); grantEntity_(other.user_id, 'NHP', true, false, 100, true);
const otok = createSession_(other.user_id);
const bad = [
  ['another buyer’s PO', call('uploadSlip', { poId: po.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' }, otok), 'NOT_FOUND'],
  ['PO awaiting approval', call('uploadSlip', { poId: po2.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' }), 'BAD_REQUEST'],
  ['PNG declared', call('uploadSlip', { poId: po.poId, imageBase64: jpeg(), mimeType: 'image/png' }), 'BAD_REQUEST'],
  ['not a JPEG inside', call('uploadSlip', { poId: po.poId, imageBase64: Utilities.base64Encode(Array(3000).fill(65)), mimeType: 'image/jpeg' }), 'BAD_REQUEST'],
  ['too large', call('uploadSlip', { poId: po.poId, imageBase64: 'A'.repeat(8.5 * 1024 * 1024), mimeType: 'image/jpeg' }), 'TOO_LARGE'],
];
bad.forEach(b => check('uploadSlip refused: ' + b[0] + ' -> ' + b[2], !b[1].ok && b[1].error.code === b[2], JSON.stringify(b[1]).slice(0, 200)));
const up = call('uploadSlip', { poId: po.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' });
const f1 = drive.files[MEM.Bills[0] && MEM.Bills[0].drive_file_id];
//console.log('DEBUG bills=' + MEM.Bills.length + ' month=' + (f1 && f1.folder.name) + ' year=' + (f1 && f1.folder.parent && f1.folder.parent.name) + ' ent=' + (f1 && f1.folder.parent && f1.folder.parent.parent && f1.folder.parent.parent.name) + ' same=' + (f1 && f1.folder.parent.parent === entFolders.NHP));
check('upload saves to PO Desk/NHP/<YYYY>/<MM> as <PO>_<date>_<supplier>_unreviewed.jpg with a draft Bills row', up.ok && MEM.Bills.length === 1 && f1 && /^PO-0\\d+_\\d{4}-\\d{2}-\\d{2}_Engen-Rainbow-Motors_unreviewed\\.jpg$/.test(f1.name) && f1.folder.parent.parent === entFolders.NHP && /^\\d{2}$/.test(f1.folder.name), JSON.stringify(up) + ' ' + (f1 && f1.name));

// read: success
setGemini('ok', ANSWER);
const rd = call('readSlip', { billId: up.data.billId });
check('readSlip: fields, low-confidence list and flags returned; ocr_json stored', rd.ok && rd.data.status === 'ok' && rd.data.fields.totalIncl === 123.45 && rd.data.lowConfidence.includes('slipNumber') && JSON.parse(MEM.Bills[0].ocr_json).status === 'ok', JSON.stringify(rd).slice(0, 300));
const g0 = geminiCalls()[0];
check('Gemini request: inline JPEG, temperature 0, JSON schema, key in header (not URL)', g0.body.contents[0].parts[0].inlineData.mimeType === 'image/jpeg' && g0.body.generationConfig.temperature === 0 && g0.body.generationConfig.responseMimeType === 'application/json' && g0.body.generationConfig.responseJsonSchema.required.includes('total_incl') && g0.key === 'gk' && !/key=/.test(g0.url) && /gemini-3\\.6-flash:generateContent$/.test(g0.url), JSON.stringify(g0.url));
check('no CLAUDE.md flags for a clean slip matching the PO (the fixture slip is dated 4 Nov 2026, so a date gap is expected on later days)', rd.data.flags.filter(x => x.code !== 'DATE_GAP').length === 0, JSON.stringify(rd.data.flags));

// read: every failure becomes "manual", with the PO supplier prefilled
[['429 quota', '429', /reached its limit/], ['outage (500 twice)', '500', /unavailable/], ['blocked answer', 'blocked', /could not be read/], ['unparseable JSON', 'badjson', /could not be read/]].forEach(t => {
  setGemini(t[1]);
  const r = call('readSlip', { billId: up.data.billId });
  check('readSlip ' + t[0] + ' -> manual, buyer types (supplier prefilled)', r.ok && r.data.status === 'manual' && t[2].test(r.data.reason) && r.data.fields.supplierName === 'Engen Rainbow Motors' && r.data.fields.totalIncl === null, JSON.stringify(r).slice(0, 250));
});
setGemini('500then200', ANSWER); const r5 = call('readSlip', { billId: up.data.billId });
check('one 5xx is retried and then succeeds', r5.ok && r5.data.status === 'ok', JSON.stringify(r5).slice(0, 200));
setGemini('oldschema', ANSWER); const r6 = call('readSlip', { billId: up.data.billId });
const lastGc = geminiCalls()[geminiCalls().length - 1].body.generationConfig;
check('API that rejects responseJsonSchema -> retried with responseSchema', r6.ok && r6.data.status === 'ok' && lastGc.responseSchema && !lastGc.responseJsonSchema, JSON.stringify(r6).slice(0, 200));
armGeminiFailure(); setGemini('ok', ANSWER);
const r7 = call('readSlip', { billId: up.data.billId });
check('armGeminiFailure -> next read is manual, then normal again', r7.data.status === 'manual' && /forced/.test(r7.data.reason) && call('readSlip', { billId: up.data.billId }).data.status === 'ok', JSON.stringify(r7.data.reason));
props.delete('GEMINI_API_KEY');
check('no Gemini key -> manual', call('readSlip', { billId: up.data.billId }).data.status === 'manual', '');
props.set('GEMINI_API_KEY', 'gk');

// save review: validation and flags (read once more first: the last read above had no key)
setGemini('ok', ANSWER); call('readSlip', { billId: up.data.billId });
const fields = Object.assign({}, rd.data.fields);
const sv = call('saveSlipReview', { billId: up.data.billId, fields });
const b0 = MEM.Bills[0];
check('saveSlipReview stores reviewed values and renames to <PO>_<slip date>_<supplier>_<total>.jpg', sv.ok && b0.total_incl_zar === 123.45 && b0.supplier_vat_no === '4123456789' && f1.name === po.poNumber + '_2026-11-04_Engen-Rainbow-Motors_123.45.jpg' && JSON.parse(b0.ocr_json).source === 'gemini', JSON.stringify(sv) + ' ' + f1.name);
const badSaves = [
  ['VAT number not SA format', { supplierVatNumber: '12345' }],
  ['no date', { date: '' }],
  ['future date', { date: '2030-01-01' }],
  ['zero total', { totalIncl: 0 }],
  ['VAT above total', { vatAmount: 500 }],
  ['line without amount', { lineItems: [{ description: 'x', qty: 1, lineTotalIncl: null }] }],
];
badSaves.forEach(b => { const r = call('saveSlipReview', { billId: up.data.billId, fields: Object.assign({}, fields, b[1]) }); check('saveSlipReview refuses ' + b[0], !r.ok && r.error.code === 'BAD_REQUEST', JSON.stringify(r).slice(0, 150)); });
const flagged = call('saveSlipReview', { billId: up.data.billId, fields: Object.assign({}, fields, { supplierName: 'Shell Ultra City', supplierVatNumber: '', totalIncl: 5600, vatAmount: null, date: '2026-10-25', lineItems: [] }) });
const codes = flagged.ok ? flagged.data.flags.map(f => f.code).sort().join() : '';
check('all CLAUDE.md flags raised (variance, supplier, no VAT no, full tax invoice, date gap) and stored', codes === 'DATE_GAP,FULL_TAX_INVOICE,NO_VAT_NUMBER,SUPPLIER_MISMATCH,VARIANCE' && JSON.parse(MEM.Bills[0].flags).length === 5, codes + ' ' + JSON.stringify(flagged).slice(0, 200));
call('saveSlipReview', { billId: up.data.billId, fields });   // back to the clean values

// duplicate on a second PO from the same supplier
const po3 = mkPO(123.45).data;
const up3 = call('uploadSlip', { poId: po3.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' });
setGemini('ok', ANSWER);
const rd3 = call('readSlip', { billId: up3.data.billId });
check('same supplier + slip number on another PO -> DUPLICATE flag naming the first PO', rd3.data.flags.some(f => f.code === 'DUPLICATE' && f.message.includes(po.poNumber)), JSON.stringify(rd3.data.flags));

// retake replaces the photo, trashes the old one and clears what was read
const firstFile = MEM.Bills.find(b => b.bill_id === up3.data.billId).drive_file_id;
const up4 = call('uploadSlip', { poId: po3.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' });
const b4 = MEM.Bills.find(b => b.bill_id === up3.data.billId);
check('retake: same draft bill, new photo, old photo in the bin, OCR cleared', up4.data.billId === up3.data.billId && b4.drive_file_id !== firstFile && drive.files[firstFile].trashed && b4.ocr_json === '', '');

// manual path end to end
armGeminiFailure();
const rm = call('readSlip', { billId: up3.data.billId });
const typed = Object.assign({}, rm.data.fields, { date: '2026-11-04', totalIncl: '118,90', slipNumber: 'T 004513' });
const sm = call('saveSlipReview', { billId: up3.data.billId, fields: typed });
check('Gemini down -> buyer types the values (comma decimal accepted) and saves', rm.data.status === 'manual' && sm.ok && MEM.Bills.find(b => b.bill_id === up3.data.billId).total_incl_zar === 118.9 && JSON.parse(MEM.Bills.find(b => b.bill_id === up3.data.billId).ocr_json).source === 'manual', JSON.stringify(sm).slice(0, 200));

// views
const gp = call('getPO', { poId: po.poId });
check('getPO shows the slip as reviewed', gp.ok && gp.data.slip && gp.data.slip.reviewed === true && gp.data.slip.billId === up.data.billId, JSON.stringify(gp.data && gp.data.slip));
const gs = call('getSlip', { billId: up.data.billId, withImage: true });
check('getSlip returns reviewed values and the image', gs.ok && gs.data.status === 'reviewed' && gs.data.fields.totalIncl === 123.45 && gs.data.image.base64.length > 100, JSON.stringify(gs).slice(0, 150));
check('another buyer cannot read or save my slip', call('getSlip', { billId: up.data.billId }, otok).error.code === 'NOT_FOUND' && call('saveSlipReview', { billId: up.data.billId, fields }, otok).error.code === 'NOT_FOUND', '');

// --- slip accuracy test: HTTP detail in the reason, re-read only failed slips, "ok" truths survive a re-read ---
const grid = { v: [] };
const rng = (r, c, nr, nc) => { const o = {
  getValues: () => grid.v.slice(r - 1, r - 1 + nr).map(row => Array.from({ length: nc }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j]))),
  setValues: vals => { vals.forEach((row, i) => { grid.v[r - 1 + i] = grid.v[r - 1 + i] || []; row.forEach((x, j) => { grid.v[r - 1 + i][c - 1 + j] = x; }); }); return o; },
  setNumberFormat: () => o, setFontWeight: () => o }; return o; };
const fakeSheet = { getLastRow: () => grid.v.length, getLastColumn: () => grid.v.reduce((m, row) => Math.max(m, row.length), 0), getRange: rng, clear: () => { grid.v = []; }, setFrozenRows: () => {} };
db_ = () => ({ getSheetByName: n => (n === SLIP_TEST_TAB && grid.v.length ? fakeSheet : null), insertSheet: () => fakeSheet });
const rootF = DriveApp.getFolderById(entFolders.NHP.id).createFolder('root'); props.set('DRIVE_ROOT_ID', rootF.getId());
const testF = rootF.createFolder('_test');
['a.jpg', 'b.jpg', 'c.jpg'].forEach(n => testF.createFile(Utilities.newBlob([0xff, 0xd8, 0xff, 0xe0].concat(Array(3000).fill(7)).map(x => x > 127 ? x - 256 : x), 'image/jpeg', n)));
testF.createFile(Utilities.newBlob([1, 2, 3], 'text/plain', 'notes.txt'));
const rowOf = f => { const h = grid.v[0]; const r = grid.v.find(x => x[0] === f); const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; };
const setCell = (f, col, v) => { grid.v.find(x => x[0] === f)[grid.v[0].indexOf(col)] = v; };
setGemini('ok', ANSWER); geminiQueue.length = 0; geminiQueue.push('ok', '503', '503', 'ok');
let g = geminiCalls().length;
runSlipTest();
const ra = rowOf('a.jpg'), rb = rowOf('b.jpg');
check('runSlipTest: 3 images read (text file skipped), the 503 slip says why in the reason column', grid.v.length === 4 && ra.status === 'ok' && rowOf('c.jpg').status === 'ok' && rb.status === 'manual' && /\\[HTTP 503 UNAVAILABLE: The model is overloaded/.test(rb.reason) && geminiCalls().length - g === 4, JSON.stringify(rb.reason) + ' ' + (geminiCalls().length - g));
check('the HTTP error is in the audit log too', MEM.AuditLog.some(a => a.action === 'ocr.extract' && !a.ok && /overloaded/.test(a.detail_json)), '');
setCell('a.jpg', 'true_supplier', 'ok'); setCell('a.jpg', 'true_date', 'ok'); setCell('a.jpg', 'true_total', 'OK');
setCell('b.jpg', 'true_supplier', 'Engen Rainbow Motors'); setCell('b.jpg', 'true_date', '04/11/2026'); setCell('b.jpg', 'true_total', '123.45');
const aBefore = JSON.stringify(grid.v.find(x => x[0] === 'a.jpg'));
g = geminiCalls().length;
rerunFailedSlips();
check('rerunFailedSlips: only the manual slip is read again; other rows unchanged; typed truths kept', geminiCalls().length - g === 1 && rowOf('b.jpg').status === 'ok' && rowOf('b.jpg').reason === '' && rowOf('b.jpg').true_date === '04/11/2026' && JSON.stringify(grid.v.find(x => x[0] === 'a.jpg')) === aBefore && rowOf('a.jpg').true_total === 'OK', JSON.stringify(rowOf('b.jpg')));
g = geminiCalls().length;
rerunFailedSlips();
check('rerunFailedSlips with nothing failed: no Gemini calls, sheet untouched', geminiCalls().length === g && grid.v.length === 4 && /nothing to re-read/.test(logs[logs.length - 1]), logs[logs.length - 1]);
setGemini('ok', Object.assign({}, ANSWER, { total_incl: 999 }));
runSlipTest();
check('full re-run: "ok" becomes the value it vouched for, so a changed read scores as wrong', rowOf('a.jpg').true_total === '123.45' && rowOf('a.jpg').true_supplier === 'ENGEN RAINBOW MOTORS' && rowOf('a.jpg').total === '999', JSON.stringify(rowOf('a.jpg')));
scoreSlipTest();
check('scoreSlipTest after the re-run: a and b scored, c (no truths) left out', /all right on 0 of 2 slips/.test(logs[logs.length - 1]), logs[logs.length - 1].slice(0, 300));
setGemini('ok', ANSWER);

cleanupTestPOs();
check('cleanup removes the test slips (photos in the bin, Bills rows gone)', MEM.Bills.length === 0 && Object.values(drive.files).filter(f => f.folder.name !== "_test").every(f => f.trashed) && Object.values(drive.files).filter(f => f.folder.name === "_test").every(f => !f.trashed), JSON.stringify(MEM.Bills.length));
console.log('=== Stage 5 offline: ' + P.filter(x => x.startsWith('FAIL')).length + ' failure(s) of ' + P.length + ' ===\\n' + P.join('\\n'));
`, ctx);
console.log(logs.filter(l => !l.startsWith('WARN AppError') && !l.startsWith('AUDIT')).join('\n'));
