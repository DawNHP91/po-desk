// Approvals (approvers only): POs over a buyer's limit, oldest first, each with approve or decline
// and an optional note for the buyer. The approval email links to #/approvals/<poId>, which opens
// that PO first; if someone already decided it, the screen says who.
import { h, fill, alertBox, rand, fmtDate, inputClass } from './ui.js';
import { call } from '../api.js';

const waited = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`) + ' of working time';

export function render(root, ctx, params) {
  const focusId = params[0] || '';
  let alive = true;
  const list = h('div', { class: 'mt-4 space-y-4', 'aria-live': 'polite' }, h('p', { class: 'text-center text-slate-500' }, 'Loading…'));
  root.append(
    h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Approvals'),
    h('p', { class: 'mt-1 text-slate-600' }, 'POs above the buyer’s limit wait here. The buyer can’t buy until you decide.'),
    list,
    h('a', { href: '#/home', class: 'mt-6 block py-3 text-center text-base font-medium text-slate-600' }, 'Home'),
  );
  load();

  async function load() {
    try {
      const r = await call('listApprovals', {});
      if (!alive) return;
      let items = r.items;
      let gone = null;
      if (focusId && !items.some((i) => i.poId === focusId)) {
        try { gone = await call('getPO', { poId: focusId }); } catch { gone = null; }
        if (!alive) return;
      }
      if (focusId) items = items.filter((i) => i.poId === focusId).concat(items.filter((i) => i.poId !== focusId));
      fill(list,
        gone ? alertBox(decidedText(gone), 'warn') : null,
        items.length ? null : h('p', { class: 'mt-4 text-center text-slate-600' }, 'Nothing is waiting for you.'),
        ...items.map((it) => card(it, !focusId || it.poId === focusId)));
    } catch (err) {
      if (alive && err.code !== 'AUTH_REQUIRED') fill(list, alertBox(err.message));
    }
  }

  function decidedText(po) {
    if (po.status === 'AWAITING_APPROVAL') return `${po.poNumber} is waiting, but not for you.`;
    const d = po.decision;
    const what = po.status === 'DECLINED' ? 'declined' : 'approved';
    return `${po.poNumber || 'This PO'} was already ${what}` + (d && d.by ? ` by ${d.by}` : '') + (d && d.at ? ` on ${fmtDate(d.at)}` : '') + '.';
  }

  function card(it, open) {
    const row = (k, v) => [h('dt', { class: 'text-sm text-slate-500' }, k), h('dd', { class: 'mb-2 text-base text-slate-900' }, v)];
    const note = h('textarea', { class: inputClass + ' text-base', rows: 2, maxlength: 300, placeholder: 'Note for the buyer (optional)', 'aria-label': `Note for ${it.buyerName}` });
    const msg = h('div', { class: 'mt-3', 'aria-live': 'polite' });
    const btn = 'rounded-2xl px-4 py-4 text-base font-semibold touch-manipulation disabled:opacity-60';
    const approve = h('button', { type: 'button', class: btn + ' bg-brand text-white active:opacity-90' }, 'Approve');
    const decline = h('button', { type: 'button', class: btn + ' border-2 border-red-300 bg-white text-red-800 active:bg-red-50' }, 'Decline');
    let declineArmed = false;
    const body = h('div', { class: open ? '' : 'hidden' },
      h('dl', { class: 'mt-3' },
        row('Buyer', `${it.buyerName} (limit ${rand(it.buyerLimitZar)})`),
        row('Supplier', it.supplierName),
        row('What', it.description),
        row('Account', it.accountCode + (it.accountName ? ' · ' + it.accountName : '')),
        row('Paid with', it.paidWith || '—'),
        row('Raised', fmtDate(it.createdAt) + ' · waiting ' + waited(it.waitingWorkMinutes))),
      it.own ? alertBox(`This is your own PO. No one else can approve ${it.company} POs, so you may; it will be marked self-approved.`, 'warn') : null,
      h('div', { class: 'mt-3' }, note),
      h('div', { class: 'mt-3 grid grid-cols-2 gap-3' }, decline, approve),
      msg);
    const head = h('button', { type: 'button', class: 'flex w-full items-start justify-between gap-3 text-left', 'aria-expanded': String(open), onclick: () => { const o = body.classList.toggle('hidden'); head.setAttribute('aria-expanded', String(!o)); } },
      h('span', { class: 'min-w-0' },
        h('span', { class: 'block text-sm font-medium text-slate-500' }, it.company),
        h('span', { class: 'block font-mono text-2xl font-bold' }, it.poNumber),
        h('span', { class: 'block truncate text-slate-800' }, it.supplierName)),
      h('span', { class: 'shrink-0 text-right text-xl font-bold' }, rand(it.amountInclZar)));
    const box = h('article', { class: 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200' }, head, body);

    async function decide(decision) {
      approve.disabled = decline.disabled = true;
      msg.replaceChildren(h('p', { class: 'text-slate-600' }, decision === 'approve' ? 'Approving in Xero…' : 'Declining in Xero…'));
      try {
        const r = await call('decidePO', { poId: it.poId, decision, note: note.value }, { timeoutMs: 45000 });
        if (!alive) return;
        const ok = r.status === 'ISSUED';
        fill(box, h('div', { class: `rounded-xl p-3 ${ok ? 'bg-green-50 text-green-900' : 'bg-slate-100 text-slate-800'}`, role: 'status' },
          h('p', { class: 'text-lg font-bold' }, `${r.poNumber} ${ok ? 'approved ✓' : 'declined'}`),
          h('p', { class: 'mt-1' }, r.self ? 'Marked self-approved.' : r.buyerEmailed ? `${it.buyerName.split(' ')[0]} has been emailed.` : `${it.buyerName.split(' ')[0]} sees it in PO Desk.`)));
      } catch (err) {
        approve.disabled = decline.disabled = false;
        if (err.code !== 'AUTH_REQUIRED') msg.replaceChildren(alertBox(err.message));
        if (err.code === 'ALREADY_DECIDED') { approve.disabled = decline.disabled = true; }
      }
    }
    approve.addEventListener('click', () => decide('approve'));
    decline.addEventListener('click', () => {
      // Declining cancels the PO in Xero: ask for a second tap.
      if (!declineArmed) { declineArmed = true; decline.textContent = 'Tap again to decline'; setTimeout(() => { declineArmed = false; if (!decline.disabled) decline.textContent = 'Decline'; }, 4000); return; }
      decide('decline');
    });
    return box;
  }

  return () => { alive = false; };
}
