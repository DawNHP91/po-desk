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
