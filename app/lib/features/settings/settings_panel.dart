import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/media/image_picker.dart';
import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/notifications/local_notifier.dart';
import '../../core/state/app_controller.dart';
import '../../shared/qr_code_view.dart';
import '../../shared/theme.dart';

/// 设置分组：服务商池与模型槽位拆分，辅以用量、作息、外观、全量工具/设备与关于数据。
enum SettingsSection {
  modelProviders,
  modelUsage,
  usage,
  rhythmNotify,
  appearance,
  toolsDevices,
  about,
}

extension SettingsSectionMeta on SettingsSection {
  String get title => switch (this) {
        SettingsSection.modelProviders => '模型服务商',
        SettingsSection.modelUsage => '模型配置',
        SettingsSection.usage => '用量',
        SettingsSection.rhythmNotify => '作息与通知',
        SettingsSection.appearance => '居所与外观',
        SettingsSection.toolsDevices => '工具与设备',
        SettingsSection.about => '关于与数据',
      };

  IconData get icon => switch (this) {
        SettingsSection.modelProviders => PhosphorIconsLight.cube,
        SettingsSection.modelUsage => PhosphorIconsLight.slidersHorizontal,
        SettingsSection.usage => PhosphorIconsLight.chartBar,
        SettingsSection.rhythmNotify => PhosphorIconsLight.moonStars,
        SettingsSection.appearance => PhosphorIconsLight.palette,
        SettingsSection.toolsDevices => PhosphorIconsLight.wrench,
        SettingsSection.about => PhosphorIconsLight.info,
      };
}

/// 桌面端居中双栏设置弹层（不再占据主界面右侧抽屉）。
Future<void> showSettingsDialog(
  BuildContext context, {
  required AppController controller,
  ImageFilePicker? imagePicker,
  SettingsSection initialSection = SettingsSection.modelUsage,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierColor: Colors.black.withValues(alpha: 0.28),
    builder: (dialogCtx) {
      final colors = dialogCtx.colors;
      final size = MediaQuery.sizeOf(dialogCtx);
      final dialogWidth = math.min(760.0, size.width - 48);
      final dialogHeight = math.min(620.0, size.height * 0.84);

      return Dialog(
        key: const Key('settings_modal_dialog'),
        backgroundColor: colors.mineralCanvas,
        insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: colors.hairline),
        ),
        clipBehavior: Clip.antiAlias,
        child: SizedBox(
          width: dialogWidth,
          height: dialogHeight,
          child: SettingsPanelContent(
            controller: controller,
            imagePicker: imagePicker,
            initialSection: initialSection,
            onClose: () => Navigator.of(dialogCtx).pop(),
          ),
        ),
      );
    },
  );
}

/// 侧边栏快捷外观浮层（无黑幕遮罩，可直接看着主聊天纸面预览配色）。
Future<void> showAppearancePopover(
  BuildContext context, {
  required GlobalKey anchorKey,
  required AppController controller,
}) {
  final isWide = MediaQuery.sizeOf(context).width >= PsyberTheme.desktopBreakpoint;
  if (!isWide) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.colors.letterSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetCtx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
          child: AppearanceQuickCard(
            controller: controller,
            onClose: () => Navigator.of(sheetCtx).pop(),
          ),
        ),
      ),
    );
  }

  double bottom = 58;
  double left = 16;
  final anchorCtx = anchorKey.currentContext;
  if (anchorCtx != null) {
    final box = anchorCtx.findRenderObject() as RenderBox?;
    final overlay = Overlay.maybeOf(context)?.context.findRenderObject() as RenderBox?;
    if (box != null && box.hasSize && overlay != null && overlay.hasSize) {
      final topLeft = box.localToGlobal(Offset.zero, ancestor: overlay);
      bottom = (overlay.size.height - topLeft.dy + 8).clamp(16.0, overlay.size.height - 240.0);
      left = topLeft.dx.clamp(12.0, math.max(12.0, overlay.size.width - 324.0));
    }
  }

  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: '关闭外观快捷切换',
    barrierColor: Colors.transparent,
    transitionDuration: const Duration(milliseconds: 140),
    pageBuilder: (dialogCtx, _, __) {
      final colors = dialogCtx.colors;
      return Stack(
        children: [
          Positioned(
            left: left,
            bottom: bottom,
            width: 312,
            child: Material(
              key: const Key('appearance_popover_card'),
              color: colors.letterSurface,
              elevation: 8,
              shadowColor: Colors.black.withValues(alpha: 0.12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
                side: BorderSide(color: colors.hairline),
              ),
              clipBehavior: Clip.antiAlias,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: AppearanceQuickCard(
                  controller: controller,
                  onClose: () => Navigator.of(dialogCtx).pop(),
                ),
              ),
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

/// 独立导出的上传贴纸弹窗（供贴纸选择面板右上角「+ 上传」直接调用）。
Future<void> showStickerUploadDialog(
  BuildContext context, {
  required AppController controller,
  ImageFilePicker? imagePicker,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _StickerUploadDialog(
      controller: controller,
      imagePicker: imagePicker,
    ),
  );
}

/// 快捷外观与阅读色板卡片（复用于侧边栏 Popover 与移动端底部 Sheet）。
class AppearanceQuickCard extends StatelessWidget {
  const AppearanceQuickCard({
    super.key,
    required this.controller,
    required this.onClose,
  });

  final AppController controller;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(PhosphorIconsLight.palette, size: 16, color: colors.inkDeep),
            const SizedBox(width: 7),
            Text(
              '外观与阅读色板',
              style: PsyberTheme.editorialSerif.copyWith(
                fontSize: 15,
                fontWeight: FontWeight.w500,
                color: colors.inkDeep,
              ),
            ),
            const Spacer(),
            IconButton(
              icon: const Icon(PhosphorIconsLight.x, size: 15),
              tooltip: '关闭',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
              onPressed: onClose,
            ),
          ],
        ),
        const SizedBox(height: 10),
        ThemePaletteSelector(controller: controller, framed: false),
      ],
    );
  }
}

/// 可复用的主题模式与 5 套阅读色板选择器。
class ThemePaletteSelector extends StatelessWidget {
  const ThemePaletteSelector({
    super.key,
    required this.controller,
    this.framed = true,
  });

  final AppController controller;
  final bool framed;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: controller.themeModeNotifier,
      builder: (context, currentMode, _) {
        return ValueListenableBuilder<PsyberPalette>(
          valueListenable: controller.lightPaletteNotifier,
          builder: (context, lightPalette, _) {
            return ValueListenableBuilder<PsyberPalette>(
              valueListenable: controller.darkPaletteNotifier,
              builder: (context, darkPalette, _) {
                final body = Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: _ThemeChip(
                            key: const Key('theme_mode_system'),
                            label: '跟随系统',
                            icon: PhosphorIconsLight.circleHalf,
                            selected: currentMode == ThemeMode.system,
                            onTap: () => controller.setThemeMode(ThemeMode.system),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _ThemeChip(
                            key: const Key('theme_mode_light'),
                            label: '日间浅色',
                            icon: PhosphorIconsLight.sun,
                            selected: currentMode == ThemeMode.light,
                            onTap: () => controller.setThemeMode(ThemeMode.light),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _ThemeChip(
                            key: const Key('theme_mode_dark'),
                            label: '夜间深色',
                            icon: PhosphorIconsLight.moon,
                            selected: currentMode == ThemeMode.dark,
                            onTap: () => controller.setThemeMode(ThemeMode.dark),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Text(
                      '阅读色板（日间与夜间分别保存）',
                      style: TextStyle(fontSize: 11, color: colors.inkQuiet),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final palette in PsyberPalette.values)
                          Builder(
                            builder: (context) {
                              final isSavedSlot =
                                  palette == lightPalette || palette == darkPalette;
                              final isActive = switch (currentMode) {
                                ThemeMode.light => palette == lightPalette,
                                ThemeMode.dark => palette == darkPalette,
                                ThemeMode.system => isSavedSlot,
                              };
                              final slotHint = palette == lightPalette
                                  ? ' · 日'
                                  : palette == darkPalette
                                      ? ' · 夜'
                                      : '';
                              return InkWell(
                                key: Key('palette_${palette.name}'),
                                borderRadius: BorderRadius.circular(8),
                                onTap: () => controller.setPalette(palette),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 9,
                                    vertical: 6,
                                  ),
                                  decoration: BoxDecoration(
                                    color: isActive
                                        ? colors.accentSoft
                                        : colors.mineralCanvas,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: isActive
                                          ? colors.accentBorder
                                          : isSavedSlot
                                              ? colors.hairlineWarm
                                              : colors.hairline,
                                      width: isActive ? 1.3 : 1.0,
                                    ),
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Container(
                                        width: 11,
                                        height: 11,
                                        decoration: BoxDecoration(
                                          color: palette.swatchBg,
                                          shape: BoxShape.circle,
                                          border: Border.all(
                                            color: palette.swatchAccent,
                                            width: 2,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 5),
                                      Text(
                                        '${palette.label}$slotHint',
                                        style: TextStyle(
                                          fontSize: 11.5,
                                          fontWeight: isActive
                                              ? FontWeight.w600
                                              : FontWeight.w400,
                                          color: isActive
                                              ? colors.inkDeep
                                              : colors.inkQuiet,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
                      ],
                    ),
                  ],
                );
                if (!framed) return body;
                return _SurfaceBox(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: body,
                  ),
                );
              },
            );
          },
        );
      },
    );
  }
}

/// 桌面端居中双栏设置内容（左分组导航 + 右独立滚动区）。
class SettingsPanelContent extends StatefulWidget {
  const SettingsPanelContent({
    super.key,
    required this.controller,
    required this.onClose,
    this.imagePicker,
    this.initialSection = SettingsSection.modelUsage,
  });

  final AppController controller;
  final VoidCallback onClose;
  final ImageFilePicker? imagePicker;
  final SettingsSection initialSection;

  @override
  State<SettingsPanelContent> createState() => _SettingsPanelContentState();
}

class _SettingsPanelContentState extends State<SettingsPanelContent> {
  late SettingsSection _activeSection;

  @override
  void initState() {
    super.initState();
    _activeSection = widget.initialSection;
    unawaited(widget.controller.loadSettings());
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 左侧固定分组导航
        Container(
          width: 184,
          decoration: BoxDecoration(
            color: colors.letterSurface,
            border: Border(right: BorderSide(color: colors.hairline)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 18, 14, 14),
                child: Text(
                  '偏好与设置',
                  style: PsyberTheme.editorialSerif.copyWith(
                    fontSize: 17,
                    fontWeight: FontWeight.w500,
                    color: colors.inkDeep,
                  ),
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                  children: [
                    for (final section in SettingsSection.values)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: _NavRailTile(
                          key: Key('settings_nav_${section.name}'),
                          icon: section.icon,
                          label: section.title,
                          selected: _activeSection == section,
                          onTap: () => setState(() => _activeSection = section),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        // 右侧独立内容区
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                height: 54,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(22, 0, 12, 0),
                  child: Row(
                    children: [
                      Text(
                        _activeSection.title,
                        style: PsyberTheme.editorialSerif.copyWith(
                          fontSize: 16.5,
                          fontWeight: FontWeight.w500,
                          color: colors.inkDeep,
                        ),
                      ),
                      const Spacer(),
                      IconButton(
                        key: const Key('close_settings_button'),
                        icon: const Icon(PhosphorIconsLight.x, size: 19),
                        tooltip: '关闭设置 (Esc)',
                        onPressed: widget.onClose,
                      ),
                    ],
                  ),
                ),
              ),
              Divider(height: 1, color: colors.hairline),
              Expanded(
                child: _SettingsSectionBody(
                  key: ValueKey(_activeSection),
                  section: _activeSection,
                  controller: widget.controller,
                  imagePicker: widget.imagePicker,
                  onCloseSettings: widget.onClose,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 窄屏/移动端使用的全屏两级导航设置页。
class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    required this.controller,
    this.imagePicker,
    this.initialSection,
  });

  final AppController controller;
  final ImageFilePicker? imagePicker;
  final SettingsSection? initialSection;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  @override
  void initState() {
    super.initState();
    unawaited(widget.controller.loadSettings());
  }

  String _summaryFor(
    SettingsSection section,
    SettingsSnapshot? snap,
    ThemeMode mode,
    PsyberPalette? palette,
  ) {
    switch (section) {
      case SettingsSection.modelProviders:
        final count = snap?.providers.values.where((p) => p.authStatus == 'configured').length ?? 0;
        return count > 0 ? '已配置 $count 个模型服务商' : '配置 API 地址与密钥';
      case SettingsSection.modelUsage:
        final slot = snap?.chatSlot;
        if (slot != null && slot.model.isNotEmpty) {
          return '${slot.provider} · ${slot.model}';
        }
        return '分配主对话、整理与可选槽位';
      case SettingsSection.usage:
        return '按时间范围查看 Token 与费用';
      case SettingsSection.rhythmNotify:
        final c = snap?.circadian;
        if (c != null) {
          return '夜间静默 ${c.sleepStart} – ${c.sleepEnd}';
        }
        return '作息、主动招呼与离线推送';
      case SettingsSection.appearance:
        final modeLabel = switch (mode) {
          ThemeMode.system => '跟随系统',
          ThemeMode.light => '日间浅色',
          ThemeMode.dark => '夜间深色',
        };
        return palette != null ? '$modeLabel · ${palette.label}' : modeLabel;
      case SettingsSection.toolsDevices:
        final toolCount = snap?.tools.length ?? 0;
        final devCount = snap?.devices.length ?? 0;
        final mcpCount = snap?.mcpServers.length ?? 0;
        return toolCount > 0
            ? '$toolCount 个能力工具 · $mcpCount 个 MCP · $devCount 台设备'
            : '$devCount 台已配对设备 · $mcpCount 个 MCP 扩展';
      case SettingsSection.about:
        final ver = snap?.systemInfo?.version ?? '0.1.0';
        return '版本 $ver · 配置文件与记忆目录';
    }
  }

  void _openSection(SettingsSection section) {
    unawaited(
      Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => _SettingsMobileDetailPage(
            section: section,
            controller: widget.controller,
            imagePicker: widget.imagePicker,
            onCloseAll: () => Navigator.of(context).pop(),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.initialSection != null) {
      return _SettingsMobileDetailPage(
        section: widget.initialSection!,
        controller: widget.controller,
        imagePicker: widget.imagePicker,
        onCloseAll: () => Navigator.of(context).pop(),
      );
    }

    final colors = context.colors;
    final isMacOs = !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

    return Scaffold(
      key: const Key('settings_mobile_page'),
      backgroundColor: colors.mineralCanvas,
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.only(top: isMacOs ? 28 : 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                height: 52,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 10, 0),
                  child: Row(
                    children: [
                      Text(
                        '偏好与设置',
                        style: PsyberTheme.editorialSerif.copyWith(
                          fontSize: 17.5,
                          fontWeight: FontWeight.w500,
                          color: colors.inkDeep,
                        ),
                      ),
                      const Spacer(),
                      IconButton(
                        key: const Key('close_settings_button'),
                        icon: const Icon(PhosphorIconsLight.x, size: 19),
                        tooltip: '关闭设置',
                        onPressed: () => Navigator.of(context).pop(),
                      ),
                    ],
                  ),
                ),
              ),
              Divider(height: 1, color: colors.hairline),
              Expanded(
                child: ValueListenableBuilder<SettingsSnapshot?>(
                  valueListenable: widget.controller.settingsNotifier,
                  builder: (context, snap, _) => ValueListenableBuilder<ThemeMode>(
                    valueListenable: widget.controller.themeModeNotifier,
                    builder: (context, mode, _) => ValueListenableBuilder<PsyberPalette?>(
                      valueListenable: widget.controller.paletteNotifier,
                      builder: (context, palette, _) {
                        return ListView(
                          padding: const EdgeInsets.all(16),
                          children: [
                            _SurfaceBox(
                              child: Column(
                                children: [
                                  for (var i = 0; i < SettingsSection.values.length; i++) ...[
                                    if (i > 0) Divider(height: 1, color: colors.hairline),
                                    ListTile(
                                      key: Key(
                                        'settings_mobile_item_${SettingsSection.values[i].name}',
                                      ),
                                      leading: Icon(
                                        SettingsSection.values[i].icon,
                                        size: 20,
                                        color: colors.inkDeep,
                                      ),
                                      title: Text(
                                        SettingsSection.values[i].title,
                                        style: TextStyle(
                                          fontSize: 14.5,
                                          fontWeight: FontWeight.w500,
                                          color: colors.inkDeep,
                                        ),
                                      ),
                                      subtitle: Text(
                                        _summaryFor(
                                          SettingsSection.values[i],
                                          snap,
                                          mode,
                                          palette,
                                        ),
                                        style: TextStyle(
                                          fontSize: 12,
                                          color: colors.inkQuiet,
                                        ),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      trailing: Icon(
                                        PhosphorIconsLight.caretRight,
                                        size: 16,
                                        color: colors.inkFaint,
                                      ),
                                      onTap: () => _openSection(SettingsSection.values[i]),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        );
                      },
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SettingsMobileDetailPage extends StatelessWidget {
  const _SettingsMobileDetailPage({
    required this.section,
    required this.controller,
    required this.onCloseAll,
    this.imagePicker,
  });

  final SettingsSection section;
  final AppController controller;
  final VoidCallback onCloseAll;
  final ImageFilePicker? imagePicker;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final isMacOs = !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;
    return Scaffold(
      backgroundColor: colors.mineralCanvas,
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.only(top: isMacOs ? 28 : 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                height: 52,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(6, 0, 10, 0),
                  child: Row(
                    children: [
                      IconButton(
                        key: const Key('settings_mobile_back_button'),
                        icon: const Icon(PhosphorIconsLight.caretLeft, size: 20),
                        tooltip: '返回',
                        onPressed: () => Navigator.of(context).pop(),
                      ),
                      Text(
                        section.title,
                        style: PsyberTheme.editorialSerif.copyWith(
                          fontSize: 17,
                          fontWeight: FontWeight.w500,
                          color: colors.inkDeep,
                        ),
                      ),
                      const Spacer(),
                      IconButton(
                        key: const Key('close_settings_button'),
                        icon: const Icon(PhosphorIconsLight.x, size: 19),
                        tooltip: '关闭设置',
                        onPressed: () {
                          Navigator.of(context).pop();
                          onCloseAll();
                        },
                      ),
                    ],
                  ),
                ),
              ),
              Divider(height: 1, color: colors.hairline),
              Expanded(
                child: _SettingsSectionBody(
                  section: section,
                  controller: controller,
                  imagePicker: imagePicker,
                  onCloseSettings: () {
                    Navigator.of(context).pop();
                    onCloseAll();
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

/// 单个设置分组的主体内容（复用于桌面弹层右侧与移动端二级详情页）。
class _SettingsSectionBody extends StatefulWidget {
  const _SettingsSectionBody({
    super.key,
    required this.section,
    required this.controller,
    required this.onCloseSettings,
    this.imagePicker,
  });

  final SettingsSection section;
  final AppController controller;
  final VoidCallback onCloseSettings;
  final ImageFilePicker? imagePicker;

  @override
  State<_SettingsSectionBody> createState() => _SettingsSectionBodyState();
}

class _SettingsSectionBodyState extends State<_SettingsSectionBody> {
  final _webhookUrlCtrl = TextEditingController();
  final _barkServerUrlCtrl = TextEditingController();
  final _barkKeyCtrl = TextEditingController();
  final _ntfyServerUrlCtrl = TextEditingController();
  final _ntfyTopicCtrl = TextEditingController();
  final _ntfyTokenCtrl = TextEditingController();

  String _sleepStart = '23:30';
  String _sleepEnd = '07:30';
  bool _proactiveEnabled = true;
  bool _desktopNotifyEnabled = true;
  bool _webhookEnabled = false;
  bool _barkEnabled = false;
  bool _hasBarkKey = false;
  bool _ntfyEnabled = false;
  bool _hasNtfyToken = false;
  bool _savingRhythm = false;
  bool _testingNotifications = false;
  String? _rhythmFeedback;
  String? _rhythmError;
  bool _hydrated = false;

  bool _uploadingAvatar = false;
  String? _avatarHint;

  @override
  void initState() {
    super.initState();
    _syncFromSnapshot(widget.controller.settingsNotifier.value);
    widget.controller.settingsNotifier.addListener(_onSettingsChanged);
  }

  void _onSettingsChanged() {
    if (!mounted) return;
    _syncFromSnapshot(widget.controller.settingsNotifier.value);
  }

  void _syncFromSnapshot(SettingsSnapshot? snap) {
    if (snap == null) return;
    if (!_hydrated) {
      _sleepStart = snap.circadian.sleepStart;
      _sleepEnd = snap.circadian.sleepEnd;
      _webhookUrlCtrl.text = snap.webhookUrl;
      _barkServerUrlCtrl.text = snap.barkServerUrl;
      _ntfyServerUrlCtrl.text = snap.ntfyServerUrl;
      _ntfyTopicCtrl.text = snap.ntfyTopic;
      _proactiveEnabled = snap.circadian.proactiveEnabled;
      _desktopNotifyEnabled = snap.desktopNotifyEnabled;
      _webhookEnabled = snap.webhookEnabled;
      _barkEnabled = snap.barkEnabled;
      _hasBarkKey = snap.hasBarkKey;
      _ntfyEnabled = snap.ntfyEnabled;
      _hasNtfyToken = snap.hasNtfyToken;
      _hydrated = true;
    } else {
      _hasBarkKey = snap.hasBarkKey;
      _hasNtfyToken = snap.hasNtfyToken;
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller.settingsNotifier.removeListener(_onSettingsChanged);
    _webhookUrlCtrl.dispose();
    _barkServerUrlCtrl.dispose();
    _barkKeyCtrl.dispose();
    _ntfyServerUrlCtrl.dispose();
    _ntfyTopicCtrl.dispose();
    _ntfyTokenCtrl.dispose();
    super.dispose();
  }

  TimeOfDay _parseTime(String raw, TimeOfDay fallback) {
    final parts = raw.trim().split(':');
    if (parts.length != 2) return fallback;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null || h < 0 || h > 23 || m < 0 || m > 59) {
      return fallback;
    }
    return TimeOfDay(hour: h, minute: m);
  }

  String _formatTime(TimeOfDay t) {
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  Future<void> _pickCircadianTime({required bool isStart}) async {
    final current = isStart
        ? _parseTime(_sleepStart, const TimeOfDay(hour: 23, minute: 30))
        : _parseTime(_sleepEnd, const TimeOfDay(hour: 7, minute: 30));
    final picked = await showTimePicker(
      context: context,
      initialTime: current,
      builder: (ctx, child) {
        return MediaQuery(
          data: MediaQuery.of(ctx).copyWith(alwaysUse24HourFormat: true),
          child: child ?? const SizedBox.shrink(),
        );
      },
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (isStart) {
        _sleepStart = _formatTime(picked);
      } else {
        _sleepEnd = _formatTime(picked);
      }
    });
    await _saveCircadianAndNotifications();
  }

  Future<void> _saveCircadianAndNotifications() async {
    setState(() {
      _savingRhythm = true;
      _rhythmFeedback = null;
      _rhythmError = null;
    });
    try {
      final webhookUrl = _webhookUrlCtrl.text.trim();
      final barkServer = _barkServerUrlCtrl.text.trim();
      final barkKey = _barkKeyCtrl.text.trim();
      final ntfyServer = _ntfyServerUrlCtrl.text.trim();
      final ntfyTopic = _ntfyTopicCtrl.text.trim();
      final ntfyToken = _ntfyTokenCtrl.text.trim();
      final patch = <String, dynamic>{
        'circadian': {
          'sleepStart': _sleepStart,
          'sleepEnd': _sleepEnd,
          'proactiveEnabled': _proactiveEnabled,
        },
        'notifications': {
          'desktop': {'enabled': _desktopNotifyEnabled},
          if (webhookUrl.isNotEmpty || _webhookEnabled)
            'webhook': {
              'enabled': _webhookEnabled,
              'url': webhookUrl,
            },
          if (_barkEnabled || barkServer.isNotEmpty || barkKey.isNotEmpty || _hasBarkKey)
            'bark': {
              'enabled': _barkEnabled,
              if (barkServer.isNotEmpty) 'serverUrl': barkServer,
            },
          if (_ntfyEnabled || ntfyTopic.isNotEmpty || ntfyServer.isNotEmpty)
            'ntfy': {
              'enabled': _ntfyEnabled,
              'topic': ntfyTopic,
              if (ntfyServer.isNotEmpty) 'serverUrl': ntfyServer,
            },
        },
      };
      if (barkKey.isNotEmpty || ntfyToken.isNotEmpty) {
        patch['notificationSecrets'] = {
          if (barkKey.isNotEmpty) 'barkDeviceKey': barkKey,
          if (ntfyToken.isNotEmpty) 'ntfyToken': ntfyToken,
        };
      }
      await widget.controller.patchSettings(patch);
      if (!mounted) return;
      _barkKeyCtrl.clear();
      _ntfyTokenCtrl.clear();
      setState(() {
        _savingRhythm = false;
        _rhythmFeedback = '已自动保存并即时生效';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _savingRhythm = false;
        _rhythmError = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _savingRhythm = false;
        _rhythmError = '保存失败，请检查网络或输入格式（如 23:30）';
      });
    }
  }

  Future<void> _handleTestNotifications() async {
    if (_testingNotifications) return;
    setState(() {
      _testingNotifications = true;
      _rhythmFeedback = null;
      _rhythmError = null;
    });
    try {
      if (LocalNotificationService.isSupported && _desktopNotifyEnabled) {
        await LocalNotificationService.requestPermission();
        await LocalNotificationService.show(
          id: 'test_${DateTime.now().millisecondsSinceEpoch}',
          title: 'Psyber 测试通知',
          body: 'Mac 客户端原生通知已连通。',
        );
      }
      final res = await widget.controller.testNotifications();
      if (!mounted || res == null) return;
      setState(() {
        _testingNotifications = false;
        if (res.suppressedReason == 'no_channels') {
          _rhythmError = '当前未启用任何离线通知通道';
        } else if (res.failedChannels.isNotEmpty && res.sentChannels.isEmpty) {
          _rhythmError = '发送失败：${res.failedChannels.join('、')}';
        } else if (res.failedChannels.isNotEmpty) {
          _rhythmFeedback = '已发送至 ${res.sentChannels.join('、')}（${res.failedChannels.join('、')} 失败）';
        } else {
          _rhythmFeedback = '测试通知已发送至：${res.sentChannels.join('、')}';
        }
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _testingNotifications = false;
        _rhythmError = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _testingNotifications = false;
        _rhythmError = '测试通知发送失败，请检查网络';
      });
    }
  }


  Future<void> _handleUploadAvatar(String who) async {
    if (_uploadingAvatar) return;
    final picker = widget.imagePicker ?? defaultPlatformImagePicker;
    final picked = await picker();
    if (picked == null || !mounted) return;
    setState(() {
      _uploadingAvatar = true;
      _avatarHint = null;
    });
    try {
      await widget.controller.uploadAvatar(
        who: who,
        bytes: picked.bytes,
        filename: picked.filename,
        mimeType: picked.mimeType,
      );
      if (!mounted) return;
      final residentLabel =
          widget.controller.identityNotifier.value.displayResidentName;
      setState(() {
        _uploadingAvatar = false;
        _avatarHint = who == 'resident' ? '$residentLabel头像已更新' : '我的头像已更新';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _uploadingAvatar = false;
        _avatarHint = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _uploadingAvatar = false;
        _avatarHint = '头像上传失败，请稍后重试';
      });
    }
  }

  Future<void> _openMcpEditorDialog({McpPresetView? preset}) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => _McpEditorDialog(
        controller: widget.controller,
        preset: preset,
      ),
    );
  }

  Future<void> _openMcpPresetPicker() async {
    final presets = await widget.controller.loadMcpPresets();
    if (!mounted) return;
    final colors = context.colors;
    final picked = await showDialog<McpPresetView>(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: colors.letterSurface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: colors.hairline),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '选择 MCP 生态预设',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: colors.inkDeep,
                  ),
                ),
                const SizedBox(height: 10),
                if (presets.isEmpty)
                  Text(
                    '当前服务端未返回预设模板，可改用「自定义添加」。',
                    style: TextStyle(fontSize: 12.5, color: colors.inkQuiet),
                  )
                else
                  for (final p in presets)
                    ListTile(
                      key: Key('mcp_preset_${p.id}'),
                      dense: true,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 6),
                      title: Text(
                        p.label,
                        style: TextStyle(fontSize: 13.5, color: colors.inkDeep),
                      ),
                      subtitle: Text(
                        p.description,
                        style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                      ),
                      onTap: () => Navigator.of(ctx).pop(p),
                    ),
              ],
            ),
          ),
        ),
      ),
    );
    if (picked != null && mounted) {
      await _openMcpEditorDialog(preset: picked);
    }
  }


  Widget _buildRhythmNotifySection(BuildContext context) {
    final colors = context.colors;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const _SectionLabel('作息节律'),
        _SurfaceBox(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: _TimePickerBox(
                        key: const Key('sleep_start_picker'),
                        label: '夜间休息开始',
                        value: _sleepStart,
                        onTap: () => unawaited(_pickCircadianTime(isStart: true)),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _TimePickerBox(
                        key: const Key('sleep_end_picker'),
                        label: '早晨醒来',
                        value: _sleepEnd,
                        onTap: () => unawaited(_pickCircadianTime(isStart: false)),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _QuietSwitchTile(
                  key: const Key('proactive_enabled_switch'),
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  title: '允许定时主动招呼',
                  subtitle: '静默时段不打扰，连续未回会自动安静',
                  value: _proactiveEnabled,
                  onChanged: (v) {
                    setState(() => _proactiveEnabled = v);
                    unawaited(_saveCircadianAndNotifications());
                  },
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        const _SectionLabel('离线触达'),
        _SurfaceBox(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _QuietSwitchTile(
                  key: const Key('desktop_notify_switch'),
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  title: '本机桌面通知',
                  value: _desktopNotifyEnabled,
                  onChanged: (v) {
                    setState(() => _desktopNotifyEnabled = v);
                    unawaited(_saveCircadianAndNotifications());
                  },
                ),
                _QuietSwitchTile(
                  key: const Key('webhook_enabled_switch'),
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  title: 'Webhook 离线推送',
                  value: _webhookEnabled,
                  onChanged: (v) {
                    setState(() => _webhookEnabled = v);
                    unawaited(_saveCircadianAndNotifications());
                  },
                ),
                if (_webhookEnabled || _webhookUrlCtrl.text.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _webhookUrlCtrl,
                          style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                          decoration: const InputDecoration(
                            labelText: 'Webhook URL',
                            hintText: 'https://...',
                            isDense: true,
                          ),
                          onSubmitted: (_) => unawaited(_saveCircadianAndNotifications()),
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: _savingRhythm
                            ? null
                            : () => unawaited(_saveCircadianAndNotifications()),
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        ),
                        child: const Text('保存', style: TextStyle(fontSize: 12.5)),
                      ),
                    ],
                  ),
                ],
                _QuietSwitchTile(
                  key: const Key('bark_enabled_switch'),
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  title: 'Bark 推送 (iOS)',
                  subtitle: _hasBarkKey ? '设备 Key 已配置' : '零证书直达 iOS 锁屏',
                  value: _barkEnabled,
                  onChanged: (v) {
                    setState(() => _barkEnabled = v);
                    unawaited(_saveCircadianAndNotifications());
                  },
                ),
                if (_barkEnabled || _hasBarkKey) ...[
                  const SizedBox(height: 8),
                  TextField(
                    key: const Key('bark_key_field'),
                    controller: _barkKeyCtrl,
                    obscureText: true,
                    style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                    decoration: InputDecoration(
                      labelText: _hasBarkKey ? 'Bark Device Key（留空保持不变）' : 'Bark Device Key',
                      hintText: '从 Bark App 复制的 Key',
                      isDense: true,
                    ),
                    onSubmitted: (_) => unawaited(_saveCircadianAndNotifications()),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          key: const Key('bark_server_field'),
                          controller: _barkServerUrlCtrl,
                          style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                          decoration: const InputDecoration(
                            labelText: 'Bark 服务器（可选）',
                            hintText: 'https://api.day.app',
                            isDense: true,
                          ),
                          onSubmitted: (_) => unawaited(_saveCircadianAndNotifications()),
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: _savingRhythm
                            ? null
                            : () => unawaited(_saveCircadianAndNotifications()),
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        ),
                        child: const Text('保存', style: TextStyle(fontSize: 12.5)),
                      ),
                    ],
                  ),
                ],
                _QuietSwitchTile(
                  key: const Key('ntfy_enabled_switch'),
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  title: 'ntfy 推送 (跨端)',
                  subtitle: '支持 Android / iOS / 桌面自建',
                  value: _ntfyEnabled,
                  onChanged: (v) {
                    setState(() => _ntfyEnabled = v);
                    unawaited(_saveCircadianAndNotifications());
                  },
                ),
                if (_ntfyEnabled || _ntfyTopicCtrl.text.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  TextField(
                    key: const Key('ntfy_topic_field'),
                    controller: _ntfyTopicCtrl,
                    style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                    decoration: const InputDecoration(
                      labelText: 'ntfy Topic（必填）',
                      hintText: '例如 psyber-my-room',
                      isDense: true,
                    ),
                    onSubmitted: (_) => unawaited(_saveCircadianAndNotifications()),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    key: const Key('ntfy_server_field'),
                    controller: _ntfyServerUrlCtrl,
                    style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                    decoration: const InputDecoration(
                      labelText: 'ntfy 服务器（可选）',
                      hintText: 'https://ntfy.sh',
                      isDense: true,
                    ),
                    onSubmitted: (_) => unawaited(_saveCircadianAndNotifications()),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          key: const Key('ntfy_token_field'),
                          controller: _ntfyTokenCtrl,
                          obscureText: true,
                          style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                          decoration: InputDecoration(
                            labelText: _hasNtfyToken ? '鉴权 Token（留空保持不变）' : '鉴权 Token（可选）',
                            isDense: true,
                          ),
                          onSubmitted: (_) => unawaited(_saveCircadianAndNotifications()),
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: _savingRhythm
                            ? null
                            : () => unawaited(_saveCircadianAndNotifications()),
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        ),
                        child: const Text('保存', style: TextStyle(fontSize: 12.5)),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  key: const Key('test_notifications_button'),
                  onPressed: _testingNotifications
                      ? null
                      : () => unawaited(_handleTestNotifications()),
                  icon: const Icon(PhosphorIconsLight.bellRinging, size: 15),
                  label: Text(
                    _testingNotifications ? '正在发送测试…' : '发一条测试通知',
                    style: const TextStyle(fontSize: 12.5),
                  ),
                ),
                if (_rhythmError != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _rhythmError!,
                    style: TextStyle(color: colors.dangerInk, fontSize: 12),
                  ),
                ],
                if (_rhythmFeedback != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _rhythmFeedback!,
                    style: TextStyle(color: colors.statusSuccess, fontSize: 12),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildAppearanceSection(BuildContext context) {
    final colors = context.colors;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const _SectionLabel('明暗与阅读色板'),
        ThemePaletteSelector(controller: widget.controller, framed: true),
        const SizedBox(height: 18),
        const _SectionLabel('居所双人头像'),
        _SurfaceBox(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '也可直接在左侧栏顶部的双人状态卡点击头像更换。',
                  style: TextStyle(fontSize: 12, color: colors.inkQuiet),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: ValueListenableBuilder<IdentityInfo>(
                        valueListenable: widget.controller.identityNotifier,
                        builder: (context, identity, _) => OutlinedButton.icon(
                          key: const Key('upload_resident_avatar_button'),
                          onPressed: _uploadingAvatar
                              ? null
                              : () => unawaited(_handleUploadAvatar('resident')),
                          icon: const Icon(PhosphorIconsLight.sparkle, size: 15),
                          label: Text(
                            '${identity.displayResidentName}头像',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        key: const Key('upload_user_avatar_button'),
                        onPressed: _uploadingAvatar
                            ? null
                            : () => unawaited(_handleUploadAvatar('user')),
                        icon: const Icon(PhosphorIconsLight.user, size: 15),
                        label: const Text('我的头像', style: TextStyle(fontSize: 12)),
                      ),
                    ),
                  ],
                ),
                if (_avatarHint != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _avatarHint!,
                    style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildToolsDevicesSection(BuildContext context, SettingsSnapshot? snap) {
    final colors = context.colors;
    final currentDeviceId = widget.controller.profileNotifier.value?.deviceId ?? '';

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const _SectionLabel('Psyber 能力与工具'),
        _AllToolsCatalogCard(controller: widget.controller, snap: snap),
        const SizedBox(height: 10),
        const _SectionLabel('外部工具扩展（MCP）'),
        _buildMcpServersSection(context, snap),
        const SizedBox(height: 18),
        const _SectionLabel('已配对设备'),
        _SurfaceBox(
          child: Column(
            children: [
              if (snap != null && snap.devices.isNotEmpty) ...[
                for (var i = 0; i < snap.devices.length; i++) ...[
                  if (i > 0) Divider(height: 1, color: colors.hairline),
                  ListTile(
                    dense: true,
                    leading: Icon(
                      snap.devices[i].platform == 'ios' ||
                              snap.devices[i].platform == 'android'
                          ? PhosphorIconsLight.deviceMobile
                          : PhosphorIconsLight.laptop,
                      size: 18,
                      color: colors.inkQuiet,
                    ),
                    title: Row(
                      children: [
                        Flexible(
                          child: Text(
                            snap.devices[i].deviceName,
                            style: TextStyle(fontSize: 13.5, color: colors.inkDeep),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (snap.devices[i].deviceId == currentDeviceId) ...[
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 1.5,
                            ),
                            decoration: BoxDecoration(
                              color: colors.celadonWash,
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: colors.hairline),
                            ),
                            child: Text(
                              '本机',
                              style: TextStyle(
                                fontSize: 10.5,
                                color: colors.inkQuiet,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                    subtitle: Text(
                      snap.devices[i].platform,
                      style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                    ),
                    trailing: snap.devices[i].deviceId == currentDeviceId
                        ? null
                        : TextButton(
                            onPressed: () => unawaited(
                              widget.controller
                                  .revokeOtherDevice(snap.devices[i].deviceId),
                            ),
                            child: Text(
                              '吊销',
                              style: TextStyle(
                                fontSize: 12,
                                color: colors.dangerInk,
                              ),
                            ),
                          ),
                  ),
                ],
                Divider(height: 1, color: colors.hairline),
              ],
              ListTile(
                key: const Key('pair_new_device_qr_button'),
                leading: Icon(
                  PhosphorIconsLight.qrCode,
                  size: 18,
                  color: colors.inkDeep,
                ),
                title: Text(
                  '配对新设备（扫码 / 配对码）',
                  style: TextStyle(fontSize: 13.5, color: colors.inkDeep),
                ),
                subtitle: Text(
                  '生成 5 分钟有效的一次性二维码供手机扫码直连',
                  style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                ),
                trailing: Icon(
                  PhosphorIconsLight.caretRight,
                  size: 15,
                  color: colors.inkFaint,
                ),
                onTap: () => unawaited(
                  showDialog<void>(
                    context: context,
                    builder: (_) => _PairNewDeviceQrDialog(
                      controller: widget.controller,
                    ),
                  ),
                ),
              ),
              Divider(height: 1, color: colors.hairline),
              ListTile(
                key: const Key('disconnect_device_button'),
                leading: Icon(
                  PhosphorIconsLight.linkBreak,
                  size: 18,
                  color: colors.dangerInk,
                ),
                title: Text(
                  '断开本机连接并重新配对',
                  style: TextStyle(fontSize: 13.5, color: colors.dangerInk),
                ),
                onTap: () async {
                  widget.onCloseSettings();
                  await widget.controller.disconnect();
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        const _SectionLabel('评测与调试（进阶）'),
        _SurfaceBox(
          child: ValueListenableBuilder<bool>(
            valueListenable: widget.controller.recallEvalModeNotifier,
            builder: (context, enabled, _) => Column(
              children: [
                _QuietSwitchTile(
                  key: const Key('recall_eval_switch'),
                  title: '召回评测模式',
                  subtitle: '开启后在回复下显示「想起 N 张卡」',
                  value: enabled,
                  onChanged: widget.controller.toggleRecallEvalMode,
                ),
                if (enabled) ...[
                  Divider(height: 1, color: colors.hairline),
                  ValueListenableBuilder<IdentityInfo>(
                    valueListenable: widget.controller.identityNotifier,
                    builder: (context, identity, _) => _QuietSwitchTile(
                      key: const Key('recall_eval_notice_switch'),
                      title: '评测检视对${identity.displayResidentName}透明',
                      subtitle: '开启后如实告知${identity.displayResidentName}当前处于召回评测检视中',
                      value: snap?.recallEvalNoticeResident ?? false,
                      onChanged: (v) => unawaited(
                        widget.controller.patchSettings({
                          'recallEvalNoticeResident': v,
                        }),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildMcpServersSection(BuildContext context, SettingsSnapshot? snap) {
    final colors = context.colors;
    final servers = snap?.mcpServers ?? const <McpServerView>[];
    return _SurfaceBox(
      child: Padding(
        key: const Key('mcp_servers_section'),
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (servers.isEmpty)
              Text(
                '尚未挂载外部 MCP 服务。所有外部工具仅通过 Tier 3 按需检索，不影响主对话缓存。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet, height: 1.45),
              )
            else
              for (var i = 0; i < servers.length; i++) ...[
                if (i > 0) const Divider(height: 14),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(
                                servers[i].id,
                                style: PsyberTheme.monoStyle.copyWith(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: colors.inkDeep,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 1.5,
                                ),
                                decoration: BoxDecoration(
                                  color: servers[i].status == 'connected'
                                      ? colors.celadonWash
                                      : colors.mineralCanvas,
                                  borderRadius: BorderRadius.circular(6),
                                  border: Border.all(color: colors.hairline),
                                ),
                                child: Text(
                                  servers[i].status == 'connected'
                                      ? '已连接 · ${servers[i].toolCount} 工具'
                                      : (servers[i].status == 'disabled' ? '已停用' : '降级'),
                                  style: TextStyle(
                                    fontSize: 10.5,
                                    color: servers[i].status == 'connected'
                                        ? colors.statusSuccess
                                        : colors.inkQuiet,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 3),
                          Text(
                            '${servers[i].transport} · ${servers[i].trustLevel == 'auto' ? '自动放行' : '需审批'}'
                            '${servers[i].lastError != null ? ' · ${servers[i].lastError}' : ''}',
                            style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      key: Key('mcp_reconnect_${servers[i].id}'),
                      icon: Icon(
                        PhosphorIconsLight.arrowClockwise,
                        size: 16,
                        color: colors.inkQuiet,
                      ),
                      tooltip: '重连',
                      constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                      padding: EdgeInsets.zero,
                      onPressed: () =>
                          unawaited(widget.controller.reconnectMcpServer(servers[i].id)),
                    ),
                    IconButton(
                      key: Key('mcp_delete_${servers[i].id}'),
                      icon: Icon(
                        PhosphorIconsLight.trash,
                        size: 16,
                        color: colors.dangerInk,
                      ),
                      tooltip: '移除',
                      constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                      padding: EdgeInsets.zero,
                      onPressed: () => unawaited(
                        widget.controller.patchSettings({
                          'mcpServers': [
                            for (final s in servers)
                              if (s.id != servers[i].id) s.toConfigJson(),
                          ],
                        }),
                      ),
                    ),
                  ],
                ),
              ],
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    key: const Key('mcp_add_preset_button'),
                    onPressed: () => unawaited(_openMcpPresetPicker()),
                    icon: const Icon(PhosphorIconsLight.plugsConnected, size: 15),
                    label: const Text('从预设添加', style: TextStyle(fontSize: 12)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    key: const Key('mcp_add_custom_button'),
                    onPressed: () => unawaited(_openMcpEditorDialog()),
                    icon: const Icon(PhosphorIconsLight.plus, size: 15),
                    label: const Text('自定义添加', style: TextStyle(fontSize: 12)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }


  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SettingsSnapshot?>(
      valueListenable: widget.controller.settingsNotifier,
      builder: (context, snap, _) {
        switch (widget.section) {
          case SettingsSection.modelProviders:
            return _ModelProvidersSection(controller: widget.controller, snap: snap);
          case SettingsSection.modelUsage:
            return _ModelAllocationSection(controller: widget.controller, snap: snap);
          case SettingsSection.usage:
            return _UsageSection(controller: widget.controller);
          case SettingsSection.rhythmNotify:
            return _buildRhythmNotifySection(context);
          case SettingsSection.appearance:
            return _buildAppearanceSection(context);
          case SettingsSection.toolsDevices:
            return _buildToolsDevicesSection(context, snap);
          case SettingsSection.about:
            return _AboutDataSection(controller: widget.controller, snap: snap);
        }
      },
    );
  }
}

class _NavRailTile extends StatelessWidget {
  const _NavRailTile({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: selected ? colors.accentSoft : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: selected ? colors.accentBorder : Colors.transparent,
            ),
          ),
          child: Row(
            children: [
              Icon(
                icon,
                size: 17,
                color: selected ? colors.inkDeep : colors.inkQuiet,
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    color: selected ? colors.inkDeep : colors.inkQuiet,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 6),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: colors.inkQuiet,
        ),
      ),
    );
  }
}

class _SurfaceBox extends StatelessWidget {
  const _SurfaceBox({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.letterSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.hairline),
      ),
      clipBehavior: Clip.antiAlias,
      child: child,
    );
  }
}

class _QuietSwitchTile extends StatelessWidget {
  const _QuietSwitchTile({
    super.key,
    required this.title,
    this.subtitle,
    required this.value,
    required this.onChanged,
    this.contentPadding = const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
  });

  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;
  final EdgeInsetsGeometry contentPadding;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      onTap: () => onChanged(!value),
      child: Padding(
        padding: contentPadding,
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: TextStyle(fontSize: 13.5, color: colors.inkDeep),
                  ),
                  if (subtitle != null && subtitle!.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 12),
            Transform.scale(
              scale: 0.76,
              alignment: Alignment.centerRight,
              child: CupertinoSwitch(
                value: value,
                activeTrackColor: colors.accent,
                inactiveTrackColor: colors.hairline,
                thumbColor: value ? colors.onAccent : colors.letterSurface,
                onChanged: onChanged,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TimePickerBox extends StatelessWidget {
  const _TimePickerBox({
    super.key,
    required this.label,
    required this.value,
    required this.onTap,
  });

  final String label;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: colors.mineralCanvas,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: colors.hairline),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: TextStyle(fontSize: 11, color: colors.inkQuiet),
            ),
            const SizedBox(height: 3),
            Row(
              children: [
                Text(
                  value,
                  style: PsyberTheme.monoStyle.copyWith(
                    fontSize: 13.5,
                    color: colors.inkDeep,
                  ),
                ),
                const Spacer(),
                Icon(
                  PhosphorIconsLight.clock,
                  size: 14,
                  color: colors.inkQuiet,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ThemeChip extends StatelessWidget {
  const _ThemeChip({
    super.key,
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(9),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        decoration: BoxDecoration(
          color: selected ? colors.accentSoft : colors.mineralCanvas,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            color: selected ? colors.accentBorder : colors.hairline,
            width: selected ? 1.4 : 1.0,
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 16,
              color: selected ? colors.inkDeep : colors.inkQuiet,
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                color: selected ? colors.inkDeep : colors.inkQuiet,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _UsageMetricTile extends StatelessWidget {
  const _UsageMetricTile({
    required this.label,
    required this.value,
    required this.sub,
  });

  final String label;
  final String value;
  final String sub;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: colors.mineralCanvas,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11, color: colors.inkQuiet)),
          const SizedBox(height: 3),
          Text(
            value,
            style: PsyberTheme.monoStyle.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: colors.inkDeep,
            ),
          ),
          const SizedBox(height: 2),
          Text(sub, style: TextStyle(fontSize: 10.5, color: colors.inkQuiet)),
        ],
      ),
    );
  }
}

class _McpEditorDialog extends StatefulWidget {
  const _McpEditorDialog({
    required this.controller,
    this.preset,
  });

  final AppController controller;
  final McpPresetView? preset;

  @override
  State<_McpEditorDialog> createState() => _McpEditorDialogState();
}

class _McpEditorDialogState extends State<_McpEditorDialog> {
  late final TextEditingController _idCtrl;
  late final TextEditingController _descCtrl;
  late final TextEditingController _cmdCtrl;
  late final TextEditingController _argsCtrl;
  late final TextEditingController _urlCtrl;
  late final TextEditingController _secretValCtrl;
  late String _transport;
  late String _trustLevel;
  late final String _secretKey;
  String? _errText;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final preset = widget.preset;
    _idCtrl = TextEditingController(text: preset?.id ?? '');
    _descCtrl = TextEditingController(text: preset?.description ?? '');
    _cmdCtrl = TextEditingController(text: preset?.command ?? '');
    _argsCtrl = TextEditingController(text: (preset?.args ?? const <String>[]).join(' '));
    _urlCtrl = TextEditingController(text: preset?.url ?? '');
    _secretValCtrl = TextEditingController();
    _transport = preset?.transport ?? 'stdio';
    _trustLevel = preset?.trustLevel ?? 'confirm';
    _secretKey = preset != null && preset.secretKeys.isNotEmpty ? preset.secretKeys.first : '';
  }

  @override
  void dispose() {
    _idCtrl.dispose();
    _descCtrl.dispose();
    _cmdCtrl.dispose();
    _argsCtrl.dispose();
    _urlCtrl.dispose();
    _secretValCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final id = _idCtrl.text.trim();
    if (id.isEmpty) {
      setState(() => _errText = '请填写服务器 ID');
      return;
    }
    if (_transport == 'stdio' && _cmdCtrl.text.trim().isEmpty) {
      setState(() => _errText = 'stdio 模式请填写启动命令');
      return;
    }
    if (_transport == 'streamable_http' && _urlCtrl.text.trim().isEmpty) {
      setState(() => _errText = 'HTTP 模式请填写端点 URL');
      return;
    }
    setState(() {
      _saving = true;
      _errText = null;
    });
    try {
      final preset = widget.preset;
      final existing =
          widget.controller.settingsNotifier.value?.mcpServers ?? const <McpServerView>[];
      final nextList = [
        for (final s in existing)
          if (s.id != id) s.toConfigJson(),
        {
          'id': id,
          'enabled': true,
          'transport': _transport,
          if (_descCtrl.text.trim().isNotEmpty) 'description': _descCtrl.text.trim(),
          if (_transport == 'stdio') 'command': _cmdCtrl.text.trim(),
          if (_transport == 'stdio' && _argsCtrl.text.trim().isNotEmpty)
            'args': _argsCtrl.text.trim().split(RegExp(r'\s+')),
          if (preset != null && preset.env.isNotEmpty) 'env': preset.env,
          if (_transport == 'streamable_http') 'url': _urlCtrl.text.trim(),
          if (preset != null && preset.headers.isNotEmpty) 'headers': preset.headers,
          'trustLevel': _trustLevel,
        },
      ];
      final patch = <String, dynamic>{'mcpServers': nextList};
      if (_secretKey.isNotEmpty && _secretValCtrl.text.trim().isNotEmpty) {
        patch['mcpSecrets'] = {_secretKey: _secretValCtrl.text.trim()};
      }
      await widget.controller.patchSettings(patch);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _errText = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _errText = '保存失败，请检查网络连接';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final preset = widget.preset;
    return Dialog(
      backgroundColor: colors.letterSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.hairline),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                preset != null ? '接入预设：${preset.label}' : '添加外部 MCP 服务器',
                style: TextStyle(
                  fontSize: 16.5,
                  fontWeight: FontWeight.w600,
                  color: colors.inkDeep,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '工具强制归入 Tier 3 按需搜索池，默认需审批确认，密钥仅写入 0600 凭证文件。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('mcp_id_field'),
                controller: _idCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                decoration: const InputDecoration(
                  labelText: '服务器 ID（小写字母/数字/-）',
                  hintText: '例如 fetch / tavily',
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _descCtrl,
                decoration: const InputDecoration(labelText: '一句话说明（可选）'),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _transport,
                isExpanded: true,
                decoration: const InputDecoration(labelText: '传输方式'),
                items: const [
                  DropdownMenuItem(
                    value: 'stdio',
                    child: Text('本地子进程 (stdio)', overflow: TextOverflow.ellipsis),
                  ),
                  DropdownMenuItem(
                    value: 'streamable_http',
                    child: Text('远程 HTTP (streamable_http)', overflow: TextOverflow.ellipsis),
                  ),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _transport = v);
                },
              ),
              const SizedBox(height: 10),
              if (_transport == 'stdio') ...[
                TextField(
                  key: const Key('mcp_command_field'),
                  controller: _cmdCtrl,
                  style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                  decoration: const InputDecoration(labelText: '启动命令', hintText: 'uvx / npx'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _argsCtrl,
                  style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                  decoration: const InputDecoration(labelText: '启动参数（空格分隔）'),
                ),
              ] else ...[
                TextField(
                  key: const Key('mcp_url_field'),
                  controller: _urlCtrl,
                  style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                  decoration: const InputDecoration(
                    labelText: 'MCP 端点 URL',
                    hintText: 'https://.../mcp/',
                  ),
                ),
              ],
              if (_secretKey.isNotEmpty) ...[
                const SizedBox(height: 10),
                TextField(
                  key: const Key('mcp_secret_field'),
                  controller: _secretValCtrl,
                  obscureText: true,
                  style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                  decoration: InputDecoration(
                    labelText: '凭证密钥 ($_secretKey)',
                    hintText: '仅存 credentials.json，不入 config.json',
                  ),
                ),
              ],
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _trustLevel,
                isExpanded: true,
                decoration: const InputDecoration(labelText: '调用审批策略'),
                items: const [
                  DropdownMenuItem(
                    value: 'confirm',
                    child: Text('每次调用确认（推荐）', overflow: TextOverflow.ellipsis),
                  ),
                  DropdownMenuItem(
                    value: 'auto',
                    child: Text('自动放行（仅限信任的只读服务）', overflow: TextOverflow.ellipsis),
                  ),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _trustLevel = v);
                },
              ),
              if (_errText != null) ...[
                const SizedBox(height: 8),
                Text(_errText!, style: TextStyle(fontSize: 12, color: colors.dangerInk)),
              ],
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _saving ? null : () => Navigator.of(context).pop(),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    key: const Key('mcp_save_button'),
                    onPressed: _saving ? null : () => unawaited(_save()),
                    child: Text(_saving ? '保存中…' : '保存并热加载'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StickerUploadDialog extends StatefulWidget {
  const _StickerUploadDialog({
    required this.controller,
    this.imagePicker,
  });

  final AppController controller;
  final ImageFilePicker? imagePicker;

  @override
  State<_StickerUploadDialog> createState() => _StickerUploadDialogState();
}

class _StickerUploadDialogState extends State<_StickerUploadDialog> {
  final _idCtrl = TextEditingController();
  final _labelCtrl = TextEditingController();
  final _packCtrl = TextEditingController(text: 'default');
  PickedImage? _pickedImage;
  String? _errText;
  bool _uploading = false;

  @override
  void dispose() {
    _idCtrl.dispose();
    _labelCtrl.dispose();
    _packCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickImage() async {
    final picker = widget.imagePicker ?? defaultPlatformImagePicker;
    final res = await picker();
    if (res != null && mounted) {
      setState(() => _pickedImage = res);
    }
  }

  Future<void> _upload() async {
    final id = _idCtrl.text.trim();
    final label = _labelCtrl.text.trim();
    if (_pickedImage == null || id.isEmpty || label.isEmpty) {
      setState(() => _errText = '请选择图片并填写 ID 与语义说明');
      return;
    }
    setState(() {
      _uploading = true;
      _errText = null;
    });
    try {
      await widget.controller.uploadSticker(
        bytes: _pickedImage!.bytes,
        filename: _pickedImage!.filename,
        mimeType: _pickedImage!.mimeType,
        id: id,
        label: label,
        pack: _packCtrl.text.trim().isEmpty ? 'default' : _packCtrl.text.trim(),
      );
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _errText = e.isEndpointUnavailable
            ? '当前服务端暂未开启在线上传贴纸，可将图片放入服务端 stickers/ 目录。'
            : e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _errText = '上传失败，请稍后重试';
      });
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
        constraints: const BoxConstraints(maxWidth: 420),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '上传表情贴纸',
                style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 6),
              Text(
                '支持 PNG / WebP / GIF（≤ 2 MB），也可将图片直接放入服务端 stickers/ 目录。',
                style: TextStyle(fontSize: 12.5, color: colors.inkQuiet, height: 1.45),
              ),
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: _uploading ? null : () => unawaited(_pickImage()),
                icon: const Icon(PhosphorIconsLight.image, size: 17),
                label: Text(_pickedImage == null ? '选择贴纸图片' : _pickedImage!.filename),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _idCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                decoration: const InputDecoration(
                  labelText: '贴纸 ID',
                  hintText: '例如 cat-nod（小写字母/数字/-）',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _labelCtrl,
                decoration: const InputDecoration(
                  labelText: '贴纸语义说明（≤ 20 字）',
                  hintText: '例如 轻轻点头',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _packCtrl,
                decoration: const InputDecoration(labelText: '分组名（可选）'),
              ),
              if (_errText != null) ...[
                const SizedBox(height: 10),
                Text(
                  _errText!,
                  style: TextStyle(color: colors.dangerInk, fontSize: 12.5),
                ),
              ],
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _uploading ? null : () => Navigator.of(context).pop(),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _uploading ? null : () => unawaited(_upload()),
                    child: const Text('上传'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _formatTokenCount(int? tokens) {
  if (tokens == null || tokens <= 0) return '-';
  if (tokens >= 1000000) {
    final v = tokens / 1000000;
    return v == v.truncateToDouble() ? '${v.toInt()}M' : '${v.toStringAsFixed(1)}M';
  }
  if (tokens >= 1000) {
    final v = tokens / 1000;
    return v == v.truncateToDouble() ? '${v.toInt()}K' : '${v.toStringAsFixed(1)}K';
  }
  return '$tokens';
}

String _modalityLabel(String mod) => switch (mod) {
      'text' => '文本',
      'image' => '识图',
      'audio' => '音频',
      'video' => '视频',
      'pdf' => 'PDF',
      _ => mod,
    };

String _formatEpochTime(int? ms) {
  if (ms == null || ms <= 0) return '尚未同步';
  final dt = DateTime.fromMillisecondsSinceEpoch(ms).toLocal();
  String p2(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${p2(dt.month)}-${p2(dt.day)} ${p2(dt.hour)}:${p2(dt.minute)}';
}

String _defaultBaseUrlForKind(String kind) => switch (kind) {
      'openai' => 'https://api.openai.com/v1',
      'anthropic' => 'https://api.anthropic.com',
      'google' => 'https://generativelanguage.googleapis.com/v1beta',
      _ => '',
    };

/// 模型服务商池：左侧服务商列表 + 右侧地址/密钥/连通测试/模型标签与元数据覆盖。
class _ModelProvidersSection extends StatefulWidget {
  const _ModelProvidersSection({required this.controller, required this.snap});

  final AppController controller;
  final SettingsSnapshot? snap;

  @override
  State<_ModelProvidersSection> createState() => _ModelProvidersSectionState();
}

class _ModelProvidersSectionState extends State<_ModelProvidersSection> {
  final _baseUrlCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  String? _selectedId;
  bool _obscureKey = true;
  bool _saving = false;
  bool _testing = false;
  bool _discovering = false;
  String? _feedback;
  bool _feedbackOk = true;
  Map<String, DiscoveredModelView> _discoveredById = const <String, DiscoveredModelView>{};

  @override
  void initState() {
    super.initState();
    _ensureSelection();
  }

  @override
  void didUpdateWidget(covariant _ModelProvidersSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.snap != widget.snap) {
      _ensureSelection(keepInput: true);
    }
  }

  void _ensureSelection({bool keepInput = false}) {
    final providers = widget.snap?.providers ?? const <String, ProviderSettingsView>{};
    if (providers.isEmpty) {
      _selectedId = null;
      return;
    }
    final prev = _selectedId;
    if (prev == null || !providers.containsKey(prev)) {
      final chatP = widget.snap?.chatSlot?.provider;
      _selectedId = (chatP != null && providers.containsKey(chatP)) ? chatP : providers.keys.first;
      _syncInputsFor(_selectedId!);
    } else if (!keepInput) {
      _syncInputsFor(prev);
    }
  }

  void _syncInputsFor(String id) {
    final p = widget.snap?.providers[id];
    final savedUrl = p?.baseUrl?.trim() ?? '';
    _baseUrlCtrl.text = savedUrl.isNotEmpty ? savedUrl : _defaultBaseUrlForKind(p?.kind ?? '');
    _apiKeyCtrl.clear();
    _feedback = null;
    _discoveredById = const <String, DiscoveredModelView>{};
  }

  @override
  void dispose() {
    _baseUrlCtrl.dispose();
    _apiKeyCtrl.dispose();
    super.dispose();
  }

  Future<void> _saveBaseUrl(ProviderSettingsView p) async {
    setState(() {
      _saving = true;
      _feedback = null;
    });
    try {
      final baseUrl = _baseUrlCtrl.text.trim();
      await widget.controller.patchSettings({
        'llm': {
          'providers': {
            p.id: {
              'kind': p.kind,
              'baseUrl': baseUrl,
              'authMode': p.authMode,
              'models': p.models,
              if (p.modelOverrides.isNotEmpty)
                'modelOverrides': {for (final e in p.modelOverrides.entries) e.key: e.value.toJson()},
            },
          },
        },
      });
      if (!mounted) return;
      setState(() {
        _saving = false;
        _discoveredById = const <String, DiscoveredModelView>{};
        _feedbackOk = true;
        _feedback = '服务地址已更新';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _feedbackOk = false;
        _feedback = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _feedbackOk = false;
        _feedback = '保存失败，请检查网络连接';
      });
    }
  }

  Future<void> _saveApiKey(ProviderSettingsView p) async {
    final key = _apiKeyCtrl.text.trim();
    if (key.isEmpty) {
      setState(() {
        _feedbackOk = false;
        _feedback = '请先输入新的 API 密钥';
      });
      return;
    }
    setState(() {
      _saving = true;
      _feedback = null;
    });
    try {
      await widget.controller.patchSettings({
        'credentials': {
          p.id: {'apiKey': key},
        },
      });
      if (!mounted) return;
      _apiKeyCtrl.clear();
      setState(() {
        _saving = false;
        _discoveredById = const <String, DiscoveredModelView>{};
        _feedbackOk = true;
        _feedback = 'API 密钥已更新并安全存储';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _feedbackOk = false;
        _feedback = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _feedbackOk = false;
        _feedback = '密钥更新失败';
      });
    }
  }

  Future<void> _testConnection(ProviderSettingsView p) async {
    final testModel = p.models.isNotEmpty
        ? p.models.first
        : (widget.snap?.chatSlot?.provider == p.id ? widget.snap!.chatSlot!.model : '');
    if (testModel.isEmpty) {
      setState(() {
        _feedbackOk = false;
        _feedback = '请先为该服务商添加至少一个模型再测连通';
      });
      return;
    }
    setState(() {
      _testing = true;
      _feedback = null;
    });
    try {
      final res = await widget.controller.testLlmModel(provider: p.id, model: testModel);
      if (!mounted || res == null) return;
      setState(() {
        _testing = false;
        _feedbackOk = res.ok;
        _feedback = res.ok ? '连通正常 · ${res.latencyMs} ms ($testModel)' : (res.error ?? '连通测试失败');
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _testing = false;
        _feedbackOk = false;
        _feedback = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _testing = false;
        _feedbackOk = false;
        _feedback = '连通测试失败';
      });
    }
  }

  Future<void> _discoverModels(ProviderSettingsView p) async {
    setState(() {
      _discovering = true;
      _feedback = null;
    });
    try {
      final list = await widget.controller.loadLlmModels(provider: p.id);
      if (!mounted) return;
      setState(() {
        _discovering = false;
        _discoveredById = {for (final m in list) m.id: m};
        _feedbackOk = true;
        _feedback = '已获取 ${list.length} 个模型及其上下文/模态信息';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _discovering = false;
        _feedbackOk = false;
        _feedback = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _discovering = false;
        _feedbackOk = false;
        _feedback = '拉取模型列表失败';
      });
    }
  }

  Future<void> _updateProviderModels(ProviderSettingsView p, List<String> nextModels) async {
    await widget.controller.patchSettings({
      'llm': {
        'providers': {
          p.id: {
            'kind': p.kind,
            if (p.baseUrl != null && p.baseUrl!.isNotEmpty) 'baseUrl': p.baseUrl,
            'authMode': p.authMode,
            'models': nextModels,
            if (p.modelOverrides.isNotEmpty)
              'modelOverrides': {for (final e in p.modelOverrides.entries) e.key: e.value.toJson()},
          },
        },
      },
    });
  }

  Future<void> _openAddModelDialog(ProviderSettingsView p) async {
    final added = await showDialog<String>(
      context: context,
      builder: (_) => _AddModelDialog(
        provider: p,
        controller: widget.controller,
        initialDiscovered: _discoveredById,
        onDiscovered: (map) {
          if (!mounted) return;
          setState(() => _discoveredById = map);
        },
      ),
    );
    if (added != null && added.isNotEmpty && !p.models.contains(added)) {
      await _updateProviderModels(p, [...p.models, added]);
    }
  }

  Future<void> _openModelOverrideDialog(ProviderSettingsView p, String modelId) async {
    final discovered = _discoveredById[modelId];
    final existing = p.modelOverrides[modelId];
    await showDialog<void>(
      context: context,
      builder: (_) => _ModelMetadataOverrideDialog(
        provider: p,
        modelId: modelId,
        discovered: discovered,
        existing: existing,
        controller: widget.controller,
      ),
    );
  }

  Future<void> _openAddProviderDialog() async {
    final createdId = await showDialog<String>(
      context: context,
      builder: (_) => _AddProviderDialog(controller: widget.controller),
    );
    if (createdId != null && mounted) {
      setState(() {
        _selectedId = createdId;
        _syncInputsFor(createdId);
      });
    }
  }

  Future<void> _deleteProvider(ProviderSettingsView p) async {
    await widget.controller.patchSettings({
      'llm': {
        'deleteProviderIds': [p.id],
      },
    });
    if (mounted) {
      setState(() => _ensureSelection());
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final snap = widget.snap;
    final providers = snap?.providers ?? const <String, ProviderSettingsView>{};
    final selected = _selectedId != null ? providers[_selectedId] : null;
    final isChatProvider = selected != null && snap?.chatSlot?.provider == selected.id;

    Widget buildProviderList() {
      return _SurfaceBox(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < providers.length; i++) ...[
              if (i > 0) Divider(height: 1, color: colors.hairline),
              Builder(
                builder: (context) {
                  final p = providers.values.elementAt(i);
                  final active = p.id == _selectedId;
                  final configured = p.authStatus == 'configured';
                  final isDefault = snap?.chatSlot?.provider == p.id;
                  return InkWell(
                    key: Key('provider_item_${p.id}'),
                    onTap: () => setState(() {
                      _selectedId = p.id;
                      _syncInputsFor(p.id);
                    }),
                    child: Container(
                      color: active ? colors.accentSoft : Colors.transparent,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              p.id,
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                                color: colors.inkDeep,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (isDefault) ...[
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                              decoration: BoxDecoration(
                                color: colors.mineralCanvas,
                                borderRadius: BorderRadius.circular(5),
                                border: Border.all(color: colors.hairline),
                              ),
                              child: Text('主', style: TextStyle(fontSize: 10, color: colors.inkQuiet)),
                            ),
                            const SizedBox(width: 6),
                          ],
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: configured ? colors.statusSuccess : colors.hairlineWarm,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ],
            if (providers.isNotEmpty) Divider(height: 1, color: colors.hairline),
            InkWell(
              key: const Key('add_provider_button'),
              onTap: () => unawaited(_openAddProviderDialog()),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Row(
                  children: [
                    Icon(PhosphorIconsLight.plus, size: 14, color: colors.accent),
                    const SizedBox(width: 6),
                    Text('添加服务商', style: TextStyle(fontSize: 12.5, color: colors.accent)),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    }

    Widget buildDetail(ProviderSettingsView p) {
      final configured = p.authStatus == 'configured';
      final modelSet = <String>[
        ...p.models,
        if (snap?.chatSlot?.provider == p.id &&
            snap!.chatSlot!.model.isNotEmpty &&
            !p.models.contains(snap.chatSlot!.model))
          snap.chatSlot!.model,
      ];
      return _SurfaceBox(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(p.id, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: colors.inkDeep)),
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                              decoration: BoxDecoration(
                                color: colors.mineralCanvas,
                                borderRadius: BorderRadius.circular(5),
                                border: Border.all(color: colors.hairline),
                              ),
                              child: Text(p.kind, style: PsyberTheme.monoStyle.copyWith(fontSize: 10.5, color: colors.inkQuiet)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 3),
                        Row(
                          children: [
                            Container(
                              width: 6.5,
                              height: 6.5,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: configured ? colors.statusSuccess : colors.thresholdAmber,
                              ),
                            ),
                            const SizedBox(width: 5),
                            Text(
                              configured ? '密钥已配置' : '尚未配置密钥',
                              style: TextStyle(fontSize: 11.5, color: configured ? colors.statusSuccess : colors.thresholdAmber),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (!isChatProvider && providers.length > 1)
                    IconButton(
                      icon: Icon(PhosphorIconsLight.trash, size: 16, color: colors.dangerInk),
                      tooltip: '移除服务商',
                      onPressed: () => unawaited(_deleteProvider(p)),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text('服务地址', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: colors.inkDeep)),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _baseUrlCtrl,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                      decoration: InputDecoration(
                        hintText: _defaultBaseUrlForKind(p.kind).isNotEmpty
                            ? _defaultBaseUrlForKind(p.kind)
                            : 'https://api.example.com/v1',
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _saving ? null : () => unawaited(_saveBaseUrl(p)),
                    child: const Text('更新', style: TextStyle(fontSize: 12)),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text('API 密钥', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: colors.inkDeep)),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _apiKeyCtrl,
                      obscureText: _obscureKey,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                      decoration: InputDecoration(
                        hintText: configured ? '填入新的密钥才会覆盖' : '请输入 API Key',
                        isDense: true,
                        suffixIcon: IconButton(
                          icon: Icon(_obscureKey ? PhosphorIconsLight.eyeSlash : PhosphorIconsLight.eye, size: 16),
                          onPressed: () => setState(() => _obscureKey = !_obscureKey),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _saving ? null : () => unawaited(_saveApiKey(p)),
                    child: const Text('更新', style: TextStyle(fontSize: 12)),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  key: const Key('test_llm_button'),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: _testing ? null : () => unawaited(_testConnection(p)),
                  child: Text(_testing ? '检测中…' : '检测连接', style: const TextStyle(fontSize: 12)),
                ),
              ),
              if (_feedback != null) ...[
                const SizedBox(height: 4),
                Text(
                  _feedback!,
                  style: TextStyle(fontSize: 11.5, color: _feedbackOk ? colors.statusSuccess : colors.dangerInk),
                ),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('模型', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: colors.inkDeep)),
                  const Spacer(),
                  TextButton(
                    onPressed: _discovering ? null : () => unawaited(_discoverModels(p)),
                    style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 6), minimumSize: Size.zero),
                    child: Text(_discovering ? '拉取中…' : '拉取能力信息', style: const TextStyle(fontSize: 11.5)),
                  ),
                  const SizedBox(width: 4),
                  OutlinedButton(
                    onPressed: () => unawaited(_openAddModelDialog(p)),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: const Text('添加模型', style: TextStyle(fontSize: 11.5)),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              if (modelSet.isEmpty)
                Text('暂未登记模型，点击「添加模型」或「拉取能力信息」后即可在模型配置页分配。', style: TextStyle(fontSize: 12, color: colors.inkQuiet))
              else
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final modelId in modelSet)
                      Builder(
                        builder: (context) {
                          final ov = p.modelOverrides[modelId];
                          final disc = _discoveredById[modelId];
                          final ctx = ov?.contextWindow ?? disc?.contextWindow;
                          final mods = ov?.inputModalities ?? disc?.inputModalities ?? const <String>[];
                          final hasVision = mods.contains('image');
                          final hasAudio = mods.contains('audio');
                          final hasVideo = mods.contains('video');
                          final badges = <String>[
                            if (ctx != null) _formatTokenCount(ctx),
                            if (hasVision) '识图',
                            if (hasAudio) '音频',
                            if (hasVideo) '视频',
                            if (ov != null) '已覆写',
                          ];
                          return InkWell(
                            borderRadius: BorderRadius.circular(8),
                            onTap: () => unawaited(_openModelOverrideDialog(p, modelId)),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                              decoration: BoxDecoration(
                                color: colors.mineralCanvas,
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: ov != null ? colors.accentBorder : colors.hairline),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(modelId, style: PsyberTheme.monoStyle.copyWith(fontSize: 11.5, color: colors.inkDeep)),
                                  if (badges.isNotEmpty) ...[
                                    const SizedBox(width: 5),
                                    Text(badges.join('·'), style: TextStyle(fontSize: 10, color: colors.inkQuiet)),
                                  ],
                                  if (p.models.contains(modelId)) ...[
                                    const SizedBox(width: 4),
                                    GestureDetector(
                                      onTap: () => unawaited(
                                        _updateProviderModels(p, p.models.where((m) => m != modelId).toList()),
                                      ),
                                      child: Icon(PhosphorIconsLight.x, size: 12, color: colors.inkFaint),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                  ],
                ),
              const SizedBox(height: 8),
              Text(
                '点击任意模型标签可手动覆盖上下文长度、最大输出或识图/音频/视频能力（优先级高于 models.dev 自动匹配）。',
                style: TextStyle(fontSize: 11, color: colors.inkFaint),
              ),
            ],
          ),
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 500;
        if (providers.isEmpty) {
          return ListView(
            padding: const EdgeInsets.all(20),
            children: [
              _SurfaceBox(
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    children: [
                      Text('尚未添加模型服务商', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: colors.inkDeep)),
                      const SizedBox(height: 10),
                      FilledButton.icon(
                        key: const Key('add_provider_button'),
                        onPressed: () => unawaited(_openAddProviderDialog()),
                        icon: const Icon(PhosphorIconsLight.plus, size: 15),
                        label: const Text('添加模型服务商'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        }
        if (wide) {
          return ListView(
            padding: const EdgeInsets.all(18),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: 168, child: buildProviderList()),
                  const SizedBox(width: 12),
                  Expanded(child: selected != null ? buildDetail(selected) : const SizedBox.shrink()),
                ],
              ),
            ],
          );
        }
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            buildProviderList(),
            const SizedBox(height: 12),
            if (selected != null) buildDetail(selected),
          ],
        );
      },
    );
  }
}

class _AddModelDialog extends StatefulWidget {
  const _AddModelDialog({
    required this.provider,
    required this.controller,
    required this.initialDiscovered,
    required this.onDiscovered,
  });

  final ProviderSettingsView provider;
  final AppController controller;
  final Map<String, DiscoveredModelView> initialDiscovered;
  final ValueChanged<Map<String, DiscoveredModelView>> onDiscovered;

  @override
  State<_AddModelDialog> createState() => _AddModelDialogState();
}

class _AddModelDialogState extends State<_AddModelDialog> {
  final _ctrl = TextEditingController();
  late Map<String, DiscoveredModelView> _discovered;
  bool _loading = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _discovered = Map<String, DiscoveredModelView>.from(widget.initialDiscovered);
    unawaited(_fetchModels());
  }

  Future<void> _fetchModels() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final list = await widget.controller.loadLlmModels(provider: widget.provider.id);
      if (!mounted) return;
      final map = {for (final m in list) m.id: m};
      setState(() {
        _discovered = map;
        _loading = false;
      });
      widget.onDiscovered(map);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = '拉取模型列表失败，可直接手动输入模型 ID';
      });
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final p = widget.provider;
    final query = _ctrl.text.trim().toLowerCase();
    final filtered = _discovered.values
        .where((m) => !p.models.contains(m.id))
        .where(
          (m) =>
              query.isEmpty ||
              m.id.toLowerCase().contains(query) ||
              m.name.toLowerCase().contains(query),
        )
        .take(60)
        .toList(growable: false);

    return Dialog(
      backgroundColor: colors.letterSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: colors.hairline),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '添加模型到 ${p.id}',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: colors.inkDeep),
                    ),
                  ),
                  TextButton(
                    onPressed: _loading ? null : () => unawaited(_fetchModels()),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text(_loading ? '拉取中…' : '刷新列表', style: const TextStyle(fontSize: 11.5)),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _ctrl,
                autofocus: true,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                decoration: const InputDecoration(
                  labelText: '模型 ID（支持输入关键词筛选下方列表）',
                  hintText: '例如 gemini-decision-1 / claude-sonnet-4-5',
                  isDense: true,
                ),
                onChanged: (_) => setState(() {}),
                onSubmitted: (v) => Navigator.of(context).pop(v.trim()),
              ),
              if (_loading && _discovered.isEmpty) ...[
                const SizedBox(height: 12),
                Row(
                  children: [
                    const SizedBox(
                      width: 13,
                      height: 13,
                      child: CircularProgressIndicator(strokeWidth: 1.8),
                    ),
                    const SizedBox(width: 8),
                    Text('正在拉取可用模型…', style: TextStyle(fontSize: 11.5, color: colors.inkQuiet)),
                  ],
                ),
              ] else if (_loadError != null && _discovered.isEmpty) ...[
                const SizedBox(height: 8),
                Text(_loadError!, style: TextStyle(fontSize: 11.5, color: colors.inkQuiet)),
              ] else if (_discovered.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(
                  '从已拉取列表点选（匹配 ${filtered.length} / ${_discovered.length}）：',
                  style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                ),
                const SizedBox(height: 6),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 180),
                  child: SingleChildScrollView(
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final m in filtered)
                          ActionChip(
                            label: Text(m.id, style: PsyberTheme.monoStyle.copyWith(fontSize: 11)),
                            onPressed: () => Navigator.of(context).pop(m.id),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: () => Navigator.of(context).pop(_ctrl.text.trim()),
                    child: const Text('添加'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AddProviderDialog extends StatefulWidget {
  const _AddProviderDialog({required this.controller});
  final AppController controller;

  @override
  State<_AddProviderDialog> createState() => _AddProviderDialogState();
}

class _AddProviderDialogState extends State<_AddProviderDialog> {
  final _idCtrl = TextEditingController();
  final _baseUrlCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  String _kind = 'openai-compat';
  String _lastAutoBaseUrl = '';
  bool _saving = false;
  String? _err;

  @override
  void dispose() {
    _idCtrl.dispose();
    _baseUrlCtrl.dispose();
    _apiKeyCtrl.dispose();
    _modelCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final id = _idCtrl.text.trim();
    if (id.isEmpty) {
      setState(() => _err = '请填写服务商标识（如 openrouter / deepseek / custom）');
      return;
    }
    if (_kind == 'openai-compat' && _baseUrlCtrl.text.trim().isEmpty) {
      setState(() => _err = '兼容接口请填写 Base URL');
      return;
    }
    setState(() {
      _saving = true;
      _err = null;
    });
    try {
      final initModel = _modelCtrl.text.trim();
      final key = _apiKeyCtrl.text.trim();
      await widget.controller.patchSettings({
        'llm': {
          'providers': {
            id: {
              'kind': _kind,
              if (_baseUrlCtrl.text.trim().isNotEmpty) 'baseUrl': _baseUrlCtrl.text.trim(),
              'authMode': 'api_key',
              if (initModel.isNotEmpty) 'models': [initModel],
            },
          },
        },
        if (key.isNotEmpty)
          'credentials': {
            id: {'apiKey': key},
          },
      });
      if (mounted) Navigator.of(context).pop(id);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _err = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _err = '添加失败，请检查网络连接';
      });
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
        constraints: const BoxConstraints(maxWidth: 420),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('添加模型服务商', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: colors.inkDeep)),
              const SizedBox(height: 12),
              TextField(
                controller: _idCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                decoration: const InputDecoration(labelText: '服务商标识 ID', hintText: '例如 openrouter / deepseek / custom', isDense: true),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _kind,
                decoration: const InputDecoration(labelText: '接口协议', isDense: true),
                items: const [
                  DropdownMenuItem(value: 'openai-compat', child: Text('OpenAI 兼容接口')),
                  DropdownMenuItem(value: 'openai', child: Text('OpenAI 官方')),
                  DropdownMenuItem(value: 'anthropic', child: Text('Anthropic')),
                  DropdownMenuItem(value: 'google', child: Text('Google Gemini')),
                ],
                onChanged: (v) {
                  if (v == null) return;
                  setState(() {
                    _kind = v;
                    final nextDefault = _defaultBaseUrlForKind(v);
                    final current = _baseUrlCtrl.text.trim();
                    if (current.isEmpty || current == _lastAutoBaseUrl) {
                      _baseUrlCtrl.text = nextDefault;
                      _lastAutoBaseUrl = nextDefault;
                    }
                  });
                },
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _baseUrlCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                decoration: InputDecoration(
                  labelText: '服务地址 Base URL',
                  hintText: _defaultBaseUrlForKind(_kind).isNotEmpty
                      ? _defaultBaseUrlForKind(_kind)
                      : 'https://api.example.com/v1',
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _apiKeyCtrl,
                obscureText: true,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                decoration: const InputDecoration(labelText: 'API 密钥（可选，稍后也可补充）', isDense: true),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _modelCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                decoration: const InputDecoration(labelText: '初始模型 ID（可选）', hintText: '例如 deepseek-chat', isDense: true),
              ),
              if (_err != null) ...[
                const SizedBox(height: 8),
                Text(_err!, style: TextStyle(fontSize: 12, color: colors.dangerInk)),
              ],
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('取消')),
                  const SizedBox(width: 8),
                  FilledButton(onPressed: _saving ? null : () => unawaited(_save()), child: Text(_saving ? '保存中…' : '添加')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ModelMetadataOverrideDialog extends StatefulWidget {
  const _ModelMetadataOverrideDialog({
    required this.provider,
    required this.modelId,
    required this.controller,
    this.discovered,
    this.existing,
  });

  final ProviderSettingsView provider;
  final String modelId;
  final DiscoveredModelView? discovered;
  final ModelMetadataOverrideView? existing;
  final AppController controller;

  @override
  State<_ModelMetadataOverrideDialog> createState() => _ModelMetadataOverrideDialogState();
}

class _ModelMetadataOverrideDialogState extends State<_ModelMetadataOverrideDialog> {
  late final TextEditingController _ctxCtrl;
  late final TextEditingController _outCtrl;
  late Set<String> _inputMods;
  late bool _reasoning;
  late bool _toolCall;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final ov = widget.existing;
    final disc = widget.discovered;
    _ctxCtrl = TextEditingController(text: (ov?.contextWindow ?? disc?.contextWindow)?.toString() ?? '');
    _outCtrl = TextEditingController(text: (ov?.maxTokens ?? disc?.maxTokens)?.toString() ?? '');
    _inputMods = Set<String>.from(ov?.inputModalities ?? disc?.inputModalities ?? const ['text']);
    _reasoning = ov?.reasoning ?? disc?.reasoning ?? false;
    _toolCall = ov?.toolCall ?? disc?.toolCall ?? true;
  }

  @override
  void dispose() {
    _ctxCtrl.dispose();
    _outCtrl.dispose();
    super.dispose();
  }

  Future<void> _save({bool clear = false}) async {
    setState(() => _saving = true);
    final nextOverrides = Map<String, Map<String, dynamic>>.fromEntries(
      widget.provider.modelOverrides.entries.map((e) => MapEntry(e.key, e.value.toJson())),
    );
    if (clear) {
      nextOverrides.remove(widget.modelId);
    } else {
      final ctx = int.tryParse(_ctxCtrl.text.trim());
      final out = int.tryParse(_outCtrl.text.trim());
      nextOverrides[widget.modelId] = {
        if (ctx != null && ctx > 0) 'contextWindow': ctx,
        if (out != null && out > 0) 'maxTokens': out,
        'inputModalities': _inputMods.isEmpty ? ['text'] : _inputMods.toList(),
        'reasoning': _reasoning,
        'toolCall': _toolCall,
      };
    }
    try {
      await widget.controller.patchSettings({
        'llm': {
          'providers': {
            widget.provider.id: {
              'kind': widget.provider.kind,
              if (widget.provider.baseUrl != null && widget.provider.baseUrl!.isNotEmpty)
                'baseUrl': widget.provider.baseUrl,
              'authMode': widget.provider.authMode,
              'models': widget.provider.models,
              'modelOverrides': nextOverrides,
            },
          },
        },
      });
      if (mounted) Navigator.of(context).pop();
    } finally {
      if (mounted) setState(() => _saving = false);
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
        constraints: const BoxConstraints(maxWidth: 420),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('模型能力配置', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: colors.inkDeep)),
              const SizedBox(height: 3),
              Text(
                '${widget.provider.id} / ${widget.modelId}',
                style: PsyberTheme.monoStyle.copyWith(fontSize: 12, color: colors.inkQuiet),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _ctxCtrl,
                      keyboardType: TextInputType.number,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                      decoration: const InputDecoration(labelText: '上下文窗口 (tokens)', hintText: '128000', isDense: true),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: TextField(
                      controller: _outCtrl,
                      keyboardType: TextInputType.number,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                      decoration: const InputDecoration(labelText: '最大输出 (tokens)', hintText: '16384', isDense: true),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text('输入模态能力', style: TextStyle(fontSize: 12, color: colors.inkQuiet)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final mod in const ['text', 'image', 'audio', 'video', 'pdf'])
                    FilterChip(
                      label: Text(_modalityLabel(mod), style: const TextStyle(fontSize: 11.5)),
                      selected: _inputMods.contains(mod),
                      onSelected: (v) => setState(() {
                        if (v) {
                          _inputMods.add(mod);
                        } else if (mod != 'text') {
                          _inputMods.remove(mod);
                        }
                      }),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              _QuietSwitchTile(
                contentPadding: const EdgeInsets.symmetric(vertical: 4),
                title: '支持深度思考 / Reasoning',
                value: _reasoning,
                onChanged: (v) => setState(() => _reasoning = v),
              ),
              _QuietSwitchTile(
                contentPadding: const EdgeInsets.symmetric(vertical: 4),
                title: '支持工具调用 / Tool Call',
                value: _toolCall,
                onChanged: (v) => setState(() => _toolCall = v),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  if (widget.existing != null)
                    TextButton(
                      onPressed: _saving ? null : () => unawaited(_save(clear: true)),
                      child: Text('恢复自动匹配', style: TextStyle(fontSize: 12, color: colors.dangerInk)),
                    ),
                  const Spacer(),
                  TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('取消')),
                  const SizedBox(width: 8),
                  FilledButton(onPressed: _saving ? null : () => unawaited(_save()), child: const Text('保存覆盖')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 模型配置页：按角色槽位分配模型 + 主对话内联可折叠参数摘要 + models.dev 目录同步。
class _ModelAllocationSection extends StatefulWidget {
  const _ModelAllocationSection({required this.controller, required this.snap});

  final AppController controller;
  final SettingsSnapshot? snap;

  @override
  State<_ModelAllocationSection> createState() => _ModelAllocationSectionState();
}

class _ModelAllocationSectionState extends State<_ModelAllocationSection> {
  bool _chatParamsExpanded = false;
  bool _syncingCatalog = false;
  String? _syncHint;

  List<ModelSlotView> _availableCandidates(SettingsSnapshot? snap) {
    final out = <ModelSlotView>[];
    final seen = <String>{};
    void addSlot(ModelSlotView? s) {
      if (s == null || s.provider.isEmpty || s.model.isEmpty) return;
      final key = '${s.provider}/${s.model}';
      if (seen.add(key)) out.add(s);
    }

    if (snap != null) {
      for (final p in snap.providers.values) {
        for (final m in p.models) {
          addSlot(ModelSlotView(provider: p.id, model: m));
        }
      }
      addSlot(snap.chatSlot);
      addSlot(snap.memoryTaskSlot);
      addSlot(snap.digestSlot);
      addSlot(snap.decisionSlot);
      addSlot(snap.embeddingSlot);
      addSlot(snap.rerankerSlot);
      addSlot(snap.visionSlot);
      addSlot(snap.imageGenSlot);
      for (final f in snap.fallbackSlots) {
        addSlot(f);
      }
    }
    return out;
  }

  Future<void> _setSlot(String slotKey, ModelSlotView? value) async {
    await widget.controller.patchSettings({
      'llm': {
        'slots': {slotKey: value?.toJson()},
      },
    });
  }

  Future<void> _syncCatalog() async {
    if (_syncingCatalog) return;
    setState(() {
      _syncingCatalog = true;
      _syncHint = null;
    });
    try {
      final res = await widget.controller.syncModelCatalog();
      if (!mounted || res == null) return;
      setState(() {
        _syncingCatalog = false;
        _syncHint = res.ok ? '已同步 ${res.count} 个模型元数据' : (res.error ?? '同步失败，继续使用本地快照');
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _syncingCatalog = false;
        _syncHint = '同步失败，继续使用本地快照';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final snap = widget.snap;
    final candidates = _availableCandidates(snap);

    String thinkingText(String level) => switch (level) {
          'auto' => '自动',
          'off' => '关闭',
          'low' => '轻度',
          'medium' => '标准',
          'high' => '深度',
          _ => '自动',
        };

    Widget buildSlotRow({
      required String slotKey,
      required String title,
      required String subtitle,
      required ModelSlotView? current,
      required String emptyLabel,
      bool allowClear = true,
      Widget? belowTitle,
    }) {
      final currentVal = (current != null && current.provider.isNotEmpty && current.model.isNotEmpty)
          ? '${current.provider}/${current.model}'
          : '';
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(title, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: colors.inkDeep)),
                          if (allowClear) ...[
                            const SizedBox(width: 6),
                            Text('可选', style: TextStyle(fontSize: 11, color: colors.inkFaint)),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(subtitle, style: TextStyle(fontSize: 11.5, color: colors.inkQuiet)),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                SizedBox(
                  width: 218,
                  child: DropdownButtonFormField<String>(
                    key: Key('slot_picker_$slotKey'),
                    initialValue: currentVal.isEmpty ? '' : currentVal,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    ),
                    items: [
                      if (allowClear || currentVal.isEmpty)
                        DropdownMenuItem<String>(
                          value: '',
                          child: Text(emptyLabel, style: TextStyle(fontSize: 12, color: colors.inkQuiet), overflow: TextOverflow.ellipsis),
                        ),
                      for (final c in candidates)
                        DropdownMenuItem<String>(
                          value: '${c.provider}/${c.model}',
                          child: Text(
                            '${c.provider}/${c.model}',
                            style: PsyberTheme.monoStyle.copyWith(fontSize: 12, color: colors.inkDeep),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: (val) {
                      if (val == null || val.isEmpty) {
                        if (allowClear) unawaited(_setSlot(slotKey, null));
                        return;
                      }
                      final idx = val.indexOf('/');
                      if (idx > 0) {
                        unawaited(_setSlot(slotKey, ModelSlotView(provider: val.substring(0, idx), model: val.substring(idx + 1))));
                      }
                    },
                  ),
                ),
              ],
            ),
            if (belowTitle != null) belowTitle,
          ],
        ),
      );
    }

    final ctxText = snap?.chatContextLimit != null ? _formatTokenCount(snap!.chatContextLimit) : '跟随模型';
    final fbCount = snap?.fallbackSlots.length ?? 0;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const _SectionLabel('模型分配'),
        _SurfaceBox(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              buildSlotRow(
                slotKey: 'chat',
                title: '主对话',
                subtitle: '日常聊天与工具调用的默认模型',
                current: snap?.chatSlot,
                emptyLabel: '请先在「模型服务商」添加模型',
                allowClear: false,
                belowTitle: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      InkWell(
                        key: const Key('chat_params_toggle'),
                        borderRadius: BorderRadius.circular(6),
                        onTap: () => setState(() => _chatParamsExpanded = !_chatParamsExpanded),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              Icon(
                                _chatParamsExpanded ? PhosphorIconsLight.caretDown : PhosphorIconsLight.caretRight,
                                size: 13,
                                color: colors.inkQuiet,
                              ),
                              const SizedBox(width: 4),
                              Expanded(
                                child: Text(
                                  '参数 · 思考 ${thinkingText(snap?.thinkingLevel ?? 'auto')} · 上下文 $ctxText${fbCount > 0 ? ' · 备用 $fbCount 个' : ''}',
                                  style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (_chatParamsExpanded) ...[
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            for (final entry in const [
                              ('auto', '自动'),
                              ('off', '关闭'),
                              ('low', '轻度'),
                              ('medium', '标准'),
                              ('high', '深度'),
                            ])
                              Expanded(
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(horizontal: 2),
                                  child: InkWell(
                                    key: Key('thinking_level_${entry.$1}'),
                                    borderRadius: BorderRadius.circular(8),
                                    onTap: () => unawaited(
                                      widget.controller.patchSettings({
                                        'llm': {
                                          'thinking': {
                                            'enabled': entry.$1 != 'off',
                                            'level': entry.$1,
                                          },
                                        },
                                      }),
                                    ),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(vertical: 6),
                                      alignment: Alignment.center,
                                      decoration: BoxDecoration(
                                        color: (snap?.thinkingLevel ?? 'auto') == entry.$1
                                            ? colors.accentSoft
                                            : colors.mineralCanvas,
                                        borderRadius: BorderRadius.circular(8),
                                        border: Border.all(
                                          color: (snap?.thinkingLevel ?? 'auto') == entry.$1
                                              ? colors.accentBorder
                                              : colors.hairline,
                                        ),
                                      ),
                                      child: Text(
                                        entry.$2,
                                        style: TextStyle(
                                          fontSize: 11.5,
                                          fontWeight: (snap?.thinkingLevel ?? 'auto') == entry.$1
                                              ? FontWeight.w600
                                              : FontWeight.w400,
                                          color: colors.inkDeep,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'memory_task',
                title: '静默整理与梗概',
                subtitle: '睡前整理记忆卡片与日/周梗概，可选性价比更高的小模型',
                current: snap?.memoryTaskSlot,
                emptyLabel: '默认跟随主对话模型',
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'decision',
                title: '决策门控',
                subtitle: '判断日/周反思触发与按轮记忆召回；推荐 Google gemini-decision-1，也可选 OpenRouter 等轻量模型',
                current: snap?.decisionSlot,
                emptyLabel: '默认跟随摘要/整理模型',
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'digest',
                title: '附件摘要',
                subtitle: '发图/短视频时并行生成文字摘要供后续轮次与睡前整理记忆，不破缓存',
                current: snap?.digestSlot,
                emptyLabel: '未配置（不生成附件摘要）',
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'embedding',
                title: 'Embedding',
                subtitle: '记忆向量检索；不配则退回关键词检索',
                current: snap?.embeddingSlot,
                emptyLabel: '未配置（关键词检索）',
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'reranker',
                title: 'Rerank',
                subtitle: '记忆检索结果重排；不配则跳过重排',
                current: snap?.rerankerSlot,
                emptyLabel: '未配置',
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'vision',
                title: '多模态识图',
                subtitle: '主对话本身不支持识图时用于理解图片',
                current: snap?.visionSlot,
                emptyLabel: '默认跟随主对话模型',
              ),
              Divider(height: 1, color: colors.hairline),
              buildSlotRow(
                slotKey: 'image_gen',
                title: '生图',
                subtitle: '供生图能力使用；不配则不启用',
                current: snap?.imageGenSlot,
                emptyLabel: '未配置',
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _SurfaceBox(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('models.dev 模型元数据目录', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: colors.inkDeep)),
                      const SizedBox(height: 2),
                      Text(
                        _syncHint ??
                            '已收录 ${snap?.systemInfo?.catalogModelCount ?? 0} 个模型能力定义 · 自动补齐上下文与识图/音频模态',
                        style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  key: const Key('sync_model_catalog_button'),
                  onPressed: _syncingCatalog ? null : () => unawaited(_syncCatalog()),
                  child: Text(_syncingCatalog ? '同步中…' : '同步目录', style: const TextStyle(fontSize: 12)),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 独立用量页：时间范围分段切换 + 概览指标 + 按模型与每日明细。
class _UsageSection extends StatefulWidget {
  const _UsageSection({required this.controller});
  final AppController controller;

  @override
  State<_UsageSection> createState() => _UsageSectionState();
}

class _UsageSectionState extends State<_UsageSection> {
  int? _selectedDays = 7;
  bool _loading = false;
  UsageStatsSnapshot? _stats;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load(7));
  }

  Future<void> _load(int? days) async {
    setState(() {
      _selectedDays = days;
      _loading = true;
      _error = null;
    });
    try {
      final res = await widget.controller.loadUsageStats(days: days);
      if (!mounted) return;
      setState(() {
        _stats = res;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '暂时无法拉取用量统计';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final stats = _stats;
    final bucket = stats?.activeBucket;
    String fmtUsd(double v) => '\$${v.toStringAsFixed(4)}';
    String fmtPct(double r) => '${(r * 100).toStringAsFixed(1)}%';

    return ListView(
      key: const Key('usage_stats_section'),
      padding: const EdgeInsets.all(20),
      children: [
        _SurfaceBox(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Text('时间范围', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: colors.inkDeep)),
                const Spacer(),
                Wrap(
                  spacing: 4,
                  children: [
                    for (final entry in const <(int?, String)>[
                      (1, '今天'),
                      (7, '7 天'),
                      (30, '30 天'),
                      (90, '90 天'),
                      (null, '全部'),
                    ])
                      InkWell(
                        key: Key('usage_range_${entry.$1 ?? 'all'}'),
                        borderRadius: BorderRadius.circular(7),
                        onTap: _loading ? null : () => unawaited(_load(entry.$1)),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                          decoration: BoxDecoration(
                            color: _selectedDays == entry.$1 ? colors.accentSoft : colors.mineralCanvas,
                            borderRadius: BorderRadius.circular(7),
                            border: Border.all(
                              color: _selectedDays == entry.$1 ? colors.accentBorder : colors.hairline,
                            ),
                          ),
                          child: Text(
                            entry.$2,
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: _selectedDays == entry.$1 ? FontWeight.w600 : FontWeight.w400,
                              color: colors.inkDeep,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),
        if (_loading && stats == null)
          const Padding(
            padding: EdgeInsets.all(28),
            child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
          )
        else if (_error != null)
          _SurfaceBox(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Text(_error!, style: TextStyle(fontSize: 12.5, color: colors.dangerInk)),
            ),
          )
        else if (bucket == null || bucket.turnCount == 0)
          _SurfaceBox(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 38, horizontal: 20),
              child: Column(
                children: [
                  Icon(PhosphorIconsLight.chartBar, size: 28, color: colors.inkFaint),
                  const SizedBox(height: 8),
                  Text('暂无用量数据', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: colors.inkDeep)),
                  const SizedBox(height: 4),
                  Text('这段时间还没有用量，换个时间范围看看。', style: TextStyle(fontSize: 12, color: colors.inkQuiet)),
                ],
              ),
            ),
          )
        else ...[
          Row(
            children: [
              Expanded(
                child: _UsageMetricTile(
                  label: '估算费用',
                  value: fmtUsd(bucket.estimatedCostUsd),
                  sub: '${bucket.turnCount} 轮对话',
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _UsageMetricTile(
                  label: 'Prompt Cache 命中率',
                  value: fmtPct(bucket.cacheHitRate),
                  sub: '读 ${_formatTokenCount(bucket.cacheReadTokens)} · 写 ${_formatTokenCount(bucket.cacheWriteTokens)}',
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: _UsageMetricTile(
                  label: '输入 Token',
                  value: _formatTokenCount(bucket.inputTokens),
                  sub: '今日 ${fmtUsd(stats!.today.estimatedCostUsd)}',
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _UsageMetricTile(
                  label: '输出 Token',
                  value: _formatTokenCount(bucket.outputTokens),
                  sub: '累计 ${fmtUsd(stats.total.estimatedCostUsd)}',
                ),
              ),
            ],
          ),
          if (stats.byModel.isNotEmpty) ...[
            const SizedBox(height: 16),
            const _SectionLabel('按模型分布'),
            _SurfaceBox(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    for (var i = 0; i < stats.byModel.length; i++) ...[
                      if (i > 0) Divider(height: 12, color: colors.hairline),
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              stats.byModel[i].model,
                              style: PsyberTheme.monoStyle.copyWith(fontSize: 12, color: colors.inkDeep),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          Text(
                            '${stats.byModel[i].bucket.turnCount} 轮 · ${fmtUsd(stats.byModel[i].bucket.estimatedCostUsd)}',
                            style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
          if (stats.daily.isNotEmpty) ...[
            const SizedBox(height: 16),
            const _SectionLabel('每日明细'),
            _SurfaceBox(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    for (var i = 0; i < stats.daily.length && i < 14; i++) ...[
                      if (i > 0) Divider(height: 10, color: colors.hairline),
                      Row(
                        children: [
                          Text(stats.daily[i].date, style: PsyberTheme.monoStyle.copyWith(fontSize: 12, color: colors.inkDeep)),
                          const Spacer(),
                          Text(
                            '${stats.daily[i].bucket.turnCount} 轮 · 命中 ${fmtPct(stats.daily[i].bucket.cacheHitRate)} · ${fmtUsd(stats.daily[i].bucket.estimatedCostUsd)}',
                            style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ],
      ],
    );
  }
}

/// 全量工具清单卡片：展示 Psyber 所有能力，核心元工具锁定常驻不可关闭，扩展工具可按需开关。
class _AllToolsCatalogCard extends StatelessWidget {
  const _AllToolsCatalogCard({required this.controller, required this.snap});

  final AppController controller;
  final SettingsSnapshot? snap;

  Future<void> _toggleTool(ToolCatalogItemView tool, bool nextEnabled) async {
    if (tool.locked) return;
    final disabled = Set<String>.from(snap?.disabledTools ?? const <String>[]);
    if (nextEnabled) {
      disabled.remove(tool.name);
    } else {
      disabled.add(tool.name);
    }
    await controller.patchSettings({'disabledTools': disabled.toList()});
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final tools = snap?.tools ?? const <ToolCatalogItemView>[];
    if (tools.isEmpty) {
      return _SurfaceBox(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Text('正在加载工具清单…', style: TextStyle(fontSize: 12, color: colors.inkQuiet)),
        ),
      );
    }

    final enabledCount = tools.where((t) => t.enabled).length;
    final grouped = <String, List<ToolCatalogItemView>>{};
    for (final t in tools) {
      grouped.putIfAbsent(t.category, () => <ToolCatalogItemView>[]).add(t);
    }

    return Column(
      key: const Key('all_tools_catalog'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 8),
          child: Text(
            '已启用 $enabledCount / 共 ${tools.length} 项 · 核心元工具默认常驻不可关闭',
            style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
          ),
        ),
        for (final entry in grouped.entries) ...[
          _SurfaceBox(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  color: colors.mineralCanvas,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  child: Text(
                    entry.key,
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: colors.inkQuiet),
                  ),
                ),
                for (var i = 0; i < entry.value.length; i++) ...[
                  Divider(height: 1, color: colors.hairline),
                  Builder(
                    builder: (context) {
                      final tool = entry.value[i];
                      return Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Flexible(
                                        child: Text(
                                          tool.name,
                                          style: PsyberTheme.monoStyle.copyWith(
                                            fontSize: 12.5,
                                            fontWeight: FontWeight.w500,
                                            color: colors.inkDeep,
                                          ),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                      if (tool.security == 'confirm') ...[
                                        const SizedBox(width: 6),
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                          decoration: BoxDecoration(
                                            color: colors.mineralCanvas,
                                            borderRadius: BorderRadius.circular(5),
                                            border: Border.all(color: colors.hairline),
                                          ),
                                          child: Text('需审批', style: TextStyle(fontSize: 10, color: colors.inkQuiet)),
                                        ),
                                      ],
                                    ],
                                  ),
                                  if (tool.description.isNotEmpty) ...[
                                    const SizedBox(height: 2),
                                    Text(
                                      tool.description,
                                      style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ],
                                ],
                              ),
                            ),
                            const SizedBox(width: 10),
                            if (tool.locked)
                              Container(
                                key: Key('tool_locked_${tool.name}'),
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                decoration: BoxDecoration(
                                  color: colors.mineralCanvas,
                                  borderRadius: BorderRadius.circular(7),
                                  border: Border.all(color: colors.hairline),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(PhosphorIconsLight.lockSimple, size: 12, color: colors.inkQuiet),
                                    const SizedBox(width: 4),
                                    Text('核心常驻', style: TextStyle(fontSize: 11, color: colors.inkQuiet)),
                                  ],
                                ),
                              )
                            else
                              Transform.scale(
                                scale: 0.76,
                                alignment: Alignment.centerRight,
                                child: CupertinoSwitch(
                                  key: Key('tool_switch_${tool.name}'),
                                  value: tool.enabled,
                                  activeTrackColor: colors.accent,
                                  inactiveTrackColor: colors.hairline,
                                  thumbColor: tool.enabled ? colors.onAccent : colors.letterSurface,
                                  onChanged: (v) => unawaited(_toggleTool(tool, v)),
                                ),
                              ),
                          ],
                        ),
                      );
                    },
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
      ],
    );
  }
}

/// 关于与数据页：版本号、配置文件与记忆目录路径（一键复制）、模型元数据目录同步状态。
class _AboutDataSection extends StatefulWidget {
  const _AboutDataSection({required this.controller, required this.snap});

  final AppController controller;
  final SettingsSnapshot? snap;

  @override
  State<_AboutDataSection> createState() => _AboutDataSectionState();
}

class _AboutDataSectionState extends State<_AboutDataSection> {
  String? _copiedHint;
  bool _syncing = false;
  String? _syncMsg;

  Future<void> _copyPath(String label, String? path) async {
    if (path == null || path.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: path));
    if (!mounted) return;
    setState(() => _copiedHint = '已复制$label路径');
  }

  Future<void> _syncNow() async {
    if (_syncing) return;
    setState(() {
      _syncing = true;
      _syncMsg = null;
    });
    try {
      final res = await widget.controller.syncModelCatalog();
      if (!mounted || res == null) return;
      setState(() {
        _syncing = false;
        _syncMsg = res.ok ? '同步成功：共 ${res.count} 个模型' : (res.error ?? '同步失败');
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _syncing = false;
        _syncMsg = '同步失败，请稍后重试';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final info = widget.snap?.systemInfo;

    Widget rowItem({
      required String label,
      required String value,
      bool mono = false,
      Widget? trailing,
    }) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            Text(label, style: TextStyle(fontSize: 13.5, color: colors.inkDeep)),
            const SizedBox(width: 14),
            Expanded(
              child: Text(
                value,
                textAlign: TextAlign.right,
                style: (mono ? PsyberTheme.monoStyle : const TextStyle()).copyWith(
                  fontSize: mono ? 12 : 13,
                  color: colors.inkQuiet,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (trailing != null) ...[
              const SizedBox(width: 8),
              trailing,
            ],
          ],
        ),
      );
    }

    return ListView(
      key: const Key('about_data_section'),
      padding: const EdgeInsets.all(20),
      children: [
        _SurfaceBox(
          child: Column(
            children: [
              rowItem(label: '版本', value: info?.version ?? '0.1.0', mono: true),
              Divider(height: 1, color: colors.hairline),
              rowItem(
                label: '配置文件',
                value: info?.configPath ?? '未返回',
                mono: true,
                trailing: info?.configPath != null
                    ? IconButton(
                        icon: Icon(PhosphorIconsLight.copy, size: 15, color: colors.inkQuiet),
                        tooltip: '复制路径',
                        constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                        padding: EdgeInsets.zero,
                        onPressed: () => unawaited(_copyPath('配置文件', info!.configPath)),
                      )
                    : null,
              ),
              Divider(height: 1, color: colors.hairline),
              rowItem(
                label: '记忆与存储位置',
                value: info?.memoryDir ?? info?.dataDir ?? '未返回',
                mono: true,
                trailing: (info?.memoryDir ?? info?.dataDir) != null
                    ? IconButton(
                        icon: Icon(PhosphorIconsLight.copy, size: 15, color: colors.inkQuiet),
                        tooltip: '复制路径',
                        constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                        padding: EdgeInsets.zero,
                        onPressed: () => unawaited(_copyPath('存储位置', info?.memoryDir ?? info?.dataDir)),
                      )
                    : null,
              ),
              Divider(height: 1, color: colors.hairline),
              rowItem(
                label: '模型能力目录',
                value: '${info?.catalogModelCount ?? 0} 个模型 · ${_formatEpochTime(info?.catalogUpdatedAt)}',
                trailing: OutlinedButton(
                  onPressed: _syncing ? null : () => unawaited(_syncNow()),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(_syncing ? '同步中…' : '同步', style: const TextStyle(fontSize: 11.5)),
                ),
              ),
            ],
          ),
        ),
        if (_copiedHint != null) ...[
          const SizedBox(height: 10),
          Text(_copiedHint!, style: TextStyle(fontSize: 12, color: colors.statusSuccess)),
        ],
        if (_syncMsg != null) ...[
          const SizedBox(height: 8),
          Text(_syncMsg!, style: TextStyle(fontSize: 12, color: colors.inkQuiet)),
        ],
      ],
    );
  }
}

/// 已配对设备端展示的「配对新设备」二维码弹窗（5 分钟一次性配对码 + 候选局域网地址）。
class _PairNewDeviceQrDialog extends StatefulWidget {
  const _PairNewDeviceQrDialog({required this.controller});

  final AppController controller;

  @override
  State<_PairNewDeviceQrDialog> createState() => _PairNewDeviceQrDialogState();
}

class _PairNewDeviceQrDialogState extends State<_PairNewDeviceQrDialog> {
  IssuedPairCodeView? _issued;
  bool _loading = true;
  String? _error;
  String? _copiedHint;
  Timer? _countdownTimer;

  @override
  void initState() {
    super.initState();
    unawaited(_issue());
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    super.dispose();
  }

  Future<void> _issue() async {
    _countdownTimer?.cancel();
    setState(() {
      _loading = true;
      _error = null;
      _copiedHint = null;
    });
    try {
      final res = await widget.controller.issueNewDevicePairCode();
      if (!mounted) return;
      if (res == null) {
        setState(() {
          _loading = false;
          _error = '当前未连接到服务端';
        });
        return;
      }
      setState(() {
        _issued = res;
        _loading = false;
      });
      _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '生成配对二维码失败，请确认服务端在线';
      });
    }
  }

  String _formatRemaining(int expiresAtMs) {
    final diffSec =
        ((expiresAtMs - DateTime.now().millisecondsSinceEpoch) / 1000).ceil();
    if (diffSec <= 0) return '已过期，请重新生成';
    final min = diffSec ~/ 60;
    final sec = diffSec % 60;
    return '剩余 ${min.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}';
  }

  Future<void> _copy(String label, String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    setState(() => _copiedHint = '已复制$label');
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final issued = _issued;

    return Dialog(
      key: const Key('pair_new_device_qr_dialog'),
      backgroundColor: colors.letterSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.hairline),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Text(
                    '扫码配对新设备',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 16.5,
                      fontWeight: FontWeight.w500,
                      color: colors.inkDeep,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(PhosphorIconsLight.x, size: 17),
                    constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                    padding: EdgeInsets.zero,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '用手机端 Psyber 扫描二维码即可自动填入地址并完成一次性绑定，二维码不含长期密钥。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet, height: 1.45),
              ),
              const SizedBox(height: 14),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 48),
                  child: Center(
                    child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                )
              else if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 20),
                  child: Text(
                    _error!,
                    style: TextStyle(fontSize: 12.5, color: colors.dangerInk),
                  ),
                )
              else if (issued != null) ...[
                Center(
                  child: QrCodeView(
                    key: const Key('pair_qr_code_view'),
                    data: issued.qrPayload,
                    size: 196,
                  ),
                ),
                const SizedBox(height: 12),
                Center(
                  child: Text(
                    issued.code,
                    key: const Key('pair_qr_code_text'),
                    style: PsyberTheme.monoStyle.copyWith(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 2.2,
                      color: colors.inkDeep,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                Center(
                  child: Text(
                    _formatRemaining(issued.expiresAt),
                    style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                  ),
                ),
                if (issued.urls.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    '候选地址：${issued.urls.join(' · ')}',
                    textAlign: TextAlign.center,
                    style: PsyberTheme.monoStyle.copyWith(
                      fontSize: 11,
                      color: colors.inkQuiet,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                if (_copiedHint != null) ...[
                  const SizedBox(height: 6),
                  Center(
                    child: Text(
                      _copiedHint!,
                      style: TextStyle(fontSize: 11.5, color: colors.statusSuccess),
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => unawaited(_copy('配对码', issued.code)),
                        child: const Text('复制配对码', style: TextStyle(fontSize: 12)),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => unawaited(_copy('二维码内容', issued.qrPayload)),
                        child: const Text('复制二维码内容', style: TextStyle(fontSize: 12)),
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton.icon(
                    onPressed: _loading ? null : () => unawaited(_issue()),
                    icon: const Icon(PhosphorIconsLight.arrowClockwise, size: 15),
                    label: const Text('重新生成', style: TextStyle(fontSize: 12.5)),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
