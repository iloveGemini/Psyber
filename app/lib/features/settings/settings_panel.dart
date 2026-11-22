import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/media/image_picker.dart';
import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/notifications/local_notifier.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// 设置分组：将原本平铺的 7 个长分区收拢为 4 个低频配置中心。
enum SettingsSection {
  modelUsage,
  rhythmNotify,
  appearance,
  toolsDevices,
}

extension SettingsSectionMeta on SettingsSection {
  String get title => switch (this) {
        SettingsSection.modelUsage => '模型与用量',
        SettingsSection.rhythmNotify => '作息与通知',
        SettingsSection.appearance => '居所与外观',
        SettingsSection.toolsDevices => '工具与设备',
      };

  IconData get icon => switch (this) {
        SettingsSection.modelUsage => PhosphorIconsLight.cpu,
        SettingsSection.rhythmNotify => PhosphorIconsLight.moonStars,
        SettingsSection.appearance => PhosphorIconsLight.palette,
        SettingsSection.toolsDevices => PhosphorIconsLight.plugsConnected,
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
      case SettingsSection.modelUsage:
        final slot = snap?.chatSlot;
        if (slot != null && slot.model.isNotEmpty) {
          return '${slot.provider} · ${slot.model}';
        }
        return '尚未配置主对话模型';
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
        final devCount = snap?.devices.length ?? 0;
        final mcpCount = snap?.mcpServers.length ?? 0;
        return '$devCount 台已配对设备 · $mcpCount 个 MCP 扩展';
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
  final _baseUrlCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();

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

  bool _editingModelInline = false;
  String _providerKind = 'openai-compat';
  bool _hasExistingKey = false;
  bool _savingModel = false;
  String? _modelErrText;

  bool _testingLlm = false;
  String? _llmTestHint;
  bool _llmTestOk = true;
  bool _loadingUsage = false;
  UsageStatsSnapshot? _usageStats;
  String? _usageError;
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
      _hydrateModelFields(snap);
      _hydrated = true;
    } else if (!_editingModelInline) {
      _hasBarkKey = snap.hasBarkKey;
      _hasNtfyToken = snap.hasNtfyToken;
      _hydrateModelFields(snap);
    }
    if (mounted) setState(() {});
  }

  void _hydrateModelFields(SettingsSnapshot snap) {
    final slot = snap.chatSlot;
    final currentProvider = slot != null ? snap.providers[slot.provider] : null;
    _providerKind = currentProvider?.kind ?? 'openai-compat';
    _hasExistingKey = currentProvider?.authStatus == 'configured';
    _baseUrlCtrl.text = currentProvider?.baseUrl ?? '';
    _modelCtrl.text = slot?.model ?? '';
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
    _baseUrlCtrl.dispose();
    _modelCtrl.dispose();
    _apiKeyCtrl.dispose();
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

  Future<void> _saveModelInline() async {
    final model = _modelCtrl.text.trim();
    final baseUrl = _baseUrlCtrl.text.trim();
    if (model.isEmpty) {
      setState(() => _modelErrText = '请填写模型 ID');
      return;
    }
    if (_providerKind == 'openai-compat' && baseUrl.isEmpty) {
      setState(() => _modelErrText = '兼容接口请填写自定义 Base URL');
      return;
    }
    setState(() {
      _savingModel = true;
      _modelErrText = null;
    });
    try {
      await widget.controller.updateLlmSettings(
        providerKind: _providerKind,
        modelName: model,
        baseUrl: baseUrl.isEmpty ? null : baseUrl,
        apiKey: _apiKeyCtrl.text.trim(),
      );
      if (!mounted) return;
      _apiKeyCtrl.clear();
      setState(() {
        _savingModel = false;
        _editingModelInline = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _modelErrText = e.message;
        _savingModel = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _modelErrText = '保存失败，请检查网络连接';
        _savingModel = false;
      });
    }
  }

  Future<void> _handleTestLlm(ModelSlotView? slot) async {
    if (slot == null || slot.provider.isEmpty || slot.model.isEmpty || _testingLlm) return;
    setState(() {
      _testingLlm = true;
      _llmTestHint = null;
    });
    try {
      final res = await widget.controller.testLlmModel(
        provider: slot.provider,
        model: slot.model,
      );
      if (!mounted || res == null) return;
      setState(() {
        _testingLlm = false;
        _llmTestOk = res.ok;
        _llmTestHint = res.ok ? '连通正常 · ${res.latencyMs} ms' : (res.error ?? '连通测试失败');
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _testingLlm = false;
        _llmTestOk = false;
        _llmTestHint = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _testingLlm = false;
        _llmTestOk = false;
        _llmTestHint = '连通测试失败，请检查网络';
      });
    }
  }

  Future<void> _handleLoadUsageStats() async {
    if (_loadingUsage) return;
    setState(() {
      _loadingUsage = true;
      _usageError = null;
    });
    try {
      final stats = await widget.controller.loadUsageStats();
      if (!mounted) return;
      setState(() {
        _usageStats = stats;
        _loadingUsage = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingUsage = false;
        _usageError = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadingUsage = false;
        _usageError = '暂时无法拉取消耗统计';
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

  Widget _buildModelUsageSection(BuildContext context, SettingsSnapshot? snap) {
    final colors = context.colors;
    final slot = snap?.chatSlot;
    final providerInfo = slot != null ? snap?.providers[slot.provider] : null;
    final configured = providerInfo?.authStatus == 'configured';

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const _SectionLabel('主对话模型与凭证'),
        _SurfaceBox(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              InkWell(
                key: const Key('open_model_config_tile'),
                onTap: () {
                  if (snap != null) _hydrateModelFields(snap);
                  setState(() {
                    _editingModelInline = !_editingModelInline;
                    _modelErrText = null;
                  });
                },
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              slot != null && slot.model.isNotEmpty
                                  ? '${slot.provider} · ${slot.model}'
                                  : '尚未设置主对话模型',
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              configured
                                  ? (_editingModelInline
                                      ? '正在编辑配置（保存后立即热生效）'
                                      : '凭证已配置（点击展开修改模型或 Key）')
                                  : '点击展开填写 API Key 与模型 ID',
                              style: TextStyle(
                                fontSize: 12,
                                color: configured
                                    ? colors.inkQuiet
                                    : colors.thresholdAmber,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (slot != null && slot.model.isNotEmpty)
                        TextButton(
                          key: const Key('test_llm_button'),
                          onPressed: _testingLlm
                              ? null
                              : () => unawaited(_handleTestLlm(slot)),
                          child: Text(
                            _testingLlm ? '测试中…' : '测连通',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                      Icon(
                        _editingModelInline
                            ? PhosphorIconsLight.caretUp
                            : PhosphorIconsLight.caretDown,
                        size: 16,
                        color: colors.inkQuiet,
                      ),
                    ],
                  ),
                ),
              ),
              if (_llmTestHint != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                  child: Text(
                    _llmTestHint!,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: _llmTestOk ? colors.statusSuccess : colors.dangerInk,
                    ),
                  ),
                ),
              if (_editingModelInline) ...[
                Divider(height: 1, color: colors.hairline),
                Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      DropdownButtonFormField<String>(
                        initialValue: _providerKind,
                        decoration: const InputDecoration(
                          labelText: '模型服务商',
                          isDense: true,
                        ),
                        items: const [
                          DropdownMenuItem(value: 'openai', child: Text('OpenAI')),
                          DropdownMenuItem(value: 'anthropic', child: Text('Anthropic')),
                          DropdownMenuItem(value: 'google', child: Text('Google')),
                          DropdownMenuItem(
                            value: 'openai-compat',
                            child: Text('OpenAI 兼容接口（自定义地址）'),
                          ),
                        ],
                        onChanged: (v) {
                          if (v != null) setState(() => _providerKind = v);
                        },
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _baseUrlCtrl,
                        style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                        decoration: const InputDecoration(
                          labelText: '接口地址 Base URL（兼容接口必填）',
                          hintText: 'https://api.example.com/v1',
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _modelCtrl,
                        style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                        decoration: const InputDecoration(
                          labelText: '主对话模型 ID',
                          hintText: 'gpt-4o / deepseek-chat',
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _apiKeyCtrl,
                        obscureText: true,
                        style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                        decoration: InputDecoration(
                          labelText: _hasExistingKey
                              ? 'API Key（留空保持现有密钥不变）'
                              : 'API Key（必填）',
                          isDense: true,
                        ),
                      ),
                      if (_modelErrText != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          _modelErrText!,
                          style: TextStyle(color: colors.dangerInk, fontSize: 12),
                        ),
                      ],
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: _savingModel
                                ? null
                                : () => setState(() => _editingModelInline = false),
                            child: const Text('取消'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: _savingModel
                                ? null
                                : () => unawaited(_saveModelInline()),
                            child: Text(_savingModel ? '保存中…' : '保存模型配置'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
              Divider(height: 1, color: colors.hairline),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          '默认思考深度档位',
                          style: TextStyle(fontSize: 12, color: colors.inkQuiet),
                        ),
                        const Spacer(),
                        Text(
                          '也可在聊天输入栏随时切换',
                          style: TextStyle(fontSize: 11, color: colors.inkFaint),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        for (final entry in const [
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
                                    color: (snap?.thinkingLevel ?? 'medium') == entry.$1
                                        ? colors.accentSoft
                                        : colors.mineralCanvas,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: (snap?.thinkingLevel ?? 'medium') == entry.$1
                                          ? colors.accentBorder
                                          : colors.hairline,
                                    ),
                                  ),
                                  child: Text(
                                    entry.$2,
                                    style: TextStyle(
                                      fontSize: 11.5,
                                      fontWeight:
                                          (snap?.thinkingLevel ?? 'medium') == entry.$1
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
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        const _SectionLabel('消耗统计'),
        _buildUsageStatsCard(context),
      ],
    );
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

  Widget _buildUsageStatsCard(BuildContext context) {
    final colors = context.colors;
    final stats = _usageStats;
    String fmtUsd(double v) => '\$${v.toStringAsFixed(4)}';
    String fmtPct(double r) => '${(r * 100).toStringAsFixed(1)}%';

    return _SurfaceBox(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          key: const Key('usage_stats_section'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(
                  'Token 与费用统计',
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w500,
                    color: colors.inkDeep,
                  ),
                ),
                const Spacer(),
                TextButton(
                  key: const Key('load_usage_stats_button'),
                  onPressed:
                      _loadingUsage ? null : () => unawaited(_handleLoadUsageStats()),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(
                    _loadingUsage ? '拉取中…' : (stats == null ? '查看统计' : '刷新'),
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              ],
            ),
            if (_usageError != null) ...[
              const SizedBox(height: 6),
              Text(_usageError!, style: TextStyle(fontSize: 12, color: colors.dangerInk)),
            ] else if (stats == null) ...[
              const SizedBox(height: 4),
              Text(
                '按需拉取今日/累计消耗与 Prompt Cache 命中率，不常驻主聊天面。',
                style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
              ),
            ] else ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: _UsageMetricTile(
                      label: '今日费用',
                      value: fmtUsd(stats.today.estimatedCostUsd),
                      sub: '${stats.today.turnCount} 轮 · 命中 ${fmtPct(stats.today.cacheHitRate)}',
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _UsageMetricTile(
                      label: '累计费用',
                      value: fmtUsd(stats.total.estimatedCostUsd),
                      sub: '${stats.total.turnCount} 轮 · 命中 ${fmtPct(stats.total.cacheHitRate)}',
                    ),
                  ),
                ],
              ),
              if (stats.byModel.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text('按模型', style: TextStyle(fontSize: 11, color: colors.inkQuiet)),
                const SizedBox(height: 4),
                for (final m in stats.byModel.take(4))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            m.model,
                            style: PsyberTheme.monoStyle.copyWith(
                              fontSize: 11.5,
                              color: colors.inkDeep,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Text(
                          '${m.bucket.turnCount} 轮 · ${fmtUsd(m.bucket.estimatedCostUsd)}',
                          style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                        ),
                      ],
                    ),
                  ),
              ],
            ],
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
          case SettingsSection.modelUsage:
            return _buildModelUsageSection(context, snap);
          case SettingsSection.rhythmNotify:
            return _buildRhythmNotifySection(context);
          case SettingsSection.appearance:
            return _buildAppearanceSection(context);
          case SettingsSection.toolsDevices:
            return _buildToolsDevicesSection(context, snap);
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
