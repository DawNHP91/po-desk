// Brand colours and logos come from brand/brands.json (keyed by entity: PK, HPB, NHP).
// The shell brand is chosen by hostname, so other subdomains can be added to HOST_BRANDS later.
// Once a company is chosen, applyBrand(entity) recolours the header, bar and buttons for it.

export const HOST_BRANDS = {
  'po.pharmakaru.co.za': 'PK',
};
const DEFAULT_SHELL = 'PK';

// Used only if brands.json can't be fetched, so the login screen still looks right.
const FALLBACK = {
  PK: { name: 'Pharma Karu', logo: 'brand/pk/logo-horizontal.png', primary: '#14532D', accent: '#C4862A', ink: '#5B6470' },
};

export let BRANDS = { ...FALLBACK };

export async function loadBrands() {
  try {
    const res = await fetch('brand/brands.json', { cache: 'no-cache' });
    if (res.ok) BRANDS = { ...FALLBACK, ...(await res.json()) };
  } catch {
    // keep FALLBACK
  }
}

export const shellKey = () => HOST_BRANDS[location.hostname] || DEFAULT_SHELL;

export function brand(key) {
  return BRANDS[key] || BRANDS[shellKey()] || FALLBACK.PK;
}

/**
 * Colour behind white text. brands.json flags NHP's #509544 as too light for small white text
 * (3.7:1), so a darker buttonOnWhite wins where one is given.
 */
export const solid = (b) => b.buttonOnWhite || b.primary;

/** Sets the live CSS variables (CSSOM, which the CSP allows) and the browser's theme colour. */
export function applyBrand(entityKey) {
  const b = brand(entityKey || shellKey());
  const root = document.documentElement.style;
  root.setProperty('--brand-primary', solid(b));
  root.setProperty('--brand-accent', b.accent || solid(b));
  root.setProperty('--brand-ink', b.ink || '#334155');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', solid(b));
  return b;
}
