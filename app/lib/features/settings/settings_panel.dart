import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/media/image_picker.dart';
import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';
import 'drawer_modal.dart';

/// 完整设置面板：
/// - 宽屏（>= 920px）嵌入右侧滑出栏，不遮挡主空间；
/// - 窄屏 / 移动端作为独立设置页推入，可自然返回；
/// - 接通 GET / PATCH /api/v1/settings（模型热切换、作息、通知、设备吊销）并预留 Ring 1.5 抽屉与贴纸管理槽。
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
  final _sleepStartCtrl = TextEditingController(text: '23:30');
  final _sleepEndCtrl = TextEditingController(text: '07:30');
  final _webhookUrlCtrl = TextEditingController();

  bool _proactiveEnabled = true;
  bool _desktopNotifyEnabled = true;
  bool _webhookEnabled = false;
  bool _savingRhythm = false;
  String? _rhythmFeedback;
  String? _rhythmError;
  bool _hydrated = false;
  bool _dirty = false;

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
      _sleepStartCtrl.text = snap.circadian.sleepStart;
      _sleepEndCtrl.text = snap.circadian.sleepEnd;
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
    _sleepStartCtrl.dispose();
    _sleepEndCtrl.dispose();
    _webhookUrlCtrl.dispose();
    super.dispose();
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
          'sleepStart': _sleepStartCtrl.text.trim(),
          'sleepEnd': _sleepEndCtrl.text.trim(),
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
    final slot = snap?.chatSlot;
    final currentProvider = slot != null ? snap?.providers[slot.provider] : null;

    var providerKind = currentProvider?.kind ?? 'openai-compat';
    final baseUrlCtrl = TextEditingController(text: currentProvider?.baseUrl ?? '');
    final modelCtrl = TextEditingController(text: slot?.model ?? '');
    final apiKeyCtrl = TextEditingController();
    String? errText;
    var saving = false;

    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setDialogState) => Dialog(
            backgroundColor: PsyberTheme.letterSurface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: const BorderSide(color: PsyberTheme.hairline),
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
                    const Text(
                      '保存后立即热生效，密钥仅写入服务端 0600 凭证文件。',
                      style: TextStyle(fontSize: 12.5, color: PsyberTheme.inkQuiet),
                    ),
                    const SizedBox(height: 14),
                    DropdownButtonFormField<String>(
                      initialValue: providerKind,
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
                        if (v != null) setDialogState(() => providerKind = v);
                      },
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: baseUrlCtrl,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                      decoration: const InputDecoration(
                        labelText: '接口地址 Base URL（兼容接口必填）',
                        hintText: 'https://api.example.com/v1',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: modelCtrl,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                      decoration: const InputDecoration(
                        labelText: '主对话模型 ID',
                        hintText: 'gpt-4o / deepseek-chat',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: apiKeyCtrl,
                      obscureText: true,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                      decoration: InputDecoration(
                        labelText: currentProvider?.authStatus == 'configured'
                            ? 'API Key（留空保持现有密钥不变）'
                            : 'API Key（必填）',
                      ),
                    ),
                    if (errText != null) ...[
                      const SizedBox(height: 10),
                      Text(
                        errText!,
                        style: const TextStyle(color: PsyberTheme.dangerInk, fontSize: 12.5),
                      ),
                    ],
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                          child: const Text('取消'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: saving
                              ? null
                              : () async {
                                  final model = modelCtrl.text.trim();
                                  final baseUrl = baseUrlCtrl.text.trim();
                                  if (model.isEmpty) {
                                    setDialogState(() => errText = '请填写模型 ID');
                                    return;
                                  }
                                  if (providerKind == 'openai-compat' && baseUrl.isEmpty) {
                                    setDialogState(() => errText = '兼容接口请填写自定义 Base URL');
                                    return;
                                  }
                                  setDialogState(() {
                                    saving = true;
                                    errText = null;
                                  });
                                  try {
                                    await widget.controller.updateLlmSettings(
                                      providerKind: providerKind,
                                      modelName: model,
                                      baseUrl: baseUrl.isEmpty ? null : baseUrl,
                                      apiKey: apiKeyCtrl.text.trim(),
                                    );
                                    if (ctx.mounted) Navigator.of(ctx).pop();
                                  } on ApiException catch (e) {
                                    setDialogState(() {
                                      errText = e.message;
                                      saving = false;
                                    });
                                  } catch (_) {
                                    setDialogState(() {
                                      errText = '保存失败，请检查网络连接';
                                      saving = false;
                                    });
                                  }
                                },
                          child: const Text('保存'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ).whenComplete(() {
        baseUrlCtrl.dispose();
        modelCtrl.dispose();
        apiKeyCtrl.dispose();
      }),
    );
  }

  void _openStickerUploadDialog() {
    final idCtrl = TextEditingController();
    final labelCtrl = TextEditingController();
    final packCtrl = TextEditingController(text: 'default');
    PickedImage? pickedImage;
    String? errText;
    var uploading = false;

    unawaited(
      showDialog<void>(
        context: context,
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setDialogState) => Dialog(
            backgroundColor: PsyberTheme.letterSurface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: const BorderSide(color: PsyberTheme.hairline),
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
                      '上传表情贴纸（Ring 1.5）',
                      style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '支持 PNG / WebP / GIF（≤ 2 MB）。Ring 1 服务端可将图片放入数据目录 stickers/ 文件夹。',
                      style: TextStyle(fontSize: 12.5, color: PsyberTheme.inkQuiet, height: 1.45),
                    ),
                    const SizedBox(height: 14),
                    OutlinedButton.icon(
                      onPressed: uploading
                          ? null
                          : () async {
                              final picker = widget.imagePicker ?? defaultPlatformImagePicker;
                              final res = await picker();
                              if (res != null) {
                                setDialogState(() => pickedImage = res);
                              }
                            },
                      icon: const Icon(Icons.image_outlined, size: 17),
                      label: Text(pickedImage == null ? '选择贴纸图片' : pickedImage!.filename),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: idCtrl,
                      style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                      decoration: const InputDecoration(
                        labelText: '贴纸 ID',
                        hintText: '例如 cat-nod（小写字母/数字/-）',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: labelCtrl,
                      decoration: const InputDecoration(
                        labelText: '贴纸语义说明（≤ 20 字）',
                        hintText: '例如 轻轻点头',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: packCtrl,
                      decoration: const InputDecoration(labelText: '分组名（可选）'),
                    ),
                    if (errText != null) ...[
                      const SizedBox(height: 10),
                      Text(
                        errText!,
                        style: const TextStyle(color: PsyberTheme.dangerInk, fontSize: 12.5),
                      ),
                    ],
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: uploading ? null : () => Navigator.of(ctx).pop(),
                          child: const Text('取消'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: uploading
                              ? null
                              : () async {
                                  final id = idCtrl.text.trim();
                                  final label = labelCtrl.text.trim();
                                  if (pickedImage == null || id.isEmpty || label.isEmpty) {
                                    setDialogState(() => errText = '请选择图片并填写 ID 与语义说明');
                                    return;
                                  }
                                  setDialogState(() {
                                    uploading = true;
                                    errText = null;
                                  });
                                  try {
                                    await widget.controller.uploadSticker(
                                      bytes: pickedImage!.bytes,
                                      filename: pickedImage!.filename,
                                      mimeType: pickedImage!.mimeType,
                                      id: id,
                                      label: label,
                                      pack: packCtrl.text.trim().isEmpty
                                          ? 'default'
                                          : packCtrl.text.trim(),
                                    );
                                    if (ctx.mounted) Navigator.of(ctx).pop();
                                  } on ApiException catch (e) {
                                    setDialogState(() {
                                      uploading = false;
                                      errText = e.isEndpointUnavailable
                                          ? '当前后端处于 Ring 1 模式，动态上传贴纸将在 Ring 1.5 开启'
                                          : e.message;
                                    });
                                  } catch (_) {
                                    setDialogState(() {
                                      uploading = false;
                                      errText = '上传失败，请稍后重试';
                                    });
                                  }
                                },
                          child: const Text('上传'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ).whenComplete(() {
        idCtrl.dispose();
        labelCtrl.dispose();
        packCtrl.dispose();
      }),
    );
  }

  Widget _buildThemeModeSelector(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: widget.controller.themeModeNotifier,
      builder: (context, currentMode, _) {
        return _SurfaceBox(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
            child: Row(
              children: [
                Expanded(
                  child: _ThemeChip(
                    key: const Key('theme_mode_system'),
                    label: '跟随系统',
                    icon: Icons.brightness_auto_outlined,
                    selected: currentMode == ThemeMode.system,
                    onTap: () => widget.controller.setThemeMode(ThemeMode.system),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _ThemeChip(
                    key: const Key('theme_mode_light'),
                    label: '暖纸浅色',
                    icon: Icons.light_mode_outlined,
                    selected: currentMode == ThemeMode.light,
                    onTap: () => widget.controller.setThemeMode(ThemeMode.light),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _ThemeChip(
                    key: const Key('theme_mode_dark'),
                    label: '曜夜深色',
                    icon: Icons.dark_mode_outlined,
                    selected: currentMode == ThemeMode.dark,
                    onTap: () => widget.controller.setThemeMode(ThemeMode.dark),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final currentDeviceId = widget.controller.profileNotifier.value?.deviceId ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 10, 12),
          child: Row(
            children: [
              Text(
                '房间与连接设置',
                style: PsyberTheme.editorialSerif.copyWith(
                  fontSize: 17.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              IconButton(
                key: const Key('close_settings_button'),
                icon: const Icon(Icons.close, size: 19),
                tooltip: '关闭设置',
                onPressed: widget.onClose,
              ),
            ],
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
                    child: InkWell(
                      key: const Key('open_model_config_tile'),
                      borderRadius: BorderRadius.circular(12),
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
                                    configured ? '凭证已配置（点击热切换模型或 Key）' : '点击填写 API Key 与模型 ID',
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
                            const Icon(Icons.chevron_right, size: 18, color: PsyberTheme.inkQuiet),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  const _SectionLabel('评测与空间扩展'),
                  _SurfaceBox(
                    child: Column(
                      children: [
                        ValueListenableBuilder<bool>(
                          valueListenable: widget.controller.recallEvalModeNotifier,
                          builder: (context, enabled, _) => SwitchListTile(
                            key: const Key('recall_eval_switch'),
                            contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
                            title: const Text('召回评测模式', style: TextStyle(fontSize: 14)),
                            subtitle: const Text(
                              '开启后在助手回复下展示「想起 N 张卡」标注入口',
                              style: TextStyle(fontSize: 12, color: PsyberTheme.inkQuiet),
                            ),
                            value: enabled,
                            onChanged: widget.controller.toggleRecallEvalMode,
                          ),
                        ),
                        const Divider(height: 1),
                        ListTile(
                          key: const Key('open_drawer_entry'),
                          leading: const Icon(
                            Icons.lock_outline,
                            size: 19,
                            color: PsyberTheme.thresholdAmber,
                          ),
                          title: const Text('上锁的抽屉', style: TextStyle(fontSize: 14)),
                          subtitle: const Text(
                            '私密日记（拆封必留痕告知对方 · Ring 1.5）',
                            style: TextStyle(fontSize: 12, color: PsyberTheme.inkQuiet),
                          ),
                          trailing: const Icon(Icons.chevron_right, size: 18),
                          onTap: () {
                            unawaited(
                              showDialog<void>(
                                context: context,
                                builder: (_) => DrawerModal(controller: widget.controller),
                              ),
                            );
                          },
                        ),
                        const Divider(height: 1),
                        ListTile(
                          key: const Key('open_sticker_manager_entry'),
                          leading: Icon(
                            Icons.add_reaction_outlined,
                            size: 19,
                            color: colors.inkQuiet,
                          ),
                          title: const Text('上传互发表情贴纸', style: TextStyle(fontSize: 14)),
                          subtitle: const Text(
                            '支持 PNG / WebP / GIF（Ring 1.5 动态贴纸库）',
                            style: TextStyle(fontSize: 12, color: PsyberTheme.inkQuiet),
                          ),
                          trailing: const Icon(Icons.chevron_right, size: 18),
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
                                child: TextField(
                                  controller: _sleepStartCtrl,
                                  onChanged: (_) => _dirty = true,
                                  style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                                  decoration: const InputDecoration(
                                    labelText: '夜间休息开始',
                                    isDense: true,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: TextField(
                                  controller: _sleepEndCtrl,
                                  onChanged: (_) => _dirty = true,
                                  style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                                  decoration: const InputDecoration(
                                    labelText: '早晨醒来',
                                    isDense: true,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          SwitchListTile(
                            contentPadding: EdgeInsets.zero,
                            dense: true,
                            title: const Text('允许定时主动招呼', style: TextStyle(fontSize: 13.5)),
                            subtitle: const Text(
                              '夜间静默窗内不会打扰，连续未回会自动退回安静',
                              style: TextStyle(fontSize: 11.5, color: PsyberTheme.inkQuiet),
                            ),
                            value: _proactiveEnabled,
                            onChanged: (v) => setState(() {
                              _proactiveEnabled = v;
                              _dirty = true;
                            }),
                          ),
                          SwitchListTile(
                            contentPadding: EdgeInsets.zero,
                            dense: true,
                            title: const Text('本机桌面通知', style: TextStyle(fontSize: 13.5)),
                            value: _desktopNotifyEnabled,
                            onChanged: (v) => setState(() {
                              _desktopNotifyEnabled = v;
                              _dirty = true;
                            }),
                          ),
                          SwitchListTile(
                            contentPadding: EdgeInsets.zero,
                            dense: true,
                            title: const Text('Webhook 离线推送', style: TextStyle(fontSize: 13.5)),
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
                              style: const TextStyle(color: PsyberTheme.dangerInk, fontSize: 12),
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
                                    ? Icons.smartphone_outlined
                                    : Icons.laptop_mac_outlined,
                                size: 18,
                                color: PsyberTheme.inkQuiet,
                              ),
                              title: Row(
                                children: [
                                  Flexible(
                                    child: Text(
                                      snap.devices[i].deviceName,
                                      style: const TextStyle(fontSize: 13.5),
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
                                style: const TextStyle(fontSize: 11.5, color: PsyberTheme.inkQuiet),
                              ),
                              trailing: snap.devices[i].deviceId == currentDeviceId
                                  ? null
                                  : TextButton(
                                      onPressed: () => unawaited(
                                        widget.controller
                                            .revokeOtherDevice(snap.devices[i].deviceId),
                                      ),
                                      child: const Text(
                                        '吊销',
                                        style: TextStyle(
                                          fontSize: 12,
                                          color: PsyberTheme.dangerInk,
                                        ),
                                      ),
                                    ),
                            ),
                          ],
                          const Divider(height: 1),
                        ],
                        ListTile(
                          key: const Key('disconnect_device_button'),
                          leading: const Icon(Icons.link_off, size: 18, color: PsyberTheme.dangerInk),
                          title: const Text(
                            '断开本机连接并重新配对',
                            style: TextStyle(fontSize: 13.5, color: PsyberTheme.dangerInk),
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
                  const _SectionLabel('外观主题'),
                  _buildThemeModeSelector(context),
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
    return Scaffold(
      backgroundColor: colors.mineralCanvas,
      body: SafeArea(
        child: SettingsPanelContent(
          controller: controller,
          imagePicker: imagePicker,
          onClose: () => Navigator.of(context).pop(),
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
