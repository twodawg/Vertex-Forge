/**
 * File I/O: native JSON round-trip plus GLB export. No build step, so the
 * exporter comes from the vendored three.js examples via the import map.
 */
import { serialize, deserialize } from '../core/model.js';
import { buildMesh } from '../core/mesh.js';

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
