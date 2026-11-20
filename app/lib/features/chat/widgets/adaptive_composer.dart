import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
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
class AdaptiveComposer extends StatelessWidget {
  const AdaptiveComposer({
    super.key,
    required this.door,
    required this.controller,
    required this.pendingAttachments,
    required this.uploadingImage,
    required this.sending,
    required this.onPickImage,
    required this.onOpenStickers,
    required this.onRemoveAttachment,
    required this.onSend,
  });

  final DoorStatus door;
  final TextEditingController controller;
  final List<PendingAttachment> pendingAttachments;
  final bool uploadingImage;
  final bool sending;
  final VoidCallback onPickImage;
  final VoidCallback onOpenStickers;
  final void Function(int index) onRemoveAttachment;
  final VoidCallback onSend;

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
                    borderRadius: BorderRadius.circular(isDoorNote ? 12 : 16),
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
                      if (pendingAttachments.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
                          child: Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (var i = 0; i < pendingAttachments.length; i++)
                                _PendingThumbChip(
                                  key: Key('pending_attachment_$i'),
                                  attachment: pendingAttachments[i],
                                  onRemove: () => onRemoveAttachment(i),
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
                              onPressed: (sending || uploadingImage) ? null : onPickImage,
                              icon: uploadingImage
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
                              onPressed: sending ? null : onOpenStickers,
                              icon: Icon(
                                PhosphorIconsLight.smiley,
                                size: 20,
                                color: colors.inkQuiet,
                              ),
                            ),
                            Expanded(
                              child: TextField(
                                key: const Key('chat_input_field'),
                                controller: controller,
                                minLines: 1,
                                maxLines: 5,
                                textInputAction: TextInputAction.send,
                                onSubmitted: (_) => onSend(),
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
                              child: FilledButton(
                                key: const Key('chat_send_button'),
                                onPressed: sending ? null : onSend,
                                style: FilledButton.styleFrom(
                                  backgroundColor: isDoorNote
                                      ? colors.thresholdAmber
                                      : colors.accent,
                                  foregroundColor: isDoorNote
                                      ? Colors.white
                                      : colors.onAccent,
                                  elevation: 0,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 16,
                                    vertical: 9,
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(9),
                                  ),
                                  minimumSize: const Size(60, 34),
                                ),
                                child: Text(
                                  isDoorNote ? '塞纸条' : '发送',
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: isDoorNote
                                        ? Colors.white
                                        : colors.onAccent,
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
              ],
            ),
          ),
        ),
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
