// Hash router and app shell. Entry point (index.html loads this module).
import * as auth from './auth.js';
import { loadBrands, applyBrand, brand, shellKey } from './brand.js';
import { h } from './views/ui.js';
import * as loginView from './views/login.js';
import * as companiesView from './views/companies.js';
import * as homeView from './views/home.js';

const ROUTES = {
  '/login': { view: loginView, signedIn: false },
  '/companies': { view: companiesView, signedIn: true },
  '/home': { view: homeView, signedIn: true },
};

const app = document.getElementById('app');
let cleanup = null;
let restoreState = 'signed-out';

const landing = () => (auth.needsCompanyChoice() ? '/companies' : '/home');

export function go(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

function currentPath() {
  const p = location.hash.replace(/^#/, '');
  return ROUTES[p] ? p : (auth.isSignedIn() ? landing() : '/login');
}

function render() {
  const path = currentPath();
  if (location.hash !== '#' + path) { location.replace('#' + path); return; }
  const route = ROUTES[path];

  if (restoreState === 'offline' && !auth.isSignedIn()) return renderOffline();
  if (route.signedIn && !auth.isSignedIn()) return go('/login');
  if (!route.signedIn && auth.isSignedIn()) return go(landing());
  if (path === '/home' && auth.needsCompanyChoice()) return go('/companies');
  if (path === '/companies' && auth.buyCompanies().length <= 1) return go('/home');

  if (cleanup) { cleanup(); cleanup = null; }
  const company = path === '/home' ? auth.selectedCompany() : null;
  applyBrand(company ? company.brandKey : null);

  const main = h('main', { class: 'mx-auto w-full max-w-md px-4 pb-10 pt-4' });
  app.replaceChildren(shellHeader(company), main);
  window.scrollTo(0, 0);
  const ctx = { go, auth, brand, landing };
  cleanup = route.view.render(main, ctx) || null;
}

function shellHeader(company) {
  const b = brand(company ? company.brandKey : shellKey());
  const me = auth.getMe();
  const header = h('header', { class: 'sticky top-0 z-20 bg-white shadow-sm' },
    h('div', { class: 'mx-auto flex w-full max-w-md items-center justify-between gap-3 px-4 py-2' },
      h('img', { src: b.logo, alt: b.name, class: 'h-10 w-auto max-w-[55%] object-contain' }),
      me ? h('div', { class: 'flex items-center gap-3 text-sm' },
        h('span', { class: 'text-slate-600' }, me.user.firstName),
        h('button', { type: 'button', class: 'rounded-lg px-3 py-2 font-medium text-brand active:bg-slate-100', onclick: async () => { await auth.logout(); go('/login'); } }, 'Sign out'),
      ) : null,
    ),
    // Always visible once a company is chosen, so nobody raises a PO in the wrong company's books.
    company ? h('div', { class: 'bg-brand text-white' },
      h('div', { class: 'mx-auto flex w-full max-w-md items-center justify-between gap-3 px-4 py-2' },
        h('p', { class: 'text-base' }, 'Buying for: ', h('strong', { class: 'font-semibold' }, company.name)),
        auth.buyCompanies().length > 1
          ? h('button', { type: 'button', class: 'rounded-lg border border-white/60 px-3 py-1.5 text-sm font-medium active:bg-white/10', onclick: () => go('/companies') }, 'Switch')
          : null,
      ),
    ) : null,
  );
  return header;
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
