import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/rich_message_text.dart';
import '../../../shared/theme.dart';

/// Psyber 主动递出的暖黄折叠分享卡（ShareCard）：
/// - 默认只显示标题与「点开看」，划过去不算看过；
/// - 只有用户真的点击展开时，才触发一次拆阅回执（onOpen），让“分享”与“拆阅”成为完整的双向关系动作。
class ShareCard extends StatefulWidget {
  const ShareCard({
    super.key,
    required this.share,
    required this.onOpen,
  });

  final ShareCardItem share;
  final Future<void> Function(String shareId) onOpen;

  @override
  State<ShareCard> createState() => _ShareCardState();
}

class _ShareCardState extends State<ShareCard> {
  bool _open = false;
  bool _told = false;

  void _toggle() {
    final next = !_open;
    setState(() => _open = next);
    if (next && !_told && !widget.share.isOpened) {
      _told = true;
      unawaited(widget.onOpen(widget.share.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final share = widget.share;
    final badgeLabel = _open
        ? '收起'
        : (share.isOpened || _told ? '已拆阅 · 点开看' : '分享 · 点开看');

    return Container(
      key: Key('share_card_${share.id}'),
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: colors.slipPaper,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colors.hairlineWarm),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            key: Key('share_card_toggle_${share.id}'),
            onTap: _toggle,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              child: Row(
                children: [
                  Icon(
                    _open
                        ? PhosphorIconsLight.envelopeSimpleOpen
                        : PhosphorIconsLight.envelopeSimple,
                    size: 16,
                    color: colors.thresholdAmber,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      share.title,
                      style: PsyberTheme.editorialSerif.copyWith(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: colors.inkDeep,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: colors.thresholdAmberSoft,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      badgeLabel,
                      style: TextStyle(
                        fontSize: 10.5,
                        color: colors.thresholdAmber,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_open) ...[
            Divider(height: 1, color: colors.hairlineWarm),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  RichMessageText(
                    text: share.content,
                    baseStyle: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 14.5,
                      height: 1.68,
                      color: colors.inkDeep,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      '—— 留给你看',
                      style: PsyberTheme.editorialSerif.copyWith(
                        fontSize: 11.5,
                        color: colors.inkQuiet,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
