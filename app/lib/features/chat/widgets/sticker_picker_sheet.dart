import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// 真图贴纸选择弹窗：
/// 按 pack 分组筛选，4 列缩略图网格带 Bearer Token 拉取真实贴纸（无图/离线时回退文字卡）。
class StickerPickerDialog extends StatefulWidget {
  const StickerPickerDialog({
    super.key,
    required this.stickersFuture,
    required this.profile,
    required this.onSelect,
  });

  final Future<List<StickerView>> stickersFuture;
  final ConnectionProfile? profile;
  final void Function(StickerView sticker) onSelect;

  @override
  State<StickerPickerDialog> createState() => _StickerPickerDialogState();
}

class _StickerPickerDialogState extends State<StickerPickerDialog> {
  String _selectedPack = '全部';

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Dialog(
      backgroundColor: PsyberTheme.letterSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: PsyberTheme.hairline),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440, maxHeight: 460),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Text(
                    '贴纸',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(PhosphorIconsLight.x, size: 18),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Flexible(
                child: FutureBuilder<List<StickerView>>(
                  future: widget.stickersFuture,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState != ConnectionState.done) {
                      return const Center(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: 28),
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      );
                    }
                    final items = snapshot.data ?? const <StickerView>[];
                    if (items.isEmpty) {
                      return const Padding(
                        padding: EdgeInsets.symmetric(vertical: 20),
                        child: Text(
                          '暂无可用贴纸，可将图片放入数据目录的 stickers/ 文件夹后重启同步。',
                          style: TextStyle(
                            fontSize: 13,
                            color: PsyberTheme.inkQuiet,
                            height: 1.5,
                          ),
                        ),
                      );
                    }

                    final packs = <String>{'全部', ...items.map((e) => e.pack)};
                    final filtered = _selectedPack == '全部'
                        ? items
                        : items.where((e) => e.pack == _selectedPack).toList(growable: false);

                    return Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (packs.length > 2) ...[
                          SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: Row(
                              children: [
                                for (final pack in packs)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 6),
                                    child: ChoiceChip(
                                      label: Text(
                                        pack,
                                        style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: _selectedPack == pack
                                              ? FontWeight.w600
                                              : FontWeight.normal,
                                          color: _selectedPack == pack
                                              ? colors.inkDeep
                                              : colors.inkQuiet,
                                        ),
                                      ),
                                      selected: _selectedPack == pack,
                                      selectedColor: colors.accentSoft,
                                      backgroundColor: colors.mineralCanvas,
                                      side: BorderSide(
                                        color: _selectedPack == pack
                                            ? colors.accentBorder
                                            : colors.hairline,
                                      ),
                                      visualDensity: VisualDensity.compact,
                                      onSelected: (_) => setState(() => _selectedPack = pack),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 10),
                        ],
                        Flexible(
                          child: GridView.builder(
                            shrinkWrap: true,
                            itemCount: filtered.length,
                            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                              crossAxisCount: 4,
                              crossAxisSpacing: 8,
                              mainAxisSpacing: 8,
                              childAspectRatio: 0.86,
                            ),
                            itemBuilder: (context, index) {
                              final sticker = filtered[index];
                              final hasImage =
                                  widget.profile != null && sticker.url.isNotEmpty;
                              return InkWell(
                                key: Key('sticker_option_${sticker.id}'),
                                borderRadius: BorderRadius.circular(12),
                                onTap: () {
                                  Navigator.of(context).pop();
                                  widget.onSelect(sticker);
                                },
                                child: Container(
                                  padding: const EdgeInsets.all(6),
                                  decoration: BoxDecoration(
                                    color: PsyberTheme.mineralCanvas,
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(color: PsyberTheme.hairline),
                                  ),
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Expanded(
                                        child: hasImage
                                            ? ClipRRect(
                                                borderRadius: BorderRadius.circular(8),
                                                child: Image.network(
                                                  widget.profile!.resolveMediaUrl(sticker.url),
                                                  headers: {
                                                    'Authorization':
                                                        'Bearer ${widget.profile!.token}',
                                                  },
                                                  fit: BoxFit.contain,
                                                  errorBuilder: (_, __, ___) => Icon(
                                                    PhosphorIconsLight.smiley,
                                                    size: 28,
                                                    color: colors.inkQuiet,
                                                  ),
                                                ),
                                              )
                                            : Icon(
                                                PhosphorIconsLight.smiley,
                                                size: 28,
                                                color: colors.inkQuiet,
                                              ),
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        sticker.label,
                                        style: const TextStyle(
                                          fontSize: 11,
                                          color: PsyberTheme.inkQuiet,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        textAlign: TextAlign.center,
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
