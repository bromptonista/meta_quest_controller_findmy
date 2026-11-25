/**
 * Minimal, self-contained ISO/IEC 18004 QR Code SVG generator (Byte mode, ECC Level L, Versions 1-6).
 * Zero external requests or tracking — generates a crisp scannable SVG offline for opening the
 * URL on phone / Meta Horizon app / Quest camera.
 */

// Version 1..6 capacities for ECC Level L (total codewords, EC codewords per single block)
const VERSION_SPECS = [
  null,
  { version: 1, size: 21, totalCodewords: 26, ecCodewords: 7, align: [] },
  { version: 2, size: 25, totalCodewords: 44, ecCodewords: 10, align: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, ecCodewords: 15, align: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, ecCodewords: 20, align: [6, 26] },
  { version: 5, size: 37, totalCodewords: 134, ecCodewords: 26, align: [6, 30] },
  { version: 6, size: 41, totalCodewords: 172, ecCodewords: 18, blocks: 2, align: [6, 34] }
];

// GF(256) log/exp tables with primitive polynomial 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(dataBytes, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ rem[0];
    for (let j = 0; j < ecLen - 1; j++) {
      rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    rem[ecLen - 1] = gfMul(gen[ecLen], factor);
  }
  return rem;
}

function encodeCodewords(text) {
  const utf8 = new TextEncoder().encode(text);
  let spec = null;
  for (let v = 1; v <= 6; v++) {
    const s = VERSION_SPECS[v];
    const blocks = s.blocks || 1;
    const dataCapacity = s.totalCodewords - s.ecCodewords * blocks;
    // Byte mode header: 4 bits mode (0100) + 8 bits length = 12 bits -> +2 bytes overhead
    if (utf8.length + 2 <= dataCapacity) {
      spec = { ...s, blocks, dataCapacity };
      break;
    }
  }
  if (!spec) return null; // Too long for v1-v6

  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(utf8.length, 8);
  for (const byte of utf8) pushBits(byte, 8);

  const maxBits = spec.dataCapacity * 8;
  const terminator = Math.min(4, maxBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(spec.dataCapacity);
  let idx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    dataBytes[idx++] = b;
  }
  const pads = [0xec, 0x11];
  let padIdx = 0;
  while (idx < spec.dataCapacity) {
    dataBytes[idx++] = pads[padIdx % 2];
    padIdx++;
  }

  // Interleave blocks (1 block for v1..5, 2 equal blocks for v6-L)
  const blockCount = spec.blocks;
  const blockDataLen = spec.dataCapacity / blockCount;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < blockCount; b++) {
    const slice = dataBytes.subarray(b * blockDataLen, (b + 1) * blockDataLen);
    dataBlocks.push(slice);
    ecBlocks.push(rsEncode(slice, spec.ecCodewords));
  }

  const finalBytes = [];
  for (let i = 0; i < blockDataLen; i++) {
    for (let b = 0; b < blockCount; b++) finalBytes.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < spec.ecCodewords; i++) {
    for (let b = 0; b < blockCount; b++) finalBytes.push(ecBlocks[b][i]);
  }

  return { spec, codewords: finalBytes };
}

function formatBitsForMask(ecLevelBits, maskPattern) {
  const data = (ecLevelBits << 3) | maskPattern;
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= poly << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

export function generateQrMatrix(text) {
  const encoded = encodeCodewords(text);
  if (!encoded) return null;
  const { spec, codewords } = encoded;
  const N = spec.size;

  const modules = Array.from({ length: N }, () => new Uint8Array(N));
  const isFunction = Array.from({ length: N }, () => new Uint8Array(N));

  const setFunc = (r, c, dark) => {
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  const placeFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= N || c < 0 || c >= N) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (onBorder || inCenter));
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, N - 7);
  placeFinder(N - 7, 0);

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const align = spec.align;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = align[i];
      const cc = align[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Reserve format information slots + dark module
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) setFunc(8, i, false);
    if (!isFunction[i][8]) setFunc(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][N - 1 - i]) setFunc(8, N - 1 - i, false);
    if (!isFunction[N - 1 - i][8]) setFunc(N - 1 - i, 8, false);
  }
  setFunc(N - 8, 8, true); // Dark module

  // Place data bits in upward/downward 2-column zig-zag
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = N - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip vertical timing column
    for (let vert = 0; vert < N; vert++) {
      const r = upward ? N - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Apply mask 0: (r + c) % 2 === 0, ECC Level L = 0b01
  const maskPattern = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!isFunction[r][c] && (r + c) % 2 === 0) {
        modules[r][c] ^= 1;
      }
    }
  }

  const fmt = formatBitsForMask(0b01, maskPattern);
  // Copy 1: vertical column 8 (top) and horizontal row 8 (left), LSB at (0,8), MSB at (8,0)
  for (let i = 0; i <= 5; i++) modules[i][8] = (fmt >>> i) & 1;
  modules[7][8] = (fmt >>> 6) & 1;
  modules[8][8] = (fmt >>> 7) & 1;
  modules[8][7] = (fmt >>> 8) & 1;
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = (fmt >>> i) & 1;

  // Copy 2: horizontal row 8 (top-right) for bits 0..7, vertical col 8 (bottom-left) for bits 8..14
  for (let i = 0; i <= 7; i++) modules[8][N - 1 - i] = (fmt >>> i) & 1;
  for (let i = 8; i <= 14; i++) modules[N - 15 + i][8] = (fmt >>> i) & 1;
  modules[N - 8][8] = 1;

  return modules;
}

export function renderQrSvg(text, sizePx = 164) {
  const matrix = generateQrMatrix(text);
  if (!matrix) return '';
  const N = matrix.length;
  const quiet = 3;
  const viewSize = N + quiet * 2;
  let path = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (matrix[r][c]) {
        path += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img" aria-label="QR code for Quest URL"><rect width="${viewSize}" height="${viewSize}" rx="2" fill="#ffffff"/><path d="${path}" fill="#090d16"/></svg>`;
}
