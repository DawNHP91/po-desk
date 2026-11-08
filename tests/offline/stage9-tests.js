
// ===================== Stage 9: one slip, several accounts =====================
{
const t9 = X[entityById_('NHP').xero_tenant_id];
const inv9 = (poNumber) => t9.invoices.filter(i => String(i.InvoiceNumber).indexOf(poNumber) === 0 && i.Status !== 'DELETED');
const slip9 = (amount) => {
  CacheService.getScriptCache().removeAll([rateKey_('po', buyer.user_id, PO_RULES.RATE_WINDOW_S), rateKey_('bill', buyer.user_id, BILL_RULES.RATE_WINDOW_S), rateKey_('slip', buyer.user_id, SLIP_RULES.RATE_WINDOW_S)]);
  const p = mkPO(amount).data;
  const u = call('uploadSlip', { poId: p.poId, imageBase64: jpeg(), mimeType: 'image/jpeg' });
  return { po: p, billId: u.data.billId };
};
const f9 = (o) => Object.assign({ supplierName: 'ENGEN RAINBOW MOTORS', supplierVatNumber: '4123456789', slipNumber: 'S9-' + Math.random().toString(36).slice(2, 7), date: '2026-11-04', totalIncl: 180, vatAmount: 23.48, lineItems: [], paymentMethodHint: 'CARD' }, o || {});
const sub9 = (billId, fields) => call('submitBill', { billId: billId, fields: fields, confirmDuplicate: true });
const byCode = (inv) => { const o = {}; inv.LineItems.forEach(l => { o[l.AccountCode + '/' + l.TaxType] = (o[l.AccountCode + '/' + l.TaxType] || 0) + l.LineAmount; }); return o; };

const A9 = slip9(180);
const ra9 = sub9(A9.billId, f9({ lineItems: [{ description: 'Coffee 500g', qty: 1, lineTotalIncl: 95, accountCode: '426' }, { description: 'Bleach 750ml', qty: 1, lineTotalIncl: 85, accountCode: '404' }] }));
const ia9 = inv9(A9.po.poNumber)[0];
check('coffee + bleach on one slip: the bill has one line per account (426 R95, 404 R85), VAT as on the slip', ra9.ok && ia9 && ia9.LineItems.length === 2 && JSON.stringify(byCode(ia9)) === JSON.stringify({ '426/INPUT3': 95, '404/INPUT3': 85 }) && ia9.TotalTax === 23.48 && ra9.data.vatMatches === true, JSON.stringify(ia9 && ia9.LineItems));
const B9 = slip9(60);
const rb9 = sub9(B9.billId, f9({ totalIncl: 60, vatAmount: 7.83, lineItems: [{ description: 'Sponges', qty: 2, lineTotalIncl: 20 }, { description: 'Bleach', qty: 1, lineTotalIncl: 40 }] }));
const ib9 = inv9(B9.po.poNumber)[0];
check('items on the same account (here the PO’s) become ONE line listing them with amounts', rb9.ok && ib9.LineItems.length === 1 && ib9.LineItems[0].AccountCode === '433' && ib9.LineItems[0].Description === 'Sponges × 2 R20.00; Bleach R40.00', JSON.stringify(ib9 && ib9.LineItems));
const C9 = slip9(180);
const rc9 = sub9(C9.billId, f9({ lineItems: [{ description: 'Coffee', qty: 1, lineTotalIncl: 90, accountCode: '426' }, { description: 'Bleach', qty: 1, lineTotalIncl: 85, accountCode: '404' }] }));
check('items on two accounts that don’t add up to the total: refused with a clear message, nothing sent to Xero', !rc9.ok && rc9.error.code === 'BAD_REQUEST' && /add up to R175\.00, not the total R180\.00/.test(rc9.error.message) && inv9(C9.po.poNumber).length === 0, JSON.stringify(rc9));
const rc9b = sub9(C9.billId, f9({ lineItems: [{ description: 'Coffee', qty: 1, lineTotalIncl: 95, accountCode: '426' }, { description: 'Bleach', qty: 1, lineTotalIncl: 85, accountCode: '999' }] }));
check('an account that isn’t one of the company’s purchase accounts is refused', !rc9b.ok && /Account 999 can’t be used/.test(rc9b.error.message), JSON.stringify(rc9b));
const D9 = slip9(420);
const rd9 = sub9(D9.billId, f9({ totalIncl: 421.99, vatAmount: 2.87, lineItems: [{ description: 'Diesel 50ppm', qty: 1, lineTotalIncl: 400, accountCode: '433' }, { description: 'Coke', qty: 1, lineTotalIncl: 21.99, accountCode: '426' }] }));
const id9 = inv9(D9.po.poNumber)[0];
check('diesel + cold drink split by account: no VAT on the fuel line, the slip’s VAT on the drink, exactly', rd9.ok && JSON.stringify(byCode(id9)) === JSON.stringify({ '433/NONE': 400, '426/INPUT3': 21.99 }) && id9.TotalTax === 2.87, JSON.stringify(id9 && id9.LineItems));
const E9 = slip9(100);
const re9 = sub9(E9.billId, f9({ totalIncl: 100, vatAmount: 6.52, lineItems: [{ description: 'Milk', qty: 1, lineTotalIncl: 50, accountCode: '426' }, { description: 'Bleach', qty: 1, lineTotalIncl: 50, accountCode: '404' }] }));
const ie9 = inv9(E9.po.poNumber)[0];
const lines9 = ie9 ? ie9.LineItems : [];
check('mixed VAT without fuel: each account gets a VAT and a no-VAT part in proportion; total and VAT exact', re9.ok && lines9.length === 4 && ie9.Total === 100 && ie9.TotalTax === 6.52 && ['426', '404'].every(c => lines9.some(l => l.AccountCode === c && l.TaxType === 'INPUT3') && lines9.some(l => l.AccountCode === c && l.TaxType === 'NONE')), JSON.stringify(lines9));
const F9 = slip9(180);
const rf9 = sub9(F9.billId, f9({ supplierVatNumber: '', vatAmount: null, lineItems: [{ description: 'Coffee 500g', qty: 1, lineTotalIncl: 95, accountCode: '426' }, { description: 'Bleach 750ml', qty: 1, lineTotalIncl: 85, accountCode: '404' }] }));
check('no VAT number with two accounts: two no-VAT lines, VAT R0.00', rf9.ok && JSON.stringify(byCode(inv9(F9.po.poNumber)[0])) === JSON.stringify({ '426/NONE': 95, '404/NONE': 85 }) && inv9(F9.po.poNumber)[0].TotalTax === 0, JSON.stringify(rf9).slice(0, 200));

// the review screen's suggestions per item
MEM.Categories.push({ category_id: 'cat-s9-clean', entity_id: 'NHP', name: 'Cleaning', account_code: '404', tax_type: 'INPUT3', keywords: 'bleach', sort: 70, active: true },
  { category_id: 'cat-s9-coffee', entity_id: 'NHP', name: 'Staff refreshments', account_code: '426', tax_type: 'INPUT3', keywords: 'coffee', sort: 120, active: true });
const G9 = slip9(200);
setGemini('ok', Object.assign({}, ANSWER, { slip_number: 'S9-READ', total_incl: 200, vat_amount: 26.09, subtotal_excl: 173.91,
  line_items: [{ description: 'COFFEE 500G', qty: 1, unit_price_incl: 95, line_total_incl: 95 }, { description: 'BLEACH 750ML', qty: 1, unit_price_incl: 85, line_total_incl: 85 }, { description: 'MYSTERY ITEM', qty: 1, unit_price_incl: 20, line_total_incl: 20 }] }));
const rg9 = call('readSlip', { billId: G9.billId });
const li9 = rg9.ok ? rg9.data.fields.lineItems : [];
check('reading the slip suggests an account per item (coffee 426, bleach 404); an item with no suggestion keeps the PO’s (433)', rg9.ok && li9.map(l => l.accountCode).join() === '426,404,433' && rg9.data.po.accountCode === '433' && rg9.data.po.accountName === 'Vehicle - Petrol and oil', JSON.stringify(rg9.data && rg9.data.fields.lineItems) + ' ' + JSON.stringify(rg9.data && rg9.data.po));
const rg9b = sub9(G9.billId, rg9.data.fields);
const ig9 = inv9(G9.po.poNumber)[0];
check('…and submitting what was read makes a bill with three account lines that add up to the slip', rg9b.ok && ig9.LineItems.length === 3 && ig9.Total === 200 && ig9.TotalTax === 26.09, JSON.stringify(ig9 && ig9.LineItems));
const gs9 = call('getSlip', { billId: G9.billId }).data;
check('the sent slip keeps each item’s account (read-only view)', gs9.fields.lineItems.map(l => l.accountCode).join() === '426,404,433', JSON.stringify(gs9.fields.lineItems));
}
