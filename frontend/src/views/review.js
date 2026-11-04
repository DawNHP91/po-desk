// Check the slip and create the bill (CLAUDE.md Flow 2 steps 5–6): pre-filled and editable. Warnings
// are amber notes that never block; fields Gemini was unsure of are outlined; the photo opens full
// screen to zoom. Once sent to Xero the slip is shown read-only with the bill's state.
import { h, fill, alertBox, rand, fmtDate, handover, inputClass, labelClass, parseAmount } from './ui.js';
import { call } from '../api.js';

// Same wording and rules as Main.gs slipFlags_ so the notes match what is stored with the bill.
const GENERIC = ['pty', 'ltd', 'cc', 'inc', 'the', 'and', 'limited', 'company', 'trading', 'group', 'store', 'stores', 'shop', 'motors', 'services',
  'supplies', 'supply', 'market', 'supermarket', 'hardware', 'pharmacy', 'garage', 'station', 'centre', 'center', 'sa', 'south', 'africa'];
// Same rules as namesMatch_ in Main.gs (fuzzy on): keep the two in step.
function namesMatch(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\(pty\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const na = norm(a); const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const words = (s) => s.split(' ').filter((w) => w.length >= 3 && !GENERIC.includes(w));
  const wa = words(na); const wb = words(nb);
  if (wa.some((w) => wb.includes(w))) return true;
  const ca = na.replace(/ /g, ''); const cb = nb.replace(/ /g, '');
  if (Math.min(ca.length, cb.length) >= 4 && (ca.includes(cb) || cb.includes(ca))) return true;
  return nearlySame(ca, cb) || wa.some((x) => wb.some((y) => nearlySame(x, y)));
}

// At most 1 letter different (5–9 letters) or 2 (10 or more); shorter words must match exactly.
function nearlySame(x, y) {
  const len = Math.min(x.length, y.length);
  const allowed = len < 5 ? 0 : len < 10 ? 1 : 2;
  if (!allowed || Math.abs(x.length - y.length) > allowed) return false;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > allowed) return false;
    prev = cur;
  }
  return prev[y.length] <= allowed;
}

function liveFlags(po, f, t) {
  const out = [];
  const total = parseAmount(f.totalIncl);
  if (total > 0 && po.amountInclZar > 0) {
    const diff = Math.round((total - po.amountInclZar) * 100) / 100;
    const pct = Math.abs(diff) / po.amountInclZar * 100;
    if (Math.abs(diff) > t.varianceZar || pct > t.variancePct) out.push(`The slip total ${rand(total)} is ${rand(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the PO amount ${rand(po.amountInclZar)} (${Math.round(pct)}%).`);
  }
  if (f.supplierName.trim() && !namesMatch(f.supplierName, po.supplierName)) out.push(`The slip is from “${f.supplierName.trim()}”, but the PO is for “${po.supplierName}”.`);
  if (!f.supplierVatNumber.replace(/\D/g, '')) out.push('No supplier VAT number: the bill will use No VAT, so no VAT can be claimed back on it.');
  if (total > t.fullInvoiceZar) out.push(`Over ${rand(t.fullInvoiceZar)}: SARS needs a full tax invoice showing your company’s name, address and VAT number, not only a till slip.`);
  if (f.date) {
    const poDay = new Date(new Date(po.createdAt).getTime() + 2 * 3600e3).toISOString().slice(0, 10);
    const days = Math.round(Math.abs(new Date(f.date + 'T00:00:00Z') - new Date(poDay + 'T00:00:00Z')) / 86400000);
    if (days > t.dateDays) out.push(`The slip is dated ${f.date}, ${days} days from the PO (${poDay}).`);
  }
  return out;
}

export function render(root, ctx, params) {
  const billId = params[0];
  let alive = true;
  let view = null;
  let dataUrl = null;
  const given = handover.get('slip:' + billId);
  handover.delete('slip:' + billId);
  if (given && given.view) { view = given.view; dataUrl = given.dataUrl; show(); } else load(given && given.dataUrl);

  function show() {
    if (view.bill && view.bill.billStatus) readOnly();
    else build();
  }

  async function load(knownUrl) {
    fill(root, h('p', { class: 'mt-6 text-center text-slate-500' }, 'Loading the slip…'));
    try {
      const v = await call('getSlip', { billId, withImage: !knownUrl }, { timeoutMs: 45000 });
      if (!alive) return;
      view = v;
      dataUrl = knownUrl || (v.image ? `data:${v.image.mimeType};base64,${v.image.base64}` : null);
      show();
    } catch (err) {
      if (alive && err.code !== 'AUTH_REQUIRED') fill(root, alertBox(err.message), h('a', { href: '#/slips', class: 'mt-4 block text-center font-medium text-brand' }, 'Back'));
    }
  }

  function build() {
    const po = view.po;
    const f = view.fields;
    const low = new Set(view.status === 'ok' ? view.lowConfidence : []);
    const serverDup = (view.flags || []).filter((x) => x.code === 'DUPLICATE').map((x) => x.message);
    const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);

    // --- fields ---
    const input = (id, value, attrs) => { const el = h('input', Object.assign({ id, class: inputClass, autocomplete: 'off' }, attrs || {})); el.value = value === null || value === undefined ? '' : String(value); return el; };
    const money = (id, value) => {
      const el = h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', class: 'block w-full bg-transparent py-3 pr-4 text-lg focus:outline-none' });
      el.value = value === null || value === undefined ? '' : Number(value).toFixed(2);
      return { el, box: h('div', { class: 'mt-1 flex items-center rounded-xl border border-slate-300 bg-white focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30' }, h('span', { class: 'pl-4 pr-1 text-lg text-slate-500' }, 'R'), el) };
    };
    const inp = {
      supplierName: input('s-supplier', f.supplierName, { maxlength: 100 }),
      supplierVatNumber: input('s-vat', f.supplierVatNumber, { inputmode: 'numeric', maxlength: 13, placeholder: '10 digits, starts with 4; empty if none' }),
      slipNumber: input('s-number', f.slipNumber, { maxlength: 40 }),
      date: input('s-date', f.date, { type: 'date', max: today }),
    };
    const total = money('s-total', f.totalIncl);
    const vat = money('s-vatamt', f.vatAmount);
    const vatHint = h('p', { class: 'mt-1 text-sm text-slate-500' });

    const field = (key, label, control, hint) => {
      const flagged = low.has(key);
      const wrap = h('div', { class: 'mt-5 rounded-xl ' + (flagged ? 'bg-amber-50 p-2 ring-2 ring-amber-400' : '') },
        h('label', { class: labelClass, for: (control.el || control).id || null }, label, flagged ? h('span', { class: 'ml-1 font-semibold text-amber-800' }, '· check this') : null),
        control.box || control, hint || null);
      if (flagged) (control.el || control).addEventListener('input', () => { wrap.className = 'mt-5 rounded-xl'; wrap.querySelector('label span')?.remove(); }, { once: true });
      return wrap;
    };

    // --- line items ---
    let lines = (f.lineItems || []).map((li) => ({ description: li.description, qty: li.qty, lineTotalIncl: li.lineTotalIncl }));
    const linesBox = h('div', { class: 'mt-2 space-y-2' });
    const linesSum = h('p', { class: 'mt-2 text-sm' });
    const linesOpen = { on: low.has('lineItems') };
    const linesToggle = h('button', { type: 'button', class: 'mt-6 flex w-full items-center justify-between rounded-xl bg-white px-4 py-3 text-left text-base font-medium ring-1 ring-slate-200' + (low.has('lineItems') ? ' ring-2 ring-amber-400' : ''), onclick: () => { linesOpen.on = !linesOpen.on; renderLines(); } });
    function renderLines() {
      linesToggle.replaceChildren(h('span', {}, `Items on the slip (${lines.length})` + (low.has('lineItems') ? ' · check these' : '')), h('span', { 'aria-hidden': 'true' }, linesOpen.on ? '▲' : '▼'));
      if (!linesOpen.on) { linesBox.replaceChildren(); updateLive(); return; }
      fill(linesBox, ...lines.map((li, i) => {
        const d = h('input', { class: 'min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base', 'aria-label': `Line ${i + 1} description` });
        d.value = li.description || '';
        const q = h('input', { class: 'w-16 rounded-lg border border-slate-300 px-2 py-2 text-base', inputmode: 'decimal', 'aria-label': `Line ${i + 1} quantity` });
        q.value = li.qty === null || li.qty === undefined ? '1' : String(li.qty);
        const a = h('input', { class: 'w-24 rounded-lg border border-slate-300 px-2 py-2 text-right text-base', inputmode: 'decimal', 'aria-label': `Line ${i + 1} amount` });
        a.value = li.lineTotalIncl === null || li.lineTotalIncl === undefined ? '' : Number(li.lineTotalIncl).toFixed(2);
        d.addEventListener('input', () => { li.description = d.value; });
        q.addEventListener('input', () => { li.qty = q.value; });
        a.addEventListener('input', () => { li.lineTotalIncl = a.value; updateLive(); });
        return h('div', { class: 'flex items-center gap-2' }, d, q, a,
          h('button', { type: 'button', class: 'rounded-lg px-2 py-2 text-slate-500 active:bg-slate-100', 'aria-label': `Remove line ${i + 1}`, onclick: () => { lines.splice(i, 1); renderLines(); } }, '✕'));
      }), h('button', { type: 'button', class: 'rounded-lg px-3 py-2 text-base font-medium text-brand active:bg-slate-100', onclick: () => { lines.push({ description: '', qty: 1, lineTotalIncl: '' }); renderLines(); } }, '+ Add a line'));
      updateLive();
    }

    // --- live notes ---
    const flagsBox = h('div', { class: 'mt-4 space-y-2', 'aria-live': 'polite' });

    // --- which supplier, when the slip names another one (asked before anything goes to Xero) ---
    let suppliers = [];
    ctx.auth.refData(po.entityId).then((d) => { suppliers = d.suppliers || []; shownFor = null; if (alive) updateLive(); }).catch(() => {});
    let choice = null;          // { key, mode: 'keep' | 'existing' | 'new', contactId? }
    let shownFor = null;
    const choiceBox = h('fieldset', { class: 'mt-6' });
    function renderChoice(slipName) {
      const name = slipName.trim();
      if (name === shownFor) return;
      shownFor = name;
      if (!name || namesMatch(name, po.supplierName)) { choice = null; choiceBox.replaceChildren(); return; }
      const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const near = suppliers.filter((x) => x.name !== po.supplierName && namesMatch(name, x.name)).slice(0, 3);
      const options = [{ key: 'keep', mode: 'keep', label: `Keep ${po.supplierName}`, sub: 'The PO’s supplier' }]
        .concat(near.map((x) => ({ key: 'c:' + x.contactId, mode: 'existing', contactId: x.contactId, label: `Change to ${x.name}`, sub: 'Already a supplier in Xero' })));
      if (!near.some((x) => norm(x.name) === norm(name))) options.push({ key: 'new', mode: 'new', label: `Change to “${name}”`, sub: 'Added to Xero as a supplier if it isn’t there yet' });
      if (choice && !options.some((o) => o.key === choice.key)) choice = null;
      fill(choiceBox,
        h('legend', { class: 'text-lg font-semibold' }, 'Which supplier is this bill for?'),
        h('p', { class: 'text-sm text-slate-600' }, `The slip says “${name}”; the PO is for ${po.supplierName}.`),
        ...options.map((o) => {
          const radio = h('input', { type: 'radio', name: 'bill-supplier', value: o.key, class: 'mt-1 h-5 w-5 shrink-0 accent-brand' });
          radio.checked = !!choice && choice.key === o.key;
          radio.addEventListener('change', () => { choice = { key: o.key, mode: o.mode, contactId: o.contactId }; });
          return h('label', { class: 'mt-2 flex items-start gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200 active:bg-slate-50' }, radio,
            h('span', { class: 'min-w-0' }, h('span', { class: 'block font-medium' }, o.label), h('span', { class: 'block text-sm text-slate-500' }, o.sub)));
        }));
    }
    const values = () => ({
      supplierName: inp.supplierName.value, supplierVatNumber: inp.supplierVatNumber.value, slipNumber: inp.slipNumber.value,
      date: inp.date.value, totalIncl: total.el.value, vatAmount: vat.el.value === '' ? null : vat.el.value,
      paymentMethodHint: f.paymentMethodHint || '',
      lineItems: lines.filter((li) => String(li.description || '').trim() || String(li.lineTotalIncl ?? '').trim() !== ''),
    });
    function updateLive() {
      const v = values();
      const t = parseAmount(v.totalIncl);
      vatHint.textContent = t > 0 ? `15% VAT on ${rand(t)} would be ${rand(Math.round(t * 15 / 115 * 100) / 100)}.` : '';
      const priced = lines.map((li) => parseAmount(li.lineTotalIncl)).filter((x) => !Number.isNaN(x));
      if (priced.length && t > 0) {
        const sum = Math.round(priced.reduce((s, x) => s + x, 0) * 100) / 100;
        const off = Math.abs(sum - t) > 0.05;
        linesSum.className = 'mt-2 text-sm ' + (off ? 'font-medium text-amber-800' : 'text-slate-500');
        linesSum.textContent = `Items add up to ${rand(sum)}` + (off ? `, not the total ${rand(t)}.` : '.');
      } else linesSum.textContent = '';
      const notes = liveFlags(po, v, view.thresholds).concat(serverDup);
      fill(flagsBox, ...notes.map((n) => alertBox(n, 'warn')));
      renderChoice(v.supplierName);
    }
    [inp.supplierName, inp.supplierVatNumber, inp.date, total.el, vat.el].forEach((el) => el.addEventListener('input', updateLive));

    // --- banner ---
    const banner = view.status === 'manual'
      ? h('div', { class: 'mt-2 rounded-2xl bg-sky-50 p-4 text-sky-950 ring-1 ring-sky-200', role: 'status' },
        h('p', { class: 'text-lg font-bold' }, 'Type the details from the slip'),
        h('p', { class: 'mt-1' }, view.reason || 'The slip couldn’t be read automatically.'),
        h('button', { type: 'button', class: 'mt-3 rounded-xl border-2 border-sky-300 bg-white px-4 py-2 font-semibold active:bg-sky-100', onclick: readAgain }, 'Try reading again'))
      : view.status === 'reviewed'
        ? h('div', { class: 'mt-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200', role: 'status' }, h('p', { class: 'font-semibold' }, 'Checked earlier, not sent to Xero yet'), h('p', { class: 'mt-1 text-slate-600' }, 'Check it once more, then create the bill.'))
        : h('div', { class: 'mt-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200', role: 'status' },
          h('p', { class: 'font-semibold' }, 'Read from the photo'),
          h('p', { class: 'mt-1 text-slate-600' }, low.size ? 'Check every value against the slip, especially the outlined ones.' : 'Check every value against the slip.'));

    async function readAgain(e) {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'Reading…';
      try {
        view = await call('readSlip', { billId }, { timeoutMs: 90000 });
        if (alive) build();
      } catch (err) {
        b.disabled = false;
        b.textContent = 'Try reading again';
        if (err.code !== 'AUTH_REQUIRED') message.replaceChildren(alertBox(err.message));
      }
    }

    // --- photo ---
    const photo = dataUrl
      ? h('button', { type: 'button', class: 'mt-4 block w-full overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200', 'aria-label': 'Open the photo full screen', onclick: () => openZoom(dataUrl) },
        h('img', { src: dataUrl, alt: 'Slip photo', class: 'max-h-72 w-full object-contain' }),
        h('span', { class: 'block py-1.5 text-center text-sm text-slate-600' }, 'Tap to zoom'))
      : null;

    const message = h('div', { class: 'mt-4', 'aria-live': 'polite' });
    const LABEL = 'Create the bill in Xero';
    let confirmDup = false;   // set once the server has said "looks like a duplicate" and the buyer goes ahead
    [inp.supplierName, inp.slipNumber, inp.date, total.el].forEach((el) => el.addEventListener('input', () => { if (confirmDup) { confirmDup = false; save.textContent = LABEL; } }));
    const save = h('button', { type: 'button', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white touch-manipulation active:opacity-90 disabled:opacity-60' }, LABEL);
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      const v = values();
      if (!v.date) { message.replaceChildren(alertBox('Enter the date on the slip.')); inp.date.focus(); return; }
      if (!(parseAmount(v.totalIncl) > 0)) { message.replaceChildren(alertBox('Enter the slip total including VAT.')); total.el.focus(); return; }
      const asked = choiceBox.childElementCount > 0;
      if (asked && !choice) { message.replaceChildren(alertBox('Choose which supplier the bill is for.')); choiceBox.scrollIntoView({ block: 'center' }); return; }
      save.disabled = true;
      save.textContent = 'Creating the bill…';
      message.replaceChildren();
      try {
        const r = await call('submitBill', { billId, fields: v, supplier: asked ? { mode: choice.mode, contactId: choice.contactId } : undefined, confirmDuplicate: confirmDup }, { timeoutMs: 90000 });
        if (alive) done(r);
      } catch (err) {
        save.disabled = false;
        save.textContent = LABEL;
        if (err.code === 'TIMEOUT') message.replaceChildren(alertBox('PO Desk is still working on it. Open the PO in a minute to see the bill; tapping again won’t make a second one.', 'warn'));
        else if (err.code === 'SUPPLIER_CHOICE') { shownFor = null; renderChoice(inp.supplierName.value); message.replaceChildren(alertBox(err.message)); }
        else if (err.code === 'DUPLICATE_CHECK') { confirmDup = true; save.textContent = 'Create the bill anyway'; message.replaceChildren(alertBox(err.message, 'warn')); }
        else if (err.code !== 'AUTH_REQUIRED') message.replaceChildren(alertBox(err.message));
      }
    });

    fill(root,
      h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Check the slip'),
      h('p', { class: 'mt-1 text-slate-600' }, `${po.poNumber} · ${po.supplierName} · PO amount ${rand(po.amountInclZar)}`),
      view.bill && view.bill.rejected ? h('div', { class: 'mt-2' }, alertBox(`Xero didn’t accept the bill: ${view.bill.rejected} Correct the details and tap “${LABEL}” again.`)) : null,
      banner,
      photo,
      (view.checks || []).length ? h('div', { class: 'mt-4 space-y-2' }, view.checks.map((c) => alertBox(c.message, 'warn'))) : null,
      flagsBox,
      field('supplierName', 'Supplier (as on the slip)', inp.supplierName),
      field('supplierVatNumber', 'Supplier VAT number', inp.supplierVatNumber),
      field('slipNumber', 'Slip or invoice number', inp.slipNumber),
      field('date', 'Date on the slip', inp.date),
      field('totalIncl', 'Total including VAT', total),
      field('vatAmount', 'VAT on the slip', vat, vatHint),
      linesToggle, linesBox, linesSum,
      choiceBox,
      message,
      save,
      h('a', { href: '#/po/' + po.poId, class: 'mt-3 block py-3 text-center text-base font-medium text-slate-600' }, 'Back to the PO'),
    );
    renderLines();
  }

  // After Create the bill: what happened in Xero, in plain words.
  function done(r) {
    fill(root,
      billCard(r, view.po.poNumber),
      r.duplicate ? h('p', { class: 'mt-3 text-slate-600' }, 'This slip had already been sent; nothing new was created in Xero.') : null,
      (r.flags || []).length ? h('div', { class: 'mt-4 space-y-2' }, h('p', { class: 'font-medium' }, 'Noted with the bill:'), r.flags.map((x) => alertBox(x.message, 'warn'))) : null,
      driveLink(r.slipUrl),
      navButtons());
  }

  // A slip already sent to Xero: its bill, the photo and the values as sent. Nothing editable.
  function readOnly() {
    const f = view.fields;
    const row = (k, v) => [h('dt', { class: 'text-sm text-slate-500' }, k), h('dd', { class: 'mb-3 text-base text-slate-900' }, v)];
    fill(root,
      h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Slip and bill'),
      h('p', { class: 'mt-1 text-slate-600' }, `${view.po.poNumber} · PO amount ${rand(view.po.amountInclZar)}`),
      billCard(view.bill, view.po.poNumber),
      dataUrl ? h('button', { type: 'button', class: 'mt-4 block w-full overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200', 'aria-label': 'Open the photo full screen', onclick: () => openZoom(dataUrl) },
        h('img', { src: dataUrl, alt: 'Slip photo', class: 'max-h-72 w-full object-contain' }),
        h('span', { class: 'block py-1.5 text-center text-sm text-slate-600' }, 'Tap to zoom')) : null,
      h('dl', { class: 'mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200' },
        row('Supplier on the slip', f.supplierName || '—'),
        row('Supplier VAT number', f.supplierVatNumber || 'None'),
        row('Slip number', f.slipNumber || '—'),
        row('Date on the slip', f.date ? fmtDate(f.date + 'T12:00:00+02:00') : '—'),
        row('Total incl. VAT', f.totalIncl === null || f.totalIncl === undefined ? '—' : rand(f.totalIncl)),
        row('VAT on the slip', f.vatAmount === null || f.vatAmount === undefined ? '—' : rand(f.vatAmount))),
      driveLink(view.bill.slipUrl),
      navButtons());
  }

  function navButtons() {
    return h('div', { class: 'mt-6 grid grid-cols-2 gap-3' },
      h('button', { type: 'button', class: 'rounded-2xl bg-brand px-4 py-4 text-base font-semibold text-white', onclick: () => ctx.go('/po/' + view.po.poId) }, 'Back to the PO'),
      h('button', { type: 'button', class: 'rounded-2xl border-2 border-slate-300 bg-white px-4 py-4 text-base font-semibold', onclick: () => ctx.go('/home') }, 'Home'));
  }

  return () => { alive = false; closeZoom(); };
}

const STEP_TEXT = { bill: 'creating the bill', attachBill: 'attaching the slip to the bill', attachPO: 'attaching the slip to the PO', poBilled: 'marking the PO billed' };

/** The bill's state: made, still finishing off, or waiting for Xero. b: billView_ fields from the server. */
export function billCard(b, poNumber) {
  const left = (b.pending || []).map((k) => STEP_TEXT[k]).filter(Boolean);
  const [tone, title, text] = b.billStatus === 'BILLED'
    ? ['bg-green-50 text-green-900 ring-green-200', 'Draft bill in Xero ✓', `The slip is attached to the bill and to ${poNumber}, and the PO is marked billed.`]
    : b.invoiceCreated
      ? ['bg-sky-50 text-sky-950 ring-sky-200', 'Bill made in Xero; finishing off', `Still to do: ${left.join(', ') || 'a last check'}. PO Desk finishes this by itself within a few minutes.`]
      : ['bg-sky-50 text-sky-950 ring-sky-200', 'Waiting for Xero', 'Xero isn’t answering right now. The slip and details are saved; PO Desk creates the bill by itself as soon as Xero answers.'];
  const row = (k, v) => [h('dt', { class: 'text-sm opacity-75' }, k), h('dd', { class: 'mb-2 font-medium' }, v)];
  return h('div', { class: `mt-4 rounded-2xl p-4 ring-1 ${tone}`, role: 'status' },
    h('p', { class: 'text-xl font-bold' }, title),
    h('p', { class: 'mt-1' }, text),
    b.billRef || b.xeroTotal !== null ? h('dl', { class: 'mt-3' },
      b.billRef ? row('Reference in Xero', b.billRef) : null,
      b.xeroTotal !== null && b.xeroTotal !== undefined ? row('Bill total', rand(b.xeroTotal) + (b.xeroVat !== null && b.xeroVat !== undefined ? ` · VAT ${rand(b.xeroVat)}` : '')) : null,
      b.billSupplier ? row('Supplier', b.billSupplier + (b.supplierChanged ? ' (changed from the PO’s)' : '')) : null) : null,
    b.vatMatches === false ? h('p', { class: 'mt-2 font-medium' }, 'Xero’s VAT differs from the slip; your PO Desk admin will check it.') : null);
}

/** "View slip" opens the photo in Google Drive. It is not shared, so only PO Desk's own account can open it. */
export function driveLink(url) {
  if (!url) return null;
  return h('div', { class: 'mt-4 text-center' },
    h('a', { href: url, target: '_blank', rel: 'noopener', class: 'inline-block py-2 text-base font-semibold text-brand underline' }, 'View slip in Google Drive'),
    h('p', { class: 'text-sm text-slate-500' }, 'Opens for PO Desk’s own Google account only.'));
}

// --- full-screen zoom: buttons and double-tap zoom; drag/scroll to pan ---
let zoomEl = null;
function closeZoom() {
  if (zoomEl) { zoomEl.remove(); zoomEl = null; document.body.classList.remove('overflow-hidden'); }
}
function openZoom(src) {
  closeZoom();
  let z = 1;
  const img = h('img', { src, alt: 'Slip photo, zoomable', class: 'block max-w-none select-none' });
  const setZ = (n) => { z = Math.max(1, Math.min(4, n)); img.style.width = (z * 100) + '%'; level.textContent = Math.round(z * 100) + '%'; };
  const level = h('span', { class: 'min-w-14 text-center text-white' });
  img.addEventListener('dblclick', () => setZ(z > 1 ? 1 : 2.5));
  const btn = 'rounded-xl bg-white/15 px-4 py-2 text-lg font-semibold text-white active:bg-white/25';
  zoomEl = h('div', { class: 'fixed inset-0 z-50 flex flex-col bg-black', role: 'dialog', 'aria-label': 'Slip photo' },
    h('div', { class: 'flex items-center justify-between gap-2 p-3' },
      h('button', { type: 'button', class: btn, 'aria-label': 'Zoom out', onclick: () => setZ(z - 0.5) }, '−'),
      level,
      h('button', { type: 'button', class: btn, 'aria-label': 'Zoom in', onclick: () => setZ(z + 0.5) }, '+'),
      h('button', { type: 'button', class: btn, onclick: closeZoom }, 'Close')),
    h('div', { class: 'min-h-0 flex-1 overflow-auto overscroll-contain' }, img));
  document.body.append(zoomEl);
  document.body.classList.add('overflow-hidden');
  setZ(1);
}
