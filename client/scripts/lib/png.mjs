import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes an 8-bit, non-interlaced PNG into RGBA. Only the colour types this
 * repository produces are supported (0 grey, 2 rgb, 6 rgba); anything else
 * throws rather than being silently misread.
 */
export function decode(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
      if (interlace !== 0) throw new Error('interlaced png is not supported');
      if (colorType !== 0 && colorType !== 2 && colorType !== 6) throw new Error('unsupported colour type ' + colorType);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const a = x >= channels ? pixels[row + x - channels] : 0;
      const b = y > 0 ? pixels[prev + x] : 0;
      const c = x >= channels && y > 0 ? pixels[prev + x - channels] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth(a, b, c);
      else throw new Error('bad filter ' + filter);
      pixels[row + x] = out & 0xff;
    }
    pos += stride;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const j = i * channels;
    if (channels === 4) {
      rgba[i * 4] = pixels[j];
      rgba[i * 4 + 1] = pixels[j + 1];
      rgba[i * 4 + 2] = pixels[j + 2];
      rgba[i * 4 + 3] = pixels[j + 3];
    } else if (channels === 3) {
      rgba[i * 4] = pixels[j];
      rgba[i * 4 + 1] = pixels[j + 1];
      rgba[i * 4 + 2] = pixels[j + 2];
      rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4] = pixels[j];
      rgba[i * 4 + 1] = pixels[j];
      rgba[i * 4 + 2] = pixels[j];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes RGBA as PNG. With `alpha: false` the alpha channel is dropped, which
 * is what iOS needs: App Store Connect rejects an icon that has one, even when
 * every pixel is opaque.
 *
 * Each row is filtered with whichever of the five PNG filters leaves the
 * smallest sum of absolute signed bytes. Filter 0 alone compresses badly on the
 * smooth gradients these icons are made of.
 */
export function encode(image, { alpha = true } = {}) {
  const { width, height, data } = image;
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const packed = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = y * stride + x * channels;
      packed[d] = data[s];
      packed[d + 1] = data[s + 1];
      packed[d + 2] = data[s + 2];
      if (alpha) packed[d + 3] = data[s + 3];
    }
  }
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    let best = Infinity;
    let bestFilter = 0;
    let bestRow = null;
    for (let filter = 0; filter < 5; filter += 1) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const src = packed[row + x];
        const a = x >= channels ? packed[row + x - channels] : 0;
        const b = previous[x];
        const c = x >= channels ? previous[x - channels] : 0;
        let value;
        if (filter === 0) value = src;
        else if (filter === 1) value = src - a;
        else if (filter === 2) value = src - b;
        else if (filter === 3) value = src - ((a + b) >> 1);
        else value = src - paeth(a, b, c);
        value &= 0xff;
        candidate[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < best) {
        best = score;
        bestFilter = filter;
        bestRow = Buffer.from(candidate);
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    bestRow.copy(raw, y * (stride + 1) + 1);
    previous = packed.subarray(row, row + stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Alpha bounding box, optionally stopping before a detached shadow. */
export function bodyBounds(image) {
  const { width, height, data } = image;
  const rowHasInk = (y) => {
    for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3] > 12) return true;
    return false;
  };
  let lastInk = height - 1;
  while (lastInk > 0 && !rowHasInk(lastInk)) lastInk -= 1;
  let y = lastInk;
  while (y > 0 && rowHasInk(y)) y -= 1;
  while (y > 0 && !rowHasInk(y)) y -= 1;
  const bottom = y;
  let minX = width;
  let minY = height;
  let maxX = 0;
  for (let yy = 0; yy <= bottom; yy += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(yy * width + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (yy < minY) minY = yy;
      }
    }
  }
  return { minX, minY, width: maxX - minX + 1, height: bottom - minY + 1 };
}

/**
 * Resamples with a box filter when shrinking and bilinear when growing. Both
 * paths interpolate premultiplied alpha, otherwise every soft edge picks up a
 * dark fringe from whatever colour the transparent pixels happen to hold.
 */
export function resize(source, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  const { width: sw, height: sh, data } = source;
  const shrink = width < sw || height < sh;
  if (shrink) {
    const sx = sw / width;
    const sy = sh / height;
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy += 1) {
          for (let xx = x0; xx < x1; xx += 1) {
            const i = (yy * sw + xx) * 4;
            const alpha = data[i + 3] / 255;
            r += data[i] * alpha;
            g += data[i + 1] * alpha;
            b += data[i + 2] * alpha;
            a += data[i + 3];
            n += 1;
          }
        }
        const d = (y * width + x) * 4;
        const average = a / n;
        if (average <= 0) {
          out[d] = 0;
          out[d + 1] = 0;
          out[d + 2] = 0;
          out[d + 3] = 0;
        } else {
          const alpha = average / 255;
          out[d] = r / n / alpha;
          out[d + 1] = g / n / alpha;
          out[d + 2] = b / n / alpha;
          out[d + 3] = average;
        }
      }
    }
    return { width, height, data: out };
  }
  const sample = (x, y) => {
    const cx = Math.min(sw - 1, Math.max(0, x));
    const cy = Math.min(sh - 1, Math.max(0, y));
    const i = (cy * sw + cx) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  for (let y = 0; y < height; y += 1) {
    const fy = ((y + 0.5) * sh) / height - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = ((x + 0.5) * sw) / width - 0.5;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const p00 = sample(x0, y0);
      const p10 = sample(x0 + 1, y0);
      const p01 = sample(x0, y0 + 1);
      const p11 = sample(x0 + 1, y0 + 1);
      const d = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const weights = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];
      const corners = [p00, p10, p01, p11];
      for (let i = 0; i < 4; i += 1) {
        const alpha = corners[i][3] / 255;
        r += corners[i][0] * alpha * weights[i];
        g += corners[i][1] * alpha * weights[i];
        b += corners[i][2] * alpha * weights[i];
        a += corners[i][3] * weights[i];
      }
      if (a <= 0) {
        out[d] = 0;
        out[d + 1] = 0;
        out[d + 2] = 0;
        out[d + 3] = 0;
      } else {
        const alpha = a / 255;
        out[d] = r / alpha;
        out[d + 1] = g / alpha;
        out[d + 2] = b / alpha;
        out[d + 3] = a;
      }
    }
  }
  return { width, height, data: out };
}

/** Crops a region out of an RGBA image. */
export function crop(image, x, y, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let yy = 0; yy < height; yy += 1) {
    const from = ((y + yy) * image.width + x) * 4;
    out.set(image.data.subarray(from, from + width * 4), yy * width * 4);
  }
  return { width, height, data: out };
}

/** Composites an RGBA image onto a solid colour, returning an opaque image. */
export function flatten(image, hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const out = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i += 1) {
    const alpha = image.data[i * 4 + 3] / 255;
    out[i * 4] = image.data[i * 4] * alpha + r * (1 - alpha);
    out[i * 4 + 1] = image.data[i * 4 + 1] * alpha + g * (1 - alpha);
    out[i * 4 + 2] = image.data[i * 4 + 2] * alpha + b * (1 - alpha);
    out[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Places an RGBA image centred on a canvas of the given size. A `hex` of null
 * leaves the canvas transparent, which is what every icon except the tiles
 * wants.
 */
export function compose(canvasWidth, canvasHeight, hex, piece) {
  const out = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  if (hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    for (let i = 0; i < canvasWidth * canvasHeight; i += 1) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = 255;
    }
  }
  const ox = Math.round((canvasWidth - piece.width) / 2);
  const oy = Math.round((canvasHeight - piece.height) / 2);
  for (let y = 0; y < piece.height; y += 1) {
    const ty = oy + y;
    if (ty < 0 || ty >= canvasHeight) continue;
    for (let x = 0; x < piece.width; x += 1) {
      const tx = ox + x;
      if (tx < 0 || tx >= canvasWidth) continue;
      const s = (y * piece.width + x) * 4;
      const d = (ty * canvasWidth + tx) * 4;
      const sourceAlpha = piece.data[s + 3] / 255;
      if (sourceAlpha <= 0) continue;
      // Straight-alpha "source over". The alpha channel has to be written too:
      // on a transparent canvas leaving it at zero produces a file that looks
      // like a valid icon and renders as nothing at all.
      const destinationAlpha = out[d + 3] / 255;
      const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      out[d] = (piece.data[s] * sourceAlpha + out[d] * destinationAlpha * (1 - sourceAlpha)) / outAlpha;
      out[d + 1] = (piece.data[s + 1] * sourceAlpha + out[d + 1] * destinationAlpha * (1 - sourceAlpha)) / outAlpha;
      out[d + 2] = (piece.data[s + 2] * sourceAlpha + out[d + 2] * destinationAlpha * (1 - sourceAlpha)) / outAlpha;
      out[d + 3] = outAlpha * 255;
    }
  }
  return { width: canvasWidth, height: canvasHeight, data: out };
}
