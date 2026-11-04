// New PO (Flow 1 steps 2–4): payment method, supplier, what, amount, category, account.
// The server re-checks everything; this screen only makes the right answer the easy one.
import { h, fill, alertBox, rand, uuid, inputClass, labelClass } from './ui.js';
import { call } from '../api.js';
import { remember } from './po.js';

const MAX_RESULTS = 8;
const SUGGEST_DELAY_MS = 600;
// Errors after which the PO may already exist in Xero: resend the identical request (same idemKey)
// and the server returns that PO instead of creating a second one.
const MAYBE_CREATED = ['TIMEOUT', 'NETWORK', 'BAD_RESPONSE', 'BUSY', 'INTERNAL'];

const pmText = (pm) => (pm.type === 'CARD' && pm.last4 ? `${pm.label} ••${pm.last4}` : pm.label);

/** Accepts 1234.5, 1 234,50 and 1,234.50; returns cents-rounded number or NaN. */
function parseAmount(v) {
  let s = String(v || '').replace(/[R\s]/gi, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

export function render(root, ctx) {
  const { auth } = ctx;
  const company = auth.selectedCompany();
  const ent = company.entityId;
  const limit = Number(company.poLimitZar) || 0;
  let alive = true;
  let ref = null;
  const s = {
    pmId: '', supplier: null, categoryId: '', suggestion: null, suggesting: false, suggestPromise: null,
    suggestError: '', override: '', idemKey: uuid(), busy: false, frozen: null,
  };
  let suggestSeq = 0;
  let suggestTimer = null;

  root.append(h('p', { class: 'mt-6 text-center text-slate-500' }, 'Loading ' + company.name + '…'));
  auth.refData(ent)
    .then((d) => { if (alive) { ref = d; build(); } })
    .catch((err) => { if (alive && err.code !== 'AUTH_REQUIRED') root.replaceChildren(alertBox(err.message)); });

  function build() {
    // --- payment method ---
    const pmButtons = ref.paymentMethods.map((pm) => h('button', {
      type: 'button', 'data-pm': pm.pmId, onclick: () => setPm(pm.pmId),
      class: 'rounded-xl border-2 px-4 py-3 text-left text-base font-medium touch-manipulation',
    }, pmText(pm)));
    function setPm(id) {
      s.pmId = id;
      pmButtons.forEach((b) => {
        const on = b.getAttribute('data-pm') === id;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.className = 'rounded-xl border-2 px-4 py-3 text-left text-base font-medium touch-manipulation ' +
          (on ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white text-slate-900 active:bg-slate-100');
      });
    }
    const remembered = auth.lastPm(ent);
    setPm(ref.paymentMethods.some((p) => p.pmId === remembered) ? remembered : (ref.paymentMethods.length === 1 ? ref.paymentMethods[0].pmId : ''));

    // --- supplier ---
    const supInput = h('input', {
      id: 'supplier', type: 'search', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search',
      placeholder: 'Start typing the supplier’s name', class: inputClass,
    });
    const results = h('div', { class: 'mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white empty:hidden', role: 'listbox' });
    const chosen = h('div', { class: 'mt-1 hidden' });
    const supNote = h('div', { class: 'mt-2' });
    const newSup = h('div', {});

    supInput.addEventListener('input', renderResults);
    function renderResults() {
      results.replaceChildren();
      const typed = supInput.value.trim();
      const q = typed.toLowerCase();
      if (!q) return;
      const hits = ref.suppliers.filter((x) => x.name.toLowerCase().includes(q))
        .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
      hits.slice(0, MAX_RESULTS).forEach((x) => results.append(h('button', {
        type: 'button', role: 'option', onclick: () => pickSupplier(x),
        class: 'block w-full border-b border-slate-100 px-4 py-3 text-left text-base active:bg-slate-100',
      }, x.name)));
      if (hits.length > MAX_RESULTS) results.append(h('p', { class: 'border-b border-slate-100 px-4 py-2 text-sm text-slate-500' }, `${hits.length - MAX_RESULTS} more: keep typing`));
      if (!hits.some((x) => x.name.toLowerCase() === q)) {
        results.append(h('button', {
          type: 'button', onclick: () => openNewSupplier(typed),
          class: 'block w-full px-4 py-3 text-left text-base font-medium text-brand active:bg-slate-100',
        }, `+ New supplier “${typed}”`));
      }
    }

    function pickSupplier(x, note) {
      s.supplier = x;
      results.replaceChildren();
      newSup.replaceChildren();
      supInput.classList.add('hidden');
      chosen.classList.remove('hidden');
      chosen.replaceChildren(h('div', { class: 'flex items-center justify-between gap-3 rounded-xl border-2 border-brand bg-white px-4 py-3' },
        h('span', { class: 'min-w-0 truncate text-lg font-semibold' }, x.name),
        h('button', { type: 'button', class: 'shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-brand active:bg-slate-100', onclick: clearSupplier }, 'Change'),
      ));
      fill(supNote, note ? alertBox(note, 'warn') : null);
      suggestNow();
    }

    function clearSupplier() {
      s.supplier = null;
      chosen.classList.add('hidden');
      supInput.classList.remove('hidden');
      supNote.replaceChildren();
      supInput.focus();
      renderResults();
      suggestNow();
    }

    function openNewSupplier(name) {
      results.replaceChildren();
      const nameIn = h('input', { class: inputClass, maxlength: 100, autocomplete: 'organization', 'aria-label': 'Supplier name' });
      nameIn.value = name;
      const vatIn = h('input', { class: inputClass, inputmode: 'numeric', maxlength: 13, placeholder: '10 digits, starts with 4', 'aria-label': 'Supplier VAT number' });
      const msg = h('div', { class: 'mt-2' });
      const add = h('button', { type: 'button', class: 'flex-1 rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white disabled:opacity-50' }, 'Add supplier');
      const cancel = h('button', { type: 'button', class: 'rounded-xl px-4 py-3 text-base font-medium text-slate-700 active:bg-slate-100', onclick: () => { newSup.replaceChildren(); renderResults(); } }, 'Cancel');
      add.addEventListener('click', async () => {
        if (add.disabled) return;
        add.disabled = true;
        msg.replaceChildren(h('p', { class: 'text-slate-600' }, 'Adding to ' + company.name + '’s Xero…'));
        try {
          const r = await call('createSupplier', { entityId: ent, name: nameIn.value, vatNumber: vatIn.value });
          await auth.addSupplier(ent, r.supplier);
          pickSupplier(r.supplier, r.existing ? 'This supplier is already in Xero, so that one is used.' : '');
        } catch (err) {
          add.disabled = false;
          msg.replaceChildren(alertBox(err.message));
        }
      });
      newSup.replaceChildren(h('div', { class: 'mt-3 rounded-2xl border border-slate-200 bg-white p-4' },
        h('p', { class: 'text-lg font-semibold' }, 'New supplier'),
        h('label', { class: labelClass + ' mt-3' }, 'Name'), nameIn,
        h('label', { class: labelClass + ' mt-3' }, 'VAT number (optional)'), vatIn,
        msg,
        h('div', { class: 'mt-3 flex gap-3' }, add, cancel),
      ));
      nameIn.focus();
    }

    // --- what, amount, category ---
    const descIn = h('input', { id: 'desc', type: 'text', maxlength: 200, autocomplete: 'off', enterkeyhint: 'next', placeholder: 'e.g. Diesel for the bakkie', class: inputClass });
    descIn.addEventListener('input', () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(suggestNow, SUGGEST_DELAY_MS); });

    const amountIn = h('input', { id: 'amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', placeholder: '0.00', class: 'block w-full bg-transparent py-3 pr-4 text-lg focus:outline-none' });
    const amountBox = h('div', { class: 'mt-1 flex items-center rounded-xl border border-slate-300 bg-white focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30' },
      h('span', { class: 'pl-4 pr-1 text-lg text-slate-500' }, 'R'), amountIn);
    const limitNote = h('div', { class: 'mt-2' });
    amountIn.addEventListener('input', updateLimit);

    let catSelect = null;
    if (ref.categories.length) {
      catSelect = h('select', { id: 'category', class: inputClass }, h('option', { value: '' }, 'No category'),
        ref.categories.map((c) => h('option', { value: c.categoryId }, c.name)));
      catSelect.addEventListener('change', () => { s.categoryId = catSelect.value; suggestNow(); });
    }

    // --- account ---
    const acctBox = h('div', { class: 'mt-1 rounded-2xl border border-slate-200 bg-white p-4', 'aria-live': 'polite' });
    const acctSelect = h('select', { id: 'account', class: inputClass },
      h('option', { value: '' }, 'Use the suggestion'),
      ref.accounts.map((a) => h('option', { value: a.code }, `${a.code} · ${a.name}`)));
    acctSelect.addEventListener('change', () => { s.override = acctSelect.value; renderAccount(); });

    const accountName = (code) => (ref.accounts.find((a) => a.code === code) || {}).name || '';
    const chosenCode = () => s.override || (s.suggestion && s.suggestion.accountCode) || '';

    function renderAccount() {
      const lines = [];
      if (s.override) {
        lines.push(h('p', { class: 'text-lg font-semibold' }, `${s.override} · ${accountName(s.override)}`),
          h('p', { class: 'mt-1 text-sm text-slate-600' }, 'Chosen by you.'));
      } else if (s.suggesting && !s.suggestion) {
        lines.push(h('p', { class: 'text-slate-500' }, 'Finding the right account…'));
      } else if (s.suggestion && s.suggestion.accountCode) {
        lines.push(h('p', { class: 'text-lg font-semibold' }, `${s.suggestion.accountCode} · ${s.suggestion.accountName}`),
          h('p', { class: 'mt-1 text-sm text-slate-600' }, s.suggestion.reason));
        if (s.suggestion.needsReview) lines.push(h('p', { class: 'mt-2 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-sm font-medium text-amber-900' }, 'Check this account'));
        if (s.suggesting) lines.push(h('p', { class: 'mt-1 text-sm text-slate-400' }, 'Updating…'));
      } else {
        lines.push(h('p', { class: 'text-slate-600' }, s.suggestError || (s.suggestion ? s.suggestion.reason : 'Choose the supplier and say what you’re buying, and PO Desk suggests the account.')));
      }
      acctBox.replaceChildren(...lines);
    }

    function suggestNow() {
      clearTimeout(suggestTimer);
      const desc = descIn.value.trim();
      if (!s.supplier && !desc && !s.categoryId) { s.suggestion = null; s.suggesting = false; renderAccount(); return Promise.resolve(); }
      const seq = ++suggestSeq;
      s.suggesting = true;
      renderAccount();
      s.suggestPromise = call('suggest', { entityId: ent, contactId: s.supplier ? s.supplier.contactId : '', categoryId: s.categoryId, description: desc })
        .then((r) => { if (seq === suggestSeq) { s.suggestion = r; s.suggestError = ''; } })
        .catch((err) => { if (seq === suggestSeq) { s.suggestion = null; s.suggestError = err.message; } })
        .finally(() => { if (seq === suggestSeq && alive) { s.suggesting = false; renderAccount(); } });
      return s.suggestPromise;
    }

    // --- limit and submit ---
    const submitBtn = h('button', { type: 'button', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white shadow-sm touch-manipulation active:opacity-90 disabled:opacity-60' }, 'Get PO number');
    const message = h('div', { class: 'mt-4', 'aria-live': 'polite' });
    const overLimit = () => { const a = parseAmount(amountIn.value); return a > 0 && a > limit; };
    const submitLabel = () => (overLimit() ? 'Send for approval' : 'Get PO number');

    function updateLimit() {
      limitNote.replaceChildren(overLimit()
        ? alertBox(`Over your ${rand(limit)} limit: this PO will need approval before you buy.`, 'warn')
        : h('p', { class: 'text-sm text-slate-500' }, `Your limit: ${rand(limit)} per PO.`));
      if (!s.busy && !s.frozen) submitBtn.textContent = submitLabel();
    }

    const fields = () => [supInput, descIn, amountIn, catSelect, acctSelect, ...pmButtons].filter(Boolean);
    const setDisabled = (on) => fields().forEach((f) => { f.disabled = on; });

    function buildPayload() {
      if (!s.pmId) return { error: 'Choose how you’re paying.' };
      if (!s.supplier) return { error: 'Choose the supplier, or add a new one.' };
      const description = descIn.value.trim();
      if (description.length < 2) return { error: 'Say what you’re buying.' };
      const amount = parseAmount(amountIn.value);
      if (!(amount > 0)) return { error: 'Enter the amount including VAT, e.g. 450.00.' };
      const accountCode = chosenCode();
      if (!accountCode) return { error: 'Choose an account.' };
      return { entityId: ent, pmId: s.pmId, contactId: s.supplier.contactId, description, amountInclZar: amount, categoryId: s.categoryId, accountCode };
    }

    async function submit() {
      if (s.busy) return;            // a second tap while the first is in flight does nothing
      s.busy = true;
      submitBtn.disabled = true;
      message.replaceChildren();
      let payload = s.frozen;
      try {
        if (!payload) {
          if (s.suggesting && !s.override) { submitBtn.textContent = 'Checking the account…'; await s.suggestPromise; }
          payload = buildPayload();
          if (payload.error) throw Object.assign(new Error(payload.error), { code: 'FORM' });
        }
        setDisabled(true);
        submitBtn.textContent = overLimit() ? 'Sending for approval…' : 'Getting your PO number…';
        const t0 = performance.now();
        const po = await call('createPO', payload, { idemKey: s.idemKey, timeoutMs: 30000 });
        po.clientMs = Math.round(performance.now() - t0);
        auth.setLastPm(ent, payload.pmId);
        remember(po);
        ctx.go('/po/' + po.poId);
      } catch (err) {
        s.busy = false;
        submitBtn.disabled = false;
        if (MAYBE_CREATED.includes(err.code)) {
          s.frozen = payload;                       // same payload and idemKey on the retry
          submitBtn.textContent = 'Try again';
          message.replaceChildren(alertBox(err.message + ' Tap Try again: it won’t create a second PO.', 'warn'));
        } else {
          if (err.code !== 'FORM') s.idemKey = uuid();   // nothing was created; a fresh key for the corrected form
          s.frozen = null;
          setDisabled(false);
          submitBtn.textContent = submitLabel();
          if (err.code !== 'AUTH_REQUIRED') message.replaceChildren(alertBox(err.message));
        }
      }
    }
    submitBtn.addEventListener('click', submit);

    const section = (label, forId, ...kids) => h('div', { class: 'mt-6' }, h('label', { class: labelClass, for: forId || null }, label), ...kids);
    fill(root,
      h('h1', { class: 'mt-2 text-2xl font-bold' }, 'New PO'),
      h('div', { class: 'mt-6' }, h('p', { class: labelClass }, 'How are you paying?'),
        ref.paymentMethods.length
          ? h('div', { class: 'mt-2 grid grid-cols-1 gap-2', role: 'group', 'aria-label': 'Payment method' }, pmButtons)
          : alertBox('No cards or cash floats are set up for ' + company.name + '. Ask your PO Desk admin.')),
      section('Supplier', 'supplier', supInput, chosen, results, supNote, newSup),
      section('What are you buying?', 'desc', descIn),
      section('Amount including VAT', 'amount', amountBox, limitNote),
      catSelect ? section('Category', 'category', catSelect) : null,
      h('div', { class: 'mt-6' }, h('p', { class: labelClass }, 'Account'), acctBox,
        h('label', { class: labelClass + ' mt-3', for: 'account' }, 'Change account'), acctSelect),
      message,
      submitBtn,
      h('a', { href: '#/home', class: 'mt-3 block py-3 text-center text-base font-medium text-slate-600' }, 'Cancel'),
    );
    updateLimit();
    renderAccount();
  }

  return () => { alive = false; clearTimeout(suggestTimer); };
}
