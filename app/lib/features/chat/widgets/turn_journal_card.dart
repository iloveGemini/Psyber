import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/rich_message_text.dart';
import '../../../shared/theme.dart';

/// 模型切换点极淡分隔线（仅在相对上一条助手回复切了模型时呈现）。
class ModelSwitchDivider extends StatelessWidget {
  const ModelSwitchDivider({super.key, required this.model});

  final String model;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final shortName = model.contains('/') ? model.split('/').last : model;
    if (shortName.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      key: Key('model_switch_$shortName'),
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: Text(
          '已切换为 $shortName',
          style: TextStyle(
            fontSize: 11,
            color: colors.inkFaint,
          ),
        ),
      ),
    );
  }
}

/// 同轮「思考 + 多步工具调用」极简摘要行 + 竖向时间线详情层：
/// - 行内仅保留单行摘要（`⏱ 摘要 >`），不撑开主聊天流；
/// - 点击后：移动端拉起圆角 BottomSheet，桌面端弹出轻弹层；
///   - 纯思考（无工具步骤）：直接展开并以 RichMessageText 渲染 Markdown；
///   - 多步思考/工具动作：默认折叠各步思考正文，点击按手风琴模式在固定最大高度（220px）的可滚动划窗中展开；
/// - 隐私敏感工具（look_at_screen）永不收入此卡，由下方 ScreenToolCard 独立展示。
class TurnJournalCard extends StatefulWidget {
  const TurnJournalCard({
    super.key,
    required this.thinking,
    this.progressTools = const <ToolProgressItem>[],
    this.summaryTools = const <ToolSummaryItem>[],
    this.journalSteps = const <TurnJournalStep>[],
    this.isStreaming = false,
  });

  final String thinking;
  final List<ToolProgressItem> progressTools;
  final List<ToolSummaryItem> summaryTools;
  final List<TurnJournalStep> journalSteps;
  final bool isStreaming;

  @override
  State<TurnJournalCard> createState() => _TurnJournalCardState();
}

class _TurnJournalCardState extends State<TurnJournalCard> {
  DateTime? _streamStartedAt;
  int? _elapsedSec;

  @override
  void initState() {
    super.initState();
    if (widget.isStreaming) {
      _streamStartedAt = DateTime.now();
    }
  }

  @override
  void didUpdateWidget(covariant TurnJournalCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!oldWidget.isStreaming && widget.isStreaming) {
      _streamStartedAt = DateTime.now();
      _elapsedSec = null;
    } else if (oldWidget.isStreaming && !widget.isStreaming && _streamStartedAt != null) {
      final secs = DateTime.now().difference(_streamStartedAt!).inSeconds;
      _elapsedSec = secs > 0 ? secs : 1;
    }
  }

  List<_JournalToolStep> _collectAllTools() {
    final steps = <_JournalToolStep>[];
    for (final t in widget.progressTools) {
      if (t.isScreen) continue;
      steps.add(
        _JournalToolStep(
          label: t.label.isNotEmpty ? t.label : t.name,
          status: t.status,
        ),
      );
    }
    if (steps.isEmpty) {
      for (final s in widget.summaryTools) {
        if (s.isScreen) continue;
        steps.add(
          _JournalToolStep(
            label: s.label.isNotEmpty ? s.label : s.name,
            status: s.ok ? 'done' : 'error',
          ),
        );
      }
    }
    return steps;
  }

  List<_RenderedJournalStep> _collectRenderedSteps() {
    if (widget.journalSteps.isNotEmpty) {
      final rendered = <_RenderedJournalStep>[];
      for (final js in widget.journalSteps) {
        final tools = <_JournalToolStep>[];
        for (final t in js.progressTools) {
          if (t.isScreen) continue;
          tools.add(
            _JournalToolStep(
              label: t.label.isNotEmpty ? t.label : t.name,
              status: t.status,
            ),
          );
        }
        if (tools.isEmpty) {
          for (final s in js.summaryTools) {
            if (s.isScreen) continue;
            tools.add(
              _JournalToolStep(
                label: s.label.isNotEmpty ? s.label : s.name,
                status: s.ok ? 'done' : 'error',
              ),
            );
          }
        }
        if (js.thinking.trim().isNotEmpty || tools.isNotEmpty) {
          rendered.add(
            _RenderedJournalStep(
              thinking: js.thinking.trim(),
              tools: tools,
            ),
          );
        }
      }
      if (rendered.isNotEmpty) return rendered;
    }

    final fallbackTools = _collectAllTools();
    if (widget.thinking.trim().isEmpty && fallbackTools.isEmpty) {
      return const <_RenderedJournalStep>[];
    }
    return <_RenderedJournalStep>[
      _RenderedJournalStep(
        thinking: widget.thinking.trim(),
        tools: fallbackTools,
      ),
    ];
  }

  /// 将分步思考与工具调用展平为竖向时间线节点，保持时间先后顺序。
  List<_TimelineNode> _buildTimelineNodes(List<_RenderedJournalStep> steps) {
    final nodes = <_TimelineNode>[];
    for (final step in steps) {
      if (step.thinking.isNotEmpty) {
        if (step.tools.length == 1) {
          final tool = step.tools.first;
          nodes.add(
            _TimelineNode(
              title: tool.label,
              body: step.thinking,
              status: tool.status,
            ),
          );
          continue;
        }
        nodes.add(
          _TimelineNode(
            body: step.thinking,
            status: widget.isStreaming ? 'running' : 'done',
          ),
        );
      }
      for (final tool in step.tools) {
        nodes.add(
          _TimelineNode(
            title: tool.label,
            status: tool.status,
          ),
        );
      }
    }
    return nodes;
  }

  String _inlineSummaryText(List<_JournalToolStep> tools, bool hasThinking) {
    if (widget.isStreaming) {
      final running = tools.where((t) => t.status == 'running').toList(growable: false);
      if (running.isNotEmpty) {
        return '正在${running.last.label}…';
      }
      return hasThinking ? '正在思考…' : '翻看手账…';
    }

    final timePrefix = (_elapsedSec != null && _elapsedSec! > 0)
        ? '思考了 $_elapsedSec 秒'
        : (hasThinking ? '思考过程' : '');

    if (tools.isEmpty) {
      return timePrefix.isNotEmpty ? timePrefix : '思考过程';
    }
    final firstLabel = tools.first.label;
    final toolPart = tools.length == 1 ? firstLabel : '$firstLabel 等 ${tools.length} 步';
    if (timePrefix.isEmpty) return toolPart;
    return '$timePrefix · $toolPart';
  }

  String _sheetTitle(List<_JournalToolStep> tools, bool hasThinking) {
    if (widget.isStreaming) {
      return hasThinking ? '正在思考…' : '执行步骤';
    }
    if (_elapsedSec != null && _elapsedSec! > 0) {
      return '思考了 $_elapsedSec 秒';
    }
    if (hasThinking && tools.isNotEmpty) {
      return '思考与步骤（${tools.length} 步）';
    }
    if (tools.isNotEmpty) {
      return '执行步骤（${tools.length} 步）';
    }
    return '思考过程';
  }

  void _openDetailModal(
    BuildContext context, {
    required String title,
    required List<_TimelineNode> nodes,
  }) {
    final isWide = MediaQuery.sizeOf(context).width >= 720;
    if (isWide) {
      showDialog<void>(
        context: context,
        builder: (dialogCtx) {
          final colors = dialogCtx.colors;
          final maxH = MediaQuery.sizeOf(dialogCtx).height * 0.72;
          return Dialog(
            backgroundColor: colors.letterSurface,
            surfaceTintColor: Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(20),
              side: BorderSide(color: colors.hairline),
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: 540, maxHeight: maxH),
              child: _JournalDetailContent(
                title: title,
                nodes: nodes,
                showDragHandle: false,
                onClose: () => Navigator.of(dialogCtx).pop(),
              ),
            ),
          );
        },
      );
      return;
    }

    final outerColors = context.colors;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: outerColors.letterSurface,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        side: BorderSide(color: outerColors.hairline),
      ),
      builder: (sheetCtx) {
        final maxH = MediaQuery.sizeOf(sheetCtx).height * 0.78;
        return ConstrainedBox(
          constraints: BoxConstraints(maxHeight: maxH),
          child: SafeArea(
            top: false,
            child: _JournalDetailContent(
              title: title,
              nodes: nodes,
              showDragHandle: true,
              onClose: () => Navigator.of(sheetCtx).pop(),
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final renderedSteps = _collectRenderedSteps();
    final allTools = _collectAllTools();
    final hasThinking = renderedSteps.any((s) => s.thinking.isNotEmpty) ||
        widget.thinking.trim().isNotEmpty;
    if (!hasThinking && allTools.isEmpty && renderedSteps.isEmpty) {
      return const SizedBox.shrink();
    }

    final colors = context.colors;
    final nodes = _buildTimelineNodes(renderedSteps);
    final summaryText = _inlineSummaryText(allTools, hasThinking);
    final title = _sheetTitle(allTools, hasThinking);

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        key: const Key('thinking_toggle'),
        borderRadius: BorderRadius.circular(8),
        onTap: () => _openDetailModal(context, title: title, nodes: nodes),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                widget.isStreaming
                    ? PhosphorIconsLight.circleDashed
                    : PhosphorIconsLight.clock,
                size: 14.5,
                color: colors.inkQuiet,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  summaryText,
                  style: TextStyle(
                    fontSize: 13,
                    color: colors.inkQuiet,
                    height: 1.35,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 4),
              Icon(
                PhosphorIconsLight.caretRight,
                size: 13,
                color: colors.inkFaint,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _JournalDetailContent extends StatefulWidget {
  const _JournalDetailContent({
    required this.title,
    required this.nodes,
    required this.showDragHandle,
    required this.onClose,
  });

  final String title;
  final List<_TimelineNode> nodes;
  final bool showDragHandle;
  final VoidCallback onClose;

  @override
  State<_JournalDetailContent> createState() => _JournalDetailContentState();
}

class _JournalDetailContentState extends State<_JournalDetailContent> {
  int? _expandedIndex;

  bool get _isPureThinking =>
      widget.nodes.length == 1 &&
      (widget.nodes.first.title == null || widget.nodes.first.title!.isEmpty) &&
      widget.nodes.first.body != null &&
      widget.nodes.first.body!.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final firstBodyIndex =
        widget.nodes.indexWhere((n) => n.body != null && n.body!.isNotEmpty);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.showDragHandle)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Center(
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: colors.hairline,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ),
        Padding(
          padding: EdgeInsets.fromLTRB(16, widget.showDragHandle ? 12 : 16, 16, 12),
          child: Row(
            children: [
              Material(
                color: colors.mineralCanvas,
                shape: CircleBorder(side: BorderSide(color: colors.hairline)),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: widget.onClose,
                  child: SizedBox(
                    width: 32,
                    height: 32,
                    child: Icon(
                      PhosphorIconsLight.x,
                      size: 15,
                      color: colors.inkDeep,
                    ),
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  widget.title,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w600,
                    color: colors.inkDeep,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 32),
            ],
          ),
        ),
        Divider(height: 1, color: colors.hairline.withValues(alpha: 0.7)),
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
            child: _isPureThinking
                ? RichMessageText(
                    key: const Key('thinking_body'),
                    text: widget.nodes.first.body!,
                    baseStyle: TextStyle(
                      fontSize: 13.5,
                      height: 1.68,
                      color: colors.inkDeep,
                    ),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (var i = 0; i < widget.nodes.length; i++)
                        _TimelineStepRow(
                          node: widget.nodes[i],
                          isLast: i == widget.nodes.length - 1,
                          expanded: _expandedIndex == i,
                          onToggleExpand: () {
                            setState(() {
                              _expandedIndex = (_expandedIndex == i) ? null : i;
                            });
                          },
                          bodyKey: i == firstBodyIndex
                              ? const Key('thinking_body')
                              : Key('thinking_body_$i'),
                        ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }
}

class _TimelineStepRow extends StatelessWidget {
  const _TimelineStepRow({
    required this.node,
    required this.isLast,
    required this.expanded,
    required this.onToggleExpand,
    this.bodyKey,
  });

  final _TimelineNode node;
  final bool isLast;
  final bool expanded;
  final VoidCallback onToggleExpand;
  final Key? bodyKey;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final hasTitle = node.title != null && node.title!.isNotEmpty;
    final hasBody = node.body != null && node.body!.isNotEmpty;
    final dotColor = switch (node.status) {
      'error' => colors.dangerInk,
      'running' => colors.accent,
      _ => colors.inkQuiet,
    };

    return Stack(
      children: [
        if (!isLast)
          Positioned(
            left: 9.25,
            top: 18,
            bottom: 2,
            child: Container(
              width: 1.5,
              color: colors.hairline,
            ),
          ),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 20,
              child: Padding(
                padding: const EdgeInsets.only(top: 7),
                child: Center(
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: dotColor,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(bottom: isLast ? 0 : 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                  if (hasTitle)
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Flexible(
                          child: Text(
                            node.title!,
                            style: TextStyle(
                              fontSize: 14.5,
                              height: 1.45,
                              fontWeight: FontWeight.w500,
                              color: colors.inkDeep,
                            ),
                          ),
                        ),
                        if (node.status == 'running' || node.status == 'error') ...[
                          const SizedBox(width: 6),
                          Text(
                            node.status == 'running' ? '进行中' : '未成',
                            style: TextStyle(
                              fontSize: 11.5,
                              color: node.status == 'error'
                                  ? colors.dangerInk
                                  : colors.inkQuiet,
                            ),
                          ),
                        ],
                      ],
                    ),
                  if (hasBody) ...[
                    if (hasTitle) const SizedBox(height: 4),
                    InkWell(
                      borderRadius: BorderRadius.circular(6),
                      onTap: onToggleExpand,
                      child: Padding(
                        padding: hasTitle
                            ? const EdgeInsets.symmetric(vertical: 2)
                            : EdgeInsets.zero,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              expanded
                                  ? '收起思考'
                                  : (hasTitle ? '查看思考' : '思考片段'),
                              style: hasTitle
                                  ? TextStyle(
                                      fontSize: 12.5,
                                      color: colors.inkQuiet,
                                      fontWeight: FontWeight.w500,
                                    )
                                  : TextStyle(
                                      fontSize: 14.5,
                                      height: 1.45,
                                      fontWeight: FontWeight.w500,
                                      color: colors.inkDeep,
                                    ),
                            ),
                            SizedBox(width: hasTitle ? 3 : 5),
                            Icon(
                              expanded
                                  ? PhosphorIconsLight.caretUp
                                  : PhosphorIconsLight.caretDown,
                              size: hasTitle ? 12.5 : 14,
                              color: hasTitle ? colors.inkFaint : colors.inkQuiet,
                            ),
                          ],
                        ),
                      ),
                    ),
                    AnimatedSize(
                      duration: const Duration(milliseconds: 160),
                      curve: Curves.easeOutCubic,
                      alignment: Alignment.topCenter,
                      child: expanded
                          ? Container(
                              key: bodyKey,
                              width: double.infinity,
                              margin: const EdgeInsets.only(top: 6),
                              constraints: const BoxConstraints(maxHeight: 220),
                              decoration: BoxDecoration(
                                color: colors.mineralCanvas,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(
                                  color: colors.hairline.withValues(alpha: 0.85),
                                ),
                              ),
                              child: SingleChildScrollView(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                  vertical: 10,
                                ),
                                child: RichMessageText(
                                  text: node.body!,
                                  baseStyle: TextStyle(
                                    fontSize: 13,
                                    height: 1.62,
                                    color: colors.inkDeep,
                                  ),
                                ),
                              ),
                            )
                          : const SizedBox.shrink(),
                    ),
                  ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      );
  }
}

class _TimelineNode {
  const _TimelineNode({
    this.title,
    this.body,
    this.status = 'done',
  });

  final String? title;
  final String? body;
  final String status;
}

class _RenderedJournalStep {
  const _RenderedJournalStep({required this.thinking, required this.tools});
  final String thinking;
  final List<_JournalToolStep> tools;
}

class _JournalToolStep {
  const _JournalToolStep({required this.label, required this.status});
  final String label;
  final String status;
}

/// 隐私敏感工具（look_at_screen）独立卡片：永不混入聚合折叠卡，保障用户知情权。
class ScreenToolCard extends StatelessWidget {
  const ScreenToolCard({
    super.key,
    required this.label,
    this.reason,
    this.screenshotUrl,
    this.profile,
    this.isRunning = false,
  });

  final String label;
  final String? reason;
  final String? screenshotUrl;
  final ConnectionProfile? profile;
  final bool isRunning;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: colors.celadonWash.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.hairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            PhosphorIconsLight.monitor,
            size: 15,
            color: colors.thresholdAmber,
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isRunning ? '正在看一眼你的屏幕…' : label,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: colors.inkDeep,
                  ),
                ),
                if (reason != null && reason!.trim().isNotEmpty)
                  Text(
                    '理由：$reason',
                    style: TextStyle(fontSize: 11, color: colors.inkQuiet),
                  ),
              ],
            ),
          ),
          if (!isRunning &&
              screenshotUrl != null &&
              screenshotUrl!.isNotEmpty &&
              profile != null) ...[
            const SizedBox(width: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: Image.network(
                profile!.resolveMediaUrl(screenshotUrl!),
                headers: {'Authorization': 'Bearer ${profile!.token}'},
                width: 44,
                height: 30,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => const SizedBox.shrink(),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
