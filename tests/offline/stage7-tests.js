// ===================== Stage 7: approvals, people, jobs =====================
{
const tNHP7 = X[entityById_('NHP').xero_tenant_id];
const login = (email, pin) => call('login', { email: email, pin: pin }, '');
const tokFor = (email) => { const r = login(email, '565056'); if (!r.ok) throw new Error('login ' + email + ': ' + JSON.stringify(r.error)); return r.data.token; };
const freshPO = (amount, t) => { CacheService.getScriptCache().removeAll([rateKey_('po', buyer.user_id, PO_RULES.RATE_WINDOW_S), rateKey_('po', admin.user_id, PO_RULES.RATE_WINDOW_S)]); return call('createPO', { entityId: 'NHP', pmId: card.pm_id, contactId: engen, description: 'Stage 7 test', amountInclZar: amount, accountCode: '433' }, t).data; };
const callIdem = (action, payload, t) => JSON.parse(doPost({ postData: { contents: JSON.stringify({ action, token: t || tok, payload, idemKey: Utilities.getUuid() }) } }).getContent());
const mails = (re) => sent.filter(m => re.test(m.subject));
const atok = createSession_(admin.user_id);
const ec = (r) => (r && r.error ? r.error.code : 'OK');

// UAT accounts
props.set('UAT_PIN', '565056');
createUatAccounts();
const appr = findUserByEmail_('test.approver@po-desk.test');
check('createUatAccounts: 3 test buyers and one approver of all three companies, shared PIN works, UAT_PIN deleted',
  UAT_ACCOUNTS.every(a => findUserByEmail_(a.email) && isTrue_(findUserByEmail_(a.email).active)) && ['HPB', 'NHP', 'PK'].every(e => grantsFor_(appr.user_id)[e] && grantsFor_(appr.user_id)[e].canApprove && !grantsFor_(appr.user_id)[e].canBuy) && login('test.buyer.pk@po-desk.test', '565056').ok && !props.has('UAT_PIN'), '');
const aptok = tokFor('test.approver@po-desk.test');

// approvals: email with link, list, approve, decline
const before = sent.length;
const big = freshPO(650);
const link = 'https://po.pharmakaru.co.za/#/approvals/' + big.poId;
check('over-limit PO: AWAITING_APPROVAL; approvers emailed with a link straight to the item (test approver skipped: .test)', big.status === 'AWAITING_APPROVAL' && sent.slice(before).some(m => m.to === 'dawie@nhpglobalgroup.com' && m.body.indexOf(link) !== -1) && !sent.slice(before).some(m => /\.test$/.test(m.to)), JSON.stringify(sent.slice(before)).slice(0, 300));
const la = call('listApprovals', {}, aptok);
const item = la.ok && la.data.items.find(i => i.poId === big.poId);
check('listApprovals (approver): the PO with buyer, limit, company and waiting time', !!item && item.buyerName === 'Test Buyer NHP' && item.buyerLimitZar === 500 && item.company === 'NHP Global' && item.own === false && typeof item.waitingWorkMinutes === 'number', JSON.stringify(la).slice(0, 300));
check('listApprovals refused for a buyer who can’t approve', ec(call('listApprovals', {}, tok)) === 'FORBIDDEN', '');
const ap = call('decidePO', { poId: big.poId, decision: 'approve', note: 'OK for the stock-take' }, aptok);
const bigRow = MEM.POs.find(p => p.po_id === big.poId);
const bigX = tNHP7.pos.find(p => p.PurchaseOrderID === bigRow.xero_po_id);
check('approve: Xero PO AUTHORISED, row ISSUED with approver, time and note; History note in Xero; buyer sees who approved', ap.ok && ap.data.status === 'ISSUED' && bigX.Status === 'AUTHORISED' && bigRow.status === 'ISSUED' && bigRow.approver_user_id === appr.user_id && bigRow.decided_at && bigRow.decision_note === 'OK for the stock-take' && tNHP7.history.some(x => x.id === bigX.PurchaseOrderID && /approved by Test Approver/.test(x.text)) && call('getPO', { poId: big.poId }).data.decision.by === 'Test Approver', JSON.stringify(ap));
check('deciding again: "already decided", nothing changes', ec(call('decidePO', { poId: big.poId, decision: 'decline' }, aptok)) === 'ALREADY_DECIDED' && bigX.Status === 'AUTHORISED', '');
const dec = freshPO(700);
const rd7 = call('decidePO', { poId: dec.poId, decision: 'decline', note: 'Use the existing stock' }, aptok);
const decRow = MEM.POs.find(p => p.po_id === dec.poId);
check('decline: Xero PO DELETED, row DECLINED with the note', rd7.ok && rd7.data.status === 'DECLINED' && tNHP7.pos.find(p => p.PurchaseOrderID === decRow.xero_po_id).Status === 'DELETED' && decRow.decision_note === 'Use the existing stock' && call('getPO', { poId: dec.poId }).data.decision.note === 'Use the existing stock', JSON.stringify(rd7));
const hpbOnly = createUser('HPB Approver', 'hpb.approver@po-desk.test', 'approver'); grantEntity_(hpbOnly.user_id, 'HPB', false, true, 0, true);
const hpbTok = createSession_(hpbOnly.user_id);
const nhpPending = freshPO(720);
check('an approver of another company can’t see or decide it (NOT_FOUND, not in their list)', ec(call('decidePO', { poId: nhpPending.poId, decision: 'approve' }, hpbTok)) === 'NOT_FOUND' && !call('listApprovals', {}, hpbTok).data.items.some(i => i.poId === nhpPending.poId), '');
faults.push({ method: 'POST', re: /^\\/PurchaseOrders\\/[0-9a-f-]{36}$/, status: 503, times: 3 });
const down = call('decidePO', { poId: nhpPending.poId, decision: 'approve' }, aptok);
check('Xero down while approving: clear message, nothing changed (still waiting)', !down.ok && down.error.code === 'XERO_DOWN' && MEM.POs.find(p => p.po_id === nhpPending.poId).status === 'AWAITING_APPROVAL', JSON.stringify(down));

// own POs
const adminPO = freshPO(2000, atok);
check('own PO with another approver around: not in my list, and refused if I try', !call('listApprovals', {}, atok).data.items.some(i => i.poId === adminPO.poId) && ec(call('decidePO', { poId: adminPO.poId, decision: 'approve' }, atok)) === 'FORBIDDEN', '');
call('setPersonActive', { userId: appr.user_id, active: false }, atok);
const alone = call('listApprovals', {}, atok).data.items.find(i => i.poId === adminPO.poId);
const selfOk = call('decidePO', { poId: adminPO.poId, decision: 'approve' }, atok);
check('admin and no other approver: own PO listed as own, approval allowed and marked self-approved (History note too)', !!alone && alone.own === true && selfOk.ok && selfOk.data.self === true && call('getPO', { poId: adminPO.poId }, atok).data.decision.self === true && tNHP7.history.some(x => /self-approved/.test(x.text)), JSON.stringify(selfOk));
const lone = notifyApprovers_(MEM.POs.find(p => p.po_id === adminPO.poId), admin, null);
check('when nobody else can approve, the admin buyer is told they may self-approve', /approve this one yourself/.test(lone.warning), JSON.stringify(lone));
call('setPersonActive', { userId: appr.user_id, active: true }, atok);

// reminders after 4 working hours
check('working minutes: Fri 15:00 -> Mon 10:00 = 240; a weekend = 0; Mon 07:00 -> 18:00 = 540',
  workingMinutesBetween_(new Date('2026-11-06T15:00:00+02:00'), new Date('2026-11-09T10:00:00+02:00')) === 240 &&
  workingMinutesBetween_(new Date('2026-11-07T09:00:00+02:00'), new Date('2026-11-08T17:00:00+02:00')) === 0 &&
  workingMinutesBetween_(new Date('2026-11-09T07:00:00+02:00'), new Date('2026-11-09T18:00:00+02:00')) === 540, '');
const old = freshPO(800);
const oldRow = MEM.POs.find(p => p.po_id === old.poId);
oldRow.created_at = new Date(Date.now() - 7 * 86400000);
const fresh2 = freshPO(810);
let s0 = sent.length;
processQueue();
const rem = sent.slice(s0).filter(m => /^Reminder: /.test(m.subject));
check('processQueue sends ONE reminder for a PO waiting > 4 working hours (with the link), none for a new one', rem.length === 1 && rem[0].subject.indexOf(oldRow.po_number) !== -1 && rem[0].body.indexOf('#/approvals/' + old.poId) !== -1 && oldRow.reminded_at && !MEM.POs.find(p => p.po_id === fresh2.poId).reminded_at, JSON.stringify(rem).slice(0, 300));
s0 = sent.length; processQueue(); processQueue();
check('two more runs (e.g. a duplicate trigger): no second reminder', sent.slice(s0).filter(m => /^Reminder: /.test(m.subject)).length === 0, '');

// people admin
const aptok2 = tokFor('test.approver@po-desk.test');   // the deactivate/reactivate above ended the old session
const later = (ms) => { const u = Date.now() + ms; while (Date.now() < u) { /* sessions must start after sessions_valid_from */ } };
check('non-admins are refused every admin action (buyer and approver)', ['listPeople', 'savePerson', 'resetPin', 'setPersonActive'].every(a => ec(call(a, { userId: admin.user_id, name: 'X Y', email: 'x@y.co', role: 'admin', active: false }, tok)) === 'FORBIDDEN' && ec(call(a, { userId: admin.user_id, name: 'X Y', email: 'x@y.co', role: 'admin', active: false }, aptok2)) === 'FORBIDDEN'), '');
s0 = sent.length;
const np = call('savePerson', { name: 'Dawie UAT', email: 'Dawie@PharmaKaru.co.za', role: 'buyer', companies: [{ entityId: 'NHP', canBuy: true, canApprove: false, poLimitZar: '800' }, { entityId: 'PK', canBuy: true, canApprove: false, poLimitZar: 300 }, { entityId: 'HPB', canBuy: false, canApprove: false, poLimitZar: 0 }] }, atok);
const welcome = sent.slice(s0).find(m => m.to === 'dawie@pharmakaru.co.za');
const tokenM = welcome && /#\\/set-pin\\?t=([0-9a-f]{64})/.exec(welcome.body);
const uRow = findUserByEmail_('dawie@pharmakaru.co.za');
check('add a person: Users + UserEntities written, email lower-cased, Set PIN link emailed; only the token’s SHA-256 stored, 48 h expiry',
  np.ok && np.data.created && uRow && uRow.role === 'buyer' && !uRow.pin_hash && grantsFor_(uRow.user_id).NHP.poLimitZar === 800 && grantsFor_(uRow.user_id).PK.canBuy && !grantsFor_(uRow.user_id).HPB && tokenM &&
  uRow.pin_token_hash === sha256Hex_(tokenM[1]) && JSON.stringify(uRow).indexOf(tokenM[1]) === -1 && Math.abs(new Date(uRow.pin_token_expires) - Date.now() - 48 * 3600e3) < 60000 && /set your PIN/.test(welcome.subject),
  JSON.stringify(np).slice(0, 300));
check('emails are unique (case-insensitive)', ec(call('savePerson', { name: 'Someone Else', email: 'DAWIE@pharmakaru.co.za', role: 'buyer', companies: [] }, atok)) === 'EMAIL_TAKEN', '');
const t1 = tokenM[1];
const ck = call('checkPinToken', { token: t1 }, '');
check('Set PIN link: checks out with the person’s first name; mismatched and weak PINs are refused', ck.ok && ck.data.firstName === 'Dawie' && ec(call('setPinWithToken', { token: t1, pin: '482916', pin2: '482917' }, '')) === 'BAD_REQUEST' && ec(call('setPinWithToken', { token: t1, pin: '123456', pin2: '123456' }, '')) === 'BAD_REQUEST', JSON.stringify(ck));
const setOk = call('setPinWithToken', { token: t1, pin: '482916', pin2: '482916' }, '');
check('PIN saved hashed, link burnt: the person signs in; the same link then fails', setOk.ok && login('dawie@pharmakaru.co.za', '482916').ok && findUserByEmail_('dawie@pharmakaru.co.za').pin_hash !== '482916' && !findUserByEmail_('dawie@pharmakaru.co.za').pin_token_hash && ec(call('setPinWithToken', { token: t1, pin: '493827', pin2: '493827' }, '')) === 'PIN_LINK_INVALID' && ec(call('checkPinToken', { token: t1 }, '')) === 'PIN_LINK_INVALID', JSON.stringify(setOk));
const utok = login('dawie@pharmakaru.co.za', '482916').data.token;
s0 = sent.length;
const rs = call('resetPin', { userId: uRow.user_id }, atok);
const t2 = (/#\\/set-pin\\?t=([0-9a-f]{64})/.exec((sent.slice(s0).find(m => m.to === 'dawie@pharmakaru.co.za') || {}).body || '') || [])[1];
check('Reset PIN: new link emailed, the old PIN stops working at once and open sessions end', rs.ok && t2 && t2 !== t1 && ec(login('dawie@pharmakaru.co.za', '482916')) === 'LOGIN_FAILED' && ec(call('me', {}, utok)) === 'AUTH_REQUIRED' && /new PIN/.test(sent.slice(s0)[0].subject), JSON.stringify(rs));
const exp = findUserByEmail_('dawie@pharmakaru.co.za'); exp.pin_token_expires = new Date(Date.now() - 1000);
check('an expired link is refused', ec(call('checkPinToken', { token: t2 }, '')) === 'PIN_LINK_INVALID', '');
exp.pin_token_expires = new Date(Date.now() + 3600e3);
call('setPinWithToken', { token: t2, pin: '593817', pin2: '593817' }, '');
const utok2 = login('dawie@pharmakaru.co.za', '593817').data.token;
const deact = call('setPersonActive', { userId: uRow.user_id, active: false }, atok);
check('deactivate: their session ends at once, sign-in is refused, their row and POs stay', deact.ok && deact.data.person.active === false && ec(call('me', {}, utok2)) === 'AUTH_REQUIRED' && !login('dawie@pharmakaru.co.za', '593817').ok && !!findUserByEmail_('dawie@pharmakaru.co.za'), JSON.stringify(deact));
const react = call('setPersonActive', { userId: uRow.user_id, active: true }, atok);
check('reactivate: they can sign in again (old sessions stay ended)', react.ok && login('dawie@pharmakaru.co.za', '593817').ok && ec(call('me', {}, utok2)) === 'AUTH_REQUIRED', '');
check('last active admin: can’t be demoted, can’t deactivate themselves', ec(call('savePerson', { userId: admin.user_id, name: admin.name, email: admin.email, role: 'buyer', companies: [] }, atok)) === 'LAST_ADMIN' && ec(call('setPersonActive', { userId: admin.user_id, active: false }, atok)) === 'BAD_REQUEST', '');
const ad2 = call('savePerson', { name: 'Second Admin', email: 'admin2@po-desk.test', role: 'admin', companies: [] }, atok);
later(3);
const a2tok = createSession_(ad2.data.person.userId);
const dA = call('setPersonActive', { userId: admin.user_id, active: false }, a2tok);
check('with two admins one may deactivate the other; the one left can’t be demoted', dA.ok && ec(call('savePerson', { userId: ad2.data.person.userId, name: 'Second Admin', email: 'admin2@po-desk.test', role: 'buyer', companies: [] }, a2tok)) === 'LAST_ADMIN', JSON.stringify(dA));
call('setPersonActive', { userId: admin.user_id, active: true }, a2tok);
later(3);
const atok3 = createSession_(admin.user_id);
const ed = call('savePerson', { userId: uRow.user_id, name: 'Dawie UAT', email: 'dawie@pharmakaru.co.za', role: 'buyer', companies: [{ entityId: 'NHP', canBuy: true, canApprove: true, poLimitZar: 950 }] }, atok3);
check('edit grants: limit and approve right change; AuditLog has create, update, pin link, deactivate, reactivate', ed.ok && grantsFor_(uRow.user_id).NHP.poLimitZar === 950 && grantsFor_(uRow.user_id).NHP.canApprove && ['user.create', 'user.update', 'pin.link', 'user.deactivate', 'user.reactivate'].every(a => MEM.AuditLog.some(x => x.action === a)), JSON.stringify(ed).slice(0, 200));
const lp = call('listPeople', {}, atok3);
check('listPeople: everyone with role, companies and status; never a PIN, hash or token', lp.ok && lp.data.people.length === MEM.Users.length && lp.data.people.every(p => p.companies.length === 3) && !/pin_hash|pin_salt|pin_token|[0-9a-f]{64}/.test(JSON.stringify(lp)), '');

// digest
const yRow = MEM.POs.find(p => p.po_id === fresh2.poId); yRow.created_at = new Date(Date.now() - 86400000);
const openRow = MEM.POs.find(p => p.po_id === big.poId); openRow.created_at = new Date(Date.now() - 5 * 86400000);
const flagBill = MEM.Bills.find(b => b.status === 'BILLED' && b.flags && b.flags !== '[]');
if (flagBill) { const st = JSON.parse(flagBill.steps_json); st.startedAt = new Date(Date.now() - 86400000).toISOString(); flagBill.steps_json = JSON.stringify(st); }
armForcedPOFailure(); const prov = freshPO(120);
const dg = digest_(new Date());
const nhpSec = dg.body.split('== NHP Global ==')[1].split('== ')[0];
check('digest per company: issued yesterday, open > 3 days without a slip (by buyer), provisional refs, bills with notes, waiting for approval',
  /Issued yesterday: 1/.test(nhpSec) && nhpSec.indexOf(yRow.po_number) !== -1 && /Open more than 3 days without a slip: 1/.test(nhpSec) && /Test Buyer NHP:\\n {4}PO-/.test(nhpSec) && nhpSec.indexOf(prov.provisionalRef) !== -1 && (!flagBill || /Bills from yesterday with notes: [1-9]/.test(nhpSec)) && /Waiting for approval: [1-9]/.test(nhpSec) && /== HP Biotech ==/.test(dg.body) && /== Pharma Karu ==/.test(dg.body),
  dg.body.slice(0, 1500));
s0 = sent.length;
const d1 = dailyDigest(), d2 = dailyDigest();
check('dailyDigest: sent once to each active admin; a second run the same day sends nothing', sent.slice(s0).filter(m => /^PO Desk daily/.test(m.subject)).length === MEM.Users.filter(u => u.role === 'admin' && isTrue_(u.active) && !/\\.test$/.test(u.email)).length && d2 === 'already sent today', JSON.stringify(sent.slice(s0).map(m => m.to)));

// triggers
const trig = [];
ScriptApp.getProjectTriggers = () => trig.slice();
ScriptApp.deleteTrigger = (t) => { const i = trig.indexOf(t); if (i !== -1) trig.splice(i, 1); };
ScriptApp.newTrigger = (fn) => { const b = { timeBased: () => b, atHour: () => b, everyDays: () => b, everyMinutes: () => b, inTimezone: () => b, create: () => { const t = { getHandlerFunction: () => fn }; trig.push(t); return t; } }; return b; };
['syncAll', 'syncAll', 'processQueue', 'processQueue', 'unrelatedJob'].forEach(fn => ScriptApp.newTrigger(fn).create());
installTriggers(); installTriggers();
const names = trig.map(t => t.getHandlerFunction()).sort().join();
check('installTriggers (twice, over duplicates): exactly one nightlySync, processQueue, dailyDigest; old syncAll gone; others untouched', names === 'dailyDigest,nightlySync,processQueue,unrelatedJob', names);
syncAllNow_ = () => 'synced';
props.delete('RAN_SYNC');
const n1 = nightlySync(), n2 = nightlySync();
CacheService.getScriptCache().put('running:syncAll', '1', 600);
const n3 = syncAll();
CacheService.getScriptCache().remove('running:syncAll');
check('nightlySync runs once a day; a sync started while one runs steps aside', n1 === 'synced' && n2 === 'already ran today' && n3 === 'another sync is running' && syncAll() === 'synced', JSON.stringify([n1, n2, n3]));
}
