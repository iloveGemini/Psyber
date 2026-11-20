import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/models/models.dart';
import '../../../shared/theme.dart';

/// 门楣顶栏（The Threshold Header）：
/// - 左侧：抽屉与档案入口（all_inbox_outlined，含未读纸条/私密日记红点）
/// - 中部：悬浮住户头像与呼吸门态胶囊（在线/忙碌/勿扰，点击展开门牌便签与作息）
/// - 右侧：常用活动入口（widgets_outlined / movie_outlined，放映伴看与扩展插槽）
class DoorThresholdBar extends StatefulWidget {
  const DoorThresholdBar({
    super.key,
    required this.door,
    required this.showReconnectingHint,
    required this.settings,
    required this.onOpenLeftDrawer,
    required this.onOpenRightDrawer,
    this.onOpenSettings,
    this.activeActivity,
  });

  final DoorStatus door;
  final bool showReconnectingHint;
  final SettingsSnapshot? settings;
  final VoidCallback onOpenLeftDrawer;
  final VoidCallback onOpenRightDrawer;
  final VoidCallback? onOpenSettings;
  final ActivitySessionView? activeActivity;

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
          badgeBg: colors.celadonWash,
          badgeBorder: colors.hairline,
          textColor: colors.inkDeep,
        ),
      DoorState.quiet => (
          label: '想静一静',
          statusText: '忙碌',
          dotColor: colors.inkQuiet,
          badgeBg: colors.mineralCanvas,
          badgeBorder: colors.hairline,
          textColor: colors.inkQuiet,
        ),
      DoorState.closed => (
          label: '门关着',
          statusText: '勿扰',
          dotColor: colors.thresholdAmber,
          badgeBg: colors.slipPaper,
          badgeBorder: colors.hairlineWarm,
          textColor: colors.thresholdAmber,
        ),
      DoorState.coolingOff => (
          label: '冷静中',
          statusText: '冷静中',
          dotColor: colors.thresholdAmber,
          badgeBg: colors.slipPaper,
          badgeBorder: colors.hairlineWarm,
          textColor: colors.thresholdAmber,
        ),
      DoorState.departed => (
          label: '已离开',
          statusText: '纪念',
          dotColor: colors.inkFaint,
          badgeBg: colors.mineralCanvas,
          badgeBorder: colors.hairline,
          textColor: colors.inkQuiet,
        ),
    };

    final hasNote = door.note != null && door.note!.trim().isNotEmpty;
    final circadian = widget.settings?.circadian;

    return Container(
      decoration: BoxDecoration(
        color: colors.letterSurface,
        border: Border(bottom: BorderSide(color: colors.hairline)),
      ),
      child: SafeArea(
        bottom: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 820),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  child: Row(
                    children: [
                      // 左抽屉按钮：抽屉与档案
                      IconButton(
                        key: const Key('left_drawer_button'),
                        tooltip: '抽屉与档案',
                        icon: Stack(
                          clipBehavior: Clip.none,
                          children: [
                            const Icon(PhosphorIconsLight.archiveBox, size: 21),
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
                        color: colors.inkDeep,
                        onPressed: widget.onOpenLeftDrawer,
                      ),
                      const SizedBox(width: 4),

                      // 中部悬浮头像与门态存在胶囊
                      Expanded(
                        child: Center(
                          child: InkWell(
                            key: const Key('door_threshold_toggle'),
                            borderRadius: BorderRadius.circular(16),
                            onTap: () => setState(() => _expanded = !_expanded),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 4,
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  // 居中圆形悬浮头像 + 呼吸圆点
                                  Container(
                                    width: 32,
                                    height: 32,
                                    decoration: BoxDecoration(
                                      color: colors.celadonWash,
                                      shape: BoxShape.circle,
                                      border: Border.all(
                                        color: colors.hairline,
                                        width: 1.2,
                                      ),
                                    ),
                                    child: Stack(
                                      clipBehavior: Clip.none,
                                      children: [
                                        Center(
                                          child: Text(
                                            'P',
                                            style: PsyberTheme.editorialSerif.copyWith(
                                              fontSize: 16,
                                              fontWeight: FontWeight.w500,
                                              color: colors.inkDeep,
                                            ),
                                          ),
                                        ),
                                        Positioned(
                                          right: -1,
                                          bottom: -1,
                                          child: Container(
                                            width: 9,
                                            height: 9,
                                            decoration: BoxDecoration(
                                              color: statusMeta.dotColor,
                                              shape: BoxShape.circle,
                                              border: Border.all(
                                                color: colors.letterSurface,
                                                width: 1.6,
                                              ),
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 9),
                                  Column(
                                    mainAxisSize: MainAxisSize.min,
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text(
                                            'Psyber',
                                            style: PsyberTheme.editorialSerif.copyWith(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w500,
                                              color: colors.inkDeep,
                                            ),
                                          ),
                                          const SizedBox(width: 6),
                                          Container(
                                            key: const Key('door_state_badge'),
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 6,
                                              vertical: 2,
                                            ),
                                            decoration: BoxDecoration(
                                              color: statusMeta.badgeBg,
                                              borderRadius: BorderRadius.circular(8),
                                              border: Border.all(
                                                color: statusMeta.badgeBorder,
                                              ),
                                            ),
                                            child: Text(
                                              statusMeta.label,
                                              style: TextStyle(
                                                fontSize: 11,
                                                fontWeight: FontWeight.w500,
                                                color: statusMeta.textColor,
                                              ),
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
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 4),

                      // 右抽屉按钮：常用活动
                      IconButton(
                        key: const Key('right_drawer_button'),
                        tooltip: '常用活动',
                        icon: Stack(
                          clipBehavior: Clip.none,
                          children: [
                            Icon(
                              widget.activeActivity != null
                                  ? PhosphorIconsLight.filmStrip
                                  : PhosphorIconsLight.squaresFour,
                              size: 21,
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
                    ],
                  ),
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
                  secondChild: Container(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
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
                            Text(
                              '夜间静默窗：${circadian.sleepStart} – ${circadian.sleepEnd}',
                              style: TextStyle(
                                fontSize: 11.5,
                                color: colors.inkFaint,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
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
