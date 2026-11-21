import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// 随手短视频帧播渲染卡（Spec 04 §5.4）：
/// 播放由前端提取的短视频关键帧并标示时长，兼容普通视觉模型与无原生视频依赖。
class VideoTile extends StatefulWidget {
  const VideoTile({
    super.key,
    required this.videoClip,
    required this.profile,
  });

  final VideoClipInfo videoClip;
  final ConnectionProfile profile;

  @override
  State<VideoTile> createState() => _VideoTileState();
}

class _VideoTileState extends State<VideoTile> {
  Timer? _timer;
  bool _playing = false;
  int _frameIndex = 0;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _togglePlay() {
    final total = widget.videoClip.frameHashes.length;
    if (total <= 1) return;
    if (_playing) {
      _timer?.cancel();
      _timer = null;
      setState(() => _playing = false);
      return;
    }
    setState(() {
      _playing = true;
      _frameIndex = 0;
    });
    final intervalMs =
        ((widget.videoClip.durationSec * 1000) / total).round().clamp(350, 900);
    _timer = Timer.periodic(Duration(milliseconds: intervalMs), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        if (_frameIndex >= total - 1) {
          _playing = false;
          _frameIndex = 0;
          timer.cancel();
          _timer = null;
        } else {
          _frameIndex += 1;
        }
      });
    });
  }

  String _formatDuration(double sec) {
    final s = sec.round().clamp(0, 3600);
    final mm = (s ~/ 60).toString();
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$mm:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final hashes = widget.videoClip.frameHashes;
    if (hashes.isEmpty) return const SizedBox.shrink();
    final activeHash = hashes[_frameIndex.clamp(0, hashes.length - 1)];
    final colors = context.colors;

    return GestureDetector(
      key: const Key('video_tile_card'),
      onTap: _togglePlay,
      child: Container(
        width: 240,
        height: 160,
        decoration: BoxDecoration(
          color: Colors.black87,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: colors.hairline),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.network(
              widget.profile.resolveMediaUrl('/api/v1/media/$activeHash'),
              headers: {'Authorization': 'Bearer ${widget.profile.token}'},
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => const Center(
                child: Icon(
                  PhosphorIconsLight.filmStrip,
                  size: 28,
                  color: Colors.white70,
                ),
              ),
            ),
            if (!_playing)
              Center(
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: const BoxDecoration(
                    color: Colors.black54,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    PhosphorIconsLight.play,
                    color: Colors.white,
                    size: 22,
                  ),
                ),
              ),
            Positioned(
              left: 8,
              top: 8,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: Colors.black54,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  '${_frameIndex + 1}/${hashes.length} 帧',
                  style: const TextStyle(fontSize: 10.5, color: Colors.white),
                ),
              ),
            ),
            Positioned(
              right: 8,
              bottom: 8,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: Colors.black54,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  _formatDuration(widget.videoClip.durationSec),
                  style: const TextStyle(fontSize: 11, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
