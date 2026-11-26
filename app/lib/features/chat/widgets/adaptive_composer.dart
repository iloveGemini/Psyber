import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/media/voice_bridge.dart';
import '../../../core/models/models.dart';
import '../../../shared/rich_message_text.dart';
import '../../../shared/theme.dart';

@immutable
class PendingAttachment {
  const PendingAttachment({
    required this.hash,
    required this.filename,
    required this.bytes,
  });

  final String hash;
  final String filename;
  final List<int> bytes;
}

@immutable
class PendingVideoClip {
  const PendingVideoClip({
    required this.durationSec,
    required this.frameHashes,
    required this.filename,
    this.previewBytes = const <int>[],
  });

  final double durationSec;
  final List<String> frameHashes;
  final String filename;
  final List<int> previewBytes;
}

/// 门态自适应输入台（Claude 双端交互架构）：
/// - 桌面端：双层圆角卡片（上层多行纯输入区 + 下层左侧 `+`/贴纸、右侧模型与思考深度胶囊/发送键）；
/// - 移动端：未聚焦空态收拢为极简单行胶囊（`+` + 输入提示 + 语音），聚焦或有草稿时平滑展开为双层卡片，
///   点击模型与思考胶囊拉起圆角 BottomSheet；
/// - closed / cooling_off：切换为折痕纸感「门缝纸条」，不展示对方正在输入；
/// - departed：转为纪念只读底栏并允许查阅告别信。
class AdaptiveComposer extends StatefulWidget {
  const AdaptiveComposer({
    super.key,
    required this.door,
    this.residentName,
    required this.controller,
    required this.pendingAttachments,
    this.pendingVideoClip,
    this.pendingSticker,
    this.profile,
    required this.uploadingImage,
    required this.sending,
    this.isReplying = false,
    this.isDraggingFiles = false,
    required this.onPickImage,
    required this.onOpenStickers,
    required this.onRemoveAttachment,
    this.onRemoveVideoClip,
    this.onClearSticker,
    this.onPasteClipboard,
    this.onVoiceInput,
    this.voiceBridge,
    this.voiceLocale = 'zh-CN',
    this.onChangeVoiceLocale,
    this.onSendVoiceClip,
    this.voiceToggleTrigger,
    this.onAbort,
    this.thinkingLevel = 'medium',
    this.currentModelLabel,
    this.currentChatSlot,
    this.availableModelSlots = const <ModelSlotView>[],
    this.onSelectChatSlot,
    this.onSelectThinkingLevel,
    this.onOpenModelSettings,
    required this.onSend,
  });

  final DoorStatus door;
  final String? residentName;
  final TextEditingController controller;
  final List<PendingAttachment> pendingAttachments;
  final PendingVideoClip? pendingVideoClip;
  final StickerView? pendingSticker;
  final ConnectionProfile? profile;
  final bool uploadingImage;
  final bool sending;
  final bool isReplying;
  final bool isDraggingFiles;
  final VoidCallback onPickImage;
  final VoidCallback onOpenStickers;
  final void Function(int index) onRemoveAttachment;
  final VoidCallback? onRemoveVideoClip;
  final VoidCallback? onClearSticker;
  final Future<bool> Function()? onPasteClipboard;
  final VoidCallback? onVoiceInput;
  final VoiceBridge? voiceBridge;
  final String voiceLocale;
  final ValueChanged<String>? onChangeVoiceLocale;
  final Future<void> Function(VoiceRecordingResult result, {required bool urgent})?
      onSendVoiceClip;
  final ValueListenable<int>? voiceToggleTrigger;
  final VoidCallback? onAbort;
  final String thinkingLevel;
  final String? currentModelLabel;
  final ModelSlotView? currentChatSlot;
  final List<ModelSlotView> availableModelSlots;
  final ValueChanged<ModelSlotView>? onSelectChatSlot;
  final ValueChanged<String>? onSelectThinkingLevel;
  final VoidCallback? onOpenModelSettings;
  final void Function({bool urgent}) onSend;

  @override
  State<AdaptiveComposer> createState() => _AdaptiveComposerState();
}

enum _VoiceCaptureMode { idle, holding, canceling, locked, finishing }

class _AdaptiveComposerState extends State<AdaptiveComposer> {
  late final FocusNode _inputFocusNode;
  late final FocusNode _voiceFocusNode;
  final GlobalKey _thinkingAnchorKey = GlobalKey();
  final GlobalKey _inputFieldSubtreeKey = GlobalKey();
  final GlobalKey _composerCardKey = GlobalKey();
  bool _urgentOpen = false;
  bool _inputFocused = false;

  _VoiceCaptureMode _voiceMode = _VoiceCaptureMode.idle;
  StreamSubscription<VoiceRecordingUpdate>? _voiceSub;
  Timer? _voiceClockTimer;
  DateTime? _voiceStartedAt;
  double? _lockedMinCardHeight;
  String _liveTranscript = '';
  double _voiceDurationSec = 0.0;
  bool _speechPermissionMissing = false;
  final List<double> _voiceLevels = List<double>.filled(14, 0.12, growable: true);

  VoiceBridge get _voiceBridge => widget.voiceBridge ?? NativeVoiceBridge.instance;
  bool get _isVoiceActive => _voiceMode != _VoiceCaptureMode.idle;

  static const _thinkingOptions = <(String, String)>[
    ('auto', '自动'),
    ('off', '关闭'),
    ('low', '轻度'),
    ('medium', '标准'),
    ('high', '深度'),
  ];

  bool get _isDesktopOrWeb {
    if (kIsWeb) return true;
    return defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.windows ||
        defaultTargetPlatform == TargetPlatform.linux;
  }

  void _onFocusChanged() {
    if (!mounted) return;
    final focused = _inputFocusNode.hasFocus;
    if (focused != _inputFocused) {
      setState(() => _inputFocused = focused);
    }
  }

  Future<void> _handleDesktopPaste() async {
    final handler = widget.onPasteClipboard;
    if (handler != null) {
      final handledMedia = await handler();
      if (handledMedia || !mounted) return;
    }
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final pasted = data?.text;
    if (!mounted || pasted == null || pasted.isEmpty) return;
    final value = widget.controller.value;
    final sel = value.selection;
    final start = sel.isValid ? sel.start : value.text.length;
    final end = sel.isValid ? sel.end : value.text.length;
    final safeStart = start.clamp(0, value.text.length);
    final safeEnd = end.clamp(safeStart, value.text.length);
    final nextText = value.text.replaceRange(safeStart, safeEnd, pasted);
    widget.controller.value = TextEditingValue(
      text: nextText,
      selection: TextSelection.collapsed(offset: safeStart + pasted.length),
    );
  }

  @override
  void initState() {
    super.initState();
    _inputFocusNode = FocusNode(
      onKeyEvent: (node, event) {
        if (!_isDesktopOrWeb) return KeyEventResult.ignored;
        if (event is! KeyDownEvent) return KeyEventResult.ignored;

        final isPasteShortcut =
            event.logicalKey == LogicalKeyboardKey.keyV &&
            ((defaultTargetPlatform == TargetPlatform.macOS &&
                    HardwareKeyboard.instance.isMetaPressed) ||
                (defaultTargetPlatform != TargetPlatform.macOS &&
                    HardwareKeyboard.instance.isControlPressed)) &&
            !HardwareKeyboard.instance.isAltPressed;
        if (isPasteShortcut && widget.onPasteClipboard != null) {
          unawaited(_handleDesktopPaste());
          return KeyEventResult.handled;
        }

        final isEnter = event.logicalKey == LogicalKeyboardKey.enter ||
            event.logicalKey == LogicalKeyboardKey.numpadEnter;
        if (!isEnter) return KeyEventResult.ignored;

        // 拼音/日文等输入法处于候选词组合态时不误发
        final composing = widget.controller.value.composing;
        if (composing.isValid && !composing.isCollapsed) {
          return KeyEventResult.ignored;
        }
        final isPrimarySendCombo =
            HardwareKeyboard.instance.isMetaPressed ||
            HardwareKeyboard.instance.isControlPressed;
        if (isPrimarySendCombo) {
          if (!widget.sending) {
            _triggerSend();
          }
          return KeyEventResult.handled;
        }
        if (HardwareKeyboard.instance.isShiftPressed) {
          return KeyEventResult.ignored;
        }
        if (!widget.sending) {
          _triggerSend();
        }
        return KeyEventResult.handled;
      },
    );
    _inputFocusNode.addListener(_onFocusChanged);
    _voiceFocusNode = FocusNode(
      onKeyEvent: (node, event) {
        if (!_isDesktopOrWeb || _voiceMode != _VoiceCaptureMode.locked) {
          return KeyEventResult.ignored;
        }
        if (event is! KeyDownEvent) return KeyEventResult.ignored;
        if (event.logicalKey == LogicalKeyboardKey.escape) {
          unawaited(_cancelVoiceCapture());
          return KeyEventResult.handled;
        }
        if (event.logicalKey == LogicalKeyboardKey.enter ||
            event.logicalKey == LogicalKeyboardKey.numpadEnter) {
          unawaited(_finishVoiceCaptureAndSend());
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
    );
    widget.voiceToggleTrigger?.addListener(_onExternalVoiceToggle);
  }

  @override
  void didUpdateWidget(covariant AdaptiveComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.voiceToggleTrigger != widget.voiceToggleTrigger) {
      oldWidget.voiceToggleTrigger?.removeListener(_onExternalVoiceToggle);
      widget.voiceToggleTrigger?.addListener(_onExternalVoiceToggle);
    }
    if (widget.door.state != DoorState.closed && _urgentOpen) {
      _urgentOpen = false;
    }
  }

  void _onExternalVoiceToggle() {
    if (!mounted || widget.sending || widget.isReplying) return;
    if (_voiceMode == _VoiceCaptureMode.idle) {
      unawaited(_startVoiceCapture(locked: true));
    } else if (_voiceMode == _VoiceCaptureMode.locked) {
      unawaited(_finishVoiceCaptureAndSend());
    }
  }

  void _showVoiceToast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 2),
        ),
      );
  }

  Future<void> _startVoiceCapture({required bool locked}) async {
    if (_isVoiceActive || widget.sending) return;
    if (widget.onSendVoiceClip == null) {
      widget.onVoiceInput?.call();
      return;
    }
    if (!_voiceBridge.isSupported) {
      _showVoiceToast('当前平台暂不支持原生语音条录制');
      return;
    }

    var perm = await _voiceBridge.checkPermission();
    if (!perm.micGranted || !perm.speechGranted) {
      perm = await _voiceBridge.requestPermission();
    }
    if (!mounted) return;
    if (!perm.micGranted) {
      _showVoiceToast('请先在系统设置中允许 Psyber 使用麦克风');
      return;
    }

    final cardBox = _composerCardKey.currentContext?.findRenderObject() as RenderBox?;
    final isDesktopNow =
        _isDesktopOrWeb || MediaQuery.sizeOf(context).width >= 720;
    final measuredCardHeight =
        (isDesktopNow && cardBox != null && cardBox.hasSize) ? cardBox.size.height : null;

    _inputFocusNode.unfocus();
    setState(() {
      _lockedMinCardHeight = measuredCardHeight;
      _voiceMode = locked ? _VoiceCaptureMode.locked : _VoiceCaptureMode.holding;
      _liveTranscript = '';
      _voiceDurationSec = 0.0;
      _voiceStartedAt = DateTime.now();
      _speechPermissionMissing = !perm.speechGranted;
      for (var i = 0; i < _voiceLevels.length; i++) {
        _voiceLevels[i] = 0.14;
      }
    });

    if (locked && _isDesktopOrWeb) {
      _voiceFocusNode.requestFocus();
    }

    await _voiceSub?.cancel();
    _voiceSub = _voiceBridge.updates.listen((update) {
      if (!mounted || !_isVoiceActive) return;
      setState(() {
        if (update.transcript.isNotEmpty) {
          _liveTranscript = update.transcript;
        }
        if (update.durationSec > _voiceDurationSec) {
          _voiceDurationSec = update.durationSec;
        }
        if (update.level != null) {
          _voiceLevels.removeAt(0);
          _voiceLevels.add(update.level!.clamp(0.1, 1.0));
        }
      });
    });

    _voiceClockTimer?.cancel();
    _voiceClockTimer = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (!mounted || !_isVoiceActive || _voiceStartedAt == null) return;
      final elapsed = DateTime.now().difference(_voiceStartedAt!).inMilliseconds / 1000.0;
      if (elapsed > _voiceDurationSec) {
        setState(() => _voiceDurationSec = elapsed);
      }
    });

    try {
      await _voiceBridge.startRecording(locale: widget.voiceLocale);
      if (!mounted) {
        unawaited(_voiceBridge.cancelRecording());
        return;
      }
      if (!locked) {
        unawaited(HapticFeedback.mediumImpact());
      } else {
        unawaited(HapticFeedback.selectionClick());
      }
    } catch (err) {
      _resetVoiceState();
      _showVoiceToast('无法启动录音：$err');
    }
  }

  void _stopVoiceListeners() {
    _voiceClockTimer?.cancel();
    _voiceClockTimer = null;
    final sub = _voiceSub;
    _voiceSub = null;
    if (sub != null) {
      unawaited(sub.cancel());
    }
  }

  void _resetVoiceState() {
    _stopVoiceListeners();
    _voiceStartedAt = null;
    if (mounted) {
      setState(() {
        _voiceMode = _VoiceCaptureMode.idle;
        _lockedMinCardHeight = null;
        _liveTranscript = '';
        _voiceDurationSec = 0.0;
        _speechPermissionMissing = false;
      });
    }
  }

  Future<void> _cancelVoiceCapture() async {
    if (!_isVoiceActive) return;
    _stopVoiceListeners();
    unawaited(HapticFeedback.lightImpact());
    await _voiceBridge.cancelRecording();
    _resetVoiceState();
  }

  Future<void> _finishVoiceCaptureToText() async {
    if (!_isVoiceActive || _voiceMode == _VoiceCaptureMode.finishing) return;
    final fallbackTranscript = _liveTranscript;
    _stopVoiceListeners();
    setState(() => _voiceMode = _VoiceCaptureMode.finishing);
    VoiceRecordingResult? result;
    try {
      result = await _voiceBridge.stopRecording();
    } catch (_) {
      result = null;
    }
    final text = (result?.transcript.trim().isNotEmpty == true)
        ? result!.transcript.trim()
        : fallbackTranscript.trim();
    _resetVoiceState();
    if (!mounted || text.isEmpty) return;
    final existing = widget.controller.text;
    final merged = existing.trim().isEmpty ? text : '$existing $text';
    widget.controller.value = TextEditingValue(
      text: merged,
      selection: TextSelection.collapsed(offset: merged.length),
    );
    _inputFocusNode.requestFocus();
  }

  Future<void> _finishVoiceCaptureAndSend() async {
    if (!_isVoiceActive || _voiceMode == _VoiceCaptureMode.finishing) return;
    final fallbackTranscript = _liveTranscript;
    final elapsedSec = _voiceDurationSec;
    _stopVoiceListeners();
    setState(() => _voiceMode = _VoiceCaptureMode.finishing);
    VoiceRecordingResult? result;
    try {
      result = await _voiceBridge.stopRecording();
    } catch (err) {
      _resetVoiceState();
      _showVoiceToast('录音结束失败：$err');
      return;
    }

    if (result == null || (result.durationSec < 0.35 && elapsedSec < 0.35)) {
      _resetVoiceState();
      _showVoiceToast('说话时间太短，已取消');
      return;
    }

    final finalResult = VoiceRecordingResult(
      bytes: result.bytes,
      durationSec: result.durationSec > 0 ? result.durationSec : elapsedSec,
      transcript: result.transcript.trim().isNotEmpty
          ? result.transcript.trim()
          : fallbackTranscript.trim(),
      mimeType: result.mimeType,
    );

    final useUrgent = widget.door.state == DoorState.closed && _urgentOpen;
    if (_urgentOpen && mounted) {
      setState(() => _urgentOpen = false);
    }

    try {
      await widget.onSendVoiceClip?.call(finalResult, urgent: useUrgent);
    } finally {
      _resetVoiceState();
    }
  }

  String _formatVoiceTimer(double sec) {
    final s = sec.floor().clamp(0, 3599);
    final mm = s ~/ 60;
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$mm:$ss';
  }

  void _triggerSend() {
    final useUrgent = widget.door.state == DoorState.closed && _urgentOpen;
    if (_urgentOpen) {
      setState(() => _urgentOpen = false);
    }
    widget.onSend(urgent: useUrgent);
  }

  Future<void> _confirmUrgentChannel() async {
    if (_urgentOpen) {
      setState(() => _urgentOpen = false);
      return;
    }
    final colors = context.colors;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.letterSurface,
        title: const Text('开启一次性紧急通道？', style: TextStyle(fontSize: 16)),
        content: Text(
          '门正关着，开启后仅限这一条消息直接突破关门送达；发完后通道会自动重新关上。',
          style: TextStyle(fontSize: 13.5, color: colors.inkQuiet, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('算了，塞纸条'),
          ),
          FilledButton(
            key: const Key('confirm_urgent_channel_button'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('确认开启（仅此一条）'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted && widget.door.state == DoorState.closed) {
      setState(() => _urgentOpen = true);
      _inputFocusNode.requestFocus();
    }
  }

  String _thinkingLabel(String level) => switch (level) {
        'auto' => '自动',
        'off' => '关闭',
        'low' => '轻度',
        'high' => '深度',
        _ => '标准',
      };

  String _shortModelName(String? rawModel) {
    if (rawModel == null || rawModel.trim().isEmpty) return '';
    final trimmed = rawModel.trim();
    final afterSlash = trimmed.contains('/') ? trimmed.split('/').last : trimmed;
    final afterDot = afterSlash.contains('·') ? afterSlash.split('·').last.trim() : afterSlash;
    return afterDot;
  }

  String _displayModelCapsuleTitle() {
    final fromSlot = _shortModelName(widget.currentChatSlot?.model);
    if (fromSlot.isNotEmpty) return fromSlot;
    final fromLabel = _shortModelName(widget.currentModelLabel);
    if (fromLabel.isNotEmpty) return fromLabel;
    return '模型';
  }

  List<ModelSlotView> _resolvedModelOptions() {
    final seen = <String>{};
    final out = <ModelSlotView>[];
    void addSlot(ModelSlotView? slot) {
      if (slot == null || slot.model.trim().isEmpty) return;
      final key = '${slot.provider}::${slot.model.trim()}';
      if (seen.add(key)) out.add(slot);
    }

    addSlot(widget.currentChatSlot);
    for (final s in widget.availableModelSlots) {
      addSlot(s);
    }
    return out;
  }

  bool _isSameSlot(ModelSlotView a, ModelSlotView? b) {
    if (b == null) return false;
    return a.provider == b.provider && a.model == b.model;
  }

  Future<void> _openModelAndThinkingSelector({required bool isDesktop}) async {
    if (widget.onSelectThinkingLevel == null && widget.onSelectChatSlot == null) {
      return;
    }
    if (isDesktop) {
      await _openDesktopModelThinkingPopover();
    } else {
      await _openMobileModelThinkingSheet();
    }
  }

  Future<void> _openDesktopModelThinkingPopover() async {
    double bottom = 78;
    double left = 24;
    const popoverWidth = 316.0;
    final anchorCtx = _thinkingAnchorKey.currentContext;
    if (anchorCtx != null) {
      final box = anchorCtx.findRenderObject() as RenderBox?;
      final overlay = Overlay.maybeOf(context)?.context.findRenderObject() as RenderBox?;
      if (box != null && box.hasSize && overlay != null && overlay.hasSize) {
        final topLeft = box.localToGlobal(Offset.zero, ancestor: overlay);
        bottom = (overlay.size.height - topLeft.dy + 8).clamp(16.0, overlay.size.height - 200.0);
        // 尽量右对齐胶囊右边缘
        final preferredLeft = topLeft.dx + box.size.width - popoverWidth;
        left = preferredLeft.clamp(12.0, math.max(12.0, overlay.size.width - popoverWidth - 12.0));
      }
    }

    final modelOptions = _resolvedModelOptions();

    await showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: '关闭模型与思考菜单',
      barrierColor: Colors.transparent,
      transitionDuration: const Duration(milliseconds: 130),
      pageBuilder: (dialogCtx, _, __) {
        final colors = dialogCtx.colors;
        return Stack(
          children: [
            Positioned(
              left: left,
              bottom: bottom,
              width: popoverWidth,
              child: Material(
                key: const Key('composer_thinking_popover'),
                color: colors.letterSurface,
                elevation: 10,
                shadowColor: Colors.black.withValues(alpha: 0.14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                  side: BorderSide(color: colors.hairline),
                ),
                clipBehavior: Clip.antiAlias,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Text(
                            '模型与思考',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: colors.inkDeep,
                            ),
                          ),
                          const Spacer(),
                          if (widget.onOpenModelSettings != null)
                            InkWell(
                              key: const Key('quick_open_model_settings'),
                              borderRadius: BorderRadius.circular(6),
                              onTap: () {
                                Navigator.of(dialogCtx).pop();
                                widget.onOpenModelSettings!();
                              },
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                child: Text(
                                  '配置模型',
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    color: colors.inkQuiet,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                      if (modelOptions.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxHeight: 200),
                          child: SingleChildScrollView(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                for (final slot in modelOptions)
                                  _buildModelOptionTile(
                                    dialogCtx,
                                    slot: slot,
                                    selected: _isSameSlot(slot, widget.currentChatSlot),
                                    compact: true,
                                    onTap: widget.onSelectChatSlot == null
                                        ? null
                                        : () {
                                            Navigator.of(dialogCtx).pop();
                                            widget.onSelectChatSlot!(slot);
                                          },
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ] else if (widget.currentModelLabel != null &&
                          widget.currentModelLabel!.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          widget.currentModelLabel!,
                          style: PsyberTheme.monoStyle.copyWith(
                            fontSize: 11.5,
                            color: colors.inkQuiet,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      if (widget.onSelectThinkingLevel != null) ...[
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          child: Divider(height: 1, color: colors.hairline),
                        ),
                        Text(
                          '思考深度',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            color: colors.inkQuiet,
                          ),
                        ),
                        const SizedBox(height: 7),
                        _buildThinkingSegmentedRow(dialogCtx),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ],
        );
      },
      transitionBuilder: (ctx, anim, _, child) => FadeTransition(
        opacity: CurvedAnimation(parent: anim, curve: Curves.easeOut),
        child: child,
      ),
    );
  }

  Future<void> _openMobileModelThinkingSheet() async {
    final modelOptions = _resolvedModelOptions();
    final colors = context.colors;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: colors.mineralCanvas,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        side: BorderSide(color: colors.hairline),
      ),
      builder: (sheetCtx) {
        final colors = sheetCtx.colors;
        return SafeArea(
          key: const Key('composer_thinking_popover'),
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                  Center(
                    child: Container(
                      width: 36,
                      height: 4,
                      decoration: BoxDecoration(
                        color: colors.hairline,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Material(
                        color: colors.letterSurface,
                        shape: CircleBorder(
                          side: BorderSide(color: colors.hairline),
                        ),
                        child: InkWell(
                          customBorder: const CircleBorder(),
                          onTap: () => Navigator.of(sheetCtx).pop(),
                          child: SizedBox(
                            width: 34,
                            height: 34,
                            child: Icon(
                              PhosphorIconsLight.x,
                              size: 16,
                              color: colors.inkDeep,
                            ),
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          '选择模型',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: colors.inkDeep,
                          ),
                        ),
                      ),
                      if (widget.onOpenModelSettings != null)
                        TextButton(
                          key: const Key('quick_open_model_settings'),
                          style: TextButton.styleFrom(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          onPressed: () {
                            Navigator.of(sheetCtx).pop();
                            widget.onOpenModelSettings!();
                          },
                          child: Text(
                            '管理',
                            style: TextStyle(fontSize: 13, color: colors.inkQuiet),
                          ),
                        )
                      else
                        const SizedBox(width: 34),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Container(
                    decoration: BoxDecoration(
                      color: colors.letterSurface,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: colors.hairline),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: modelOptions.isNotEmpty
                        ? ConstrainedBox(
                            constraints: const BoxConstraints(maxHeight: 280),
                            child: SingleChildScrollView(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  for (var i = 0; i < modelOptions.length; i++) ...[
                                    if (i > 0)
                                      Divider(
                                        height: 1,
                                        indent: 16,
                                        endIndent: 16,
                                        color: colors.hairline.withValues(alpha: 0.7),
                                      ),
                                    _buildModelOptionTile(
                                      sheetCtx,
                                      slot: modelOptions[i],
                                      selected: _isSameSlot(
                                        modelOptions[i],
                                        widget.currentChatSlot,
                                      ),
                                      compact: false,
                                      onTap: widget.onSelectChatSlot == null
                                          ? null
                                          : () {
                                              Navigator.of(sheetCtx).pop();
                                              widget.onSelectChatSlot!(modelOptions[i]);
                                            },
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          )
                        : Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 14,
                            ),
                            child: Text(
                              widget.currentModelLabel ?? '尚未配置聊天模型',
                              style: TextStyle(fontSize: 14, color: colors.inkQuiet),
                            ),
                          ),
                  ),
                  if (widget.onSelectThinkingLevel != null) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                      decoration: BoxDecoration(
                        color: colors.letterSurface,
                        borderRadius: BorderRadius.circular(18),
                        border: Border.all(color: colors.hairline),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Text(
                                '思考强度',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  color: colors.inkDeep,
                                ),
                              ),
                              const Spacer(),
                              Text(
                                _thinkingLabel(widget.thinkingLevel),
                                style: TextStyle(
                                  fontSize: 13,
                                  color: colors.inkQuiet,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          _buildThinkingSegmentedRow(sheetCtx),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
          );
      },
    );
  }

  Widget _buildModelOptionTile(
    BuildContext ctx, {
    required ModelSlotView slot,
    required bool selected,
    required bool compact,
    VoidCallback? onTap,
  }) {
    final colors = ctx.colors;
    return InkWell(
      borderRadius: compact ? BorderRadius.circular(10) : BorderRadius.zero,
      onTap: onTap,
      child: Container(
        padding: compact
            ? const EdgeInsets.symmetric(horizontal: 10, vertical: 8)
            : const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
        decoration: compact && selected
            ? BoxDecoration(
                color: colors.accentSoft,
                borderRadius: BorderRadius.circular(10),
              )
            : null,
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    _shortModelName(slot.model),
                    style: TextStyle(
                      fontSize: compact ? 13 : 15,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                      color: colors.inkDeep,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (slot.provider.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      slot.provider,
                      style: TextStyle(
                        fontSize: compact ? 11 : 12,
                        color: colors.inkQuiet,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            if (selected) ...[
              const SizedBox(width: 8),
              Icon(
                PhosphorIconsLight.check,
                size: compact ? 15 : 18,
                color: colors.accent,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildThinkingSegmentedRow(BuildContext ctx) {
    final colors = ctx.colors;
    return Row(
      children: [
        for (final entry in _thinkingOptions)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: InkWell(
                key: Key('quick_thinking_${entry.$1}'),
                borderRadius: BorderRadius.circular(8),
                onTap: () {
                  Navigator.of(ctx).pop();
                  widget.onSelectThinkingLevel!(entry.$1);
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: widget.thinkingLevel == entry.$1
                        ? colors.accentSoft
                        : colors.mineralCanvas,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: widget.thinkingLevel == entry.$1
                          ? colors.accentBorder
                          : colors.hairline,
                    ),
                  ),
                  child: Text(
                    entry.$2,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: widget.thinkingLevel == entry.$1
                          ? FontWeight.w600
                          : FontWeight.w400,
                      color: colors.inkDeep,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  @override
  void dispose() {
    widget.voiceToggleTrigger?.removeListener(_onExternalVoiceToggle);
    _voiceClockTimer?.cancel();
    unawaited(_voiceSub?.cancel());
    if (_isVoiceActive) {
      unawaited(_voiceBridge.cancelRecording());
    }
    _inputFocusNode.removeListener(_onFocusChanged);
    _inputFocusNode.dispose();
    _voiceFocusNode.dispose();
    super.dispose();
  }

  void _openFarewellDialog(BuildContext context, String farewell) {
    final colors = context.colors;
    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          backgroundColor: colors.slipPaper,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: colors.hairlineWarm),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '留下的告别信',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  RichMessageText(
                    text: farewell,
                    baseStyle: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 14.5,
                      height: 1.7,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: () => Navigator.of(ctx).pop(),
                      child: const Text('合上'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildAddMediaButton(PsyberColors colors, {required bool pillFill}) {
    final size = pillFill ? 34.0 : 32.0;
    return IconButton(
      key: const Key('pick_image_button'),
      tooltip: '添加图片或视频',
      padding: EdgeInsets.zero,
      constraints: BoxConstraints.tightFor(width: size, height: size),
      style: IconButton.styleFrom(
        minimumSize: Size(size, size),
        fixedSize: Size(size, size),
        backgroundColor: pillFill ? colors.celadonWash : Colors.transparent,
        shape: const CircleBorder(),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      onPressed: (widget.sending || widget.uploadingImage) ? null : widget.onPickImage,
      icon: widget.uploadingImage
          ? const SizedBox(
              width: 15,
              height: 15,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(
              PhosphorIconsLight.plus,
              size: 18,
              color: colors.inkDeep,
            ),
    );
  }

  Widget _buildStickerButton(PsyberColors colors, {required bool pillFill}) {
    final size = pillFill ? 34.0 : 32.0;
    return IconButton(
      key: const Key('open_stickers_button'),
      tooltip: '发送贴纸',
      padding: EdgeInsets.zero,
      constraints: BoxConstraints.tightFor(width: size, height: size),
      style: IconButton.styleFrom(
        minimumSize: Size(size, size),
        fixedSize: Size(size, size),
        backgroundColor: pillFill ? colors.celadonWash : Colors.transparent,
        shape: const CircleBorder(),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      onPressed: widget.sending ? null : widget.onOpenStickers,
      icon: Icon(
        PhosphorIconsLight.smiley,
        size: 18,
        color: colors.inkQuiet,
      ),
    );
  }

  Widget _buildModelThinkingCapsule(
    PsyberColors colors, {
    required bool isDesktop,
    required bool filledPill,
  }) {
    final modelTitle = _displayModelCapsuleTitle();
    final thinkingText = _thinkingLabel(widget.thinkingLevel);
    return KeyedSubtree(
      key: _thinkingAnchorKey,
      child: InkWell(
        key: const Key('composer_thinking_button'),
        borderRadius: BorderRadius.circular(18),
        onTap: widget.sending
            ? null
            : () => unawaited(_openModelAndThinkingSelector(isDesktop: isDesktop)),
        child: Container(
          height: filledPill ? 32 : 30,
          padding: EdgeInsets.symmetric(horizontal: filledPill ? 11 : 9),
          decoration: BoxDecoration(
            color: filledPill ? colors.celadonWash : Colors.transparent,
            borderRadius: BorderRadius.circular(18),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: isDesktop ? 156 : 112),
                child: Text(
                  modelTitle,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w500,
                    color: colors.inkDeep,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 5),
              Text(
                thinkingText,
                style: TextStyle(
                  fontSize: 12,
                  color: widget.thinkingLevel == 'off'
                      ? colors.inkFaint
                      : colors.inkQuiet,
                ),
              ),
              if (isDesktop) ...[
                const SizedBox(width: 3),
                Icon(
                  PhosphorIconsLight.caretDown,
                  size: 12,
                  color: colors.inkQuiet,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPrimaryActionButton(
    PsyberColors colors, {
    required bool hasDraft,
    required bool isUrgentActive,
    required bool isDoorNote,
    required bool isDesktop,
  }) {
    final size = isDesktop ? 32.0 : 34.0;
    if (widget.isReplying) {
      return Tooltip(
        message: '停止生成',
        child: IconButton(
          key: const Key('chat_stop_button'),
          padding: EdgeInsets.zero,
          constraints: BoxConstraints.tightFor(width: size, height: size),
          style: IconButton.styleFrom(
            minimumSize: Size(size, size),
            fixedSize: Size(size, size),
            backgroundColor: colors.accent,
            foregroundColor: colors.onAccent,
            shape: const CircleBorder(),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          onPressed: widget.onAbort,
          icon: const Icon(PhosphorIconsFill.stop, size: 12),
        ),
      );
    }

    if (hasDraft) {
      final Color btnBg = isUrgentActive
          ? colors.dangerInk
          : (isDoorNote ? colors.thresholdAmberSoft : colors.accent);
      final Color btnFg = isUrgentActive
          ? Colors.white
          : (isDoorNote ? colors.thresholdAmber : colors.onAccent);
      final BorderSide? btnSide =
          isDoorNote ? BorderSide(color: colors.thresholdAmber) : null;

      return Tooltip(
        message: isUrgentActive ? '紧急发送' : (isDoorNote ? '塞纸条' : '发送'),
        child: IconButton(
          key: const Key('chat_send_button'),
          padding: EdgeInsets.zero,
          constraints: BoxConstraints.tightFor(width: size, height: size),
          style: IconButton.styleFrom(
            minimumSize: Size(size, size),
            fixedSize: Size(size, size),
            backgroundColor: btnBg,
            foregroundColor: btnFg,
            side: btnSide,
            shape: const CircleBorder(),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          onPressed: widget.sending ? null : _triggerSend,
          icon: widget.sending
              ? SizedBox(
                  width: 13,
                  height: 13,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: btnFg,
                  ),
                )
              : const Icon(PhosphorIconsLight.arrowUp, size: 16),
        ),
      );
    }

    final Color bg = isUrgentActive
        ? colors.dangerInk
        : (isDoorNote ? colors.thresholdAmberSoft : colors.accent);
    final Color fg = isUrgentActive
        ? Colors.white
        : (isDoorNote ? colors.thresholdAmber : colors.onAccent);
    return Tooltip(
      message: isDesktop ? '点按免提说 / 按住松手发（⌘⇧M）' : '按住说松手发 · 轻点免提说',
      child: GestureDetector(
        key: const Key('chat_voice_button'),
        behavior: HitTestBehavior.opaque,
        onTap: widget.sending ? null : () => unawaited(_startVoiceCapture(locked: true)),
        onLongPressStart: widget.sending
            ? null
            : (_) => unawaited(_startVoiceCapture(locked: false)),
        onLongPressMoveUpdate: (details) {
          if (_voiceMode != _VoiceCaptureMode.holding &&
              _voiceMode != _VoiceCaptureMode.canceling) {
            return;
          }
          final offset = details.localOffsetFromOrigin;
          if (offset.dy < -52) {
            unawaited(HapticFeedback.heavyImpact());
            setState(() => _voiceMode = _VoiceCaptureMode.locked);
            if (_isDesktopOrWeb) _voiceFocusNode.requestFocus();
          } else if (offset.dx < -56) {
            if (_voiceMode != _VoiceCaptureMode.canceling) {
              unawaited(HapticFeedback.selectionClick());
              setState(() => _voiceMode = _VoiceCaptureMode.canceling);
            }
          } else if (_voiceMode != _VoiceCaptureMode.holding) {
            setState(() => _voiceMode = _VoiceCaptureMode.holding);
          }
        },
        onLongPressEnd: (_) {
          if (_voiceMode == _VoiceCaptureMode.canceling) {
            unawaited(_cancelVoiceCapture());
          } else if (_voiceMode == _VoiceCaptureMode.holding) {
            unawaited(_finishVoiceCaptureAndSend());
          }
        },
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: widget.sending ? bg.withValues(alpha: 0.45) : bg,
            shape: BoxShape.circle,
            border: isDoorNote ? Border.all(color: colors.thresholdAmber) : null,
          ),
          alignment: Alignment.center,
          child: Icon(
            PhosphorIconsLight.microphone,
            size: 16,
            color: fg,
          ),
        ),
      ),
    );
  }

  Widget _buildVoiceRecordingCard(
    PsyberColors colors, {
    required bool isDesktop,
    required bool isDoorNote,
  }) {
    final isCanceling = _voiceMode == _VoiceCaptureMode.canceling;
    final isLocked = _voiceMode == _VoiceCaptureMode.locked;
    final isFinishing = _voiceMode == _VoiceCaptureMode.finishing;
    final accentColor = isCanceling
        ? colors.dangerInk
        : (isDoorNote ? colors.thresholdAmber : colors.accent);
    final btnSize = isDesktop ? 32.0 : 34.0;
    final visibleLevels = _voiceLevels.length > 10
        ? _voiceLevels.sublist(_voiceLevels.length - 10)
        : _voiceLevels;

    final placeholderText = isCanceling
        ? '松开手指以取消发送'
        : (_speechPermissionMissing
            ? '正在录制原声语音条…'
            : '正在听你说话…');

    // 与默认双层输入台保持同高：按切换前实测卡片高度对齐上层最小高度，避免跳动
    final double toolbarHeight = btnSize + 11.0;
    final double topMinHeight = _lockedMinCardHeight != null
        ? (_lockedMinCardHeight! - 2.0 - toolbarHeight - 25.0).clamp(40.0, 200.0)
        : 44.4;
    return Focus(
      focusNode: _voiceFocusNode,
      child: Column(
        key: const Key('voice_recording_card'),
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 15, 12, 10),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minHeight: topMinHeight,
                maxHeight: math.max(topMinHeight, 120.0),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: SingleChildScrollView(
                      reverse: true,
                      child: Text(
                        _liveTranscript.isNotEmpty
                            ? _liveTranscript
                            : placeholderText,
                        key: const Key('voice_live_transcript'),
                        style: TextStyle(
                          fontSize: 15,
                          height: 1.48,
                          color: _liveTranscript.isNotEmpty
                              ? colors.inkDeep
                              : (isCanceling
                                  ? colors.dangerInk
                                  : colors.inkFaint),
                        ),
                      ),
                    ),
                  ),
                  if (!_speechPermissionMissing) ...[
                    const SizedBox(width: 8),
                    Tooltip(
                      message: widget.voiceLocale == 'en-US'
                          ? '当前英文识别，点击切换中文'
                          : '当前中文识别，点击切换英文',
                      child: InkWell(
                        key: const Key('voice_locale_toggle'),
                        borderRadius: BorderRadius.circular(10),
                        onTap: (isLocked && !isFinishing)
                            ? () {
                                final next = widget.voiceLocale == 'en-US'
                                    ? 'zh-CN'
                                    : 'en-US';
                                widget.onChangeVoiceLocale?.call(next);
                                unawaited(_voiceBridge.switchLocale(next));
                                unawaited(HapticFeedback.selectionClick());
                              }
                            : null,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 2.5,
                          ),
                          decoration: BoxDecoration(
                            color: colors.mineralCanvas,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: colors.hairline),
                          ),
                          child: Text(
                            widget.voiceLocale == 'en-US' ? 'EN' : '中文',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: isLocked ? colors.inkDeep : colors.inkQuiet,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 2, 10, 9),
            child: SizedBox(
              height: btnSize,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: accentColor,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 7),
                  Text(
                    _formatVoiceTimer(_voiceDurationSec),
                    style: PsyberTheme.monoStyle.copyWith(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: accentColor,
                    ),
                  ),
                  const SizedBox(width: 9),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      for (final lv in visibleLevels)
                        AnimatedContainer(
                          duration: const Duration(milliseconds: 70),
                          width: 2.5,
                          height: 4 + lv * 12,
                          margin: const EdgeInsets.symmetric(horizontal: 1.3),
                          decoration: BoxDecoration(
                            color: accentColor.withValues(alpha: 0.72),
                            borderRadius: BorderRadius.circular(2),
                          ),
                        ),
                    ],
                  ),
                  const Spacer(),
                  if (isLocked || isFinishing) ...[
                    Tooltip(
                      message: '停止录音并转入输入框编辑',
                      child: IconButton(
                        key: const Key('voice_to_text_button'),
                        padding: EdgeInsets.zero,
                        constraints: BoxConstraints.tightFor(
                          width: btnSize,
                          height: btnSize,
                        ),
                        style: IconButton.styleFrom(
                          minimumSize: Size(btnSize, btnSize),
                          fixedSize: Size(btnSize, btnSize),
                          backgroundColor: colors.mineralCanvas,
                          foregroundColor: colors.inkDeep,
                          side: BorderSide(color: colors.hairline),
                          shape: const CircleBorder(),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        onPressed: isFinishing
                            ? null
                            : () => unawaited(_finishVoiceCaptureToText()),
                        icon: const Icon(PhosphorIconsFill.stop, size: 11.5),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Tooltip(
                      message: isDesktop ? '发送语音 (Enter)' : '发送语音',
                      child: IconButton(
                        key: const Key('voice_send_button'),
                        padding: EdgeInsets.zero,
                        constraints: BoxConstraints.tightFor(
                          width: btnSize,
                          height: btnSize,
                        ),
                        style: IconButton.styleFrom(
                          minimumSize: Size(btnSize, btnSize),
                          fixedSize: Size(btnSize, btnSize),
                          backgroundColor: isDoorNote
                              ? colors.thresholdAmber
                              : colors.accent,
                          foregroundColor: colors.onAccent,
                          shape: const CircleBorder(),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        onPressed: isFinishing
                            ? null
                            : () => unawaited(_finishVoiceCaptureAndSend()),
                        icon: isFinishing
                            ? SizedBox(
                                width: 13,
                                height: 13,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: colors.onAccent,
                                ),
                              )
                            : const Icon(PhosphorIconsLight.arrowUp, size: 16),
                      ),
                    ),
                  ] else
                    Text(
                      isCanceling ? '松手取消' : '← 取消 · ↑ 锁定 · 松手发',
                      style: TextStyle(
                        fontSize: 12,
                        color: isCanceling ? colors.dangerInk : colors.inkQuiet,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildInputField(
    PsyberColors colors, {
    required bool isUrgentActive,
    required bool isDoorNote,
    required bool singleLinePill,
  }) {
    final hintText = isUrgentActive
        ? '紧急直达（仅此一条）…'
        : (isDoorNote ? '写下要塞进门缝的纸条…' : '说点什么…');
    return KeyedSubtree(
      key: _inputFieldSubtreeKey,
      child: TextField(
        key: const Key('chat_input_field'),
        focusNode: _inputFocusNode,
        controller: widget.controller,
        minLines: singleLinePill ? 1 : 2,
        maxLines: singleLinePill ? 1 : (_isDesktopOrWeb ? 6 : 5),
        textAlignVertical: TextAlignVertical.center,
        style: TextStyle(
          fontSize: 15,
          height: 1.48,
          leadingDistribution: TextLeadingDistribution.even,
          color: colors.inkDeep,
        ),
        textInputAction: _isDesktopOrWeb ? TextInputAction.newline : TextInputAction.send,
        onSubmitted: _isDesktopOrWeb ? null : (_) => _triggerSend(),
        decoration: InputDecoration(
          filled: false,
          hintText: hintText,
          hintStyle: TextStyle(fontSize: 14.5, color: colors.inkFaint),
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          contentPadding: singleLinePill
              ? const EdgeInsets.symmetric(horizontal: 10, vertical: 8)
              : const EdgeInsets.fromLTRB(16, 15, 16, 10),
          isDense: true,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final door = widget.door;
    if (door.state.isReadOnly) {
      final hasFarewell = door.farewell != null && door.farewell!.trim().isNotEmpty;
      return Container(
        key: const Key('departed_readonly_banner'),
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        decoration: BoxDecoration(
          color: colors.letterSurface,
          border: Border(top: BorderSide(color: colors.hairline)),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    '这段陪伴已停留在纪念只读状态',
                    style: PsyberTheme.editorialSerif.copyWith(
                      color: colors.inkQuiet,
                      fontSize: 13.5,
                    ),
                  ),
                ),
                if (hasFarewell) ...[
                  const SizedBox(width: 12),
                  TextButton(
                    onPressed: () => _openFarewellDialog(context, door.farewell!),
                    child: const Text('查看告别信', style: TextStyle(fontSize: 13)),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    }

    final isDesktopLayout =
        _isDesktopOrWeb || MediaQuery.sizeOf(context).width >= 720;
    final canUseUrgent = door.state == DoorState.closed;
    final isUrgentActive = canUseUrgent && _urgentOpen;
    final isDoorNote = door.state.isDoorNoteMode && !isUrgentActive;
    final isQuiet = door.state == DoorState.quiet;
    final showModelCapsule =
        widget.onSelectThinkingLevel != null || widget.onSelectChatSlot != null;

    final bottomSafe = MediaQuery.paddingOf(context).bottom;
    final bottomPad = isDesktopLayout
        ? 14.0
        : (bottomSafe > 0 ? math.max(bottomSafe - 16.0, 10.0) : 8.0);

    return Container(
      padding: EdgeInsets.fromLTRB(16, 4, 16, bottomPad),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (isQuiet)
                Padding(
                  padding: const EdgeInsets.only(left: 10, bottom: 6),
                  child: Text(
                    '${(widget.residentName != null && widget.residentName!.trim().isNotEmpty) ? widget.residentName!.trim() : 'Psyber'}此刻在忙自己的事，留言会先安静放着',
                    style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                  ),
                ),
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: widget.controller,
                builder: (context, textValue, _) {
                  final hasDraft = textValue.text.trim().isNotEmpty ||
                      widget.pendingAttachments.isNotEmpty ||
                      widget.pendingVideoClip != null ||
                      widget.pendingSticker != null;
                  final showSingleLineMobilePill = !isDesktopLayout &&
                      !_inputFocused &&
                      !hasDraft &&
                      !widget.isReplying &&
                      !widget.isDraggingFiles &&
                      !_isVoiceActive &&
                      !door.state.isDoorNoteMode;

                  final borderRadius = BorderRadius.circular(
                    showSingleLineMobilePill
                        ? 28
                        : (isDoorNote ? 14 : (isDesktopLayout ? 18 : 20)),
                  );
                  final borderColor = _voiceMode == _VoiceCaptureMode.canceling
                      ? colors.dangerInk
                      : (_isVoiceActive
                          ? colors.accentBorder
                          : (widget.isDraggingFiles
                              ? colors.accentBorder
                              : (isUrgentActive
                                  ? colors.dangerInk
                                  : (isDoorNote
                                      ? colors.hairlineWarm
                                      : colors.hairline))));

                  return AnimatedSize(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOutCubic,
                    alignment: Alignment.bottomCenter,
                    child: Container(
                      key: _composerCardKey,
                      decoration: BoxDecoration(
                        color: isDoorNote ? colors.slipPaper : colors.letterSurface,
                        borderRadius: borderRadius,
                        border: Border.all(
                          color: borderColor,
                          width: (widget.isDraggingFiles ||
                                  isUrgentActive ||
                                  _voiceMode == _VoiceCaptureMode.canceling)
                              ? 1.5
                              : 1,
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(
                              alpha: colors.isDark ? 0.18 : 0.04,
                            ),
                            blurRadius: 12,
                            offset: const Offset(0, 2),
                          ),
                        ],
                      ),
                      child: _isVoiceActive
                          ? _buildVoiceRecordingCard(
                              colors,
                              isDesktop: isDesktopLayout,
                              isDoorNote: isDoorNote,
                            )
                          : showSingleLineMobilePill
                          ? Padding(
                              padding: const EdgeInsets.fromLTRB(8, 7, 8, 7),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    _buildAddMediaButton(colors, pillFill: true),
                                    Expanded(
                                      child: _buildInputField(
                                        colors,
                                        isUrgentActive: isUrgentActive,
                                        isDoorNote: isDoorNote,
                                        singleLinePill: true,
                                      ),
                                    ),
                                    _buildPrimaryActionButton(
                                      colors,
                                      hasDraft: hasDraft,
                                      isUrgentActive: isUrgentActive,
                                      isDoorNote: isDoorNote,
                                      isDesktop: false,
                                    ),
                                  ],
                                ),
                              )
                            : Column(
                                mainAxisSize: MainAxisSize.min,
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  if (widget.isDraggingFiles)
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
                                      child: Row(
                                        children: [
                                          Icon(
                                            PhosphorIconsLight.paperclip,
                                            size: 14,
                                            color: colors.accent,
                                          ),
                                          const SizedBox(width: 6),
                                          Text(
                                            '松手添加到待发区（图片或短视频）',
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: colors.inkQuiet,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  if (door.state.isDoorNoteMode) ...[
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(16, 9, 10, 6),
                                      child: Row(
                                        children: [
                                          Icon(
                                            isUrgentActive
                                                ? PhosphorIconsLight.lightning
                                                : PhosphorIconsLight.envelopeSimpleOpen,
                                            size: 14,
                                            color: isUrgentActive
                                                ? colors.dangerInk
                                                : colors.thresholdAmber,
                                          ),
                                          const SizedBox(width: 6),
                                          Expanded(
                                            child: Text(
                                              isUrgentActive
                                                  ? '紧急直达（仅此一条）· 发完自动重新关上'
                                                  : '门缝纸条 · 写入后不会打扰或强迫回复',
                                              style: PsyberTheme.editorialSerif.copyWith(
                                                fontSize: 12,
                                                color: isUrgentActive
                                                    ? colors.dangerInk
                                                    : colors.thresholdAmber,
                                              ),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                          if (canUseUrgent)
                                            TextButton(
                                              key: const Key('urgent_channel_button'),
                                              onPressed: widget.sending
                                                  ? null
                                                  : () => unawaited(_confirmUrgentChannel()),
                                              style: TextButton.styleFrom(
                                                padding: const EdgeInsets.symmetric(
                                                  horizontal: 8,
                                                  vertical: 2,
                                                ),
                                                minimumSize: Size.zero,
                                                tapTargetSize:
                                                    MaterialTapTargetSize.shrinkWrap,
                                                foregroundColor: isUrgentActive
                                                    ? colors.inkQuiet
                                                    : colors.thresholdAmber,
                                              ),
                                              child: Text(
                                                isUrgentActive ? '取消紧急' : '有急事',
                                                style: const TextStyle(fontSize: 11.5),
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                    CustomPaint(
                                      size: const Size(double.infinity, 1),
                                      painter: _DashedHairlinePainter(
                                        isUrgentActive
                                            ? colors.dangerSoft
                                            : colors.hairlineWarm,
                                      ),
                                    ),
                                  ],
                                  if (widget.pendingAttachments.isNotEmpty ||
                                      widget.pendingVideoClip != null ||
                                      widget.pendingSticker != null)
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(14, 10, 14, 2),
                                      child: Wrap(
                                        spacing: 8,
                                        runSpacing: 8,
                                        children: [
                                          if (widget.pendingSticker != null)
                                            _PendingStickerChip(
                                              key: const Key('pending_sticker_chip'),
                                              sticker: widget.pendingSticker!,
                                              profile: widget.profile,
                                              onRemove: widget.onClearSticker ?? () {},
                                            ),
                                          if (widget.pendingVideoClip != null)
                                            _PendingVideoChip(
                                              key: const Key('pending_video_chip'),
                                              clip: widget.pendingVideoClip!,
                                              onRemove: widget.onRemoveVideoClip ?? () {},
                                            ),
                                          for (var i = 0;
                                              i < widget.pendingAttachments.length;
                                              i++)
                                            _PendingThumbChip(
                                              key: Key('pending_attachment_$i'),
                                              attachment: widget.pendingAttachments[i],
                                              onRemove: () => widget.onRemoveAttachment(i),
                                            ),
                                        ],
                                      ),
                                    ),
                                  _buildInputField(
                                    colors,
                                    isUrgentActive: isUrgentActive,
                                    isDoorNote: isDoorNote,
                                    singleLinePill: false,
                                  ),
                                  Padding(
                                    padding: const EdgeInsets.fromLTRB(10, 2, 10, 9),
                                    child: Row(
                                      crossAxisAlignment: CrossAxisAlignment.center,
                                      children: [
                                        _buildAddMediaButton(
                                          colors,
                                          pillFill: !isDesktopLayout,
                                        ),
                                        const SizedBox(width: 4),
                                        _buildStickerButton(
                                          colors,
                                          pillFill: !isDesktopLayout,
                                        ),
                                        if (!isDesktopLayout && showModelCapsule) ...[
                                          const SizedBox(width: 6),
                                          _buildModelThinkingCapsule(
                                            colors,
                                            isDesktop: false,
                                            filledPill: true,
                                          ),
                                        ],
                                        const Spacer(),
                                        if (isDesktopLayout && showModelCapsule) ...[
                                          _buildModelThinkingCapsule(
                                            colors,
                                            isDesktop: true,
                                            filledPill: false,
                                          ),
                                          const SizedBox(width: 6),
                                        ],
                                        _buildPrimaryActionButton(
                                          colors,
                                          hasDraft: hasDraft,
                                          isUrgentActive: isUrgentActive,
                                          isDoorNote: isDoorNote,
                                          isDesktop: isDesktopLayout,
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                      ),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PendingStickerChip extends StatelessWidget {
  const _PendingStickerChip({
    super.key,
    required this.sticker,
    required this.profile,
    required this.onRemove,
  });

  final StickerView sticker;
  final ConnectionProfile? profile;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final hasImage = profile != null && sticker.url.isNotEmpty;
    return Container(
      padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
      decoration: BoxDecoration(
        color: colors.mineralCanvas,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.hairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: hasImage
                ? Image.network(
                    profile!.resolveMediaUrl(sticker.url),
                    headers: {'Authorization': 'Bearer ${profile!.token}'},
                    width: 28,
                    height: 28,
                    fit: BoxFit.contain,
                    errorBuilder: (_, __, ___) => SizedBox(
                      width: 28,
                      height: 28,
                      child: Icon(
                        PhosphorIconsLight.smiley,
                        size: 16,
                        color: colors.inkQuiet,
                      ),
                    ),
                  )
                : SizedBox(
                    width: 28,
                    height: 28,
                    child: Icon(
                      PhosphorIconsLight.smiley,
                      size: 16,
                      color: colors.inkQuiet,
                    ),
                  ),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 130),
            child: Text(
              '贴纸：${sticker.label}',
              style: TextStyle(fontSize: 12, color: colors.inkDeep),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            key: const Key('clear_pending_sticker'),
            onTap: onRemove,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.all(2),
              child: Icon(PhosphorIconsLight.x, size: 14, color: colors.inkQuiet),
            ),
          ),
        ],
      ),
    );
  }
}

class _PendingVideoChip extends StatelessWidget {
  const _PendingVideoChip({
    super.key,
    required this.clip,
    required this.onRemove,
  });

  final PendingVideoClip clip;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final durationLabel = clip.durationSec > 0
        ? '${clip.durationSec.toStringAsFixed(clip.durationSec >= 10 ? 0 : 1)}s'
        : '${clip.frameHashes.length} 帧';
    return Container(
      padding: const EdgeInsets.fromLTRB(4, 4, 6, 4),
      decoration: BoxDecoration(
        color: colors.mineralCanvas,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.hairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: clip.previewBytes.isNotEmpty
                ? Stack(
                    alignment: Alignment.center,
                    children: [
                      Image.memory(
                        Uint8List.fromList(clip.previewBytes),
                        width: 34,
                        height: 34,
                        fit: BoxFit.cover,
                      ),
                      Container(
                        width: 18,
                        height: 18,
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.45),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          PhosphorIconsFill.play,
                          size: 10,
                          color: Colors.white,
                        ),
                      ),
                    ],
                  )
                : Container(
                    width: 34,
                    height: 34,
                    color: colors.accentSoft,
                    child: Icon(
                      PhosphorIconsLight.filmStrip,
                      size: 18,
                      color: colors.inkQuiet,
                    ),
                  ),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 140),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  clip.filename,
                  style: TextStyle(fontSize: 12, color: colors.inkDeep),
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  '视频 · $durationLabel',
                  style: TextStyle(fontSize: 10.5, color: colors.inkQuiet),
                ),
              ],
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            onTap: onRemove,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.all(2),
              child: Icon(PhosphorIconsLight.x, size: 14, color: colors.inkQuiet),
            ),
          ),
        ],
      ),
    );
  }
}

class _PendingThumbChip extends StatelessWidget {
  const _PendingThumbChip({
    super.key,
    required this.attachment,
    required this.onRemove,
  });

  final PendingAttachment attachment;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.fromLTRB(4, 4, 6, 4),
      decoration: BoxDecoration(
        color: colors.mineralCanvas,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.hairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: attachment.bytes.isNotEmpty
                ? Image.memory(
                    Uint8List.fromList(attachment.bytes),
                    width: 34,
                    height: 34,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => SizedBox(
                      width: 34,
                      height: 34,
                      child: Icon(PhosphorIconsLight.image, size: 18, color: colors.inkQuiet),
                    ),
                  )
                : SizedBox(
                    width: 34,
                    height: 34,
                    child: Icon(PhosphorIconsLight.image, size: 18, color: colors.inkQuiet),
                  ),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 120),
            child: Text(
              attachment.filename,
              style: TextStyle(fontSize: 12, color: colors.inkDeep),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            onTap: onRemove,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.all(2),
              child: Icon(PhosphorIconsLight.x, size: 14, color: colors.inkQuiet),
            ),
          ),
        ],
      ),
    );
  }
}

class _DashedHairlinePainter extends CustomPainter {
  const _DashedHairlinePainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    const dashWidth = 5.0;
    const dashGap = 4.0;
    var x = 0.0;
    while (x < size.width) {
      canvas.drawLine(Offset(x, 0), Offset((x + dashWidth).clamp(0, size.width), 0), paint);
      x += dashWidth + dashGap;
    }
  }

  @override
  bool shouldRepaint(covariant _DashedHairlinePainter oldDelegate) =>
      oldDelegate.color != color;
}
