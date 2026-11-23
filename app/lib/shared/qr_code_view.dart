import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

/// 零外部依赖 ISO/IEC 18004 标准二维码矩阵编码器（Byte 模式，EC Level L，Versions 1–10）。
class QrMatrix {
  const QrMatrix({
    required this.version,
    required this.size,
    required this.modules,
  });

  final int version;
  final int size;
  final Uint8List modules;

  bool isDark(int row, int col) => modules[row * size + col] == 1;

  static final Uint8List _gfExp = _initGfExp();
  static final Uint8List _gfLog = _initGfLog();

  static Uint8List _initGfExp() {
    final exp = Uint8List(512);
    var x = 1;
    for (var i = 0; i < 255; i++) {
      exp[i] = x;
      x <<= 1;
      if ((x & 0x100) != 0) x ^= 0x11d;
    }
    for (var i = 255; i < 512; i++) {
      exp[i] = exp[i - 255];
    }
    return exp;
  }

  static Uint8List _initGfLog() {
    final log = Uint8List(256);
    var x = 1;
    for (var i = 0; i < 255; i++) {
      log[x] = i;
      x <<= 1;
      if ((x & 0x100) != 0) x ^= 0x11d;
    }
    return log;
  }

  static int _gfMul(int a, int b) {
    if (a == 0 || b == 0) return 0;
    return _gfExp[_gfLog[a] + _gfLog[b]];
  }

  static Uint8List _rsGenPoly(int ecCount) {
    var poly = Uint8List.fromList([1]);
    for (var i = 0; i < ecCount; i++) {
      final next = Uint8List(poly.length + 1);
      final factor = _gfExp[i];
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= _gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  static Uint8List _rsEc(Uint8List data, int ecCount) {
    final gen = _rsGenPoly(ecCount);
    final rem = Uint8List(ecCount);
    for (var i = 0; i < data.length; i++) {
      final factor = data[i] ^ rem[0];
      for (var j = 0; j < ecCount - 1; j++) {
        rem[j] = rem[j + 1];
      }
      rem[ecCount - 1] = 0;
      if (factor != 0) {
        for (var j = 0; j < ecCount; j++) {
          rem[j] ^= _gfMul(gen[j + 1], factor);
        }
      }
    }
    return rem;
  }

  static const List<_QrVersionSpec> _specs = [
    _QrVersionSpec(1, 26, 7, [(1, 19)], []),
    _QrVersionSpec(2, 44, 10, [(1, 34)], [6, 18]),
    _QrVersionSpec(3, 70, 15, [(1, 55)], [6, 22]),
    _QrVersionSpec(4, 100, 20, [(1, 80)], [6, 26]),
    _QrVersionSpec(5, 134, 26, [(1, 108)], [6, 30]),
    _QrVersionSpec(6, 172, 18, [(2, 68)], [6, 34]),
    _QrVersionSpec(7, 196, 20, [(2, 78)], [6, 22, 38]),
    _QrVersionSpec(8, 242, 24, [(2, 97)], [6, 24, 42]),
    _QrVersionSpec(9, 292, 30, [(2, 116)], [6, 26, 46]),
    _QrVersionSpec(10, 346, 18, [(2, 68), (2, 69)], [6, 28, 50]),
  ];

  static _QrVersionSpec _selectSpec(int byteLen) {
    for (final spec in _specs) {
      final countBits = spec.version <= 9 ? 8 : 16;
      final capBytes = (spec.totalDataCodewords * 8 - 4 - countBits) ~/ 8;
      if (byteLen <= capBytes) return spec;
    }
    throw ArgumentError('QR payload too long ($byteLen bytes, max 271)');
  }

  static int _formatBits(int ecBits, int mask) {
    final data = (ecBits << 3) | mask;
    var rem = data << 10;
    const poly = 0x537;
    for (var i = 14; i >= 10; i--) {
      if ((rem & (1 << i)) != 0) {
        rem ^= poly << (i - 10);
      }
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  static int _versionBits(int version) {
    var rem = version << 12;
    const poly = 0x1f25;
    for (var i = 17; i >= 12; i--) {
      if ((rem & (1 << i)) != 0) {
        rem ^= poly << (i - 12);
      }
    }
    return (version << 12) | rem;
  }

  static bool _maskCond(int mask, int r, int c) {
    switch (mask) {
      case 0:
        return (r + c) % 2 == 0;
      case 1:
        return r % 2 == 0;
      case 2:
        return c % 3 == 0;
      case 3:
        return (r + c) % 3 == 0;
      case 4:
        return ((r ~/ 2) + (c ~/ 3)) % 2 == 0;
      case 5:
        return ((r * c) % 2) + ((r * c) % 3) == 0;
      case 6:
        return (((r * c) % 2) + ((r * c) % 3)) % 2 == 0;
      case 7:
        return (((r + c) % 2) + ((r * c) % 3)) % 2 == 0;
      default:
        return false;
    }
  }

  static int _penalty(Uint8List grid, int size) {
    var score = 0;
    for (var r = 0; r < size; r++) {
      var run = 1;
      for (var c = 1; c < size; c++) {
        if (grid[r * size + c] == grid[r * size + c - 1]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (var c = 0; c < size; c++) {
      var run = 1;
      for (var r = 1; r < size; r++) {
        if (grid[r * size + c] == grid[(r - 1) * size + c]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (var r = 0; r < size - 1; r++) {
      for (var c = 0; c < size - 1; c++) {
        final v = grid[r * size + c];
        if (v == grid[r * size + c + 1] &&
            v == grid[(r + 1) * size + c] &&
            v == grid[(r + 1) * size + c + 1]) {
          score += 3;
        }
      }
    }
    var dark = 0;
    for (var i = 0; i < grid.length; i++) {
      dark += grid[i];
    }
    final pct = (dark * 100) / grid.length;
    score += ((pct - 50).abs() ~/ 5) * 10;
    return score;
  }

  static QrMatrix encode(String text) {
    final bytes = Uint8List.fromList(utf8.encode(text));
    final spec = _selectSpec(bytes.length);
    final size = spec.version * 4 + 17;
    final base = Uint8List(size * size);
    final isFunc = Uint8List(size * size);

    void setFunc(int r, int c, bool dark) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      base[r * size + c] = dark ? 1 : 0;
      isFunc[r * size + c] = 1;
    }

    void drawFinder(int top, int left) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          final r = top + dr;
          final c = left + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          final inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          final dark = inOuter &&
              (dr == 0 ||
                  dr == 6 ||
                  dc == 0 ||
                  dc == 6 ||
                  (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setFunc(r, c, dark);
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (var i = 8; i < size - 8; i++) {
      final dark = i % 2 == 0;
      setFunc(6, i, dark);
      setFunc(i, 6, dark);
    }

    final aligns = spec.alignments;
    for (var i = 0; i < aligns.length; i++) {
      for (var j = 0; j < aligns.length; j++) {
        if ((i == 0 && j == 0) ||
            (i == 0 && j == aligns.length - 1) ||
            (i == aligns.length - 1 && j == 0)) {
          continue;
        }
        final cr = aligns[i];
        final cc = aligns[j];
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            final dark = (dr.abs() > dc.abs() ? dr.abs() : dc.abs()) != 1;
            setFunc(cr + dr, cc + dc, dark);
          }
        }
      }
    }

    for (var i = 0; i <= 8; i++) {
      if (i != 6) {
        setFunc(8, i, false);
        setFunc(i, 8, false);
      }
    }
    for (var i = 0; i < 8; i++) {
      setFunc(8, size - 1 - i, false);
      setFunc(size - 1 - i, 8, false);
    }
    setFunc(size - 8, 8, true);

    if (spec.version >= 7) {
      final vBits = _versionBits(spec.version);
      for (var i = 0; i < 18; i++) {
        final bit = ((vBits >> i) & 1) == 1;
        final a = i ~/ 3;
        final b = size - 11 + (i % 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    final dataCap = spec.totalDataCodewords;
    final bits = <int>[];
    void pushBits(int val, int len) {
      for (var i = len - 1; i >= 0; i--) {
        bits.add((val >> i) & 1);
      }
    }

    pushBits(0x04, 4);
    pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
    for (final b in bytes) {
      pushBits(b, 8);
    }
    final capBits = dataCap * 8;
    final termLen = (capBits - bits.length).clamp(0, 4);
    pushBits(0, termLen);
    while (bits.length % 8 != 0) {
      bits.add(0);
    }
    final data = Uint8List(dataCap);
    final byteCount = bits.length ~/ 8;
    for (var i = 0; i < byteCount; i++) {
      var v = 0;
      for (var b = 0; b < 8; b++) {
        v = (v << 1) | bits[i * 8 + b];
      }
      data[i] = v;
    }
    var padIdx = 0;
    for (var i = byteCount; i < dataCap; i++) {
      data[i] = padIdx % 2 == 0 ? 0xec : 0x11;
      padIdx++;
    }

    final dataBlocks = <Uint8List>[];
    final ecBlocks = <Uint8List>[];
    var offset = 0;
    for (final (count, len) in spec.blocks) {
      for (var i = 0; i < count; i++) {
        final slice = Uint8List.sublistView(data, offset, offset + len);
        offset += len;
        dataBlocks.add(slice);
        ecBlocks.add(_rsEc(slice, spec.ecPerBlock));
      }
    }
    final all = Uint8List(spec.totalCodewords);
    var idx = 0;
    var maxDataLen = 0;
    for (final b in dataBlocks) {
      if (b.length > maxDataLen) maxDataLen = b.length;
    }
    for (var i = 0; i < maxDataLen; i++) {
      for (final b in dataBlocks) {
        if (i < b.length) all[idx++] = b[i];
      }
    }
    for (var i = 0; i < spec.ecPerBlock; i++) {
      for (final ec in ecBlocks) {
        all[idx++] = ec[i];
      }
    }

    var bitIdx = 0;
    final totalBits = all.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      final upward = ((right + 1) & 2) == 0;
      for (var vert = 0; vert < size; vert++) {
        final r = upward ? size - 1 - vert : vert;
        for (var j = 0; j < 2; j++) {
          final c = right - j;
          if (isFunc[r * size + c] != 0) continue;
          var bit = 0;
          if (bitIdx < totalBits) {
            bit = (all[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          base[r * size + c] = bit;
        }
      }
    }

    var bestGrid = base;
    var bestScore = 1 << 30;
    const ecLevelLBits = 0x01;
    for (var mask = 0; mask < 8; mask++) {
      final cand = Uint8List.fromList(base);
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (isFunc[r * size + c] == 0 && _maskCond(mask, r, c)) {
            cand[r * size + c] ^= 1;
          }
        }
      }
      final fmt = _formatBits(ecLevelLBits, mask);
      void putFmt(int r, int c, int pos) {
        cand[r * size + c] = (fmt >> pos) & 1;
      }

      for (var i = 0; i <= 5; i++) {
        putFmt(8, i, 14 - i);
      }
      putFmt(8, 7, 8);
      putFmt(8, 8, 7);
      putFmt(7, 8, 6);
      for (var i = 0; i <= 5; i++) {
        putFmt(5 - i, 8, 5 - i);
      }
      for (var i = 0; i <= 6; i++) {
        putFmt(size - 1 - i, 8, 14 - i);
      }
      for (var i = 0; i <= 7; i++) {
        putFmt(8, size - 8 + i, 7 - i);
      }

      final score = _penalty(cand, size);
      if (score < bestScore) {
        bestScore = score;
        bestGrid = cand;
      }
    }

    return QrMatrix(version: spec.version, size: size, modules: bestGrid);
  }
}

class _QrVersionSpec {
  const _QrVersionSpec(
    this.version,
    this.totalCodewords,
    this.ecPerBlock,
    this.blocks,
    this.alignments,
  );

  final int version;
  final int totalCodewords;
  final int ecPerBlock;
  final List<(int, int)> blocks;
  final List<int> alignments;

  int get totalDataCodewords {
    var sum = 0;
    for (final (count, len) in blocks) {
      sum += count * len;
    }
    return sum;
  }
}

/// 高对比度二维码展示组件（白底深码 + 标准静区，便于手机摄像头快速识别）。
class QrCodeView extends StatelessWidget {
  const QrCodeView({
    super.key,
    required this.data,
    this.size = 200,
    this.quietZoneModules = 3,
  });

  final String data;
  final double size;
  final int quietZoneModules;

  @override
  Widget build(BuildContext context) {
    final matrix = QrMatrix.encode(data);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
      ),
      clipBehavior: Clip.antiAlias,
      child: CustomPaint(
        size: Size.square(size),
        painter: _QrPainter(matrix: matrix, quietZone: quietZoneModules),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter({required this.matrix, required this.quietZone});

  final QrMatrix matrix;
  final int quietZone;

  @override
  void paint(Canvas canvas, Size size) {
    final bgPaint = Paint()..color = Colors.white;
    canvas.drawRect(Offset.zero & size, bgPaint);

    final total = matrix.size + quietZone * 2;
    final moduleSize = size.shortestSide / total;
    final darkPaint = Paint()
      ..color = const Color(0xFF141414)
      ..isAntiAlias = false;

    for (var r = 0; r < matrix.size; r++) {
      for (var c = 0; c < matrix.size; c++) {
        if (!matrix.isDark(r, c)) continue;
        final rect = Rect.fromLTWH(
          (c + quietZone) * moduleSize,
          (r + quietZone) * moduleSize,
          moduleSize + 0.25,
          moduleSize + 0.25,
        );
        canvas.drawRect(rect, darkPaint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _QrPainter oldDelegate) =>
      oldDelegate.matrix != matrix || oldDelegate.quietZone != quietZone;
}
