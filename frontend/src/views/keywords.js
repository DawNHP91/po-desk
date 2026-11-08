// Categories & keywords (admins only). A category name is the same category in every company that has
// it. Admins switch it on per company, add or remove keywords (all companies at once, or one), see the
// keywords PO Desk learned from old bills, and ask the AI for ideas. The server re-checks admin rights.
import { h, fill, alertBox, inputClass, labelClass } from './ui.js';
import { call } from '../api.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

/** How old bills back a keyword, in words; tone 'warn' when they mostly went elsewhere. */
function evidence(ev) {
  if (!ev) return { text: 'Not on any old bill yet.', warn: false };
  const w = `“${ev.word}”`;
  if (ev.right === ev.lines) return { text: `${plural(ev.lines, 'old bill line')} with ${w}, all to this category.`, warn: false };
  const other = ev.other ? `${ev.other.lines} to ${ev.other.label}` : '';
  if (ev.right === 0) return { text: `${plural(ev.lines, 'old bill line')} with ${w}, none to this category${other ? ` (${other})` : ''}.`, warn: true };
  return { text: `${plural(ev.lines, 'old bill line')} with ${w}: ${ev.right} to this category${other ? `, ${other}` : ''}.`, warn: ev.right / ev.lines < 0.5 };
}

export function render(root, ctx, params) {
  const name = params[0] ? decodeURIComponent(params[0]) : '';
  let alive = true;
  let data = null;
  const main = h('div', {}, h('p', { class: 'mt-6 text-center text-slate-500' }, 'Loading…'));
  root.append(main);
  if (!ctx.auth.getMe().isAdmin) { fill(main, alertBox('Only a PO Desk admin can manage categories and keywords.')); return; }
  load();

  async function load() {
    try {
      data = await call('listKeywords', {});
      if (!alive) return;
      if (!name) list();
      else detail(data.categories.find((c) => c.name.toLowerCase() === name.toLowerCase()));
    } catch (err) {
      if (alive && err.code !== 'AUTH_REQUIRED') fill(main, alertBox(err.message));
    }
  }

  const companyName = (id) => (data.companies.find((c) => c.entityId === id) || { name: id }).name;
  const stateChip = (co) => {
    const [label, cls] = !co.valid ? ['no account', 'bg-red-100 text-red-800'] : co.active ? ['On', 'bg-green-100 text-green-800'] : ['Off', 'bg-slate-200 text-slate-700'];
    return h('span', { class: `inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}` }, `${co.entityId} ${co.accountCode || '—'} · ${label}`);
  };
  const setupNote = () => (data.columnsReady ? null : h('div', { class: 'mt-4' }, alertBox('One setup step is left: run setupSheets() once in the Apps Script editor. Until then keywords can’t be saved.', 'warn')));

  // --- list ---------------------------------------------------------------------------------------
  function list() {
    fill(main,
      h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Categories & keywords'),
      h('p', { class: 'mt-1 text-slate-600' }, 'Keywords point a purchase to a category’s account, on New PO and for each item on a slip. A category only counts once it’s switched on for that company.'),
      setupNote(),
      tester(),
      h('div', { class: 'mt-6 space-y-3' }, ...data.categories.map((c) => h('button', {
        type: 'button', class: 'block w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 active:bg-slate-50',
        onclick: () => ctx.go('/keywords/' + encodeURIComponent(c.name)),
      },
        h('span', { class: 'block font-semibold' }, c.name),
        h('span', { class: 'mt-2 flex flex-wrap gap-1.5' }, ...c.companies.map(stateChip)),
        h('span', { class: 'mt-2 block text-sm text-slate-600' }, `${plural(c.keywords.length, 'keyword')} · ${c.learned.length} learned`)))),
      h('a', { href: '#/home', class: 'mt-6 block py-3 text-center text-base font-medium text-slate-600' }, 'Home'));
  }

  /** Type a description, see what PO Desk would suggest in one company. */
  function tester() {
    const company = h('select', { id: 'kw-test-co', class: inputClass }, ...data.companies.map((c) => h('option', { value: c.entityId }, c.name)));
    const desc = h('input', { id: 'kw-test', class: inputClass, placeholder: 'e.g. JIK REG 750ML', autocomplete: 'off', maxlength: 200 });
    const out = h('div', { class: 'mt-3', 'aria-live': 'polite' });
    const btn = h('button', { type: 'submit', class: 'mt-3 w-full rounded-xl border-2 border-brand bg-white px-4 py-3 text-base font-semibold text-brand active:bg-slate-50 disabled:opacity-60' }, 'Test');
    const form = h('form', { class: 'mt-5 rounded-2xl bg-white p-4 ring-1 ring-slate-200' },
      h('h2', { class: 'text-lg font-semibold' }, 'Try a description'),
      h('label', { class: labelClass + ' mt-2', for: 'kw-test-co' }, 'Company'), company,
      h('label', { class: labelClass + ' mt-3', for: 'kw-test' }, 'What is being bought, or a line from a slip'), desc,
      btn, out);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!desc.value.trim()) { desc.focus(); return; }
      btn.disabled = true;
      out.replaceChildren(h('p', { class: 'text-slate-500' }, 'Checking…'));
      try {
        const r = await call('testKeywords', { entityId: company.value, description: desc.value });
        if (!alive) return;
        out.replaceChildren(
          h('p', { class: 'text-base' }, '→ ', h('strong', {}, r.accountCode ? `${r.accountCode} ${r.accountName}` : 'no account'), r.needsReview ? ' (needs review)' : ''),
          h('p', { class: 'text-sm text-slate-600' }, r.reason),
          ...r.switchedOff.map((x) => h('p', { class: 'mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900' }, `${x.name} is switched off in ${companyName(company.value)}: its keyword “${x.keyword}” would catch this once it’s on.`)));
      } catch (err) {
        if (err.code !== 'AUTH_REQUIRED') out.replaceChildren(alertBox(err.message));
      }
      btn.disabled = false;
    });
    return form;
  }

  // --- one category ---------------------------------------------------------------------------------
  function detail(cat, notice) {
    if (!cat) { fill(main, alertBox('Category not found.'), h('a', { href: '#/keywords', class: 'mt-4 block text-center font-medium text-brand' }, 'Back to categories')); return; }
    const msg = h('div', { class: 'mt-3', 'aria-live': 'polite' }, notice ? h('p', { class: 'rounded-xl bg-green-50 p-3 text-green-900', role: 'status' }, notice) : null);
    const showError = (err) => { if (err.code !== 'AUTH_REQUIRED') msg.replaceChildren(alertBox(err.message)); };
    const replace = (c, note) => {
      const i = data.categories.findIndex((x) => x.name === c.name);
      if (i !== -1) data.categories[i] = c;
      if (alive) detail(c, note);
    };
    const all = cat.companies.map((c) => c.entityId);
    const where = (ids) => (ids.length === all.length ? '' : 'Only ' + ids.map(companyName).join(', '));

    // switched on, per company
    const switches = cat.companies.map((co) => {
      const btn = h('button', {
        type: 'button', role: 'switch', 'aria-checked': String(co.active), 'aria-label': `${cat.name} in ${co.company}`,
        class: 'shrink-0 rounded-full px-4 py-2 text-base font-semibold disabled:opacity-50 ' + (co.active ? 'bg-brand text-white' : 'border-2 border-slate-300 bg-white text-slate-700'),
        disabled: !co.valid && !co.active,
      }, co.active ? 'On' : 'Off');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const r = await call('setCategoryActive', { categoryId: co.categoryId, active: !co.active });
          replace(r.category, `${cat.name} is now ${co.active ? 'off' : 'on'} in ${co.company}.`);
        } catch (err) { btn.disabled = false; showError(err); }
      });
      return h('div', { class: 'flex items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200' },
        h('div', { class: 'min-w-0' },
          h('p', { class: 'font-semibold' }, co.company),
          h('p', { class: 'text-sm ' + (co.valid ? 'text-slate-600' : 'text-red-800') }, co.valid ? `${co.accountCode} ${co.accountName}` : `${co.accountCode || 'No account'}: not a purchase account in this company’s chart. Fix it in the Categories tab.`)),
        btn);
    });

    // add
    const kw = h('input', { id: 'kw-add', class: inputClass, placeholder: 'e.g. bleach, jik, mop', autocomplete: 'off', autocapitalize: 'none', maxlength: 400 });
    const scope = h('select', { id: 'kw-scope', class: inputClass }, h('option', { value: '' }, cat.companies.length > 1 ? 'All companies' : cat.companies[0].company),
      ...(cat.companies.length > 1 ? cat.companies.map((co) => h('option', { value: co.entityId }, 'Only ' + co.company)) : []));
    const addBtn = h('button', { type: 'submit', class: 'mt-3 w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white active:opacity-90 disabled:opacity-60' }, 'Add');
    const addForm = h('form', {},
      h('label', { class: labelClass, for: 'kw-add' }, 'Add keywords'), kw,
      h('p', { class: 'mt-1 text-sm text-slate-500' }, 'Separate several with commas. Plurals count: “mop” also finds “MOPS”.'),
      h('label', { class: labelClass + ' mt-3', for: 'kw-scope' }, 'For'), scope, addBtn);
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!kw.value.trim()) { kw.focus(); return; }
      addBtn.disabled = true;
      try {
        const r = await call('saveKeyword', { name: cat.name, op: 'add', keyword: kw.value, entityIds: scope.value ? [scope.value] : [] });
        replace(r.category, 'Added.');
      } catch (err) { addBtn.disabled = false; showError(err); }
    });

    const remove = async (btn, k, ids) => {
      btn.disabled = true;
      try {
        const r = await call('saveKeyword', { name: cat.name, op: 'remove', keyword: k, entityIds: ids });
        replace(r.category, `Removed “${k}”. PO Desk won’t learn it again.`);
      } catch (err) { btn.disabled = false; showError(err); }
    };
    const row = (x) => {
      const ev = evidence(x.evidence);
      const btn = h('button', { type: 'button', class: 'shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-red-800 active:bg-red-50 disabled:opacity-50', 'aria-label': `Remove ${x.k}` }, 'Remove');
      btn.addEventListener('click', () => remove(btn, x.k, x.entityIds));
      return h('li', { class: 'flex items-start justify-between gap-3 py-2.5' },
        h('div', { class: 'min-w-0' },
          h('p', { class: 'font-medium' }, x.k, where(x.entityIds) ? h('span', { class: 'ml-2 text-sm font-normal text-slate-500' }, where(x.entityIds)) : null),
          h('p', { class: 'text-sm ' + (ev.warn ? 'text-amber-800' : 'text-slate-500') }, ev.text)),
        btn);
    };
    const listOf = (items, empty) => (items.length
      ? h('ul', { class: 'mt-1 divide-y divide-slate-200 rounded-xl bg-white px-3 ring-1 ring-slate-200' }, ...items.map(row))
      : h('p', { class: 'mt-1 text-slate-500' }, empty));

    // AI ideas
    const ideasBox = h('div', { class: 'mt-2', 'aria-live': 'polite' });
    const ideasBtn = h('button', { type: 'button', class: 'mt-2 w-full rounded-xl border-2 border-brand bg-white px-4 py-3 text-base font-semibold text-brand active:bg-slate-50 disabled:opacity-60' }, 'Suggest keywords with AI');
    ideasBtn.addEventListener('click', async () => {
      ideasBtn.disabled = true;
      ideasBox.replaceChildren(h('p', { class: 'text-slate-500' }, 'Asking the AI… this takes about 10 seconds.'));
      try {
        const r = await call('keywordIdeas', { name: cat.name }, { timeoutMs: 60000 });
        if (!alive) return;
        ideasBox.replaceChildren(r.ideas.length
          ? h('ul', { class: 'divide-y divide-slate-200 rounded-xl bg-white px-3 ring-1 ring-slate-200' }, ...r.ideas.map(ideaRow))
          : h('p', { class: 'text-slate-500' }, 'No new ideas this time.'));
      } catch (err) {
        if (err.code !== 'AUTH_REQUIRED') ideasBox.replaceChildren(alertBox(err.message));
      }
      ideasBtn.disabled = false;
      ideasBtn.textContent = 'Ask again';
    });
    function ideaRow(x) {
      const ev = evidence(x.evidence);
      const btn = x.takenBy ? null : h('button', { type: 'button', class: 'shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white active:opacity-90 disabled:opacity-50', 'aria-label': `Add ${x.k}` }, 'Add');
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const r = await call('saveKeyword', { name: cat.name, op: 'add', keyword: x.k });
            const i = data.categories.findIndex((c) => c.name === r.category.name);
            if (i !== -1) data.categories[i] = r.category;
            btn.textContent = 'Added';
            keywordsBox.replaceChildren(listOf(r.category.keywords, 'No keywords yet.'));
            keywordsTitle.textContent = `Keywords (${r.category.keywords.length})`;
          } catch (err) { btn.disabled = false; showError(err); }
        });
      }
      return h('li', { class: 'flex items-start justify-between gap-3 py-2.5' },
        h('div', { class: 'min-w-0' },
          h('p', { class: 'font-medium' }, x.k),
          x.why ? h('p', { class: 'text-sm text-slate-600' }, x.why) : null,
          x.takenBy ? h('p', { class: 'text-sm text-amber-800' }, `Already a keyword of ${x.takenBy}.`) : h('p', { class: 'text-sm ' + (ev.warn ? 'text-amber-800' : 'text-slate-500') }, ev.text)),
        btn);
    }

    const keywordsTitle = h('h2', { class: 'mt-6 text-lg font-semibold' }, `Keywords (${cat.keywords.length})`);
    const keywordsBox = h('div', {}, listOf(cat.keywords, 'No keywords yet.'));
    fill(main,
      h('a', { href: '#/keywords', class: 'inline-block py-2 text-base font-medium text-brand' }, '‹ Categories'),
      h('h1', { class: 'mt-1 text-2xl font-bold' }, cat.name),
      setupNote(),
      msg,
      h('h2', { class: 'mt-4 text-lg font-semibold' }, 'Switched on for'),
      h('div', { class: 'mt-2 space-y-2' }, ...switches),
      h('div', { class: 'mt-6 rounded-2xl bg-white p-4 ring-1 ring-slate-200' }, addForm),
      keywordsTitle, keywordsBox,
      h('h2', { class: 'mt-6 text-lg font-semibold' }, `Learned from old bills (${cat.learned.length})`),
      h('p', { class: 'mt-1 text-sm text-slate-500' }, 'Added by PO Desk each night when at least 9 in 10 old bill lines with the word went to this category’s account. Remove any that are wrong: they won’t come back.'),
      listOf(cat.learned, 'Nothing learned yet.'),
      h('h2', { class: 'mt-6 text-lg font-semibold' }, 'Ideas from AI'),
      h('p', { class: 'mt-1 text-sm text-slate-500' }, 'Brand names and slip wordings for this category. Nothing is added until you tap Add.'),
      ideasBtn, ideasBox,
      cat.removed.length ? h('p', { class: 'mt-6 text-sm text-slate-500' }, 'Removed (won’t be learned again; type one in above to bring it back): ' + cat.removed.map((x) => x.k).join(', ')) : null,
      h('a', { href: '#/keywords', class: 'mt-6 block py-3 text-center text-base font-medium text-slate-600' }, 'Back to categories'));
  }

  return () => { alive = false; };
}
