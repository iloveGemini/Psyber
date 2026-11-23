import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/network/api_client.dart';
import '../../core/network/lan_discovery.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// 配对入口页：支持本机桌面端免码连入、局域网自动发现、扫码配对与手动输入一次性配对码。
class PairingPage extends StatefulWidget {
  const PairingPage({
    super.key,
    required this.controller,
  });

  final AppController controller;

  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  final _urlController = TextEditingController(text: 'http://localhost:3721');
  final _codeController = TextEditingController();
  final _deviceNameController =
      TextEditingController(text: _resolvePlatformInfo().name);
  bool _submitting = false;
  bool _scanningLan = false;
  bool _showHelp = false;
  String? _errorText;
  LocalPairHint? _localHint;
  List<DiscoveredServer> _discovered = const <DiscoveredServer>[];

  static ({String name, String wire}) _resolvePlatformInfo() {
    if (kIsWeb) return (name: 'Web Browser', wire: 'web');
    if (Platform.isMacOS) return (name: 'Mac', wire: 'macos');
    if (Platform.isIOS) return (name: 'iPhone', wire: 'ios');
    if (Platform.isAndroid) return (name: 'Android', wire: 'android');
    if (Platform.isWindows) return (name: 'Windows', wire: 'windows');
    return (name: 'Desktop', wire: 'macos');
  }

  @override
  void initState() {
    super.initState();
    _urlController.addListener(_onUrlChanged);
    unawaited(_loadLocalHint());
    unawaited(_scanLan());
  }

  void _onUrlChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _loadLocalHint() async {
    final hint = await widget.controller.loadLocalDesktopPairHint();
    if (!mounted || hint == null) return;
    setState(() {
      _localHint = hint;
    });
  }

  Future<void> _scanLan() async {
    if (_scanningLan) return;
    setState(() => _scanningLan = true);
    try {
      final list = await widget.controller.discoverLanServers();
      if (!mounted) return;
      setState(() {
        _discovered = list;
        _scanningLan = false;
        if (list.isNotEmpty &&
            (_urlController.text.trim().isEmpty ||
                _urlController.text.trim() == 'http://localhost:3721') &&
            _localHint == null &&
            list.first.primaryUrl.isNotEmpty) {
          _urlController.text = list.first.primaryUrl;
        }
      });
    } catch (_) {
      if (mounted) setState(() => _scanningLan = false);
    }
  }

  @override
  void dispose() {
    _urlController.removeListener(_onUrlChanged);
    _urlController.dispose();
    _codeController.dispose();
    _deviceNameController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final baseUrl = _urlController.text.trim();
    final code = _codeController.text.trim();
    final platformInfo = _resolvePlatformInfo();
    final deviceName = _deviceNameController.text.trim().isEmpty
        ? platformInfo.name
        : _deviceNameController.text.trim();

    if (baseUrl.isEmpty || code.isEmpty) {
      setState(() {
        _errorText = '请填写后端地址与 8 位一次性配对码';
      });
      return;
    }

    setState(() {
      _submitting = true;
      _errorText = null;
    });

    try {
      await widget.controller.pairAndConnect(
        baseUrl: baseUrl,
        code: code,
        deviceName: deviceName,
        platform: platformInfo.wire,
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _errorText = e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _errorText = '无法连接到服务端，请确认地址正确且服务已启动';
      });
    } finally {
      if (mounted) {
        setState(() {
          _submitting = false;
        });
      }
    }
  }

  Future<void> _submitLocalPair() async {
    final hint = _localHint;
    if (hint == null || _submitting) return;
    final platformInfo = _resolvePlatformInfo();
    final deviceName = _deviceNameController.text.trim().isEmpty
        ? platformInfo.name
        : _deviceNameController.text.trim();

    setState(() {
      _submitting = true;
      _errorText = null;
    });
    try {
      await widget.controller.localPairAndConnect(
        baseUrl: hint.baseUrl,
        secret: hint.secret,
        deviceName: deviceName,
        platform: platformInfo.wire,
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _errorText = e.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _errorText = '无法连接本机服务端，请确认服务已启动或改用配对码');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleScanOrImportQr() async {
    if (_submitting) return;
    String? rawPayload;
    if (QrScannerChannel.isCameraSupported) {
      rawPayload = await QrScannerChannel.scan();
      if (!mounted) return;
    }
    rawPayload ??= await _showPasteQrDialog();
    if (!mounted || rawPayload == null || rawPayload.trim().isEmpty) return;

    final parsed = parsePairQrPayload(rawPayload);
    if (parsed == null) {
      setState(() => _errorText = '未识别到有效的 Psyber 配对二维码内容');
      return;
    }
    _urlController.text = parsed.urls.first;
    _codeController.text = parsed.code;

    final platformInfo = _resolvePlatformInfo();
    final deviceName = _deviceNameController.text.trim().isEmpty
        ? platformInfo.name
        : _deviceNameController.text.trim();
    setState(() {
      _submitting = true;
      _errorText = null;
    });
    try {
      await widget.controller.pairFromQrPayload(
        rawPayload: rawPayload,
        deviceName: deviceName,
        platform: platformInfo.wire,
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _errorText = e.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _errorText = '扫码配对连接失败，请确认与服务端在同一局域网');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<String?> _showPasteQrDialog() {
    return showDialog<String>(
      context: context,
      builder: (_) => const _PasteQrPayloadDialog(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final showPlainHttpNotice = isNonLoopbackPlainHttp(_urlController.text);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: colors.statusSuccess,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Text(
                        'Psyber',
                        style: PsyberTheme.editorialSerif.copyWith(
                          fontSize: 28,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.4,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '连接到常驻在后台的 Psyber 空间，窗口只是推开那扇门的地方。',
                    style: TextStyle(fontSize: 13.5, color: colors.inkQuiet, height: 1.5),
                  ),
                  if (_localHint != null) ...[
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: colors.accentSoft,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: colors.accentBorder),
                      ),
                      child: Row(
                        children: [
                          Icon(PhosphorIconsLight.laptop, size: 18, color: colors.inkDeep),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '检测到本机 Psyber 服务',
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: colors.inkDeep,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _localHint!.baseUrl,
                                  style: PsyberTheme.monoStyle.copyWith(
                                    fontSize: 11.5,
                                    color: colors.inkQuiet,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            key: const Key('local_pair_button'),
                            onPressed: _submitting ? null : () => unawaited(_submitLocalPair()),
                            style: FilledButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                            ),
                            child: const Text('本机免码连接', style: TextStyle(fontSize: 12.5)),
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: colors.letterSurface,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: colors.hairline),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Icon(PhosphorIconsLight.wifiHigh, size: 15, color: colors.inkQuiet),
                            const SizedBox(width: 6),
                            Text(
                              '局域网自动发现',
                              style: TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w600,
                                color: colors.inkDeep,
                              ),
                            ),
                            const Spacer(),
                            InkWell(
                              key: const Key('lan_discover_refresh_button'),
                              borderRadius: BorderRadius.circular(6),
                              onTap: _scanningLan ? null : () => unawaited(_scanLan()),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                                child: Text(
                                  _scanningLan ? '扫描中…' : '刷新扫描',
                                  style: TextStyle(fontSize: 11.5, color: colors.accent),
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        if (_discovered.isEmpty)
                          Text(
                            _scanningLan
                                ? '正在局域网内寻找 Psyber 服务…'
                                : '未发现局域网实例，可扫码配对或手动填写地址。',
                            style: TextStyle(fontSize: 12, color: colors.inkQuiet),
                          )
                        else
                          Wrap(
                            spacing: 6,
                            runSpacing: 6,
                            children: [
                              for (final s in _discovered)
                                InkWell(
                                  key: Key('discovered_server_${s.instanceId}'),
                                  borderRadius: BorderRadius.circular(10),
                                  onTap: () {
                                    if (s.primaryUrl.isNotEmpty) {
                                      setState(() {
                                        _urlController.text = s.primaryUrl;
                                      });
                                    }
                                  },
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 7,
                                    ),
                                    decoration: BoxDecoration(
                                      color: _urlController.text.trim() == s.primaryUrl
                                          ? colors.accentSoft
                                          : colors.mineralCanvas,
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(
                                        color: _urlController.text.trim() == s.primaryUrl
                                            ? colors.accentBorder
                                            : colors.hairline,
                                      ),
                                    ),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Text(
                                          s.displayLabel,
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                            color: colors.inkDeep,
                                          ),
                                        ),
                                        Text(
                                          s.primaryUrl,
                                          style: PsyberTheme.monoStyle.copyWith(
                                            fontSize: 11,
                                            color: colors.inkQuiet,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: colors.letterSurface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: colors.hairline),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        TextField(
                          key: const Key('pair_url_field'),
                          controller: _urlController,
                          style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                          decoration: const InputDecoration(
                            labelText: '服务端地址',
                            hintText: 'http://localhost:3721',
                          ),
                        ),
                        if (showPlainHttpNotice) ...[
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              Icon(
                                PhosphorIconsLight.shieldWarning,
                                size: 13.5,
                                color: colors.inkQuiet,
                              ),
                              const SizedBox(width: 5),
                              Expanded(
                                child: Text(
                                  '局域网明文 HTTP 连接，请仅在可信 Wi-Fi 或 Tailscale 下配对。',
                                  style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                                ),
                              ),
                            ],
                          ),
                        ],
                        const SizedBox(height: 14),
                        TextField(
                          key: const Key('pair_code_field'),
                          controller: _codeController,
                          textCapitalization: TextCapitalization.characters,
                          style: PsyberTheme.monoStyle.copyWith(
                            fontSize: 16,
                            letterSpacing: 1.6,
                            fontWeight: FontWeight.w600,
                          ),
                          decoration: const InputDecoration(
                            labelText: '一次性配对码',
                            hintText: 'ABCD-1234',
                          ),
                        ),
                        const SizedBox(height: 14),
                        TextField(
                          key: const Key('pair_device_field'),
                          controller: _deviceNameController,
                          decoration: const InputDecoration(
                            labelText: '当前设备名称',
                          ),
                        ),
                        if (_errorText != null) ...[
                          const SizedBox(height: 14),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                            decoration: BoxDecoration(
                              color: colors.dangerSoft,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(
                              _errorText!,
                              key: const Key('pair_error_text'),
                              style: TextStyle(
                                color: colors.dangerInk,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ],
                        const SizedBox(height: 20),
                        FilledButton(
                          key: const Key('pair_submit_button'),
                          onPressed: _submitting ? null : _submit,
                          child: _submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Text('配对并连接'),
                        ),
                        const SizedBox(height: 10),
                        OutlinedButton.icon(
                          key: const Key('scan_qr_pair_button'),
                          onPressed:
                              _submitting ? null : () => unawaited(_handleScanOrImportQr()),
                          icon: const Icon(PhosphorIconsLight.qrCode, size: 16),
                          label: Text(
                            QrScannerChannel.isCameraSupported ? '扫码配对' : '扫码 / 粘贴二维码内容',
                            style: const TextStyle(fontSize: 13),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  InkWell(
                    borderRadius: BorderRadius.circular(10),
                    onTap: () => setState(() => _showHelp = !_showHelp),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                      child: Row(
                        children: [
                          Icon(
                            _showHelp ? PhosphorIconsLight.caretUp : PhosphorIconsLight.question,
                            size: 15,
                            color: colors.inkQuiet,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            '如何获取配对码或二维码？',
                            style: TextStyle(fontSize: 12.5, color: colors.inkQuiet),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (_showHelp)
                    Container(
                      margin: const EdgeInsets.only(top: 4),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: colors.letterSurface,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: colors.hairline),
                      ),
                      child: Text(
                        '在运行后端的终端输入 p 回车（自动打印配对码与二维码），或在已连接的桌面端「设置 → 工具与设备 → 配对新设备」展示二维码。',
                        style: TextStyle(fontSize: 12.5, color: colors.inkQuiet, height: 1.5),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PasteQrPayloadDialog extends StatefulWidget {
  const _PasteQrPayloadDialog();

  @override
  State<_PasteQrPayloadDialog> createState() => _PasteQrPayloadDialogState();
}

class _PasteQrPayloadDialogState extends State<_PasteQrPayloadDialog> {
  final _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
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
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '粘贴配对二维码内容',
                style: TextStyle(
                  fontSize: 15.5,
                  fontWeight: FontWeight.w600,
                  color: colors.inkDeep,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '粘贴桌面端复制的二维码 JSON 内容，将自动解析地址与一次性配对码并连接。',
                style: TextStyle(fontSize: 12, color: colors.inkQuiet),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('qr_payload_input_field'),
                controller: _ctrl,
                maxLines: 3,
                style: PsyberTheme.monoStyle.copyWith(fontSize: 12),
                decoration: const InputDecoration(
                  hintText: '{"v":1,"urls":["http://192.168.x.x:3721"],"code":"ABCD-1234"}',
                ),
              ),
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
                    key: const Key('qr_payload_confirm_button'),
                    onPressed: () => Navigator.of(context).pop(_ctrl.text.trim()),
                    child: const Text('解析并配对'),
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
