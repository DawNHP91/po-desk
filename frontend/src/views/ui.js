// Tiny DOM helpers. Text always goes in as text nodes (never innerHTML), so names from Xero or
// the Sheet can't inject markup.

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    // CSS custom properties via CSSOM: allowed by the CSP, unlike style="" attributes.
    else if (k === 'vars') Object.entries(v).forEach(([name, val]) => el.style.setProperty(name, val));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

/** Outline icon from one or more SVG path strings (24x24 grid). */
export function icon(paths, cls = 'h-8 w-8') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  [].concat(paths).forEach((d) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  });
  return svg;
}

/** R1,234.50 — rand, two decimals, comma thousands (as Xero shows amounts). */
export function rand(n) {
  const v = Number(n) || 0;
  return 'R' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function alertBox(message, tone = 'error') {
  const cls = tone === 'error' ? 'bg-red-50 text-red-800 border-red-200' : 'bg-amber-50 text-amber-900 border-amber-200';
  return h('div', { role: 'alert', class: `rounded-xl border p-3 text-base ${cls}` }, message);
}

const STATUS = {
  ISSUED: ['Issued', 'bg-green-100 text-green-800'],
  AWAITING_APPROVAL: ['Awaiting approval', 'bg-amber-100 text-amber-900'],
  PENDING_XERO: ['Provisional', 'bg-sky-100 text-sky-900'],
  DECLINED: ['Declined', 'bg-red-100 text-red-800'],
  BILLED: ['Billed', 'bg-slate-200 text-slate-800'],
  CANCELLED: ['Cancelled', 'bg-slate-100 text-slate-600'],
};

export function statusChip(status) {
  const [label, cls] = STATUS[status] || [status, 'bg-slate-100 text-slate-700'];
  return h('span', { class: `inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-medium ${cls}` }, label);
}

/** 3 Nov 2026, in South African time whatever the phone's timezone. */
export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' }).format(d);
}

/** Random UUID for idempotency keys; falls back for older browsers without crypto.randomUUID. */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const inputClass = 'mt-1 block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-slate-100';
export const labelClass = 'block text-sm font-medium text-slate-700';

/** replaceChildren that skips null/false, so optional sections never render as the text "null". */
export function fill(root, ...kids) {
  root.replaceChildren();
  append(root, kids);
  return root;
}
