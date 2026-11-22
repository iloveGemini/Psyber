import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

String _failureLabel(String code) {
  switch (code) {
    case 'AUTH_EXPIRED':
      return '访问凭证已过期或无效';
    case 'RATE_LIMITED':
      return '请求过于频繁，暂时限流';
    case 'CONTEXT_OVERFLOW':
      return '本轮输入超出上下文长度';
    case 'PROVIDER_ERROR':
      return '模型服务暂时没有响应';
    default:
      return '上一轮连接中断';
  }
}

String _failureSuggestion(String code) {
  switch (code) {
    case 'AUTH_EXPIRED':
      return '请打开左下角「偏好与设置 → 模型与用量」，检查 API Key 或服务商配置是否正确；保存后可直接点上方「重试」。';
    case 'RATE_LIMITED':
      return '模型服务当前限流了，稍等几秒再点「重试」即可继续，不需要重发一遍刚才的话。';
    case 'CONTEXT_OVERFLOW':
      return '可在左侧档案栏底部点一次「存记忆换段」开启新段，或精简刚才较长的附件后再试。';
    case 'PROVIDER_ERROR':
      return '可能是网络波动或模型网关临时超时；点「重试」会沿用你刚才那句话原地续跑，不会出现重复消息。';
    default:
      return '点「重试」可沿用刚才的话原地恢复，不会重复发送消息。';
  }
}

bool _opensByDefault(TurnFailureState failure) {
  return failure.code == 'AUTH_EXPIRED' || !failure.retryable;
}

/// 系统故障中断内联卡片（Spec 04 §5.4）：
/// 与 SilenceLine 严格区分——带警示图标、病因人话、可展开建议/原文以及原地无痕「重试」按钮。
class FailureLine extends StatefulWidget {
  const FailureLine({
    super.key,
    required this.failure,
    required this.retrying,
    required this.onRetry,
    required this.onDismiss,
  });

  final TurnFailureState failure;
  final bool retrying;
  final Future<void> Function() onRetry;
  final VoidCallback onDismiss;

  @override
  State<FailureLine> createState() => _FailureLineState();
}

class _FailureLineState extends State<FailureLine> {
  late bool _expanded;

  @override
  void initState() {
    super.initState();
    _expanded = _opensByDefault(widget.failure);
  }

  @override
  void didUpdateWidget(covariant FailureLine oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.failure.turnId != widget.failure.turnId ||
        oldWidget.failure.code != widget.failure.code) {
      _expanded = _opensByDefault(widget.failure);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final failure = widget.failure;
    final canRetry = failure.turnId != null && failure.turnId!.isNotEmpty;

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: Container(
          key: const Key('failure_line'),
          margin: const EdgeInsets.symmetric(vertical: 8),
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          decoration: BoxDecoration(
            color: colors.dangerSoft.withValues(alpha: 0.65),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: colors.dangerInk.withValues(alpha: 0.35),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    PhosphorIconsLight.warning,
                    size: 16,
                    color: colors.dangerInk,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: InkWell(
                      borderRadius: BorderRadius.circular(6),
                      onTap: () => setState(() => _expanded = !_expanded),
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              '上一轮中断 · ${_failureLabel(failure.code)}',
                              style: TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w500,
                                color: colors.inkDeep,
                              ),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Icon(
                            _expanded
                                ? PhosphorIconsLight.caretUp
                                : PhosphorIconsLight.caretDown,
                            size: 13,
                            color: colors.inkQuiet,
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (canRetry)
                    TextButton(
                      key: const Key('retry_failed_turn_button'),
                      onPressed: widget.retrying
                          ? null
                          : () => unawaited(widget.onRetry()),
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        foregroundColor: colors.inkDeep,
                      ),
                      child: Text(
                        widget.retrying ? '再来一次…' : '重试',
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  IconButton(
                    icon: Icon(
                      PhosphorIconsLight.x,
                      size: 14,
                      color: colors.inkQuiet,
                    ),
                    padding: const EdgeInsets.all(4),
                    constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                    tooltip: '收起提示',
                    onPressed: widget.onDismiss,
                  ),
                ],
              ),
              if (_expanded) ...[
                const SizedBox(height: 6),
                Container(
                  margin: const EdgeInsets.only(left: 6),
                  padding: const EdgeInsets.only(left: 10),
                  decoration: BoxDecoration(
                    border: Border(
                      left: BorderSide(
                        color: colors.dangerInk.withValues(alpha: 0.4),
                        width: 2,
                      ),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _failureSuggestion(failure.code),
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.45,
                          color: colors.inkQuiet,
                        ),
                      ),
                      if (failure.message.trim().isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: colors.letterSurface,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: colors.hairline),
                          ),
                          child: SelectableText(
                            failure.message,
                            style: PsyberTheme.monoStyle.copyWith(
                              fontSize: 11,
                              height: 1.4,
                              color: colors.inkQuiet,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
