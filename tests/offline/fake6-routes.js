  const r2 = n => Math.round(n * 100) / 100;
  if (method === 'PUT' && u.pathname === '/Invoices') {
    const inv = body.Invoices[0];
    if (inv.LineItems.some(l => l.AccountCode === '999')) return { status: 400, data: { Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code for this document." }] }] } };
    if (xflags.refuseTaxOverride && inv.LineItems.some(l => l.TaxAmount !== undefined)) return { status: 400, data: { Elements: [{ ValidationErrors: [{ Message: 'The TaxAmount is not valid for this line.' }] }] } };
    const rate = t => ({ INPUT3: 15, NONE: 0 })[t];
    const lines = inv.LineItems.map(l => { const amt = r2(l.Quantity * l.UnitAmount); return Object.assign({ LineItemID: crypto.randomUUID(), LineAmount: amt }, l, { TaxAmount: l.TaxAmount !== undefined ? l.TaxAmount : r2(amt * rate(l.TaxType) / (100 + rate(l.TaxType))) }); });
    const total = r2(lines.reduce((a, l) => a + l.LineAmount, 0)), tax = r2(lines.reduce((a, l) => a + l.TaxAmount, 0));
    const c = st.contacts.find(x => x.ContactID === inv.Contact.ContactID) || { Name: 'Engen Rainbow Motors' };
    const created = Object.assign({}, inv, { InvoiceID: crypto.randomUUID(), Contact: { ContactID: inv.Contact.ContactID, Name: c.Name }, LineAmountTypes: xflags.dropInclusive ? 'Exclusive' : inv.LineAmountTypes, Total: total, TotalTax: tax, SubTotal: r2(total - tax), LineItems: lines });
    st.invoices.push(created);
    return { status: 200, data: { Invoices: [created] } };
  }
  if (method === 'GET' && u.pathname === '/Invoices') {
    const ids = (u.searchParams.get('ContactIDs') || '').split(',').filter(Boolean), sts = (u.searchParams.get('Statuses') || '').split(',').filter(Boolean);
    return { status: 200, data: { Invoices: st.invoices.filter(i => (!ids.length || ids.includes(i.Contact.ContactID)) && (!sts.length || sts.includes(i.Status)) && i.Type === 'ACCPAY') } };
  }
  let m2 = /^\/Invoices\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (m2) {
    const inv = st.invoices.find(i => i.InvoiceID === m2[1]); if (!inv) return { status: 404, data: { Message: 'no invoice' } };
    if (method === 'POST') { const p = body.Invoices[0]; if (p.Status) inv.Status = p.Status; if (p.LineAmountTypes) inv.LineAmountTypes = p.LineAmountTypes; }
    return { status: 200, data: { Invoices: [inv] } };
  }
  m2 = /^\/(Invoices|PurchaseOrders)\/([0-9a-f-]{36})\/Attachments(?:\/(.+))?$/.exec(u.pathname);
  if (m2) {
    const list = st.att[m2[2]] = st.att[m2[2]] || [];
    if (method === 'GET') return { status: 200, data: { Attachments: list } };
    const po = st.pos.find(p => p.PurchaseOrderID === m2[2]);
    if (po && po.Status === 'BILLED') return { status: 400, data: { Elements: [{ ValidationErrors: [{ Message: 'Attachments cannot be added to a billed purchase order.' }] }] } };
    const a = { AttachmentID: crypto.randomUUID(), FileName: decodeURIComponent(m2[3]), ContentLength: Buffer.from(full.binary_body.base64, 'base64').length, MimeType: full.binary_body.content_type };
    list.push(a);
    return { status: 200, data: { Attachments: [a] } };
  }
  m2 = /^\/(Invoices|PurchaseOrders)\/([0-9a-f-]{36})\/History$/.exec(u.pathname);
  if (m2 && method === 'PUT') { if (xflags.noHistory) return { status: 403, data: { Message: 'forbidden' } }; st.history.push({ type: m2[1], id: m2[2], text: body.HistoryRecords[0].Details }); return { status: 200, data: { HistoryRecords: body.HistoryRecords } }; }
  m2 = /^\/PurchaseOrders\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (m2) {
    const po = st.pos.find(p => p.PurchaseOrderID === m2[1]); if (!po) return { status: 404, data: {} };
    if (method === 'POST') {
      const p = body.PurchaseOrders[0];
      if (p.Contact && xflags.refusePoContact) return { status: 400, data: { Elements: [{ ValidationErrors: [{ Message: 'Contact cannot be changed.' }] }] } };
      if (p.Status === 'DELETED' && po.Status === 'BILLED') return { status: 400, data: { Elements: [{ ValidationErrors: [{ Message: 'A billed PO cannot be deleted.' }] }] } };
      if (p.Status) po.Status = p.Status; if (p.Contact) po.Contact = p.Contact;
    }
    return { status: 200, data: { PurchaseOrders: [po] } };
  }
  return { status: 404, data: { Message: 'unhandled ' + method + ' ' + path } };
}
