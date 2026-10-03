import { extractPalette, prepareWada, nearestWada, suggest, rgbToLab, deltaE } from './colour.js';

const $ = (s) => document.querySelector(s);
const wada = prepareWada(await (await fetch('wada.json')).json());

/* ---------- storage (IndexedDB) ---------- */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('wada-wardrobe', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (mode, fn) => new Promise((res, rej) => {
  const t = db.transaction('items', mode);
  const out = fn(t.objectStore('items'));
  t.oncomplete = () => res(out.result);
  t.onerror = () => rej(t.error);
});
const allItems = () => tx('readonly', (s) => s.getAll());
const putItem = (it) => tx('readwrite', (s) => s.put(it));
const delItem = (id) => tx('readwrite', (s) => s.delete(id));

let items = [];
const urls = new Map();
const imgUrl = (it) => {
  if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.image));
  return urls.get(it.id);
};

/* ---------- tabs ---------- */
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
function show(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ['wardrobe', 'add', 'outfits'].forEach((t) => ($(`#tab-${t}`).hidden = t !== tab));
  if (tab === 'outfits') renderOutfits();
}

/* ---------- wardrobe ---------- */
async function refresh() {
  items = await allItems();
  $('#count').textContent = items.length ? `${items.length} items` : '';
  $('#empty').hidden = items.length > 0;
  $('#grid').innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = `<div class="im"><img src="${imgUrl(it)}" alt=""></div>
      <div class="strip">${it.palette.map((p) => `<i style="background:${p.hex};flex:${p.share}"></i>`).join('')}</div>
      <div class="meta"><b>${esc(it.name || it.category)}</b><br><span class="muted">${it.category}</span></div>`;
    d.onclick = () => openDetail(it);
    $('#grid').append(d);
  }
  const sel = $('#around');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Any item</option>' + items.map((i) => `<option value="${i.id}">${esc(i.name || i.category)}</option>`).join('');
  sel.value = cur;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function openDetail(it) {
  $('#detail-body').innerHTML = `
    <div class="cut"><img src="${imgUrl(it)}" alt=""></div>
    <h3>${esc(it.name || it.category)}</h3>
    <div class="palette">${it.palette.map((p) => {
      const n = nearestWada(p.lab, wada);
      return `<div class="sw" style="cursor:default"><b style="background:${p.hex}"></b><span>${p.hex}<small>≈ ${wada.colors[n.idx].name} (ΔE ${n.de.toFixed(1)})</small></span></div>`;
    }).join('')}</div>
    <p><button class="btn primary" id="d-around">Outfits with this</button>
    <button class="btn ghost" id="d-del">Delete</button></p>`;
  $('#detail').showModal();
  $('#d-around').onclick = () => { $('#detail').close(); $('#around').value = it.id; show('outfits'); };
  $('#d-del').onclick = async () => {
    if (!confirm('Delete this item?')) return;
    await delItem(it.id);
    urls.delete(it.id);
    $('#detail').close();
    refresh();
  };
}

/* ---------- add flow ---------- */
let draft = null;
const bitmapFrom = (blobOrFile) => createImageBitmap(blobOrFile, { imageOrientation: 'from-image' });
function canvasFrom(bmp, max) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

let bgLib = null;
async function removeBackground(file) {
  const src = canvasFrom(await bitmapFrom(file), 1024);
  const srcBlob = await toBlob(src);
  try {
    bgLib ??= await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm');
    const out = await bgLib.removeBackground(srcBlob, {
      model: 'isnet_quint8',
      output: { format: 'image/png' },
      progress: (key, cur, tot) => {
        if (key.startsWith('fetch') && tot) $('#status').textContent = `Downloading cut-out model (first time only)… ${Math.round((cur / tot) * 100)}%`;
      },
    });
    return { blob: out, method: 'model' };
  } catch (e) {
    console.warn('Model background removal failed, using fallback', e);
    return { blob: await fallbackCutout(src), method: 'fallback' };
  }
}

// Fallback: flood-fill from the border over pixels close to the border colour.
async function fallbackCutout(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x, y) => { const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  const bg = rgbToLab(r / n, g / n, b / n);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const p = y * w + x; if (!seen[p]) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop(), i = p * 4;
    if (deltaE(bg, rgbToLab(d[i], d[i + 1], d[i + 2])) > 14) { seen[p] = 2; continue; }
    d[i + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  ctx.putImageData(img, 0, 0);
  return toBlob(canvas);
}

// Garment-only pixels: opaque, and not touching the edge of the mask (kills fringe blending).
function garmentPixels(canvas, erode = 2) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = d[i * 4 + 3] >= 200 ? 1 : 0;
  const count = (m) => m.reduce((a, b) => a + b, 0);
  let eroded = mask;
  for (let k = 0; k < erode; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      next[p] = eroded[p] && eroded[p - 1] && eroded[p + 1] && eroded[p - w] && eroded[p + w] ? 1 : 0;
    }
    eroded = next;
  }
  if (count(eroded) < 50) eroded = mask;
  const out = [];
  for (let i = 0; i < w * h; i++) if (eroded[i]) out.push(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return out;
}

$('#file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  $('#work').hidden = false;
  $('#palette-box').hidden = true;
  $('#cutimg').removeAttribute('src');
  $('#status').textContent = 'Removing background…';
  try {
    const { blob, method } = await removeBackground(file);
    const cutCanvas = canvasFrom(await bitmapFrom(blob), 480);
    const pixels = garmentPixels(canvasFrom(await bitmapFrom(blob), 200));
    const palette = extractPalette(pixels);
    draft = { image: await toBlob(cutCanvas), palette };
    $('#cutimg').src = URL.createObjectURL(draft.image);
    $('#status').textContent = method === 'model' ? 'Background removed.' : 'Basic background removal used (model unavailable). Works best on a plain backdrop.';
    renderDraftPalette();
    $('#name').value = '';
    $('#palette-box').hidden = false;
  } catch (err) {
    console.error(err);
    $('#status').textContent = 'Something went wrong processing that photo. Try another.';
  }
};

function renderDraftPalette() {
  $('#palette').innerHTML = '';
  draft.palette.forEach((p, i) => {
    const n = nearestWada(p.lab, wada);
    const d = document.createElement('div');
    d.className = 'sw';
    d.innerHTML = `<b style="background:${p.hex}"></b><span>${Math.round(p.share * 100)}%${i === 0 ? ' · base' : ''}<small>≈ ${wada.colors[n.idx].name}</small></span>`;
    d.onclick = () => {
      if (draft.palette.length === 1) return;
      draft.palette.splice(i, 1);
      renderDraftPalette();
    };
    $('#palette').append(d);
  });
}

$('#save').onclick = async () => {
  const sum = draft.palette.reduce((a, p) => a + p.share, 0);
  const palette = draft.palette.map((p) => ({ hex: p.hex, lab: p.lab, share: p.share / sum }));
  await putItem({ name: $('#name').value.trim(), category: $('#cat').value, image: draft.image, palette, added: Date.now() });
  draft = null;
  $('#work').hidden = true;
  await refresh();
  show('wardrobe');
};

/* ---------- outfits ---------- */
for (const id of ['tol', 'accents', 'full', 'around']) $('#' + id).oninput = renderOutfits;
function renderOutfits() {
  $('#tolout').textContent = $('#tol').value;
  const box = $('#results');
  if (items.length < 2) { box.innerHTML = '<p class="muted center">Add at least two items to see suggestions.</p>'; return; }
  const res = suggest(items, wada, {
    maxDe: +$('#tol').value,
    accents: $('#accents').checked,
    fullOnly: $('#full').checked,
    mustInclude: $('#around').value ? +$('#around').value : null,
  });
  if (!res.length) { box.innerHTML = '<p class="muted center">No matches. Try a higher tolerance or add more items.</p>'; return; }
  box.innerHTML = '';
  for (const r of res) {
    const c = document.createElement('div');
    c.className = 'card';
    c.innerHTML = `<h4>Wada #${r.combo}<span>${r.covered}/${r.slots.length} colours · ΔE ${r.avg.toFixed(1)}</span></h4>
      <div class="wcols">${r.slots.map((s) => `<i style="background:${s.hex}" title="${esc(s.name)}"></i>`).join('')}</div>
      <div class="pieces">${r.slots.map((s, i) => {
        const p = r.picked[i];
        return p ? `<div class="piece"><div class="im"><img src="${imgUrl(p.it)}" alt=""><span class="chip" style="background:${s.hex}"></span></div>${esc(p.it.name || p.it.category)}</div>`
          : `<div class="piece gap"><div class="im">·</div>${esc(s.name)}</div>`;
      }).join('')}</div>`;
    box.append(c);
  }
}

/* ---------- backup ---------- */
$('#export').onclick = async () => {
  const out = [];
  for (const it of items) {
    const buf = new Uint8Array(await it.image.arrayBuffer());
    let bin = ''; buf.forEach((b) => (bin += String.fromCharCode(b)));
    out.push({ ...it, id: undefined, image: 'data:image/png;base64,' + btoa(bin) });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = 'wada-wardrobe-backup.json';
  a.click();
};
$('#import').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  for (const it of JSON.parse(await f.text())) {
    it.image = await (await fetch(it.image)).blob();
    delete it.id;
    await putItem(it);
  }
  e.target.value = '';
  refresh();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
await refresh();
