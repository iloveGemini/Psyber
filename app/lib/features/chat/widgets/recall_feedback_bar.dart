import 'package:flutter/material.dart';

import '../../../core/models/models.dart';
import '../../../core/state/app_controller.dart';
import '../../../shared/theme.dart';

/// 可开关召回标注浮条（Spec 04 §5.4 · NG-4）：
/// 仅在评测模式开启且 recallCount > 0 时渲染单行胶囊「想起 N 张卡」，
/// 点击后才懒加载 GET /api/v1/turns/:turnId/recall，支持单点标「准 / 噪声」与补充「漏召」。
class RecallFeedbackBar extends StatefulWidget {
  const RecallFeedbackBar({
    super.key,
    required this.controller,
    required this.turnId,
    required this.recallCount,
  });

  final AppController controller;
  final String turnId;
  final int recallCount;

  @override
  State<RecallFeedbackBar> createState() => _RecallFeedbackBarState();
}

class _RecallFeedbackBarState extends State<RecallFeedbackBar> {
  bool _expanded = false;
  bool _loading = false;
  List<RecallTraceItem>? _items;
  String? _error;

  Future<void> _toggle() async {
    if (_expanded) {
      setState(() => _expanded = false);
      return;
    }
    setState(() {
      _expanded = true;
      _error = null;
    });
    if (_items != null) return;

    setState(() => _loading = true);
    try {
      final loaded = await widget.controller.loadTurnRecall(widget.turnId);
      if (!mounted) return;
      setState(() {
        _items = loaded;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = '读取召回记录失败';
        _loading = false;
      });
    }
  }

  Future<void> _markVerdict(int index, String verdict) async {
    final current = _items;
    if (current == null) return;
    final target = current[index];
    await widget.controller.submitRecallFeedback(
      turnId: widget.turnId,
      cardPath: target.cardPath,
      verdict: verdict,
    );
    if (!mounted) return;
    final updated = List<RecallTraceItem>.from(current);
    updated[index] = target.copyWith(feedback: verdict);
    setState(() => _items = updated);
  }

  Future<void> _promptMissedNote() async {
    final textController = TextEditingController();
    final note = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('补充漏召备注'),
        content: TextField(
          controller: textController,
          decoration: const InputDecoration(
            hintText: '简述本轮本该想起但没想起的内容',
          ),
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(textController.text.trim()),
            child: const Text('提交'),
          ),
        ],
      ),
    );
    textController.dispose();
    if (note == null || note.isEmpty) return;
    await widget.controller.submitRecallFeedback(
      turnId: widget.turnId,
      verdict: 'missed',
      note: note,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: Key('recall_capsule_${widget.turnId}'),
            borderRadius: BorderRadius.circular(12),
            onTap: _toggle,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: PsyberTheme.paperCanvas,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: PsyberTheme.hairline),
              ),
              child: Text(
                '想起 ${widget.recallCount} 张卡',
                style: const TextStyle(fontSize: 12, color: PsyberTheme.inkMuted),
              ),
            ),
          ),
          if (_expanded) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: PsyberTheme.paperCard,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: PsyberTheme.hairline),
              ),
              child: _loading
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : _error != null
                      ? Text(_error!, style: const TextStyle(fontSize: 12))
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            for (var i = 0; i < (_items?.length ?? 0); i++)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 6),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        '${_items![i].title} (${_items![i].cardPath})',
                                        style: const TextStyle(fontSize: 12),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    _VerdictChip(
                                      key: Key('recall_useful_${widget.turnId}_$i'),
                                      label: '准',
                                      selected: _items![i].feedback == 'useful',
                                      onTap: () => _markVerdict(i, 'useful'),
                                    ),
                                    const SizedBox(width: 4),
                                    _VerdictChip(
                                      key: Key('recall_noisy_${widget.turnId}_$i'),
                                      label: '噪声',
                                      selected: _items![i].feedback == 'noisy',
                                      onTap: () => _markVerdict(i, 'noisy'),
                                    ),
                                  ],
                                ),
                              ),
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: _promptMissedNote,
                                style: TextButton.styleFrom(
                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                  minimumSize: Size.zero,
                                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                ),
                                child: const Text('补充漏召', style: TextStyle(fontSize: 12)),
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

class _VerdictChip extends StatelessWidget {
  const _VerdictChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: selected ? PsyberTheme.accentWarm : PsyberTheme.paperCanvas,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: PsyberTheme.hairline),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11.5,
            color: selected ? Colors.white : PsyberTheme.inkPrimary,
          ),
        ),
      ),
    );
  }
}
