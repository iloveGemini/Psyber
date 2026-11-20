import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/models/models.dart';
import '../../../core/network/api_client.dart';
import '../../../core/state/app_controller.dart';
import '../../../expression/expression_renderer.dart';
import '../../../shared/theme.dart';
import 'widgets/recall_feedback_bar.dart';
import 'widgets/thinking_card.dart';

/// Ring 1 主聊天页：
/// - 仅在 paused/hidden 切后台时静默中止 SSE、回前台合并重连不弹红条（桌面失焦 inactive 不断流）
/// - 门状态顶栏与门缝纸条输入框自适应切换
/// - ListView.builder 虚拟化时间线 + 顶部按需分页加载 + 独立流式轮次槽（防整页高频重绘）
/// - 基础 ExpressionRenderer（色温光罩 + 触觉 + 气泡微动效 + 贴纸/附件图片渲染）
/// - 默认关闭、按需开启的召回标注浮条
class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.controller,
  });

  final AppController controller;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with WidgetsBindingObserver {
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  bool _sending = false;
  bool _loadingOlder = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.expressionNotifier.addListener(_onExpression);
  }

  void _onExpression() {
    final expr = widget.controller.expressionNotifier.value;
    if (expr?.haptic != null) {
      unawaited(triggerExpressionHaptic(expr!.haptic));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 仅真正切入后台（paused/hidden）时中断 SSE，避免桌面窗口失焦或系统弹窗（inactive）频繁断流
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      widget.controller.onAppPaused();
    } else if (state == AppLifecycleState.resumed) {
      widget.controller.onAppResumed();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.expressionNotifier.removeListener(_onExpression);
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _inputController.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.controller.sendMessage(text);
      _inputController.clear();
      _scrollToBottom();
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '发送失败，请检查网络连接后重试';
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _loadOlder() async {
    if (_loadingOlder || !widget.controller.hasMoreHistory) return;
    setState(() => _loadingOlder = true);
    try {
      await widget.controller.loadOlderHistory();
    } finally {
      if (mounted) setState(() => _loadingOlder = false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      unawaited(
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        ),
      );
    });
  }

  void _openSettingsSheet() {
    unawaited(
      showModalBottomSheet<void>(
        context: context,
        backgroundColor: PsyberTheme.paperCard,
        builder: (ctx) => Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '客户端设置',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
              ValueListenableBuilder<bool>(
                valueListenable: widget.controller.recallEvalModeNotifier,
                builder: (context, enabled, _) => SwitchListTile(
                  key: const Key('recall_eval_switch'),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('召回评测模式'),
                  subtitle: const Text('开启后在助手回复下方显示「想起 N 张卡」标注入口'),
                  value: enabled,
                  onChanged: widget.controller.toggleRecallEvalMode,
                ),
              ),
              const Divider(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.link_off),
                title: const Text('断开连接并重新配对'),
                onTap: () async {
                  Navigator.of(ctx).pop();
                  await widget.controller.disconnect();
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
    return Scaffold(
      appBar: AppBar(
        title: ValueListenableBuilder<DoorStatus>(
          valueListenable: widget.controller.doorNotifier,
          builder: (context, door, _) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Psyber', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  _DoorBadge(door: door),
                ],
              ),
              if (door.note != null && door.note!.trim().isNotEmpty)
                Text(
                  door.note!,
                  style: const TextStyle(fontSize: 12, color: PsyberTheme.inkMuted),
                  overflow: TextOverflow.ellipsis,
                ),
            ],
          ),
        ),
        actions: [
          ValueListenableBuilder<bool>(
            valueListenable: widget.controller.showReconnectingHintNotifier,
            builder: (context, showHint, _) {
              if (!showHint) return const SizedBox.shrink();
              return const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: Center(
                  child: Text(
                    '正在重新连接…',
                    key: Key('gentle_reconnecting_hint'),
                    style: TextStyle(fontSize: 12, color: PsyberTheme.inkMuted),
                  ),
                ),
              );
            },
          ),
          IconButton(
            key: const Key('settings_button'),
            tooltip: '设置',
            icon: const Icon(Icons.tune),
            onPressed: _openSettingsSheet,
          ),
        ],
      ),
      body: ValueListenableBuilder<ExpressionPayload?>(
        valueListenable: widget.controller.expressionNotifier,
        builder: (context, expr, child) => AtmosphereOverlay(
          atmosphere: expr?.atmosphere,
          child: child!,
        ),
        child: Column(
          children: [
            ValueListenableBuilder<String?>(
              valueListenable: widget.controller.turnErrorNotifier,
              builder: (context, err, _) {
                if (err == null || err.isEmpty) return const SizedBox.shrink();
                return Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  color: const Color(0xFFF6E7E2),
                  child: Text(
                    err,
                    key: const Key('turn_error_banner'),
                    style: const TextStyle(fontSize: 13, color: Color(0xFF7D362B)),
                  ),
                );
              },
            ),
            Expanded(
              child: ValueListenableBuilder<List<TimelineItem>>(
                valueListenable: widget.controller.timelineNotifier,
                builder: (context, items, _) {
                  final hasMore = widget.controller.hasMoreHistory;
                  final headerCount = hasMore ? 1 : 0;
                  return ValueListenableBuilder<bool>(
                    valueListenable: widget.controller.recallEvalModeNotifier,
                    builder: (context, evalEnabled, _) {
                      return ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                        itemCount: headerCount + items.length + 1,
                        itemBuilder: (context, index) {
                          if (hasMore && index == 0) {
                            return Center(
                              child: TextButton(
                                key: const Key('load_older_history_button'),
                                onPressed: _loadingOlder ? null : _loadOlder,
                                child: Text(_loadingOlder ? '加载中…' : '加载更早消息'),
                              ),
                            );
                          }
                          final msgIndex = index - headerCount;
                          if (msgIndex == items.length) {
                            // 流式回复槽独立监听，避免高频 turn.text 触发历史列表重绘
                            return ValueListenableBuilder<ActiveTurnState?>(
                              valueListenable: widget.controller.activeTurnNotifier,
                              builder: (context, active, _) {
                                if (active == null) return const SizedBox.shrink();
                                return _StreamingAssistantBubble(
                                  active: active,
                                  onAbort: widget.controller.abortActiveTurn,
                                );
                              },
                            );
                          }
                          final item = items[msgIndex];
                          return _MessageBubble(
                            item: item,
                            controller: widget.controller,
                            showRecallBar: evalEnabled,
                          );
                        },
                      );
                    },
                  );
                },
              ),
            ),
            ValueListenableBuilder<DoorStatus>(
              valueListenable: widget.controller.doorNotifier,
              builder: (context, door, _) => _AdaptiveComposer(
                door: door,
                controller: _inputController,
                sending: _sending,
                onSend: _send,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DoorBadge extends StatelessWidget {
  const _DoorBadge({required this.door});

  final DoorStatus door;

  @override
  Widget build(BuildContext context) {
    final label = switch (door.state) {
      DoorState.open => '门开着',
      DoorState.quiet => '想静一静',
      DoorState.closed => '门关着',
      DoorState.coolingOff => '冷静中',
      DoorState.departed => '已离开',
    };
    return Container(
      key: const Key('door_state_badge'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: door.state.isDoorNoteMode ? PsyberTheme.doorNotePaper : PsyberTheme.paperCard,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: PsyberTheme.hairline),
      ),
      child: Text(
        label,
        style: const TextStyle(fontSize: 11.5, color: PsyberTheme.inkMuted),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.item,
    required this.controller,
    required this.showRecallBar,
  });

  final TimelineItem item;
  final AppController controller;
  final bool showRecallBar;

  @override
  Widget build(BuildContext context) {
    final isUser = item.isUser;
    final profile = controller.profileNotifier.value;
    final bgColor = item.isDoorNote
        ? PsyberTheme.doorNotePaper
        : isUser
            ? PsyberTheme.userBubble
            : PsyberTheme.paperCard;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: PsyberTheme.hairline),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (item.isDoorNote)
                const Padding(
                  padding: EdgeInsets.only(bottom: 4),
                  child: Text(
                    '门缝纸条',
                    style: TextStyle(fontSize: 11, color: PsyberTheme.inkMuted),
                  ),
                ),
              if (item.isAssistant && (item.thinking?.isNotEmpty ?? false))
                ThinkingCard(thinking: item.thinking!, isStreaming: false),
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
                              style: const TextStyle(fontSize: 13, color: PsyberTheme.accentWarm),
                            ),
                          ),
                        )
                      : Text(
                          '[贴纸：${item.sticker!.label}]',
                          style: const TextStyle(fontSize: 13, color: PsyberTheme.accentWarm),
                        ),
                ),
              if (item.attachments.isNotEmpty && profile != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final hash in item.attachments)
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: Image.network(
                            profile.resolveMediaUrl('/api/v1/media/$hash'),
                            headers: {'Authorization': 'Bearer ${profile.token}'},
                            width: 140,
                            height: 140,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => Container(
                              width: 100,
                              height: 60,
                              color: PsyberTheme.paperCanvas,
                              alignment: Alignment.center,
                              child: const Text('图片已过期', style: TextStyle(fontSize: 11)),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              if (item.content.isNotEmpty)
                SelectableText(
                  item.content,
                  style: const TextStyle(
                    fontSize: 15,
                    height: 1.5,
                    color: PsyberTheme.inkPrimary,
                  ),
                ),
              if (showRecallBar &&
                  item.isAssistant &&
                  item.turnId != null &&
                  (item.recallCount ?? 0) > 0)
                RecallFeedbackBar(
                  controller: controller,
                  turnId: item.turnId!,
                  recallCount: item.recallCount!,
                ),
              Align(
                alignment: Alignment.centerRight,
                child: IconButton(
                  key: Key('delete_msg_${item.id}'),
                  icon: const Icon(Icons.delete_outline, size: 15, color: PsyberTheme.inkMuted),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                  tooltip: '删除消息',
                  onPressed: () => unawaited(controller.deleteMessage(item.id)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StreamingAssistantBubble extends StatelessWidget {
  const _StreamingAssistantBubble({
    required this.active,
    required this.onAbort,
  });

  final ActiveTurnState active;
  final Future<void> Function() onAbort;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: MotionBubbleWrapper(
          motion: active.latestExpression?.motion,
          child: Container(
            key: const Key('streaming_bubble'),
            margin: const EdgeInsets.symmetric(vertical: 6),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: PsyberTheme.paperCard,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: PsyberTheme.hairline),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (active.thinking.isNotEmpty)
                  ThinkingCard(thinking: active.thinking, isStreaming: true),
                if (active.text.isNotEmpty)
                  Text(
                    active.text,
                    style: const TextStyle(
                      fontSize: 15,
                      height: 1.5,
                      color: PsyberTheme.inkPrimary,
                    ),
                  )
                else
                  const Text(
                    '…',
                    style: TextStyle(color: PsyberTheme.inkMuted),
                  ),
                const SizedBox(height: 6),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    key: const Key('abort_turn_button'),
                    onPressed: () => unawaited(onAbort()),
                    icon: const Icon(Icons.stop_circle_outlined, size: 16),
                    label: const Text('停止生成', style: TextStyle(fontSize: 12)),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AdaptiveComposer extends StatelessWidget {
  const _AdaptiveComposer({
    required this.door,
    required this.controller,
    required this.sending,
    required this.onSend,
  });

  final DoorStatus door;
  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    if (door.state.isReadOnly) {
      return Container(
        key: const Key('departed_readonly_banner'),
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: const BoxDecoration(
          color: PsyberTheme.paperCard,
          border: Border(top: BorderSide(color: PsyberTheme.hairline)),
        ),
        child: const Text(
          '这段陪伴已停留在纪念只读状态',
          textAlign: TextAlign.center,
          style: TextStyle(color: PsyberTheme.inkMuted, fontSize: 13),
        ),
      );
    }

    final isDoorNote = door.state.isDoorNoteMode;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        decoration: BoxDecoration(
          color: isDoorNote ? PsyberTheme.doorNotePaper : PsyberTheme.paperCard,
          border: const Border(top: BorderSide(color: PsyberTheme.hairline)),
        ),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('chat_input_field'),
                controller: controller,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  hintText: isDoorNote ? '从门缝塞一张纸条（不会打扰对方）…' : '说点什么…',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(color: PsyberTheme.hairline),
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(
              key: const Key('chat_send_button'),
              onPressed: sending ? null : onSend,
              child: Text(isDoorNote ? '塞纸条' : '发送'),
            ),
          ],
        ),
      ),
    );
  }
}
