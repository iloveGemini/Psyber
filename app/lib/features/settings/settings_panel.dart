import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/media/image_picker.dart';
import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// 完整设置面板：
/// - 宽屏（>= 920px）嵌入右侧滑出栏，不遮挡主空间；
/// - 窄屏 / 移动端作为独立设置页推入，可自然返回；
/// - 接通 GET / PATCH /api/v1/settings（模型热切换、作息、通知、设备吊销）并保留贴纸管理。
class SettingsPanelContent extends StatefulWidget {
  const SettingsPanelContent({
    super.key,
    required this.controller,
    required this.onClose,
    this.imagePicker,
  });

  final AppController controller;
  final VoidCallback onClose;
  final ImageFilePicker? imagePicker;

  @override
  State<SettingsPanelContent> createState() => _SettingsPanelContentState();
}

class _SettingsPanelContentState extends State<SettingsPanelContent> {
  final _webhookUrlCtrl = TextEditingController();

  String _sleepStart = '23:30';
  String _sleepEnd = '07:30';
  bool _proactiveEnabled = true;
  bool _desktopNotifyEnabled = true;
  bool _webhookEnabled = false;
  bool _savingRhythm = false;
  String? _rhythmFeedback;
  String? _rhythmError;
  bool _hydrated = false;
  bool _dirty = false;
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
    unawaited(widget.controller.loadSettings());
  }

  void _onSettingsChanged() {
    if (!mounted) return;
    _syncFromSnapshot(widget.controller.settingsNotifier.value);
  }

  void _syncFromSnapshot(SettingsSnapshot? snap) {
    if (snap == null) return;
    if (!_hydrated || !_dirty) {
      _sleepStart = snap.circadian.sleepStart;
      _sleepEnd = snap.circadian.sleepEnd;
      _webhookUrlCtrl.text = snap.webhookUrl;
      _proactiveEnabled = snap.circadian.proactiveEnabled;
      _desktopNotifyEnabled = snap.desktopNotifyEnabled;
      _webhookEnabled = snap.webhookEnabled;
      _hydrated = true;
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.controller.settingsNotifier.removeListener(_onSettingsChanged);
    _webhookUrlCtrl.dispose();
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
      _dirty = true;
    });
  }

  Future<void> _saveCircadianAndNotifications() async {
    setState(() {
      _savingRhythm = true;
      _rhythmFeedback = null;
      _rhythmError = null;
    });
    try {
      final webhookUrl = _webhookUrlCtrl.text.trim();
      await widget.controller.patchSettings({
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
        },
      });
      if (!mounted) return;
      _dirty = false;
      setState(() {
        _savingRhythm = false;
        _rhythmFeedback = '已保存并即时生效';
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

  void _openModelConfigDialog() {
    final snap = widget.controller.settingsNotifier.value;
    unawaited(
      showDialog<void>(
        context: context,
        builder: (_) => _ModelConfigDialog(
          controller: widget.controller,
          settings: snap,
        ),
      ),
    );
  }

  void _openStickerUploadDialog() {
    unawaited(
      showDialog<void>(
        context: context,
        builder: (_) => _StickerUploadDialog(
          controller: widget.controller,
          imagePicker: widget.imagePicker,
        ),
      ),
    );
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
      setState(() {
        _uploadingAvatar = false;
        _avatarHint = who == 'resident' ? '住户头像已更新' : '我的头像已更新';
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

  Widget _buildMcpServersSection(BuildContext context, SettingsSnapshot? snap) {
    final colors = context.colors;
    final servers = snap?.mcpServers ?? const <McpServerView>[];
    return _SurfaceBox(
      child: Padding(
        key: const Key('mcp_servers_section'),
        padding: const EdgeInsets.all(12),
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
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
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
                      icon: Icon(PhosphorIconsLight.arrowClockwise, size: 16, color: colors.inkQuiet),
                      tooltip: '重连',
                      constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                      padding: EdgeInsets.zero,
                      onPressed: () => unawaited(widget.controller.reconnectMcpServer(servers[i].id)),
                    ),
                    IconButton(
                      key: Key('mcp_delete_${servers[i].id}'),
                      icon: Icon(PhosphorIconsLight.trash, size: 16, color: colors.dangerInk),
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

  Widget _buildThemeModeSelector(BuildContext context) {
    final colors = context.colors;
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: widget.controller.themeModeNotifier,
      builder: (context, currentMode, _) {
        return ValueListenableBuilder<PsyberPalette>(
          valueListenable: widget.controller.lightPaletteNotifier,
          builder: (context, lightPalette, _) {
            return ValueListenableBuilder<PsyberPalette>(
              valueListenable: widget.controller.darkPaletteNotifier,
              builder: (context, darkPalette, _) {
                return _SurfaceBox(
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: _ThemeChip(
                                key: const Key('theme_mode_system'),
                                label: '跟随系统',
                                icon: PhosphorIconsLight.circleHalf,
                                selected: currentMode == ThemeMode.system,
                                onTap: () => widget.controller.setThemeMode(ThemeMode.system),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: _ThemeChip(
                                key: const Key('theme_mode_light'),
                                label: '日间浅色',
                                icon: PhosphorIconsLight.sun,
                                selected: currentMode == ThemeMode.light,
                                onTap: () => widget.controller.setThemeMode(ThemeMode.light),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: _ThemeChip(
                                key: const Key('theme_mode_dark'),
                                label: '夜间深色',
                                icon: PhosphorIconsLight.moon,
                                selected: currentMode == ThemeMode.dark,
                                onTap: () => widget.controller.setThemeMode(ThemeMode.dark),
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
                                  final isSavedSlot = palette == lightPalette || palette == darkPalette;
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
                                    onTap: () => widget.controller.setPalette(palette),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
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
                    ),
                  ),
                );
              },
            );
          },
        );
      },
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
                  onPressed: _loadingUsage ? null : () => unawaited(_handleLoadUsageStats()),
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
    final colors = context.colors;
    final currentDeviceId = widget.controller.profileNotifier.value?.deviceId ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 50,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 10, 0),
            child: Row(
              children: [
                Text(
                  '偏好与设置',
                  style: PsyberTheme.editorialSerif.copyWith(
                    fontSize: 17,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const Spacer(),
                IconButton(
                  key: const Key('close_settings_button'),
                  icon: const Icon(PhosphorIconsLight.x, size: 19),
                  tooltip: '关闭设置',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: ValueListenableBuilder<SettingsSnapshot?>(
            valueListenable: widget.controller.settingsNotifier,
            builder: (context, snap, _) {
              final slot = snap?.chatSlot;
              final providerInfo =
                  slot != null ? snap?.providers[slot.provider] : null;
              final configured = providerInfo?.authStatus == 'configured';

              return ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  const _SectionLabel('模型与凭证'),
                  _SurfaceBox(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        InkWell(
                          key: const Key('open_model_config_tile'),
                          onTap: _openModelConfigDialog,
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
                                            ? '凭证已配置（点击热切换模型或 Key）'
                                            : '点击填写 API Key 与模型 ID',
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
                        const Divider(height: 1),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '思考深度档位',
                                style: TextStyle(fontSize: 12, color: colors.inkQuiet),
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
                  const SizedBox(height: 18),
                  const _SectionLabel('互动与评测'),
                  _SurfaceBox(
                    child: Column(
                      children: [
                        ValueListenableBuilder<bool>(
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
                                const Divider(height: 1),
                                _QuietSwitchTile(
                                  key: const Key('recall_eval_notice_switch'),
                                  title: '评测检视对住户透明',
                                  subtitle: '开启后如实告知住户当前处于召回评测检视中',
                                  value: snap?.recallEvalNoticeResident ?? false,
                                  onChanged: (v) => unawaited(
                                    widget.controller.patchSettings({
                                      'recallEvalNoticeResident': v,
                                    }),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                        const Divider(height: 1),
                        ListTile(
                          key: const Key('open_sticker_manager_entry'),
                          leading: Icon(
                            PhosphorIconsLight.smiley,
                            size: 19,
                            color: colors.inkQuiet,
                          ),
                          title: const Text('上传互发表情贴纸', style: TextStyle(fontSize: 14)),
                          subtitle: Text(
                            '支持 PNG / WebP / GIF 贴纸',
                            style: TextStyle(fontSize: 12, color: colors.inkQuiet),
                          ),
                          onTap: _openStickerUploadDialog,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  const _SectionLabel('作息节律与离线触达'),
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
                            contentPadding: const EdgeInsets.symmetric(vertical: 6),
                            title: '允许定时主动招呼',
                            subtitle: '静默时段不打扰，连续未回会自动安静',
                            value: _proactiveEnabled,
                            onChanged: (v) => setState(() {
                              _proactiveEnabled = v;
                              _dirty = true;
                            }),
                          ),
                          _QuietSwitchTile(
                            contentPadding: const EdgeInsets.symmetric(vertical: 6),
                            title: '本机桌面通知',
                            value: _desktopNotifyEnabled,
                            onChanged: (v) => setState(() {
                              _desktopNotifyEnabled = v;
                              _dirty = true;
                            }),
                          ),
                          _QuietSwitchTile(
                            contentPadding: const EdgeInsets.symmetric(vertical: 6),
                            title: 'Webhook 离线推送',
                            value: _webhookEnabled,
                            onChanged: (v) => setState(() {
                              _webhookEnabled = v;
                              _dirty = true;
                            }),
                          ),
                          if (_webhookEnabled || _webhookUrlCtrl.text.isNotEmpty) ...[
                            const SizedBox(height: 6),
                            TextField(
                              controller: _webhookUrlCtrl,
                              onChanged: (_) => _dirty = true,
                              style: PsyberTheme.monoStyle.copyWith(fontSize: 12.5),
                              decoration: const InputDecoration(
                                labelText: 'Webhook URL',
                                hintText: 'https://...',
                                isDense: true,
                              ),
                            ),
                          ],
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
                          const SizedBox(height: 10),
                          Align(
                            alignment: Alignment.centerRight,
                            child: FilledButton(
                              onPressed: _savingRhythm ? null : _saveCircadianAndNotifications,
                              style: FilledButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                              ),
                              child: Text(
                                _savingRhythm ? '保存中…' : '保存作息与通知',
                                style: const TextStyle(fontSize: 13),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  const _SectionLabel('已配对设备'),
                  _SurfaceBox(
                    child: Column(
                      children: [
                        if (snap != null && snap.devices.isNotEmpty) ...[
                          for (var i = 0; i < snap.devices.length; i++) ...[
                            if (i > 0) const Divider(height: 1),
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
                          const Divider(height: 1),
                        ],
                        ListTile(
                          key: const Key('disconnect_device_button'),
                          leading: Icon(PhosphorIconsLight.linkBreak, size: 18, color: colors.dangerInk),
                          title: Text(
                            '断开本机连接并重新配对',
                            style: TextStyle(fontSize: 13.5, color: colors.dangerInk),
                          ),
                          onTap: () async {
                            widget.onClose();
                            await widget.controller.disconnect();
                          },
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  const _SectionLabel('居所头像与外观'),
                  _SurfaceBox(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: OutlinedButton.icon(
                                  key: const Key('upload_resident_avatar_button'),
                                  onPressed: _uploadingAvatar
                                      ? null
                                      : () => unawaited(_handleUploadAvatar('resident')),
                                  icon: const Icon(PhosphorIconsLight.sparkle, size: 15),
                                  label: const Text('住户头像', style: TextStyle(fontSize: 12)),
                                ),
                              ),
                              const SizedBox(width: 8),
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
                            const SizedBox(height: 6),
                            Text(
                              _avatarHint!,
                              style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  _buildThemeModeSelector(context),
                  const SizedBox(height: 18),
                  const _SectionLabel('外部工具扩展（MCP）'),
                  _buildMcpServersSection(context, snap),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}

/// 窄屏/移动端使用的完整设置页路由。
class SettingsPage extends StatelessWidget {
  const SettingsPage({
    super.key,
    required this.controller,
    this.imagePicker,
  });

  final AppController controller;
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
          child: SettingsPanelContent(
            controller: controller,
            imagePicker: imagePicker,
            onClose: () => Navigator.of(context).pop(),
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

class _ModelConfigDialog extends StatefulWidget {
  const _ModelConfigDialog({
    required this.controller,
    required this.settings,
  });

  final AppController controller;
  final SettingsSnapshot? settings;

  @override
  State<_ModelConfigDialog> createState() => _ModelConfigDialogState();
}

class _ModelConfigDialogState extends State<_ModelConfigDialog> {
  late String _providerKind;
  late final TextEditingController _baseUrlCtrl;
  late final TextEditingController _modelCtrl;
  late final TextEditingController _apiKeyCtrl;
  String? _errText;
  bool _saving = false;
  bool _hasExistingKey = false;

  @override
  void initState() {
    super.initState();
    final snap = widget.settings;
    final slot = snap?.chatSlot;
    final currentProvider = slot != null ? snap?.providers[slot.provider] : null;
    _providerKind = currentProvider?.kind ?? 'openai-compat';
    _hasExistingKey = currentProvider?.authStatus == 'configured';
    _baseUrlCtrl = TextEditingController(text: currentProvider?.baseUrl ?? '');
    _modelCtrl = TextEditingController(text: slot?.model ?? '');
    _apiKeyCtrl = TextEditingController();
  }

  @override
  void dispose() {
    _baseUrlCtrl.dispose();
    _modelCtrl.dispose();
    _apiKeyCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final model = _modelCtrl.text.trim();
    final baseUrl = _baseUrlCtrl.text.trim();
    if (model.isEmpty) {
      setState(() => _errText = '请填写模型 ID');
      return;
    }
    if (_providerKind == 'openai-compat' && baseUrl.isEmpty) {
      setState(() => _errText = '兼容接口请填写自定义 Base URL');
      return;
    }
    setState(() {
      _saving = true;
      _errText = null;
    });
    try {
      await widget.controller.updateLlmSettings(
        providerKind: _providerKind,
        modelName: model,
        baseUrl: baseUrl.isEmpty ? null : baseUrl,
        apiKey: _apiKeyCtrl.text.trim(),
      );
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _errText = e.message;
        _saving = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _errText = '保存失败，请检查网络连接';
        _saving = false;
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
        constraints: const BoxConstraints(maxWidth: 440),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '配置模型与 API Key',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 6),
              Text(
                '保存后立即热生效，密钥仅写入服务端 0600 凭证文件。',
                style: TextStyle(fontSize: 12.5, color: colors.inkQuiet),
              ),
              const SizedBox(height: 14),
              DropdownButtonFormField<String>(
                initialValue: _providerKind,
                decoration: const InputDecoration(labelText: '模型服务商'),
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
              const SizedBox(height: 12),
              TextField(
                controller: _baseUrlCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                decoration: const InputDecoration(
                  labelText: '接口地址 Base URL（兼容接口必填）',
                  hintText: 'https://api.example.com/v1',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _modelCtrl,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                decoration: const InputDecoration(
                  labelText: '主对话模型 ID',
                  hintText: 'gpt-4o / deepseek-chat',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _apiKeyCtrl,
                obscureText: true,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                decoration: InputDecoration(
                  labelText: _hasExistingKey
                      ? 'API Key（留空保持现有密钥不变）'
                      : 'API Key（必填）',
                ),
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
                    onPressed: _saving ? null : () => Navigator.of(context).pop(),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _saving ? null : () => unawaited(_save()),
                    child: const Text('保存'),
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
