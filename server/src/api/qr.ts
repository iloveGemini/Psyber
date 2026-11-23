/**
 * 零外部依赖 ISO/IEC 18004 标准二维码编码器（Byte 模式，Versions 1–10，纠错等级 L/M），
 * 用于服务端终端打印紧凑 Unicode 半块二维码，以及校验二维码载荷生成。
 */

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
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    for (let j = 0; j < ecCount - 1; j++) {
      rem[j] = rem[j + 1]!;
    }
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        rem[j] ^= gfMul(gen[j + 1]!, factor);
      }
    }
  }
  return rem;
}

interface VersionSpec {
  version: number;
  totalCodewords: number;
  ecPerBlock: number;
  blocks: Array<[count: number, dataCodewords: number]>;
  alignments: number[];
}

// EC Level L (format bits 01) for Versions 1–10: max 271 bytes in Byte mode
const LEVEL_L_SPECS: VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 7, blocks: [[1, 19]], alignments: [] },
  { version: 2, totalCodewords: 44, ecPerBlock: 10, blocks: [[1, 34]], alignments: [6, 18] },
  { version: 3, totalCodewords: 70, ecPerBlock: 15, blocks: [[1, 55]], alignments: [6, 22] },
  { version: 4, totalCodewords: 100, ecPerBlock: 20, blocks: [[1, 80]], alignments: [6, 26] },
  { version: 5, totalCodewords: 134, ecPerBlock: 26, blocks: [[1, 108]], alignments: [6, 30] },
  { version: 6, totalCodewords: 172, ecPerBlock: 18, blocks: [[2, 68]], alignments: [6, 34] },
  { version: 7, totalCodewords: 196, ecPerBlock: 20, blocks: [[2, 78]], alignments: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecPerBlock: 24, blocks: [[2, 97]], alignments: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecPerBlock: 30, blocks: [[2, 116]], alignments: [6, 26, 46] },
  {
    version: 10,
    totalCodewords: 346,
    ecPerBlock: 18,
    blocks: [
      [2, 68],
      [2, 69],
    ],
    alignments: [6, 28, 50],
  },
];

function totalDataCodewords(spec: VersionSpec): number {
  return spec.blocks.reduce((sum, [count, cw]) => sum + count * cw, 0);
}

function selectSpec(byteLen: number): VersionSpec {
  for (const spec of LEVEL_L_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const capBytes = Math.floor((totalDataCodewords(spec) * 8 - 4 - countBits) / 8);
    if (byteLen <= capBytes) return spec;
  }
  throw new Error(`QR payload too long (${byteLen} bytes, max 271)`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataCap = totalDataCodewords(spec);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Mode indicator: Byte (0100)
  pushBits(0b0100, 4);
  // Character count indicator
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) {
    pushBits(b, 8);
  }
  // Terminator (up to 4 zero bits)
  const capBits = dataCap * 8;
  const termLen = Math.min(4, capBits - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCap);
  const byteCount = bits.length / 8;
  for (let i = 0; i < byteCount; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) {
      v = (v << 1) | bits[i * 8 + b]!;
    }
    out[i] = v;
  }
  // Pad bytes alternating 0xEC, 0x11
  let padIdx = 0;
  for (let i = byteCount; i < dataCap; i++) {
    out[i] = padIdx % 2 === 0 ? 0xec : 0x11;
    padIdx++;
  }
  return out;
}

function interleaveBlocks(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, len] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const slice = data.subarray(offset, offset + len);
      offset += len;
      dataBlocks.push(slice);
      ecBlocks.push(rsComputeEc(slice, spec.ecPerBlock));
    }
  }

  const result = new Uint8Array(spec.totalCodewords);
  let idx = 0;
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result[idx++] = block[i]!;
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      result[idx++] = ec[i]!;
    }
  }
  return result;
}

function computeFormatBits(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) {
      rem ^= poly << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  const poly = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if (rem & (1 << i)) {
      rem ^= poly << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function penaltyScore(grid: Uint8Array, size: number): number {
  let score = 0;
  // Rule 1: adjacent modules in row/col
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (grid[r * size + c] === grid[r * size + c - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (grid[r * size + c] === grid[(r - 1) * size + c]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r * size + c];
      if (
        v === grid[r * size + c + 1] &&
        v === grid[(r + 1) * size + c] &&
        v === grid[(r + 1) * size + c + 1]
      ) {
        score += 3;
      }
    }
  }
  // Rule 4: dark module balance
  let dark = 0;
  for (let i = 0; i < grid.length; i++) dark += grid[i]!;
  const pct = (dark * 100) / grid.length;
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export interface QrMatrix {
  version: number;
  size: number;
  modules: Uint8Array;
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = selectSpec(bytes.length);
  const size = spec.version * 4 + 17;
  const base = new Uint8Array(size * size);
  const isFunc = new Uint8Array(size * size);

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    base[r * size + c] = dark ? 1 : 0;
    isFunc[r * size + c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inOuter &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r, c, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunc(6, i, dark);
    setFunc(i, 6, dark);
  }

  // Alignment patterns
  const aligns = spec.alignments;
  for (let i = 0; i < aligns.length; i++) {
    for (let j = 0; j < aligns.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === aligns.length - 1) ||
        (i === aligns.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = aligns[i]!;
      const cc = aligns[j]!;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunc(8, size - 1 - i, false);
    setFunc(size - 1 - i, 8, false);
  }
  setFunc(size - 8, 8, true);

  // Version info (versions >= 7)
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  // Place data + EC bits in standard zig-zag order
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const allCodewords = interleaveBlocks(dataCodewords, spec);
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (isFunc[r * size + c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (allCodewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        base[r * size + c] = bit;
      }
    }
  }

  // Pick best mask (0..7)
  let bestGrid = base;
  let bestScore = Number.POSITIVE_INFINITY;
  const ecLevelLBits = 0b01;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Uint8Array(base);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r * size + c] && maskCondition(mask, r, c)) {
          candidate[r * size + c] ^= 1;
        }
      }
    }
    const fmt = computeFormatBits(ecLevelLBits, mask);
    // Write format info
    const putFmt = (r: number, c: number, bitIdxPos: number) => {
      candidate[r * size + c] = (fmt >>> bitIdxPos) & 1;
    };
    for (let i = 0; i <= 5; i++) putFmt(8, i, 14 - i);
    putFmt(8, 7, 8);
    putFmt(8, 8, 7);
    putFmt(7, 8, 6);
    for (let i = 0; i <= 5; i++) putFmt(5 - i, 8, 5 - i);
    for (let i = 0; i <= 6; i++) putFmt(size - 1 - i, 8, 14 - i);
    for (let i = 0; i <= 7; i++) putFmt(8, size - 8 + i, 7 - i);

    const score = penaltyScore(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestGrid = candidate;
    }
  }

  return { version: spec.version, size, modules: bestGrid };
}

/**
 * 使用 Unicode 半块字符（▀ ▄ █ 空格）在终端渲染紧凑二维码（含静区，适配深色/浅色终端）。
 */
export function renderTerminalQr(text: string, quietZone = 2): string {
  const { size, modules } = encodeQrMatrix(text);
  const total = size + quietZone * 2;
  const isDark = (r: number, c: number): boolean => {
    const mr = r - quietZone;
    const mc = c - quietZone;
    if (mr < 0 || mc < 0 || mr >= size || mc >= size) return false;
    return modules[mr * size + mc] === 1;
  };

  // 反色输出（白底黑码在深色终端中更易被手机识别：用实心块代表亮区，空块代表暗区）
  const lines: string[] = [];
  for (let r = 0; r < total; r += 2) {
    let line = "";
    for (let c = 0; c < total; c++) {
      const topWhite = !isDark(r, c);
      const bottomWhite = r + 1 < total ? !isDark(r + 1, c) : true;
      if (topWhite && bottomWhite) line += "█";
      else if (topWhite && !bottomWhite) line += "▀";
      else if (!topWhite && bottomWhite) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
