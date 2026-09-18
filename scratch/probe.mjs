import { parseSTL, parseOBJ } from '../src/core/formats.js';
import { weldPositions, mergeCoplanarTriangles, defaultWeldTolerance } from '../src/core/merge.js';
import { buildDocument, normalisePositions } from '../src/core/importer.js';

const log = (...a) => console.log(...a);

log('--- weld exact dups ---');
log(JSON.stringify(weldPositions([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0], 1e-4)));

log('--- weld straddle ---');
log(JSON.stringify(weldPositions([1, 0, 0, 1.09, 0, 0], 0.1)));

log('--- weld eps 0 ---');
log(JSON.stringify(weldPositions([0, 0, 0, 0, 0, 0], 0)));

log('--- weld NaN ---');
log(JSON.stringify(weldPositions([NaN, 0, 0, NaN, 0, 0], 1)));

log('--- defaultWeldTolerance ---');
log(defaultWeldTolerance(1), defaultWeldTolerance(0), defaultWeldTolerance(Infinity));

log('--- merge two tris -> quad ---');
log(JSON.stringify(mergeCoplanarTriangles([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3])));

log('--- merge two touching quads ---');
log(JSON.stringify(mergeCoplanarTriangles([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0], [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2])));

log('--- fit ---');
log(JSON.stringify(normalisePositions([0, 0, 0, 10, 0, 0], { fit: 2 })));

log('--- buildDocument STL square ---');
const facets = [
  [[0, 0, 1], [0, 0, 0, 1, 0, 0, 1, 1, 0]],
  [[0, 0, 1], [0, 0, 0, 1, 1, 0, 0, 1, 0]],
];
const buf = new ArrayBuffer(84 + facets.length * 50);
const view = new DataView(buf);
new TextEncoder().encodeInto('Binary STL test', new Uint8Array(buf));
view.setUint32(80, facets.length, true);
let o = 84;
for (const [n, verts] of facets) {
  for (const v of [...n, ...verts]) { view.setFloat32(o, v, true); o += 4; }
  view.setUint16(o, 0, true); o += 2;
}
const parsed = parseSTL(buf);
log('parsed positions', parsed.positions.length / 3, 'tris', parsed.triangles.length);
const built = buildDocument(parsed, { name: 'Square' });
log('doc verts', built.doc.vertices.length, 'faces', built.doc.faces.length, 'loops', JSON.stringify(built.doc.faces.map(f=>f.loop.length)));
log('stats', JSON.stringify(built.stats));
