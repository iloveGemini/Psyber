import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// 极克制的无字纯纸面微颗粒层：
/// 仅使用 256x256 高频单像素均匀微粒（绝不加低频云絮斑块或粗纤维暗斑，避免画面显脏），
/// 配合四周极轻的页边柔光过渡，去掉纯色数码塑料感的同时保持阅读面干净通透。
class PaperGrainOverlay extends StatefulWidget {
  const PaperGrainOverlay({
    super.key = const Key('paper_grain_overlay'),
    required this.isDark,
    this.edgeTint,
  });

  final bool isDark;
  final Color? edgeTint;

  @override
  State<PaperGrainOverlay> createState() => _PaperGrainOverlayState();
}

class _PaperGrainOverlayState extends State<PaperGrainOverlay> {
  static ui.Image? _lightGrainImage;
  static ui.Image? _darkGrainImage;
  static Future<void>? _loadingFuture;

  ui.Image? get _activeImage => widget.isDark ? _darkGrainImage : _lightGrainImage;

  @override
  void initState() {
    super.initState();
    _ensureTexturesLoaded();
  }

  @override
  void didUpdateWidget(covariant PaperGrainOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_activeImage == null) {
      _ensureTexturesLoaded();
    }
  }

  void _ensureTexturesLoaded() {
    if (_lightGrainImage != null && _darkGrainImage != null) return;
    _loadingFuture ??= _generateBothTiles().then((_) {
      if (mounted) {
        setState(() {});
      }
    }).catchError((_) {
      // 测试或受限渲染环境降级为静态边缘渐变，不阻塞页面绘制
    });
  }

  static Future<void> _generateBothTiles() async {
    final light = await _buildSeamlessGrainImage(isDark: false);
    final dark = await _buildSeamlessGrainImage(isDark: true);
    _lightGrainImage = light;
    _darkGrainImage = dark;
  }

  static Future<ui.Image> _buildSeamlessGrainImage({required bool isDark}) {
    const size = 256;
    final pixels = Uint8List(size * size * 4);

    double hash2d(int x, int y, int seed) {
      var h = x * 374761393 + y * 668265263 + seed * 1442695041;
      h = (h ^ (h >> 13)) * 1274126177;
      h = h ^ (h >> 16);
      return ((h & 0xFFFF) / 32767.5) - 1.0;
    }

    final seed = isDark ? 20261123 : 20261122;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        // 两个独立高频随机求和构成柔和的三角分布单像素颗粒，避免粗糙斑块和重复感
        final n1 = hash2d(x, y, seed);
        final n2 = hash2d(x, y, seed + 17);
        final signal = ((n1 + n2) * 0.5).clamp(-1.0, 1.0);

        final offset = (y * size + x) * 4;
        if (signal >= 0) {
          // 亮部微粒（PixelFormat.rgba8888 预乘 alpha：RGB 必须等于 alpha）
          final alpha = (signal * (isDark ? 7.0 : 8.0)).round().clamp(0, 255);
          pixels[offset] = alpha;
          pixels[offset + 1] = alpha;
          pixels[offset + 2] = alpha;
          pixels[offset + 3] = alpha;
        } else {
          // 暗部微粒（预乘 RGB 恒为 0）
          final alpha = ((-signal) * (isDark ? 9.0 : 6.0)).round().clamp(0, 255);
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
          pixels[offset + 3] = alpha;
        }
      }
    }

    final completer = Completer<ui.Image>();
    ui.decodeImageFromPixels(
      pixels,
      size,
      size,
      ui.PixelFormat.rgba8888,
      completer.complete,
    );
    return completer.future;
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: RepaintBoundary(
        child: CustomPaint(
          painter: _PaperGrainPainter(
            image: _activeImage,
            edgeTint: widget.edgeTint,
          ),
          child: const SizedBox.expand(),
        ),
      ),
    );
  }
}

class _PaperGrainPainter extends CustomPainter {
  _PaperGrainPainter({
    required this.image,
    required this.edgeTint,
  });

  final ui.Image? image;
  final Color? edgeTint;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final rect = Offset.zero & size;

    if (image != null) {
      final shaderPaint = Paint()
        ..shader = ui.ImageShader(
          image!,
          TileMode.repeated,
          TileMode.repeated,
          Matrix4.identity().storage,
        );
      canvas.drawRect(rect, shaderPaint);
    }

    if (edgeTint != null && edgeTint!.a > 0) {
      final vignettePaint = Paint()
        ..shader = RadialGradient(
          center: Alignment.center,
          radius: 1.08,
          colors: <Color>[
            edgeTint!.withValues(alpha: 0.0),
            edgeTint!.withValues(alpha: edgeTint!.a * 0.4),
            edgeTint!,
          ],
          stops: const <double>[0.52, 0.84, 1.0],
        ).createShader(rect);
      canvas.drawRect(rect, vignettePaint);
    }
  }

  @override
  bool shouldRepaint(covariant _PaperGrainPainter oldDelegate) {
    return oldDelegate.image != image || oldDelegate.edgeTint != edgeTint;
  }
}
