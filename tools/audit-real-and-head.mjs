/**
 * Two audits in one:
 *  A) real third-party assets (three.js / Khronos samples) through the import
 *     pipeline - my procedural fixtures may be systematically wrong about what
 *     real exporters emit.
 *  B) the procedural head's proportions against anthropometric ranges.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseAny } from '../src/core/formats.js';
import { buildDocument } from '../src/core/importer.js';
import { buildHead } from './head-mesh.mjs';

console.log('=== A) REAL-WORLD ASSETS ===\n');

const cases = [
  { f: 'BoxVertexColors.glb', expect: 'COLOR_0 on 8 corners: 8 distinct-ish hues, no welding collapse' },
  { f: 'duck.glb', expect: 'textured glTF: should bake texture colour via UVs' },
  { f: 'Cerberus.obj', expect: 'real head sculpt, 2.6MB: geometry only (no colour in file)' },
  { f: 'female02.obj', expect: 'real OBJ with MTL' },
];

for (const c of cases) {
  const path = `real-assets/${c.f}`;
  if (!existsSync(path)) { console.log(`${c.f}: MISSING`); continue; }
  try {
    const buf = readFileSync(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    let mtlText = null;
    const mtlPath = path.replace(/\.obj$/i, '.mtl');
    if (/\.obj$/i.test(c.f) && existsSync(mtlPath)) mtlText = readFileSync(mtlPath, 'utf8');
    const parsed = parseAny(c.f, ab, { mtlText });
    const t0 = Date.now();
    const { doc, stats } = buildDocument(parsed, { center: false, scale: 1 });
    const ms = Date.now() - t0;
    const cols = doc.faces.map((f) => f.color).filter(Boolean);
    const uniq = [...new Set(cols)];
    const dark = uniq.filter((h) => [1, 3, 5].reduce((s, i) => s + parseInt(h.slice(i, i + 2), 16), 0) < 120);
    console.log(`${c.f.padEnd(22)} verts ${String(stats.vertices).padStart(6)} faces ${String(doc.faces.length).padStart(5)} ${String(ms).padStart(5)}ms`);
    console.log(`  ${c.expect}`);
    console.log(`  colour: ${cols.length}/${doc.faces.length} faces, ${uniq.length} distinct${uniq.length ? ', sample ' + uniq.slice(0, 5).join(' ') : ''}${dark.length ? ` (${dark.length} very dark)` : ''}`);
    if (parsed.note) console.log(`  note: ${parsed.note}`);
    if (mtlText) console.log(`  mtl: ${mtlText.split('\n').filter((l) => l.startsWith('newmtl')).length} materials`);
  } catch (err) {
    console.log(`${c.f}: FAILED ${err.message}`);
  }
  console.log('');
}

console.log('=== B) HEAD PROPORTIONS vs ANTHROPOMETRICS ===\n');
const m = buildHead();
const V = [];
for (let i = 0; i < m.positions.length; i += 3) V.push([m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
const rng = (k) => { let lo = Infinity, hi = -Infinity; for (const v of V) { if (v[k] < lo) lo = v[k]; if (v[k] > hi) hi = v[k]; } return [lo, hi]; };
const [xlo, xhi] = rng(0); const [ylo, yhi] = rng(1); const [zlo, zhi] = rng(2);
const W = xhi - xlo, H = yhi - ylo, D = zhi - zlo;
// Head height normalised so all ratios compare like the literature.
console.log(`bbox            width ${W.toFixed(3)}  height ${H.toFixed(3)}  depth ${D.toFixed(3)}`);
console.log(`H/W ratio       ${(H / W).toFixed(3)}   (adult head height/breadth ~1.30-1.45)`);
console.log(`D/W ratio       ${(D / W).toFixed(3)}   (depth/breadth ~1.15-1.25)`);

// Feature placement as fractions of head height, eyes at ~0.44-0.50 from top.
const eyeY = 0.09;
const eyeFromTop = (yhi - eyeY) / H;
console.log(`eye line        ${(eyeFromTop * 100).toFixed(1)}% down from crown  (humans: ~45-50%)`);
console.log(`eye separation  ${((0.3 - -0.3) / W * 100).toFixed(0)}% of breadth   (outer canthi ~70-75%, pupils ~40-45%)`);
const noseTipY = -0.14;
console.log(`nose tip        ${((yhi - noseTipY) / H * 100).toFixed(1)}% down  (ala of nose ~62-68%)`);
const lipY = -0.44;
console.log(`mouth           ${((yhi - lipY) / H * 100).toFixed(1)}% down  (mouth ~72-76%)`);
console.log(`chin at         ${((yhi - ylo) / H * 100).toFixed(0)}% (by definition 100%)`);

// Cheek-to-chin taper: real faces narrow toward the jaw.
const midW = (() => { let lo = Infinity, hi = -Infinity; for (const v of V) if (Math.abs(v[1]) < 0.05) { lo = Math.min(lo, v[0]); hi = Math.max(hi, v[0]); } return hi - lo; })();
const lowW = (() => { let lo = Infinity, hi = -Infinity; for (const v of V) if (v[1] < -0.6 && v[1] > -0.8) { lo = Math.min(lo, v[0]); hi = Math.max(hi, v[0]); } return hi - lo; })();
console.log(`jaw taper       mid ${(midW).toFixed(2)} -> chin zone ${(lowW).toFixed(2)} (${(lowW / midW * 100).toFixed(0)}%  - should be clearly < 100%)`);
const front = (() => { let hi = -Infinity; for (const v of V) if (v[1] < 0.2 && v[2] > hi) hi = v[2]; return hi; })();
console.log(`projection      front features reach z=${front.toFixed(2)} vs half-depth ${(D / 2).toFixed(2)}`);
