/**
 * Emit the procedural head as test assets in every import format the app
 * claims to support. Each variant encodes the SAME per-vertex sRGB colour in
 * the way that format really does, so an import that comes back grey, dark or
 * warped is a bug rather than a bad fixture.
 *
 * Run: node tools/make-head-assets.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { buildHead, faceHex } from './head-mesh.mjs';

const OUT = process.argv[2] || 'test-assets';
mkdirSync(OUT, { recursive: true });

const mesh = buildHead();
const N = mesh.vertexCount;

/* ---------------------------------------------------------------- *
 * colour-space helpers
 * ---------------------------------------------------------------- */
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lin2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/* triangulate quads (fan) - glTF and STL are triangle-only */
const tris = [];
for (const q of mesh.quads) tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);

/* ---------------------------------------------------------------- *
 * OBJ with per-vertex colour  (v x y z r g b)
 * What Blender / MeshLab / CloudCompare write.
 * ---------------------------------------------------------------- */
{
  const L = ['# VertexForge head test - per-vertex colour', `# ${N} verts`];
  for (let i = 0; i < N; i++) {
    L.push(`v ${mesh.positions[i * 3].toFixed(5)} ${mesh.positions[i * 3 + 1].toFixed(5)} ${mesh.positions[i * 3 + 2].toFixed(5)} ${mesh.colors[i * 3].toFixed(4)} ${mesh.colors[i * 3 + 1].toFixed(4)} ${mesh.colors[i * 3 + 2].toFixed(4)}`);
  }
  for (let i = 0; i < N; i++) L.push(`vt ${mesh.uvs[i * 2].toFixed(4)} ${mesh.uvs[i * 2 + 1].toFixed(4)}`);
  for (const q of mesh.quads) L.push(`f ${q.map((i) => `${i + 1}/${i + 1}`).join(' ')}`);
  writeFileSync(`${OUT}/head_vertexcolor.obj`, L.join('\n'));
}

/* ---------------------------------------------------------------- *
 * OBJ with 0-255 vertex colour  (some scanners write this)
 * ---------------------------------------------------------------- */
{
  const L = ['# per-vertex colour in 0-255'];
  for (let i = 0; i < N; i++) {
    const r = Math.round(mesh.colors[i * 3] * 255);
    const g = Math.round(mesh.colors[i * 3 + 1] * 255);
    const b = Math.round(mesh.colors[i * 3 + 2] * 255);
    L.push(`v ${mesh.positions[i * 3].toFixed(5)} ${mesh.positions[i * 3 + 1].toFixed(5)} ${mesh.positions[i * 3 + 2].toFixed(5)} ${r} ${g} ${b}`);
  }
  for (const q of mesh.quads) L.push(`f ${q.map((i) => i + 1).join(' ')}`);
  writeFileSync(`${OUT}/head_vertexcolor255.obj`, L.join('\n'));
}

/* ---------------------------------------------------------------- *
 * OBJ + MTL  (material per face group - the common download shape)
 * ---------------------------------------------------------------- */
{
  const L = ['# material per group', 'mtllib head.mtl'];
  for (let i = 0; i < N; i++) L.push(`v ${mesh.positions[i * 3].toFixed(5)} ${mesh.positions[i * 3 + 1].toFixed(5)} ${mesh.positions[i * 3 + 2].toFixed(5)}`);
  for (let i = 0; i < N; i++) L.push(`vt ${mesh.uvs[i * 2].toFixed(4)} ${mesh.uvs[i * 2 + 1].toFixed(4)}`);
  for (const g of mesh.groups) {
    L.push(`usemtl ${g.name}`);
    for (const fi of g.faces) L.push(`f ${mesh.quads[fi].map((i) => `${i + 1}/${i + 1}`).join(' ')}`);
  }
  writeFileSync(`${OUT}/head_mtl.obj`, L.join('\n'));

  const mtl = ['# simple material, average of each group', 'newmtl skin', 'Kd 0.886 0.735 0.614', 'newmtl hair', 'Kd 0.176 0.114 0.094', 'newmtl eye', 'Kd 0.784 0.765 0.686', ''];
  writeFileSync(`${OUT}/head.mtl`, mtl.join('\n'));
}

/* ---------------------------------------------------------------- *
 * PLY ascii, uchar 0-255
 * ---------------------------------------------------------------- */
{
  const head = [
    'ply', 'format ascii 1.0', `element vertex ${N}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    `element face ${mesh.quads.length}`, 'property list int int vertex_indices', 'end_header',
  ];
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push(`${mesh.positions[i * 3].toFixed(5)} ${mesh.positions[i * 3 + 1].toFixed(5)} ${mesh.positions[i * 3 + 2].toFixed(5)} ${Math.round(mesh.colors[i * 3] * 255)} ${Math.round(mesh.colors[i * 3 + 1] * 255)} ${Math.round(mesh.colors[i * 3 + 2] * 255)}`);
  }
  for (const q of mesh.quads) rows.push('4 ' + q.join(' '));
  writeFileSync(`${OUT}/head_ascii.ply`, head.concat(rows).join('\n') + '\n');
}

/* ---------------------------------------------------------------- *
 * PLY binary_little_endian, uchar colours
 * ---------------------------------------------------------------- */
{
  const header = Buffer.from(
    [
      'ply', 'format binary_little_endian 1.0', `element vertex ${N}`,
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue',
      `element face ${mesh.quads.length}`, 'property list int int vertex_indices', 'end_header',
      '',
    ].join('\n'),
    'ascii',
  );
  const body = Buffer.alloc(N * 15 + mesh.quads.length * 20);
  let o = 0;
  for (let i = 0; i < N; i++) {
    body.writeFloatLE(mesh.positions[i * 3], o); o += 4;
    body.writeFloatLE(mesh.positions[i * 3 + 1], o); o += 4;
    body.writeFloatLE(mesh.positions[i * 3 + 2], o); o += 4;
    body[o++] = Math.round(mesh.colors[i * 3] * 255);
    body[o++] = Math.round(mesh.colors[i * 3 + 1] * 255);
    body[o++] = Math.round(mesh.colors[i * 3 + 2] * 255);
  }
  for (const q of mesh.quads) {
    body.writeInt32LE(4, o); o += 4;
    for (const i of q) { body.writeInt32LE(i, o); o += 4; }
  }
  writeFileSync(`${OUT}/head_binary.ply`, Buffer.concat([header, body.subarray(0, o)]));
}

/* ---------------------------------------------------------------- *
 * STL (binary) - the colourless baseline
 * ---------------------------------------------------------------- */
{
  const body = Buffer.alloc(84 + tris.length * 50);
  body.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12; // normal: recomputed from winding by the importer
    for (const i of t) {
      body.writeFloatLE(mesh.positions[i * 3], o); o += 4;
      body.writeFloatLE(mesh.positions[i * 3 + 1], o); o += 4;
      body.writeFloatLE(mesh.positions[i * 3 + 2], o); o += 4;
    }
    o += 2;
  }
  writeFileSync(`${OUT}/head.stl`, Buffer.concat([Buffer.alloc(80), body.subarray(80).slice(0, 4), body.subarray(84, o)]));
}

/* ---------------------------------------------------------------- *
 * glTF helpers: pack one BIN chunk, emit a GLB container
 * ---------------------------------------------------------------- */
const u16 = (arr) => { const b = Buffer.alloc(arr.length * 2); arr.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
const f32 = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

function makeGLB(json, binBuffers) {
  const bin = Buffer.concat(binBuffers.map(pad4));
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'));
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); // 'glTF'
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  jsonChunk.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + jsonChunk.length);
  out.writeUInt32LE(0x004e4942, 24 + jsonChunk.length); // 'BIN'
  bin.copy(out, 28 + jsonChunk.length);
  return out;
}

/** Build POSITION/COLOR_0/indices accessors with correct 4-byte alignment. */
function gltfMeshFrom(positions, colorsLin, triList) {
  const posB = f32(positions);
  const colB = f32(colorsLin);
  const idxB = u16(triList.flat());
  // indices are 2 bytes each: pad to a 4-byte multiple so the bufferView after
  // it stays aligned.
  const idxPad = idxB.length % 4 ? Buffer.concat([idxB, Buffer.alloc(4 - (idxB.length % 4))]) : idxB;
  const views = [];
  const accessors = [];
  const push = (buf, type, comp, count, target) => {
    const byteOffset = views.reduce((n, v) => n + v.length, 0);
    views.push(buf);
    accessors.push({ bufferView: accessors.length, byteOffset: 0, componentType: comp, count, type });
    return { byteOffset, byteLength: buf.length, target };
  };
  const pv = push(posB, 'VEC3', 5126, positions.length / 3, 34962);
  const cv = push(colB, 'VEC3', 5126, colorsLin.length / 3, 34962);
  const iv = push(idxPad, 'SCALAR', 5123, triList.length * 3, 34963);
  // bufferView indices must match accessor order used above
  accessors[0].bufferView = 0;
  accessors[1].bufferView = 1;
  accessors[2].bufferView = 2;
  return {
    views: [pv, cv, iv],
    accessors,
    count: positions.length / 3,
    bin: [posB, colB, idxPad],
  };
}

/* ---------------------------------------------------------------- *
 * GLB with COLOR_0  (per-vertex, LINEAR per spec)
 * ---------------------------------------------------------------- */
{
  const colorsLin = new Array(N * 3);
  for (let i = 0; i < N * 3; i++) colorsLin[i] = srgbToLinear(mesh.colors[i]);
  const m = gltfMeshFrom(Array.from(mesh.positions), colorsLin, tris);
  const json = {
    asset: { version: '2.0', generator: 'vertexforge-test-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Head' }],
    meshes: [{ name: 'Head', primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, mode: 4 }] }],
    accessors: m.accessors,
    bufferViews: m.views,
    buffers: [{ byteLength: m.bin.reduce((n, b) => n + b.length, 0) }],
  };
  writeFileSync(`${OUT}/head_color.glb`, makeGLB(json, m.bin));
}

/* ---------------------------------------------------------------- *
 * GLB with MATERIALS only (baseColorFactor, linear) - most authored
 * glTFs are coloured this way, with NO COLOR_0 at all.
 * ---------------------------------------------------------------- */
{
  const views = [];
  const accessors = [];
  const bins = [];
  const primitives = [];
  const materials = [];

  for (const g of mesh.groups) {
    const used = new Set();
    for (const fi of g.faces) for (const v of mesh.quads[fi]) used.add(v);
    const list = [...used];
    const remap = new Map(list.map((v, i) => [v, i])); // indices are primitive-relative

    const verts = [];
    let cr = 0; let cg = 0; let cb = 0;
    for (const v of list) {
      verts.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      cr += mesh.colors[v * 3]; cg += mesh.colors[v * 3 + 1]; cb += mesh.colors[v * 3 + 2];
    }

    const localTris = [];
    for (const fi of g.faces) {
      const q = mesh.quads[fi];
      localTris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
    }
    const idxB = u16(localTris.map((t) => t.map((i) => remap.get(i))).flat());
    const idxPad = idxB.length % 4 ? Buffer.concat([idxB, Buffer.alloc(4 - (idxB.length % 4))]) : idxB;

    const posB = f32(verts);
    const posOff = bins.reduce((a, b) => a + Math.ceil(b.length / 4) * 4, 0);
    const idxOff = posOff + Math.ceil(posB.length / 4) * 4;
    bins.push(posB, idxPad);

    accessors.push(
      { bufferView: views.length, componentType: 5126, count: list.length, type: 'VEC3' },
      { bufferView: views.length + 1, componentType: 5123, count: localTris.length * 3, type: 'SCALAR' },
    );
    views.push(
      { buffer: 0, byteOffset: posOff, byteLength: posB.length, target: 34962 },
      { buffer: 0, byteOffset: idxOff, byteLength: idxB.length, target: 34963 },
    );

    materials.push({
      name: g.name,
      pbrMetallicRoughness: {
        // glTF baseColorFactor is LINEAR, so encode exactly like an authoring
        // tool would - this is what the importer must invert.
        baseColorFactor: [srgbToLinear(cr / list.length), srgbToLinear(cg / list.length), srgbToLinear(cb / list.length), 1],
        metallicFactor: 0,
        roughnessFactor: 0.8,
      },
    });
    primitives.push({
      attributes: { POSITION: accessors.length - 2 },
      indices: accessors.length - 1,
      material: materials.length - 1,
      mode: 4,
    });
  }

  const json = {
    asset: { version: '2.0', generator: 'vertexforge-test-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Head' }],
    meshes: [{ name: 'Head', primitives }],
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bins.reduce((a, b) => a + Math.ceil(b.length / 4) * 4, 0) }],
  };
  writeFileSync(`${OUT}/head_materials.glb`, makeGLB(json, bins));
}

/* ---------------------------------------------------------------- *
 * GLB with an EMBEDDED TEXTURE (no COLOR_0) - what a downloaded
 * "3D human head" actually is: UV-mapped, colour lives in a PNG.
 * ---------------------------------------------------------------- */
{
  // Bake the vertex colours into UV space, nearest-neighbour scatter, then
  // fill uncovered pixels with the mean.
  const S = 128;
  const img = new Uint8Array(S * S * 4);
  const seen = new Uint8Array(S * S);
  let mr = 0; let mg = 0; let mb = 0;
  for (let i = 0; i < N; i++) {
    const u = mesh.uvs[i * 2];
    const v = mesh.uvs[i * 2 + 1];
    const x = Math.min(S - 1, Math.max(0, Math.round(u * (S - 1))));
    const y = Math.min(S - 1, Math.max(0, Math.round((1 - v) * (S - 1))));
    const p = (y * S + x) * 4;
    const r = Math.round(mesh.colors[i * 3] * 255);
    const g2 = Math.round(mesh.colors[i * 3 + 1] * 255);
    const b = Math.round(mesh.colors[i * 3 + 2] * 255);
    img[p] = r; img[p + 1] = g2; img[p + 2] = b; img[p + 3] = 255;
    seen[y * S + x] = 1;
    mr += r; mg += g2; mb += b;
  }
  mr /= N; mg /= N; mb /= N;
  for (let i = 0; i < S * S; i++) if (!seen[i]) { img[i * 4] = mr; img[i * 4 + 1] = mg; img[i * 4 + 2] = mb; img[i * 4 + 3] = 255; }
  const png = encodePNG(S, S, img);

  const colorsLin = new Array(N * 3);
  for (let i = 0; i < N * 3; i++) colorsLin[i] = srgbToLinear(mesh.colors[i]);
  void colorsLin;

  const posB = f32(Array.from(mesh.positions));
  const uvB = f32(Array.from(mesh.uvs));
  const idxB = u16(tris.flat());
  const idxPad = idxB.length % 4 ? Buffer.concat([idxB, Buffer.alloc(4 - (idxB.length % 4))]) : idxB;
  const pngPad = png.length % 4 ? Buffer.concat([png, Buffer.alloc(4 - (png.length % 4))]) : png;

  const off = (arr, upto) => arr.slice(0, upto).reduce((a, b) => a + Math.ceil(b.length / 4) * 4, 0);
  const bins = [posB, uvB, idxPad, pngPad];
  const oPos = off(bins, 0);
  const oUv = off(bins, 1);
  const oIdx = off(bins, 2);
  const oImg = off(bins, 3);

  const json = {
    asset: { version: '2.0', generator: 'vertexforge-test-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Head' }],
    meshes: [{
      name: 'Head',
      primitives: [{
        attributes: { POSITION: 0, TEXCOORD_0: 1 },
        indices: 2,
        material: 0,
        mode: 4,
      }],
    }],
    materials: [{
      name: 'HeadTexture',
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 0.85,
      },
    }],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: N, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: N, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: tris.length * 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: oPos, byteLength: posB.length, target: 34962 },
      { buffer: 0, byteOffset: oUv, byteLength: uvB.length, target: 34962 },
      { buffer: 0, byteOffset: oIdx, byteLength: idxB.length, target: 34963 },
      { buffer: 0, byteOffset: oImg, byteLength: png.length },
    ],
    buffers: [{ byteLength: oImg + pngPad.length }],
  };
  writeFileSync(`${OUT}/head_textured.glb`, makeGLB(json, bins));
  writeFileSync(`${OUT}/head_texture_preview.png`, png);
}

/* ---------------- minimal PNG encoder ---------------- */
function encodePNG(w, h, rgba) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cc = Buffer.alloc(4);
    cc.writeUInt32BE(crc(td), 0);
    return Buffer.concat([len, td, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ground truth report ---------------- */
const groups = mesh.groups.map((g) => ({ name: g.name, count: g.faces.length, hexes: g.faces.map((fi) => faceHex(mesh, mesh.quads[fi])) }));
console.log(`vertices ${N}, quads ${mesh.quads.length}, tris ${tris.length}`);
for (const g of groups) {
  const uniq = [...new Set(g.hexes)];
  console.log(`${g.name.padEnd(5)} faces ${String(g.count).padStart(4)}  distinct hexes ${String(uniq.length).padStart(4)}  sample ${uniq.slice(0, 4).join(' ')}`);
}
console.log('wrote to', OUT);
