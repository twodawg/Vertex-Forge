/**
 * Turn glTF baseColorTexture into per-vertex colours.
 *
 * parseGLTF is synchronous (the whole core is), and PNG decoding needs async
 * inflate, so the parser records `textureJobs` and this module finishes the
 * work in the already-async import path. Each vertex samples its own UV, so a
 * UV-mapped head arrives with skin, hair and eyes distinguishable rather than
 * one flat material.
 *
 * Sampling is nearest-texel with REPEAT wrapping and glTF's V convention
 * (V = 0 at the top of the image), which is what baseColorTexture uses.
 */
import { decodePNG } from './png.js';

const cache = new Map(); // bytes -> decoded image promise

async function decodeCached(bytes, mimeType) {
  if (mimeType && !/png/i.test(mimeType)) return null; // JPEG is not decodable here
  const key = bytes.subarray(0, Math.min(bytes.length, 64)).join(',');
  let p = cache.get(key);
  if (!p) {
    p = decodePNG(bytes).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/**
 * @param {object} parsed the parseAny result (mutated: colors filled in)
 * @returns {Promise<{baked:number, failed:number}>}
 */
export async function applyTextures(parsed) {
  const jobs = parsed?.textureJobs;
  if (!jobs?.length || !parsed.uvs) return { baked: 0, failed: 0 };

  const colors = parsed.colors?.length === parsed.positions.length ? parsed.colors.slice() : new Array(parsed.positions.length).fill(1);
  let baked = 0;
  let failed = 0;

  for (const job of jobs) {
    const img = await decodeCached(job.bytes, job.mimeType);
    if (!img) {
      failed++;
      continue;
    }
    const { width: w, height: h, data } = img;
    const fr = (v) => v - Math.floor(v); // REPEAT wrap, including negatives
    for (let i = 0; i < job.count; i++) {
      const vi = job.uvBase + i;
      if (vi * 2 + 1 >= parsed.uvs.length) break;
      const u = parsed.uvs[vi * 2];
      const v = parsed.uvs[vi * 2 + 1];
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const x = Math.min(w - 1, Math.max(0, Math.floor(fr(u) * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor((1 - fr(v)) * h)));
      const p = (y * w + x) * 4;
      // Alpha-blend toward a light grey so transparent texels do not import
      // as hard black holes in the middle of the model.
      const a = data[p + 3] / 255;
      const o = vi * 3;
      colors[o] = (data[p] * a + 204 * (1 - a)) / 255;
      colors[o + 1] = (data[p + 1] * a + 204 * (1 - a)) / 255;
      colors[o + 2] = (data[p + 2] * a + 204 * (1 - a)) / 255;
      baked++;
    }
  }

  if (!baked) return { baked, failed };
  // Mutates in place: importFile awaits this before buildDocument, so the
  // importer sees colours strictly parallel to positions, as it requires.
  parsed.colors = colors;
  parsed.uvs = undefined;
  parsed.textureJobs = undefined;
  return { baked, failed };
}
