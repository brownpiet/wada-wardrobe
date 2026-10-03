// Pure colour logic (no DOM) so it can be tested in Node and used in the browser.

const D65 = [0.95047, 1, 1.08883];
const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export function rgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / D65[0];
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / D65[2];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// CIEDE2000. kL > 1 de-emphasises lightness differences (used when merging
// shades of the same fabric colour that differ only through folds/shadows).
export function deltaE(l1, l2, kL = 1) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) / rad + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else hbp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  const T =
    1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  const x = dLp / (kL * Sl), y = dCp / Sc, z = dHp / Sh;
  return Math.sqrt(x * x + y * y + z * z + Rt * y * z);
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Adaptive palette from garment-only pixels.
 * rgb: flat array [r,g,b,r,g,b,...] of masked (garment) pixels.
 * Returns [{rgb, lab, hex, share}] sorted by share, largest first (the "base").
 */
export function extractPalette(rgb, { k = 6, mergeDe = 10, minShare = 0.04, maxColors = 5 } = {}) {
  const total = rgb.length / 3;
  if (total === 0) return [];
  const step = Math.max(1, Math.floor(total / 6000));
  const pts = [];
  for (let i = 0; i < total; i += step) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    pts.push({ rgb: [r, g, b], lab: rgbToLab(r, g, b) });
  }
  const rand = rng(1234);
  const kk = Math.min(k, pts.length);
  const cent = [pts[Math.floor(rand() * pts.length)].lab.slice()];
  while (cent.length < kk) {
    const d2 = pts.map((p) => Math.min(...cent.map((c) => (p.lab[0] - c[0]) ** 2 + (p.lab[1] - c[1]) ** 2 + (p.lab[2] - c[2]) ** 2)));
    const sum = d2.reduce((a, b) => a + b, 0);
    if (sum === 0) break;
    let r = rand() * sum, idx = 0;
    while (r > d2[idx] && idx < d2.length - 1) { r -= d2[idx]; idx++; }
    cent.push(pts[idx].lab.slice());
  }
  let assign = new Array(pts.length).fill(0);
  for (let it = 0; it < 15; it++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < cent.length; c++) {
        const d = (pts[i].lab[0] - cent[c][0]) ** 2 + (pts[i].lab[1] - cent[c][1]) ** 2 + (pts[i].lab[2] - cent[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const s = sums[assign[i]];
      s[0] += pts[i].lab[0]; s[1] += pts[i].lab[1]; s[2] += pts[i].lab[2]; s[3]++;
    }
    sums.forEach((s, c) => { if (s[3]) cent[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  let clusters = cent.map(() => ({ n: 0, lab: [0, 0, 0], rgb: [0, 0, 0] }));
  pts.forEach((p, i) => {
    const c = clusters[assign[i]];
    c.n++;
    for (let j = 0; j < 3; j++) { c.lab[j] += p.lab[j]; c.rgb[j] += p.rgb[j]; }
  });
  clusters = clusters.filter((c) => c.n).map((c) => ({
    n: c.n, lab: c.lab.map((v) => v / c.n), rgb: c.rgb.map((v) => v / c.n),
  }));
  clusters.sort((a, b) => b.n - a.n);
  // Merge near-duplicates (lightness de-emphasised so folds/shadows collapse).
  const merged = [];
  for (const c of clusters) {
    const m = merged.find((x) => deltaE(x.lab, c.lab, 2) < mergeDe);
    if (m) {
      const t = m.n + c.n;
      for (let j = 0; j < 3; j++) {
        m.lab[j] = (m.lab[j] * m.n + c.lab[j] * c.n) / t;
        m.rgb[j] = (m.rgb[j] * m.n + c.rgb[j] * c.n) / t;
      }
      m.n = t;
    } else merged.push({ n: c.n, lab: c.lab.slice(), rgb: c.rgb.slice() });
  }
  merged.sort((a, b) => b.n - a.n);
  const sum = merged.reduce((a, c) => a + c.n, 0);
  let out = merged.filter((c, i) => i === 0 || c.n / sum >= minShare).slice(0, maxColors);
  const s2 = out.reduce((a, c) => a + c.n, 0);
  return out.map((c) => ({
    rgb: c.rgb.map(Math.round),
    lab: c.lab,
    hex: rgbToHex(...c.rgb),
    share: c.n / s2,
  }));
}

export function prepareWada(data) {
  const colors = data.colors.map((c) => {
    const rgb = hexToRgb(c.h);
    return { name: c.n, hex: c.h, rgb, lab: rgbToLab(...rgb) };
  });
  return { colors, combos: data.combos };
}

export function nearestWada(lab, wada) {
  let best = 0, bd = Infinity;
  wada.colors.forEach((c, i) => {
    const d = deltaE(lab, c.lab);
    if (d < bd) { bd = d; best = i; }
  });
  return { idx: best, de: bd };
}

/**
 * Suggest outfits.
 * items: [{id, category, palette:[{lab,share}]}]  (palette[0] is the base colour)
 * opts: maxDe (tolerance), accents (let non-base colours match), fullOnly, mustInclude (item id), limit
 */
export function suggest(items, wada, { maxDe = 20, accents = true, fullOnly = false, mustInclude = null, limit = 40 } = {}) {
  const ACCENT_PENALTY = 1.25;
  const cost = (item, lab) => {
    let best = Infinity;
    const n = accents ? item.palette.length : 1;
    for (let i = 0; i < n; i++) {
      const d = deltaE(lab, item.palette[i].lab) * (i === 0 ? 1 : ACCENT_PENALTY);
      if (d < best) best = d;
    }
    return best;
  };
  const results = [];
  wada.combos.forEach((combo, ci) => {
    const slots = combo.map((idx) => wada.colors[idx]);
    const cands = slots.map((s) =>
      items.map((it) => ({ it, c: cost(it, s.lab) })).filter((x) => x.c <= maxDe).sort((a, b) => a.c - b.c).slice(0, 8));
    let best = null;
    const rec = (si, used, cats, picked, total, covered) => {
      if (si === slots.length) {
        if (covered < 2) return;
        if (fullOnly && covered < slots.length) return;
        if (mustInclude != null && !picked.some((p) => p && p.it.id === mustInclude)) return;
        const score = covered / slots.length * 100 - (total / covered);
        if (!best || score > best.score) best = { score, covered, picked: picked.slice(), avg: total / covered };
        return;
      }
      for (const cand of cands[si]) {
        if (used.has(cand.it.id) || cats.has(cand.it.category)) continue;
        used.add(cand.it.id); cats.add(cand.it.category); picked.push(cand);
        rec(si + 1, used, cats, picked, total + cand.c, covered + 1);
        picked.pop(); used.delete(cand.it.id); cats.delete(cand.it.category);
      }
      if (!fullOnly) { picked.push(null); rec(si + 1, used, cats, picked, total, covered); picked.pop(); }
    };
    rec(0, new Set(), new Set(), [], 0, 0);
    if (best) results.push({ combo: ci + 1, slots, ...best });
  });
  // De-duplicate identical item sets, keep the best-scoring combination.
  const seen = new Map();
  for (const r of results.sort((a, b) => b.score - a.score)) {
    const key = r.picked.filter(Boolean).map((p) => p.it.id).sort().join('|');
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()].slice(0, limit);
}
