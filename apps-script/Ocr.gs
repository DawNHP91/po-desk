/**
 * Ocr.gs — reads a till slip photo with Gemini (generateContent, image inline, strict JSON).
 *
 * Gemini is a convenience, never a dependency: no key, a quota error (429), an outage, a blocked
 * answer or unparseable JSON all return { status: 'manual' } so the buyer simply types the values.
 */

const OCR = Object.freeze({
  BASE: 'https://generativelanguage.googleapis.com/v1beta/models/',
  MAX_ATTEMPTS: 2,                 // one retry on 5xx/network; 429 is never retried (quota)
  LINES_TOLERANCE_ZAR: 0.05,
  VAT_TOLERANCE_ZAR: 0.10,
  VAT_TOLERANCE_PCT: 2,
});

const SLIP_PROMPT = [
  'You are reading a photo of a South African till slip or tax invoice for a purchase. Return the fields in the JSON schema.',
  'Rules:',
  '- supplier_name: the trading name printed at the top (e.g. "SPAR Oudtshoorn", "Builders Warehouse"). Not "TAX INVOICE", not the customer, not the bank or card network.',
  '- supplier_vat_number: the supplier\'s VAT registration number, labelled "VAT No", "VAT No.", "VAT Reg", "VAT Reg No", "VAT Registration No" or "VAT#". South African VAT numbers are 10 digits starting with 4. Digits only, no spaces. null if none is printed. Never use a company registration number (e.g. 2015/123456/07), phone number or till number.',
  '- slip_number: the slip, receipt, invoice or transaction number ("Slip No", "Inv No", "Tax Invoice No", "Receipt #", "Trans #", "Doc No"). null if none.',
  '- date: the transaction date as YYYY-MM-DD. South African slips print dates day first: 03/11/2026 and 03-11-26 both mean 3 November 2026. Never swap day and month.',
  '- currency: "ZAR" for rand (R). Otherwise the ISO code shown.',
  '- Amounts are rand as plain numbers with two decimals, e.g. 1234.50. Slips may write "R1 234,50" or "1,234.50": convert both to 1234.50. Never include the R sign.',
  '- total_incl: the final amount paid including VAT ("TOTAL", "TOTAL DUE", "AMOUNT DUE", "BALANCE DUE", "TOTAL INCL VAT"). Not the amount tendered and not the change.',
  '- vat_amount: the VAT shown on the slip ("VAT", "VAT 15%", "Tax"). Standard VAT is 15%, so on a fully standard-rated slip it is about total x 15/115. Do not calculate it: return what is printed, or null.',
  '- subtotal_excl: the amount excluding VAT if printed ("Excl", "Total Excl VAT", "Taxable value"), else null.',
  '- line_items: every purchased item in order, with qty (default 1), unit_price_incl and line_total_incl as printed. Discounts and promotions are negative lines. Leave out tender, change, card and loyalty lines.',
  '- payment_method_hint: "CARD" if paid by card (Visa, Mastercard, Debit, Credit, card number ending), "CASH" if cash tendered, "EFT", or null.',
  '- confidence: for every field, 0 to 1, how sure you are that the value is exactly right. Use under 0.5 when the print is faded, cut off, creased or ambiguous.',
  'Never guess. If a field is not printed or not readable, use null and confidence 0. If the image is not a slip or invoice, return nulls with confidence 0.',
].join('\n');

const SLIP_FIELDS = ['supplier_name', 'supplier_vat_number', 'slip_number', 'date', 'currency', 'line_items', 'subtotal_excl', 'vat_amount', 'total_incl', 'payment_method_hint'];

/** JSON Schema for responseJsonSchema (current API). */
function slipJsonSchema_() {
  const str = (d) => ({ type: ['string', 'null'], description: d });
  const num = (d) => ({ type: ['number', 'null'], description: d });
  const conf = {};
  SLIP_FIELDS.forEach(f => { conf[f] = { type: 'number', minimum: 0, maximum: 1 }; });
  return {
    type: 'object',
    properties: {
      supplier_name: str('Trading name at the top of the slip'),
      supplier_vat_number: str('10 digits starting with 4, digits only'),
      slip_number: str('Slip / receipt / invoice number'),
      date: str('YYYY-MM-DD'),
      currency: str('ISO currency code, ZAR for rand'),
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { description: { type: 'string' }, qty: num('Quantity'), unit_price_incl: num('Unit price incl VAT'), line_total_incl: num('Line total incl VAT') },
          required: ['description', 'qty', 'unit_price_incl', 'line_total_incl'],
        },
      },
      subtotal_excl: num('Amount excluding VAT, if printed'),
      vat_amount: num('VAT as printed'),
      total_incl: num('Total paid incl VAT'),
      payment_method_hint: str('CARD, CASH, EFT or null'),
      confidence: { type: 'object', properties: conf, required: SLIP_FIELDS },
    },
    required: SLIP_FIELDS.concat(['confidence']),
  };
}

/** The same schema in the older OpenAPI-subset form, used only if the API rejects responseJsonSchema. */
function slipOpenApiSchema_() {
  const str = { type: 'STRING', nullable: true };
  const num = { type: 'NUMBER', nullable: true };
  const conf = {};
  SLIP_FIELDS.forEach(f => { conf[f] = { type: 'NUMBER' }; });
  return {
    type: 'OBJECT',
    properties: {
      supplier_name: str, supplier_vat_number: str, slip_number: str, date: str, currency: str,
      line_items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { description: { type: 'STRING' }, qty: num, unit_price_incl: num, line_total_incl: num }, required: ['description'] } },
      subtotal_excl: num, vat_amount: num, total_incl: num, payment_method_hint: str,
      confidence: { type: 'OBJECT', properties: conf, required: SLIP_FIELDS },
    },
    required: SLIP_FIELDS.concat(['confidence']),
  };
}

/**
 * Reads the slip image in Drive. Returns
 * { status: 'ok'|'manual', reason, model, ms, attempts, fields, confidence, lowConfidence, checks }.
 * fields use the app's camelCase names (supplierName, supplierVatNumber, slipNumber, date,
 * currency, lineItems[], subtotalExcl, vatAmount, totalIncl, paymentMethodHint).
 */
function extractSlip(fileId, ctx) {
  return extractSlipFromBlob_(DriveApp.getFileById(fileId).getBlob(), ctx);
}

/** Gemini's own error message ({error:{status, message}}), short enough for a log or a sheet cell. Never shown to buyers. */
function geminiError_(text) {
  try {
    const e = JSON.parse(text).error || {};
    if (e.message) return truncate_((e.status ? e.status + ': ' : '') + e.message, 200);
  } catch (err) { /* not JSON */ }
  return truncate_(text, 200);
}

/** Core of extractSlip: takes the image itself (the slip test sends 1600 px renditions, like the app). */
function extractSlipFromBlob_(blob, ctx) {
  ctx = ctx || {};
  const t0 = Date.now();
  const model = String(getConfig('GEMINI_MODEL', 'gemini-3.6-flash'));
  const manual = (reason, extra) => {
    const out = Object.assign({ status: 'manual', reason: reason, model: model, ms: Date.now() - t0 }, extra || {});
    auditLog({ userId: ctx.userId, entityId: ctx.entityId, action: 'ocr.extract', ref: ctx.ref, ok: false, detail: { model: model, ms: out.ms, reason: reason, http: out.http, attempts: out.attempts, error: out.error } });
    return out;
  };

  const key = getOptionalSecret_('GEMINI_API_KEY');
  if (!key) return manual('Slip reading is not set up yet (no Gemini key).');
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('TEST_FAIL_GEMINI')) {
    props.deleteProperty('TEST_FAIL_GEMINI');
    return manual('Slip reading is unavailable right now (forced for testing).');
  }

  const mime = blob.getContentType() || 'image/jpeg';
  const generationConfig = { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: slipJsonSchema_() };
  const body = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: Utilities.base64Encode(blob.getBytes()) } }, { text: SLIP_PROMPT }] }], generationConfig: generationConfig };
  const url = OCR.BASE + encodeURIComponent(model) + ':generateContent';

  let attempt = 0;
  let res = null;
  let schemaFallback = false;
  while (attempt < OCR.MAX_ATTEMPTS + (schemaFallback ? 1 : 0)) {
    attempt++;
    try {
      res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true });
    } catch (err) {
      res = null;
      if (attempt < OCR.MAX_ATTEMPTS) { Utilities.sleep(1500); continue; }
      return manual('Slip reading is unavailable right now (no connection).', { attempts: attempt });
    }
    const code = res.getResponseCode();
    if (code === 200) break;
    const text = res.getContentText();
    if (code === 429) return manual('The free slip-reading allowance is used up for now.', { http: 429, attempts: attempt });
    // Older API versions only know the OpenAPI-style schema: retry once in that form.
    if (code === 400 && !schemaFallback && /response_?json_?schema|responseJsonSchema/i.test(text)) {
      schemaFallback = true;
      delete generationConfig.responseJsonSchema;
      generationConfig.responseSchema = slipOpenApiSchema_();
      continue;
    }
    if (code === 404) return manual('Slip reading is misconfigured (model "' + model + '" not found). Tell your PO Desk admin.', { http: 404, attempts: attempt });
    if (code >= 500 && attempt < OCR.MAX_ATTEMPTS) { Utilities.sleep(1500); continue; }
    console.warn('Gemini ' + code + ': ' + truncate_(text, 300));
    return manual('Slip reading is unavailable right now.', { http: code, attempts: attempt, error: geminiError_(text) });
  }

  let raw;
  try {
    const json = JSON.parse(res.getContentText());
    if (json.promptFeedback && json.promptFeedback.blockReason) return manual('The slip could not be read automatically.', { http: 200, attempts: attempt, blocked: json.promptFeedback.blockReason });
    const cand = (json.candidates || [])[0];
    if (!cand || (cand.finishReason && cand.finishReason !== 'STOP')) return manual('The slip could not be read automatically.', { http: 200, attempts: attempt, finish: cand && cand.finishReason });
    const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
    raw = JSON.parse(text);
  } catch (err) {
    return manual('The slip could not be read automatically.', { http: 200, attempts: attempt });
  }

  const n = normalizeSlip_(raw, Number(getConfig('OCR_MIN_CONFIDENCE', 0.7)));
  const out = Object.assign({ status: 'ok', reason: '', model: model, ms: Date.now() - t0, attempts: attempt }, n);
  auditLog({ userId: ctx.userId, entityId: ctx.entityId, action: 'ocr.extract', ref: ctx.ref, ok: true, detail: { model: model, ms: out.ms, attempts: attempt, low: n.lowConfidence, checks: n.checks.map(c => c.code), schemaFallback: schemaFallback || undefined } });
  return out;
}

/**
 * Pure: cleans Gemini's answer and checks it adds up. Returns { fields, confidence, lowConfidence, checks }.
 * A failed check lowers the confidence of the fields involved so the review screen highlights them.
 */
function normalizeSlip_(raw, minConfidence) {
  raw = raw || {};
  const conf0 = raw.confidence || {};
  const confidence = {};
  const c = (k) => { const v = Number(conf0[k]); return isNaN(v) ? 0 : Math.max(0, Math.min(1, v)); };
  const money = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
  const text = (v, max) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
  const checks = [];

  const fields = {
    supplierName: text(raw.supplier_name, 100),
    supplierVatNumber: text(raw.supplier_vat_number, 20).replace(/\D/g, ''),
    slipNumber: text(raw.slip_number, 40),
    date: '',
    currency: text(raw.currency, 3).toUpperCase(),
    lineItems: (Array.isArray(raw.line_items) ? raw.line_items : []).slice(0, 50).map(li => {
      const qty = money(li.qty) || 1;
      const unit = money(li.unit_price_incl);
      let total = money(li.line_total_incl);
      if (total === null && unit !== null) total = Math.round(unit * qty * 100) / 100;
      return { description: text(li.description, 200), qty: qty, unitPriceIncl: unit, lineTotalIncl: total };
    }).filter(li => li.description || li.lineTotalIncl !== null),
    subtotalExcl: money(raw.subtotal_excl),
    vatAmount: money(raw.vat_amount),
    totalIncl: money(raw.total_incl),
    paymentMethodHint: text(raw.payment_method_hint, 10).toUpperCase(),
  };
  confidence.supplierName = fields.supplierName ? c('supplier_name') : 0;
  confidence.supplierVatNumber = fields.supplierVatNumber ? c('supplier_vat_number') : 0;
  confidence.slipNumber = fields.slipNumber ? c('slip_number') : 0;
  confidence.totalIncl = fields.totalIncl !== null ? c('total_incl') : 0;
  confidence.vatAmount = fields.vatAmount !== null ? c('vat_amount') : 0;
  confidence.lineItems = fields.lineItems.length ? c('line_items') : 0;

  const iso = text(raw.date, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00Z') : null;
  const realDate = d && !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
  if (realDate && d.getUTCFullYear() >= 2020 && d.getTime() <= Date.now() + 36 * 3600 * 1000) {
    fields.date = iso;
    confidence.date = c('date');
  } else {
    confidence.date = 0;
    if (iso) checks.push({ code: 'DATE_UNREADABLE', message: 'The date on the slip (' + iso + ') doesn’t look right. Check it.' });
  }

  if (fields.supplierVatNumber && !/^4\d{9}$/.test(fields.supplierVatNumber)) {
    checks.push({ code: 'VAT_NUMBER_FORMAT', message: 'The VAT number read (' + fields.supplierVatNumber + ') isn’t 10 digits starting with 4. Check it.' });
    confidence.supplierVatNumber = Math.min(confidence.supplierVatNumber, 0.3);
  }
  if (fields.currency && fields.currency !== 'ZAR') checks.push({ code: 'NOT_RAND', message: 'This slip doesn’t seem to be in rand (' + fields.currency + ').' });
  if (!fields.currency && fields.totalIncl !== null) fields.currency = 'ZAR';

  const priced = fields.lineItems.filter(li => li.lineTotalIncl !== null);
  if (fields.totalIncl !== null && priced.length) {
    const sum = Math.round(priced.reduce((s, li) => s + li.lineTotalIncl, 0) * 100) / 100;
    if (Math.abs(sum - fields.totalIncl) > OCR.LINES_TOLERANCE_ZAR) {
      checks.push({ code: 'LINES_NOT_TOTAL', message: 'The line items add up to R' + sum.toFixed(2) + ', not the total R' + fields.totalIncl.toFixed(2) + '. Check the total and the lines.' });
      confidence.totalIncl = Math.min(confidence.totalIncl, 0.5);
      confidence.lineItems = Math.min(confidence.lineItems, 0.5);
    }
  }
  if (/^4\d{9}$/.test(fields.supplierVatNumber) && fields.totalIncl !== null) {
    const expected = Math.round(fields.totalIncl * 15 / 115 * 100) / 100;
    if (fields.vatAmount === null) {
      checks.push({ code: 'VAT_MISSING', message: 'The slip has a VAT number but no VAT amount was read. Check the VAT line.' });
    } else if (Math.abs(fields.vatAmount - expected) > Math.max(OCR.VAT_TOLERANCE_ZAR, expected * OCR.VAT_TOLERANCE_PCT / 100)) {
      checks.push({ code: 'VAT_NOT_15', message: 'VAT reads R' + fields.vatAmount.toFixed(2) + ', but 15% VAT on R' + fields.totalIncl.toFixed(2) + ' is R' + expected.toFixed(2) + '. Some items may be zero-rated; check the slip.' });
      confidence.vatAmount = Math.min(confidence.vatAmount, 0.5);
    }
  }

  const lowConfidence = Object.keys(confidence).filter(k => confidence[k] < minConfidence);
  return { fields: fields, confidence: confidence, lowConfidence: lowConfidence, checks: checks };
}
