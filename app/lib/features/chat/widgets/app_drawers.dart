import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../../core/media/image_picker.dart';
import '../../../core/models/models.dart';
import '../../../core/state/app_controller.dart';
import '../../../shared/theme.dart';
import '../../settings/drawer_modal.dart';
import '../../settings/settings_panel.dart';
import 'dual_status_card.dart';

/// 左区面板正文：复用于窄屏遮罩抽屉与宽屏可折叠侧边栏。
class LeftArchivePanelContent extends StatelessWidget {
  const LeftArchivePanelContent({
    super.key,
    required this.controller,
    required this.onOpenSettings,
    this.isSidebar = false,
    this.onCollapse,
    this.imagePicker,
  });

  final AppController controller;
  final VoidCallback onOpenSettings;
  final bool isSidebar;
  final VoidCallback? onCollapse;
  final ImageFilePicker? imagePicker;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isMacOs = !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;
    final appearanceAnchorKey = GlobalKey();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(
            20,
            (isSidebar && isMacOs) ? 38 : 16,
            12,
            10,
          ),
          child: Row(
            children: [
              Icon(PhosphorIconsLight.archiveBox, size: 19, color: colors.inkDeep),
              const SizedBox(width: 8),
              Text(
                '抽屉与档案',
                style: PsyberTheme.editorialSerif.copyWith(
                  fontSize: 17,
                  fontWeight: FontWeight.w500,
                  color: colors.inkDeep,
                ),
              ),
              const Spacer(),
              if (!isSidebar || onCollapse != null)
                IconButton(
                  key: isSidebar ? const Key('left_drawer_button') : null,
                  icon: Icon(
                    isSidebar ? PhosphorIconsLight.sidebarSimple : PhosphorIconsLight.x,
                    size: 18,
                  ),
                  tooltip: isSidebar ? '收起侧边栏' : '关闭抽屉',
                  onPressed: isSidebar ? onCollapse : () => Navigator.of(context).pop(),
                ),
            ],
          ),
        ),
        DualStatusCard(controller: controller, imagePicker: imagePicker),
        Divider(height: 1, color: colors.hairline),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.symmetric(vertical: 8),
            children: [
              ValueListenableBuilder<IdentityInfo>(
                valueListenable: controller.identityNotifier,
                builder: (context, identity, _) => ListTile(
                  key: const Key('open_drawer_entry'),
                  leading: Icon(
                    PhosphorIconsLight.lock,
                    size: 18,
                    color: colors.thresholdAmber,
                  ),
                  title: const Text(
                    '上锁的抽屉',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                  ),
                  subtitle: Text(
                    '私密日记（拆封会留痕并让${identity.residentSubject}知道）',
                    style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                  ),
                  onTap: () {
                    if (!isSidebar) {
                      Navigator.of(context).pop();
                    }
                    unawaited(
                      showDialog<void>(
                        context: context,
                        builder: (_) => DrawerModal(controller: controller),
                      ),
                    );
                  },
                ),
              ),
              ValueListenableBuilder<DoorStatus>(
                valueListenable: controller.doorNotifier,
                builder: (context, door, _) {
                  return ListTile(
                    key: const Key('door_notes_archive_entry'),
                    leading: Icon(
                      PhosphorIconsLight.tray,
                      size: 18,
                      color: colors.inkDeep,
                    ),
                    title: const Text(
                      '门缝纸条归档',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                    ),
                    subtitle: Text(
                      door.unreadDoorNotes > 0
                          ? '有 ${door.unreadDoorNotes} 张未拆封纸条'
                          : '关门或休息时投递的纸条均保留于此',
                      style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                    ),
                    trailing: door.unreadDoorNotes > 0
                        ? Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: colors.thresholdAmberSoft,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              '${door.unreadDoorNotes} 张',
                              style: TextStyle(
                                fontSize: 11,
                                color: colors.thresholdAmber,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          )
                        : null,
                    onTap: () {
                      final messenger = ScaffoldMessenger.maybeOf(context);
                      if (!isSidebar) {
                        Navigator.of(context).pop();
                      }
                      messenger?.hideCurrentSnackBar();
                      messenger?.showSnackBar(
                        SnackBar(
                          content: Text(
                            door.unreadDoorNotes > 0
                                ? '有 ${door.unreadDoorNotes} 张门缝纸条尚未拆封，可在聊天流中查看'
                                : '关门或休息时投递的纸条均保留在聊天流中',
                          ),
                          duration: const Duration(seconds: 3),
                        ),
                      );
                    },
                  );
                },
              ),
            ],
          ),
        ),
        Divider(height: 1, color: colors.hairline),
        _ContextSessionFooter(
          controller: controller,
          isSidebar: isSidebar,
        ),
        Divider(height: 1, color: colors.hairline),
        Material(
          color: isSidebar ? Colors.transparent : colors.mineralCanvas,
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              10,
              6,
              10,
              isSidebar
                  ? 6.0
                  : (() {
                      final bottomSafe = MediaQuery.paddingOf(context).bottom;
                      return bottomSafe > 0
                          ? math.max(bottomSafe - 16.0, 10.0)
                          : 8.0;
                    })(),
            ),
            child: Row(
              children: [
                IconButton(
                  key: const Key('settings_button'),
                  tooltip: '偏好与设置 (⌘,)',
                  icon: Icon(
                    PhosphorIconsLight.gearSix,
                    size: 18,
                    color: colors.inkQuiet,
                  ),
                  constraints: const BoxConstraints.tightFor(width: 34, height: 34),
                  style: IconButton.styleFrom(
                    minimumSize: const Size(34, 34),
                    fixedSize: const Size(34, 34),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  padding: EdgeInsets.zero,
                  onPressed: () {
                    if (!isSidebar) {
                      Navigator.of(context).pop();
                    }
                    onOpenSettings();
                  },
                ),
                const Spacer(),
                KeyedSubtree(
                  key: appearanceAnchorKey,
                  child: ValueListenableBuilder<ThemeMode>(
                    valueListenable: controller.themeModeNotifier,
                    builder: (context, mode, _) {
                      final icon = switch (mode) {
                        ThemeMode.light => PhosphorIconsLight.sun,
                        ThemeMode.dark => PhosphorIconsLight.moon,
                        ThemeMode.system => PhosphorIconsLight.circleHalf,
                      };
                      return IconButton(
                        key: const Key('quick_appearance_button'),
                        tooltip: '外观与阅读色板',
                        icon: Icon(icon, size: 18, color: colors.inkQuiet),
                        constraints: const BoxConstraints.tightFor(width: 34, height: 34),
                        style: IconButton.styleFrom(
                          minimumSize: const Size(34, 34),
                          fixedSize: const Size(34, 34),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        padding: EdgeInsets.zero,
                        onPressed: () {
                          if (!isSidebar) {
                            Navigator.of(context).pop();
                          }
                          unawaited(
                            showAppearancePopover(
                              context,
                              anchorKey: appearanceAnchorKey,
                              controller: controller,
                            ),
                          );
                        },
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _ContextSessionFooter extends StatelessWidget {
  const _ContextSessionFooter({
    required this.controller,
    required this.isSidebar,
  });

  final AppController controller;
  final bool isSidebar;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      color: isSidebar ? Colors.transparent : colors.mineralCanvas,
      padding: const EdgeInsets.fromLTRB(16, 10, 14, 10),
      child: ValueListenableBuilder<ContextUsageInfo?>(
        valueListenable: controller.contextUsageNotifier,
        builder: (context, usage, _) {
          final ratio = (usage?.ratio ?? 0.0).clamp(0.0, 1.0);
          final percent = (ratio * 100).round();
          final hasUsage = usage != null && usage.usedTokens > 0;
          final barColor = ratio >= 0.8
              ? colors.thresholdAmber
              : colors.accent;

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Text(
                    '本段对话',
                    style: TextStyle(
                      fontSize: 11.5,
                      color: colors.inkQuiet,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const Spacer(),
                  if (hasUsage)
                    Text(
                      '$percent%',
                      style: PsyberTheme.monoStyle.copyWith(
                        fontSize: 11,
                        color: ratio >= 0.8
                            ? colors.thresholdAmber
                            : colors.inkQuiet,
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: LinearProgressIndicator(
                  value: ratio,
                  minHeight: 3,
                  backgroundColor: colors.hairline,
                  valueColor: AlwaysStoppedAnimation<Color>(barColor),
                ),
              ),
              const SizedBox(height: 8),
              ValueListenableBuilder<ActiveTurnState?>(
                valueListenable: controller.activeTurnNotifier,
                builder: (context, activeTurn, _) => ValueListenableBuilder<bool>(
                  valueListenable: controller.wrappingUpNotifier,
                  builder: (context, wrappingUp, _) {
                    final busy = wrappingUp || activeTurn != null;
                    return OutlinedButton.icon(
                      key: const Key('manual_wrap_up_button'),
                      onPressed: busy
                          ? null
                          : () async {
                              try {
                                final res = await controller.wrapUpMemorySession();
                                if (!context.mounted || res == null) return;
                                if (!isSidebar) {
                                  Navigator.of(context).maybePop();
                                }
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text(
                                      res.wrapped
                                          ? '已收拢这段记忆，开启新一段'
                                          : res.queued
                                              ? '已开启新一段，旧对话正在后台整理'
                                              : '当前已在新的一段',
                                    ),
                                  ),
                                );
                              } catch (e) {
                                if (!context.mounted) return;
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(content: Text('换段失败：$e')),
                                );
                              }
                            },
                      style: OutlinedButton.styleFrom(
                        foregroundColor: colors.inkDeep,
                        side: BorderSide(color: colors.hairline),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 7,
                        ),
                        minimumSize: const Size(double.infinity, 32),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                      icon: Icon(
                        PhosphorIconsLight.bookmarkSimple,
                        size: 14,
                        color: busy ? colors.inkFaint : colors.inkQuiet,
                      ),
                      label: Text(
                        wrappingUp ? '正在换段…' : '存记忆换段',
                        style: const TextStyle(fontSize: 12),
                      ),
                    );
                  },
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// 窄屏左抽屉（抽屉与档案）：带圆角与遮罩的移动端滑出抽屉。
class LeftArchiveDrawer extends StatelessWidget {
  const LeftArchiveDrawer({
    super.key,
    required this.controller,
    required this.onOpenSettings,
    this.imagePicker,
  });

  final AppController controller;
  final VoidCallback onOpenSettings;
  final ImageFilePicker? imagePicker;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    const drawerRadius = BorderRadius.only(
      topRight: Radius.circular(16),
      bottomRight: Radius.circular(16),
    );

    return Drawer(
      backgroundColor: colors.letterSurface,
      shape: const RoundedRectangleBorder(borderRadius: drawerRadius),
      child: ClipRRect(
        borderRadius: drawerRadius,
        child: SafeArea(
          bottom: false,
          child: LeftArchivePanelContent(
            controller: controller,
            onOpenSettings: onOpenSettings,
            imagePicker: imagePicker,
          ),
        ),
      ),
    );
  }
}

/// 宽屏无遮罩左侧边栏（248px，极细右边框区分主阅读空间）。
class LeftArchiveSidebar extends StatelessWidget {
  const LeftArchiveSidebar({
    super.key,
    required this.controller,
    required this.onOpenSettings,
    required this.onCollapse,
    this.imagePicker,
  });

  final AppController controller;
  final VoidCallback onOpenSettings;
  final VoidCallback onCollapse;
  final ImageFilePicker? imagePicker;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      key: const Key('desktop_left_sidebar'),
      width: 248,
      decoration: BoxDecoration(
        border: Border(right: BorderSide(color: colors.hairline)),
      ),
      child: Material(
        color: colors.mineralCanvas,
        child: SafeArea(
          child: LeftArchivePanelContent(
            controller: controller,
            onOpenSettings: onOpenSettings,
            isSidebar: true,
            onCollapse: onCollapse,
            imagePicker: imagePicker,
          ),
        ),
      ),
    );
  }
}

/// 常用活动卡片主体：复用于窄屏右抽屉与桌面端就近弹出的轻量 Popover。
class ActivityCardBody extends StatelessWidget {
  const ActivityCardBody({
    super.key,
    required this.controller,
    required this.onAfterEnd,
  });

  final AppController controller;
  final VoidCallback onAfterEnd;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ValueListenableBuilder<ActivitySessionView?>(
      valueListenable: controller.activeActivityNotifier,
      builder: (context, activity, _) {
        final isActive = activity != null;
        return Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: isActive ? colors.celadonWash : colors.mineralCanvas,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: isActive ? colors.accentBorder : colors.hairline,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(PhosphorIconsLight.filmStrip, size: 18, color: colors.inkDeep),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      '放映伴看',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 7,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: isActive ? colors.statusSuccessSoft : colors.letterSurface,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: colors.hairline),
                    ),
                    child: Text(
                      isActive ? '伴看进行中' : '已就绪',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: isActive ? colors.statusSuccess : colors.inkQuiet,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                isActive
                    ? '正在一起看：${activity.title.isEmpty ? '伴看视频' : activity.title}'
                    : '播放视频时可在一旁同步观看并轻声交流。',
                style: TextStyle(
                  fontSize: 12,
                  color: colors.inkQuiet,
                  height: 1.45,
                ),
              ),
              if (isActive) ...[
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton(
                    key: const Key('end_activity_button'),
                    onPressed: () async {
                      await controller.endActiveCinema();
                      if (context.mounted) {
                        onAfterEnd();
                      }
                    },
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 6,
                      ),
                      minimumSize: Size.zero,
                    ),
                    child: const Text('结束伴看', style: TextStyle(fontSize: 12)),
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// 桌面端右上角就近弹出的常用活动轻量 Popover（无黑幕遮罩，高度自适应）。
Future<void> showActivityPopover(
  BuildContext context, {
  required GlobalKey anchorKey,
  required AppController controller,
}) {
  double top = 56;
  double right = 16;
  final anchorCtx = anchorKey.currentContext;
  if (anchorCtx != null) {
    final box = anchorCtx.findRenderObject() as RenderBox?;
    final overlay = Overlay.maybeOf(context)?.context.findRenderObject() as RenderBox?;
    if (box != null && box.hasSize && overlay != null && overlay.hasSize) {
      final bottomRight = box.localToGlobal(
        Offset(box.size.width, box.size.height),
        ancestor: overlay,
      );
      top = bottomRight.dy + 8;
      final maxRight = math.max(12.0, overlay.size.width - 312.0);
      right = (overlay.size.width - bottomRight.dx).clamp(12.0, maxRight);
    }
  }

  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭常用活动',
    barrierColor: Colors.transparent,
    transitionDuration: const Duration(milliseconds: 140),
    pageBuilder: (dialogCtx, _, __) {
      return Stack(
        children: [
          Positioned(
            top: top,
            right: right,
            width: 296,
            child: ActivityPopoverCard(
              controller: controller,
              onClose: () => Navigator.of(dialogCtx).pop(),
            ),
          ),
        ],
      );
    },
    transitionBuilder: (ctx, anim, _, child) {
      return FadeTransition(
        opacity: CurvedAnimation(parent: anim, curve: Curves.easeOut),
        child: child,
      );
    },
  );
}

class ActivityPopoverCard extends StatelessWidget {
  const ActivityPopoverCard({
    super.key,
    required this.controller,
    required this.onClose,
  });

  final AppController controller;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      key: const Key('activity_popover_card'),
      color: colors.letterSurface,
      elevation: 6,
      shadowColor: Colors.black.withValues(alpha: 0.08),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.hairline),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(PhosphorIconsLight.squaresFour, size: 17, color: colors.inkDeep),
                const SizedBox(width: 7),
                Text(
                  '常用活动',
                  style: PsyberTheme.editorialSerif.copyWith(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w500,
                    color: colors.inkDeep,
                  ),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(PhosphorIconsLight.x, size: 16),
                  tooltip: '关闭',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                  onPressed: onClose,
                ),
              ],
            ),
            const SizedBox(height: 10),
            ActivityCardBody(
              controller: controller,
              onAfterEnd: onClose,
            ),
            const SizedBox(height: 12),
            Center(
              child: Text(
                '更多共处活动将陆续加入',
                style: TextStyle(fontSize: 11.5, color: colors.inkFaint),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 窄屏右抽屉（常用活动）：放映伴看实时卡片与快捷操作。
class RightActivityDrawer extends StatelessWidget {
  const RightActivityDrawer({
    super.key,
    required this.controller,
  });

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Drawer(
      backgroundColor: colors.letterSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.only(
          topLeft: Radius.circular(16),
          bottomLeft: Radius.circular(16),
        ),
      ),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 12, 10),
              child: Row(
                children: [
                  Icon(PhosphorIconsLight.squaresFour, size: 20, color: colors.inkDeep),
                  const SizedBox(width: 8),
                  Text(
                    '常用活动',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 18,
                      fontWeight: FontWeight.w500,
                      color: colors.inkDeep,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(PhosphorIconsLight.x, size: 18),
                    tooltip: '关闭抽屉',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Text(
                '一起看片，或开启新的共处时光。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet, height: 1.4),
              ),
            ),
            const SizedBox(height: 12),
            Divider(height: 1, color: colors.hairline),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  ActivityCardBody(
                    controller: controller,
                    onAfterEnd: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(height: 18),
                  Center(
                    child: Text(
                      '更多共处活动将陆续加入',
                      style: TextStyle(fontSize: 12, color: colors.inkFaint),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
