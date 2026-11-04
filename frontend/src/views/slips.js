// Add slip: the buyer's approved POs in this company that still need their slip.
import { h, fill, alertBox, rand, fmtDate, statusChip } from './ui.js';
import { call } from '../api.js';

export function render(root, ctx) {
  const company = ctx.auth.selectedCompany();
  let alive = true;
  const list = h('div', { class: 'mt-4 space-y-3', 'aria-live': 'polite' }, h('p', { class: 'text-center text-slate-500' }, 'Loading…'));
  root.append(
    h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Add slip'),
    h('p', { class: 'mt-1 text-slate-600' }, 'Choose the PO the slip belongs to.'),
    list,
  );

  call('listPOs', { entityId: company.entityId }).then((r) => {
    if (!alive) return;
    // Not yet sent to Xero (a bill that is on its way shows on the PO itself).
    const open = r.pos.filter((p) => p.status === 'ISSUED' && !(p.slip && p.slip.billStatus));
    if (!open.length) {
      fill(list, h('p', { class: 'mt-4 text-center text-slate-600' }, 'No approved POs are waiting for a slip.'),
        h('a', { href: '#/pos', class: 'mt-4 block text-center font-medium text-brand' }, 'See all my POs'));
      return;
    }
    fill(list, ...open.map((po) => h('button', {
      type: 'button',
      class: 'flex w-full items-start justify-between gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 touch-manipulation active:bg-slate-50',
      onclick: () => ctx.go(po.slip ? '/slip/' + po.slip.billId : '/po/' + po.poId + '/slip'),
    },
      h('span', { class: 'min-w-0' },
        h('span', { class: 'block font-mono text-lg font-semibold' }, po.poNumber),
        h('span', { class: 'block truncate text-slate-800' }, po.supplierName),
        h('span', { class: 'block text-sm text-slate-500' }, fmtDate(po.createdAt) + (po.slip ? (po.slip.reviewed ? ' · checked, bill not made yet' : ' · photo taken, not checked yet') : ''))),
      h('span', { class: 'shrink-0 text-right' }, h('span', { class: 'block font-semibold' }, rand(po.amountInclZar)), h('span', { class: 'mt-1 block' }, statusChip(po.status))),
    )));
  }).catch((err) => { if (alive && err.code !== 'AUTH_REQUIRED') fill(list, alertBox(err.message)); });

  return () => { alive = false; };
}
