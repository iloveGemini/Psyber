import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// 移动端浮动顶栏（复刻 Roxy CompanionHeader）：
/// - 仅在窄屏显示，桌面端完全隐藏顶栏（状态统一收敛至左侧边栏双人状态卡）；
/// - 顶部采用垂直透明渐隐遮罩（bg -> 80% -> transparent），消息列表从下方自然滑过；
/// - 左侧抽屉按钮 + 中央紧凑状态胶囊（仅留头像 + 状态色点 + 状态提示）+ 右侧活动抽屉按钮。
class MobileFloatingHeader extends StatelessWidget {
  const MobileFloatingHeader({
    super.key,
    required this.door,
    required this.showReconnectingHint,
    required this.settings,
    required this.identity,
    required this.profile,
    required this.onOpenLeftDrawer,
    required this.onOpenRightDrawer,
    this.onOpenRhythmSettings,
    this.activeActivity,
    this.rightButtonKey,
  });

  final DoorStatus door;
  final bool showReconnectingHint;
  final SettingsSnapshot? settings;
  final IdentityInfo identity;
  final ConnectionProfile? profile;
  final VoidCallback onOpenLeftDrawer;
  final VoidCallback onOpenRightDrawer;
  final VoidCallback? onOpenRhythmSettings;
  final ActivitySessionView? activeActivity;
  final GlobalKey? rightButtonKey;

  ({String label, Color dotColor, Color textColor}) _statusMeta(PsyberColors colors) {
    return switch (door.state) {
      DoorState.open => (
          label: '门开着',
          dotColor: colors.statusSuccess,
          textColor: colors.inkDeep,
        ),
      DoorState.quiet => (
          label: '想静一静',
          dotColor: colors.inkQuiet,
          textColor: colors.inkDeep,
        ),
      DoorState.closed => (
          label: '门关着',
          dotColor: colors.thresholdAmber,
          textColor: colors.thresholdAmber,
        ),
      DoorState.coolingOff => (
          label: '冷静中',
          dotColor: colors.thresholdAmber,
          textColor: colors.thresholdAmber,
        ),
      DoorState.departed => (
          label: '已告别',
          dotColor: colors.inkFaint,
          textColor: colors.inkQuiet,
        ),
    };
  }

  void _showDoorDetailDialog(BuildContext context) {
    final colors = context.colors;
    final hasNote = door.note != null && door.note!.trim().isNotEmpty;
    final circadian = settings?.circadian;
    final subject = identity.residentSubject;

    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          backgroundColor: door.state.isDoorNoteMode ? colors.slipPaper : colors.letterSurface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(
              color: door.state.isDoorNoteMode ? colors.hairlineWarm : colors.hairline,
            ),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      _HeaderResidentAvatar(
                        avatarUrl: settings?.residentAvatarUrl,
                        profile: profile,
                        initial: identity.avatarInitial,
                        size: 32,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          identity.displayResidentName,
                          style: PsyberTheme.editorialSerif.copyWith(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: colors.inkDeep,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: Icon(PhosphorIconsLight.x, size: 17, color: colors.inkQuiet),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        onPressed: () => Navigator.of(ctx).pop(),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (hasNote) ...[
                    Text(
                      '门牌便签：${door.note!}',
                      style: PsyberTheme.editorialSerif.copyWith(
                        fontSize: 13.5,
                        color: colors.inkDeep,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  Text(
                    switch (door.state) {
                      DoorState.open => '门开着（在线）：推门即聊，消息立即回复。',
                      DoorState.quiet => '虚掩中（忙碌）：$subject正在忙自己的事，留言会先安静放着，轻声沟通。',
                      DoorState.closed => '门关着（勿扰）：只收门缝纸条，不打扰$subject独处或休息。',
                      DoorState.coolingOff => '冷静期中：当前仅保留门缝纸条通道。',
                      DoorState.departed => '这段陪伴已结束并停留在纪念只读状态。',
                    },
                    style: TextStyle(
                      fontSize: 12.5,
                      color: colors.inkQuiet,
                      height: 1.55,
                    ),
                  ),
                  if (circadian != null) ...[
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Text(
                          '夜间静默窗：${circadian.sleepStart} – ${circadian.sleepEnd}',
                          style: TextStyle(fontSize: 11.5, color: colors.inkFaint),
                        ),
                        if (onOpenRhythmSettings != null) ...[
                          const SizedBox(width: 8),
                          InkWell(
                            key: const Key('door_bar_adjust_rhythm_button'),
                            borderRadius: BorderRadius.circular(4),
                            onTap: () {
                              Navigator.of(ctx).pop();
                              onOpenRhythmSettings!();
                            },
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                              child: Text(
                                '调整',
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: colors.accent,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
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
    final meta = _statusMeta(colors);
    final surfaceBg = colors.letterSurface.withValues(alpha: 0.9);
    final shadow = BoxShadow(
      color: Colors.black.withValues(alpha: colors.isDark ? 0.22 : 0.045),
      blurRadius: 10,
      offset: const Offset(0, 2),
    );

    return Container(
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
      child: SafeArea(
        bottom: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
              child: Row(
                children: [
                  _FloatingIconButton(
                    key: const Key('left_drawer_button'),
                    tooltip: '抽屉与档案',
                    backgroundColor: surfaceBg,
                    borderColor: colors.hairline,
                    shadow: shadow,
                    onPressed: onOpenLeftDrawer,
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Icon(PhosphorIconsLight.list, size: 20, color: colors.inkDeep),
                        if (door.unreadDoorNotes > 0)
                          Positioned(
                            right: -2,
                            top: -2,
                            child: Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: colors.thresholdAmber,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: Center(
                      child: Material(
                        color: Colors.transparent,
                        child: InkWell(
                          key: const Key('door_threshold_toggle'),
                          borderRadius: BorderRadius.circular(999),
                          onTap: () => _showDoorDetailDialog(context),
                          child: Container(
                            height: 42,
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                            decoration: BoxDecoration(
                              color: surfaceBg,
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(
                                color: door.state.isDoorNoteMode
                                    ? colors.hairlineWarm
                                    : colors.hairline,
                              ),
                              boxShadow: [shadow],
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                _HeaderResidentAvatar(
                                  avatarUrl: settings?.residentAvatarUrl,
                                  profile: profile,
                                  initial: identity.avatarInitial,
                                  size: 26,
                                ),
                                const SizedBox(width: 8),
                                Container(
                                  width: 7,
                                  height: 7,
                                  decoration: BoxDecoration(
                                    color: meta.dotColor,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  meta.label,
                                  key: const Key('door_state_badge'),
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w500,
                                    color: meta.textColor,
                                  ),
                                ),
                                if (door.unreadDoorNotes > 0) ...[
                                  const SizedBox(width: 6),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 5,
                                      vertical: 1,
                                    ),
                                    decoration: BoxDecoration(
                                      color: colors.thresholdAmberSoft,
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      '${door.unreadDoorNotes}',
                                      style: TextStyle(
                                        fontSize: 10.5,
                                        color: colors.thresholdAmber,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  KeyedSubtree(
                    key: rightButtonKey,
                    child: _FloatingIconButton(
                      key: const Key('right_drawer_button'),
                      tooltip: '常用活动',
                      backgroundColor: surfaceBg,
                      borderColor: colors.hairline,
                      shadow: shadow,
                      onPressed: onOpenRightDrawer,
                      child: Stack(
                        clipBehavior: Clip.none,
                        children: [
                          Icon(
                            activeActivity != null
                                ? PhosphorIconsLight.filmStrip
                                : PhosphorIconsLight.squaresFour,
                            size: 20,
                            color: colors.inkDeep,
                          ),
                          if (activeActivity != null)
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
                    ),
                  ),
                ],
              ),
            ),
            if (showReconnectingHint)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                  decoration: BoxDecoration(
                    color: surfaceBg,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: colors.hairline),
                  ),
                  child: Text(
                    '正在重新连接…',
                    key: const Key('gentle_reconnecting_hint'),
                    style: TextStyle(fontSize: 11, color: colors.inkQuiet),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _FloatingIconButton extends StatelessWidget {
  const _FloatingIconButton({
    super.key,
    required this.tooltip,
    required this.backgroundColor,
    required this.borderColor,
    required this.shadow,
    required this.onPressed,
    required this.child,
  });

  final String tooltip;
  final Color backgroundColor;
  final Color borderColor;
  final BoxShadow shadow;
  final VoidCallback onPressed;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onPressed,
          child: Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: backgroundColor,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: borderColor),
              boxShadow: [shadow],
            ),
            alignment: Alignment.center,
            child: child,
          ),
        ),
      ),
    );
  }
}

class _HeaderResidentAvatar extends StatelessWidget {
  const _HeaderResidentAvatar({
    required this.avatarUrl,
    required this.profile,
    required this.initial,
    this.size = 26,
  });

  final String? avatarUrl;
  final ConnectionProfile? profile;
  final String initial;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final hasImage = avatarUrl != null && avatarUrl!.isNotEmpty && profile != null;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: colors.useReadingChrome ? colors.accentSoft : colors.celadonWash,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: colors.useReadingChrome ? colors.accentBorder : colors.hairline,
          width: 0.8,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: hasImage
          ? Image.network(
              profile!.resolveMediaUrl(avatarUrl!),
              headers: {'Authorization': 'Bearer ${profile!.token}'},
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Center(
                child: Text(
                  initial,
                  style: PsyberTheme.editorialSerif.copyWith(
                    fontSize: size * 0.5,
                    fontWeight: FontWeight.w600,
                    color: colors.useReadingChrome ? colors.accent : colors.inkDeep,
                  ),
                ),
              ),
            )
          : Center(
              child: Text(
                initial,
                style: PsyberTheme.editorialSerif.copyWith(
                  fontSize: size * 0.5,
                  fontWeight: FontWeight.w600,
                  color: colors.useReadingChrome ? colors.accent : colors.inkDeep,
                ),
              ),
            ),
    );
  }
}
