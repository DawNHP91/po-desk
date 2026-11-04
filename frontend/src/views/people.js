// People (admins only): everyone with their role, companies and status; add or edit a person;
// email a Set PIN link (new person, or Reset PIN); deactivate or reactivate. Admins never see or
// type anyone's PIN. The server re-checks the caller is an admin on every call.
import { h, fill, alertBox, rand, inputClass, labelClass, parseAmount } from './ui.js';
import { call } from '../api.js';

const ROLE_TEXT = { buyer: 'Buyer', approver: 'Approver', admin: 'Admin' };

export function render(root, ctx, params) {
  const sub = params[0] || '';   // '' = list, 'new', or a userId
  let alive = true;
  const main = h('div', {}, h('p', { class: 'mt-6 text-center text-slate-500' }, 'Loading…'));
  root.append(main);
  if (!ctx.auth.getMe().isAdmin) { fill(main, alertBox('Only a PO Desk admin can manage people.')); return; }
  load();

  async function load() {
    try {
      const r = await call('listPeople', {});
      if (!alive) return;
      if (!sub) list(r);
      else form(r, sub === 'new' ? null : r.people.find((p) => p.userId === sub));
    } catch (err) {
      if (alive && err.code !== 'AUTH_REQUIRED') fill(main, alertBox(err.message));
    }
  }

  function status(p) {
    if (!p.active) return ['Inactive', 'bg-slate-200 text-slate-700'];
    if (p.locked) return ['Locked', 'bg-red-100 text-red-800'];
    if (!p.hasPin) return [p.linkPending ? 'PIN link sent' : 'No PIN yet', 'bg-amber-100 text-amber-900'];
    return ['Active', 'bg-green-100 text-green-800'];
  }
  const chip = ([label, cls]) => h('span', { class: `inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-medium ${cls}` }, label);
  const access = (p) => p.companies.filter((c) => c.canBuy || c.canApprove)
    .map((c) => c.name + ' ' + [c.canBuy ? `buy ≤ ${rand(c.poLimitZar)}` : '', c.canApprove ? 'approve' : ''].filter(Boolean).join(', ')).join(' · ') || 'No companies';

  function list(r) {
    fill(main,
      h('div', { class: 'mt-2 flex items-center justify-between gap-3' },
        h('h1', { class: 'text-2xl font-bold' }, 'People'),
        h('button', { type: 'button', class: 'rounded-xl bg-brand px-4 py-2.5 text-base font-semibold text-white active:opacity-90', onclick: () => ctx.go('/people/new') }, 'Add a person')),
      h('div', { class: 'mt-4 space-y-3' }, ...r.people.map((p) => h('button', {
        type: 'button', class: 'block w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50' + (p.active ? '' : ' opacity-70'),
        onclick: () => ctx.go('/people/' + p.userId),
      },
        h('span', { class: 'flex items-start justify-between gap-3' },
          h('span', { class: 'min-w-0' }, h('span', { class: 'block font-semibold' }, p.name + (p.userId === r.meId ? ' (you)' : '')), h('span', { class: 'block truncate text-sm text-slate-600' }, p.email)),
          h('span', { class: 'shrink-0 text-right' }, chip(status(p)), h('span', { class: 'mt-1 block text-sm text-slate-500' }, ROLE_TEXT[p.role] || p.role))),
        h('span', { class: 'mt-2 block text-sm text-slate-700' }, access(p))))),
      h('a', { href: '#/home', class: 'mt-6 block py-3 text-center text-base font-medium text-slate-600' }, 'Home'));
  }

  function form(r, p, notice) {
    if (sub !== 'new' && !p) { fill(main, alertBox('Person not found.'), h('a', { href: '#/people', class: 'mt-4 block text-center font-medium text-brand' }, 'Back to People')); return; }
    const isMe = p && p.userId === r.meId;
    const input = (id, value, attrs) => { const el = h('input', Object.assign({ id, class: inputClass, autocomplete: 'off' }, attrs || {})); el.value = value || ''; return el; };
    const name = input('p-name', p && p.name, { maxlength: 80, autocapitalize: 'words' });
    const email = input('p-email', p && p.email, { type: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', maxlength: 120 });
    const role = h('select', { id: 'p-role', class: inputClass }, ...['buyer', 'approver', 'admin'].map((x) => h('option', { value: x }, ROLE_TEXT[x])));
    role.value = p ? p.role : 'buyer';
    const rows = r.companies.map((c) => {
      const cur = (p && p.companies.find((x) => x.entityId === c.entityId)) || { canBuy: false, canApprove: false, poLimitZar: 0 };
      const buy = h('input', { type: 'checkbox', class: 'h-5 w-5 accent-brand', 'aria-label': `${c.name}: can buy` });
      const approve = h('input', { type: 'checkbox', class: 'h-5 w-5 accent-brand', 'aria-label': `${c.name}: can approve` });
      const limit = h('input', { class: 'w-28 rounded-lg border border-slate-300 px-3 py-2 text-right text-base disabled:bg-slate-100', inputmode: 'decimal', 'aria-label': `${c.name}: limit in rand`, placeholder: '0.00' });
      buy.checked = cur.canBuy; approve.checked = cur.canApprove;
      limit.value = cur.poLimitZar ? Number(cur.poLimitZar).toFixed(2) : '';
      const sync = () => { limit.disabled = !buy.checked; };
      buy.addEventListener('change', sync); sync();
      const el = h('div', { class: 'rounded-xl bg-white p-3 ring-1 ring-slate-200' },
        h('p', { class: 'font-semibold' }, c.name),
        h('div', { class: 'mt-2 flex flex-wrap items-center gap-x-5 gap-y-2' },
          h('label', { class: 'flex items-center gap-2' }, buy, 'Can buy'),
          h('label', { class: 'flex items-center gap-2' }, approve, 'Can approve'),
          h('label', { class: 'flex items-center gap-2' }, 'Limit R', limit)));
      return { c, buy, approve, limit, el };
    });
    const msg = h('div', { class: 'mt-4', 'aria-live': 'polite' }, notice ? h('p', { class: 'rounded-xl bg-green-50 p-3 text-green-900', role: 'status' }, notice) : null);
    const save = h('button', { type: 'button', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white active:opacity-90 disabled:opacity-60' }, p ? 'Save changes' : 'Add and email a PIN link');
    save.addEventListener('click', async () => {
      const companies = rows.map(({ c, buy, approve, limit }) => ({ entityId: c.entityId, canBuy: buy.checked, canApprove: approve.checked, poLimitZar: buy.checked ? limit.value : 0 }));
      const badLimit = companies.find((x) => x.canBuy && (x.poLimitZar === '' || Number.isNaN(parseAmount(x.poLimitZar))));
      if (badLimit) { msg.replaceChildren(alertBox(`Enter the ${badLimit.entityId} limit in rand, e.g. 1500.`)); return; }
      save.disabled = true;
      msg.replaceChildren();
      try {
        const res = await call('savePerson', { userId: p ? p.userId : '', name: name.value, email: email.value, role: role.value, companies });
        if (!alive) return;
        if (res.created) {
          fill(main, h('div', { class: 'mt-2 rounded-2xl bg-green-50 p-4 text-green-900 ring-1 ring-green-200', role: 'status' },
            h('p', { class: 'text-xl font-bold' }, `${res.person.name} added`),
            h('p', { class: 'mt-1' }, res.linkEmailed ? `We emailed ${res.person.email} a link to choose their PIN. It works once, for 48 hours.` : 'The email with their PIN link could not be sent. Open them and tap Send PIN link again.')),
          h('button', { type: 'button', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-base font-semibold text-white', onclick: () => ctx.go('/people') }, 'Back to People'));
        } else {
          msg.replaceChildren(h('p', { class: 'rounded-xl bg-green-50 p-3 text-green-900', role: 'status' }, 'Saved.'));
          save.disabled = false;
        }
      } catch (err) {
        save.disabled = false;
        if (err.code !== 'AUTH_REQUIRED') msg.replaceChildren(alertBox(err.message));
      }
    });

    const actions = [];
    if (p) {
      const btn = 'w-full rounded-2xl border-2 px-4 py-3 text-base font-semibold active:bg-slate-100 disabled:opacity-60';
      if (p.active) {
        const pinBtn = h('button', { type: 'button', class: btn + ' border-slate-300 bg-white' }, p.hasPin ? 'Reset PIN' : 'Send PIN link');
        let armed = false;
        pinBtn.addEventListener('click', async () => {
          // A reset stops the old PIN at once, so it takes a second tap.
          if (p.hasPin && !armed) { armed = true; pinBtn.textContent = 'Tap again: their PIN stops working'; return; }
          pinBtn.disabled = true;
          try {
            const res = await call('resetPin', { userId: p.userId });
            if (!alive) return;
            p = res.person;
            msg.replaceChildren(h('p', { class: 'rounded-xl bg-green-50 p-3 text-green-900', role: 'status' }, res.linkEmailed ? `Emailed a new PIN link to ${p.email}. It works once, for 48 hours.` : 'The email could not be sent. Try again later.'));
            pinBtn.textContent = 'Send PIN link again'; armed = true;
          } catch (err) { if (err.code !== 'AUTH_REQUIRED') msg.replaceChildren(alertBox(err.message)); }
          pinBtn.disabled = false;
        });
        actions.push(pinBtn);
      }
      if (!isMe) {
        const act = h('button', { type: 'button', class: btn + (p.active ? ' border-red-300 bg-white text-red-800' : ' border-slate-300 bg-white') }, p.active ? 'Deactivate' : 'Reactivate');
        let armed = false;
        act.addEventListener('click', async () => {
          if (p.active && !armed) { armed = true; act.textContent = 'Tap again: they are signed out at once'; return; }
          act.disabled = true;
          try {
            const res = await call('setPersonActive', { userId: p.userId, active: !p.active });
            if (alive) form(r, res.person, res.person.active ? 'Reactivated.' : 'Deactivated: they were signed out. Their POs and history stay.');
          } catch (err) { act.disabled = false; if (err.code !== 'AUTH_REQUIRED') msg.replaceChildren(alertBox(err.message)); }
        });
        actions.push(act);
      }
    }

    fill(main,
      h('h1', { class: 'mt-2 text-2xl font-bold' }, p ? p.name : 'Add a person'),
      p ? h('p', { class: 'mt-1' }, chip(status(p)), p.linkPending ? h('span', { class: 'ml-2 text-sm text-slate-600' }, 'link valid until ' + new Date(p.linkExpires).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : null) : null,
      h('div', { class: 'mt-5' }, h('label', { class: labelClass, for: 'p-name' }, 'Full name'), name),
      h('div', { class: 'mt-5' }, h('label', { class: labelClass, for: 'p-email' }, 'Email'), email),
      h('div', { class: 'mt-5' }, h('label', { class: labelClass, for: 'p-role' }, 'Role'), role,
        h('p', { class: 'mt-1 text-sm text-slate-500' }, 'Admins also manage people. What someone may buy or approve is set per company below.')),
      h('h2', { class: 'mt-6 text-lg font-semibold' }, 'Companies'),
      h('div', { class: 'mt-2 space-y-3' }, ...rows.map((x) => x.el)),
      msg,
      save,
      actions.length ? h('div', { class: 'mt-6 space-y-3' }, ...actions) : null,
      h('a', { href: '#/people', class: 'mt-4 block py-3 text-center text-base font-medium text-slate-600' }, 'Back to People'));
  }

  return () => { alive = false; };
}
