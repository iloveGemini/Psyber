import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/media/image_picker.dart';
import '../../../core/models/models.dart';
import '../../../core/network/api_client.dart';
import '../../../core/state/app_controller.dart';
import '../../../expression/expression_renderer.dart';
import '../../../shared/theme.dart';
import '../activities/activity_banner_slot.dart' show ActivityBannerSlot;
import '../settings/settings_panel.dart';
import 'widgets/adaptive_composer.dart';
import 'widgets/app_drawers.dart';
import 'widgets/door_threshold_bar.dart';
import 'widgets/sticker_picker_sheet.dart';
import 'widgets/timeline_items.dart';

/// 主聊天室页面：
/// - 门楣顶栏（实时门态、门牌便签展开、活动胶囊与设置入口）
/// - Ring 1.5 活动伴看浮栏槽（日常零占位）
/// - 居中窄阅读列（680px）+ 悬停/长按消息菜单 + 局部流式轮次槽 + 回到底部胶囊
/// - 宽屏（>= 920px）右侧滑出设置栏，窄屏推入独立设置页
class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.controller,
    this.imagePicker,
  });

  final AppController controller;
  final ImageFilePicker? imagePicker;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with WidgetsBindingObserver {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final List<PendingAttachment> _pendingAttachments = <PendingAttachment>[];

  bool _sending = false;
  bool _uploadingImage = false;
  bool _loadingOlder = false;
  bool _showDesktopSettings = false;
  bool _showScrollToBottom = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.expressionNotifier.addListener(_onExpression);
    _scrollController.addListener(_onScroll);
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final distFromBottom =
        _scrollController.position.maxScrollExtent - _scrollController.offset;
    final shouldShow = distFromBottom > 240;
    if (shouldShow != _showScrollToBottom) {
      setState(() => _showScrollToBottom = shouldShow);
    }
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
    _scrollController.removeListener(_onScroll);
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _inputController.text.trim();
    if ((text.isEmpty && _pendingAttachments.isEmpty) || _sending) return;
    setState(() => _sending = true);
    try {
      final attachmentHashes =
          _pendingAttachments.map((a) => a.hash).toList(growable: false);
      await widget.controller.sendMessage(
        text,
        attachments: attachmentHashes.isEmpty ? null : attachmentHashes,
      );
      _inputController.clear();
      if (mounted) {
        setState(() => _pendingAttachments.clear());
      }
      _scrollToBottom();
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '发送失败，请检查网络连接后重试';
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _pickAndUploadImage() async {
    if (_uploadingImage) return;
    setState(() => _uploadingImage = true);
    try {
      final picker = widget.imagePicker ?? defaultPlatformImagePicker;
      final picked = await picker();
      if (picked == null || !mounted) return;
      final uploaded = await widget.controller.uploadImage(
        bytes: picked.bytes,
        filename: picked.filename,
        mimeType: picked.mimeType,
      );
      if (uploaded == null || !mounted) return;
      setState(() {
        _pendingAttachments.add(
          PendingAttachment(
            hash: uploaded.hash,
            filename: picked.filename,
            bytes: picked.bytes,
          ),
        );
      });
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '图片上传失败，请稍后重试';
    } finally {
      if (mounted) setState(() => _uploadingImage = false);
    }
  }

  Future<void> _sendSticker(StickerView sticker) async {
    if (_sending) return;
    setState(() => _sending = true);
    try {
      await widget.controller.sendMessage('', stickerId: sticker.id);
      _scrollToBottom();
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '发送贴纸失败，请稍后重试';
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _openStickerSheet() {
    final stickersFuture = widget.controller.loadStickers();
    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => StickerPickerDialog(
          stickersFuture: stickersFuture,
          profile: widget.controller.profileNotifier.value,
          onSelect: (sticker) => unawaited(_sendSticker(sticker)),
        ),
      ),
    );
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

  void _toggleSettings() {
    final wide = MediaQuery.sizeOf(context).width >= PsyberTheme.desktopBreakpoint;
    if (wide) {
      setState(() => _showDesktopSettings = !_showDesktopSettings);
      return;
    }
    unawaited(
      Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => SettingsPage(
            controller: widget.controller,
            imagePicker: widget.imagePicker,
          ),
        ),
      ),
    );
  }

  bool _shouldShowDateDivider(List<TimelineItem> items, int index) {
    if (index == 0) return items[0].createdAt > 0;
    final prev = items[index - 1].createdAt;
    final curr = items[index].createdAt;
    if (prev <= 0 || curr <= 0) return false;
    final prevDt = DateTime.fromMillisecondsSinceEpoch(prev).toLocal();
    final currDt = DateTime.fromMillisecondsSinceEpoch(curr).toLocal();
    if (prevDt.year != currDt.year ||
        prevDt.month != currDt.month ||
        prevDt.day != currDt.day) {
      return true;
    }
    return curr - prev >= 30 * 60 * 1000;
  }

  String? _findLatestUserMessageId(List<TimelineItem> items) {
    for (var i = items.length - 1; i >= 0; i--) {
      if (items[i].isUser) return items[i].id;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isWide = MediaQuery.sizeOf(context).width >= PsyberTheme.desktopBreakpoint;

    return Scaffold(
      key: _scaffoldKey,
      drawer: LeftArchiveDrawer(
        controller: widget.controller,
        onOpenSettings: _toggleSettings,
        imagePicker: widget.imagePicker,
      ),
      endDrawer: RightActivityDrawer(
        controller: widget.controller,
      ),
      body: Row(
        children: [
          Expanded(
            child: Column(
              children: [
                ValueListenableBuilder<DoorStatus>(
                  valueListenable: widget.controller.doorNotifier,
                  builder: (context, door, _) => ValueListenableBuilder<bool>(
                    valueListenable: widget.controller.showReconnectingHintNotifier,
                    builder: (context, showHint, _) =>
                        ValueListenableBuilder<SettingsSnapshot?>(
                      valueListenable: widget.controller.settingsNotifier,
                      builder: (context, settings, _) =>
                          ValueListenableBuilder<ActivitySessionView?>(
                        valueListenable: widget.controller.activeActivityNotifier,
                        builder: (context, activity, _) => DoorThresholdBar(
                          door: door,
                          showReconnectingHint: showHint,
                          settings: settings,
                          activeActivity: activity,
                          onOpenLeftDrawer: () => _scaffoldKey.currentState?.openDrawer(),
                          onOpenRightDrawer: () => _scaffoldKey.currentState?.openEndDrawer(),
                          onOpenSettings: _toggleSettings,
                        ),
                      ),
                    ),
                  ),
                ),
                ValueListenableBuilder<ActivitySessionView?>(
                  valueListenable: widget.controller.activeActivityNotifier,
                  builder: (context, activity, _) {
                    if (activity == null) return const SizedBox.shrink();
                    return ActivityBannerSlot(
                      session: activity,
                      profile: widget.controller.profileNotifier.value,
                      onEndActivity: widget.controller.endActiveCinema,
                    );
                  },
                ),
                Expanded(
                  child: ValueListenableBuilder<ExpressionPayload?>(
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
                            if (err == null || err.isEmpty) {
                              return const SizedBox.shrink();
                            }
                            return Container(
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 16,
                                vertical: 9,
                              ),
                              color: PsyberTheme.dangerSoft,
                              child: Center(
                                child: ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: PsyberTheme.readingMaxWidth,
                                  ),
                                  child: Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          err,
                                          key: const Key('turn_error_banner'),
                                          style: const TextStyle(
                                            fontSize: 13,
                                            color: PsyberTheme.dangerInk,
                                          ),
                                        ),
                                      ),
                                      IconButton(
                                        icon: const Icon(
                                          PhosphorIconsLight.x,
                                          size: 16,
                                          color: PsyberTheme.dangerInk,
                                        ),
                                        padding: EdgeInsets.zero,
                                        constraints: const BoxConstraints(
                                          minWidth: 24,
                                          minHeight: 24,
                                        ),
                                        onPressed: () =>
                                            widget.controller.turnErrorNotifier.value = null,
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
                        Expanded(
                          child: Stack(
                            children: [
                              ValueListenableBuilder<List<TimelineItem>>(
                                valueListenable: widget.controller.timelineNotifier,
                                builder: (context, items, _) {
                                  final hasMore = widget.controller.hasMoreHistory;
                                  final headerCount = hasMore ? 1 : 0;
                                  final latestUserId = _findLatestUserMessageId(items);
                                  return ValueListenableBuilder<bool>(
                                    valueListenable: widget.controller.recallEvalModeNotifier,
                                    builder: (context, evalEnabled, _) {
                                      return ValueListenableBuilder<DoorStatus>(
                                        valueListenable: widget.controller.doorNotifier,
                                        builder: (context, door, _) {
                                          return ListView.builder(
                                            controller: _scrollController,
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 16,
                                              vertical: 14,
                                            ),
                                            itemCount: headerCount + items.length + 1,
                                            itemBuilder: (context, index) {
                                              if (hasMore && index == 0) {
                                                return Center(
                                                  child: TextButton(
                                                    key: const Key('load_older_history_button'),
                                                    onPressed: _loadingOlder ? null : _loadOlder,
                                                    child: Text(
                                                      _loadingOlder ? '加载中…' : '加载更早消息',
                                                    ),
                                                  ),
                                                );
                                              }
                                              final msgIndex = index - headerCount;
                                              if (msgIndex == items.length) {
                                                return ValueListenableBuilder<ActiveTurnState?>(
                                                  valueListenable:
                                                      widget.controller.activeTurnNotifier,
                                                  builder: (context, active, _) {
                                                    if (active == null) {
                                                      if (items.isEmpty) {
                                                        return Padding(
                                                          padding: const EdgeInsets.only(top: 96),
                                                          child: _EmptyRoomState(door: door),
                                                        );
                                                      }
                                                      return const SizedBox.shrink();
                                                    }
                                                    return StreamingAssistantBubble(
                                                      active: active,
                                                      onAbort: widget.controller.abortActiveTurn,
                                                    );
                                                  },
                                                );
                                              }
                                              final item = items[msgIndex];
                                              final showDivider =
                                                  _shouldShowDateDivider(items, msgIndex);

                                              Widget entry;
                                              if (item.isMemoryTask) {
                                                entry = MemoryTaskRow(item: item);
                                              } else if (item.isSystemNotice) {
                                                entry = SystemNoticeRow(item: item);
                                              } else {
                                                entry = MessageBubbleRow(
                                                  item: item,
                                                  controller: widget.controller,
                                                  showRecallBar: evalEnabled,
                                                  isLatestUserMessage: item.id == latestUserId,
                                                  doorState: door.state,
                                                );
                                              }

                                              if (!showDivider) return entry;
                                              return Column(
                                                mainAxisSize: MainAxisSize.min,
                                                children: [
                                                  TimelineDateDivider(epochMs: item.createdAt),
                                                  entry,
                                                ],
                                              );
                                            },
                                          );
                                        },
                                      );
                                    },
                                  );
                                },
                              ),
                              if (_showScrollToBottom)
                                Positioned(
                                  right: 20,
                                  bottom: 14,
                                  child: Material(
                                    color: colors.letterSurface,
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(9),
                                      side: BorderSide(color: colors.hairline),
                                    ),
                                    child: InkWell(
                                      key: const Key('scroll_to_bottom_button'),
                                      borderRadius: BorderRadius.circular(9),
                                      onTap: _scrollToBottom,
                                      child: Padding(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 12,
                                          vertical: 6,
                                        ),
                                        child: Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Icon(
                                              PhosphorIconsLight.arrowDown,
                                              size: 14,
                                              color: colors.inkDeep,
                                            ),
                                            const SizedBox(width: 4),
                                            Text(
                                              '回到底部',
                                              style: TextStyle(
                                                fontSize: 12,
                                                fontWeight: FontWeight.w500,
                                                color: colors.inkDeep,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                        ValueListenableBuilder<DoorStatus>(
                          valueListenable: widget.controller.doorNotifier,
                          builder: (context, door, _) => AdaptiveComposer(
                            door: door,
                            controller: _inputController,
                            pendingAttachments: _pendingAttachments,
                            uploadingImage: _uploadingImage,
                            sending: _sending,
                            onPickImage: _pickAndUploadImage,
                            onOpenStickers: _openStickerSheet,
                            onRemoveAttachment: (idx) {
                              setState(() => _pendingAttachments.removeAt(idx));
                            },
                            onSend: _send,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (isWide && _showDesktopSettings)
            Container(
              width: 372,
              decoration: BoxDecoration(
                color: colors.mineralCanvas,
                border: Border(left: BorderSide(color: colors.hairline)),
              ),
              child: SettingsPanelContent(
                controller: widget.controller,
                imagePicker: widget.imagePicker,
                onClose: () => setState(() => _showDesktopSettings = false),
              ),
            ),
        ],
      ),
    );
  }
}

class _EmptyRoomState extends StatelessWidget {
  const _EmptyRoomState({required this.door});

  final DoorStatus door;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              door.state.isDoorNoteMode ? '门关着，屋里安静得很。' : '门刚推开，屋里还没落笔。',
              style: PsyberTheme.editorialSerif.copyWith(
                fontSize: 17,
                color: PsyberTheme.inkQuiet,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              door.state.isDoorNoteMode
                  ? '可以在下方塞一张纸条，等对方想看的时候再看。'
                  : '随便打个招呼，或者先送一张贴纸开始认识。',
              style: const TextStyle(fontSize: 13, color: PsyberTheme.inkFaint),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
