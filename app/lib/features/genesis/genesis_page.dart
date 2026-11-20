import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// Ring 1 初生引导页：支持中性开局（留空名字）或直接定名，并一步配置 BYOK 模型凭证。
class GenesisPage extends StatefulWidget {
  const GenesisPage({
    super.key,
    required this.controller,
  });

  final AppController controller;

  @override
  State<GenesisPage> createState() => _GenesisPageState();
}

class _GenesisPageState extends State<GenesisPage> {
  final _residentNameController = TextEditingController();
  final _userNameController = TextEditingController();
  final _timezoneController = TextEditingController(text: 'Asia/Shanghai');
  final _sleepStartController = TextEditingController(text: '23:30');
  final _sleepEndController = TextEditingController(text: '07:30');
  final _modelController = TextEditingController();
  final _apiKeyController = TextEditingController();
  String _providerKind = 'openai';
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _residentNameController.dispose();
    _userNameController.dispose();
    _timezoneController.dispose();
    _sleepStartController.dispose();
    _sleepEndController.dispose();
    _modelController.dispose();
    _apiKeyController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.controller.completeGenesis(
        residentName: _residentNameController.text.trim(),
        userName: _userNameController.text.trim(),
        timezone: _timezoneController.text.trim().isEmpty
            ? 'Asia/Shanghai'
            : _timezoneController.text.trim(),
        sleepStart: _sleepStartController.text.trim(),
        sleepEnd: _sleepEndController.text.trim(),
        providerKind: _modelController.text.trim().isEmpty ? null : _providerKind,
        modelName: _modelController.text.trim(),
        apiKey: _apiKeyController.text.trim(),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = '初始化失败，请稍后重试');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
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
                      '初次见面（Genesis）',
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '名字可留空，进入聊天后再慢慢认识与取名',
                      style: TextStyle(fontSize: 13, color: PsyberTheme.inkMuted),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      key: const Key('genesis_resident_name'),
                      controller: _residentNameController,
                      decoration: const InputDecoration(
                        labelText: '住户名字（可选，留空为中性初生）',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('genesis_user_name'),
                      controller: _userNameController,
                      decoration: const InputDecoration(
                        labelText: '希望对方怎么称呼你（可选）',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _sleepStartController,
                            decoration: const InputDecoration(
                              labelText: '睡眠开始',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: TextField(
                            controller: _sleepEndController,
                            decoration: const InputDecoration(
                              labelText: '睡眠结束',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _providerKind,
                      decoration: const InputDecoration(
                        labelText: '模型服务商（BYOK 可选）',
                        border: OutlineInputBorder(),
                      ),
                      items: const [
                        DropdownMenuItem(value: 'openai', child: Text('OpenAI')),
                        DropdownMenuItem(value: 'anthropic', child: Text('Anthropic')),
                        DropdownMenuItem(value: 'google', child: Text('Google')),
                      ],
                      onChanged: (v) {
                        if (v != null) setState(() => _providerKind = v);
                      },
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('genesis_model_field'),
                      controller: _modelController,
                      decoration: const InputDecoration(
                        labelText: '主对话模型 ID（可选，如 gpt-4o）',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('genesis_apikey_field'),
                      controller: _apiKeyController,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: 'API Key（可选，直落 0600 凭证文件）',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 10),
                      Text(_error!, style: const TextStyle(color: Color(0xFFB34A3C), fontSize: 13)),
                    ],
                    const SizedBox(height: 18),
                    FilledButton(
                      key: const Key('genesis_submit_button'),
                      onPressed: _submitting ? null : _submit,
                      child: _submitting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('进入房间'),
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
