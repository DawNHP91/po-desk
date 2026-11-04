// Copies the static app into dist/ (Cloudflare Pages' output folder). Tailwind then writes dist/app.css.
// Only listed paths are published, so package.json, scripts/ and node_modules never reach the site.
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const OUT = 'dist';
const PUBLISH = ['index.html', 'manifest.webmanifest', '_headers', 'src', 'brand', 'icons'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const path of PUBLISH) {
  cpSync(path, `${OUT}/${path}`, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
}
console.log(`Copied ${PUBLISH.join(', ')} to ${OUT}/`);
