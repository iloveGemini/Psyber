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

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}

/// 预期内的连接取消（例如 App 切后台主动中断 SSE），绝不弹红色错误条。
class CanceledException implements Exception {
  const CanceledException();
}

/// 纯函数 SSE 行流解析器：支持 event / data / 空行落帧，忽略注释行。
Stream<SseEventFrame> parseSseLines(Stream<String> lines) async* {
  String currentEvent = 'message';
  final dataLines = <String>[];

  await for (final line in lines) {
    if (line.isEmpty) {
      if (dataLines.isNotEmpty) {
        final raw = dataLines.join('\n');
        dataLines.clear();
        try {
          final decoded = jsonDecode(raw);
          if (decoded is Map<String, dynamic>) {
            yield SseEventFrame(event: currentEvent, data: decoded);
          }
        } catch (_) {
          // 忽略无法解析的损坏帧
        }
      }
      currentEvent = 'message';
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      currentEvent = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.add(line.substring(5).trimLeft());
    }
  }
}

/// Psyber Ring 1 薄客户端网络接口（测试环境注入内存 Fake，100% 离线）。
abstract class PsyberApiClient {
  Future<HealthInfo> checkHealth(String baseUrl);

  Future<ConnectionProfile> pair({
    required String baseUrl,
    required String code,
    required String deviceName,
    required String platform,
  });

  Future<GenesisStatus> getGenesis(ConnectionProfile profile);

  Future<void> submitGenesis(
    ConnectionProfile profile, {
    String? residentName,
    String? userName,
    required String timezone,
    String? sleepStart,
    String? sleepEnd,
    String? providerKind,
    String? modelName,
    String? apiKey,
  });

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

  Future<SendMessageResult> sendMessage(
    ConnectionProfile profile, {
    required String clientMessageId,
    required String content,
    List<String>? attachments,
    String? stickerId,
  });

  Future<void> deleteMessage(ConnectionProfile profile, String messageId);

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

  /// 打开 SSE 实时事件流；调用方取消订阅时自动断开底层连接。
  Stream<SseEventFrame> openEventStream(
    ConnectionProfile profile, {
    required bool foreground,
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
    required String timezone,
    String? sleepStart,
    String? sleepEnd,
    String? providerKind,
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
    if (sleepStart != null && sleepEnd != null) {
      payload['sleepWindow'] = {'start': sleepStart, 'end': sleepEnd};
    }
    if (providerKind != null &&
        providerKind.isNotEmpty &&
        modelName != null &&
        modelName.isNotEmpty) {
      payload['llm'] = {
        'providers': {
          providerKind: {'kind': providerKind, 'authMode': 'api_key'},
        },
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
  Future<SendMessageResult> sendMessage(
    ConnectionProfile profile, {
    required String clientMessageId,
    required String content,
    List<String>? attachments,
    String? stickerId,
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
  Stream<SseEventFrame> openEventStream(
    ConnectionProfile profile, {
    required bool foreground,
  }) {
    late final StreamController<SseEventFrame> controller;
    HttpClient? client;
    StreamSubscription<SseEventFrame>? innerSub;
    var canceled = false;

    controller = StreamController<SseEventFrame>(
      onListen: () async {
        client = _clientFactory();
        try {
          final uri = Uri.parse('${normalizeBaseUrl(profile.baseUrl)}/api/v1/stream')
              .replace(queryParameters: {'foreground': foreground ? 'true' : 'false'});
          final req = await client!.getUrl(uri);
          req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
          req.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${profile.token}');
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
