// Set PIN, opened from the emailed link (#/set-pin?t=<token>): checks the link, takes a 6-digit PIN
// twice and saves it. The link works once, for 48 hours. Works whether or not someone is signed in
// on this phone; whoever was signed in is signed out first, so the new PIN is used straight away.
import { h, fill, alertBox, inputClass, labelClass } from './ui.js';
import { call } from '../api.js';

export function render(root, ctx, params) {
  const token = new URLSearchParams(params[0] || '').get('t') || '';
  // Keep the token out of the address bar and the browser history once it has been read.
  history.replaceState(null, '', location.pathname + location.search + '#/set-pin');
  let alive = true;
  const main = h('div', {}, h('p', { class: 'mt-6 text-center text-slate-500' }, 'Checking your link…'));
  root.append(main);
  check();

  async function check() {
    try {
      const who = await call('checkPinToken', { token });
      if (alive) form(who);
    } catch (err) {
      if (alive) fill(main, h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Set your PIN'), h('div', { class: 'mt-4' }, alertBox(err.message)),
        h('a', { href: '#/login', class: 'mt-6 block text-center font-medium text-brand' }, 'Go to sign in'));
    }
  }

  function form(who) {
    const pinInput = (id) => h('input', { id, type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'new-password', class: inputClass + ' tracking-[0.5em] text-center text-2xl' });
    const pin = pinInput('pin1');
    const pin2 = pinInput('pin2');
    const msg = h('div', { class: 'mt-4', 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white active:opacity-90 disabled:opacity-60' }, 'Save my PIN');
    const f = h('form', { novalidate: true },
      h('div', { class: 'mt-5' }, h('label', { class: labelClass, for: 'pin1' }, 'New 6-digit PIN'), pin),
      h('div', { class: 'mt-5' }, h('label', { class: labelClass, for: 'pin2' }, 'Type it again'), pin2),
      h('p', { class: 'mt-2 text-sm text-slate-500' }, 'Not your birthday, and not 123456 or 111111.'),
      msg, save);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!/^\d{6}$/.test(pin.value)) { msg.replaceChildren(alertBox('Your PIN must be exactly 6 digits.')); pin.focus(); return; }
      if (pin.value !== pin2.value) { msg.replaceChildren(alertBox('The two PINs don’t match. Type the same PIN twice.')); pin2.value = ''; pin2.focus(); return; }
      save.disabled = true;
      msg.replaceChildren();
      try {
        const r = await call('setPinWithToken', { token, pin: pin.value, pin2: pin2.value });
        if (!alive) return;
        if (ctx.auth.isSignedIn()) await ctx.auth.logout();
        ctx.auth.rememberEmail(r.email);
        fill(main,
          h('div', { class: 'mt-2 rounded-2xl bg-green-50 p-4 text-green-900 ring-1 ring-green-200', role: 'status' },
            h('p', { class: 'text-xl font-bold' }, 'Your PIN is set'),
            h('p', { class: 'mt-1' }, `Sign in with ${r.email} and your new PIN.`)),
          h('button', { type: 'button', class: 'mt-6 w-full rounded-2xl bg-brand px-4 py-4 text-lg font-semibold text-white', onclick: () => ctx.go('/login') }, 'Sign in'));
      } catch (err) {
        save.disabled = false;
        msg.replaceChildren(alertBox(err.message));
      }
    });
    fill(main,
      h('h1', { class: 'mt-2 text-2xl font-bold' }, `Hi ${who.firstName}`),
      h('p', { class: 'mt-1 text-slate-600' }, `Choose the PIN you’ll use with ${who.email} to sign in to PO Desk.`),
      f);
    pin.focus();
  }

  return () => { alive = false; };
}
