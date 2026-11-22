import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/media/image_picker.dart';
import '../../../core/models/models.dart';
import '../../../core/network/api_client.dart';
import '../../../core/state/app_controller.dart';
import '../../../shared/theme.dart';

/// 左侧栏顶部「双人状态卡」：
/// - 上方：住户头像（点击可更换）、门状态/回复状态与门牌心绪短句；
/// - 下方：用户头像（点击可更换）、主动挂出的心绪短句与一键「勿扰」开关。
class DualStatusCard extends StatefulWidget {
  const DualStatusCard({
    super.key,
    required this.controller,
    this.imagePicker,
  });

  final AppController controller;
  final ImageFilePicker? imagePicker;

  @override
  State<DualStatusCard> createState() => _DualStatusCardState();
}

class _DualStatusCardState extends State<DualStatusCard> {
  static const int _moodMaxLen = 60;

  bool _editingMood = false;
  bool _saving = false;
  bool _uploadingAvatar = false;
  late final TextEditingController _moodController;

  @override
  void initState() {
    super.initState();
    _moodController = TextEditingController(
      text: widget.controller.userStatusNotifier.value.moodText ?? '',
    );
  }

  @override
  void dispose() {
    _moodController.dispose();
    super.dispose();
  }

  String _describeDoor(DoorStatus door, bool isReplying) {
    if (isReplying) return '正在回复';
    switch (door.state) {
      case DoorState.open:
        return '门开着';
      case DoorState.quiet:
        return '门虚掩';
      case DoorState.closed:
        return '门关着';
      case DoorState.coolingOff:
        return '冷静期';
      case DoorState.departed:
        return '已告别';
    }
  }

  Future<void> _toggleUndisturbed(bool next) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.controller.updateUserStatus(undisturbed: next);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text('更新勿扰状态失败，请稍后重试')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _saveMood({bool clear = false}) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      final text = _moodController.text.trim();
      await widget.controller.updateUserStatus(
        moodText: clear ? null : text,
        clearMood: clear || text.isEmpty,
      );
      if (mounted) {
        if (clear) _moodController.clear();
        setState(() => _editingMood = false);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text('保存心绪失败，请稍后重试')),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _pickAndUploadAvatar(String who) async {
    if (_uploadingAvatar) return;
    final picker = widget.imagePicker ?? defaultPlatformImagePicker;
    final picked = await picker();
    if (picked == null || !mounted) return;
    setState(() => _uploadingAvatar = true);
    try {
      await widget.controller.uploadAvatar(
        who: who,
        bytes: picked.bytes,
        filename: picked.filename,
        mimeType: picked.mimeType,
      );
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)
        ?..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(who == 'resident' ? '住户头像已更新' : '我的头像已更新'),
            duration: const Duration(seconds: 2),
          ),
        );
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text(e.message)),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('头像上传失败，请稍后重试')),
      );
    } finally {
      if (mounted) setState(() => _uploadingAvatar = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ValueListenableBuilder<SettingsSnapshot?>(
      valueListenable: widget.controller.settingsNotifier,
      builder: (context, settingsSnap, _) => ValueListenableBuilder<DoorStatus>(
        valueListenable: widget.controller.doorNotifier,
        builder: (context, door, _) => ValueListenableBuilder<ActiveTurnState?>(
          valueListenable: widget.controller.activeTurnNotifier,
          builder: (context, activeTurn, _) => ValueListenableBuilder<UserStatus>(
            valueListenable: widget.controller.userStatusNotifier,
            builder: (context, userStatus, _) {
              final profile = widget.controller.profileNotifier.value;
              final isReplying = activeTurn != null;
              final doorLabel = _describeDoor(door, isReplying);
              final residentDotColor = door.state == DoorState.open
                  ? colors.statusSuccess
                  : (door.state == DoorState.departed
                      ? colors.inkFaint
                      : colors.thresholdAmber);
              final residentNote = door.note?.trim();

              return Container(
                key: const Key('dual_status_card'),
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Row 1: 住户（头像在左，门牌心绪气泡在右）
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _StatusAvatar(
                          key: const Key('quick_resident_avatar'),
                          tooltip: '点击更换住户头像',
                          icon: PhosphorIconsLight.sparkle,
                          bgColor: colors.celadonWash,
                          iconColor: colors.inkDeep,
                          dotColor: residentDotColor,
                          imageUrl: settingsSnap?.residentAvatarUrl,
                          profile: profile,
                          onTap: _uploadingAvatar
                              ? null
                              : () => unawaited(_pickAndUploadAvatar('resident')),
                        ),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Text(
                                  '住户',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                    color: colors.inkDeep,
                                  ),
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  '· $doorLabel',
                                  style: TextStyle(
                                    fontSize: 10.5,
                                    color: colors.inkQuiet,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 7,
                              ),
                              decoration: BoxDecoration(
                                color: colors.letterSurface,
                                borderRadius: const BorderRadius.only(
                                  topLeft: Radius.circular(4),
                                  topRight: Radius.circular(12),
                                  bottomLeft: Radius.circular(12),
                                  bottomRight: Radius.circular(12),
                                ),
                                border: Border.all(color: colors.hairline),
                              ),
                              child: Text(
                                (residentNote != null && residentNote.isNotEmpty)
                                    ? residentNote
                                    : '在屋里安静待着…',
                                style: TextStyle(
                                  fontSize: 12,
                                  height: 1.4,
                                  color: (residentNote != null && residentNote.isNotEmpty)
                                      ? colors.inkDeep
                                      : colors.inkQuiet,
                                  fontStyle: (residentNote != null && residentNote.isNotEmpty)
                                      ? FontStyle.normal
                                      : FontStyle.italic,
                                ),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  // Row 2: 用户（心绪气泡在左，头像在右，自带一键「勿扰」开关）
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.end,
                              children: [
                                InkWell(
                                  key: const Key('user_dnd_toggle'),
                                  borderRadius: BorderRadius.circular(10),
                                  onTap: _saving
                                      ? null
                                      : () => unawaited(
                                            _toggleUndisturbed(!userStatus.undisturbed),
                                          ),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 7,
                                      vertical: 2,
                                    ),
                                    decoration: BoxDecoration(
                                      color: userStatus.undisturbed
                                          ? colors.thresholdAmberSoft
                                          : colors.celadonWash,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: userStatus.undisturbed
                                            ? colors.thresholdAmber
                                            : colors.hairline,
                                        width: 0.8,
                                      ),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(
                                          userStatus.undisturbed
                                              ? PhosphorIconsFill.moon
                                              : PhosphorIconsLight.moon,
                                          size: 11,
                                          color: userStatus.undisturbed
                                              ? colors.thresholdAmber
                                              : colors.inkQuiet,
                                        ),
                                        const SizedBox(width: 3),
                                        Text(
                                          userStatus.undisturbed ? '勿扰中' : '勿扰',
                                          style: TextStyle(
                                            fontSize: 10.5,
                                            fontWeight: userStatus.undisturbed
                                                ? FontWeight.w600
                                                : FontWeight.w500,
                                            color: userStatus.undisturbed
                                                ? colors.thresholdAmber
                                                : colors.inkQuiet,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  '我',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                    color: colors.inkDeep,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            InkWell(
                              key: const Key('user_mood_bubble'),
                              borderRadius: const BorderRadius.only(
                                topLeft: Radius.circular(12),
                                topRight: Radius.circular(4),
                                bottomLeft: Radius.circular(12),
                                bottomRight: Radius.circular(12),
                              ),
                              onTap: () {
                                _moodController.text = userStatus.moodText ?? '';
                                setState(() => _editingMood = !_editingMood);
                              },
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 7,
                                ),
                                decoration: BoxDecoration(
                                  color: colors.accentSoft,
                                  borderRadius: const BorderRadius.only(
                                    topLeft: Radius.circular(12),
                                    topRight: Radius.circular(4),
                                    bottomLeft: Radius.circular(12),
                                    bottomRight: Radius.circular(12),
                                  ),
                                  border: Border.all(color: colors.accentBorder),
                                ),
                                child: Text(
                                  userStatus.moodText != null &&
                                          userStatus.moodText!.isNotEmpty
                                      ? userStatus.moodText!
                                      : '点此留一句心绪…',
                                  style: TextStyle(
                                    fontSize: 12,
                                    height: 1.4,
                                    color: userStatus.moodText != null &&
                                            userStatus.moodText!.isNotEmpty
                                        ? colors.inkDeep
                                        : colors.inkQuiet,
                                    fontStyle: userStatus.moodText != null &&
                                            userStatus.moodText!.isNotEmpty
                                        ? FontStyle.normal
                                        : FontStyle.italic,
                                  ),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 9),
                      _StatusAvatar(
                        key: const Key('quick_user_avatar'),
                        tooltip: '点击更换我的头像',
                        icon: PhosphorIconsLight.user,
                        bgColor: colors.accentSoft,
                        iconColor: colors.inkDeep,
                        dotColor: userStatus.undisturbed ? colors.thresholdAmber : null,
                        imageUrl: settingsSnap?.userAvatarUrl,
                        profile: profile,
                        onTap: _uploadingAvatar
                            ? null
                            : () => unawaited(_pickAndUploadAvatar('user')),
                      ),
                    ],
                  ),
                  if (_editingMood) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: colors.letterSurface,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: colors.hairline),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          TextField(
                            key: const Key('user_mood_input'),
                            controller: _moodController,
                            maxLength: _moodMaxLen,
                            autofocus: true,
                            style: TextStyle(fontSize: 12.5, color: colors.inkDeep),
                            decoration: const InputDecoration(
                              hintText: '写一句此刻心绪（如：有点累，刚下班）',
                              isDense: true,
                              counterText: '',
                              contentPadding: EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 7,
                              ),
                            ),
                            onSubmitted: (_) => unawaited(_saveMood()),
                          ),
                          const SizedBox(height: 6),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              if (userStatus.moodText != null &&
                                  userStatus.moodText!.isNotEmpty)
                                TextButton(
                                  key: const Key('user_mood_clear_button'),
                                  onPressed: _saving
                                      ? null
                                      : () => unawaited(_saveMood(clear: true)),
                                  style: TextButton.styleFrom(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 8,
                                      vertical: 4,
                                    ),
                                    minimumSize: Size.zero,
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                  child: Text(
                                    '清掉',
                                    style: TextStyle(
                                      fontSize: 11.5,
                                      color: colors.inkQuiet,
                                    ),
                                  ),
                                ),
                              const SizedBox(width: 6),
                              FilledButton(
                                key: const Key('user_mood_save_button'),
                                onPressed: _saving ? null : () => unawaited(_saveMood()),
                                style: FilledButton.styleFrom(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 10,
                                    vertical: 4,
                                  ),
                                  minimumSize: Size.zero,
                                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                ),
                                child: const Text('写上', style: TextStyle(fontSize: 11.5)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            );
            },
          ),
        ),
      ),
    );
  }
}

class _StatusAvatar extends StatelessWidget {
  const _StatusAvatar({
    super.key,
    required this.icon,
    required this.bgColor,
    required this.iconColor,
    this.dotColor,
    this.imageUrl,
    this.profile,
    this.tooltip,
    this.onTap,
  });

  final IconData icon;
  final Color bgColor;
  final Color iconColor;
  final Color? dotColor;
  final String? imageUrl;
  final ConnectionProfile? profile;
  final String? tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final hasImage = imageUrl != null && imageUrl!.isNotEmpty && profile != null;
    final avatar = Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(
            color: bgColor,
            shape: BoxShape.circle,
            border: Border.all(color: colors.hairline),
          ),
          clipBehavior: Clip.antiAlias,
          child: hasImage
              ? Image.network(
                  profile!.resolveMediaUrl(imageUrl!),
                  headers: {'Authorization': 'Bearer ${profile!.token}'},
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => Icon(icon, size: 16, color: iconColor),
                )
              : Icon(icon, size: 16, color: iconColor),
        ),
        if (dotColor != null)
          Positioned(
            right: -1,
            bottom: -1,
            child: Container(
              width: 9,
              height: 9,
              decoration: BoxDecoration(
                color: dotColor,
                shape: BoxShape.circle,
                border: Border.all(color: colors.mineralCanvas, width: 1.5),
              ),
            ),
          ),
      ],
    );
    if (onTap == null) return avatar;
    return Tooltip(
      message: tooltip ?? '',
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: avatar,
      ),
    );
  }
}
