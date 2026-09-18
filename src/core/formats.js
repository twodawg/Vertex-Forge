/**
 * Readers for external 3D formats.
 *
 * Every reader returns the same neutral shape so nothing else in the app has to
 * care where geometry came from:
 *
 *   { name, kind, note,
 *     positions: number[],      // flat xyz
 *     polygons:  number[][],    // index rings (OBJ/PLY carry real n-gons)
 *     triangles: number[],      // flat index triples (STL/glTF are tris only)
 *     lines:     number[][],    // index pairs -> document edges
 *   }
 *
 * Deliberately geometry-only. Materials, textures, normals, skinning and
 * animation are dropped because VertexForge edits *vertices* and has nowhere to
 * put the rest. That is also why these are hand-written instead of pulling in
 * three.js's loaders: the loaders build THREE.Scene graphs that we would then
 * dismantle, and they assume a DOM. This module has no dependencies at all, so
 * it runs in Node and is unit-testable.
 *
 * Coordinate convention: whatever the file says, verbatim. OBJ/PLY are
 * right-handed Y-up like three.js; STL and glTF are convention-dependent and are
 * handled by the import options (up-axis swap, scale).
 */

const MAX_OUTPUT_VERTS = 2_000_000; // above this the viewport is unusable anyway

export class ImportError extends Error {}

function fail(msg) {
  throw new ImportError(msg);
}

/* ------------------------------------------------------------------ *
 * OBJ
 * ------------------------------------------------------------------ */

/**
 * Wavefront OBJ - positions and topology only.
 *
 * A corner is keyed by its full `v/vt/vn` specifier, so a vertex that appears
 * with two different normals or UVs stays two vertices here, exactly as the file
 * defines it. The weld pass then collapses whatever legitimately can collapse.
 *
 * Only vertices actually referenced by a face or line become document vertices;
 * a file with 50k `v` lines whose geometry uses 300 of them should not drop 50k
 * handles into the viewport.
 */
export function parseOBJ(text) {
  const vTable = [];
  let vtCount = 0;
  let vnCount = 0;
  let name = null;
  const faces = [];
  const polylines = [];

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] === '#') continue;
    const f = line.split(/\s+/);
    switch (f[0]) {
      case 'v': {
        const x = Number(f[1]);
        const y = Number(f[2]);
        const z = Number(f[3]);
        if (x === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) break;
        vTable.push([x, y, z, Number(f[4]) || 1]); // w for homogeneous vertices
        break;
      }
      case 'vt':
        vtCount++;
        break;
      case 'vn':
        vnCount++;
        break;
      case 'f':
        if (f.length > 3) faces.push(f.slice(1));
        break;
      case 'l':
        if (f.length > 2) polylines.push(f.slice(1));
        break;
      case 'o':
        if (!name && f.length > 1) name = f.slice(1).join(' ');
        break;
      default:
        break; // mtllib/usemtl/g/s/vp/nr are all irrelevant to us
    }
  }

  if (!vTable.length) fail('No vertices found (this OBJ has no "v" lines).');

  const positions = [];
  const used = new Map(); // "vIdx|vt|vn" -> output index
  const resolve = (token) => {
    const parts = token.split('/');
    const raw = Number(parts[0]);
    if (!Number.isFinite(raw) || raw === 0) return null;
    const idx = raw > 0 ? raw - 1 : vTable.length + raw; // negatives count from the end
    if (idx < 0 || idx >= vTable.length) return null;
    const key = `${idx}|${parts[1] || ''}|${parts[2] || ''}`;
    let out = used.get(key);
    if (out !== undefined) return out;
    out = positions.length / 3;
    const [x, y, z, w] = vTable[idx];
    if (w !== 1 && Number.isFinite(w) && w !== 0) {
      positions.push(x / w, y / w, z / w);
    } else {
      positions.push(x, y, z);
    }
    used.set(key, out);
    return out;
  };

  const polygons = [];
  const lines = [];
  for (const tokens of faces) {
    const ring = [];
    for (const t of tokens) {
      const i = resolve(t);
      if (i !== null && !ring.includes(i)) ring.push(i);
    }
    if (ring.length >= 3) polygons.push(ring);
  }
  for (const tokens of polylines) {
    const chain = tokens.map(resolve).filter((i) => i !== null);
    for (let i = 0; i + 1 < chain.length; i++) {
      if (chain[i] !== chain[i + 1]) lines.push([chain[i], chain[i + 1]]);
    }
  }

  if (!polygons.length && !lines.length) {
    fail('That OBJ has vertices but no faces ("f") or lines ("l") to import.');
  }
  if (positions.length / 3 > MAX_OUTPUT_VERTS) fail('That OBJ is too large to edit here.');

  return {
    name: name || 'OBJ import',
    kind: 'OBJ',
    positions,
    polygons,
    triangles: [],
    lines,
    note: vtCount || vnCount ? `${vtCount ? 'UVs' : ''}${vtCount && vnCount ? ' and ' : ''}${vnCount ? 'normals' : ''} were dropped.` : '',
  };
}

/* ------------------------------------------------------------------ *
 * STL
 * ------------------------------------------------------------------ */

/**
 * STL, ascii or binary. Every facet owns its own three vertices, so an unwelded
 * STL has roughly 3x the vertex count it should and every corner is three
 * overlapping handles. Welding is what makes an STL editable.
 */
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const text = decodeUTF8(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (/solid[\s\S]*facet\s+normal/.test(text) && /vertex/.test(text)) return parseSTLAscii(decodeUTF8(bytes));
  return parseSTLBinary(bytes);
}

function parseSTLAscii(text) {
  const positions = [];
  const triangles = [];
  // One regex over the whole file: "vertex x y z" in facet order. Normals are
  // ignored because they are derived from the winding, which is what survives
  // welding and re-triangulating.
  const facetRE = /facet[\s\S]*?outer loop([\s\S]*?)endloop/g;
  let m;
  while ((m = facetRE.exec(text))) {
    const verts = [...m[1].matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)];
    if (verts.length < 3) continue;
    const base = positions.length / 3;
    for (let i = 0; i < 3; i++) {
      positions.push(Number(verts[i][1]), Number(verts[i][2]), Number(verts[i][3]));
    }
    triangles.push(base, base + 1, base + 2);
    if (positions.length / 3 > MAX_OUTPUT_VERTS) fail('That STL is too large to edit here.');
  }
  const tris = triangles.length / 3;
  if (!tris) fail('No facets found - that does not look like an STL.');
  return {
    name: 'STL import',
    kind: 'STL',
    positions,
    polygons: [],
    triangles,
    lines: [],
    note: `${tris} detached triangles - welding merges their shared corners.`,
  };
}

function parseSTLBinary(bytes) {
  if (bytes.length < 84) fail('That file is too small to be a binary STL.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const expected = 84 + count * 50;
  if (count === 0 || bytes.length !== expected) {
    fail(`Binary STL size mismatch (expected ${expected} bytes for ${count} triangles, got ${bytes.length}).`);
  }
  if (count * 3 > MAX_OUTPUT_VERTS) fail('That STL is too large to edit here.');

  const positions = new Array(count * 9);
  const triangles = new Array(count * 3);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12; // facet normal: recomputed from winding instead
    for (let i = 0; i < 9; i++) {
      positions[t * 9 + i] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count
    triangles[t * 3] = t * 3;
    triangles[t * 3 + 1] = t * 3 + 1;
    triangles[t * 3 + 2] = t * 3 + 2;
  }
  return {
    name: 'STL import',
    kind: 'STL',
    positions,
    polygons: [],
    triangles,
    lines: [],
    note: `${count} detached triangles - welding merges their shared corners.`,
  };
}

/* ------------------------------------------------------------------ *
 * PLY
 * ------------------------------------------------------------------ */

const PLY_TYPES = {
  char: [1, 'i8'],
  int8: [1, 'u8'],
  uchar: [1, 'u8'],
  short: [2, 'i16'],
  int16: [2, 'i16'],
  ushort: [2, 'u16'],
  uint16: [2, 'u16'],
  int: [4, 'i32'],
  int32: [4, 'i32'],
  uint: [4, 'u32'],
  uint32: [4, 'u32'],
  float: [4, 'f32'],
  float32: [4, 'f32'],
  double: [8, 'f64'],
  float64: [8, 'f64'],
};

/**
 * Stanford PLY: ascii plus binary in either endianness. Vertex x/y/z and the
 * face index lists are all that matters here; red/green/blue/alpha, normals and
 * texture coordinates are stepped over and discarded.
 *
 * Vertices that no face references stay in the document as loose points, which
 * is exactly what a raw scan should import as.
 */
export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  // PLY headers are ASCII, so a character offset in this prefix is also a byte
  // offset into the file.
  const head = decodeUTF8(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const trimmed = head.replace(/^\uFEFF/, '');
  if (!/^ply\b/.test(trimmed.trimStart())) fail('That is not a PLY file (missing the "ply" magic).');
  const endMarker = trimmed.indexOf('end_header');
  if (endMarker < 0) fail('PLY header has no end_header line.');
  const nl = trimmed.indexOf('\n', endMarker);
  if (nl < 0) fail('PLY header is truncated.');
  const bodyOffset = nl + 1;

  const format = (/format\s+(\S+)/.exec(trimmed) || [])[1];
  if (!format) fail('PLY header has no format line.');

  const elements = [];
  let current = null;
  for (const line of trimmed.slice(0, endMarker).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'element') {
      current = { name: f[1], count: Math.max(0, Number(f[2]) || 0), props: [] };
      elements.push(current);
    } else if (f[0] === 'property' && current) {
      if (f[1] === 'list') current.props.push({ list: true, countType: f[2], itemType: f[3], name: f[4] });
      else if (PLY_TYPES[f[1]]) current.props.push({ list: false, type: f[1], name: f[2] });
    }
  }

  const vertexEl = elements.find((e) => e.name === 'vertex');
  if (!vertexEl) fail('PLY has no vertex element.');
  const faceEl = elements.find((e) => e.name === 'face');

  const positions = [];
  const polygons = [];
  const lines = [];

  if (format === 'ascii') {
    const rows = decodeUTF8(bytes.subarray(bodyOffset)).split(/\r?\n/);
    let r = 0;
    const nextRow = () => {
      while (r < rows.length && !rows[r].trim()) r++;
      return r < rows.length ? rows[r++].trim().split(/\s+/) : null;
    };
    for (const el of elements) {
      const names = el.props.map((p) => p.name);
      const listAt = el.props.findIndex((p) => p.list);
      for (let i = 0; i < el.count; i++) {
        const f = nextRow();
        if (!f) {
          fail('That PLY is truncated.');
        }
        const nums = f.map(Number);
        if (el === vertexEl) {
          positions.push(nums[names.indexOf('x')] || 0, nums[names.indexOf('y')] || 0, nums[names.indexOf('z')] || 0);
        } else if (el === faceEl && listAt >= 0) {
          let o = 0;
          const ring = [];
          for (const p of el.props) {
            if (p.list) {
              const cnt = nums[o++];
              for (let k = 0; k < cnt; k++) ring.push(nums[o++]);
            } else o++;
          }
          const clean = dedupeRing(ring.filter((j) => j >= 0 && j < positions.length / 3));
          if (clean.length >= 3) polygons.push(clean);
        }
      }
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    const le = format === 'binary_little_endian';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = bodyOffset;
    const read = (type) => {
      const spec = PLY_TYPES[type] || [4, 'f32'];
      const size = spec[0];
      if (o + size > bytes.length) fail('That PLY is truncated.');
      let v;
      switch (spec[1]) {
        case 'i8': v = view.getInt8(o); break;
        case 'u8': v = view.getUint8(o); break;
        case 'i16': v = view.getInt16(o, le); break;
        case 'u16': v = view.getUint16(o, le); break;
        case 'i32': v = view.getInt32(o, le); break;
        case 'u32': v = view.getUint32(o, le); break;
        case 'f32': v = view.getFloat32(o, le); break;
        case 'f64': v = view.getFloat64(o, le); break;
        default: v = 0;
      }
      o += size;
      return v;
    };

    for (const el of elements) {
      const names = el.props.map((p) => p.name);
      const xi = names.indexOf('x');
      const yi = names.indexOf('y');
      const zi = names.indexOf('z');
      const interesting = el === vertexEl || el === faceEl;
      if (el === vertexEl && (xi < 0 || yi < 0 || zi < 0)) fail('PLY vertices have no x/y/z properties.');

      for (let i = 0; i < el.count; i++) {
        let x = 0;
        let y = 0;
        let z = 0;
        const ring = [];
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p];
          if (prop.list) {
            const cnt = read(prop.countType);
            for (let k = 0; k < cnt; k++) ring.push(read(prop.itemType));
          } else {
            const v = read(prop.type);
            if (interesting && el === vertexEl) {
              if (p === xi) x = v;
              else if (p === yi) y = v;
              else if (p === zi) z = v;
            }
          }
        }
        if (el === vertexEl) positions.push(x, y, z);
        else if (el === faceEl) {
          const clean = dedupeRing(ring.filter((j) => j >= 0 && j < positions.length / 3));
          if (clean.length >= 3) polygons.push(clean);
        }
      }
    }
  } else {
    fail(`PLY format "${format}" is not supported (ascii or binary only).`);
  }

  if (!positions.length) fail('No vertices found in that PLY.');
  if (positions.length / 3 > MAX_OUTPUT_VERTS) fail('That PLY is too large to edit here.');

  return {
    name: 'PLY import',
    kind: 'PLY',
    positions,
    polygons,
    triangles: [],
    lines,
    note: 'Colours and normals were dropped.',
  };
}

function dedupeRing(ids) {
  const out = [];
  for (const id of ids) {
    if (!out.length || out[out.length - 1] !== id) out.push(id);
  }
  if (out.length > 2 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

/* ------------------------------------------------------------------ *
 * glTF 2.0 / GLB
 * ------------------------------------------------------------------ */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS = { 5120: [1, 'i8'], 5121: [1, 'u8'], 5122: [2, 'i16'], 5123: [2, 'u16'], 5125: [4, 'u32'], 5126: [4, 'f32'] };
const NUM_COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * glTF 2.0 JSON, with buffers supplied by the caller.
 *
 * Reads mesh primitives and the node transforms above them, so scale and world
 * placement survive. Materials, textures, morph targets, sparse storage and
 * animation are dropped - and said so in `note` rather than half-applied.
 *
 * glTF is right-handed Y-up with -Z forward, the same convention three.js and
 * VertexForge use, so no axis swap is needed on the way in.
 *
 * @param {object} json parsed glTF JSON
 * @param {Map<number,Uint8Array>} buffers buffer index -> bytes
 */
export function parseGLTF(json, buffers, fileName = 'glTF import') {
  if (!json || typeof json !== 'object') fail('Not a glTF file.');
  const version = json.asset?.version;
  if (version && !/^2\./.test(String(version))) {
    fail(`glTF ${version} is not supported (this reader handles glTF 2.x).`);
  }

  const dataViews = [];
  for (let i = 0; i < (json.buffers || []).length; i++) {
    const buf = json.buffers[i];
    let bytes = buffers.get(i);
    if (!bytes && typeof buf.uri === 'string' && buf.uri.startsWith('data:')) {
      bytes = base64Bytes(buf.uri);
    }
    if (!bytes) {
      fail(
        `That .gltf needs an external file ("${buf.uri || 'buffer ' + i}") which a browser page cannot read on its own. ` +
          'Export or convert it to a single-file .glb and import that.',
      );
    }
    dataViews.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  const readAccessor = (index) => {
    if (index == null) return null;
    const acc = json.accessors?.[index];
    if (!acc) return null;
    if (acc.sparse) fail('Sparse glTF accessors are not supported.');
    const comp = COMPONENTS[acc.componentType];
    if (!comp) fail(`Unknown glTF component type ${acc.componentType}.`);
    const nc = NUM_COMPS[acc.type];
    if (!nc) fail(`Unsupported glTF accessor type "${acc.type}".`);
    const view = json.bufferViews?.[acc.bufferView];
    const dv = dataViews[view?.buffer ?? 0];
    if (!view || !dv) fail('glTF accessor has no readable bufferView.');
    const [size, kind] = comp;
    const stride = view.byteStride || size * nc;
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
    if (start < 0 || acc.count < 0 || start + (acc.count - 1) * stride + size * nc > dv.byteLength) {
      fail('A glTF accessor reads past the end of its buffer.');
    }
    const values = new Float64Array(acc.count * nc);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < nc; c++) values[i * nc + c] = readScalar(dv, start + i * stride + c * size, kind);
    }
    return { values, count: acc.count };
  };

  const positions = [];
  const triangles = [];
  const lines = [];
  const dropped = new Set();
  const skippedModes = new Set();

  const addPrimitive = (prim, matrix) => {
    const attrs = prim.attributes || {};
    if (attrs.NORMAL || attrs.TEXCOORD_0 || attrs.TEXCOORD_1 || attrs.TANGENT || attrs.COLOR_0) dropped.add('attributes');
    if (prim.extensions) dropped.add('extensions');
    const pos = readAccessor(attrs.POSITION);
    if (!pos) return;

    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.values[i * 3];
      let y = pos.values[i * 3 + 1];
      let z = pos.values[i * 3 + 2];
      if (matrix) [x, y, z] = applyMatrix(matrix, x, y, z);
      // Keep the index mapping intact: a broken coordinate becomes the origin
      // instead of shifting every later vertex out of alignment.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        if (!Number.isFinite(x)) x = 0;
        if (!Number.isFinite(y)) y = 0;
        if (!Number.isFinite(z)) z = 0;
        dropped.add('nonfinite');
      }
      positions.push(x, y, z);
    }

    const idx = readAccessor(prim.indices);
    const at = (i) => (idx ? idx.values[i] : i);
    const count = idx ? idx.count : pos.count;
    const span = positions.length / 3 - base;
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < span;
    const tri = (a, b, c) => {
      if (ok(a) && ok(b) && ok(c) && a !== b && b !== c && a !== c) {
        triangles.push(base + a, base + b, base + c);
      }
    };
    const seg = (a, b) => {
      if (ok(a) && ok(b) && a !== b) lines.push([base + a, base + b]);
    };

    // glTF draw modes: 0 POINTS, 1 LINES, 2 LINE_LOOP, 3 LINE_STRIP,
    // 4 TRIANGLES, 5 TRIANGLE_STRIP, 6 TRIANGLE_FAN.
    switch (prim.mode ?? 4) {
      case 4:
        for (let i = 0; i + 2 < count; i += 3) tri(at(i), at(i + 1), at(i + 2));
        break;
      case 5: // strip: overlapping triangles with alternating winding
        for (let i = 0; i + 2 < count; i++) {
          if (i % 2 === 0) tri(at(i), at(i + 1), at(i + 2));
          else tri(at(i), at(i + 2), at(i + 1));
        }
        break;
      case 6: // fan: every triangle shares the first vertex
        for (let i = 1; i + 1 < count; i++) tri(at(0), at(i), at(i + 1));
        break;
      case 1:
        for (let i = 0; i + 1 < count; i += 2) seg(at(i), at(i + 1));
        break;
      case 2:
        for (let i = 0; i < count; i++) seg(at(i), at((i + 1) % count));
        break;
      case 3:
        for (let i = 0; i + 1 < count; i++) seg(at(i), at(i + 1));
        break;
      case 0:
        break; // POINTS: vertices already imported, they simply get no faces
      default:
        skippedModes.add(prim.mode);
    }
  };

  const walk = (nodeIndex, parentMatrix, depth, seen) => {
    if (depth > 64 || seen.has(nodeIndex)) return;
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    seen.add(nodeIndex);
    const local = nodeMatrix(node);
    const matrix = local ? multiply(parentMatrix, local) : parentMatrix;
    if (node.mesh != null) {
      for (const prim of json.meshes?.[node.mesh]?.primitives || []) {
        addPrimitive(prim, matrix);
      }
    }
    for (const c of node.children || []) walk(c, matrix, depth + 1, seen);
  };

  const sceneList = json.scenes || [];
  const scene = sceneList[json.defaultScene ?? 0] || sceneList[0];
  if (scene?.nodes?.length) {
    for (const n of scene.nodes) walk(n, identity(), 0, new Set());
  } else if (json.meshes?.length) {
    // No usable scene graph: read meshes directly, untransformed.
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives || []) addPrimitive(prim, null);
    }
  } else {
    fail('That glTF has no scene and no meshes.');
  }

  if (!positions.length) fail('That glTF contained no readable vertex positions.');
  if (positions.length / 3 > MAX_OUTPUT_VERTS) fail('That glTF is too large to edit here.');

  const notes = [];
  if (dropped.has('attributes')) notes.push('Materials, textures, normals and colours were dropped.');
  if (dropped.has('extensions')) notes.push('Unsupported glTF extensions were ignored.');
  if (skippedModes.size) notes.push(`Skipped unsupported draw mode${skippedModes.size > 1 ? 's' : ''} ${[...skippedModes].join(', ')}.`);
  if (dropped.has('nonfinite')) notes.push('A few coordinates were invalid and reset to the origin.');
  if ((json.animations || []).length) notes.push('Animation was dropped.');
  if ((json.skins || []).length) notes.push('Skinning was dropped.');
  if ((json.meshes || []).some((m) => (m.primitives || []).some((p) => p.targets))) {
    notes.push('Morph targets were dropped.');
  }

  return {
    name: String(fileName).replace(/\.(glb|gltf)$/i, '').trim() || 'glTF import',
    kind: 'glTF',
    positions,
    polygons: [],
    triangles,
    lines,
    note: notes.join(' '),
  };
}

function readScalar(dv, offset, kind) {
  switch (kind) {
    case 'i8': return dv.getInt8(offset);
    case 'u8': return dv.getUint8(offset);
    case 'i16': return dv.getInt16(offset, true);
    case 'u16': return dv.getUint16(offset, true);
    case 'u32': return dv.getUint32(offset, true);
    case 'f32': return dv.getFloat32(offset, true);
    default: return 0;
  }
}

/** Column-major 4x4, matching glTF's `matrix` and three.js's elements order. */
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const t = node.translation;
  const r = node.rotation;
  const s = node.scale;
  if (!t && !r && !s) return null;
  let m = identity();
  if (s) m = multiply(m, scaleMat(s[0], s[1], s[2]));
  if (r && Math.hypot(r[0], r[1], r[2], r[3]) > 0) m = multiply(m, quatMat(r[0], r[1], r[2], r[3]));
  if (t) m = multiply(m, translateMat(t[0], t[1], t[2]));
  return m;
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function translateMat(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}
function scaleMat(x, y, z) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}
function quatMat(x, y, z, w) {
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

/** a * b (column-major). */
function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function applyMatrix(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const d = Math.abs(w) > 1e-12 ? w : 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / d,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / d,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / d,
  ];
}

function base64Bytes(uri) {
  const b64 = uri.slice(uri.indexOf(',') + 1).replace(/\s/g, '');
  if (typeof atob !== 'function') fail('That glTF embeds a data: URI but this runtime cannot decode base64.');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** GLB container bytes -> { json, buffers: Map<index, Uint8Array> }. */
export function parseGLBContainer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 20) fail('That file is too small to be a GLB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) fail('Missing the glTF binary magic ("glTF").');
  const version = view.getUint32(4, true);
  if (version !== 2) fail(`GLB version ${version} is not supported (only version 2).`);
  const total = view.getUint32(8, true);
  if (total > bytes.length) fail('That GLB is truncated.');

  let json = null;
  const buffers = new Map();
  let o = 12;
  while (o + 8 <= total) {
    const len = view.getUint32(o, true);
    const type = view.getUint32(o + 4, true);
    const start = o + 8;
    if (start + len > total) fail('That GLB has a chunk running past the end of the file.');
    if (type === CHUNK_JSON) {
      // The JSON chunk is space-padded to a 4-byte boundary; trim the filler.
      const slice = bytes.subarray(start, start + len);
      let end = slice.length;
      while (end > 0 && (slice[end - 1] === 0x20 || slice[end - 1] === 0)) end--;
      try {
        json = JSON.parse(decodeUTF8(slice.subarray(0, end)));
      } catch (err) {
        fail(`The GLB JSON chunk is not valid JSON: ${err.message}`);
      }
    } else if (type === CHUNK_BIN) {
      buffers.set(0, bytes.subarray(start, start + len));
    }
    // chunkLength excludes the padding that aligns the NEXT chunk header to a
    // 4-byte boundary, so advance over the padded size rather than `len`.
    o = start + Math.ceil(len / 4) * 4;
  }
  if (!json) fail('That GLB has no JSON chunk.');
  return { json, buffers };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(String(name).trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * Parse any supported 3D file from its bytes, sniffing the format from the
 * extension and falling back to content detection. VertexForge JSON is handled
 * by the caller (it needs `deserialize`, which lives in model.js).
 */
export function parseAny(name, arrayBuffer) {
  const ext = extOf(name);
  const bytes = new Uint8Array(arrayBuffer);

  if (ext === 'glb') {
    const { json, buffers } = parseGLBContainer(arrayBuffer);
    return parseGLTF(json, buffers, name);
  }
  if (ext === 'stl') return parseSTL(arrayBuffer);
  if (ext === 'ply') return parsePLY(arrayBuffer);

  const text = decodeUTF8(bytes);

  if (ext === 'gltf') {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      fail(`That .gltf is not valid JSON: ${err.message}`);
    }
    return parseGLTF(json, new Map(), name);
  }
  if (ext === 'obj') return parseOBJ(text);

  // No usable extension: sniff.
  if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === GLB_MAGIC) {
    const { json, buffers } = parseGLBContainer(arrayBuffer);
    return parseGLTF(json, buffers, name);
  }
  const t = text.trimStart();
  if (/^ply\b/.test(t)) return parsePLY(arrayBuffer);
  if (/^solid[\s\S]{0,400}facet\s+normal/.test(t)) return parseSTL(arrayBuffer);
  if (/^\s*(#\s|v\s|vn\s|vt\s|f\s|l\s|o\s|g\s)/m.test(t) && /(^|\n)\s*(v|f|l)\s+\S/.test(t)) {
    return parseOBJ(text);
  }
  if (t[0] === '{') {
    try {
      const json = JSON.parse(t);
      if (json.meshes || json.accessors || json.asset) return parseGLTF(json, new Map(), name);
    } catch {
      /* fall through to the error below */
    }
  }

  fail(`Cannot tell what format "${name || 'that file'}" is. Supported: OBJ, STL, PLY, GLB, glTF, and VertexForge JSON.`);
}

/* ------------------------------------------------------------------ *
 * Text decoding
 * ------------------------------------------------------------------ */

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

export function decodeUTF8(bytes) {
  if (decoder) return decoder.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
