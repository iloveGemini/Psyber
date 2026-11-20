import 'package:flutter/material.dart';

import '../../../core/media/image_picker.dart';
import '../../../core/models/models.dart';
import '../../../core/state/app_controller.dart';
import '../../../shared/theme.dart';
import '../../settings/drawer_modal.dart';

/// 左抽屉（抽屉与档案）：
/// - 收纳上锁私密日记（private/*.sealed）
/// - 门缝纸条归档
/// - 生活记忆漫步
/// - 底部角落优雅收纳「偏好与系统设置」
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

    return Drawer(
      backgroundColor: colors.letterSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.only(
          topRight: Radius.circular(16),
          bottomRight: Radius.circular(16),
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
                  Icon(Icons.all_inbox_outlined, size: 20, color: colors.inkDeep),
                  const SizedBox(width: 8),
                  Text(
                    '抽屉与档案',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                      color: colors.inkDeep,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    tooltip: '关闭抽屉',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Text(
                '存放住户的私密日记、门缝纸条与往事记录。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet, height: 1.4),
              ),
            ),
            const SizedBox(height: 12),
            Divider(height: 1, color: colors.hairline),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  ListTile(
                    key: const Key('open_drawer_entry'),
                    leading: Container(
                      padding: const EdgeInsets.all(7),
                      decoration: BoxDecoration(
                        color: colors.thresholdAmberSoft,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(
                        Icons.lock_outline,
                        size: 18,
                        color: colors.thresholdAmber,
                      ),
                    ),
                    title: const Text(
                      '上锁的抽屉',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    subtitle: const Text(
                      '住户的私密日记（拆封前必有二次确认）',
                      style: TextStyle(fontSize: 11.5, color: PsyberTheme.inkQuiet),
                    ),
                    trailing: const Icon(Icons.chevron_right, size: 18),
                    onTap: () {
                      Navigator.of(context).pop();
                      showDialog<void>(
                        context: context,
                        builder: (_) => DrawerModal(controller: controller),
                      );
                    },
                  ),
                  ValueListenableBuilder<DoorStatus>(
                    valueListenable: controller.doorNotifier,
                    builder: (context, door, _) {
                      return ListTile(
                        leading: Container(
                          padding: const EdgeInsets.all(7),
                          decoration: BoxDecoration(
                            color: colors.celadonWash,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Icon(
                            Icons.markunread_mailbox_outlined,
                            size: 18,
                            color: colors.inkDeep,
                          ),
                        ),
                        title: const Text(
                          '门缝纸条归档',
                          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                        ),
                        subtitle: Text(
                          door.unreadDoorNotes > 0
                              ? '有 ${door.unreadDoorNotes} 张未拆封纸条'
                              : '关门独处或休息时投递的纸条均存放在此',
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
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              )
                            : const Icon(Icons.chevron_right, size: 18),
                        onTap: () {
                          // 可轻弹便签归档说明
                        },
                      );
                    },
                  ),
                  ListTile(
                    leading: Container(
                      padding: const EdgeInsets.all(7),
                      decoration: BoxDecoration(
                        color: colors.celadonWash,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(
                        Icons.auto_stories_outlined,
                        size: 18,
                        color: colors.inkDeep,
                      ),
                    ),
                    title: const Text(
                      '生活记忆',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    subtitle: const Text(
                      '住户在夜间静默整理出的生活卡片',
                      style: TextStyle(fontSize: 11.5, color: PsyberTheme.inkQuiet),
                    ),
                    trailing: const Icon(Icons.chevron_right, size: 18),
                    onTap: () {
                      // 记忆漫步卡片
                    },
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: colors.hairline),
            Material(
              color: colors.mineralCanvas,
              child: ListTile(
                key: const Key('settings_button'),
                dense: true,
                leading: Icon(Icons.tune_outlined, size: 19, color: colors.inkDeep),
                title: Text(
                  '偏好与系统设置',
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: colors.inkDeep,
                  ),
                ),
                subtitle: Text(
                  '配对设备、模型路由、作息与日夜主题',
                  style: TextStyle(fontSize: 11, color: colors.inkQuiet),
                ),
                trailing: const Icon(Icons.chevron_right, size: 18),
                onTap: () {
                  Navigator.of(context).pop();
                  onOpenSettings();
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 右抽屉（常用活动）：
/// - 放映伴看（Cinema）活动实时卡片与快捷操作
/// - 预留的扩展场景插槽（专注自习、白噪音雨声、双人电台）
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
                  Icon(Icons.widgets_outlined, size: 20, color: colors.inkDeep),
                  const SizedBox(width: 8),
                  Text(
                    '常用活动',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                      color: colors.inkDeep,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    tooltip: '关闭抽屉',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Text(
                '与住户开启专属陪伴场景与日常同频互动。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet, height: 1.4),
              ),
            ),
            const SizedBox(height: 12),
            Divider(height: 1, color: colors.hairline),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  ValueListenableBuilder<ActivitySessionView?>(
                    valueListenable: controller.activeActivityNotifier,
                    builder: (context, activity, _) {
                      final isActive = activity != null;
                      return Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: isActive ? colors.celadonWash : colors.mineralCanvas,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: isActive ? colors.accentBorder : colors.hairline,
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(Icons.movie_outlined, size: 18, color: colors.inkDeep),
                                const SizedBox(width: 8),
                                const Expanded(
                                  child: Text(
                                    '放映伴看',
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 7,
                                    vertical: 2,
                                  ),
                                  decoration: BoxDecoration(
                                    color: isActive
                                        ? colors.statusSuccessSoft
                                        : colors.letterSurface,
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(color: colors.hairline),
                                  ),
                                  child: Text(
                                    isActive ? '伴看进行中' : '已就绪',
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w500,
                                      color: isActive
                                          ? colors.statusSuccess
                                          : colors.inkQuiet,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Text(
                              isActive
                                  ? '正在一起看：${activity.title.isEmpty ? '伴看视频' : activity.title}'
                                  : '播放视频网站时，住户会在一旁同步观看并轻声发送弹幕交流。',
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
                                      Navigator.of(context).pop();
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
                  ),
                  const SizedBox(height: 14),
                  _ActivitySlotCard(
                    colors: colors,
                    icon: Icons.timer_outlined,
                    title: '自习专注室',
                    desc: '番茄钟与无声静默陪伴，适合工作、阅读或专注学习。',
                    chip: 'Ring 2 预留',
                  ),
                  const SizedBox(height: 10),
                  _ActivitySlotCard(
                    colors: colors,
                    icon: Icons.water_drop_outlined,
                    title: '雨声与白噪音',
                    desc: '轻柔的环境雨声与自然声景，营造安宁氛围。',
                    chip: 'Ring 2 预留',
                  ),
                  const SizedBox(height: 10),
                  _ActivitySlotCard(
                    colors: colors,
                    icon: Icons.music_note_outlined,
                    title: '双人音乐电台',
                    desc: '共享同一份歌单与旋律，实时同步歌词感受。',
                    chip: 'Ring 2 预留',
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

class _ActivitySlotCard extends StatelessWidget {
  const _ActivitySlotCard({
    required this.colors,
    required this.icon,
    required this.title,
    required this.desc,
    required this.chip,
  });

  final PsyberColors colors;
  final IconData icon;
  final String title;
  final String desc;
  final String chip;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.mineralCanvas,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 17, color: colors.inkQuiet),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                decoration: BoxDecoration(
                  color: colors.celadonWash,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  chip,
                  style: TextStyle(fontSize: 10.5, color: colors.inkFaint),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            desc,
            style: TextStyle(fontSize: 11.5, color: colors.inkQuiet, height: 1.4),
          ),
        ],
      ),
    );
  }
}
