/* PWA ikonlarını üretir (harici bağımlılık yok).
   Kullanım:  node tools/make-icons.js   */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const BG = [31, 122, 104];       // #1F7A68 deniz yeşili
const FG = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  console.log('yazıldı:', path.relative(process.cwd(), file), size + 'x' + size);
}

/** Basit anti-aliasing için 3x3 örnekleme */
function render(size, { rounded, crossScale }) {
  const px = Buffer.alloc(size * size * 4);
  const r = rounded ? size * 0.22 : 0;
  const arm = size * 0.19 * (crossScale / 0.56);
  const half = size * crossScale / 2;
  const cx = size / 2, cy = size / 2;
  const S = 3;

  const inRounded = (x, y) => {
    if (!rounded) return true;
    const dx = Math.min(x, size - x), dy = Math.min(y, size - y);
    if (dx >= r || dy >= r) return x >= 0 && y >= 0 && x <= size && y <= size;
    return (r - dx) ** 2 + (r - dy) ** 2 <= r * r;
  };
  const inCross = (x, y) => {
    const ax = Math.abs(x - cx), ay = Math.abs(y - cy);
    return (ax <= arm / 2 && ay <= half) || (ay <= arm / 2 && ax <= half);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px0 = x + (sx + 0.5) / S, py0 = y + (sy + 0.5) / S;
          if (!inRounded(px0, py0)) continue;
          bg++;
          if (inCross(px0, py0)) fg++;
        }
      }
      const total = S * S;
      const alpha = Math.round((bg / total) * 255);
      const mix = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      px[i]     = Math.round(BG[0] * (1 - mix) + FG[0] * mix);
      px[i + 1] = Math.round(BG[1] * (1 - mix) + FG[1] * mix);
      px[i + 2] = Math.round(BG[2] * (1 - mix) + FG[2] * mix);
      px[i + 3] = alpha;
    }
  }
  return px;
}

fs.mkdirSync(OUT, { recursive: true });
writePng(path.join(OUT, 'icon-192.png'), 192, render(192, { rounded: true, crossScale: 0.56 }));
writePng(path.join(OUT, 'icon-512.png'), 512, render(512, { rounded: true, crossScale: 0.56 }));
writePng(path.join(OUT, 'icon-maskable-512.png'), 512, render(512, { rounded: false, crossScale: 0.44 }));
