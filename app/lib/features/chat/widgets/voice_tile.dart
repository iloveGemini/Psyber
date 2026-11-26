import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/media/voice_bridge.dart';
import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// 异步语音条回放组件（内嵌于消息气泡顶部，配波形进度条与时长）。
class VoiceTile extends StatefulWidget {
  const VoiceTile({
    super.key,
    required this.voiceClip,
    required this.profile,
    required this.foregroundColor,
    this.bridge,
  });

  final VoiceClipInfo voiceClip;
  final ConnectionProfile profile;
  final Color foregroundColor;
  final VoiceBridge? bridge;

  @override
  State<VoiceTile> createState() => _VoiceTileState();
}

class _VoiceTileState extends State<VoiceTile> {
  static const List<double> _barHeights = <double>[
    0.35, 0.62, 0.45, 0.85, 0.58, 0.95, 0.48, 0.76,
    0.42, 0.88, 0.64, 0.52, 0.78, 0.40, 0.68, 0.46,
  ];

  bool _loading = false;

  VoiceBridge get _bridge => widget.bridge ?? NativeVoiceBridge.instance;

  String _formatDuration(double sec) {
    final s = sec.round().clamp(1, 3600);
    final mm = s ~/ 60;
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$mm:$ss';
  }

  Future<void> _togglePlay(bool isCurrentlyPlaying) async {
    if (_loading) return;
    if (isCurrentlyPlaying) {
      await _bridge.stopAudio();
      return;
    }
    if (!_bridge.isSupported) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(
            content: Text('当前平台暂不支持语音条回放'),
            duration: Duration(seconds: 2),
          ),
        );
      return;
    }
    setState(() => _loading = true);
    try {
      final url = widget.profile.resolveMediaUrl(
        '/api/v1/media/${widget.voiceClip.mediaHash}',
      );
      await _bridge.playAudio(
        id: widget.voiceClip.mediaHash,
        url: url,
        token: widget.profile.token,
      );
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(
            const SnackBar(
              content: Text('语音播放失败，请检查网络连接'),
              duration: Duration(seconds: 2),
            ),
          );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final fg = widget.foregroundColor;
    final hash = widget.voiceClip.mediaHash;
    return ValueListenableBuilder<VoicePlaybackState?>(
      valueListenable: _bridge.playbackNotifier,
      builder: (context, playback, _) {
        final isPlaying = playback != null && playback.id == hash && playback.playing;
        final totalSec = (isPlaying && playback.durationSec > 0)
            ? playback.durationSec
            : widget.voiceClip.durationSec;
        final progress = (isPlaying && totalSec > 0)
            ? (playback.positionSec / totalSec).clamp(0.0, 1.0)
            : 0.0;
        final displaySec = isPlaying
            ? (totalSec - playback.positionSec).clamp(0.0, totalSec)
            : widget.voiceClip.durationSec;

        return InkWell(
          key: Key('voice_tile_$hash'),
          borderRadius: BorderRadius.circular(10),
          onTap: () => unawaited(_togglePlay(isPlaying)),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: fg.withValues(alpha: 0.16),
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: _loading
                      ? SizedBox(
                          width: 13,
                          height: 13,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.8,
                            color: fg,
                          ),
                        )
                      : Icon(
                          isPlaying
                              ? PhosphorIconsFill.pause
                              : PhosphorIconsFill.play,
                          size: 13,
                          color: fg,
                        ),
                ),
                const SizedBox(width: 10),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    for (var i = 0; i < _barHeights.length; i++)
                      Container(
                        width: 2.5,
                        height: 6 + _barHeights[i] * 14,
                        margin: const EdgeInsets.symmetric(horizontal: 1.4),
                        decoration: BoxDecoration(
                          color: isPlaying &&
                                  (i / _barHeights.length) <= progress
                              ? fg
                              : fg.withValues(alpha: isPlaying ? 0.32 : 0.55),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                  ],
                ),
                const SizedBox(width: 10),
                Text(
                  _formatDuration(displaySec),
                  style: PsyberTheme.monoStyle.copyWith(
                    fontSize: 12,
                    color: fg.withValues(alpha: 0.88),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
