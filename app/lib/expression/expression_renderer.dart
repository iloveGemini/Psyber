import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models/models.dart';

/// 按 Spec 04 §5.3 触发平台原生触觉反馈（在不支持的桌面/测试环境安全空操作）。
Future<void> triggerExpressionHaptic(String? haptic) async {
  if (haptic == null || haptic.isEmpty) return;
  try {
    switch (haptic) {
      case 'light':
        await HapticFeedback.lightImpact();
      case 'medium':
        await HapticFeedback.mediumImpact();
      case 'double':
        await HapticFeedback.lightImpact();
        await Future<void>.delayed(const Duration(milliseconds: 90));
        await HapticFeedback.lightImpact();
      case 'heartbeat':
        await HapticFeedback.lightImpact();
        await Future<void>.delayed(const Duration(milliseconds: 140));
        await HapticFeedback.mediumImpact();
    }
  } catch (_) {
    // 桌面或无障碍测试环境下忽略触觉通道异常
  }
}

Color atmosphereColorForTone(String tone) {
  switch (tone) {
    case 'warm':
      return const Color(0xFFD99457);
    case 'cool':
      return const Color(0xFF6B93B5);
    case 'dim':
      return const Color(0xFF3E3B39);
    case 'bright':
      return const Color(0xFFE7C873);
    case 'neutral':
    default:
      return Colors.transparent;
  }
}

double atmosphereOpacityForIntensity(String intensity) {
  return intensity == 'noticeable' ? 0.14 : 0.06;
}

/// 聊天背景纸感画布色温叠加层：600ms 缓入、按 durationSec 到期后 1200ms 缓出。
class AtmosphereOverlay extends StatefulWidget {
  const AtmosphereOverlay({
    super.key,
    required this.atmosphere,
    required this.child,
  });

  final AtmosphereSpec? atmosphere;
  final Widget child;

  @override
  State<AtmosphereOverlay> createState() => _AtmosphereOverlayState();
}

class _AtmosphereOverlayState extends State<AtmosphereOverlay> {
  AtmosphereSpec? _active;
  bool _fadingOut = false;
  Timer? _expireTimer;

  @override
  void initState() {
    super.initState();
    _apply(widget.atmosphere);
  }

  @override
  void didUpdateWidget(covariant AtmosphereOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.atmosphere != oldWidget.atmosphere) {
      _apply(widget.atmosphere);
    }
  }

  void _apply(AtmosphereSpec? spec) {
    _expireTimer?.cancel();
    if (spec == null || spec.tone == 'neutral') {
      _active = null;
      _fadingOut = true;
      return;
    }
    _active = spec;
    _fadingOut = false;
    _expireTimer = Timer(Duration(seconds: spec.durationSec), () {
      if (!mounted) return;
      setState(() {
        _fadingOut = true;
      });
    });
  }

  @override
  void dispose() {
    _expireTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final spec = _active;
    final tint = spec == null ? Colors.transparent : atmosphereColorForTone(spec.tone);
    final opacity =
        spec == null || _fadingOut ? 0.0 : atmosphereOpacityForIntensity(spec.intensity);
    final duration = _fadingOut
        ? const Duration(milliseconds: 1200)
        : const Duration(milliseconds: 600);

    return Stack(
      children: [
        widget.child,
        Positioned.fill(
          child: IgnorePointer(
            child: AnimatedContainer(
              key: const Key('atmosphere_tint_layer'),
              duration: duration,
              curve: Curves.easeInOut,
              color: tint.withValues(alpha: opacity),
            ),
          ),
        ),
      ],
    );
  }
}

/// 当轮助手气泡的单次克制微动效（shake / breathe / hesitate / nod，≤ 650ms）。
/// 系统开启“减少动态效果”时自动降级为静态渲染。
class MotionBubbleWrapper extends StatefulWidget {
  const MotionBubbleWrapper({
    super.key,
    required this.motion,
    required this.child,
    this.active = true,
    this.onStarted,
  });

  final String? motion;
  final Widget child;
  final bool active;
  final VoidCallback? onStarted;

  @override
  State<MotionBubbleWrapper> createState() => _MotionBubbleWrapperState();
}

class _MotionBubbleWrapperState extends State<MotionBubbleWrapper>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _hasTriggered = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 620),
    );
    if (widget.motion != null && widget.active) {
      _trigger();
    }
  }

  @override
  void didUpdateWidget(covariant MotionBubbleWrapper oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.motion == null) {
      _hasTriggered = false;
      return;
    }
    if (widget.motion != oldWidget.motion) {
      _hasTriggered = false;
    }
    if (widget.active && !_hasTriggered) {
      _trigger();
    }
  }

  void _trigger() {
    _hasTriggered = true;
    widget.onStarted?.call();
    unawaited(_controller.forward(from: 0));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final motion = widget.motion;
    if (motion == null || reduceMotion) {
      return widget.child;
    }

    return AnimatedBuilder(
      animation: _controller,
      child: widget.child,
      builder: (context, child) {
        final t = _controller.value;
        switch (motion) {
          case 'shake':
            final dx = math.sin(t * math.pi * 5) * 9.0 * (1 - t);
            return Transform.translate(offset: Offset(dx, 0), child: child);
          case 'nod':
            final dy = math.sin(t * math.pi * 4) * 6.5 * (1 - t);
            return Transform.translate(offset: Offset(0, dy), child: child);
          case 'breathe':
            final scale = 1.0 + math.sin(t * math.pi) * 0.04;
            return Transform.scale(scale: scale, child: child);
          case 'hesitate':
            final opacity = 0.58 + 0.42 * t;
            return Opacity(opacity: opacity, child: child);
          default:
            return child ?? const SizedBox.shrink();
        }
      },
    );
  }
}
