import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
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

/// 同轮「思考 + 多步工具调用」按步分段手账折卡（Spec 04 §5.4）：
/// - 按 step 顺序分段渲染每一步的思考与工具动作，避免多步思考糊成一坨；
/// - 保留 Key('thinking_toggle') 与 Key('thinking_body') 供流畅展开阅读；
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
  bool _expanded = false;

  @override
  void didUpdateWidget(covariant TurnJournalCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isStreaming && !widget.isStreaming && _expanded) {
      _expanded = false;
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

  String _headerTitle(List<_JournalToolStep> tools, bool hasThinking) {
    if (widget.isStreaming) {
      return hasThinking ? '思考中…' : '翻看手账…';
    }
    if (tools.isEmpty) {
      return '思考过程';
    }
    final firstLabel = tools.first.label;
    if (tools.length == 1) {
      return hasThinking ? '思索 · $firstLabel' : firstLabel;
    }
    return hasThinking
        ? '思索与动作 · $firstLabel 等 ${tools.length} 步'
        : '$firstLabel 等 ${tools.length} 步';
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
    final runningSteps =
        allTools.where((s) => s.status == 'running').toList(growable: false);
    final firstThinkingIndex =
        renderedSteps.indexWhere((s) => s.thinking.isNotEmpty);

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 4,
            children: [
              InkWell(
                key: const Key('thinking_toggle'),
                borderRadius: BorderRadius.circular(8),
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '✦',
                        style: TextStyle(
                          fontSize: 10.5,
                          color: colors.inkFaint,
                        ),
                      ),
                      const SizedBox(width: 5),
                      Text(
                        _headerTitle(allTools, hasThinking),
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.inkQuiet,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded
                            ? PhosphorIconsLight.caretUp
                            : PhosphorIconsLight.caretDown,
                        size: 13,
                        color: colors.inkFaint,
                      ),
                    ],
                  ),
                ),
              ),
              if (widget.isStreaming)
                for (final r in runningSteps)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: colors.mineralCanvas,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: colors.hairline),
                    ),
                    child: Text(
                      '${r.label} · 进行中',
                      style: TextStyle(
                        fontSize: 11,
                        color: colors.inkQuiet,
                      ),
                    ),
                  ),
            ],
          ),
          if (_expanded)
            Container(
              margin: const EdgeInsets.only(top: 5, left: 4),
              padding: const EdgeInsets.only(left: 10, top: 4, bottom: 4),
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(color: colors.hairline, width: 2),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (var i = 0; i < renderedSteps.length; i++) ...[
                    if (i > 0)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Divider(
                          height: 1,
                          thickness: 0.7,
                          color: colors.hairline.withValues(alpha: 0.8),
                        ),
                      ),
                    if (renderedSteps.length > 1)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text(
                          '第 ${i + 1} 步',
                          style: TextStyle(
                            fontSize: 10.5,
                            fontWeight: FontWeight.w500,
                            color: colors.inkFaint,
                          ),
                        ),
                      ),
                    if (renderedSteps[i].thinking.isNotEmpty)
                      SelectableText(
                        renderedSteps[i].thinking,
                        key: i == firstThinkingIndex
                            ? const Key('thinking_body')
                            : Key('thinking_body_$i'),
                        style: TextStyle(
                          fontSize: 12.5,
                          height: 1.55,
                          color: colors.inkQuiet,
                        ),
                      ),
                    if (renderedSteps[i].thinking.isNotEmpty &&
                        renderedSteps[i].tools.isNotEmpty)
                      const SizedBox(height: 6),
                    for (final stepTool in renderedSteps[i].tools)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 3),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              stepTool.status == 'error'
                                  ? PhosphorIconsLight.warningCircle
                                  : stepTool.status == 'running'
                                      ? PhosphorIconsLight.circleDashed
                                      : PhosphorIconsLight.check,
                              size: 12.5,
                              color: stepTool.status == 'error'
                                  ? colors.dangerInk
                                  : colors.inkFaint,
                            ),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                '${stepTool.label}${stepTool.status == 'running' ? ' · 进行中' : stepTool.status == 'error' ? ' · 未成' : ''}',
                                style: TextStyle(
                                  fontSize: 12,
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
            ),
        ],
      ),
    );
  }
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
