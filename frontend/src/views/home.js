// Home: the main actions for the chosen company. Approvals arrives in a later stage.
import { h, icon, alertBox } from './ui.js';

const ICONS = {
  newPo: ['M12 5v14', 'M5 12h14'],
  slip: ['M4 7h3l2-3h6l2 3h3v12H4z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  approve: ['M9 12l2 2 4-4', 'M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z'],
};

export function render(root, ctx) {
  const { auth } = ctx;
  const me = auth.getMe();
  const company = auth.selectedCompany();
  const notice = h('div', { class: 'mt-4', 'aria-live': 'polite' });

  const soon = (what) => () => notice.replaceChildren(alertBox(what + ' arrives in the next stage of the build.', 'warn'));
  const tile = (label, sub, paths, onclick) => h('button', {
    type: 'button',
    class: 'flex aspect-square flex-col justify-between rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 touch-manipulation active:bg-slate-50',
    onclick,
  },
    h('span', { class: 'text-brand' }, icon(paths)),
    h('span', {}, h('span', { class: 'block text-lg font-semibold' }, label), h('span', { class: 'block text-sm text-slate-500' }, sub)),
  );

  root.append(h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Hi ' + me.user.firstName));

  if (!company) {
    root.append(h('p', { class: 'mt-2 text-slate-600' }, auth.buyCompanies().length
      ? 'Choose a company to start.'
      : 'You can’t raise POs for any company yet. Ask your PO Desk admin to give you access.'));
  }

  const tiles = [];
  if (company) {
    tiles.push(
      tile('New PO', 'Get a PO number', ICONS.newPo, () => ctx.go('/po/new')),
      tile('Add slip', 'Photograph a till slip', ICONS.slip, () => ctx.go('/slips')),
      tile('My POs', 'Numbers and status', ICONS.list, () => ctx.go('/pos')),
    );
  }
  if (me.canApproveAny) tiles.push(tile('Approvals', 'POs over a limit', ICONS.approve, soon('Approvals')));
  if (tiles.length) root.append(h('div', { class: 'mt-6 grid grid-cols-2 gap-3' }, tiles));
  root.append(notice);

  // Load this company's reference data now, so New PO opens instantly later and any access
  // problem shows up here rather than mid-purchase.
  if (company) {
    const status = h('p', { class: 'mt-6 text-center text-sm text-slate-500' }, 'Loading ' + company.name + ' data…');
    root.append(status);
    auth.refData(company.entityId).then((d) => {
      status.textContent = `${company.name}: ${d.paymentMethods.length} payment methods · ${d.suppliers.length} suppliers · ${d.accounts.length} accounts · ${d.categories.length} categories`;
    }).catch((err) => {
      if (err.code !== 'AUTH_REQUIRED') status.replaceChildren(alertBox(err.message));
    });
  }
}
