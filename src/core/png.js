/**
 * Minimal PNG decoder - enough for glTF baseColorTexture.
 *
 * Pure JS with no dependencies, and no DOM, so it works identically in the
 * browser and under `node --test`. Inflate comes from DecompressionStream
 * (browser) or node:zlib (tests), whichever exists.
 *
 * Supported: 8-bit RGB / RGBA / grayscale / grayscale+alpha / palette, and
 * 16-bit RGB / RGBA (downsampled to 8 bits). Interlaced (Adam7) files are
 * rejected rather than guessed at.
 */

const SIGN = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(bytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateSync } = await import('node:zlib');
  return new Uint8Array(inflateSync(bytes));
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{width:number,height:number,data:Uint8Array}>} RGBA8 rows
 */
export async function decodePNG(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGN[i]) throw new Error('Not a PNG file.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;

  while (o + 8 <= bytes.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const start = o + 8;
    if (start + len > bytes.length) throw new Error('PNG chunk runs past the end of the file.');
    if (type === 'IHDR') {
      ihdr = {
        width: view.getUint32(start),
        height: view.getUint32(start + 4),
        depth: bytes[start + 8],
        color: bytes[start + 9],
        compress: bytes[start + 10],
        filter: bytes[start + 11],
        interlace: bytes[start + 12],
      };
    } else if (type === 'IDAT') idat.push(bytes.subarray(start, start + len));
    else if (type === 'PLTE') palette = bytes.subarray(start, start + len);
    else if (type === 'tRNS') trns = bytes.subarray(start, start + len);
    else if (type === 'IEND') break;
    o = start + len + 4; // skip data + CRC
  }

  if (!ihdr) throw new Error('PNG has no IHDR.');
  if (ihdr.interlace !== 0) throw new Error('Interlaced PNGs are not supported.');
  if (ihdr.compress !== 0 || ihdr.filter !== 0) throw new Error('PNG uses an unsupported compression or filter method.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error(`PNG colour type ${ihdr.color} is not supported.`);
  if (ihdr.depth !== 8 && ihdr.depth !== 16) throw new Error(`PNG bit depth ${ihdr.depth} is not supported.`);
  if (ihdr.color === 3 && !palette) throw new Error('PNG palette image has no PLTE chunk.');

  const raw = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let ro = 0;
  for (const c of idat) { raw.set(c, ro); ro += c.length; }
  const data = await inflate(raw);

  const { width: w, height: h } = ihdr;
  const bpp = Math.max(1, Math.floor((channels * ihdr.depth) / 8)); // bytes per pixel
  const stride = Math.ceil((w * channels * ihdr.depth) / 8);
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  let p = 0;

  const paeth = (a, b, c) => {
    const pa = Math.abs(b - c);
    const pb = Math.abs(a - c);
    const pc = Math.abs(a + b - 2 * c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < h; y++) {
    const filter = data[p++];
    const line = data.subarray(p, p + stride);
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`PNG row filter ${filter} is not supported.`);
      line[x] = v & 0xff;
    }

    for (let x = 0; x < w; x++) {
      let r;
      let g;
      let b;
      let a = 255;
      if (ihdr.depth === 16) {
        const so = x * channels * 2;
        r = line[so];
        g = channels >= 3 ? line[so + 2] : r;
        b = channels >= 3 ? line[so + 4] : r;
        if (channels === 4) a = line[so + 6];
        if (channels === 2) a = line[so + 2];
      } else {
        const so = x * channels;
        if (ihdr.color === 3) {
          const idx = line[so] * 3;
          r = palette[idx];
          g = palette[idx + 1];
          b = palette[idx + 2];
          if (trns && line[so] < trns.length) a = trns[line[so]];
        } else {
          r = line[so];
          g = channels >= 3 ? line[so + 1] : r;
          b = channels >= 3 ? line[so + 2] : r;
          if (channels === 2) a = line[so + 1];
          if (channels === 4) a = line[so + 3];
        }
      }
      const di = (y * w + x) * 4;
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
    prev.set(line);
  }

  return { width: w, height: h, data: out };
}
