import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// 配对入口页：连接常驻在后台的住户服务，支持终端一次性配对码绑定长期令牌。
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
  bool _showHelp = false;
  String? _errorText;

  static ({String name, String wire}) _resolvePlatformInfo() {
    if (kIsWeb) return (name: 'Web Browser', wire: 'web');
    if (Platform.isMacOS) return (name: 'Mac', wire: 'macos');
    if (Platform.isIOS) return (name: 'iPhone', wire: 'ios');
    if (Platform.isAndroid) return (name: 'Android', wire: 'android');
    if (Platform.isWindows) return (name: 'Windows', wire: 'windows');
    return (name: 'Desktop', wire: 'macos');
  }

  @override
  void dispose() {
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

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
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
                  const Text(
                    '连接到常驻在后台的住户空间，窗口只是推开那扇门的地方。',
                    style: TextStyle(fontSize: 13.5, color: PsyberTheme.inkQuiet, height: 1.5),
                  ),
                  const SizedBox(height: 20),
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: PsyberTheme.letterSurface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: PsyberTheme.hairline),
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
                              color: PsyberTheme.dangerSoft,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(
                              _errorText!,
                              key: const Key('pair_error_text'),
                              style: const TextStyle(
                                color: PsyberTheme.dangerInk,
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
                            color: PsyberTheme.inkQuiet,
                          ),
                          const SizedBox(width: 6),
                          const Text(
                            '如何获取配对码？',
                            style: TextStyle(fontSize: 12.5, color: PsyberTheme.inkQuiet),
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
                        color: PsyberTheme.letterSurface,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: PsyberTheme.hairline),
                      ),
                      child: const Text(
                        '在运行后端的终端输入 p 并回车，或另开终端执行 bun run pair，即可生成 5 分钟内有效的一次性配对码。',
                        style: TextStyle(fontSize: 12.5, color: PsyberTheme.inkQuiet, height: 1.5),
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
