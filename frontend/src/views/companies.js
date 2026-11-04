// Company picker: one large branded tile per company the user may buy for.
// The router skips this screen when there is only one.
import { h, rand } from './ui.js';
import { solid } from '../brand.js';

export function render(root, ctx) {
  const { auth } = ctx;
  const current = auth.selectedCompany();

  const tiles = auth.buyCompanies().map((c) => {
    const b = ctx.brand(c.brandKey);
    const isCurrent = current && current.entityId === c.entityId;
    return h('button', {
      type: 'button',
      class: 'flex w-full items-center gap-4 rounded-2xl border-2 border-[var(--tile)] bg-white p-4 text-left shadow-sm touch-manipulation active:scale-[0.99] active:bg-slate-50',
      vars: { '--tile': solid(b) },
      'aria-current': isCurrent ? 'true' : null,
      onclick: () => { auth.selectCompany(c.entityId); ctx.go('/home'); },
    },
      h('span', { class: 'flex h-16 w-24 shrink-0 items-center justify-center' },
        h('img', { src: b.logo, alt: '', class: 'max-h-16 max-w-24 object-contain' })),
      h('span', { class: 'min-w-0' },
        h('span', { class: 'block text-xl font-semibold' }, c.name),
        h('span', { class: 'block truncate text-sm text-slate-500' }, c.legalName),
        c.poLimitZar > 0 ? h('span', { class: 'mt-1 block text-sm text-slate-600' }, 'Your limit: ' + rand(c.poLimitZar)) : null,
        isCurrent ? h('span', { class: 'mt-1 block text-sm font-medium text-[var(--tile)]' }, 'Current company') : null,
      ),
    );
  });

  root.append(
    h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Who are you buying for?'),
    h('p', { class: 'mt-1 text-slate-600' }, 'The PO goes into this company’s books in Xero.'),
    h('div', { class: 'mt-6 space-y-4' }, tiles),
  );
}
