import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models/models.dart';

class ApiException implements Exception {
  const ApiException({
    required this.statusCode,
    required this.code,
    required this.message,
  });

  final int statusCode;
  final String code;
  final String message;

  bool get isEndpointUnavailable => statusCode == 404 || statusCode == 501;

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}

/// 预期内的连接取消（例如 App 切后台主动中断 SSE），绝不弹红色错误条。
class CanceledException implements Exception {
  const CanceledException();
}

/// 纯函数 SSE 行流解析器：支持 id / event / data / 空行落帧，忽略注释行。
Stream<SseEventFrame> parseSseLines(Stream<String> lines) async* {
  String currentEvent = 'message';
  String? currentId;
  final dataLines = <String>[];

  await for (final line in lines) {
    if (line.isEmpty) {
      if (dataLines.isNotEmpty) {
        final raw = dataLines.join('\n');
        dataLines.clear();
        try {
          final decoded = jsonDecode(raw);
          if (decoded is Map<String, dynamic>) {
            yield SseEventFrame(event: currentEvent, data: decoded, id: currentId);
          }
        } catch (_) {
          // 忽略无法解析的损坏帧
        }
      }
      currentEvent = 'message';
      currentId = null;
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('id:')) {
      currentId = line.substring(3).trim();
    } else if (line.startsWith('event:')) {
      currentEvent = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.add(line.substring(5).trimLeft());
    }
  }
}

/// Psyber 客户端网络接口（支持 Ring 1 核心端点与 Ring 1.5 扩展槽位；测试环境可注入内存 Fake）。
abstract class PsyberApiClient {
  Future<HealthInfo> checkHealth(String baseUrl);

  Future<ConnectionProfile> pair({
    required String baseUrl,
    required String code,
    required String deviceName,
    required String platform,
    String? clientId,
  });

  /// 仅限本机桌面端免码配对（读取 0600 local_pair.json 密钥）。
  Future<ConnectionProfile> localPair({
    required String baseUrl,
    required String secret,
    required String deviceName,
    required String platform,
    String? clientId,
  });

  /// 已配对设备为新设备签发 5 分钟一次性配对码与扫码二维码载荷。
  Future<IssuedPairCodeView> issuePairCode(ConnectionProfile profile);

  Future<GenesisStatus> getGenesis(ConnectionProfile profile);

  Future<void> submitGenesis(
    ConnectionProfile profile, {
    String? residentName,
    String? userName,
    String? userPronoun,
    required String timezone,
    String? sleepStart,
    String? sleepEnd,
    String? providerKind,
    String? baseUrl,
    String? modelName,
    String? apiKey,
  });

  Future<SettingsSnapshot> getSettings(ConnectionProfile profile);

  Future<SettingsSnapshot> updateSettings(
    ConnectionProfile profile,
    Map<String, dynamic> patch,
  );

  Future<void> updateLlmSettings(
    ConnectionProfile profile, {
    required String providerKind,
    required String modelName,
    String? baseUrl,
    String? apiKey,
  });

  Future<void> revokeDevice(ConnectionProfile profile, String deviceId);

  Future<DoorStatus> getDoor(ConnectionProfile profile);

  Future<HistoryPage> getHistory(
    ConnectionProfile profile, {
    String? beforeId,
    int limit = 50,
  });

  Future<UploadedMedia> uploadMedia(
    ConnectionProfile profile, {
    required List<int> bytes,
    required String filename,
    required String mimeType,
  });

  Future<List<StickerView>> listStickers(ConnectionProfile profile);

  Future<StickerView> uploadSticker(
    ConnectionProfile profile, {
    required List<int> bytes,
    required String filename,
    required String mimeType,
    required String id,
    required String label,
    String pack = 'default',
  });

  Future<SendMessageResult> sendMessage(
    ConnectionProfile profile, {
    required String clientMessageId,
    required String content,
    List<String>? attachments,
    String? stickerId,
    VideoClipInfo? videoClip,
    VoiceClipInfo? voiceClip,
    bool urgent = false,
  });

  Future<void> deleteMessage(ConnectionProfile profile, String messageId);

  /// Ring 1.5：双向社交撤回（用户撤回自己的消息，Psyber 仅见占位不知原文）。
  Future<TimelineItem> retractMessage(ConnectionProfile profile, String messageId);

  /// Ring 1.5：重新触发图片/短视频附件摘要生成。
  Future<void> retryAttachmentDigest(ConnectionProfile profile, String messageId);

  /// Ring 1.5：首次点开 Psyber 分享卡上报拆阅回执。
  Future<int?> openShare(ConnectionProfile profile, String shareId);

  /// 首次点开 Psyber 留下的门缝纸条上报拆封。
  Future<int?> openDoorNote(ConnectionProfile profile, String messageId);

  /// Ring 1.5：读取用户双人状态签（心绪短句 + 勿扰开关）。
  Future<UserStatus> getUserStatus(ConnectionProfile profile);

  /// Ring 1.5：更新用户双人状态签。
  Future<UserStatus> updateUserStatus(
    ConnectionProfile profile, {
    String? moodText,
    bool clearMood = false,
    bool? undisturbed,
  });

  /// Ring 1.5：失败轮次原地无痕重试（不重复插入用户消息）。
  Future<String?> retryTurn(ConnectionProfile profile, String turnId);

  /// Ring 1.5：用户手动触发「存记忆换段」。
  Future<WrapUpResult> wrapUpSession(ConnectionProfile profile);

  /// Ring 1.5：编辑末条用户消息（Ring 1 服务端返回 404 时由上层温和提示）。
  Future<TimelineItem> editMessage(
    ConnectionProfile profile,
    String messageId,
    String content,
  );

  /// Ring 1.5：重摇助手回复。
  Future<void> rerollMessage(ConnectionProfile profile, String messageId);

  /// Ring 1.5：切换历史版本组。
  Future<TimelineItem> switchMessageVersion(
    ConnectionProfile profile,
    String messageId,
    int version,
  );

  Future<void> abortTurn(ConnectionProfile profile, String turnId);

  Future<List<RecallTraceItem>> getTurnRecall(
    ConnectionProfile profile,
    String turnId,
  );

  Future<void> submitRecallFeedback(
    ConnectionProfile profile, {
    required String turnId,
    required String verdict,
    String? cardPath,
    String? note,
  });

  /// Ring 1.5：拉取活跃活动会话（Ring 1 服务端未挂载时返回 null）。
  Future<ActivitySessionView?> getActiveActivity(ConnectionProfile profile);

  /// Ring 1.5：结束观影伴看活动。
  Future<void> endCinemaActivity(
    ConnectionProfile profile, {
    String? sessionId,
  });

  /// Ring 1.5：读取上锁抽屉清单。
  Future<List<DrawerEntryView>> listDrawer(ConnectionProfile profile);

  /// Ring 1.5：显式确认拆封抽屉（写先于读 `privacy.peeked`）。
  Future<DrawerOpenedContent> openDrawerEntry(
    ConnectionProfile profile,
    String id,
  );

  /// Ring 1.5：读取设置页消耗统计（支持按 days 范围筛选）。
  Future<UsageStatsSnapshot> getUsageStats(ConnectionProfile profile, {int? days});

  /// 拉取服务商下可发现模型清单（含 models.dev 元数据与手工覆写）。
  Future<List<DiscoveredModelView>> listLlmModels(
    ConnectionProfile profile, {
    String? provider,
  });

  /// 手动触发 models.dev 模型元数据目录同步。
  Future<ModelCatalogSyncResult> syncModelCatalog(ConnectionProfile profile);

  /// Ring 1.5：一键模型连通测试。
  Future<LlmTestResult> testLlmModel(
    ConnectionProfile profile, {
    required String provider,
    required String model,
  });

  /// 发送一条测试离线通知。
  Future<NotificationTestResult> testNotifications(ConnectionProfile profile);

  /// Ring 1.5：上传双人头像（who 为 user 或 resident）。
  Future<String> uploadAvatar(
    ConnectionProfile profile, {
    required String who,
    required List<int> bytes,
    required String filename,
    required String mimeType,
  });

  /// Ring 1.5：读取内置外部 MCP 生态预设清单。
  Future<List<McpPresetView>> getMcpPresets(ConnectionProfile profile);

  /// Ring 1.5：手动重连单个外部 MCP 服务器。
  Future<McpServerView?> reconnectMcpServer(ConnectionProfile profile, String serverId);

  /// Ring 1.5/2：响应同步高风险工具审批卡。
  Future<void> resolveToolApproval(
    ConnectionProfile profile, {
    required String turnId,
    required String approvalId,
    required String decision,
    String scope = 'once',
  });

  /// 打开 SSE 实时事件流；调用方取消订阅时自动断开底层连接。
  Stream<SseEventFrame> openEventStream(
    ConnectionProfile profile, {
    required bool foreground,
    String? lastEventId,
  });
}

class HttpPsyberApiClient implements PsyberApiClient {
  HttpPsyberApiClient({HttpClient Function()? clientFactory})
      : _clientFactory = clientFactory ?? HttpClient.new;

  final HttpClient Function() _clientFactory;

  static String normalizeBaseUrl(String raw) {
    final trimmed = raw.trim();
    if (trimmed.endsWith('/')) {
      return trimmed.substring(0, trimmed.length - 1);
    }
    return trimmed;
  }

  Map<String, dynamic> _safeDecodeMap(String rawText) {
    if (rawText.trim().isEmpty) return const <String, dynamic>{};
    try {
      final decoded = jsonDecode(rawText);
      return decoded is Map<String, dynamic> ? decoded : const <String, dynamic>{};
    } catch (_) {
      return const <String, dynamic>{};
    }
  }

  Future<Map<String, dynamic>> _requestJson({
    required String method,
    required Uri uri,
    String? bearerToken,
    Map<String, dynamic>? body,
    Duration timeout = const Duration(seconds: 10),
  }) async {
    final client = _clientFactory();
    client.connectionTimeout = timeout;
    try {
      final req = await client.openUrl(method, uri).timeout(timeout);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (bearerToken != null && bearerToken.isNotEmpty) {
        req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearerToken');
      }
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close().timeout(timeout);
      final rawText = await utf8.decodeStream(res).timeout(timeout);
      final map = _safeDecodeMap(rawText);

      if (res.statusCode < 200 || res.statusCode >= 300) {
        final err = map['error'];
        final errMap = err is Map<String, dynamic> ? err : const <String, dynamic>{};
        throw ApiException(
          statusCode: res.statusCode,
          code: errMap['code'] as String? ?? 'HTTP_${res.statusCode}',
          message: errMap['message'] as String? ?? '请求失败（HTTP ${res.statusCode}）',
        );
      }
      return map;
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<HealthInfo> checkHealth(String baseUrl) async {
    final uri = Uri.parse('${normalizeBaseUrl(baseUrl)}/api/v1/health');
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      timeout: const Duration(milliseconds: 2500),
    );
    return HealthInfo.fromJson(json);
  }

  @override
  Future<ConnectionProfile> pair({
    required String baseUrl,
    required String code,
    required String deviceName,
    required String platform,
    String? clientId,
  }) async {
    final cleanBase = normalizeBaseUrl(baseUrl);
    final uri = Uri.parse('$cleanBase/api/v1/auth/pair');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      body: {
        'code': code.trim(),
        'deviceName': deviceName.trim(),
        'platform': platform,
        if (clientId != null && clientId.trim().isNotEmpty) 'clientId': clientId.trim(),
      },
    );
    return ConnectionProfile(
      baseUrl: cleanBase,
      token: json['token'] as String? ?? '',
      deviceId: json['deviceId'] as String? ?? '',
      instanceId: json['instanceId'] as String? ?? '',
      deviceName: deviceName.trim(),
    );
  }

  @override
  Future<ConnectionProfile> localPair({
    required String baseUrl,
    required String secret,
    required String deviceName,
    required String platform,
    String? clientId,
  }) async {
    final cleanBase = normalizeBaseUrl(baseUrl);
    final uri = Uri.parse('$cleanBase/api/v1/auth/local-pair');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      body: {
        'secret': secret.trim(),
        'deviceName': deviceName.trim(),
        'platform': platform,
        if (clientId != null && clientId.trim().isNotEmpty) 'clientId': clientId.trim(),
      },
    );
    return ConnectionProfile(
      baseUrl: cleanBase,
      token: json['token'] as String? ?? '',
      deviceId: json['deviceId'] as String? ?? '',
      instanceId: json['instanceId'] as String? ?? '',
      deviceName: deviceName.trim(),
    );
  }

  @override
  Future<IssuedPairCodeView> issuePairCode(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/auth/pair-code');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
    return IssuedPairCodeView.fromJson(json);
  }

  @override
  Future<GenesisStatus> getGenesis(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/genesis');
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    return GenesisStatus.fromJson(json);
  }

  @override
  Future<void> submitGenesis(
    ConnectionProfile profile, {
    String? residentName,
    String? userName,
    String? userPronoun,
    required String timezone,
    String? sleepStart,
    String? sleepEnd,
    String? providerKind,
    String? baseUrl,
    String? modelName,
    String? apiKey,
  }) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/genesis');
    final payload = <String, dynamic>{'timezone': timezone};
    if (residentName != null && residentName.trim().isNotEmpty) {
      payload['residentName'] = residentName.trim();
    }
    if (userName != null && userName.trim().isNotEmpty) {
      payload['userName'] = userName.trim();
    }
    if (userPronoun != null && userPronoun.trim().isNotEmpty) {
      payload['userPronoun'] = userPronoun.trim();
    }
    if (sleepStart != null && sleepEnd != null) {
      payload['sleepWindow'] = {'start': sleepStart, 'end': sleepEnd};
    }
    if (providerKind != null &&
        providerKind.isNotEmpty &&
        modelName != null &&
        modelName.isNotEmpty) {
      final providerEntry = <String, dynamic>{
        'kind': providerKind,
        'authMode': 'api_key',
      };
      if (baseUrl != null && baseUrl.trim().isNotEmpty) {
        providerEntry['baseUrl'] = baseUrl.trim();
      }
      payload['llm'] = {
        'providers': {providerKind: providerEntry},
        'slots': {
          'chat': {'provider': providerKind, 'model': modelName},
        },
      };
      if (apiKey != null && apiKey.trim().isNotEmpty) {
        payload['credentials'] = {
          providerKind: {'apiKey': apiKey.trim()},
        };
      }
    }
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: payload,
    );
  }

  @override
  Future<SettingsSnapshot> getSettings(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/settings');
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    return SettingsSnapshot.fromJson(json);
  }

  @override
  Future<SettingsSnapshot> updateSettings(
    ConnectionProfile profile,
    Map<String, dynamic> patch,
  ) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/settings');
    final json = await _requestJson(
      method: 'PATCH',
      uri: uri,
      bearerToken: profile.token,
      body: patch,
    );
    final rawSettings = json['settings'];
    if (rawSettings is Map<String, dynamic>) {
      return SettingsSnapshot.fromJson(rawSettings);
    }
    return getSettings(profile);
  }

  @override
  Future<void> updateLlmSettings(
    ConnectionProfile profile, {
    required String providerKind,
    required String modelName,
    String? baseUrl,
    String? apiKey,
  }) async {
    final providerEntry = <String, dynamic>{
      'kind': providerKind,
      'authMode': 'api_key',
    };
    if (baseUrl != null && baseUrl.trim().isNotEmpty) {
      providerEntry['baseUrl'] = baseUrl.trim();
    }
    final payload = <String, dynamic>{
      'llm': {
        'providers': {providerKind: providerEntry},
        'slots': {
          'chat': {'provider': providerKind, 'model': modelName.trim()},
        },
      },
    };
    if (apiKey != null && apiKey.trim().isNotEmpty) {
      payload['credentials'] = {
        providerKind: {'apiKey': apiKey.trim()},
      };
    }
    await updateSettings(profile, payload);
  }

  @override
  Future<void> revokeDevice(ConnectionProfile profile, String deviceId) async {
    await updateSettings(profile, {
      'revokeDeviceIds': [deviceId],
    });
  }

  @override
  Future<DoorStatus> getDoor(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/door');
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    return DoorStatus.fromJson(json);
  }

  @override
  Future<HistoryPage> getHistory(
    ConnectionProfile profile, {
    String? beforeId,
    int limit = 50,
  }) async {
    final query = <String, String>{'limit': '$limit'};
    if (beforeId != null && beforeId.isNotEmpty) {
      query['before'] = beforeId;
    }
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/history')
        .replace(queryParameters: query);
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    return HistoryPage.fromJson(json);
  }

  @override
  Future<UploadedMedia> uploadMedia(
    ConnectionProfile profile, {
    required List<int> bytes,
    required String filename,
    required String mimeType,
  }) async {
    final boundary = '----psyber${DateTime.now().microsecondsSinceEpoch}';
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/media');
    final client = _clientFactory();
    client.connectionTimeout = const Duration(seconds: 20);
    try {
      final req = await client.postUrl(uri).timeout(const Duration(seconds: 20));
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${profile.token}');
      req.headers.set(
        HttpHeaders.contentTypeHeader,
        'multipart/form-data; boundary=$boundary',
      );
      final header = '--$boundary\r\n'
          'Content-Disposition: form-data; name="file"; filename="$filename"\r\n'
          'Content-Type: $mimeType\r\n\r\n';
      final footer = '\r\n--$boundary--\r\n';
      req.add(utf8.encode(header));
      req.add(bytes);
      req.add(utf8.encode(footer));
      final res = await req.close().timeout(const Duration(seconds: 20));
      final rawText = await utf8.decodeStream(res).timeout(const Duration(seconds: 20));
      final map = _safeDecodeMap(rawText);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        final err = map['error'];
        final errMap = err is Map<String, dynamic> ? err : const <String, dynamic>{};
        throw ApiException(
          statusCode: res.statusCode,
          code: errMap['code'] as String? ?? 'HTTP_${res.statusCode}',
          message: errMap['message'] as String? ?? '上传失败（HTTP ${res.statusCode}）',
        );
      }
      return UploadedMedia.fromJson(map);
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<List<StickerView>> listStickers(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/stickers');
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    final raw = json['items'];
    if (raw is! List<dynamic>) return const <StickerView>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(StickerView.fromJson)
        .toList(growable: false);
  }

  @override
  Future<StickerView> uploadSticker(
    ConnectionProfile profile, {
    required List<int> bytes,
    required String filename,
    required String mimeType,
    required String id,
    required String label,
    String pack = 'default',
  }) async {
    final boundary = '----psyberstk${DateTime.now().microsecondsSinceEpoch}';
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/stickers');
    final client = _clientFactory();
    client.connectionTimeout = const Duration(seconds: 20);
    try {
      final req = await client.postUrl(uri).timeout(const Duration(seconds: 20));
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${profile.token}');
      req.headers.set(
        HttpHeaders.contentTypeHeader,
        'multipart/form-data; boundary=$boundary',
      );
      void writeField(String name, String value) {
        req.add(
          utf8.encode(
            '--$boundary\r\nContent-Disposition: form-data; name="$name"\r\n\r\n$value\r\n',
          ),
        );
      }

      writeField('id', id);
      writeField('label', label);
      writeField('pack', pack);
      final fileHeader = '--$boundary\r\n'
          'Content-Disposition: form-data; name="file"; filename="$filename"\r\n'
          'Content-Type: $mimeType\r\n\r\n';
      req.add(utf8.encode(fileHeader));
      req.add(bytes);
      req.add(utf8.encode('\r\n--$boundary--\r\n'));

      final res = await req.close().timeout(const Duration(seconds: 20));
      final rawText = await utf8.decodeStream(res).timeout(const Duration(seconds: 20));
      final map = _safeDecodeMap(rawText);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        final err = map['error'];
        final errMap = err is Map<String, dynamic> ? err : const <String, dynamic>{};
        throw ApiException(
          statusCode: res.statusCode,
          code: errMap['code'] as String? ?? 'HTTP_${res.statusCode}',
          message: errMap['message'] as String? ?? '贴纸上传失败（HTTP ${res.statusCode}）',
        );
      }
      return StickerView.fromJson(map);
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<SendMessageResult> sendMessage(
    ConnectionProfile profile, {
    required String clientMessageId,
    required String content,
    List<String>? attachments,
    String? stickerId,
    VideoClipInfo? videoClip,
    VoiceClipInfo? voiceClip,
    bool urgent = false,
  }) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages');
    final payload = <String, dynamic>{
      'clientMessageId': clientMessageId,
      'content': content,
    };
    if (attachments != null && attachments.isNotEmpty) {
      payload['attachments'] = attachments;
    }
    if (stickerId != null && stickerId.isNotEmpty) {
      payload['stickerId'] = stickerId;
    }
    if (videoClip != null) {
      payload['videoClip'] = videoClip.toJson();
    }
    if (voiceClip != null) {
      payload['voiceClip'] = voiceClip.toJson();
    }
    if (urgent) {
      payload['urgent'] = true;
    }
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: payload,
    );
    return SendMessageResult.fromJson(json);
  }

  @override
  Future<void> deleteMessage(ConnectionProfile profile, String messageId) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages/$messageId',
    );
    await _requestJson(
      method: 'DELETE',
      uri: uri,
      bearerToken: profile.token,
    );
  }

  @override
  Future<TimelineItem> retractMessage(
    ConnectionProfile profile,
    String messageId,
  ) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages/$messageId/retract',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
    return TimelineItem.fromJson(
      (json['message'] as Map<String, dynamic>?) ?? const <String, dynamic>{},
    );
  }

  @override
  Future<void> retryAttachmentDigest(
    ConnectionProfile profile,
    String messageId,
  ) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages/$messageId/digest',
    );
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
  }

  @override
  Future<int?> openShare(ConnectionProfile profile, String shareId) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/shares/$shareId/open',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
    return (json['openedAt'] as num?)?.toInt();
  }

  @override
  Future<int?> openDoorNote(ConnectionProfile profile, String messageId) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/door-notes/$messageId/open',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
    return (json['openedAt'] as num?)?.toInt();
  }

  @override
  Future<UserStatus> getUserStatus(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/user-status');
    try {
      final json = await _requestJson(
        method: 'GET',
        uri: uri,
        bearerToken: profile.token,
      );
      return UserStatus.fromJson(json);
    } on ApiException catch (e) {
      if (e.isEndpointUnavailable) return UserStatus.initial;
      rethrow;
    }
  }

  @override
  Future<UserStatus> updateUserStatus(
    ConnectionProfile profile, {
    String? moodText,
    bool clearMood = false,
    bool? undisturbed,
  }) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/user-status');
    final payload = <String, dynamic>{};
    if (clearMood) {
      payload['moodText'] = null;
    } else if (moodText != null) {
      payload['moodText'] = moodText;
    }
    if (undisturbed != null) {
      payload['undisturbed'] = undisturbed;
    }
    final json = await _requestJson(
      method: 'PATCH',
      uri: uri,
      bearerToken: profile.token,
      body: payload,
    );
    return UserStatus.fromJson(json);
  }

  @override
  Future<String?> retryTurn(ConnectionProfile profile, String turnId) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/turns/$turnId/retry',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
    return json['turnId'] as String?;
  }

  @override
  Future<WrapUpResult> wrapUpSession(ConnectionProfile profile) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/wrap-up',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
      // 同步存记忆换段会等待旧段整理落盘，放宽超时避免长段落中途误报超时
      timeout: const Duration(seconds: 180),
    );
    return WrapUpResult.fromJson(json);
  }

  @override
  Future<TimelineItem> editMessage(
    ConnectionProfile profile,
    String messageId,
    String content,
  ) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages/$messageId/edit',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: {'content': content},
    );
    return TimelineItem.fromJson(
      (json['message'] as Map<String, dynamic>?) ?? const <String, dynamic>{},
    );
  }

  @override
  Future<void> rerollMessage(ConnectionProfile profile, String messageId) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages/$messageId/reroll',
    );
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
    );
  }

  @override
  Future<TimelineItem> switchMessageVersion(
    ConnectionProfile profile,
    String messageId,
    int version,
  ) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/chat/messages/$messageId/version',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: {'version': version},
    );
    return TimelineItem.fromJson(
      (json['activated'] as Map<String, dynamic>?) ?? const <String, dynamic>{},
    );
  }

  @override
  Future<void> abortTurn(ConnectionProfile profile, String turnId) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/turns/$turnId/abort',
    );
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
    );
  }

  @override
  Future<List<RecallTraceItem>> getTurnRecall(
    ConnectionProfile profile,
    String turnId,
  ) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/turns/$turnId/recall',
    );
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    final raw = json['items'];
    if (raw is! List<dynamic>) return const <RecallTraceItem>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(RecallTraceItem.fromJson)
        .toList(growable: false);
  }

  @override
  Future<void> submitRecallFeedback(
    ConnectionProfile profile, {
    required String turnId,
    required String verdict,
    String? cardPath,
    String? note,
  }) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/recall/feedback');
    final payload = <String, dynamic>{
      'turnId': turnId,
      'verdict': verdict,
    };
    if (cardPath != null && cardPath.isNotEmpty) {
      payload['cardPath'] = cardPath;
    }
    if (note != null && note.trim().isNotEmpty) {
      payload['note'] = note.trim();
    }
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: payload,
    );
  }

  @override
  Future<ActivitySessionView?> getActiveActivity(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/activities');
    try {
      final json = await _requestJson(
        method: 'GET',
        uri: uri,
        bearerToken: profile.token,
      );
      final raw = json['activeSession'];
      if (raw is Map<String, dynamic>) {
        return ActivitySessionView.fromJson(raw);
      }
      return null;
    } on ApiException catch (e) {
      if (e.isEndpointUnavailable) return null;
      rethrow;
    }
  }

  @override
  Future<void> endCinemaActivity(
    ConnectionProfile profile, {
    String? sessionId,
  }) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/activities/cinema/end',
    );
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: {
        if (sessionId != null && sessionId.isNotEmpty) 'sessionId': sessionId,
        'reason': 'user_ended',
      },
    );
  }

  @override
  Future<List<DrawerEntryView>> listDrawer(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/drawer');
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    final raw = json['items'];
    if (raw is! List<dynamic>) return const <DrawerEntryView>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(DrawerEntryView.fromJson)
        .toList(growable: false);
  }

  @override
  Future<DrawerOpenedContent> openDrawerEntry(
    ConnectionProfile profile,
    String id,
  ) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/drawer/$id/open');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const {'confirmed': true},
    );
    return DrawerOpenedContent.fromJson(json);
  }

  @override
  Future<UsageStatsSnapshot> getUsageStats(ConnectionProfile profile, {int? days}) async {
    final baseUri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/usage/stats');
    final uri = days != null
        ? baseUri.replace(queryParameters: {'days': '$days'})
        : baseUri;
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    return UsageStatsSnapshot.fromJson(json);
  }

  @override
  Future<List<DiscoveredModelView>> listLlmModels(
    ConnectionProfile profile, {
    String? provider,
  }) async {
    final baseUri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/llm/models');
    final uri = (provider != null && provider.trim().isNotEmpty)
        ? baseUri.replace(queryParameters: {'provider': provider.trim()})
        : baseUri;
    final json = await _requestJson(
      method: 'GET',
      uri: uri,
      bearerToken: profile.token,
    );
    final raw = json['models'];
    if (raw is! List<dynamic>) return const <DiscoveredModelView>[];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(DiscoveredModelView.fromJson)
        .toList(growable: false);
  }

  @override
  Future<ModelCatalogSyncResult> syncModelCatalog(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/llm/catalog/sync');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
      timeout: const Duration(seconds: 15),
    );
    return ModelCatalogSyncResult.fromJson(json);
  }

  @override
  Future<LlmTestResult> testLlmModel(
    ConnectionProfile profile, {
    required String provider,
    required String model,
  }) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/llm/test');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: {'provider': provider, 'model': model},
      timeout: const Duration(seconds: 20),
    );
    return LlmTestResult.fromJson(json);
  }

  @override
  Future<NotificationTestResult> testNotifications(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/notifications/test');
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
      timeout: const Duration(seconds: 10),
    );
    return NotificationTestResult.fromJson(json);
  }

  @override
  Future<String> uploadAvatar(
    ConnectionProfile profile, {
    required String who,
    required List<int> bytes,
    required String filename,
    required String mimeType,
  }) async {
    final boundary = '----psyberavt${DateTime.now().microsecondsSinceEpoch}';
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/avatars/$who');
    final client = _clientFactory();
    client.connectionTimeout = const Duration(seconds: 20);
    try {
      final req = await client.postUrl(uri).timeout(const Duration(seconds: 20));
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${profile.token}');
      req.headers.set(
        HttpHeaders.contentTypeHeader,
        'multipart/form-data; boundary=$boundary',
      );
      final header = '--$boundary\r\n'
          'Content-Disposition: form-data; name="file"; filename="$filename"\r\n'
          'Content-Type: $mimeType\r\n\r\n';
      req.add(utf8.encode(header));
      req.add(bytes);
      req.add(utf8.encode('\r\n--$boundary--\r\n'));
      final res = await req.close().timeout(const Duration(seconds: 20));
      final rawText = await utf8.decodeStream(res).timeout(const Duration(seconds: 20));
      final map = _safeDecodeMap(rawText);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        final err = map['error'];
        final errMap = err is Map<String, dynamic> ? err : const <String, dynamic>{};
        throw ApiException(
          statusCode: res.statusCode,
          code: errMap['code'] as String? ?? 'HTTP_${res.statusCode}',
          message: errMap['message'] as String? ?? '头像上传失败（HTTP ${res.statusCode}）',
        );
      }
      return map['url'] as String? ?? '';
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<List<McpPresetView>> getMcpPresets(ConnectionProfile profile) async {
    final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/mcp/presets');
    try {
      final json = await _requestJson(
        method: 'GET',
        uri: uri,
        bearerToken: profile.token,
      );
      final raw = json['presets'];
      if (raw is! List<dynamic>) return const <McpPresetView>[];
      return raw
          .whereType<Map<String, dynamic>>()
          .map(McpPresetView.fromJson)
          .toList(growable: false);
    } on ApiException catch (e) {
      if (e.isEndpointUnavailable) return const <McpPresetView>[];
      rethrow;
    }
  }

  @override
  Future<McpServerView?> reconnectMcpServer(
    ConnectionProfile profile,
    String serverId,
  ) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/mcp/$serverId/reconnect',
    );
    final json = await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: const <String, dynamic>{},
      timeout: const Duration(seconds: 15),
    );
    final raw = json['server'];
    return raw is Map<String, dynamic> ? McpServerView.fromJson(raw) : null;
  }

  @override
  Future<void> resolveToolApproval(
    ConnectionProfile profile, {
    required String turnId,
    required String approvalId,
    required String decision,
    String scope = 'once',
  }) async {
    final uri = Uri.parse(
      '${normalizeBaseUrl(profile.baseUrl)}/api/v1/turns/$turnId/approval',
    );
    await _requestJson(
      method: 'POST',
      uri: uri,
      bearerToken: profile.token,
      body: {
        'approvalId': approvalId,
        'decision': decision,
        'scope': scope,
      },
    );
  }

  @override
  Stream<SseEventFrame> openEventStream(
    ConnectionProfile profile, {
    required bool foreground,
    String? lastEventId,
  }) {
    late final StreamController<SseEventFrame> controller;
    HttpClient? client;
    StreamSubscription<SseEventFrame>? innerSub;
    var canceled = false;

    controller = StreamController<SseEventFrame>(
      onListen: () async {
        client = _clientFactory();
        try {
          final query = <String, String>{
            'foreground': foreground ? 'true' : 'false',
            if (lastEventId != null && lastEventId.isNotEmpty) 'lastEventId': lastEventId,
          };
          final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/stream')
              .replace(queryParameters: query);
          final req = await client!.getUrl(uri);
          req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
          req.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${profile.token}');
          if (lastEventId != null && lastEventId.isNotEmpty) {
            req.headers.set('Last-Event-ID', lastEventId);
          }
          final res = await req.close();
          if (canceled) return;
          if (res.statusCode != 200) {
            controller.addError(
              ApiException(
                statusCode: res.statusCode,
                code: 'SSE_HTTP_${res.statusCode}',
                message: '实时通道连接失败（HTTP ${res.statusCode}）',
              ),
            );
            await controller.close();
            return;
          }
          final lines = res.transform(utf8.decoder).transform(const LineSplitter());
          innerSub = parseSseLines(lines).listen(
            controller.add,
            onError: (Object err, StackTrace st) {
              if (!canceled) controller.addError(err, st);
            },
            onDone: () {
              if (!controller.isClosed) {
                unawaited(controller.close());
              }
            },
          );
        } catch (err, st) {
          if (!canceled && !controller.isClosed) {
            controller.addError(err, st);
            await controller.close();
          }
        }
      },
      onCancel: () async {
        canceled = true;
        await innerSub?.cancel();
        client?.close(force: true);
      },
    );

    return controller.stream;
  }
}
