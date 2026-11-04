// Login: email + 6-digit PIN on an on-screen keypad (no phone keyboard over the digits).
// The sixth digit submits. Messages come from the server (wrong PIN, locked, too many attempts).
import { h, alertBox } from './ui.js';

const PIN_LENGTH = 6;

export function render(root, ctx) {
  const { auth } = ctx;
  let pin = '';
  let busy = false;

  const email = h('input', {
    id: 'email', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none',
    autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', placeholder: 'name@company.co.za',
    class: 'mt-1 block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30',
  });
  email.value = auth.rememberedEmail();
  email.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); email.blur(); } });

  const dots = Array.from({ length: PIN_LENGTH }, () => h('span', { class: 'h-4 w-4 rounded-full border-2 border-slate-400' }));
  const message = h('div', { class: 'min-h-[3rem]', 'aria-live': 'polite' });

  const keyClass = 'h-16 rounded-2xl bg-white text-2xl font-semibold shadow-sm ring-1 ring-slate-200 touch-manipulation select-none active:bg-slate-200 disabled:opacity-40';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'].map((k) => {
    if (k === 'clear') return h('button', { type: 'button', class: keyClass + ' text-base font-medium', 'aria-label': 'Clear PIN', onclick: () => setPin('') }, 'Clear');
    if (k === 'del') return h('button', { type: 'button', class: keyClass, 'aria-label': 'Delete last digit', onclick: () => setPin(pin.slice(0, -1)) }, '⌫');
    return h('button', { type: 'button', class: keyClass, onclick: () => press(k) }, k);
  });

  function setPin(v) {
    pin = v;
    dots.forEach((d, i) => {
      d.className = 'h-4 w-4 rounded-full border-2 ' + (i < pin.length ? 'border-brand bg-brand' : 'border-slate-400');
    });
  }

  function setBusy(b) {
    busy = b;
    keys.forEach((k) => { k.disabled = b; });
    email.disabled = b;
  }

  function press(d) {
    if (busy || pin.length >= PIN_LENGTH) return;
    message.replaceChildren();
    setPin(pin + d);
    if (pin.length === PIN_LENGTH) submit();
  }

  async function submit() {
    const addr = email.value.trim();
    if (!addr) {
      message.replaceChildren(alertBox('Enter your work email first.'));
      setPin('');
      email.focus();
      return;
    }
    setBusy(true);
    message.replaceChildren(h('p', { class: 'py-3 text-center text-slate-600' }, 'Signing in…'));
    try {
      await auth.login(addr, pin);
      ctx.go(ctx.landing());
    } catch (err) {
      setPin('');
      message.replaceChildren(alertBox(err.message, err.code === 'LOCKED' || err.code === 'RATE_LIMITED' ? 'warn' : 'error'));
    } finally {
      setBusy(false);
    }
  }

  // A hardware keyboard (or desktop testing) can type the PIN too, unless the email box has focus.
  const onKey = (e) => {
    if (document.activeElement === email) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace' && !busy) setPin(pin.slice(0, -1));
  };
  document.addEventListener('keydown', onKey);

  root.append(
    h('h1', { class: 'mt-4 text-2xl font-bold' }, 'Sign in to PO Desk'),
    h('p', { class: 'mt-1 text-slate-600' }, 'Purchase order numbers for the Pharma Karu group.'),
    h('label', { for: 'email', class: 'mt-6 block text-sm font-medium text-slate-700' }, 'Work email'),
    email,
    h('p', { class: 'mt-6 text-sm font-medium text-slate-700', id: 'pin-label' }, 'PIN'),
    h('div', { class: 'mt-3 flex justify-center gap-4', role: 'img', 'aria-labelledby': 'pin-label' }, dots),
    h('div', { class: 'mt-4' }, message),
    h('div', { class: 'mt-2 grid grid-cols-3 gap-3' }, keys),
    h('p', { class: 'mt-6 text-center text-sm text-slate-500' }, 'Forgotten your PIN? Ask your PO Desk admin for a new set-PIN link.'),
  );
  setPin('');
  if (!email.value) setTimeout(() => email.focus(), 50);

  return () => document.removeEventListener('keydown', onKey);
}
