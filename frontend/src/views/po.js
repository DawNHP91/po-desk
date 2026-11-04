// PO issued / PO detail. The number is shown large with a copy button when the buyer may use it;
// an over-limit PO is marked "don't buy yet"; a provisional ref is clearly not a PO number.
import { h, fill, alertBox, rand, statusChip, fmtDate } from './ui.js';
import { call } from '../api.js';
import { billCard, driveLink } from './review.js';

// The createPO answer, handed over by the New PO screen so the number shows without another call.
const handover = new Map();
export function remember(po) {
  handover.set(po.poId, po);
}

const BANNERS = {
  ISSUED: ['bg-green-50 text-green-900 ring-green-200', 'Approved: you can buy', 'Give this PO number to the supplier, or write it on the slip.'],
  AWAITING_APPROVAL: ['bg-amber-50 text-amber-950 ring-amber-300', 'Awaiting approval: don’t buy yet', 'This PO is above your limit. Wait until an approver has approved it.'],
  PENDING_XERO: ['bg-sky-50 text-sky-950 ring-sky-200', 'Xero isn’t answering right now', 'This is a provisional reference, not a PO number. PO Desk keeps trying; you’ll get the real PO number by email and here.'],
  DECLINED: ['bg-red-50 text-red-900 ring-red-200', 'Declined: don’t buy', 'An approver declined this PO.'],
  BILLED: ['bg-slate-100 text-slate-800 ring-slate-200', 'Billed', 'The draft bill for this PO is in Xero, with the slip attached.'],
  CANCELLED: ['bg-slate-100 text-slate-700 ring-slate-200', 'Cancelled', 'This PO was cancelled.'],
};

export function render(root, ctx, params) {
  const poId = params[0];
  let alive = true;
  const first = handover.get(poId);
  handover.delete(poId);            // later visits fetch the current status instead
  if (first) draw(first, true);
  else load();

  async function load() {
    root.replaceChildren(h('p', { class: 'mt-6 text-center text-slate-500' }, 'Loading PO…'));
    try {
      const po = await call('getPO', { poId });
      if (alive) draw(po, false);
    } catch (err) {
      if (alive && err.code !== 'AUTH_REQUIRED') root.replaceChildren(alertBox(err.message), h('a', { href: '#/pos', class: 'mt-4 block text-center font-medium text-brand' }, 'Back to My POs'));
    }
  }

  function draw(po, justCreated) {
    const [tone, title, sub] = BANNERS[po.status] || BANNERS.CANCELLED;
    const provisional = !po.poNumber;
    const number = po.poNumber || po.provisionalRef;
    const usable = po.status === 'ISSUED' || po.status === 'PENDING_XERO';

    const approverNote = po.status === 'AWAITING_APPROVAL' && po.approvers
      ? (po.approvers.notified ? `We emailed ${po.approvers.names.join(', ')}.` : po.approvers.warning)
      : '';

    const numText = h('p', {
      // Provisional refs (NHP-P-261104-01) are longer than PO numbers; keep them on one line.
      class: 'mt-1 select-all whitespace-nowrap font-mono font-bold ' + (provisional ? 'text-3xl ' : 'text-4xl tracking-wide ') + (po.status === 'AWAITING_APPROVAL' ? 'text-slate-400' : 'text-slate-900'),
      id: 'po-number',
    }, number);
    const copyBtn = usable ? h('button', {
      type: 'button', class: 'mt-3 w-full rounded-xl border-2 border-brand px-4 py-3 text-base font-semibold text-brand touch-manipulation active:bg-slate-100',
    }, provisional ? 'Copy reference' : 'Copy PO number') : null;
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(number);
          copyBtn.textContent = 'Copied ✓';
        } catch {
          // No clipboard access (older browser): select the text so a long-press copies it.
          const r = document.createRange(); r.selectNodeContents(numText);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          copyBtn.textContent = 'Selected: tap Copy';
        }
        setTimeout(() => { if (alive) copyBtn.textContent = provisional ? 'Copy reference' : 'Copy PO number'; }, 2500);
      });
    }

    const row = (k, v) => [h('dt', { class: 'text-sm text-slate-500' }, k), h('dd', { class: 'mb-3 text-base text-slate-900' }, v)];
    fill(root,
      h('div', { class: `mt-2 rounded-2xl p-4 ring-1 ${tone}`, role: 'status' },
        h('p', { class: 'text-xl font-bold' }, title),
        h('p', { class: 'mt-1' }, sub),
        approverNote ? h('p', { class: 'mt-2 font-medium' }, approverNote) : null,
        po.decision ? h('p', { class: 'mt-2 font-medium' }, (po.status === 'DECLINED' ? 'Declined by ' : 'Approved by ') + (po.decision.self ? 'you (self-approved)' : po.decision.by) +
          (po.decision.note ? `: “${po.decision.note}”` : '.')) : null),
      h('div', { class: 'mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200' },
        h('div', { class: 'flex items-center justify-between gap-3' },
          h('p', { class: 'text-sm font-medium text-slate-600' }, provisional ? 'Provisional reference' : 'PO number'),
          statusChip(po.status)),
        numText,
        copyBtn,
        justCreated && po.clientMs ? h('p', { class: 'mt-2 text-right text-xs text-slate-400' }, `Number in ${(po.clientMs / 1000).toFixed(1)} s`) : null,
        po.duplicate ? h('p', { class: 'mt-2 text-sm text-slate-500' }, 'This PO was already created; this is the same one.') : null,
      ),
      h('dl', { class: 'mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200' },
        row('Supplier', po.supplierName),
        row('Amount incl. VAT', rand(po.amountInclZar)),
        row('What', po.description),
        row('Account', po.accountCode + (po.accountName ? ' · ' + po.accountName : '')),
        row('Paid with', po.paidWith || '—'),
        row('Date', fmtDate(po.createdAt)),
      ),
      po.status === 'PENDING_XERO' ? h('button', { type: 'button', class: 'mt-4 w-full rounded-2xl border-2 border-slate-300 bg-white px-4 py-3 text-base font-semibold active:bg-slate-100', onclick: load }, 'Check again') : null,
      slipSection(po),
      h('div', { class: 'mt-6 grid grid-cols-2 gap-3' },
        h('button', { type: 'button', class: 'rounded-2xl bg-brand px-4 py-4 text-base font-semibold text-white active:opacity-90', onclick: () => ctx.go('/po/new') }, 'New PO'),
        h('button', { type: 'button', class: 'rounded-2xl border-2 border-slate-300 bg-white px-4 py-4 text-base font-semibold active:bg-slate-100', onclick: () => ctx.go('/pos') }, 'My POs')),
    );
  }

  // Once bought, the slip and its bill: photograph it, check it and create the bill, then see the
  // bill's state with a link to the slip.
  function slipSection(po) {
    const s = po.slip;
    if (po.status !== 'ISSUED' && !(s && s.billStatus)) return null;
    const btn = 'w-full rounded-2xl px-4 py-4 text-base font-semibold touch-manipulation';
    if (!s) {
      return h('button', { type: 'button', class: btn + ' mt-4 bg-brand text-white active:opacity-90', onclick: () => ctx.go('/po/' + po.poId + '/slip') }, 'Photograph the slip');
    }
    if (s.billStatus) {
      return h('section', { 'aria-label': 'Bill' },
        billCard(s, po.poNumber),
        driveLink(s.slipUrl),
        h('div', { class: 'mt-2 grid grid-cols-2 gap-3' },
          h('button', { type: 'button', class: btn + ' border-2 border-slate-300 bg-white active:bg-slate-100', onclick: () => ctx.go('/slip/' + s.billId) }, 'Slip details'),
          s.billStatus === 'BILLED' ? null : h('button', { type: 'button', class: btn + ' border-2 border-slate-300 bg-white active:bg-slate-100', onclick: load }, 'Check again')));
    }
    return h('div', {},
      s.rejected ? h('div', { class: 'mt-4' }, alertBox('Xero didn’t accept the bill: ' + s.rejected)) : null,
      h('div', { class: 'mt-4 grid grid-cols-2 gap-3' },
        h('button', { type: 'button', class: btn + ' bg-brand text-white active:opacity-90', onclick: () => ctx.go('/slip/' + s.billId) }, s.reviewed ? 'Create the bill' : 'Check the slip'),
        h('button', { type: 'button', class: btn + ' border-2 border-slate-300 bg-white active:bg-slate-100', onclick: () => ctx.go('/po/' + po.poId + '/slip') }, 'Retake photo')));
  }

  return () => { alive = false; };
}
