import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../shared/theme.dart';

/// 扩展思考折叠卡（Spec 04 §5.4）：
/// 默认折叠为一行「思考过程」，流式阶段支持展开实时阅读，结束后自动收起不占主阅读流。
class ThinkingCard extends StatefulWidget {
  const ThinkingCard({
    super.key,
    required this.thinking,
    this.isStreaming = false,
  });

  final String thinking;
  final bool isStreaming;

  @override
  State<ThinkingCard> createState() => _ThinkingCardState();
}

class _ThinkingCardState extends State<ThinkingCard> {
  bool _expanded = false;

  @override
  void didUpdateWidget(covariant ThinkingCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isStreaming && !widget.isStreaming && _expanded) {
      _expanded = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.thinking.trim().isEmpty) {
      return const SizedBox.shrink();
    }
    final colors = context.colors;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: const Key('thinking_toggle'),
            borderRadius: BorderRadius.circular(6),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _expanded ? PhosphorIconsLight.caretUp : PhosphorIconsLight.caretDown,
                    size: 13,
                    color: colors.inkFaint,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    widget.isStreaming ? '思考中…' : '思考过程',
                    style: TextStyle(
                      fontSize: 12,
                      color: colors.inkQuiet,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Container(
              margin: const EdgeInsets.only(top: 4, left: 4),
              padding: const EdgeInsets.only(left: 10, top: 2, bottom: 2),
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(color: colors.hairline, width: 2),
                ),
              ),
              child: SelectableText(
                widget.thinking,
                key: const Key('thinking_body'),
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.55,
                  color: colors.inkQuiet,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
