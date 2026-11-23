import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/media/desktop_media.dart';
import '../../../core/media/image_picker.dart';
import '../../../core/models/models.dart';
import '../../../core/network/api_client.dart';
import '../../../core/state/app_controller.dart';
import '../../../expression/expression_renderer.dart';
import '../../../shared/paper_grain.dart';
import '../../../shared/theme.dart';
import '../activities/activity_banner_slot.dart' show ActivityBannerSlot;
import '../settings/settings_panel.dart';
import 'widgets/adaptive_composer.dart';
import 'widgets/app_drawers.dart';
import 'widgets/door_threshold_bar.dart';
import 'widgets/failure_line.dart';
import 'widgets/silence_line.dart';
import 'widgets/sticker_picker_sheet.dart';
import 'widgets/timeline_items.dart';

/// 主聊天室页面：
/// - 门楣顶栏（实时门态、门牌便签展开、活动胶囊）
/// - Ring 1.5 活动伴看浮栏槽（日常零占位）
/// - 居中窄阅读列（680px）+ 悬停/长按消息菜单 + 局部流式轮次槽 + 回到底部胶囊
/// - 宽屏（>= 920px）居中双栏设置弹层，窄屏推入全屏两级设置页
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
  final _rightActivityAnchorKey = GlobalKey();
  final _inputController = TextEditingController();
  final _scrollController = ScrollController();
  final List<PendingAttachment> _pendingAttachments = <PendingAttachment>[];
  PendingVideoClip? _pendingVideoClip;
  StickerView? _pendingSticker;

  bool _sending = false;
  bool _uploadingImage = false;
  bool _loadingOlder = false;
  bool _showDesktopSidebar = true;
  bool _settingsDialogOpen = false;
  bool _showScrollToBottom = false;
  bool _isDraggingFiles = false;
  bool _autoScrollScheduled = false;
  double _lastBottomInset = 0.0;
  String _lastSavedDraft = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.expressionNotifier.addListener(_onExpression);
    widget.controller.activeTurnNotifier.addListener(_onStreamOrTimelineUpdated);
    widget.controller.timelineNotifier.addListener(_onStreamOrTimelineUpdated);
    _scrollController.addListener(_onScroll);
    _inputController.addListener(_onDraftChanged);
    unawaited(_restoreDraft());
    DesktopMediaBridge.listenDropEvents(
      onDragStateChanged: (active) {
        if (!mounted || active == _isDraggingFiles) return;
        setState(() => _isDraggingFiles = active);
      },
      onFilesDropped: (paths) {
        if (!mounted) return;
        setState(() => _isDraggingFiles = false);
        unawaited(_handleDesktopPaths(paths));
      },
    );
  }

  Future<void> _restoreDraft() async {
    final draft = await widget.controller.loadDraft();
    if (!mounted || draft.isEmpty || _inputController.text.isNotEmpty) return;
    _lastSavedDraft = draft;
    _inputController.value = TextEditingValue(
      text: draft,
      selection: TextSelection.collapsed(offset: draft.length),
    );
  }

  void _onDraftChanged() {
    final text = _inputController.text;
    if (text == _lastSavedDraft) return;
    _lastSavedDraft = text;
    unawaited(widget.controller.saveDraft(text));
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

  /// 当用户停留在底部附近时，随流式生成或新消息到来自动轻滑贴底，避免正文长出视口外。
  void _onStreamOrTimelineUpdated() {
    if (!mounted || !_scrollController.hasClients || _showScrollToBottom) return;
    final distFromBottom =
        _scrollController.position.maxScrollExtent - _scrollController.offset;
    if (distFromBottom > 160 || _autoScrollScheduled) return;
    _autoScrollScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _autoScrollScheduled = false;
      if (!mounted || !_scrollController.hasClients || _showScrollToBottom) return;
      final maxExtent = _scrollController.position.maxScrollExtent;
      if (_scrollController.offset < maxExtent) {
        _scrollController.jumpTo(maxExtent);
      }
    });
  }

  @override
  void didChangeMetrics() {
    super.didChangeMetrics();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
      final delta = bottomInset - _lastBottomInset;
      _lastBottomInset = bottomInset;
      if (delta > 0 && _scrollController.hasClients) {
        final maxExtent = _scrollController.position.maxScrollExtent;
        final target = !_showScrollToBottom
            ? maxExtent
            : (_scrollController.offset + delta).clamp(0.0, maxExtent);
        if ((target - _scrollController.offset).abs() > 0.5) {
          _scrollController.jumpTo(target);
        }
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 窗口失焦（inactive）或切后台（paused/hidden）时暂缓消费新动作，切回前台后再播放
    widget.controller.setAppForeground(state == AppLifecycleState.resumed);
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
    widget.controller.activeTurnNotifier.removeListener(_onStreamOrTimelineUpdated);
    widget.controller.timelineNotifier.removeListener(_onStreamOrTimelineUpdated);
    _scrollController.removeListener(_onScroll);
    _inputController.removeListener(_onDraftChanged);
    DesktopMediaBridge.clearDropEvents();
    _inputController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _send({bool urgent = false}) async {
    final text = _inputController.text.trim();
    if ((text.isEmpty &&
            _pendingAttachments.isEmpty &&
            _pendingVideoClip == null &&
            _pendingSticker == null) ||
        _sending) {
      return;
    }
    setState(() => _sending = true);
    try {
      final frameHashes = _pendingVideoClip?.frameHashes ?? const <String>[];
      final attachmentHashes = <String>[
        ..._pendingAttachments.map((a) => a.hash),
        ...frameHashes,
      ];
      final videoClip = _pendingVideoClip == null
          ? null
          : VideoClipInfo(
              durationSec: _pendingVideoClip!.durationSec,
              frameHashes: _pendingVideoClip!.frameHashes,
            );
      await widget.controller.sendMessage(
        text,
        attachments: attachmentHashes.isEmpty ? null : attachmentHashes,
        stickerId: _pendingSticker?.id,
        videoClip: videoClip,
        urgent: urgent,
      );
      _lastSavedDraft = '';
      _inputController.clear();
      unawaited(widget.controller.saveDraft(''));
      if (mounted) {
        setState(() {
          _pendingAttachments.clear();
          _pendingVideoClip = null;
          _pendingSticker = null;
        });
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

  Future<void> _handlePickedOrDroppedFile(PickedImage picked) async {
    if (picked.isVideo) {
      final path = picked.localPath;
      if (path == null || path.isEmpty || !DesktopMediaBridge.isSupported) {
        widget.controller.turnErrorNotifier.value =
            '当前平台暂不支持自动抽帧短视频，请优先发送截图或图片';
        return;
      }
      final clip = await DesktopMediaBridge.extractVideoFrames(path);
      if (clip == null || clip.frames.isEmpty) {
        widget.controller.turnErrorNotifier.value =
            '短视频读取失败，请确认格式为 mp4 / mov / m4v';
        return;
      }
      final frameHashes = <String>[];
      for (var i = 0; i < clip.frames.length; i++) {
        final uploaded = await widget.controller.uploadImage(
          bytes: clip.frames[i],
          filename: 'video_frame_${i + 1}.jpg',
          mimeType: 'image/jpeg',
        );
        if (uploaded != null) {
          frameHashes.add(uploaded.hash);
        }
      }
      if (!mounted || frameHashes.isEmpty) return;
      setState(() {
        _pendingVideoClip = PendingVideoClip(
          durationSec: clip.durationSec,
          frameHashes: frameHashes,
          filename: clip.filename,
          previewBytes: clip.frames.first,
        );
      });
      return;
    }

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
  }

  Future<void> _handleDesktopPaths(List<String> paths) async {
    if (_uploadingImage || paths.isEmpty) return;
    setState(() => _uploadingImage = true);
    try {
      for (final path in paths) {
        final picked = await loadPickedFileFromPath(path);
        if (picked == null || !mounted) continue;
        await _handlePickedOrDroppedFile(picked);
      }
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '媒体文件上传失败，请稍后重试';
    } finally {
      if (mounted) setState(() => _uploadingImage = false);
    }
  }

  Future<bool> _handleDesktopPaste() async {
    final clip = await DesktopMediaBridge.readClipboardMedia();
    if (clip == null) return false;
    if (clip.image != null) {
      if (!_uploadingImage) {
        setState(() => _uploadingImage = true);
        try {
          await _handlePickedOrDroppedFile(clip.image!);
        } on ApiException catch (e) {
          widget.controller.turnErrorNotifier.value = e.message;
        } catch (_) {
          widget.controller.turnErrorNotifier.value = '剪贴板图片上传失败，请稍后重试';
        } finally {
          if (mounted) setState(() => _uploadingImage = false);
        }
      }
      return true;
    }
    final mediaPaths = clip.filePaths
        .where((p) => isImageFilename(p) || isVideoFilename(p))
        .toList(growable: false);
    if (mediaPaths.isNotEmpty) {
      await _handleDesktopPaths(mediaPaths);
      return true;
    }
    return false;
  }

  Future<void> _pickAndUploadImage() async {
    if (_uploadingImage) return;
    setState(() => _uploadingImage = true);
    try {
      final picker = widget.imagePicker ?? defaultPlatformImagePicker;
      final picked = await picker();
      if (picked == null || !mounted) return;
      await _handlePickedOrDroppedFile(picked);
    } on ApiException catch (e) {
      widget.controller.turnErrorNotifier.value = e.message;
    } catch (_) {
      widget.controller.turnErrorNotifier.value = '图片上传失败，请稍后重试';
    } finally {
      if (mounted) setState(() => _uploadingImage = false);
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
          onSelect: (sticker) {
            if (!mounted) return;
            setState(() => _pendingSticker = sticker);
          },
          onUploadSticker: () => unawaited(
            showStickerUploadDialog(
              context,
              controller: widget.controller,
              imagePicker: widget.imagePicker,
            ),
          ),
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

  void _openSettings({SettingsSection? initialSection}) {
    final wide = MediaQuery.sizeOf(context).width >= PsyberTheme.desktopBreakpoint;
    if (wide) {
      if (_settingsDialogOpen) {
        Navigator.of(context, rootNavigator: true).maybePop();
        return;
      }
      _settingsDialogOpen = true;
      unawaited(
        showSettingsDialog(
          context,
          controller: widget.controller,
          imagePicker: widget.imagePicker,
          initialSection: initialSection ?? SettingsSection.modelUsage,
        ).whenComplete(() {
          _settingsDialogOpen = false;
        }),
      );
      return;
    }
    unawaited(
      Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => SettingsPage(
            controller: widget.controller,
            imagePicker: widget.imagePicker,
            initialSection: initialSection,
          ),
        ),
      ),
    );
  }

  void _toggleSettings() => _openSettings();

  String? _previousAssistantModel(List<TimelineItem> items, int beforeIndex) {
    for (var i = beforeIndex - 1; i >= 0; i--) {
      final prev = items[i];
      if (prev.isAssistant &&
          !prev.isSilence &&
          !prev.isMemoryTask &&
          !prev.isSystemNotice &&
          prev.model != null &&
          prev.model!.isNotEmpty) {
        return prev.model;
      }
    }
    return null;
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

  String? _findLatestAssistantMessageId(List<TimelineItem> items) {
    for (var i = items.length - 1; i >= 0; i--) {
      final item = items[i];
      if (item.isAssistant &&
          !item.retracted &&
          !item.isSilence &&
          !item.isMemoryTask &&
          !item.isSystemNotice &&
          !item.isShareOpened) {
        return item.id;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isWide = MediaQuery.sizeOf(context).width >= PsyberTheme.desktopBreakpoint;
    final isMacOs = !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        SingleActivator(
          LogicalKeyboardKey.comma,
          meta: isMacOs,
          control: !isMacOs,
        ): _toggleSettings,
        SingleActivator(
          LogicalKeyboardKey.backslash,
          meta: isMacOs,
          control: !isMacOs,
        ): () {
          if (isWide) {
            setState(() => _showDesktopSidebar = !_showDesktopSidebar);
          }
        },

      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          key: _scaffoldKey,
          drawer: isWide
              ? null
              : LeftArchiveDrawer(
                  controller: widget.controller,
                  onOpenSettings: _toggleSettings,
                  imagePicker: widget.imagePicker,
                ),
          endDrawer: isWide
              ? null
              : RightActivityDrawer(
                  controller: widget.controller,
                ),
          body: Row(
            children: [
              if (isWide && _showDesktopSidebar)
                LeftArchiveSidebar(
                  controller: widget.controller,
                  onOpenSettings: _toggleSettings,
                  onCollapse: () => setState(() => _showDesktopSidebar = false),
                  imagePicker: widget.imagePicker,
                ),
              Expanded(
                child: Stack(
                  children: [
                    if (colors.hasPaperGrain)
                      Positioned.fill(
                        child: PaperGrainOverlay(
                          isDark: colors.isDark,
                          edgeTint: colors.pageEdgeTint,
                        ),
                      ),
                    Column(
                      children: [
                if (isWide)
                  ValueListenableBuilder<bool>(
                    valueListenable: widget.controller.showReconnectingHintNotifier,
                    builder: (context, showHint, _) {
                      if (!showHint) return const SizedBox.shrink();
                      return Container(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        alignment: Alignment.center,
                        child: Text(
                          '正在重新连接…',
                          key: const Key('gentle_reconnecting_hint'),
                          style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                        ),
                      );
                    },
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
                              color: colors.dangerSoft,
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
                                          style: TextStyle(
                                            fontSize: 13,
                                            color: colors.dangerInk,
                                          ),
                                        ),
                                      ),
                                      ValueListenableBuilder<bool>(
                                        valueListenable:
                                            widget.controller.instanceMismatchNotifier,
                                        builder: (context, mismatch, _) {
                                          if (!mismatch) return const SizedBox.shrink();
                                          return Padding(
                                            padding: const EdgeInsets.only(right: 4),
                                            child: TextButton(
                                              key: const Key('mismatch_repair_button'),
                                              style: TextButton.styleFrom(
                                                foregroundColor: colors.dangerInk,
                                                padding: const EdgeInsets.symmetric(
                                                  horizontal: 10,
                                                  vertical: 4,
                                                ),
                                                minimumSize: Size.zero,
                                                tapTargetSize:
                                                    MaterialTapTargetSize.shrinkWrap,
                                              ),
                                              onPressed: () => unawaited(
                                                widget.controller.disconnect(
                                                  notifyServer: false,
                                                ),
                                              ),
                                              child: const Text(
                                                '重新配对',
                                                style: TextStyle(
                                                  fontSize: 12.5,
                                                  fontWeight: FontWeight.w600,
                                                ),
                                              ),
                                            ),
                                          );
                                        },
                                      ),
                                      IconButton(
                                        icon: Icon(
                                          PhosphorIconsLight.x,
                                          size: 16,
                                          color: colors.dangerInk,
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
                                  final latestAssistantId = _findLatestAssistantMessageId(items);
                                  return ValueListenableBuilder<bool>(
                                    valueListenable: widget.controller.recallEvalModeNotifier,
                                    builder: (context, evalEnabled, _) {
                                      return ValueListenableBuilder<DoorStatus>(
                                        valueListenable: widget.controller.doorNotifier,
                                        builder: (context, door, _) =>
                                            ValueListenableBuilder<IdentityInfo>(
                                          valueListenable: widget.controller.identityNotifier,
                                          builder: (context, identity, _) {
                                            final topListPad = isWide
                                                ? 28.0
                                                : (MediaQuery.paddingOf(context).top + 68.0);
                                            return ListView.builder(
                                              controller: _scrollController,
                                              padding: EdgeInsets.fromLTRB(
                                                16,
                                                topListPad,
                                                16,
                                                28,
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
                                                  builder: (context, active, _) =>
                                                      ValueListenableBuilder<TurnFailureState?>(
                                                    valueListenable: widget
                                                        .controller
                                                        .turnFailureNotifier,
                                                    builder: (context, failure, _) =>
                                                        ValueListenableBuilder<TurnSilenceNotice?>(
                                                      valueListenable: widget
                                                          .controller
                                                          .turnSilenceNotifier,
                                                      builder: (context, silence, _) =>
                                                          ValueListenableBuilder<String?>(
                                                        valueListenable: widget
                                                            .controller
                                                            .pendingModelSwitchNotifier,
                                                        builder: (context, pendingModel, _) {
                                                          final prevModel =
                                                              _previousAssistantModel(
                                                            items,
                                                            items.length,
                                                          );
                                                          if (active != null) {
                                                            final showPendingSwitch =
                                                                pendingModel != null &&
                                                                pendingModel.isNotEmpty &&
                                                                prevModel != pendingModel;
                                                            final bubble =
                                                                ValueListenableBuilder<bool>(
                                                              valueListenable: widget
                                                                  .controller
                                                                  .isAppForegroundNotifier,
                                                              builder: (
                                                                context,
                                                                isForeground,
                                                                _,
                                                              ) =>
                                                                  StreamingAssistantBubble(
                                                                active: active,
                                                                isForeground: isForeground,
                                                                profile: widget
                                                                    .controller
                                                                    .profileNotifier
                                                                    .value,
                                                                onMotionStarted: () => widget
                                                                    .controller
                                                                    .markTurnMotionStarted(
                                                                      active.turnId,
                                                                    ),
                                                                onAbort: widget
                                                                    .controller
                                                                    .abortActiveTurn,
                                                              ),
                                                            );
                                                            if (!showPendingSwitch) {
                                                              return bubble;
                                                            }
                                                            return Column(
                                                              mainAxisSize:
                                                                  MainAxisSize.min,
                                                              children: [
                                                                ModelSwitchDivider(
                                                                  model: pendingModel,
                                                                ),
                                                                bubble,
                                                              ],
                                                            );
                                                          }

                                                          if (items.isEmpty &&
                                                              failure == null &&
                                                              silence == null) {
                                                            return Padding(
                                                              padding:
                                                                  const EdgeInsets.only(
                                                                top: 96,
                                                              ),
                                                              child: _EmptyRoomState(
                                                                door: door,
                                                                residentName: identity.residentName,
                                                              ),
                                                            );
                                                          }
                                                          if (failure == null &&
                                                              silence == null) {
                                                            return const SizedBox
                                                                .shrink();
                                                          }
                                                          return Column(
                                                            mainAxisSize:
                                                                MainAxisSize.min,
                                                            children: [
                                                              if (silence != null)
                                                                SilenceLine(
                                                                  key: Key(
                                                                    'turn_silence_${silence.turnId}',
                                                                  ),
                                                                  seed: silence.turnId,
                                                                  ownTime:
                                                                      silence.ownTime,
                                                                ),
                                                              if (failure != null)
                                                                ValueListenableBuilder<bool>(
                                                                  valueListenable: widget
                                                                      .controller
                                                                      .retryingTurnNotifier,
                                                                  builder: (
                                                                    context,
                                                                    retrying,
                                                                    _,
                                                                  ) =>
                                                                      FailureLine(
                                                                    failure: failure,
                                                                    retrying: retrying,
                                                                    onRetry: widget
                                                                        .controller
                                                                        .retryFailedTurn,
                                                                    onDismiss: () {
                                                                      widget
                                                                          .controller
                                                                          .turnFailureNotifier
                                                                          .value = null;
                                                                    },
                                                                  ),
                                                                ),
                                                            ],
                                                          );
                                                        },
                                                      ),
                                                    ),
                                                  ),
                                                );
                                              }
                                              final item = items[msgIndex];
                                              final showDivider =
                                                  _shouldShowDateDivider(items, msgIndex);
                                              final prevModel =
                                                  _previousAssistantModel(
                                                items,
                                                msgIndex,
                                              );
                                              final showModelSwitch =
                                                  item.isAssistant &&
                                                  !item.isSilence &&
                                                  !item.isMemoryTask &&
                                                  !item.isSystemNotice &&
                                                  item.model != null &&
                                                  item.model!.isNotEmpty &&
                                                  prevModel != null &&
                                                  prevModel != item.model;

                                              Widget entry;
                                              if (item.isShareOpened) {
                                                entry = const SizedBox.shrink();
                                              } else if (item.retracted) {
                                                entry = RetractedMessageRow(
                                                  item: item,
                                                  residentName: identity.residentName,
                                                );
                                              } else if (item.isMemoryTask) {
                                                entry = MemoryTaskRow(item: item);
                                              } else if (item.isSilence) {
                                                entry = SilenceLine(
                                                  key: Key('silence_item_${item.id}'),
                                                  seed: item.id,
                                                  ownTime: item.kind == 'wake' ||
                                                      item.kind == 'silence',
                                                );
                                              } else if (item.isSystemNotice) {
                                                entry = SystemNoticeRow(item: item);
                                              } else {
                                                entry = MessageBubbleRow(
                                                  item: item,
                                                  controller: widget.controller,
                                                  showRecallBar: evalEnabled,
                                                  isLatestUserMessage: item.id == latestUserId,
                                                  isLatestAssistantMessage: item.id == latestAssistantId,
                                                  doorState: door.state,
                                                );
                                              }

                                              if (!showDivider && !showModelSwitch) {
                                                return entry;
                                              }
                                              return Column(
                                                mainAxisSize: MainAxisSize.min,
                                                children: [
                                                  if (showDivider)
                                                    TimelineDateDivider(
                                                      epochMs: item.createdAt,
                                                    ),
                                                  if (showModelSwitch)
                                                    ModelSwitchDivider(
                                                      model: item.model!,
                                                    ),
                                                  entry,
                                                ],
                                              );
                                            },
                                          );
                                          },
                                        ),
                                      );
                                    },
                                  );
                                },
                              ),
                              if (isWide)
                                Positioned(
                                  top: 0,
                                  left: 0,
                                  right: 0,
                                  height: 36,
                                  child: IgnorePointer(
                                    child: DecoratedBox(
                                      decoration: BoxDecoration(
                                        gradient: LinearGradient(
                                          begin: Alignment.topCenter,
                                          end: Alignment.bottomCenter,
                                          colors: [
                                            colors.mineralCanvas,
                                            colors.mineralCanvas.withValues(alpha: 0.8),
                                            colors.mineralCanvas.withValues(alpha: 0.0),
                                          ],
                                          stops: const [0.0, 0.58, 1.0],
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              Positioned(
                                left: 0,
                                right: 0,
                                bottom: 0,
                                height: 22,
                                child: IgnorePointer(
                                  child: DecoratedBox(
                                    decoration: BoxDecoration(
                                      gradient: LinearGradient(
                                        begin: Alignment.topCenter,
                                        end: Alignment.bottomCenter,
                                        colors: [
                                          colors.mineralCanvas.withValues(alpha: 0.0),
                                          colors.mineralCanvas,
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
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
                        ValueListenableBuilder<PendingToolApproval?>(
                          valueListenable: widget.controller.pendingApprovalNotifier,
                          builder: (context, pending, _) {
                            if (pending == null) return const SizedBox.shrink();
                            return Container(
                              key: const Key('tool_approval_card'),
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                              decoration: BoxDecoration(
                                color: colors.accentSoft,
                                border: Border(top: BorderSide(color: colors.accentBorder)),
                              ),
                              child: Center(
                                child: ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: PsyberTheme.readingMaxWidth,
                                  ),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          Icon(
                                            PhosphorIconsLight.shieldCheck,
                                            size: 16,
                                            color: colors.inkDeep,
                                          ),
                                          const SizedBox(width: 6),
                                          Expanded(
                                            child: Text(
                                              '外部工具调用确认 · ${pending.toolName}',
                                              style: TextStyle(
                                                fontSize: 13,
                                                fontWeight: FontWeight.w600,
                                                color: colors.inkDeep,
                                              ),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        ],
                                      ),
                                      if (pending.summary.isNotEmpty) ...[
                                        const SizedBox(height: 4),
                                        Text(
                                          pending.summary,
                                          style: TextStyle(fontSize: 12, color: colors.inkQuiet),
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ],
                                      const SizedBox(height: 8),
                                      Wrap(
                                        spacing: 8,
                                        runSpacing: 6,
                                        children: [
                                          FilledButton(
                                            key: const Key('approval_allow_once_button'),
                                            onPressed: () => unawaited(
                                              widget.controller.respondToApproval(
                                                decision: 'allow',
                                                scope: 'once',
                                              ),
                                            ),
                                            style: FilledButton.styleFrom(
                                              padding: const EdgeInsets.symmetric(
                                                horizontal: 12,
                                                vertical: 6,
                                              ),
                                              minimumSize: Size.zero,
                                            ),
                                            child: const Text('仅本次允许', style: TextStyle(fontSize: 12)),
                                          ),
                                          OutlinedButton(
                                            key: const Key('approval_allow_session_button'),
                                            onPressed: () => unawaited(
                                              widget.controller.respondToApproval(
                                                decision: 'allow',
                                                scope: 'session',
                                              ),
                                            ),
                                            style: OutlinedButton.styleFrom(
                                              padding: const EdgeInsets.symmetric(
                                                horizontal: 12,
                                                vertical: 6,
                                              ),
                                              minimumSize: Size.zero,
                                            ),
                                            child: const Text('本会话允许', style: TextStyle(fontSize: 12)),
                                          ),
                                          TextButton(
                                            key: const Key('approval_deny_button'),
                                            onPressed: () => unawaited(
                                              widget.controller.respondToApproval(
                                                decision: 'deny',
                                              ),
                                            ),
                                            style: TextButton.styleFrom(
                                              padding: const EdgeInsets.symmetric(
                                                horizontal: 10,
                                                vertical: 6,
                                              ),
                                              minimumSize: Size.zero,
                                            ),
                                            child: Text(
                                              '拒绝',
                                              style: TextStyle(
                                                fontSize: 12,
                                                color: colors.dangerInk,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
                        ValueListenableBuilder<bool>(
                          valueListenable: widget.controller.wrappingUpNotifier,
                          builder: (context, wrappingUp, _) {
                            if (!wrappingUp) return const SizedBox.shrink();
                            return Container(
                              key: const Key('rollover_wrapping_banner'),
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 16,
                                vertical: 8,
                              ),
                              decoration: BoxDecoration(
                                color: colors.accentSoft,
                                border: Border(
                                  top: BorderSide(color: colors.hairline),
                                ),
                              ),
                              child: Center(
                                child: ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: PsyberTheme.readingMaxWidth,
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      SizedBox(
                                        width: 12,
                                        height: 12,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 1.8,
                                          color: colors.accent,
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        '正在收拢这段记忆…',
                                        style: TextStyle(
                                          fontSize: 12.5,
                                          color: colors.inkQuiet,
                                          fontWeight: FontWeight.w500,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
                        ValueListenableBuilder<DoorStatus>(
                          valueListenable: widget.controller.doorNotifier,
                          builder: (context, door, _) =>
                              ValueListenableBuilder<ActiveTurnState?>(
                            valueListenable: widget.controller.activeTurnNotifier,
                            builder: (context, activeTurn, _) =>
                                ValueListenableBuilder<SettingsSnapshot?>(
                              valueListenable: widget.controller.settingsNotifier,
                              builder: (context, settingsSnap, _) =>
                                  ValueListenableBuilder<IdentityInfo>(
                                valueListenable: widget.controller.identityNotifier,
                                builder: (context, identity, _) {
                                  final slot = settingsSnap?.chatSlot;
                                  final modelLabel = (slot != null && slot.model.isNotEmpty)
                                      ? '${slot.provider} · ${slot.model}'
                                      : null;
                                  final availableSlots = <ModelSlotView>[];
                                  if (settingsSnap != null) {
                                    for (final entry in settingsSnap.providers.entries) {
                                      for (final m in entry.value.models) {
                                        final trimmed = m.trim();
                                        if (trimmed.isNotEmpty) {
                                          availableSlots.add(
                                            ModelSlotView(
                                              provider: entry.key,
                                              model: trimmed,
                                            ),
                                          );
                                        }
                                      }
                                    }
                                  }
                                  return AdaptiveComposer(
                                    door: door,
                                    residentName: identity.residentName,
                                  controller: _inputController,
                                  pendingAttachments: _pendingAttachments,
                                  pendingVideoClip: _pendingVideoClip,
                                  pendingSticker: _pendingSticker,
                                  profile: widget.controller.profileNotifier.value,
                                  uploadingImage: _uploadingImage,
                                  sending: _sending,
                                  isReplying: activeTurn != null,
                                  isDraggingFiles: _isDraggingFiles,
                                  thinkingLevel: settingsSnap?.thinkingLevel ?? 'auto',
                                  currentModelLabel: modelLabel,
                                  currentChatSlot: slot,
                                  availableModelSlots: availableSlots,
                                  onSelectChatSlot: (nextSlot) => unawaited(
                                    widget.controller.patchSettings({
                                      'llm': {
                                        'slots': {'chat': nextSlot.toJson()},
                                      },
                                    }),
                                  ),
                                  onSelectThinkingLevel: (level) => unawaited(
                                    widget.controller.patchSettings({
                                      'llm': {
                                        'thinking': {
                                          'enabled': level != 'off',
                                          'level': level,
                                        },
                                      },
                                    }),
                                  ),
                                  onOpenModelSettings: () => _openSettings(
                                    initialSection: SettingsSection.modelUsage,
                                  ),
                                  onPickImage: _pickAndUploadImage,
                                  onOpenStickers: _openStickerSheet,
                                  onRemoveAttachment: (idx) {
                                    setState(() => _pendingAttachments.removeAt(idx));
                                  },
                                  onRemoveVideoClip: () {
                                    setState(() => _pendingVideoClip = null);
                                  },
                                  onClearSticker: () {
                                    setState(() => _pendingSticker = null);
                                  },
                                  onPasteClipboard: DesktopMediaBridge.isSupported
                                      ? _handleDesktopPaste
                                      : null,
                                  onVoiceInput: () {
                                    ScaffoldMessenger.of(context)
                                      ..hideCurrentSnackBar()
                                      ..showSnackBar(
                                        const SnackBar(
                                          content: Text('语音输入即将支持'),
                                          duration: Duration(seconds: 2),
                                        ),
                                      );
                                  },
                                  onAbort: () =>
                                      unawaited(widget.controller.abortActiveTurn()),
                                    onSend: ({bool urgent = false}) =>
                                        unawaited(_send(urgent: urgent)),
                                  );
                                },
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
                    if (!isWide)
                      Positioned(
                        top: 0,
                        left: 0,
                        right: 0,
                        child: ValueListenableBuilder<DoorStatus>(
                          valueListenable: widget.controller.doorNotifier,
                          builder: (context, door, _) => ValueListenableBuilder<bool>(
                            valueListenable: widget.controller.showReconnectingHintNotifier,
                            builder: (context, showHint, _) =>
                                ValueListenableBuilder<SettingsSnapshot?>(
                              valueListenable: widget.controller.settingsNotifier,
                              builder: (context, settings, _) =>
                                  ValueListenableBuilder<ActivitySessionView?>(
                                valueListenable: widget.controller.activeActivityNotifier,
                                builder: (context, activity, _) =>
                                    ValueListenableBuilder<IdentityInfo>(
                                  valueListenable: widget.controller.identityNotifier,
                                  builder: (context, identity, _) => MobileFloatingHeader(
                                    door: door,
                                    showReconnectingHint: showHint,
                                    settings: settings,
                                    identity: identity,
                                    profile: widget.controller.profileNotifier.value,
                                    activeActivity: activity,
                                    rightButtonKey: _rightActivityAnchorKey,
                                    onOpenLeftDrawer: () =>
                                        _scaffoldKey.currentState?.openDrawer(),
                                    onOpenRightDrawer: () =>
                                        _scaffoldKey.currentState?.openEndDrawer(),
                                    onOpenRhythmSettings: () => _openSettings(
                                      initialSection: SettingsSection.rhythmNotify,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    if (isWide && !_showDesktopSidebar)
                      Positioned(
                        top: 10,
                        left: isMacOs ? 76 : 12,
                        child: IconButton(
                          key: const Key('left_drawer_button'),
                          tooltip: '展开侧边栏 (⌘\\)',
                          icon: Icon(
                            PhosphorIconsLight.sidebarSimple,
                            size: 19,
                            color: colors.inkQuiet,
                          ),
                          onPressed: () => setState(() => _showDesktopSidebar = true),
                        ),
                      ),
                    if (isWide)
                      Positioned(
                        top: 10,
                        right: 12,
                        child: KeyedSubtree(
                          key: _rightActivityAnchorKey,
                          child: ValueListenableBuilder<ActivitySessionView?>(
                            valueListenable: widget.controller.activeActivityNotifier,
                            builder: (context, activity, _) => IconButton(
                              key: const Key('right_drawer_button'),
                              tooltip: '常用活动',
                              icon: Stack(
                                clipBehavior: Clip.none,
                                children: [
                                  Icon(
                                    activity != null
                                        ? PhosphorIconsLight.filmStrip
                                        : PhosphorIconsLight.squaresFour,
                                    size: 19,
                                    color: colors.inkQuiet,
                                  ),
                                  if (activity != null)
                                    Positioned(
                                      right: -2,
                                      top: -2,
                                      child: Container(
                                        width: 7,
                                        height: 7,
                                        decoration: BoxDecoration(
                                          color: colors.statusSuccess,
                                          shape: BoxShape.circle,
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                              onPressed: () => unawaited(
                                showActivityPopover(
                                  context,
                                  anchorKey: _rightActivityAnchorKey,
                                  controller: widget.controller,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptyRoomState extends StatelessWidget {
  const _EmptyRoomState({required this.door, this.residentName});

  final DoorStatus door;
  final String? residentName;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final subject = (residentName != null && residentName!.trim().isNotEmpty)
        ? residentName!.trim()
        : 'Psyber';
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
                color: colors.inkQuiet,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              door.state.isDoorNoteMode
                  ? '可以在下方塞一张纸条，等$subject想看的时候再看。'
                  : '随便打个招呼，或者先送一张贴纸开始认识。',
              style: TextStyle(fontSize: 13, color: colors.inkFaint),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
