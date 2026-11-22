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
import 'share_card.dart';
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
    final colors = context.colors;
    if (colors.useReadingChrome) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
            child: Row(
              children: [
                Expanded(
                  child: Divider(
                    height: 1,
                    color: colors.hairline.withValues(alpha: 0.75),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Text(
                    '· $label ·',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 11.5,
                      letterSpacing: 0.6,
                      color: colors.inkFaint,
                    ),
                  ),
                ),
                Expanded(
                  child: Divider(
                    height: 1,
                    color: colors.hairline.withValues(alpha: 0.75),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Center(
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11.5,
            color: colors.inkFaint,
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
    final colors = context.colors;
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
                        ? colors.thresholdAmber
                        : colors.inkQuiet,
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
    final colors = context.colors;
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
                    color: colors.letterSurface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: colors.hairline),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '✦ 整理记忆',
                        style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded ? PhosphorIconsLight.caretUp : PhosphorIconsLight.caretDown,
                        size: 14,
                        color: colors.inkFaint,
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
                    color: colors.letterSurface,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: colors.hairline),
                  ),
                  child: Text(
                    widget.item.content,
                    style: TextStyle(
                      fontSize: 12,
                      color: colors.inkQuiet,
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
/// 双向社交撤回居中占位行（隐藏原文与思考，仅留「有过一条，收回了」）。
class RetractedMessageRow extends StatelessWidget {
  const RetractedMessageRow({super.key, required this.item});

  final TimelineItem item;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isUser = item.retractedBy == 'user' || (item.retractedBy == null && item.isUser);
    final label = isUser ? '你撤回了一条消息' : '对方撤回了一条消息';
    return Padding(
      key: Key('retracted_msg_${item.id}'),
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: Text(
          label,
          style: TextStyle(fontSize: 11.5, color: colors.inkFaint),
        ),
      ),
    );
  }
}

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
  bool _armingDelete = false;
  Timer? _deleteArmTimer;

  @override
  void dispose() {
    _deleteArmTimer?.cancel();
    super.dispose();
  }

  void _onDeleteTap() {
    if (!_armingDelete) {
      _deleteArmTimer?.cancel();
      setState(() => _armingDelete = true);
      _deleteArmTimer = Timer(const Duration(seconds: 3), () {
        if (mounted) setState(() => _armingDelete = false);
      });
      return;
    }
    _deleteArmTimer?.cancel();
    setState(() => _armingDelete = false);
    unawaited(_handleDelete());
  }

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
    final controller = widget.controller;
    final itemId = widget.item.id;
    final originalContent = widget.item.content;
    final updated = await showDialog<String>(
      context: context,
      builder: (_) => _EditMessageDialog(initialText: originalContent),
    );
    if (updated == null || updated.isEmpty || updated == originalContent) return;
    try {
      await controller.editMessage(itemId, updated);
    } on ApiException catch (e) {
      controller.turnErrorNotifier.value =
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

  Future<void> _handleRetract() async {
    try {
      await widget.controller.retractMessage(widget.item.id);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '撤回消息失败，请稍后重试';
    }
  }

  void _openContextActions() {
    final item = widget.item;
    final colors = context.colors;
    final canEdit = widget.isLatestUserMessage &&
        (!widget.doorState.isDoorNoteMode || item.isDoorNote);
    final canReroll = item.isAssistant &&
        item.kind == 'chat' &&
        !widget.doorState.isDoorNoteMode &&
        !widget.doorState.isReadOnly;
    final canRetract = item.isUser &&
        !item.retracted &&
        !widget.doorState.isReadOnly &&
        widget.controller.activeTurnNotifier.value == null;

    unawaited(
      showModalBottomSheet<void>(
        context: context,
        backgroundColor: colors.letterSurface,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
          side: BorderSide(color: colors.hairline),
        ),
        builder: (ctx) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (item.content.trim().isNotEmpty)
                ListTile(
                  leading: Icon(PhosphorIconsLight.copy, size: 19, color: colors.inkQuiet),
                  title: Text('复制文字', style: TextStyle(color: colors.inkDeep)),
                  onTap: () {
                    unawaited(Clipboard.setData(ClipboardData(text: item.content)));
                    Navigator.of(ctx).pop();
                  },
                ),
              if (canEdit)
                ListTile(
                  key: Key('edit_msg_${item.id}'),
                  leading: Icon(PhosphorIconsLight.pencilSimple, size: 19, color: colors.inkQuiet),
                  title: Text('编辑并重发', style: TextStyle(color: colors.inkDeep)),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleEdit());
                  },
                ),
              if (canReroll)
                ListTile(
                  key: Key('reroll_msg_${item.id}'),
                  leading: Icon(PhosphorIconsLight.arrowClockwise, size: 19, color: colors.inkQuiet),
                  title: Text('再说一次（Reroll）', style: TextStyle(color: colors.inkDeep)),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleReroll());
                  },
                ),
              if (canRetract)
                ListTile(
                  key: Key('retract_msg_${item.id}'),
                  leading: Icon(PhosphorIconsLight.arrowUDownLeft, size: 19, color: colors.inkQuiet),
                  title: Text('撤回这条消息（对方看不到内容）', style: TextStyle(color: colors.inkDeep)),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    unawaited(_handleRetract());
                  },
                ),
              if (!widget.doorState.isReadOnly)
                ListTile(
                  key: Key('delete_msg_${item.id}'),
                  leading: Icon(
                    PhosphorIconsLight.trash,
                    size: 19,
                    color: colors.dangerInk,
                  ),
                  title: Text(
                    '静默删除（修对话，不告知对方）',
                    style: TextStyle(color: colors.dangerInk),
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
            borderRadius: BorderRadius.circular(colors.useReadingChrome ? 8 : 10),
            // 实心强调色气泡不描边，只给门缝纸条留暖色细边
            border: item.isDoorNote
                ? Border.all(color: colors.hairlineWarm)
                : null,
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
                      child: ValueListenableBuilder<bool>(
                        valueListenable: widget.controller.isAppForegroundNotifier,
                        builder: (context, isForeground, child) =>
                            MotionBubbleWrapper(
                          motion: isUser
                              ? null
                              : widget.controller.liveMotionForCommittedTurn(item.turnId),
                          active: isForeground,
                          onStarted: isUser
                              ? null
                              : () => widget.controller.markTurnMotionConsumed(item.turnId),
                          child: child!,
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
                            if (item.urgent && isUser)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 5),
                                child: Text(
                                  '紧急直达',
                                  style: PsyberTheme.editorialSerif.copyWith(
                                    fontSize: 11,
                                    color: colors.dangerInk,
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
                                    // 用户气泡用主题 userText（实心强调色上的反白字）
                                    ? TextStyle(
                                        fontSize: 15,
                                        height: 1.62,
                                        color: colors.userText,
                                      )
                                    : PsyberTheme.editorialSerif.copyWith(
                                        fontSize: 15,
                                        height: 1.66,
                                        color: colors.inkDeep,
                                      ),
                              ),
                            for (final share in item.shares)
                              ShareCard(
                                share: share,
                                onOpen: widget.controller.openShare,
                              ),
                            if (item.aborted)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Text(
                                  '已中断',
                                  style: TextStyle(fontSize: 11, color: colors.inkFaint),
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
                                            ? colors.inkQuiet
                                            : colors.inkFaint,
                                      ),
                                    ),
                                    Text(
                                      '${item.version} / ${item.versionCount}',
                                      style: TextStyle(
                                        fontSize: 11.5,
                                        color: colors.inkQuiet,
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
                                            ? colors.inkQuiet
                                            : colors.inkFaint,
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
    final colors = context.colors;
    final item = widget.item;
    final canRetract = item.isUser &&
        !item.retracted &&
        !widget.doorState.isReadOnly &&
        widget.controller.activeTurnNotifier.value == null;
    final canDelete = !widget.doorState.isReadOnly;
    final visible = _hovered || _armingDelete;

    return AnimatedOpacity(
      duration: const Duration(milliseconds: 120),
      opacity: visible ? 1.0 : 0.0,
      child: Padding(
        padding: EdgeInsets.only(
          left: isLeft ? 0 : 4,
          right: isLeft ? 4 : 0,
          bottom: 2,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (canRetract)
              IconButton(
                key: Key('hover_retract_${item.id}'),
                icon: Icon(
                  PhosphorIconsLight.arrowUDownLeft,
                  size: 15,
                  color: colors.inkQuiet,
                ),
                tooltip: '撤回这一条（对方看不到内容）',
                padding: const EdgeInsets.all(4),
                constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                onPressed: () => unawaited(_handleRetract()),
              ),
            if (canDelete)
              InkWell(
                key: Key('hover_delete_${item.id}'),
                borderRadius: BorderRadius.circular(6),
                onTap: _onDeleteTap,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_armingDelete)
                        Padding(
                          padding: const EdgeInsets.only(right: 3),
                          child: Text(
                            '再点删除',
                            style: TextStyle(
                              fontSize: 11,
                              color: colors.dangerInk,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      Icon(
                        PhosphorIconsLight.trash,
                        size: 15,
                        color: _armingDelete ? colors.dangerInk : colors.inkQuiet,
                      ),
                    ],
                  ),
                ),
              ),
            IconButton(
              key: Key('msg_more_${item.id}'),
              icon: Icon(PhosphorIconsLight.dotsThree, size: 17, color: colors.inkQuiet),
              tooltip: '消息操作',
              padding: const EdgeInsets.all(4),
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              onPressed: _openContextActions,
            ),
          ],
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
    this.isForeground = true,
    this.profile,
    this.onMotionStarted,
  });

  final ActiveTurnState active;
  final Future<void> Function() onAbort;
  final bool isForeground;
  final ConnectionProfile? profile;
  final VoidCallback? onMotionStarted;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final screenTools =
        active.tools.where((t) => t.isScreen).toList(growable: false);
    final hasJournal =
        active.thinking.isNotEmpty || active.tools.any((t) => !t.isScreen);
    final liveSticker = active.latestExpression?.sticker;
    final hasVisibleBody = active.text.isNotEmpty || liveSticker != null;

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: Align(
          alignment: Alignment.centerLeft,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 580),
            child: MotionBubbleWrapper(
              motion: hasVisibleBody ? active.latestExpression?.motion : null,
              active: isForeground,
              onStarted: onMotionStarted,
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
                    if (liveSticker != null)
                      Padding(
                        padding: EdgeInsets.only(
                          bottom: active.text.isNotEmpty ? 6 : 0,
                        ),
                        child: profile != null && liveSticker.url.isNotEmpty
                            ? ClipRRect(
                                borderRadius: BorderRadius.circular(10),
                                child: Image.network(
                                  profile!.resolveMediaUrl(liveSticker.url),
                                  headers: {'Authorization': 'Bearer ${profile!.token}'},
                                  width: 96,
                                  height: 96,
                                  fit: BoxFit.contain,
                                  errorBuilder: (_, __, ___) => Text(
                                    '[贴纸：${liveSticker.label}]',
                                    style: TextStyle(fontSize: 13, color: colors.inkQuiet),
                                  ),
                                ),
                              )
                            : Text(
                                '[贴纸：${liveSticker.label}]',
                                style: TextStyle(fontSize: 13, color: colors.inkQuiet),
                              ),
                      ),
                    if (active.text.isNotEmpty)
                      RichMessageText(
                        text: active.text,
                        baseStyle: PsyberTheme.editorialSerif.copyWith(
                          fontSize: 15,
                          height: 1.66,
                          color: colors.inkDeep,
                        ),
                      )
                    else if (liveSticker == null)
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

/// 独立持有 TextEditingController 的编辑消息弹窗，确保关闭动画彻底退场后再销毁控制器。
class _EditMessageDialog extends StatefulWidget {
  const _EditMessageDialog({required this.initialText});

  final String initialText;

  @override
  State<_EditMessageDialog> createState() => _EditMessageDialogState();
}

class _EditMessageDialogState extends State<_EditMessageDialog> {
  late final TextEditingController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return AlertDialog(
      backgroundColor: colors.letterSurface,
      title: const Text('编辑消息', style: TextStyle(fontSize: 16.5)),
      content: TextField(
        controller: _ctrl,
        minLines: 2,
        maxLines: 6,
        autofocus: true,
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_ctrl.text.trim()),
          child: const Text('保存并重发'),
        ),
      ],
    );
  }
}
