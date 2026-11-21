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

/// 门态自适应输入台：
/// - open / quiet：居中阅读栏内嵌输入胶囊，支持本地图片缩略图预览与贴纸；
/// - closed / cooling_off：切换为折痕纸感「门缝纸条」，不展示对方正在输入；
/// - departed：转为纪念只读底栏并允许查阅告别信。
/// - 桌面端支持 Enter 发送、Shift+Enter 换行（IME 输入法候选词组合态安全放行）。
class AdaptiveComposer extends StatefulWidget {
  const AdaptiveComposer({
    super.key,
    required this.door,
    required this.controller,
    required this.pendingAttachments,
    this.pendingSticker,
    this.profile,
    required this.uploadingImage,
    required this.sending,
    required this.onPickImage,
    required this.onOpenStickers,
    required this.onRemoveAttachment,
    this.onClearSticker,
    required this.onSend,
  });

  final DoorStatus door;
  final TextEditingController controller;
  final List<PendingAttachment> pendingAttachments;
  final StickerView? pendingSticker;
  final ConnectionProfile? profile;
  final bool uploadingImage;
  final bool sending;
  final VoidCallback onPickImage;
  final VoidCallback onOpenStickers;
  final void Function(int index) onRemoveAttachment;
  final VoidCallback? onClearSticker;
  final VoidCallback onSend;

  @override
  State<AdaptiveComposer> createState() => _AdaptiveComposerState();
}

class _AdaptiveComposerState extends State<AdaptiveComposer> {
  late final FocusNode _inputFocusNode;

  bool get _isDesktopOrWeb {
    if (kIsWeb) return true;
    return defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.windows ||
        defaultTargetPlatform == TargetPlatform.linux;
  }

  @override
  void initState() {
    super.initState();
    _inputFocusNode = FocusNode(
      onKeyEvent: (node, event) {
        if (!_isDesktopOrWeb) return KeyEventResult.ignored;
        if (event is! KeyDownEvent) return KeyEventResult.ignored;
        final isEnter = event.logicalKey == LogicalKeyboardKey.enter ||
            event.logicalKey == LogicalKeyboardKey.numpadEnter;
        if (!isEnter) return KeyEventResult.ignored;

        // 拼音/日文等输入法处于候选词组合态时不误发
        final composing = widget.controller.value.composing;
        if (composing.isValid && !composing.isCollapsed) {
          return KeyEventResult.ignored;
        }
        if (HardwareKeyboard.instance.isShiftPressed) {
          return KeyEventResult.ignored;
        }
        if (!widget.sending) {
          widget.onSend();
        }
        return KeyEventResult.handled;
      },
    );
  }

  @override
  void dispose() {
    _inputFocusNode.dispose();
    super.dispose();
  }

  void _openFarewellDialog(BuildContext context, String farewell) {
    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          backgroundColor: PsyberTheme.slipPaper,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: PsyberTheme.hairlineWarm),
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

    final isDoorNote = door.state.isDoorNoteMode;
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
                      color: isDoorNote ? colors.hairlineWarm : colors.hairline,
                    ),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (isDoorNote) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 9, 14, 6),
                          child: Row(
                            children: [
                              Icon(
                                PhosphorIconsLight.envelopeSimpleOpen,
                                size: 14,
                                color: colors.thresholdAmber,
                              ),
                              const SizedBox(width: 6),
                              Text(
                                '门缝纸条 · 写入后不会打扰或强迫回复',
                                style: PsyberTheme.editorialSerif.copyWith(
                                  fontSize: 12,
                                  color: colors.thresholdAmber,
                                ),
                              ),
                            ],
                          ),
                        ),
                        CustomPaint(
                          size: const Size(double.infinity, 1),
                          painter: _DashedHairlinePainter(colors.hairlineWarm),
                        ),
                      ],
                      if (widget.pendingAttachments.isNotEmpty ||
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
                        padding: const EdgeInsets.fromLTRB(6, 6, 8, 6),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            IconButton(
                              key: const Key('pick_image_button'),
                              tooltip: '选择图片',
                              onPressed: (widget.sending || widget.uploadingImage)
                                  ? null
                                  : widget.onPickImage,
                              icon: widget.uploadingImage
                                  ? const SizedBox(
                                      width: 18,
                                      height: 18,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : Icon(
                                      PhosphorIconsLight.image,
                                      size: 20,
                                      color: colors.inkQuiet,
                                    ),
                            ),
                            IconButton(
                              key: const Key('open_stickers_button'),
                              tooltip: '发送贴纸',
                              onPressed: widget.sending ? null : widget.onOpenStickers,
                              icon: Icon(
                                PhosphorIconsLight.smiley,
                                size: 20,
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
                                textInputAction: _isDesktopOrWeb
                                    ? TextInputAction.newline
                                    : TextInputAction.send,
                                onSubmitted:
                                    _isDesktopOrWeb ? null : (_) => widget.onSend(),
                                decoration: InputDecoration(
                                  filled: false,
                                  hintText: isDoorNote
                                      ? '写下要塞进门缝的纸条…'
                                      : '说点什么…',
                                  border: InputBorder.none,
                                  enabledBorder: InputBorder.none,
                                  focusedBorder: InputBorder.none,
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 10,
                                  ),
                                  isDense: true,
                                ),
                              ),
                            ),
                            const SizedBox(width: 6),
                            Padding(
                              padding: const EdgeInsets.only(bottom: 2),
                              child: ValueListenableBuilder<TextEditingValue>(
                                valueListenable: widget.controller,
                                builder: (context, textValue, _) {
                                  final hasDraft = textValue.text.trim().isNotEmpty ||
                                      widget.pendingAttachments.isNotEmpty ||
                                      widget.pendingSticker != null;
                                  final Color btnBg;
                                  final Color btnBorder;
                                  final Color btnText;
                                  if (isDoorNote) {
                                    btnBg = hasDraft
                                        ? colors.thresholdAmberSoft
                                        : Colors.transparent;
                                    btnBorder = hasDraft
                                        ? colors.thresholdAmber
                                        : colors.hairlineWarm;
                                    btnText = colors.thresholdAmber;
                                  } else {
                                    btnBg = hasDraft
                                        ? colors.accentSoft
                                        : Colors.transparent;
                                    btnBorder = hasDraft
                                        ? colors.accentBorder
                                        : colors.hairline;
                                    btnText = hasDraft ? colors.inkDeep : colors.inkQuiet;
                                  }

                                  return FilledButton(
                                    key: const Key('chat_send_button'),
                                    onPressed: widget.sending ? null : widget.onSend,
                                    style: FilledButton.styleFrom(
                                      backgroundColor: btnBg,
                                      foregroundColor: btnText,
                                      elevation: 0,
                                      side: BorderSide(color: btnBorder),
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 14,
                                        vertical: 8,
                                      ),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(9),
                                      ),
                                      minimumSize: const Size(58, 34),
                                    ),
                                    child: Text(
                                      isDoorNote ? '塞纸条' : '发送',
                                      style: TextStyle(
                                        fontSize: 13,
                                        fontWeight:
                                            hasDraft ? FontWeight.w500 : FontWeight.w400,
                                        color: btnText,
                                      ),
                                    ),
                                  );
                                },
                              ),
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
    return Container(
      padding: const EdgeInsets.fromLTRB(4, 4, 6, 4),
      decoration: BoxDecoration(
        color: PsyberTheme.mineralCanvas,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: PsyberTheme.hairline),
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
                    errorBuilder: (_, __, ___) => const SizedBox(
                      width: 34,
                      height: 34,
                      child: Icon(PhosphorIconsLight.image, size: 18, color: PsyberTheme.inkQuiet),
                    ),
                  )
                : const SizedBox(
                    width: 34,
                    height: 34,
                    child: Icon(PhosphorIconsLight.image, size: 18, color: PsyberTheme.inkQuiet),
                  ),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 120),
            child: Text(
              attachment.filename,
              style: const TextStyle(fontSize: 12, color: PsyberTheme.inkDeep),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            onTap: onRemove,
            borderRadius: BorderRadius.circular(10),
            child: const Padding(
              padding: EdgeInsets.all(2),
              child: Icon(PhosphorIconsLight.x, size: 14, color: PsyberTheme.inkQuiet),
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
