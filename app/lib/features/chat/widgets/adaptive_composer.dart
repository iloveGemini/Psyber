import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

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

/// 门态自适应输入台：
/// - open / quiet：居中阅读栏内嵌输入胶囊，支持本地图片/短视频缩略图预览与贴纸；
/// - closed / cooling_off：切换为折痕纸感「门缝纸条」，不展示对方正在输入；
/// - departed：转为纪念只读底栏并允许查阅告别信。
/// - 桌面端支持 Enter / ⌘Enter 发送、Shift+Enter 换行与 ⌘V 粘贴图片/文件；移动端 Enter 换行。
class AdaptiveComposer extends StatefulWidget {
  const AdaptiveComposer({
    super.key,
    required this.door,
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
    this.onAbort,
    required this.onSend,
  });

  final DoorStatus door;
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
  final VoidCallback? onAbort;
  final void Function({bool urgent}) onSend;

  @override
  State<AdaptiveComposer> createState() => _AdaptiveComposerState();
}

class _AdaptiveComposerState extends State<AdaptiveComposer> {
  late final FocusNode _inputFocusNode;
  bool _urgentOpen = false;

  bool get _isDesktopOrWeb {
    if (kIsWeb) return true;
    return defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.windows ||
        defaultTargetPlatform == TargetPlatform.linux;
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
  }

  @override
  void didUpdateWidget(covariant AdaptiveComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.door.state != DoorState.closed && _urgentOpen) {
      _urgentOpen = false;
    }
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

  @override
  void dispose() {
    _inputFocusNode.dispose();
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

    final canUseUrgent = door.state == DoorState.closed;
    final isUrgentActive = canUseUrgent && _urgentOpen;
    final isDoorNote = door.state.isDoorNoteMode && !isUrgentActive;
    final isQuiet = door.state == DoorState.quiet;

    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 6, 16, 14),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (isQuiet)
                  Padding(
                    padding: const EdgeInsets.only(left: 8, bottom: 6),
                    child: Text(
                      '对方此刻在忙自己的事，留言会先安静放着',
                      style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                    ),
                  ),
                Container(
                  decoration: BoxDecoration(
                    color: isDoorNote ? colors.slipPaper : colors.letterSurface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: widget.isDraggingFiles
                          ? colors.accentBorder
                          : (isUrgentActive
                              ? colors.dangerInk
                              : (isDoorNote ? colors.hairlineWarm : colors.hairline)),
                      width: (widget.isDraggingFiles || isUrgentActive) ? 1.5 : 1,
                    ),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (widget.isDraggingFiles)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
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
                          padding: const EdgeInsets.fromLTRB(14, 8, 10, 6),
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
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
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
                            isUrgentActive ? colors.dangerSoft : colors.hairlineWarm,
                          ),
                        ),
                      ],
                      if (widget.pendingAttachments.isNotEmpty ||
                          widget.pendingVideoClip != null ||
                          widget.pendingSticker != null)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
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
                              for (var i = 0; i < widget.pendingAttachments.length; i++)
                                _PendingThumbChip(
                                  key: Key('pending_attachment_$i'),
                                  attachment: widget.pendingAttachments[i],
                                  onRemove: () => widget.onRemoveAttachment(i),
                                ),
                            ],
                          ),
                        ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            IconButton(
                              key: const Key('pick_image_button'),
                              tooltip: '选择图片',
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints.tightFor(
                                width: 30,
                                height: 30,
                              ),
                              style: IconButton.styleFrom(
                                minimumSize: const Size(30, 30),
                                fixedSize: const Size(30, 30),
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              onPressed: (widget.sending || widget.uploadingImage)
                                  ? null
                                  : widget.onPickImage,
                              icon: widget.uploadingImage
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : Icon(
                                      PhosphorIconsLight.image,
                                      size: 18,
                                      color: colors.inkQuiet,
                                    ),
                            ),
                            const SizedBox(width: 2),
                            IconButton(
                              key: const Key('open_stickers_button'),
                              tooltip: '发送贴纸',
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints.tightFor(
                                width: 30,
                                height: 30,
                              ),
                              style: IconButton.styleFrom(
                                minimumSize: const Size(30, 30),
                                fixedSize: const Size(30, 30),
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              onPressed: widget.sending ? null : widget.onOpenStickers,
                              icon: Icon(
                                PhosphorIconsLight.smiley,
                                size: 18,
                                color: colors.inkQuiet,
                              ),
                            ),
                            Expanded(
                              child: TextField(
                                key: const Key('chat_input_field'),
                                focusNode: _inputFocusNode,
                                controller: widget.controller,
                                minLines: 1,
                                maxLines: 5,
                                textAlignVertical: TextAlignVertical.center,
                                style: TextStyle(
                                  fontSize: 14.5,
                                  height: 1.35,
                                  leadingDistribution:
                                      TextLeadingDistribution.even,
                                  color: colors.inkDeep,
                                ),
                                textInputAction: _isDesktopOrWeb
                                    ? TextInputAction.newline
                                    : TextInputAction.send,
                                onSubmitted:
                                    _isDesktopOrWeb ? null : (_) => _triggerSend(),
                                decoration: InputDecoration(
                                  filled: false,
                                  hintText: isUrgentActive
                                      ? '紧急直达（仅此一条）…'
                                      : (isDoorNote ? '写下要塞进门缝的纸条…' : '说点什么…'),
                                  border: InputBorder.none,
                                  enabledBorder: InputBorder.none,
                                  focusedBorder: InputBorder.none,
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 5,
                                  ),
                                  isDense: true,
                                ),
                              ),
                            ),
                            const SizedBox(width: 6),
                            ValueListenableBuilder<TextEditingValue>(
                              valueListenable: widget.controller,
                              builder: (context, textValue, _) {
                                final hasDraft = textValue.text.trim().isNotEmpty ||
                                    widget.pendingAttachments.isNotEmpty ||
                                    widget.pendingVideoClip != null ||
                                    widget.pendingSticker != null;

                                if (widget.isReplying) {
                                  return Tooltip(
                                    message: '停止生成',
                                    child: IconButton(
                                      key: const Key('chat_stop_button'),
                                      padding: EdgeInsets.zero,
                                      constraints: const BoxConstraints.tightFor(
                                        width: 30,
                                        height: 30,
                                      ),
                                      style: IconButton.styleFrom(
                                        minimumSize: const Size(30, 30),
                                        fixedSize: const Size(30, 30),
                                        backgroundColor: colors.accent,
                                        foregroundColor: colors.onAccent,
                                        shape: const CircleBorder(),
                                        tapTargetSize:
                                            MaterialTapTargetSize.shrinkWrap,
                                      ),
                                      onPressed: widget.onAbort,
                                      icon: const Icon(
                                        PhosphorIconsFill.stop,
                                        size: 12,
                                      ),
                                    ),
                                  );
                                }

                                if (hasDraft) {
                                  final Color btnBg = isUrgentActive
                                      ? colors.dangerInk
                                      : (isDoorNote
                                          ? colors.thresholdAmberSoft
                                          : colors.accent);
                                  final Color btnFg = isUrgentActive
                                      ? Colors.white
                                      : (isDoorNote
                                          ? colors.thresholdAmber
                                          : colors.onAccent);
                                  final BorderSide? btnSide = isDoorNote
                                      ? BorderSide(color: colors.thresholdAmber)
                                      : null;

                                  return Tooltip(
                                    message: isUrgentActive
                                        ? '紧急发送'
                                        : (isDoorNote ? '塞纸条' : '发送'),
                                    child: IconButton(
                                      key: const Key('chat_send_button'),
                                      padding: EdgeInsets.zero,
                                      constraints: const BoxConstraints.tightFor(
                                        width: 30,
                                        height: 30,
                                      ),
                                      style: IconButton.styleFrom(
                                        minimumSize: const Size(30, 30),
                                        fixedSize: const Size(30, 30),
                                        backgroundColor: btnBg,
                                        foregroundColor: btnFg,
                                        side: btnSide,
                                        shape: const CircleBorder(),
                                        tapTargetSize:
                                            MaterialTapTargetSize.shrinkWrap,
                                      ),
                                      onPressed:
                                          widget.sending ? null : _triggerSend,
                                      icon: widget.sending
                                          ? SizedBox(
                                              width: 13,
                                              height: 13,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                                color: btnFg,
                                              ),
                                            )
                                          : const Icon(
                                              PhosphorIconsLight.arrowUp,
                                              size: 16,
                                            ),
                                    ),
                                  );
                                }

                                return Tooltip(
                                  message: '语音输入',
                                  child: IconButton(
                                    key: const Key('chat_voice_button'),
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints.tightFor(
                                      width: 30,
                                      height: 30,
                                    ),
                                    style: IconButton.styleFrom(
                                      minimumSize: const Size(30, 30),
                                      fixedSize: const Size(30, 30),
                                      backgroundColor: Colors.transparent,
                                      foregroundColor: isDoorNote
                                          ? colors.thresholdAmber
                                          : colors.inkQuiet,
                                      side: BorderSide(
                                        color: isDoorNote
                                            ? colors.hairlineWarm
                                            : colors.hairline,
                                      ),
                                      shape: const CircleBorder(),
                                      tapTargetSize:
                                          MaterialTapTargetSize.shrinkWrap,
                                    ),
                                    onPressed: widget.sending
                                        ? null
                                        : widget.onVoiceInput,
                                    icon: const Icon(
                                      PhosphorIconsLight.microphone,
                                      size: 16,
                                    ),
                                  ),
                                );
                              },
                            ),
                          ],
                        ),
                      ),
                    ],
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
