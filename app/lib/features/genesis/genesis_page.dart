import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';

import '../../core/network/api_client.dart';
import '../../core/state/app_controller.dart';
import '../../shared/theme.dart';

/// 初生引导页（Genesis）：
/// 分为「房间名牌」与「作息与模型连接」两段轻布局，支持中性空白开局与 BYOK 凭证一步落盘。
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
  final _baseUrlController = TextEditingController();
  final _modelController = TextEditingController();
  final _apiKeyController = TextEditingController();

  String _providerKind = 'openai';
  String _userPronoun = '';
  bool _showCustomBaseUrl = false;
  bool _obscureKey = true;
  bool _submitting = false;
  String? _error;

  static const _providers = [
    (
      id: 'openai',
      label: 'OpenAI',
      hintModel: 'gpt-4o',
      defaultUrl: 'https://api.openai.com/v1',
    ),
    (
      id: 'anthropic',
      label: 'Anthropic',
      hintModel: 'claude-sonnet-4-5',
      defaultUrl: 'https://api.anthropic.com',
    ),
    (
      id: 'google',
      label: 'Google',
      hintModel: 'gemini-2.5-flash',
      defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    ),
    (
      id: 'openai-compat',
      label: 'OpenAI 兼容',
      hintModel: 'deepseek-chat',
      defaultUrl: '',
    ),
  ];

  @override
  void dispose() {
    _residentNameController.dispose();
    _userNameController.dispose();
    _timezoneController.dispose();
    _sleepStartController.dispose();
    _sleepEndController.dispose();
    _baseUrlController.dispose();
    _modelController.dispose();
    _apiKeyController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final modelName = _modelController.text.trim();
    final baseUrl = _baseUrlController.text.trim();
    if (_providerKind == 'openai-compat' &&
        modelName.isNotEmpty &&
        baseUrl.isEmpty) {
      setState(() => _error = '使用 OpenAI 兼容接口时请填写自定义接口地址（Base URL）');
      return;
    }

    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.controller.completeGenesis(
        residentName: _residentNameController.text.trim(),
        userName: _userNameController.text.trim(),
        userPronoun: _userPronoun.isEmpty ? null : _userPronoun,
        timezone: _timezoneController.text.trim().isEmpty
            ? 'Asia/Shanghai'
            : _timezoneController.text.trim(),
        sleepStart: _sleepStartController.text.trim(),
        sleepEnd: _sleepEndController.text.trim(),
        providerKind: modelName.isEmpty ? null : _providerKind,
        baseUrl: baseUrl.isEmpty ? null : baseUrl,
        modelName: modelName,
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
    final colors = context.colors;
    final activeMeta = _providers.firstWhere(
      (p) => p.id == _providerKind,
      orElse: () => _providers.first,
    );
    final needBaseUrlField =
        _providerKind == 'openai-compat' || _showCustomBaseUrl;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 500),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '初次见面',
                    style: PsyberTheme.editorialSerif.copyWith(
                      fontSize: 26,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '名字和称呼都可以先留空，进屋之后在日常聊天里慢慢认识与决定。',
                    style: TextStyle(fontSize: 13.5, color: colors.inkQuiet, height: 1.5),
                  ),
                  const SizedBox(height: 18),
                  Container(
                    padding: const EdgeInsets.all(22),
                    decoration: BoxDecoration(
                      color: colors.letterSurface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: colors.hairline),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          '1. 房间名牌（可选）',
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: colors.inkDeep,
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          key: const Key('genesis_resident_name'),
                          controller: _residentNameController,
                          decoration: const InputDecoration(
                            labelText: 'Psyber 名字（留空则为中性初生）',
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          key: const Key('genesis_user_name'),
                          controller: _userNameController,
                          decoration: const InputDecoration(
                            labelText: '怎么称呼你（可选）',
                          ),
                        ),
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Text(
                              '你的代词',
                              style: TextStyle(fontSize: 12.5, color: colors.inkQuiet),
                            ),
                            const SizedBox(width: 10),
                            for (final opt in const [
                              ('', '先不写'),
                              ('他', '他'),
                              ('她', '她'),
                            ])
                              Padding(
                                padding: const EdgeInsets.only(right: 6),
                                child: ChoiceChip(
                                  key: Key('genesis_pronoun_${opt.$1.isEmpty ? 'none' : opt.$1}'),
                                  label: Text(opt.$2),
                                  selected: _userPronoun == opt.$1,
                                  selectedColor: colors.accentSoft,
                                  backgroundColor: colors.mineralCanvas,
                                  side: BorderSide(
                                    color: _userPronoun == opt.$1
                                        ? colors.accentBorder
                                        : colors.hairline,
                                  ),
                                  labelStyle: TextStyle(
                                    fontSize: 12,
                                    color: _userPronoun == opt.$1
                                        ? colors.inkDeep
                                        : colors.inkQuiet,
                                  ),
                                  onSelected: (_) => setState(() => _userPronoun = opt.$1),
                                ),
                              ),
                          ],
                        ),
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 18),
                          child: Divider(height: 1),
                        ),
                        Text(
                          '2. 作息与模型连接',
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            color: colors.inkDeep,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _sleepStartController,
                                style: PsyberTheme.monoStyle.copyWith(fontSize: 14),
                                decoration: const InputDecoration(labelText: '夜间休息开始'),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: TextField(
                                controller: _sleepEndController,
                                style: PsyberTheme.monoStyle.copyWith(fontSize: 14),
                                decoration: const InputDecoration(labelText: '早晨醒来'),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              flex: 2,
                              child: TextField(
                                controller: _timezoneController,
                                style: PsyberTheme.monoStyle.copyWith(fontSize: 13),
                                decoration: const InputDecoration(labelText: '时区'),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        Text(
                          '模型服务商（BYOK，也可稍后在设置里配置）',
                          style: TextStyle(fontSize: 12.5, color: colors.inkQuiet),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            for (final p in _providers)
                              ChoiceChip(
                                label: Text(p.label),
                                selected: _providerKind == p.id,
                                selectedColor: colors.accentSoft,
                                backgroundColor: colors.mineralCanvas,
                                side: BorderSide(
                                  color: _providerKind == p.id
                                      ? colors.accentBorder
                                      : colors.hairline,
                                ),
                                labelStyle: TextStyle(
                                  fontSize: 13,
                                  color: _providerKind == p.id
                                      ? colors.inkDeep
                                      : colors.inkQuiet,
                                  fontWeight: _providerKind == p.id
                                      ? FontWeight.w600
                                      : FontWeight.normal,
                                ),
                                onSelected: (_) => setState(() => _providerKind = p.id),
                              ),
                          ],
                        ),
                        if (_providerKind != 'openai-compat') ...[
                          const SizedBox(height: 6),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: TextButton(
                              onPressed: () =>
                                  setState(() => _showCustomBaseUrl = !_showCustomBaseUrl),
                              style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                minimumSize: Size.zero,
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                              child: Text(
                                _showCustomBaseUrl
                                    ? '收起自定义接口地址'
                                    : '使用自定义 Base URL（默认 ${activeMeta.defaultUrl}）',
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                          ),
                        ],
                        if (needBaseUrlField) ...[
                          const SizedBox(height: 10),
                          TextField(
                            key: const Key('genesis_base_url_field'),
                            controller: _baseUrlController,
                            style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                            decoration: InputDecoration(
                              labelText: _providerKind == 'openai-compat'
                                  ? '自定义接口地址 Base URL（必填）'
                                  : '自定义接口地址 Base URL（留空使用官方默认）',
                              hintText: activeMeta.defaultUrl.isNotEmpty
                                  ? activeMeta.defaultUrl
                                  : 'https://api.example.com/v1',
                            ),
                          ),
                        ],
                        const SizedBox(height: 12),
                        TextField(
                          key: const Key('genesis_model_field'),
                          controller: _modelController,
                          style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                          decoration: InputDecoration(
                            labelText: '主对话模型 ID（可选）',
                            hintText: '例如 ${activeMeta.hintModel}',
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          key: const Key('genesis_apikey_field'),
                          controller: _apiKeyController,
                          obscureText: _obscureKey,
                          style: PsyberTheme.monoStyle.copyWith(fontSize: 13.5),
                          decoration: InputDecoration(
                            labelText: 'API Key（可选，直落 0600 凭证文件）',
                            suffixIcon: IconButton(
                              icon: Icon(
                                _obscureKey
                                    ? PhosphorIconsLight.eye
                                    : PhosphorIconsLight.eyeSlash,
                                size: 18,
                                color: colors.inkQuiet,
                              ),
                              onPressed: () => setState(() => _obscureKey = !_obscureKey),
                            ),
                          ),
                        ),
                        if (_error != null) ...[
                          const SizedBox(height: 12),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                            decoration: BoxDecoration(
                              color: colors.dangerSoft,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(
                              _error!,
                              style: TextStyle(
                                color: colors.dangerInk,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ],
                        const SizedBox(height: 20),
                        FilledButton(
                          key: const Key('genesis_submit_button'),
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
                              : const Text('推门进去'),
                        ),
                      ],
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
