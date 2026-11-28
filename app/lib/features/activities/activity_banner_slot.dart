import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// Ring 1.5 活动伴看扩展渲染槽（ActivityPlugin UI Slot）：
/// 仅当服务端存在活跃会话（如观影伴看 cinema）时浮现在门楣下方；日常零占位。
class ActivityBannerSlot extends StatelessWidget {
  const ActivityBannerSlot({
    super.key,
    required this.session,
    required this.profile,
    required this.onEndActivity,
  });

  final ActivitySessionView session;
  final ConnectionProfile? profile;
  final Future<void> Function() onEndActivity;

  String _formatPosition(num? sec) {
    if (sec == null) return '';
    final total = sec.toInt().clamp(0, 864000);
    final m = (total ~/ 60).toString().padLeft(2, '0');
    final s = (total % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final meta = session.metadata;
    final season = meta['season'];
    final episode = meta['episode'];
    final progressText = (meta['progress'] as String?)?.trim();
    final posSec = meta['positionSec'] as num?;
    final playbackState = meta['playbackState'] as String?;
    final isPaused = meta['isPaused'] == true || playbackState == 'paused';
    final bridgeConnected = meta['bridgeConnected'];
    final frameUrl = meta['latestFrameUrl'] as String?;

    final subtitleParts = <String>[];
    if (season != null || episode != null) {
      subtitleParts.add(
        '${season != null ? 'S$season' : ''}${episode != null ? 'E$episode' : ''}',
      );
    }
    if (progressText != null && progressText.isNotEmpty) {
      subtitleParts.add(progressText);
    } else if (posSec != null) {
      subtitleParts.add(_formatPosition(posSec));
    }
    if (isPaused) {
      subtitleParts.add('已暂停');
    }
    if (bridgeConnected == false) {
      subtitleParts.add('采集服务未连');
    }

    return Container(
      key: const Key('activity_banner_slot'),
      decoration: BoxDecoration(
        color: colors.celadonWash,
        border: Border(bottom: BorderSide(color: colors.hairline)),
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 820),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
            child: Row(
              children: [
                if (frameUrl != null && frameUrl.isNotEmpty && profile != null) ...[
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: Image.network(
                      profile!.resolveMediaUrl(frameUrl),
                      headers: {'Authorization': 'Bearer ${profile!.token}'},
                      width: 52,
                      height: 32,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Icon(
                        PhosphorIconsLight.filmStrip,
                        size: 18,
                        color: colors.inkDeep,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                ] else ...[
                  Icon(PhosphorIconsLight.filmStrip, size: 18, color: colors.inkDeep),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        session.title.isEmpty ? '伴看进行中' : '正在一起看：${session.title}',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: colors.inkDeep,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (session.isStale)
                        Text(
                          '暂停有一会儿了，要结束这场观影吗？',
                          style: TextStyle(fontSize: 11.5, color: colors.thresholdAmber),
                        )
                      else if (subtitleParts.isNotEmpty)
                        Text(
                          subtitleParts.join(' · '),
                          style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                        ),
                    ],
                  ),
                ),
                TextButton(
                  key: const Key('end_activity_button'),
                  onPressed: () => unawaited(onEndActivity()),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text('结束伴看', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
