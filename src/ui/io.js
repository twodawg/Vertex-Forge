/**
 * File I/O: native JSON round-trip, external 3D import, and GLB export.
 * No build step, so the exporter comes from the vendored three.js examples via
 * the import map.
 */
import { serialize, deserialize } from '../core/model.js';
import { buildMesh } from '../core/mesh.js';
import { parseAny, extOf, ImportError } from '../core/formats.js';
import { buildDocument } from '../core/importer.js';

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeName(name, fallback = 'model') {
  const s = String(name || '')
    .trim()
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-');
  return s || fallback;
}

/** Native document JSON - lossless, diff-friendly, re-importable. */
export function exportJSON(doc, mesh) {
  const out = serialize(doc);
  out.stats.triangles = mesh?.triangleCount ?? 0;
  return JSON.stringify(out, null, 2);
}

export async function readJSONFile(file) {
  const text = await file.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`That file is not valid JSON: ${err.message}`);
  }
  return deserialize(raw).doc;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

/** Formats the file picker should offer. */
export const IMPORT_ACCEPT = '.json,.vforge.json,.obj,.stl,.ply,.glb,.gltf';

/** True for our own documents (native export, or a bare vertices/faces blob). */
function looksLikeNativeJSON(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.format === 'vertex-forge') return true;
  // glTF JSON also parses as an object, so exclude it explicitly.
  if (raw.asset || raw.meshes || raw.accessors || raw.buffers) return false;
  return Array.isArray(raw.vertices) || Array.isArray(raw.faces) || Array.isArray(raw.edges);
}

/**
 * Import any supported file into a document.
 *
 * @param {File} file
 * @param {object} [opts] see core/importer.js buildDocument
 * @returns {Promise<{doc:object, stats:object}>}
 * @throws {ImportError} with a human-readable message for the toast
 */
export async function importFile(file, opts = {}) {
  if (!file) throw new ImportError('No file was selected.');
  const ext = extOf(file.name);

  if (ext === 'json') {
    const doc = await readJSONFile(file);
    return {
      doc,
      stats: {
        vertices: doc.vertices.length,
        faces: doc.faces.length,
        edges: doc.edges.length,
        native: true,
        note: '',
      },
    };
  }

  // A .json-less native doc is still possible (renamed export): sniff it.
  const buffer = await file.arrayBuffer();
  if (ext === '' || ext === 'txt') {
    const head = new TextDecoder('utf-8').decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64)));
    if (head.trimStart()[0] === '{') {
      try {
        const raw = JSON.parse(await new Blob([buffer]).text());
        if (looksLikeNativeJSON(raw)) {
          const doc = deserialize(raw).doc;
          return { doc, stats: { vertices: doc.vertices.length, faces: doc.faces.length, native: true, note: '' } };
        }
      } catch {
        /* not JSON after all - let the parser below report the real problem */
      }
    }
  }

  const parsed = parseAny(file.name, buffer);
  const built = buildDocument(parsed, { ...opts, name: opts.name || stemOf(file.name) });

  // Fail loudly rather than showing an empty viewport.
  if (!built.doc.vertices.length) throw new ImportError('That file imported no vertices.');
  return built;
}

/** Filename without extension, for the document name. */
export function stemOf(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim();
}

export { ImportError, extOf };

/**
 * GLB (binary glTF) via three's GLTFExporter.
 *
 * Note: in `binary: true` mode the exporter resolves with an **ArrayBuffer**,
 * not a Blob - the upstream signature is loose. Normalize here so callers can
 * hand the result straight to the download helper.
 * @returns {Promise<Blob>}
 */
export async function exportGLB(viewport, doc) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const mesh = buildMesh(doc);
  if (!mesh.triangleCount) throw new Error('Nothing to export: the model has no faces.');
  const object = viewport.buildExportMesh();
  const exporter = new GLTFExporter();
  try {
    var result = await exporter.parseAsync(object, {
      binary: true,
      onlyVisible: false,
      truncateDrawRange: true,
    });
  } finally {
    // The export mesh is throwaway: release its GPU-side resources.
    object.geometry.dispose();
    object.material.dispose();
  }
  if (result instanceof Blob) return result;
  if (result instanceof ArrayBuffer) {
    return new Blob([new Uint8Array(result)], { type: 'model/gltf-binary' });
  }
  // Non-binary fallback (defensive): serialize whatever we got.
  return new Blob([JSON.stringify(result)], { type: 'application/json' });
}

/** Minimal GLB -> text summary for the "what did I load" panel. glTF JSON chunk. */
export function summarizeGLB(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return null;
  const total = view.getUint32(8, true);
  const jsonLen = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4e4f534a || 20 + jsonLen > total) return null;
  const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer, 20, jsonLen));
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
