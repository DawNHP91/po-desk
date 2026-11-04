// Hash router and app shell. Entry point (index.html loads this module).
import * as auth from './auth.js';
import { loadBrands, applyBrand, brand, shellKey } from './brand.js';
import { h } from './views/ui.js';
import * as loginView from './views/login.js';
import * as companiesView from './views/companies.js';
import * as homeView from './views/home.js';
import * as newPoView from './views/newpo.js';
import * as poView from './views/po.js';
import * as myPosView from './views/mypos.js';
import * as slipsView from './views/slips.js';
import * as slipView from './views/slip.js';
import * as reviewView from './views/review.js';
import * as approvalsView from './views/approvals.js';
import * as peopleView from './views/people.js';
import * as setPinView from './views/setpin.js';

// company: the screen works inside the chosen company, so it shows the "Buying for" bar and
// sends the user to the picker first if no company is chosen yet.
const ROUTES = [
  { re: /^\/login$/, view: loginView, signedIn: false },
  { re: /^\/companies$/, view: companiesView, signedIn: true },
  { re: /^\/home$/, view: homeView, signedIn: true, company: true, optional: true },
  { re: /^\/po\/new$/, view: newPoView, signedIn: true, company: true },
  { re: /^\/pos$/, view: myPosView, signedIn: true, company: true },
  { re: /^\/po\/([0-9a-f-]{36})$/, view: poView, signedIn: true, company: true },
  { re: /^\/slips$/, view: slipsView, signedIn: true, company: true },
  { re: /^\/po\/([0-9a-f-]{36})\/slip$/, view: slipView, signedIn: true, company: true },
  { re: /^\/slip\/([0-9a-f-]{36})$/, view: reviewView, signedIn: true, company: true },
  // Approvals and People span every company, so no "Buying for" bar.
  { re: /^\/approvals(?:\/([0-9a-f-]{36}))?$/, view: approvalsView, signedIn: true },
  { re: /^\/people(?:\/(new|[0-9a-f-]{36}))?$/, view: peopleView, signedIn: true },
  // Opened from the emailed link, signed in or not: the token is the only credential.
  { re: /^\/set-pin(?:\?(.*))?$/, view: setPinView, any: true },
];

const app = document.getElementById('app');
let cleanup = null;
let restoreState = 'signed-out';

const landing = () => (auth.needsCompanyChoice() ? '/companies' : '/home');

export function go(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

function match(path) {
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) return { route: r, params: m.slice(1) };
  }
  return null;
}

function render() {
  const path = location.hash.replace(/^#/, '');
  const found = match(path);
  if (!found) { location.replace('#' + (auth.isSignedIn() ? landing() : '/login')); return; }
  const { route, params } = found;

  if (restoreState === 'offline' && !auth.isSignedIn() && !route.any) return renderOffline();
  if (!route.any && route.signedIn && !auth.isSignedIn()) return go('/login');
  if (!route.any && !route.signedIn && auth.isSignedIn()) return go(landing());
  if (route.company && auth.needsCompanyChoice()) return go('/companies');
  if (route.company && !route.optional && !auth.selectedCompany()) return go('/home');
  if (path === '/companies' && auth.buyCompanies().length <= 1) return go('/home');

  if (cleanup) { cleanup(); cleanup = null; }
  const company = route.company ? auth.selectedCompany() : null;
  applyBrand(company ? company.brandKey : null);

  const main = h('main', { class: 'mx-auto w-full max-w-md px-4 pb-16 pt-4' });
  app.replaceChildren(shellHeader(company), main);
  window.scrollTo(0, 0);
  const ctx = { go, auth, brand, landing };
  cleanup = route.view.render(main, ctx, params) || null;
}

function shellHeader(company) {
  const b = brand(company ? company.brandKey : shellKey());
  const me = auth.getMe();
  return h('header', { class: 'sticky top-0 z-20 bg-white shadow-sm' },
    h('div', { class: 'mx-auto flex w-full max-w-md items-center justify-between gap-3 px-4 py-2' },
      h('a', { href: '#/home', 'aria-label': 'Home' }, h('img', { src: b.logo, alt: b.name, class: 'h-10 w-auto max-w-[55vw] object-contain' })),
      me ? h('div', { class: 'flex items-center gap-3 text-sm' },
        h('span', { class: 'text-slate-600' }, me.user.firstName),
        h('button', { type: 'button', class: 'rounded-lg px-3 py-2 font-medium text-brand active:bg-slate-100', onclick: async () => { await auth.logout(); go('/login'); } }, 'Sign out'),
      ) : null,
    ),
    // Always visible inside a company, so nobody raises a PO in the wrong company's books.
    company ? h('div', { class: 'bg-brand text-white' },
      h('div', { class: 'mx-auto flex w-full max-w-md items-center justify-between gap-3 px-4 py-2' },
        h('p', { class: 'text-base' }, 'Buying for: ', h('strong', { class: 'font-semibold' }, company.name)),
        auth.buyCompanies().length > 1
          ? h('button', { type: 'button', class: 'rounded-lg border border-white/60 px-3 py-1.5 text-sm font-medium active:bg-white/10', onclick: () => go('/companies') }, 'Switch')
          : null,
      ),
    ) : null,
  );
}

function renderOffline() {
  applyBrand(null);
  app.replaceChildren(h('main', { class: 'mx-auto max-w-md p-6 text-center' },
    h('p', { class: 'text-lg font-semibold' }, 'Can’t reach PO Desk'),
    h('p', { class: 'mt-2 text-slate-600' }, 'Check your signal, then try again.'),
    h('button', { type: 'button', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white', onclick: boot }, 'Try again'),
  ));
}

async function boot() {
  await loadBrands();
  restoreState = await auth.restore();
  render();
}

window.addEventListener('hashchange', render);
// Any call that finds the session gone (expired, user deactivated) sends the user back to sign in.
window.addEventListener('po:auth-required', () => { auth.clear(); go('/login'); });
boot();
