import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/models/models.dart';
import '../../../core/network/api_client.dart';
import '../../../core/state/app_controller.dart';
import '../../../expression/expression_renderer.dart';
import '../../../shared/rich_message_text.dart';
import '../../../shared/theme.dart';
import 'recall_feedback_bar.dart';
import 'thinking_card.dart';

/// 时间分隔线（当天内跨段 > 30 分钟或跨日出现）
class TimelineDateDivider extends StatelessWidget {
  const TimelineDateDivider({super.key, required this.epochMs});

  final int epochMs;

  static String formatTimestamp(int epochMs) {
    if (epochMs <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(epochMs).toLocal();
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final msgDay = DateTime(dt.year, dt.month, dt.day);
    final diffDays = today.difference(msgDay).inDays;
    final hh = dt.hour.toString().padLeft(2, '0');
    final mm = dt.minute.toString().padLeft(2, '0');
    if (diffDays == 0) return '$hh:$mm';
    if (diffDays == 1) return '昨天 $hh:$mm';
    if (dt.year == now.year) return '${dt.month}月${dt.day}日 $hh:$mm';
    return '${dt.year}/${dt.month}/${dt.day} $hh:$mm';
  }

  @override
  Widget build(BuildContext context) {
    final label = formatTimestamp(epochMs);
    if (label.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Center(
        child: Text(
          label,
          style: const TextStyle(
            fontSize: 11.5,
            color: PsyberTheme.inkFaint,
          ),
        ),
      ),
    );
  }
}

/// 门态变动、私密拆封、离开、活动记录等安静的系统分隔线。
class SystemNoticeRow extends StatelessWidget {
  const SystemNoticeRow({super.key, required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    final text = item.content.trim().isNotEmpty ? item.content.trim() : item.kind;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
          child: Row(
            children: [
              const Expanded(child: Divider(height: 1)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Text(
                  text,
                  style: TextStyle(
                    fontSize: 11.5,
                    color: item.kind == 'privacy.peeked'
                        ? PsyberTheme.thresholdAmber
                        : PsyberTheme.inkQuiet,
                  ),
                ),
              ),
              const Expanded(child: Divider(height: 1)),
            ],
          ),
        ),
      ),
    );
  }
}

/// 后台静默记忆整理折叠条（`kind == 'memory_task'`）。
class MemoryTaskRow extends StatefulWidget {
  const MemoryTaskRow({super.key, required this.item});

  final TimelineItem item;

  @override
  State<MemoryTaskRow> createState() => _MemoryTaskRowState();
}

class _MemoryTaskRowState extends State<MemoryTaskRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
          child: Column(
            children: [
              InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => setState(() => _expanded = !_expanded),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                  decoration: BoxDecoration(
                    color: PsyberTheme.letterSurface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: PsyberTheme.hairline),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        '✦ 整理记忆',
                        style: TextStyle(fontSize: 11.5, color: PsyberTheme.inkQuiet),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded ? Icons.expand_less : Icons.expand_more,
                        size: 14,
                        color: PsyberTheme.inkFaint,
                      ),
                    ],
                  ),
                ),
              ),
              if (_expanded && widget.item.content.trim().isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: PsyberTheme.letterSurface,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: PsyberTheme.hairline),
                  ),
                  child: Text(
                    widget.item.content,
                    style: const TextStyle(
                      fontSize: 12,
                      color: PsyberTheme.inkQuiet,
                      height: 1.45,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 时间线消息气泡：
/// - 居中窄阅读列（maxWidth 680px），桌面端气泡不再横跨全屏；
/// - 移除气泡右下角常驻垃圾桶图标，操作（复制/删除/Ring 1.5 编辑/重摇）收拢至悬停微浮栏与长按菜单；
/// - 预留 Ring 1.5 版本组切换器（< 1 / 2 >）与图片灯箱放大。
class MessageBubbleRow extends StatefulWidget {
  const MessageBubbleRow({
    super.key,
    required this.item,
    required this.controller,
    required this.showRecallBar,
    required this.isLatestUserMessage,
    required this.doorState,
  });

  final TimelineItem item;
  final AppController controller;
  final bool showRecallBar;
  final bool isLatestUserMessage;
  final DoorState doorState;

  @override
  State<MessageBubbleRow> createState() => _MessageBubbleRowState();
}

class _MessageBubbleRowState extends State<MessageBubbleRow> {
  bool _hovered = false;

  void _openLightbox(BuildContext context, ConnectionProfile profile, String url) {
    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          backgroundColor: const Color(0xE61E201E),
          insetPadding: const EdgeInsets.all(20),
          child: Stack(
            children: [
              Positioned.fill(
                child: InteractiveViewer(
                  minScale: 0.6,
                  maxScale: 4.0,
                  child: Center(
                    child: Image.network(
                      profile.resolveMediaUrl(url),
                      headers: {'Authorization': 'Bearer ${profile.token}'},
                      fit: BoxFit.contain,
                    ),
                  ),
                ),
              ),
              Positioned(
                top: 12,
                right: 12,
                child: IconButton(
                  style: IconButton.styleFrom(backgroundColor: Colors.black54),
                  icon: const Icon(Icons.close, color: Colors.white),
                  onPressed: () => Navigator.of(ctx).pop(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _handleEdit() async {
    final ctrl = TextEditingController(text: widget.item.content);
    final updated = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PsyberTheme.letterSurface,
        title: const Text('编辑消息（Ring 1.5）', style: TextStyle(fontSize: 16.5)),
        content: TextField(
          controller: ctrl,
          minLines: 2,
          maxLines: 6,
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('保存并重发'),
          ),
        ],
      ),
    ).whenComplete(ctrl.dispose);
    if (updated == null || updated.isEmpty || updated == widget.item.content) return;
    try {
      await widget.controller.editMessage(widget.item.id, updated);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value =
          e.isEndpointUnavailable ? '消息编辑将在 Ring 1.5 启用' : e.message;
    }
  }

  Future<void> _handleReroll() async {
    try {
      await widget.controller.rerollMessage(widget.item.id);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value =
          e.isEndpointUnavailable ? '重新生成版本组将在 Ring 1.5 启用' : e.message;
    }
  }

  Future<void> _handleSwitchVersion(int nextVersion) async {
    try {
      await widget.controller.switchMessageVersion(widget.item.id, nextVersion);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value =
          e.isEndpointUnavailable ? '版本切换将在 Ring 1.5 启用' : e.message;
    }
  }

  Future<void> _handleDelete() async {
    try {
      await widget.controller.deleteMessage(widget.item.id);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '删除消息失败，请稍后重试';
    }
  }

  void _openContextActions() {
    final item = widget.item;
    final canEdit = widget.isLatestUserMessage &&
        (!widget.doorState.isDoorNoteMode || item.isDoorNote);
    final canReroll = item.isAssistant &&
        item.kind == 'chat' &&
        !widget.doorState.isDoorNoteMode &&
        !widget.doorState.isReadOnly;

    unawaited(
      showModalBottomSheet<void>(
        context: context,
        backgroundColor: PsyberTheme.letterSurface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        builder: (ctx) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (item.content.trim().isNotEmpty)
                ListTile(
                  leading: const Icon(Icons.copy_outlined, size: 19),
                  title: const Text('复制文字'),
                  onTap: () {
                    unawaited(Clipboard.setData(ClipboardData(text: item.content)));
                    Navigator.of(ctx).pop();
                  },
                ),
              if (canEdit)
                ListTile(
                  key: Key('edit_msg_${item.id}'),
                  leading: const Icon(Icons.edit_outlined, size: 19),
                  title: const Text('编辑并重发'),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleEdit());
                  },
                ),
              if (canReroll)
                ListTile(
                  key: Key('reroll_msg_${item.id}'),
                  leading: const Icon(Icons.refresh_outlined, size: 19),
                  title: const Text('再说一次（Reroll）'),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleReroll());
                  },
                ),
              if (!widget.doorState.isReadOnly)
                ListTile(
                  key: Key('delete_msg_${item.id}'),
                  leading: const Icon(
                    Icons.delete_outline,
                    size: 19,
                    color: PsyberTheme.dangerInk,
                  ),
                  title: const Text(
                    '删除这条消息',
                    style: TextStyle(color: PsyberTheme.dangerInk),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleDelete());
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final isUser = item.isUser;
    final colors = context.colors;
    final profile = widget.controller.profileNotifier.value;
    final bgColor = item.isDoorNote
        ? colors.slipPaper
        : isUser
            ? colors.userBubble
            : colors.letterSurface;
    final borderColor = item.isDoorNote ? colors.hairlineWarm : colors.hairline;

    final radius = isUser
        ? const BorderRadius.only(
            topLeft: Radius.circular(14),
            topRight: Radius.circular(4),
            bottomLeft: Radius.circular(14),
            bottomRight: Radius.circular(14),
          )
        : const BorderRadius.only(
            topLeft: Radius.circular(4),
            topRight: Radius.circular(14),
            bottomLeft: Radius.circular(14),
            bottomRight: Radius.circular(14),
          );

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: GestureDetector(
            onSecondaryTapUp: (_) => _openContextActions(),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                mainAxisAlignment:
                    isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (isUser) _buildHoverActionPill(isLeft: true),
                  Flexible(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 540),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                        decoration: BoxDecoration(
                          color: bgColor,
                          borderRadius: radius,
                          border: Border.all(color: borderColor),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (item.isDoorNote)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 5),
                                child: Text(
                                  '门缝纸条',
                                  style: PsyberTheme.editorialSerif.copyWith(
                                    fontSize: 11.5,
                                    color: PsyberTheme.thresholdAmber,
                                  ),
                                ),
                              ),
                            if (item.isAssistant && (item.thinking?.isNotEmpty ?? false))
                              ThinkingCard(thinking: item.thinking!, isStreaming: false),
                            if (item.toolSummary.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 6),
                                child: Wrap(
                                  spacing: 6,
                                  runSpacing: 4,
                                  children: [
                                    for (final tool in item.toolSummary)
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 7,
                                          vertical: 2,
                                        ),
                                        decoration: BoxDecoration(
                                          color: PsyberTheme.mineralCanvas,
                                          borderRadius: BorderRadius.circular(8),
                                          border: Border.all(color: PsyberTheme.hairline),
                                        ),
                                        child: Text(
                                          tool.label.isNotEmpty ? tool.label : tool.name,
                                          style: const TextStyle(
                                            fontSize: 11,
                                            color: PsyberTheme.inkQuiet,
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            if (item.sticker != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 6),
                                child: profile != null && item.sticker!.url.isNotEmpty
                                    ? ClipRRect(
                                        borderRadius: BorderRadius.circular(8),
                                        child: Image.network(
                                          profile.resolveMediaUrl(item.sticker!.url),
                                          headers: {'Authorization': 'Bearer ${profile.token}'},
                                          width: 96,
                                          height: 96,
                                          fit: BoxFit.contain,
                                          errorBuilder: (_, __, ___) => Text(
                                            '[贴纸：${item.sticker!.label}]',
                                            style: TextStyle(
                                              fontSize: 13,
                                              color: colors.inkQuiet,
                                            ),
                                          ),
                                        ),
                                      )
                                    : Text(
                                        '[贴纸：${item.sticker!.label}]',
                                        style: TextStyle(
                                          fontSize: 13,
                                          color: colors.inkQuiet,
                                        ),
                                      ),
                              ),
                            if (item.attachments.isNotEmpty && profile != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 6),
                                child: Wrap(
                                  spacing: 8,
                                  runSpacing: 8,
                                  children: [
                                    for (final hash in item.attachments)
                                      GestureDetector(
                                        onTap: () => _openLightbox(
                                          context,
                                          profile,
                                          '/api/v1/media/$hash',
                                        ),
                                        child: ClipRRect(
                                          borderRadius: BorderRadius.circular(10),
                                          child: Image.network(
                                            profile.resolveMediaUrl('/api/v1/media/$hash'),
                                            headers: {
                                              'Authorization': 'Bearer ${profile.token}',
                                            },
                                            width: 164,
                                            height: 164,
                                            fit: BoxFit.cover,
                                            errorBuilder: (_, __, ___) => Container(
                                              width: 110,
                                              height: 64,
                                              color: PsyberTheme.mineralCanvas,
                                              alignment: Alignment.center,
                                              child: const Text(
                                                '图片已过期',
                                                style: TextStyle(
                                                  fontSize: 11.5,
                                                  color: PsyberTheme.inkQuiet,
                                                ),
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            if (item.content.isNotEmpty)
                              RichMessageText(text: item.content),
                            if (item.aborted)
                              const Padding(
                                padding: EdgeInsets.only(top: 4),
                                child: Text(
                                  '已中断',
                                  style: TextStyle(fontSize: 11, color: PsyberTheme.inkFaint),
                                ),
                              ),
                            if (item.isAssistant && item.versionCount > 1)
                              Padding(
                                padding: const EdgeInsets.only(top: 6),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    InkWell(
                                      key: Key('version_prev_${item.id}'),
                                      onTap: item.version > 1
                                          ? () => unawaited(
                                                _handleSwitchVersion(item.version - 1),
                                              )
                                          : null,
                                      child: Icon(
                                        Icons.chevron_left,
                                        size: 16,
                                        color: item.version > 1
                                            ? PsyberTheme.inkQuiet
                                            : PsyberTheme.inkFaint,
                                      ),
                                    ),
                                    Text(
                                      '${item.version} / ${item.versionCount}',
                                      style: const TextStyle(
                                        fontSize: 11.5,
                                        color: PsyberTheme.inkQuiet,
                                      ),
                                    ),
                                    InkWell(
                                      key: Key('version_next_${item.id}'),
                                      onTap: item.version < item.versionCount
                                          ? () => unawaited(
                                                _handleSwitchVersion(item.version + 1),
                                              )
                                          : null,
                                      child: Icon(
                                        Icons.chevron_right,
                                        size: 16,
                                        color: item.version < item.versionCount
                                            ? PsyberTheme.inkQuiet
                                            : PsyberTheme.inkFaint,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            if (widget.showRecallBar &&
                                item.isAssistant &&
                                item.turnId != null &&
                                (item.recallCount ?? 0) > 0)
                              RecallFeedbackBar(
                                controller: widget.controller,
                                turnId: item.turnId!,
                                recallCount: item.recallCount!,
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  if (!isUser) _buildHoverActionPill(isLeft: false),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHoverActionPill({required bool isLeft}) {
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 120),
      opacity: _hovered ? 1.0 : 0.35,
      child: Padding(
        padding: EdgeInsets.only(
          left: isLeft ? 0 : 4,
          right: isLeft ? 4 : 0,
          bottom: 2,
        ),
        child: IconButton(
          key: Key('msg_more_${widget.item.id}'),
          icon: const Icon(Icons.more_horiz, size: 17, color: PsyberTheme.inkQuiet),
          tooltip: '消息操作',
          padding: const EdgeInsets.all(4),
          constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
          onPressed: _openContextActions,
        ),
      ),
    );
  }
}

/// 实时流式生成槽（独立监听 ActiveTurnState，不重绘整条历史列表）。
class StreamingAssistantBubble extends StatelessWidget {
  const StreamingAssistantBubble({
    super.key,
    required this.active,
    required this.onAbort,
  });

  final ActiveTurnState active;
  final Future<void> Function() onAbort;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: Align(
          alignment: Alignment.centerLeft,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 540),
            child: MotionBubbleWrapper(
              motion: active.latestExpression?.motion,
              child: Container(
                key: const Key('streaming_bubble'),
                margin: const EdgeInsets.symmetric(vertical: 5),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                decoration: BoxDecoration(
                  color: colors.letterSurface,
                  borderRadius: const BorderRadius.only(
                    topLeft: Radius.circular(4),
                    topRight: Radius.circular(14),
                    bottomLeft: Radius.circular(14),
                    bottomRight: Radius.circular(14),
                  ),
                  border: Border.all(color: colors.hairline),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (active.thinking.isNotEmpty)
                      ThinkingCard(thinking: active.thinking, isStreaming: true),
                    if (active.tools.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 4,
                          children: [
                            for (final tool in active.tools)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 3,
                                ),
                                decoration: BoxDecoration(
                                  color: colors.mineralCanvas,
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(color: colors.hairline),
                                ),
                                child: Text(
                                  '${tool.label} · ${tool.status == 'running' ? '进行中' : tool.status == 'error' ? '失败' : '完成'}',
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    color: colors.inkQuiet,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    if (active.text.isNotEmpty)
                      RichMessageText(text: active.text)
                    else
                      Text(
                        '…',
                        style: TextStyle(color: colors.inkQuiet, fontSize: 16),
                      ),
                    const SizedBox(height: 6),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        key: const Key('abort_turn_button'),
                        onPressed: () => unawaited(onAbort()),
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        icon: const Icon(Icons.stop_circle_outlined, size: 15),
                        label: const Text('停止生成', style: TextStyle(fontSize: 12)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
