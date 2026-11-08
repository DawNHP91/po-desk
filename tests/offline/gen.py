"""Builds tests/offline/build/harness.js: base.js (Stage 5 fakes and checks) + the fake Xero for bills
(fake6-*.js) + the Stage 6, 7 and 9 checks. Run with tests/offline/run.sh."""
import sys
S = sys.argv[1]
s = open(S + '/base.js').read()
def rep(old, new):
    global s
    assert s.count(old) == 1, (old[:100], s.count(old))
    s = s.replace(old, new)
rep("const X = { [NHP]: { contacts: [{ ContactID: 'aaaaaaaa-0000-4000-8000-000000000001', Name: 'PO Desk Test Supplier', ContactStatus: 'ARCHIVED', IsSupplier: true }], pos: [] }, [HPB]: { contacts: [], pos: [] } };",
    "const X = { [NHP]: { contacts: [{ ContactID: 'aaaaaaaa-0000-4000-8000-000000000001', Name: 'PO Desk Test Supplier', ContactStatus: 'ARCHIVED', IsSupplier: true }], pos: [], invoices: [], att: {}, history: [], idem: {} }, [HPB]: { contacts: [], pos: [], invoices: [], att: {}, history: [], idem: {} } };\nX['7f209224-7389-441c-ab85-e52a8a393601'] = { contacts: [], pos: [], invoices: [], att: {}, history: [], idem: {} };\nconst faults = []; const xflags = {}; const idemSeen = [];")
rep("function fakeXero(tenant, method, path, body) {\n  const st = X[tenant]; if (!st) return { status: 403, data: { Message: 'no tenant' } };",
open(S + '/fake6-head.js').read())
rep("""  return { status: 404, data: { Message: 'unhandled ' + method + ' ' + path } };
}""", open(S + '/fake6-routes.js').read())
rep("  if (slug === 'XERO_UPDATE_PURCHASE_ORDER') { const p = st.pos.find(x => x.PurchaseOrderID === a.purchase_order_id); Object.assign(p, a.Status ? { Status: a.Status } : {}); return { PurchaseOrders: [p] }; }",
    "  if (slug === 'XERO_UPDATE_PURCHASE_ORDER') { const p = st.pos.find(x => x.PurchaseOrderID === a.purchase_order_id); if (a.Status === 'DELETED' && p.Status === 'BILLED') throw new Error('A billed PO cannot be deleted.'); Object.assign(p, a.Status ? { Status: a.Status } : {}); return { PurchaseOrders: [p] }; }")
rep("      const r = fakeXero(tenant, b.method, b.endpoint.replace('https://api.xero.com/api.xro/2.0', ''), b.body);",
    "      const r = fakeXero(tenant, b.method, b.endpoint.replace('https://api.xero.com/api.xro/2.0', ''), b.body, b);")
rep("  UrlFetchApp: { fetchAll(reqs) { sheetsCalls++; return reqs.map(r => { if (process.env.SHEETS_DOWN) return resp(503, { error: 'down' }); return resp(200, fakeSheets(ctx, r.url, r)); }); }, fetch(url, opt) {",
    "  UrlFetchApp: { fetchAll(reqs) { if (reqs.some(r => !/tools\\/execute\\/proxy$/.test(r.url))) sheetsCalls++; return reqs.map(r => { if (/tools\\/execute\\/proxy$/.test(r.url)) { parallelCalls.push(JSON.parse(r.payload).endpoint); return ctx.UrlFetchApp.fetch(r.url, r); } if (process.env.SHEETS_DOWN) return resp(503, { error: 'down' }); return resp(200, fakeSheets(ctx, r.url, r)); }); }, fetch(url, opt) {")
rep("let poSeq = 200, xeroCalls = [];", "let poSeq = 200, xeroCalls = []; const parallelCalls = [];")
rep("    getId() { return this.id; }, getName() { return this.name; }, setName(n) { this.name = n; return this; }, setTrashed(t) { this.trashed = t; return this; }, getMimeType() { return this.mime; },",
    "    getId() { return this.id; }, getName() { return this.name; }, setName(n) { this.name = n; return this; }, setTrashed(t) { this.trashed = t; return this; }, getMimeType() { return this.mime; }, sharing: 'PRIVATE', getSharingAccess() { return this.sharing; }, setSharing(a) { this.sharing = a; return this; },")
rep("  DriveApp: { getFolderById: id => drive.folders[id],", "  DriveApp: { Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { NONE: 'NONE', VIEW: 'VIEW' }, getFolderById: id => drive.folders[id],")
rep("ctx.X = X;", "ctx.X = X; ctx.faults = faults; ctx.xflags = xflags; ctx.idemSeen = idemSeen; ctx.parallelCalls = parallelCalls;")
tests = '\n'.join(open(S + '/' + f).read() for f in ['stage6-tests.js', 'stage7-tests.js', 'stage9-tests.js'] if __import__('os').path.exists(S + '/' + f))
marker = "\ncleanupTestPOs();\n"
rep(marker, "\n" + tests + marker)
rep("check('cleanup removes the test slips", "check('cleanup deletes the test bills in Xero first, then the (billed) POs; a real person’s PO is left alone', tNHP.invoices.every(i => i.Status === 'DELETED') && tNHP.pos.every(p => p.Status === 'DELETED' || (MEM.POs.find(x => x.xero_po_id === p.PurchaseOrderID) || {}).buyer_user_id === admin.user_id) && tNHP.pos.some(p => p.Status === 'AUTHORISED'), JSON.stringify(tNHP.invoices.map(i => i.Status)) + JSON.stringify(tNHP.pos.map(p => p.Status)));\ncheck('cleanup removes the test slips")
rep("console.log('=== Stage 5 offline: '", "console.log('=== PO Desk offline (Stages 5-9): '")
open(S + '/build/harness.js', 'w').write(s)
print('written')
