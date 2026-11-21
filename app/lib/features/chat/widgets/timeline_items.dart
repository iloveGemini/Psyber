import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';
import 'package:flutter/services.dart';

import '../../../core/models/models.dart';
import '../../../core/network/api_client.dart';
import '../../../core/state/app_controller.dart';
import '../../../expression/expression_renderer.dart';
import '../../../shared/rich_message_text.dart';
import '../../../shared/theme.dart';
import 'recall_feedback_bar.dart';
import 'turn_journal_card.dart';
import 'video_tile.dart';

export 'turn_journal_card.dart' show ModelSwitchDivider, ScreenToolCard, TurnJournalCard;

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
                        _expanded ? PhosphorIconsLight.caretUp : PhosphorIconsLight.caretDown,
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
                  icon: const Icon(PhosphorIconsLight.x, color: Colors.white),
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
        title: const Text('编辑消息', style: TextStyle(fontSize: 16.5)),
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
          e.isEndpointUnavailable ? '当前服务端暂不支持编辑消息' : e.message;
    }
  }

  Future<void> _handleReroll() async {
    try {
      await widget.controller.rerollMessage(widget.item.id);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value =
          e.isEndpointUnavailable ? '当前服务端暂不支持重新生成' : e.message;
    }
  }

  Future<void> _handleSwitchVersion(int nextVersion) async {
    try {
      await widget.controller.switchMessageVersion(widget.item.id, nextVersion);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value =
          e.isEndpointUnavailable ? '当前服务端暂不支持切换版本' : e.message;
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
                  leading: const Icon(PhosphorIconsLight.copy, size: 19),
                  title: const Text('复制文字'),
                  onTap: () {
                    unawaited(Clipboard.setData(ClipboardData(text: item.content)));
                    Navigator.of(ctx).pop();
                  },
                ),
              if (canEdit)
                ListTile(
                  key: Key('edit_msg_${item.id}'),
                  leading: const Icon(PhosphorIconsLight.pencilSimple, size: 19),
                  title: const Text('编辑并重发'),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleEdit());
                  },
                ),
              if (canReroll)
                ListTile(
                  key: Key('reroll_msg_${item.id}'),
                  leading: const Icon(PhosphorIconsLight.arrowClockwise, size: 19),
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
                    PhosphorIconsLight.trash,
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
    final screenTools = item.toolSummary
        .where((t) => t.isScreen)
        .toList(growable: false);
    final hasJournal = item.isAssistant &&
        ((item.thinking?.isNotEmpty ?? false) ||
            item.toolSummary.any((t) => !t.isScreen));
    final hasMedia =
        item.sticker != null || item.attachments.isNotEmpty || item.videoClip != null;
    final isPureMedia = !item.isDoorNote &&
        item.content.trim().isEmpty &&
        !hasJournal &&
        screenTools.isEmpty &&
        hasMedia;
    final showBubbleBox = item.isDoorNote || (isUser && !isPureMedia);

    final BoxDecoration? bubbleDecoration = showBubbleBox
        ? BoxDecoration(
            color: item.isDoorNote ? colors.slipPaper : colors.userBubble,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: item.isDoorNote ? colors.hairlineWarm : colors.hairline,
            ),
          )
        : null;
    final EdgeInsetsGeometry bubblePadding = showBubbleBox
        ? const EdgeInsets.symmetric(horizontal: 14, vertical: 10)
        : isPureMedia
            ? const EdgeInsets.symmetric(vertical: 2)
            : const EdgeInsets.symmetric(horizontal: 2, vertical: 6);
    final double stickerExtent = isPureMedia ? 112 : 96;

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: MouseRegion(
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: GestureDetector(
            onSecondaryTapUp: (_) => _openContextActions(),
            onLongPress: _openContextActions,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                mainAxisAlignment:
                    isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (isUser) _buildHoverActionPill(isLeft: true),
                  Flexible(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: isUser ? 540 : 580,
                      ),
                      child: Container(
                        padding: bubblePadding,
                        decoration: bubbleDecoration,
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
                                    color: colors.thresholdAmber,
                                  ),
                                ),
                              ),
                            if (hasJournal)
                              TurnJournalCard(
                                thinking: item.thinking ?? '',
                                summaryTools: item.toolSummary,
                                isStreaming: false,
                              ),
                            for (final st in screenTools)
                              ScreenToolCard(
                                label: st.label.isNotEmpty ? st.label : st.name,
                                reason: st.reason,
                                screenshotUrl: st.screenshotUrl,
                                profile: profile,
                              ),
                            if (item.sticker != null)
                              Padding(
                                padding: EdgeInsets.only(
                                  bottom: item.content.isNotEmpty ? 6 : 0,
                                ),
                                child: profile != null && item.sticker!.url.isNotEmpty
                                    ? ClipRRect(
                                        borderRadius: BorderRadius.circular(10),
                                        child: Image.network(
                                          profile.resolveMediaUrl(item.sticker!.url),
                                          headers: {'Authorization': 'Bearer ${profile.token}'},
                                          width: stickerExtent,
                                          height: stickerExtent,
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
                            if (item.videoClip != null && profile != null)
                              Padding(
                                padding: EdgeInsets.only(
                                  bottom: item.content.isNotEmpty ? 6 : 0,
                                ),
                                child: VideoTile(
                                  videoClip: item.videoClip!,
                                  profile: profile,
                                ),
                              )
                            else if (item.attachments.isNotEmpty && profile != null)
                              Padding(
                                padding: EdgeInsets.only(
                                  bottom: item.content.isNotEmpty ? 6 : 0,
                                ),
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
                                        child: Container(
                                          decoration: BoxDecoration(
                                            borderRadius: BorderRadius.circular(10),
                                            border: Border.all(
                                              color: colors.hairline,
                                              width: 0.5,
                                            ),
                                          ),
                                          clipBehavior: Clip.antiAlias,
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
                                              color: colors.mineralCanvas,
                                              alignment: Alignment.center,
                                              child: Text(
                                                '图片已过期',
                                                style: TextStyle(
                                                  fontSize: 11.5,
                                                  color: colors.inkQuiet,
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
                              RichMessageText(
                                text: item.content,
                                baseStyle: isUser
                                    ? null
                                    : PsyberTheme.editorialSerif.copyWith(
                                        fontSize: 15.5,
                                        height: 1.66,
                                        color: colors.inkDeep,
                                      ),
                              ),
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
                                        PhosphorIconsLight.caretLeft,
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
                                        PhosphorIconsLight.caretRight,
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
      opacity: _hovered ? 1.0 : 0.0,
      child: Padding(
        padding: EdgeInsets.only(
          left: isLeft ? 0 : 4,
          right: isLeft ? 4 : 0,
          bottom: 2,
        ),
        child: IconButton(
          key: Key('msg_more_${widget.item.id}'),
          icon: const Icon(PhosphorIconsLight.dotsThree, size: 17, color: PsyberTheme.inkQuiet),
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
    final screenTools =
        active.tools.where((t) => t.isScreen).toList(growable: false);
    final hasJournal =
        active.thinking.isNotEmpty || active.tools.any((t) => !t.isScreen);

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: Align(
          alignment: Alignment.centerLeft,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 580),
            child: MotionBubbleWrapper(
              motion: active.latestExpression?.motion,
              child: Container(
                key: const Key('streaming_bubble'),
                margin: const EdgeInsets.symmetric(vertical: 6),
                padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (hasJournal)
                      TurnJournalCard(
                        thinking: active.thinking,
                        progressTools: active.tools,
                        isStreaming: true,
                      ),
                    for (final st in screenTools)
                      ScreenToolCard(
                        label: st.label,
                        reason: st.reason,
                        screenshotUrl: st.screenshotUrl,
                        isRunning: st.status == 'running',
                      ),
                    if (active.text.isNotEmpty)
                      RichMessageText(
                        text: active.text,
                        baseStyle: PsyberTheme.editorialSerif.copyWith(
                          fontSize: 15.5,
                          height: 1.66,
                          color: colors.inkDeep,
                        ),
                      )
                    else
                      Row(
                        key: const Key('streaming_replying_placeholder'),
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(
                              strokeWidth: 1.6,
                              color: colors.inkQuiet,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            '正在回复…',
                            style: TextStyle(
                              color: colors.inkQuiet,
                              fontSize: 13.5,
                            ),
                          ),
                        ],
                      ),
                    const SizedBox(height: 6),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        if (active.text.isNotEmpty)
                          Row(
                            key: const Key('streaming_replying_badge'),
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              SizedBox(
                                width: 10,
                                height: 10,
                                child: CircularProgressIndicator(
                                  strokeWidth: 1.4,
                                  color: colors.inkFaint,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Text(
                                '正在回复…',
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: colors.inkFaint,
                                ),
                              ),
                            ],
                          )
                        else
                          const SizedBox.shrink(),
                        TextButton.icon(
                          key: const Key('abort_turn_button'),
                          onPressed: () => unawaited(onAbort()),
                          style: TextButton.styleFrom(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          icon: const Icon(PhosphorIconsLight.stopCircle, size: 15),
                          label: const Text('停止生成', style: TextStyle(fontSize: 12)),
                        ),
                      ],
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
