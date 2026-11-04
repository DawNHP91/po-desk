// My POs: this user's POs for the chosen company, newest first. Tap one for its detail.
import { h, alertBox, rand, statusChip, fmtDate } from './ui.js';
import { call } from '../api.js';

export function render(root, ctx) {
  const company = ctx.auth.selectedCompany();
  let alive = true;
  const list = h('div', { class: 'mt-4 space-y-3', 'aria-live': 'polite' });
  const refresh = h('button', { type: 'button', class: 'rounded-xl border-2 border-slate-300 bg-white px-4 py-2 text-base font-medium active:bg-slate-100 disabled:opacity-50', onclick: load }, 'Refresh');

  root.append(
    h('div', { class: 'mt-2 flex items-center justify-between gap-3' }, h('h1', { class: 'text-2xl font-bold' }, 'My POs'), refresh),
    list,
  );

  async function load() {
    refresh.disabled = true;
    if (!list.children.length) list.replaceChildren(h('p', { class: 'text-center text-slate-500' }, 'Loading…'));
    try {
      const r = await call('listPOs', { entityId: company.entityId });
      if (alive) draw(r.pos);
    } catch (err) {
      if (alive && err.code !== 'AUTH_REQUIRED') list.replaceChildren(alertBox(err.message));
    } finally {
      refresh.disabled = false;
    }
  }

  function draw(pos) {
    if (!pos.length) {
      list.replaceChildren(
        h('p', { class: 'mt-4 text-center text-slate-600' }, 'No POs for ' + company.name + ' yet.'),
        h('button', { type: 'button', class: 'mt-4 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white', onclick: () => ctx.go('/po/new') }, 'New PO'));
      return;
    }
    list.replaceChildren(...pos.map((po) => h('button', {
      type: 'button', onclick: () => ctx.go('/po/' + po.poId),
      class: 'flex w-full items-start justify-between gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 touch-manipulation active:bg-slate-50',
    },
      h('span', { class: 'min-w-0' },
        h('span', { class: 'block font-mono text-lg font-semibold' }, po.poNumber || po.provisionalRef),
        h('span', { class: 'block truncate text-slate-800' }, po.supplierName),
        h('span', { class: 'block truncate text-sm text-slate-500' }, fmtDate(po.createdAt) + ' · ' + po.description)),
      h('span', { class: 'shrink-0 text-right' },
        h('span', { class: 'block font-semibold' }, rand(po.amountInclZar)),
        h('span', { class: 'mt-1 block' }, statusChip(po.status))),
    )));
  }

  load();
  return () => { alive = false; };
}
