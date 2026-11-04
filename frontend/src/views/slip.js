// Photograph slip (CLAUDE.md Flow 2 steps 1–3): camera or gallery, preview with retake, then upload
// and read. Reading may fail (quota, outage): the buyer still goes on to type the values.
import { h, fill, alertBox, rand, handover } from './ui.js';
import { call } from '../api.js';
import { makeInputs, processPhoto } from '../camera.js';

export function render(root, ctx, params) {
  const poId = params[0];
  let alive = true;
  let photo = null;
  let po = null;

  const stage = h('div', { class: 'mt-4' });
  const message = h('div', { class: 'mt-4', 'aria-live': 'polite' });
  const inputs = makeInputs(onFile);
  root.append(h('h1', { class: 'mt-2 text-2xl font-bold' }, 'Photograph the slip'), h('div', { id: 'po-card' }), stage, message, inputs.camera, inputs.gallery);

  call('getPO', { poId }).then((p) => {
    if (!alive) return;
    po = p;
    fill(root.querySelector('#po-card'), h('div', { class: 'mt-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200' },
      h('p', { class: 'font-mono text-lg font-semibold' }, p.poNumber || p.provisionalRef),
      h('p', { class: 'text-slate-700' }, p.supplierName + ' · ' + rand(p.amountInclZar))));
    if (p.status !== 'ISSUED') { fill(stage, alertBox('A slip can only be added once the PO is approved and has its Xero number.', 'warn')); return; }
    showPickers();
  }).catch((err) => { if (alive && err.code !== 'AUTH_REQUIRED') fill(stage, alertBox(err.message)); });

  const big = 'w-full rounded-2xl px-4 py-4 text-lg font-semibold touch-manipulation disabled:opacity-60';
  function showPickers() {
    photo = null;
    fill(stage,
      h('ul', { class: 'mb-4 list-disc space-y-1 pl-5 text-slate-600' },
        h('li', {}, 'Lay the slip flat in good light, with no shadow over it.'),
        h('li', {}, 'Fill the frame with the whole slip, top to bottom.')),
      h('button', { type: 'button', class: big + ' bg-brand text-white active:opacity-90', onclick: () => inputs.camera.click() }, 'Take photo'),
      h('button', { type: 'button', class: big + ' mt-3 border-2 border-slate-300 bg-white active:bg-slate-100', onclick: () => inputs.gallery.click() }, 'Choose from gallery'));
  }

  async function onFile(file) {
    message.replaceChildren();
    fill(stage, h('p', { class: 'py-8 text-center text-slate-600' }, 'Preparing the photo…'));
    try {
      photo = await processPhoto(file);
    } catch (err) {
      showPickers();
      message.replaceChildren(alertBox(err.message));
      return;
    }
    if (!alive) return;
    fill(stage,
      h('img', { src: photo.dataUrl, alt: 'Slip photo preview', id: 'slip-preview', class: 'max-h-[60vh] w-full rounded-2xl bg-slate-100 object-contain ring-1 ring-slate-200' }),
      h('p', { class: 'mt-2 text-center text-sm text-slate-500' }, `${photo.width} × ${photo.height} · ${Math.round(photo.bytes / 1024)} KB`),
      h('button', { type: 'button', class: big + ' mt-4 bg-brand text-white active:opacity-90', onclick: useIt }, 'Use this photo'),
      h('button', { type: 'button', class: big + ' mt-3 border-2 border-slate-300 bg-white active:bg-slate-100', onclick: showPickers }, 'Retake'));
  }

  async function useIt(e) {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    stage.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.textContent = 'Saving the photo…';
    let billId;
    try {
      billId = (await call('uploadSlip', { poId, imageBase64: photo.base64, mimeType: 'image/jpeg' }, { timeoutMs: 60000 })).billId;
    } catch (err) {
      stage.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      btn.textContent = 'Use this photo';
      if (err.code !== 'AUTH_REQUIRED') message.replaceChildren(alertBox(err.message));
      return;
    }
    btn.textContent = 'Reading the slip…';
    let view = null;
    try {
      view = await call('readSlip', { billId }, { timeoutMs: 90000 });
    } catch (err) {
      // The photo is saved; the review screen lets the buyer type the values or try reading again.
      view = null;
    }
    handover.set('slip:' + billId, { view, dataUrl: photo.dataUrl });
    ctx.go('/slip/' + billId);
  }

  return () => { alive = false; };
}
