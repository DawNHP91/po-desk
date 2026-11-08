// ===================== Stage 11: own money, refunded =====================
{
const t11 = X[entityById_('NHP').xero_tenant_id];
const fresh11 = () => CacheService.getScriptCache().removeAll([rateKey_('po', buyer.user_id, PO_RULES.RATE_WINDOW_S), rateKey_('bill', buyer.user_id, BILL_RULES.RATE_WINDOW_S), rateKey_('slip', buyer.user_id, SLIP_RULES.RATE_WINDOW_S)]);

// the payment option
const seed11 = seedPaymentMethods();
const own11 = MEM.PaymentMethods.find(p => p.entity_id === 'NHP' && p.type === 'OWN');
// (the harness ran seedPaymentMethods at the start, so the rows are already there)
check('seedPaymentMethods adds "Own money" for HPB, NHP and PK (no bank account); running it again adds nothing',
  ['HPB', 'NHP', 'PK'].every(e => MEM.PaymentMethods.filter(p => p.entity_id === e && p.type === 'OWN' && p.label === 'Own money' && !p.xero_bank_account_id && p.active).length === 1) &&
  seed11.added.length === 0, JSON.stringify(seed11));
const rd11 = call('refData', { entityId: 'NHP' });
check('every buyer sees it on New PO', rd11.ok && rd11.data.paymentMethods.some(p => p.pmId === own11.pm_id && p.type === 'OWN' && p.label === 'Own money'), JSON.stringify(rd11.data && rd11.data.paymentMethods));

// the PO
fresh11();
const p11 = mkPO(79.38, { pmId: own11.pm_id, description: 'Soap and margarine' }).data;
const x11 = t11.pos.find(p => p.PurchaseOrderNumber === p11.poNumber);
const g11a = call('getPO', { poId: p11.poId }).data;
check('PO paid with own money: Xero reference "Own money · Test"; the buyer sees "add the slip to be refunded"', x11 && x11.Reference === 'Own money · Test' && g11a.paidWith === 'Own money' && g11a.refund && g11a.refund.status === 'AFTER_SLIP', JSON.stringify([x11 && x11.Reference, g11a.refund]));
fresh11();
const card11 = mkPO(50).data;
check('a card PO has no refund', call('getPO', { poId: card11.poId }).data.refund === null, '');

// the bill
const u11 = call('uploadSlip', { poId: p11.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' });
const sb11 = call('submitBill', { billId: u11.data.billId, confirmDuplicate: true, fields: { supplierName: 'ENGEN RAINBOW MOTORS', supplierVatNumber: '4123456789', slipNumber: 'S11-1', date: '2026-11-08', totalIncl: 79.38, vatAmount: 10.35, lineItems: [], paymentMethodHint: 'CARD' } });
const inv11 = t11.invoices.find(i => String(i.InvoiceNumber).indexOf(p11.poNumber) === 0 && i.Status !== 'DELETED');
const note11 = inv11 && t11.history.find(hh => hh.id === inv11.InvoiceID);
check('the bill goes to the shop as usual; its note starts "REFUND Test Buyer NHP R79.38" for the accountant', sb11.ok && inv11 && inv11.Contact.ContactID === engen && note11 && /^REFUND Test Buyer NHP R79\\.38: paid with their own money/.test(note11.text), JSON.stringify(note11));
const g11b = call('getPO', { poId: p11.poId }).data;
check('billed: the buyer sees "R79.38 due" (the slip total)', g11b.status === 'BILLED' && g11b.refund.status === 'DUE' && g11b.refund.amount === 79.38, JSON.stringify(g11b.refund));
const dg11 = digest_(new Date());
check('the 08:00 digest lists it under "Refunds due" with who to refund', /Refunds due[^\\n]*: 1 \\(R79\\.38\\)/.test(dg11.body) && new RegExp(p11.poNumber + '  R79\\\\.38  Engen Rainbow Motors: refund Test Buyer NHP').test(dg11.body), dg11.body.slice(0, 600));

// refunded when Xero shows the bill paid
const calls11 = xeroCalls.length;
const r11a = checkRefunds_();
check('nightly check while the bill is unpaid: still due, one Xero call for NHP only', r11a.NHP && r11a.NHP.due === 1 && r11a.NHP.refunded === 0 && !r11a.HPB && !r11a.PK && !MEM.POs.find(p => p.po_id === p11.poId).refunded_at, JSON.stringify(r11a));
inv11.Status = 'PAID';
inv11.FullyPaidOnDate = '/Date(' + Date.parse('2026-11-09T00:00:00Z') + '+0000)/';
const r11b = checkRefunds_();
const g11c = call('getPO', { poId: p11.poId }).data;
check('once Xero shows the bill PAID: marked refunded with the payment date; the buyer sees "R79.38 refunded"', r11b.NHP.refunded === 1 && g11c.refund.status === 'REFUNDED' && /^2026-11-09/.test(g11c.refund.at) && g11c.refund.amount === 79.38, JSON.stringify([r11b, g11c.refund]));
const before11 = xeroCalls.length;
const r11c = checkRefunds_();
check('…the digest no longer lists it, and with nothing due the check makes no Xero call', !/Refunds due/.test(digest_(new Date()).body) && JSON.stringify(r11c) === '{}' && xeroCalls.length === before11, JSON.stringify(r11c) + ' ' + (xeroCalls.length - before11));
check('the refund is in the audit log', MEM.AuditLog.some(x => x.action === 'po.refunded' && x.ok), '');
}
