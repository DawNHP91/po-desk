// ===================== Stage 6: draft bills =====================
const tNHP = X[entityById_('NHP').xero_tenant_id];
{
const billFields = (o) => Object.assign({ supplierName: 'ENGEN RAINBOW MOTORS', supplierVatNumber: '4123456789', slipNumber: 'T 1001', date: '2026-11-04', currency: 'ZAR', totalIncl: 230.5, vatAmount: 30.07, lineItems: [], paymentMethodHint: 'CARD' }, o || {});
const newSlip = (amount) => { CacheService.getScriptCache().removeAll([rateKey_('po', buyer.user_id, PO_RULES.RATE_WINDOW_S), rateKey_('bill', buyer.user_id, BILL_RULES.RATE_WINDOW_S)]); const p = mkPO(amount).data; const u = call('uploadSlip', { poId: p.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' }); return { po: p, billId: u.data.billId }; };
const invFor = (poNumber) => tNHP.invoices.filter(i => String(i.InvoiceNumber).indexOf(poNumber) === 0 && i.Status !== 'DELETED');
const poX = (poNumber) => tNHP.pos.find(p => p.PurchaseOrderNumber === poNumber);
const billRow = (id) => MEM.Bills.find(b => b.bill_id === id);
const jobsFor = (id) => MEM.Queue.filter(j => String(j.payload_json).indexOf(id) !== -1);
const xeroStart = xeroCalls.length;
// Stage 9 needs more NHP purchase accounts than the base fixture has.
MEM.Accounts.push({ entity_id: 'NHP', account_id: 'NHP404', code: '404', name: 'Cleaning', type: 'EXPENSE', class: 'EXPENSE', tax_type: 'INPUT3', status: 'ACTIVE' },
  { entity_id: 'NHP', account_id: 'NHP426', code: '426', name: 'Staff welfare', type: 'EXPENSE', class: 'EXPENSE', tax_type: 'INPUT3', status: 'ACTIVE' });
invalidateRefCache('NHP');
// Most checks below re-use a supplier/date/total on purpose: they confirm the duplicate warning. One check does not.
const submit = (p, t) => call('submitBill', Object.assign({ confirmDuplicate: true }, p), t);

// a slip checked before Stage 6 can be sent
const r0 = submit({ billId: up.data.billId, fields: Object.assign({}, fields) });
const i0 = invFor(po.poNumber);
check('a slip saved in Stage 5 is sent as is: its 2 items (one account) become ONE bill line listing both, VAT 16.10 as on the slip', r0.ok && r0.data.billStatus === 'BILLED' && i0.length === 1 && i0[0].LineItems.length === 1 && /DIESEL 50PPM × 40\\.12 R90\\.27; COKE 500ML R33\\.18/.test(i0[0].LineItems[0].Description) && i0[0].TotalTax === 16.1 && i0[0].Total === 123.45, JSON.stringify(i0[0] && i0[0].LineItems).slice(0, 300));

// 1. happy path
const A = newSlip(230.5);
let pc = parallelCalls.length;
const ra = submit({ billId: A.billId, fields: billFields() });
const ia = invFor(A.po.poNumber);
check('submitBill: one DRAFT ACCPAY bill, "<PO> · <slip no>" in InvoiceNumber (Xero shows it as Reference), Inclusive, total and VAT as on the slip, dated the slip date',
  ra.ok && ra.data.billStatus === 'BILLED' && ia.length === 1 && ia[0].Type === 'ACCPAY' && ia[0].Status === 'DRAFT' && ia[0].InvoiceNumber === A.po.poNumber + ' · T 1001' && ia[0].Reference === ia[0].InvoiceNumber && ia[0].LineAmountTypes === 'Inclusive' && ia[0].Total === 230.5 && ia[0].TotalTax === 30.07 && ia[0].Date === '2026-11-04' && ia[0].DueDate === '2026-11-04' && ia[0].LineItems[0].AccountCode === '433' && ia[0].LineItems[0].TaxType === 'INPUT3' && ia[0].LineItems[0].Description === 'Diesel',
  JSON.stringify(ra).slice(0, 300) + ' ' + JSON.stringify(ia).slice(0, 300));
check('the slip is attached to the bill and to the PO (final file name), the PO is BILLED in Xero, a History note on each naming the other',
  (tNHP.att[ia[0].InvoiceID] || []).length === 1 && (tNHP.att[poX(A.po.poNumber).PurchaseOrderID] || []).length === 1 && tNHP.att[ia[0].InvoiceID][0].FileName === A.po.poNumber + '_2026-11-04_Engen-Rainbow-Motors_230.50.jpg' && poX(A.po.poNumber).Status === 'BILLED' && tNHP.history.some(x => x.id === ia[0].InvoiceID && x.text.indexOf(A.po.poNumber) !== -1) && tNHP.history.some(x => x.id === poX(A.po.poNumber).PurchaseOrderID && x.text.indexOf(ia[0].InvoiceNumber) !== -1),
  JSON.stringify(tNHP.att).slice(0, 300));
const pa = MEM.POs.find(p => p.po_id === A.po.poId), ba = billRow(A.billId);
check('Bills row has the Xero bill and status BILLED; POs row BILLED with bill_id; no queue job left; AuditLog bill.submit',
  ba.xero_invoice_id === ia[0].InvoiceID && ba.status === 'BILLED' && pa.status === 'BILLED' && pa.bill_id === A.billId && jobsFor(A.billId).length === 0 && MEM.AuditLog.some(a => a.action === 'bill.submit' && a.ok), JSON.stringify([ba.status, pa.status, jobsFor(A.billId).length]));
check('every Xero write carries an Idempotency-Key keyed on the billId; the 5 follow-up calls ran in 2 parallel groups',
  idemSeen.filter(k => k.indexOf(A.billId) !== -1).length === 6 && parallelCalls.length - pc === 5, idemSeen.filter(k => k.indexOf(A.billId) !== -1).join(' / '));

// 2. again: no duplicate; locked
const ra2 = submit({ billId: A.billId, fields: billFields({ totalIncl: 999 }) });
check('submitting again returns the same bill (duplicate) and creates nothing in Xero', ra2.ok && ra2.data.duplicate === true && invFor(A.po.poNumber).length === 1 && ra2.data.billRef === ia[0].InvoiceNumber, JSON.stringify(ra2).slice(0, 200));
check('a sent slip is locked: retake, read again and save are refused; viewing still works and shows the bill',
  !call('uploadSlip', { poId: A.po.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' }).ok && call('readSlip', { billId: A.billId }).error.code === 'BILL_LOCKED' && call('saveSlipReview', { billId: A.billId, fields: billFields() }).error.code === 'BILL_LOCKED' && call('getSlip', { billId: A.billId }).data.bill.billStatus === 'BILLED', '');
const gpa = call('getPO', { poId: A.po.poId }).data;
check('getPO: BILLED, bill state and reference, VAT, and a "View slip" link to the Drive file', gpa.status === 'BILLED' && gpa.slip.billStatus === 'BILLED' && gpa.slip.billRef === ia[0].InvoiceNumber && /^https:\\/\\/drive\\.google\\.com\\/file\\/d\\/file\\d+\\/view$/.test(gpa.slip.slipUrl) && gpa.slip.xeroVat === 30.07, JSON.stringify(gpa.slip));

// duplicate slip: asked first, billed only when confirmed
const DUP = newSlip(230.5);
const rdup = call('submitBill', { billId: DUP.billId, fields: billFields() });
check('a slip that looks like one already billed (same supplier + slip number) is not billed until the buyer confirms', !rdup.ok && rdup.error.code === 'DUPLICATE_CHECK' && rdup.error.message.indexOf(A.po.poNumber) !== -1 && invFor(DUP.po.poNumber).length === 0 && !billRow(DUP.billId).status, JSON.stringify(rdup));
const rdup2 = call('submitBill', { billId: DUP.billId, fields: billFields(), confirmDuplicate: true });
check('confirmed: the bill is made and carries the duplicate note', rdup2.ok && rdup2.data.billStatus === 'BILLED' && invFor(DUP.po.poNumber).length === 1 && JSON.parse(billRow(DUP.billId).flags).indexOf('DUPLICATE') !== -1, JSON.stringify(rdup2).slice(0, 200));

// 3. VAT to the cent
const lines3 = [{ description: 'Coke 500ml', qty: 1, lineTotalIncl: 10, accountCode: '426' }, { description: 'Chips', qty: 2, lineTotalIncl: 10, accountCode: '404' }, { description: 'Gum', qty: 1, lineTotalIncl: 10, accountCode: '433' }];
const B = newSlip(30);
const rb = submit({ billId: B.billId, fields: billFields({ slipNumber: 'T 1002', totalIncl: 30, vatAmount: 3.91, lineItems: lines3 }) });
const ib = invFor(B.po.poNumber)[0];
check('three items on three accounts become three bill lines; Xero’s per-line VAT 3.90 is lifted to the slip’s 3.91 with one TaxAmount', rb.ok && ib.LineItems.length === 3 && ib.LineItems.map(l => l.AccountCode).sort().join() === '404,426,433' && ib.LineItems.some(l => l.Description === 'Chips × 2') && ib.TotalTax === 3.91 && ib.LineItems.filter(l => l.TaxAmount === 1.31).length === 1 && rb.data.vatMatches === true, JSON.stringify(ib && ib.LineItems));
xflags.refuseTaxOverride = true;
const B2 = newSlip(30);
const rb2 = submit({ billId: B2.billId, fields: billFields({ slipNumber: 'T 1003', totalIncl: 30, vatAmount: 3.91, lineItems: lines3 }) });
xflags.refuseTaxOverride = false;
check('if Xero refuses the cent adjustment, the bill is still made without it and marked "VAT differs"', rb2.ok && rb2.data.billStatus === 'BILLED' && invFor(B2.po.poNumber).length === 1 && invFor(B2.po.poNumber)[0].TotalTax === 3.9 && rb2.data.vatMatches === false && /TaxAmount/.test(JSON.parse(billRow(B2.billId).steps_json).taxOverrideRefused), JSON.stringify(rb2).slice(0, 300));
const C = newSlip(450);
const rc = submit({ billId: C.billId, fields: billFields({ slipNumber: 'T 1004', totalIncl: 450, vatAmount: 6.52 }) });
const ic = invFor(C.po.poNumber)[0];
check('mixed slip (diesel + a cold drink): a 15% line carrying exactly the slip’s VAT plus a no-VAT line', rc.ok && ic.LineItems.length === 2 && ic.LineItems[0].TaxType === 'INPUT3' && ic.LineItems[1].TaxType === 'NONE' && ic.Total === 450 && ic.TotalTax === 6.52, JSON.stringify(ic && ic.LineItems));
const D = newSlip(80);
const rd6 = submit({ billId: D.billId, fields: billFields({ slipNumber: 'T 1005', supplierVatNumber: '', totalIncl: 80, vatAmount: 10.43 }) });
const id6 = invFor(D.po.poNumber)[0];
check('no supplier VAT number: the no-VAT type, bill VAT R0.00', rd6.ok && id6.LineItems.every(l => l.TaxType === 'NONE') && id6.TotalTax === 0, JSON.stringify(id6 && id6.LineItems));
const E = newSlip(400);
const re6 = submit({ billId: E.billId, fields: billFields({ slipNumber: 'T 1006', totalIncl: 400, vatAmount: 0 }) });
check('VAT number but R0.00 VAT (zero-rated fuel): the no-VAT type, bill VAT R0.00 like the slip', re6.ok && invFor(E.po.poNumber)[0].TotalTax === 0 && invFor(E.po.poNumber)[0].LineItems[0].TaxType === 'NONE', JSON.stringify(re6).slice(0, 200));
const F = newSlip(100);
const rf = submit({ billId: F.billId, fields: billFields({ slipNumber: 'T 1007', totalIncl: 100, vatAmount: 20 }) });
check('VAT above 15/115 of the total is refused before anything reaches Xero', !rf.ok && rf.error.code === 'BAD_REQUEST' && invFor(F.po.poNumber).length === 0 && !billRow(F.billId).status, JSON.stringify(rf));

// 4. supplier choice
const shell = billFields({ supplierName: 'Shell Ultra City', slipNumber: 'T 1008', totalIncl: 100, vatAmount: 13.04 });
const rg0 = submit({ billId: F.billId, fields: shell });
check('slip from another supplier: the buyer must choose (keep / change) before anything is posted', !rg0.ok && rg0.error.code === 'SUPPLIER_CHOICE' && invFor(F.po.poNumber).length === 0, JSON.stringify(rg0));
const rg1 = submit({ billId: F.billId, fields: shell, supplier: { mode: 'keep' } });
const ig1 = invFor(F.po.poNumber)[0];
check('"keep PO supplier": the bill goes to the PO’s contact; the bill note says the buyer kept it', rg1.ok && ig1.Contact.ContactID === engen && tNHP.history.some(x => x.id === ig1.InvoiceID && /kept the PO/.test(x.text)) && rg1.data.supplierChanged === false, JSON.stringify(rg1).slice(0, 200));
const G = newSlip(115);
const slipSup = (no) => billFields({ supplierName: 'PO Desk Test Supplier Slip', supplierVatNumber: '4999999999', slipNumber: no, totalIncl: 115, vatAmount: 15 });
const rg2 = submit({ billId: G.billId, fields: slipSup('T 1009'), supplier: { mode: 'new' } });
const ig2 = invFor(G.po.poNumber)[0];
const newC = tNHP.contacts.find(c => c.Name === 'PO Desk Test Supplier Slip');
check('"change to <slip supplier>": contact created in Xero with its VAT number; bill on it; PO moved to it in Xero and in the POs row',
  rg2.ok && newC && newC.TaxNumber === '4999999999' && ig2.Contact.ContactID === newC.ContactID && poX(G.po.poNumber).Contact.ContactID === newC.ContactID && MEM.POs.find(p => p.po_id === G.po.poId).contact_id === newC.ContactID && rg2.data.supplierChanged === true && MEM.Suppliers.some(s => s.contact_id === newC.ContactID), JSON.stringify(rg2).slice(0, 300));
const H2 = newSlip(115);
const rg3 = submit({ billId: H2.billId, fields: slipSup('T 1010'), supplier: { mode: 'new' } });
check('the same slip supplier next time is found by its VAT number, not created twice', rg3.ok && tNHP.contacts.filter(c => c.Name === 'PO Desk Test Supplier Slip').length === 1 && invFor(H2.po.poNumber)[0].Contact.ContactID === newC.ContactID, JSON.stringify(rg3).slice(0, 200));
const I = newSlip(115);
const rg4 = submit({ billId: I.billId, fields: billFields({ supplierName: 'Something Else', slipNumber: 'T 1011', totalIncl: 115, vatAmount: 15 }), supplier: { mode: 'existing', contactId: 'cccccccc-0000-4000-8000-000000000003' } });
check('"existing" may only pick a supplier of this company (an HPB contact is refused)', !rg4.ok && rg4.error.code === 'BAD_REQUEST' && !billRow(I.billId).status, JSON.stringify(rg4));
xflags.refusePoContact = true;
const rg5 = submit({ billId: I.billId, fields: slipSup('T 1012'), supplier: { mode: 'new' } });
xflags.refusePoContact = false;
check('if Xero won’t move the PO to the new supplier, the PO is still marked BILLED and the refusal is recorded', rg5.ok && rg5.data.billStatus === 'BILLED' && poX(I.po.poNumber).Status === 'BILLED' && /Contact cannot/.test(JSON.parse(billRow(I.billId).steps_json).poContactRefused || ''), JSON.stringify(rg5).slice(0, 300));

// 5. partial failure and the queue
const J = newSlip(60);
armBillAttachFailure();
const rj = submit({ billId: J.billId, fields: billFields({ slipNumber: 'T 1013', totalIncl: 60, vatAmount: 7.83 }) });
const ij = invFor(J.po.poNumber);
const jobJ = jobsFor(J.billId);
check('PO attachment fails: one bill, slip on it, buyer told it is finishing off, PO not BILLED in Xero yet, job due now',
  rj.ok && rj.data.billStatus === 'QUEUED' && rj.data.invoiceCreated === true && rj.data.pending.join() === 'attachPO,poBilled' && ij.length === 1 && (tNHP.att[ij[0].InvoiceID] || []).length === 1 && poX(J.po.poNumber).Status !== 'BILLED' && jobJ.length === 1 && new Date(jobJ[0].next_run_at) <= new Date() && MEM.POs.find(p => p.po_id === J.po.poId).status === 'BILLED', JSON.stringify(rj).slice(0, 300) + ' jobs=' + JSON.stringify(jobJ));
const q1 = processQueue();
check('the queue finishes it: slip on the PO, PO BILLED; no second bill, no second attachment on the bill; job gone',
  q1.some(r => r.type === 'billSteps' && r.ok) && billRow(J.billId).status === 'BILLED' && invFor(J.po.poNumber).length === 1 && (tNHP.att[ij[0].InvoiceID] || []).length === 1 && (tNHP.att[poX(J.po.poNumber).PurchaseOrderID] || []).length === 1 && poX(J.po.poNumber).Status === 'BILLED' && jobsFor(J.billId).length === 0, JSON.stringify(q1));
const K = newSlip(70);
faults.push({ method: 'PUT', re: /^\\/Invoices$/, status: 503, times: 3 });
const rk = submit({ billId: K.billId, fields: billFields({ slipNumber: 'T 1014', totalIncl: 70, vatAmount: 9.13 }) });
check('Xero down when creating: nothing in Xero, buyer told it will be created by itself, PO still ISSUED, job due',
  rk.ok && rk.data.billStatus === 'QUEUED' && rk.data.invoiceCreated === false && invFor(K.po.poNumber).length === 0 && MEM.POs.find(p => p.po_id === K.po.poId).status === 'ISSUED' && jobsFor(K.billId).length === 1, JSON.stringify(rk).slice(0, 300));
check('while waiting for Xero the slip is locked (no retake)', call('uploadSlip', { poId: K.po.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' }).error.code === 'BILL_LOCKED', '');
const q2 = processQueue();
check('the queue creates it later: one bill, BILLED', billRow(K.billId).status === 'BILLED' && invFor(K.po.poNumber).length === 1 && MEM.POs.find(p => p.po_id === K.po.poId).status === 'BILLED', JSON.stringify(q2));
const L = newSlip(90);
faults.push({ method: 'PUT', re: /^\\/Invoices$/, status: 503, times: 1, process: true }, { method: 'PUT', re: /^\\/Invoices$/, status: 503, times: 2 });
const rl = submit({ billId: L.billId, fields: billFields({ slipNumber: 'T 1015', totalIncl: 90, vatAmount: 11.74 }) });
check('answer lost after Xero made the bill (and Composio down for the retries): queued; Xero has exactly one bill', rl.ok && rl.data.billStatus === 'QUEUED' && invFor(L.po.poNumber).length === 1, JSON.stringify(rl).slice(0, 200));
processQueue();
check('the queue finds that bill by its Reference and adopts it instead of creating a second', billRow(L.billId).status === 'BILLED' && invFor(L.po.poNumber).length === 1 && JSON.parse(billRow(L.billId).steps_json).adopted === true && billRow(L.billId).xero_invoice_id === invFor(L.po.poNumber)[0].InvoiceID, billRow(L.billId).steps_json);
const M = newSlip(95);
faults.push({ method: 'PUT', re: /^\\/Invoices$/, status: 502, times: 1, process: true });
const rm6 = submit({ billId: M.billId, fields: billFields({ slipNumber: 'T 1016', totalIncl: 95, vatAmount: 12.39 }) });
check('answer lost once: the automatic retry with the same Idempotency-Key gets the same bill back, not a second', rm6.ok && rm6.data.billStatus === 'BILLED' && invFor(M.po.poNumber).length === 1, JSON.stringify(rm6).slice(0, 200));

// 6. Xero refuses the bill
const N = newSlip(50);
MEM.POs.find(p => p.po_id === N.po.poId).account_code = '999';
const rn = submit({ billId: N.billId, fields: billFields({ slipNumber: 'T 1017', totalIncl: 50, vatAmount: 6.52 }) });
check('Xero refuses the bill: the buyer sees why, nothing queued, slip open for correction', !rn.ok && rn.error.code === 'XERO_REJECTED' && /999/.test(rn.error.message) && billRow(N.billId).status === '' && jobsFor(N.billId).length === 0 && call('getSlip', { billId: N.billId }).data.bill.rejected.indexOf('999') !== -1, JSON.stringify(rn));
MEM.POs.find(p => p.po_id === N.po.poId).account_code = '433';
const rn2 = submit({ billId: N.billId, fields: billFields({ slipNumber: 'T 1017', totalIncl: 50, vatAmount: 6.52 }) });
check('after correcting, Create the bill works (a new idempotency round, so the refusal isn’t replayed)', rn2.ok && rn2.data.billStatus === 'BILLED' && invFor(N.po.poNumber).length === 1 && idemSeen.some(k => k.indexOf(N.billId + '-r2-') !== -1), JSON.stringify(rn2).slice(0, 200));

// 7. odds and ends
xflags.noHistory = true;
const O = newSlip(40);
const ro = submit({ billId: O.billId, fields: billFields({ slipNumber: 'T 1018', totalIncl: 40, vatAmount: 5.22 }) });
xflags.noHistory = false;
check('History and Notes unreachable: the bill is still complete (notes are "if reachable")', ro.ok && ro.data.billStatus === 'BILLED' && jobsFor(O.billId).length === 0, JSON.stringify(ro).slice(0, 200));
xflags.dropInclusive = true;
const P = newSlip(45);
const rp = submit({ billId: P.billId, fields: billFields({ slipNumber: 'T 1019', totalIncl: 45, vatAmount: 5.87 }) });
xflags.dropInclusive = false;
check('if Xero ever ignores Inclusive on create, it is set straight after', rp.ok && invFor(P.po.poNumber)[0].LineAmountTypes === 'Inclusive', JSON.stringify(rp).slice(0, 200));
check('another buyer cannot submit my slip', submit({ billId: O.billId, fields: billFields() }, otok).error.code === 'NOT_FOUND', '');
const Q = newSlip(35);
drive.files[billRow(Q.billId).drive_file_id].sharing = 'ANYONE_WITH_LINK';
submit({ billId: Q.billId, fields: billFields({ slipNumber: 'T 1020', totalIncl: 35, vatAmount: 4.57 }) });
check('a slip file that somehow got link sharing is made private before it is attached', drive.files[billRow(Q.billId).drive_file_id].sharing === 'PRIVATE', '');
check('every Xero call in this stage went to NHP only', xeroCalls.slice(xeroStart).every(c => /@NHP$/.test(c)), xeroCalls.slice(xeroStart).filter(c => !/@NHP$/.test(c)).join('; '));
checkBills('NHP', 1);
const cbLog = logs.filter(l => l.indexOf('=== checkBills NHP') === 0).pop() || '';
const nBills = MEM.Bills.filter(b => b.xero_invoice_id).length;
check('checkBills reads every bill back from Xero; all pass except the one where Xero refused the cent adjustment', cbLog.indexOf(': ' + (nBills - 1) + ' of ' + nBills + ' bill(s) pass') !== -1, cbLog.slice(0, 1500));
}
