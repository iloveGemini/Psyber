import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/rich_message_text.dart';
import '../../shared/theme.dart';

/// Ring 1.5 上锁抽屉弹窗（对应 C1.6 / Spec 03 §1.2）：
/// 先仅列出标题与封蜡状态；拆封前必弹二次确认告知「打开后对方会知道」，
/// 服务端若尚处 Ring 1 未挂载 /drawer 则给出温和分期说明。
class DrawerModal extends StatefulWidget {
  const DrawerModal({
    super.key,
    required this.controller,
  });

  final AppController controller;

  @override
  State<DrawerModal> createState() => _DrawerModalState();
}

class _DrawerModalState extends State<DrawerModal> {
  bool _loading = true;
  bool _unavailable = false;
  String? _error;
  List<DrawerEntryView> _entries = const <DrawerEntryView>[];
  DrawerOpenedContent? _opened;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _unavailable = false;
    });
    try {
      final list = await widget.controller.listDrawer();
      if (!mounted) return;
      setState(() {
        _entries = list;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (e.isEndpointUnavailable) {
          _unavailable = true;
        } else {
          _error = e.message;
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '暂时无法打开抽屉列表';
      });
    }
  }

  Future<void> _confirmAndOpen(DrawerEntryView entry) async {
    final colors = context.colors;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.letterSurface,
        title: Text(
          '拆封私密日记',
          style: TextStyle(fontSize: 17, color: colors.inkDeep),
        ),
        content: Text(
          '「${entry.title}」上面贴着封条。拆开阅读会立即写入记录并让${widget.controller.identityNotifier.value.residentSubject}知道，确认要打开吗？',
          style: TextStyle(fontSize: 14, color: colors.inkQuiet, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('先不看'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: colors.thresholdAmber,
              foregroundColor: colors.onAccent,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('确认拆封'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    try {
      final content = await widget.controller.openDrawerEntry(entry.id);
      if (!mounted || content == null) return;
      setState(() => _opened = content);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = '拆封失败，请稍后重试');
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Dialog(
      backgroundColor: colors.letterSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.hairline),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460, maxHeight: 540),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  if (_opened != null)
                    IconButton(
                      icon: Icon(PhosphorIconsLight.arrowLeft, size: 18, color: colors.inkDeep),
                      onPressed: () {
                        setState(() => _opened = null);
                        unawaited(_load());
                      },
                    ),
                  Icon(
                    PhosphorIconsLight.lock,
                    size: 18,
                    color: colors.thresholdAmber,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _opened != null ? _opened!.title : '上锁的抽屉',
                      style: PsyberTheme.editorialSerif.copyWith(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        color: colors.inkDeep,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: Icon(PhosphorIconsLight.x, size: 18, color: colors.inkQuiet),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              ValueListenableBuilder<IdentityInfo>(
                valueListenable: widget.controller.identityNotifier,
                builder: (context, identity, _) => Text(
                  '这里放着${identity.displayResidentName}自己留下的私密日记。未经拆封不会外泄，一旦拆封必定留痕。',
                  style: TextStyle(fontSize: 12.5, color: colors.inkQuiet, height: 1.45),
                ),
              ),
              const SizedBox(height: 14),
              Flexible(
                child: _loading
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: 28),
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : _unavailable
                        ? Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: colors.mineralCanvas,
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(color: colors.hairline),
                            ),
                            child: Text(
                              '当前服务端暂未开启上锁抽屉功能。',
                              style: TextStyle(
                                fontSize: 13,
                                color: colors.inkQuiet,
                                height: 1.5,
                              ),
                            ),
                          )
                        : _error != null
                            ? Text(
                                _error!,
                                style: TextStyle(color: colors.dangerInk, fontSize: 13),
                              )
                            : _opened != null
                                ? SingleChildScrollView(
                                    child: Container(
                                      padding: const EdgeInsets.all(14),
                                      decoration: BoxDecoration(
                                        color: colors.slipPaper,
                                        borderRadius: BorderRadius.circular(12),
                                        border: Border.all(color: colors.hairlineWarm),
                                      ),
                                      child: RichMessageText(text: _opened!.content),
                                    ),
                                  )
                                : _entries.isEmpty
                                    ? Padding(
                                        padding: const EdgeInsets.symmetric(vertical: 20),
                                        child: Text(
                                          '抽屉里还是空的。',
                                          style: TextStyle(
                                            fontSize: 13,
                                            color: colors.inkQuiet,
                                          ),
                                        ),
                                      )
                                    : ListView.separated(
                                        shrinkWrap: true,
                                        itemCount: _entries.length,
                                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                                        itemBuilder: (context, index) {
                                          final entry = _entries[index];
                                          return InkWell(
                                            borderRadius: BorderRadius.circular(12),
                                            onTap: () => unawaited(_confirmAndOpen(entry)),
                                            child: Container(
                                              padding: const EdgeInsets.symmetric(
                                                horizontal: 14,
                                                vertical: 12,
                                              ),
                                              decoration: BoxDecoration(
                                                color: colors.mineralCanvas,
                                                borderRadius: BorderRadius.circular(12),
                                                border: Border.all(color: colors.hairline),
                                              ),
                                              child: Row(
                                                children: [
                                                  Icon(
                                                    entry.peeked
                                                        ? PhosphorIconsLight.lockOpen
                                                        : PhosphorIconsLight.sealCheck,
                                                    size: 16,
                                                    color: entry.peeked
                                                        ? colors.thresholdAmber
                                                        : colors.inkQuiet,
                                                  ),
                                                  const SizedBox(width: 10),
                                                  Expanded(
                                                    child: Text(
                                                      entry.title,
                                                      style: TextStyle(
                                                        fontSize: 14,
                                                        color: colors.inkDeep,
                                                      ),
                                                    ),
                                                  ),
                                                  Text(
                                                    entry.peeked ? '已拆封' : '封蜡完好',
                                                    style: TextStyle(
                                                      fontSize: 11.5,
                                                      color: entry.peeked
                                                          ? colors.thresholdAmber
                                                          : colors.inkQuiet,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
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
