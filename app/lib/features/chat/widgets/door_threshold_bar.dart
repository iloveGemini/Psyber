import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// 门楣顶栏（The Threshold Header）：
/// - 左侧：窄屏打开档案抽屉，宽屏切换无遮罩左侧边栏（macOS 自动避让红黄绿灯）
/// - 中部：严格居中的住户头像与门态标签（点击展开门牌便签与作息）
/// - 右侧：常用活动入口（窄屏右抽屉 / 宽屏就近弹出轻量 Popover）
class DoorThresholdBar extends StatefulWidget {
  const DoorThresholdBar({
    super.key,
    required this.door,
    required this.showReconnectingHint,
    required this.settings,
    required this.onOpenLeftDrawer,
    required this.onOpenRightDrawer,
    this.onOpenSettings,
    this.onOpenRhythmSettings,
    this.activeActivity,
    this.isReplying = false,
    this.isWide = false,
    this.sidebarOpen = false,
    this.rightButtonKey,
  });

  final DoorStatus door;
  final bool showReconnectingHint;
  final SettingsSnapshot? settings;
  final VoidCallback onOpenLeftDrawer;
  final VoidCallback onOpenRightDrawer;
  final VoidCallback? onOpenSettings;
  final VoidCallback? onOpenRhythmSettings;
  final ActivitySessionView? activeActivity;
  final bool isReplying;
  final bool isWide;
  final bool sidebarOpen;
  final GlobalKey? rightButtonKey;

  @override
  State<DoorThresholdBar> createState() => _DoorThresholdBarState();
}

class _DoorThresholdBarState extends State<DoorThresholdBar> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final door = widget.door;
    final colors = context.colors;
    final statusMeta = switch (door.state) {
      DoorState.open => (
          label: '门开着',
          statusText: '在线',
          dotColor: colors.statusSuccess,
          textColor: colors.inkQuiet,
        ),
      DoorState.quiet => (
          label: '想静一静',
          statusText: '忙碌',
          dotColor: colors.inkQuiet,
          textColor: colors.inkQuiet,
        ),
      DoorState.closed => (
          label: '门关着',
          statusText: '勿扰',
          dotColor: colors.thresholdAmber,
          textColor: colors.thresholdAmber,
        ),
      DoorState.coolingOff => (
          label: '冷静中',
          statusText: '冷静中',
          dotColor: colors.thresholdAmber,
          textColor: colors.thresholdAmber,
        ),
      DoorState.departed => (
          label: '已离开',
          statusText: '纪念',
          dotColor: colors.inkFaint,
          textColor: colors.inkQuiet,
        ),
    };
    final Color? badgeBorder = door.state.isDoorNoteMode ? colors.hairlineWarm : null;

    final hasNote = door.note != null && door.note!.trim().isNotEmpty;
    final circadian = widget.settings?.circadian;
    final isMacOs = !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;
    final needsTrafficLightInset = isMacOs && !(widget.isWide && widget.sidebarOpen);

    return Container(
      decoration: BoxDecoration(
        color: colors.letterSurface,
        border: Border(bottom: BorderSide(color: colors.hairline)),
      ),
      child: SafeArea(
        bottom: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            LayoutBuilder(
              builder: (context, constraints) {
                final leftInset = needsTrafficLightInset ? 76.0 : 10.0;
                const buttonExtent = 48.0;
                const rightInset = 10.0;
                // 对称居中时两侧须留足 max(左占位, 右占位)，否则在窄 macOS 窗口会与红黄绿灯后的按钮挤撞
                final symmetricSide = math.max(leftInset + buttonExtent, rightInset + buttonExtent);
                final canCenterSymmetrically =
                    constraints.maxWidth - symmetricSide * 2 >= 220.0;

                final leftAction = IconButton(
                  key: const Key('left_drawer_button'),
                  tooltip: widget.isWide
                      ? (widget.sidebarOpen ? '收起侧边栏 (⌘\\)' : '展开侧边栏 (⌘\\)')
                      : '抽屉与档案',
                  icon: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Icon(
                        widget.isWide
                            ? PhosphorIconsLight.sidebarSimple
                            : PhosphorIconsLight.archiveBox,
                        size: 20,
                      ),
                      if (!widget.isWide && door.unreadDoorNotes > 0)
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
                  color: colors.inkDeep,
                  onPressed: widget.onOpenLeftDrawer,
                );

                final rightAction = KeyedSubtree(
                  key: widget.rightButtonKey,
                  child: IconButton(
                    key: const Key('right_drawer_button'),
                    tooltip: '常用活动',
                    icon: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Icon(
                          widget.activeActivity != null
                              ? PhosphorIconsLight.filmStrip
                              : PhosphorIconsLight.squaresFour,
                          size: 20,
                        ),
                        if (widget.activeActivity != null)
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
                    color: colors.inkDeep,
                    onPressed: widget.onOpenRightDrawer,
                  ),
                );

                final centerPill = InkWell(
                  key: const Key('door_threshold_toggle'),
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => setState(() => _expanded = !_expanded),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 3,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 30,
                          height: 30,
                          decoration: BoxDecoration(
                            color: colors.useReadingChrome
                                ? colors.accentSoft
                                : colors.celadonWash,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: colors.useReadingChrome
                                  ? colors.accentBorder
                                  : colors.hairline,
                              width: 1.0,
                            ),
                          ),
                          child: Center(
                            child: Text(
                              'P',
                              style: PsyberTheme.editorialSerif.copyWith(
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                                color: colors.useReadingChrome
                                    ? colors.accent
                                    : colors.inkDeep,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 9),
                        Flexible(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Flexible(
                                    child: Text(
                                      'Psyber',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: PsyberTheme.editorialSerif.copyWith(
                                        fontSize: 15,
                                        fontWeight: FontWeight.w500,
                                        color: colors.inkDeep,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Container(
                                    key: const Key('door_state_badge'),
                                    padding: badgeBorder != null
                                        ? const EdgeInsets.symmetric(
                                            horizontal: 6,
                                            vertical: 1.5,
                                          )
                                        : const EdgeInsets.symmetric(
                                            horizontal: 2,
                                            vertical: 1.5,
                                          ),
                                    decoration: badgeBorder != null
                                        ? BoxDecoration(
                                            color: colors.slipPaper,
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: badgeBorder),
                                          )
                                        : null,
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        if (widget.isReplying) ...[
                                          SizedBox(
                                            key: const Key('door_replying_indicator'),
                                            width: 8,
                                            height: 8,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 1.4,
                                              color: colors.statusSuccess,
                                            ),
                                          ),
                                          const SizedBox(width: 5),
                                          Text(
                                            '正在回复…',
                                            style: TextStyle(
                                              fontSize: 11.5,
                                              fontWeight: FontWeight.w500,
                                              color: colors.inkDeep,
                                            ),
                                          ),
                                        ] else ...[
                                          Container(
                                            width: 6,
                                            height: 6,
                                            decoration: BoxDecoration(
                                              color: statusMeta.dotColor,
                                              shape: BoxShape.circle,
                                            ),
                                          ),
                                          const SizedBox(width: 5),
                                          Text(
                                            statusMeta.label,
                                            style: TextStyle(
                                              fontSize: 11.5,
                                              fontWeight: FontWeight.w400,
                                              color: statusMeta.textColor,
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                  ),
                                  if (door.unreadDoorNotes > 0) ...[
                                    const SizedBox(width: 4),
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 5,
                                        vertical: 1.5,
                                      ),
                                      decoration: BoxDecoration(
                                        color: colors.thresholdAmberSoft,
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Text(
                                        '${door.unreadDoorNotes} 张',
                                        style: TextStyle(
                                          fontSize: 10.5,
                                          color: colors.thresholdAmber,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ),
                                  ],
                                  const SizedBox(width: 2),
                                  Icon(
                                    _expanded
                                        ? PhosphorIconsLight.caretUp
                                        : PhosphorIconsLight.caretDown,
                                    size: 15,
                                    color: colors.inkFaint,
                                  ),
                                ],
                              ),
                              if (hasNote) ...[
                                const SizedBox(height: 1),
                                ConstrainedBox(
                                  constraints: const BoxConstraints(maxWidth: 220),
                                  child: Text(
                                    door.note!,
                                    style: PsyberTheme.editorialSerif.copyWith(
                                      fontSize: 11.5,
                                      color: colors.inkQuiet,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );

                if (!canCenterSymmetrically) {
                  return ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 50),
                    child: Row(
                      children: [
                        SizedBox(width: leftInset),
                        leftAction,
                        Expanded(
                          child: Center(child: centerPill),
                        ),
                        rightAction,
                        const SizedBox(width: rightInset),
                      ],
                    ),
                  );
                }

                return ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 50),
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Padding(
                          padding: EdgeInsets.only(left: leftInset),
                          child: leftAction,
                        ),
                      ),
                      Align(
                        alignment: Alignment.center,
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth: constraints.maxWidth - symmetricSide * 2,
                          ),
                          child: centerPill,
                        ),
                      ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: Padding(
                          padding: const EdgeInsets.only(right: rightInset),
                          child: rightAction,
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
            if (widget.showReconnectingHint)
              Container(
                padding: const EdgeInsets.symmetric(vertical: 3),
                alignment: Alignment.center,
                child: Text(
                  '正在重新连接…',
                  key: const Key('gentle_reconnecting_hint'),
                  style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                ),
              ),
            AnimatedCrossFade(
              duration: const Duration(milliseconds: 180),
              crossFadeState: _expanded
                  ? CrossFadeState.showSecond
                  : CrossFadeState.showFirst,
              firstChild: const SizedBox.shrink(),
              secondChild: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: door.state.isDoorNoteMode
                            ? colors.slipPaper
                            : colors.mineralCanvas,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: door.state.isDoorNoteMode
                              ? colors.hairlineWarm
                              : colors.hairline,
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (hasNote) ...[
                            Text(
                              '门牌便签：${door.note!}',
                              style: PsyberTheme.editorialSerif.copyWith(fontSize: 13.5),
                            ),
                            const SizedBox(height: 6),
                          ],
                          Text(
                            switch (door.state) {
                              DoorState.open => '门开着（在线）：推门即聊，消息立即回复。',
                              DoorState.quiet => '虚掩中（忙碌）：对方正在沉浸专注，留言会先安静放着，轻声沟通。',
                              DoorState.closed => '门关着（勿扰）：只收门缝纸条，不打扰对方独处或休息。',
                              DoorState.coolingOff => '冷静期中：当前仅保留门缝纸条通道。',
                              DoorState.departed => '这段陪伴已结束并停留在纪念只读状态。',
                            },
                            style: TextStyle(
                              fontSize: 12.5,
                              color: colors.inkQuiet,
                              height: 1.6,
                            ),
                          ),
                          if (circadian != null) ...[
                            const SizedBox(height: 6),
                            Row(
                              children: [
                                Text(
                                  '夜间静默窗：${circadian.sleepStart} – ${circadian.sleepEnd}',
                                  style: TextStyle(
                                    fontSize: 11.5,
                                    color: colors.inkFaint,
                                  ),
                                ),
                                if (widget.onOpenRhythmSettings != null) ...[
                                  const SizedBox(width: 8),
                                  InkWell(
                                    key: const Key('door_bar_adjust_rhythm_button'),
                                    borderRadius: BorderRadius.circular(4),
                                    onTap: () {
                                      setState(() => _expanded = false);
                                      widget.onOpenRhythmSettings!();
                                    },
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 4,
                                        vertical: 1,
                                      ),
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
            ),
          ],
        ),
      ),
    );
  }
}
