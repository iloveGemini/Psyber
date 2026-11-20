import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// Ring 1 单地址配对页：输入服务端地址与 8 位一次性配对码即可绑定长期令牌。
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
  final _deviceNameController = TextEditingController(text: _resolvePlatformInfo().name);
  bool _submitting = false;
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
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 400),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Card(
              color: PsyberTheme.paperCard,
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
                side: const BorderSide(color: PsyberTheme.hairline),
              ),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Psyber',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w600,
                        color: PsyberTheme.inkPrimary,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '输入后端地址与终端打印的一次性配对码完成绑定',
                      style: TextStyle(color: PsyberTheme.inkMuted, fontSize: 13),
                    ),
                    const SizedBox(height: 20),
                    TextField(
                      key: const Key('pair_url_field'),
                      controller: _urlController,
                      decoration: const InputDecoration(
                        labelText: '服务端地址',
                        hintText: 'http://localhost:3721',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('pair_code_field'),
                      controller: _codeController,
                      textCapitalization: TextCapitalization.characters,
                      decoration: const InputDecoration(
                        labelText: '一次性配对码',
                        hintText: '例如 ABCD-1234',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('pair_device_field'),
                      controller: _deviceNameController,
                      decoration: const InputDecoration(
                        labelText: '当前设备名称',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    if (_errorText != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        _errorText!,
                        key: const Key('pair_error_text'),
                        style: const TextStyle(color: Color(0xFFB34A3C), fontSize: 13),
                      ),
                    ],
                    const SizedBox(height: 18),
                    FilledButton(
                      key: const Key('pair_submit_button'),
                      onPressed: _submitting ? null : _submit,
                      child: _submitting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('配对并连接'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
