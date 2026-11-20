import 'package:flutter/material.dart';

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

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: colors.mineralCanvas,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: const Key('thinking_toggle'),
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 15,
                    color: colors.inkQuiet,
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
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: SelectableText(
                widget.thinking,
                key: const Key('thinking_body'),
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.5,
                  color: PsyberTheme.inkQuiet,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
