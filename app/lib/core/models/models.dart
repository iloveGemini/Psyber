import 'package:flutter/foundation.dart';

/// 门状态枚举（与后端 /api/v1/door 契约严格对齐）
enum DoorState {
  open,
  quiet,
  closed,
  coolingOff,
  departed;

  static DoorState fromWire(String? raw) {
    switch (raw) {
      case 'quiet':
        return DoorState.quiet;
      case 'closed':
        return DoorState.closed;
      case 'cooling_off':
        return DoorState.coolingOff;
      case 'departed':
        return DoorState.departed;
      case 'open':
      default:
        return DoorState.open;
    }
  }

  bool get isDoorNoteMode =>
      this == DoorState.closed || this == DoorState.coolingOff;

  bool get isReadOnly => this == DoorState.departed;
}

@immutable
class ConnectionProfile {
  const ConnectionProfile({
    required this.baseUrl,
    required this.token,
    required this.deviceId,
    required this.instanceId,
    required this.deviceName,
  });

  final String baseUrl;
  final String token;
  final String deviceId;
  final String instanceId;
  final String deviceName;

  factory ConnectionProfile.fromJson(Map<String, dynamic> json) {
    return ConnectionProfile(
      baseUrl: (json['baseUrl'] as String? ?? '').trim(),
      token: (json['token'] as String? ?? '').trim(),
      deviceId: (json['deviceId'] as String? ?? '').trim(),
      instanceId: (json['instanceId'] as String? ?? '').trim(),
      deviceName: (json['deviceName'] as String? ?? 'Psyber Client').trim(),
    );
  }

  Map<String, dynamic> toJson() => {
        'baseUrl': baseUrl,
        'token': token,
        'deviceId': deviceId,
        'instanceId': instanceId,
        'deviceName': deviceName,
      };

  String resolveMediaUrl(String relativePath) {
    final cleanBase = baseUrl.endsWith('/')
        ? baseUrl.substring(0, baseUrl.length - 1)
        : baseUrl;
    final path = relativePath.startsWith('/') ? relativePath : '/$relativePath';
    return '$cleanBase$path';
  }
}

@immutable
class GenesisStatus {
  const GenesisStatus({
    required this.initialized,
    required this.named,
    required this.hasChatProvider,
    required this.timezone,
    required this.sleepStart,
    required this.sleepEnd,
  });

  static const GenesisStatus completedDefault = GenesisStatus(
    initialized: true,
    named: true,
    hasChatProvider: true,
    timezone: 'Asia/Shanghai',
    sleepStart: '23:30',
    sleepEnd: '07:30',
  );

  final bool initialized;
  final bool named;
  final bool hasChatProvider;
  final String timezone;
  final String sleepStart;
  final String sleepEnd;

  factory GenesisStatus.fromJson(Map<String, dynamic> json) {
    final sleep = json['sleepWindow'];
    final sleepMap = sleep is Map<String, dynamic> ? sleep : const <String, dynamic>{};
    return GenesisStatus(
      initialized: json['initialized'] == true,
      named: json['named'] == true,
      hasChatProvider: json['hasChatProvider'] == true,
      timezone: json['timezone'] as String? ?? 'Asia/Shanghai',
      sleepStart: sleepMap['start'] as String? ?? '23:30',
      sleepEnd: sleepMap['end'] as String? ?? '07:30',
    );
  }
}

@immutable
class UploadedMedia {
  const UploadedMedia({
    required this.hash,
    required this.url,
    required this.mimeType,
    required this.size,
  });

  final String hash;
  final String url;
  final String mimeType;
  final int size;

  factory UploadedMedia.fromJson(Map<String, dynamic> json) {
    return UploadedMedia(
      hash: json['hash'] as String? ?? '',
      url: json['url'] as String? ?? '',
      mimeType: json['mimeType'] as String? ?? 'application/octet-stream',
      size: (json['size'] as num?)?.toInt() ?? 0,
    );
  }
}

@immutable
class HealthInfo {
  const HealthInfo({
    required this.ok,
    required this.version,
    required this.instanceId,
    required this.serverTimeMs,
  });

  final bool ok;
  final String version;
  final String instanceId;
  final int serverTimeMs;

  factory HealthInfo.fromJson(Map<String, dynamic> json) {
    return HealthInfo(
      ok: json['ok'] == true,
      version: json['version'] as String? ?? '0.0.0',
      instanceId: json['instanceId'] as String? ?? '',
      serverTimeMs: (json['serverTimeMs'] as num?)?.toInt() ?? 0,
    );
  }
}

@immutable
class DoorStatus {
  const DoorStatus({
    required this.state,
    required this.note,
    required this.updatedAt,
    required this.unreadDoorNotes,
  });

  static const DoorStatus initial = DoorStatus(
    state: DoorState.open,
    note: null,
    updatedAt: 0,
    unreadDoorNotes: 0,
  );

  final DoorState state;
  final String? note;
  final int updatedAt;
  final int unreadDoorNotes;

  factory DoorStatus.fromJson(Map<String, dynamic> json) {
    return DoorStatus(
      state: DoorState.fromWire(json['state'] as String?),
      note: json['note'] as String?,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      unreadDoorNotes: (json['unreadDoorNotes'] as num?)?.toInt() ?? 0,
    );
  }

  DoorStatus copyWith({
    DoorState? state,
    String? note,
    bool clearNote = false,
    int? updatedAt,
    int? unreadDoorNotes,
  }) {
    return DoorStatus(
      state: state ?? this.state,
      note: clearNote ? null : (note ?? this.note),
      updatedAt: updatedAt ?? this.updatedAt,
      unreadDoorNotes: unreadDoorNotes ?? this.unreadDoorNotes,
    );
  }
}

@immutable
class StickerView {
  const StickerView({
    required this.id,
    required this.label,
    required this.url,
  });

  final String id;
  final String label;
  final String url;

  factory StickerView.fromJson(Map<String, dynamic> json) {
    return StickerView(
      id: json['id'] as String? ?? '',
      label: json['label'] as String? ?? '',
      url: json['url'] as String? ?? '',
    );
  }
}

@immutable
class AtmosphereSpec {
  const AtmosphereSpec({
    required this.tone,
    required this.intensity,
    required this.durationSec,
  });

  /// warm / cool / dim / bright / neutral
  final String tone;

  /// subtle / noticeable
  final String intensity;
  final int durationSec;

  factory AtmosphereSpec.fromJson(Map<String, dynamic> json) {
    return AtmosphereSpec(
      tone: json['tone'] as String? ?? 'neutral',
      intensity: json['intensity'] as String? ?? 'subtle',
      durationSec: ((json['durationSec'] as num?)?.toInt() ?? 15).clamp(3, 120),
    );
  }
}

@immutable
class ExpressionPayload {
  const ExpressionPayload({
    this.haptic,
    this.atmosphere,
    this.motion,
    this.sticker,
  });

  final String? haptic;
  final AtmosphereSpec? atmosphere;
  final String? motion;
  final StickerView? sticker;

  factory ExpressionPayload.fromJson(Map<String, dynamic> json) {
    final rawAtm = json['atmosphere'];
    final rawSticker = json['sticker'];
    return ExpressionPayload(
      haptic: json['haptic'] as String?,
      atmosphere: rawAtm is Map<String, dynamic>
          ? AtmosphereSpec.fromJson(rawAtm)
          : null,
      motion: json['motion'] as String?,
      sticker: rawSticker is Map<String, dynamic>
          ? StickerView.fromJson(rawSticker)
          : null,
    );
  }
}

@immutable
class TimelineItem {
  const TimelineItem({
    required this.id,
    required this.seq,
    required this.sessionId,
    required this.role,
    required this.kind,
    required this.content,
    required this.createdAt,
    this.turnId,
    this.clientMessageId,
    this.thinking,
    this.attachments = const <String>[],
    this.sticker,
    this.expressions = const <ExpressionPayload>[],
    this.recallCount,
    this.aborted = false,
  });

  final String id;
  final int seq;
  final String sessionId;
  final String? turnId;
  final String? clientMessageId;
  final String role;
  final String kind;
  final String content;
  final String? thinking;
  final List<String> attachments;
  final StickerView? sticker;
  final List<ExpressionPayload> expressions;
  final int? recallCount;
  final bool aborted;
  final int createdAt;

  bool get isUser => role == 'user';
  bool get isAssistant => role == 'assistant';
  bool get isDoorNote => kind == 'door_note';

  factory TimelineItem.fromJson(Map<String, dynamic> json) {
    final meta = json['metadata'];
    final metaMap = meta is Map<String, dynamic> ? meta : const <String, dynamic>{};
    final rawSticker = json['sticker'];
    final rawExprs = json['expressions'] ?? metaMap['expressions'];
    final expressions = <ExpressionPayload>[];
    if (rawExprs is List<dynamic>) {
      for (final item in rawExprs) {
        if (item is Map<String, dynamic>) {
          expressions.add(ExpressionPayload.fromJson(item));
        }
      }
    }
    final rawAttachments = json['attachments'] ?? metaMap['attachments'];
    final attachments = <String>[];
    if (rawAttachments is List<dynamic>) {
      for (final a in rawAttachments) {
        if (a is String && a.isNotEmpty) {
          attachments.add(a);
        } else if (a is Map<String, dynamic> && a['hash'] is String) {
          attachments.add(a['hash'] as String);
        }
      }
    }
    final rawRecall = json['recallCount'] ?? metaMap['recallCount'];
    return TimelineItem(
      id: json['id'] as String? ?? '',
      seq: (json['seq'] as num?)?.toInt() ?? 0,
      sessionId: json['sessionId'] as String? ?? '',
      turnId: json['turnId'] as String?,
      clientMessageId: json['clientMessageId'] as String?,
      role: json['role'] as String? ?? 'system',
      kind: json['kind'] as String? ?? 'chat',
      content: json['content'] as String? ?? '',
      thinking: json['thinking'] as String?,
      attachments: attachments,
      sticker: rawSticker is Map<String, dynamic>
          ? StickerView.fromJson(rawSticker)
          : null,
      expressions: expressions,
      recallCount: rawRecall is num ? rawRecall.toInt() : null,
      aborted: json['aborted'] == true || metaMap['aborted'] == true,
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
    );
  }
}

@immutable
class HistoryPage {
  const HistoryPage({
    required this.items,
    required this.hasMore,
    required this.latestEventSeq,
    this.nextBefore,
  });

  final List<TimelineItem> items;
  final bool hasMore;
  final String? nextBefore;
  final int latestEventSeq;

  factory HistoryPage.fromJson(Map<String, dynamic> json) {
    final rawItems = json['items'];
    final items = <TimelineItem>[];
    if (rawItems is List<dynamic>) {
      for (final entry in rawItems) {
        if (entry is Map<String, dynamic>) {
          items.add(TimelineItem.fromJson(entry));
        }
      }
    }
    return HistoryPage(
      items: items,
      hasMore: json['hasMore'] == true,
      nextBefore: json['nextBefore'] as String?,
      latestEventSeq: (json['latestEventSeq'] as num?)?.toInt() ?? 0,
    );
  }
}

@immutable
class SendMessageResult {
  const SendMessageResult({
    required this.message,
    required this.deliveredAs,
    this.turnId,
  });

  final TimelineItem message;
  final String deliveredAs;
  final String? turnId;

  factory SendMessageResult.fromJson(Map<String, dynamic> json) {
    return SendMessageResult(
      message: TimelineItem.fromJson(
        (json['message'] as Map<String, dynamic>?) ?? const <String, dynamic>{},
      ),
      deliveredAs: json['deliveredAs'] as String? ?? 'chat',
      turnId: json['turnId'] as String?,
    );
  }
}

@immutable
class RecallTraceItem {
  const RecallTraceItem({
    required this.cardPath,
    required this.title,
    required this.track,
    required this.finalScore,
    this.feedback,
  });

  final String cardPath;
  final String title;
  final String track;
  final double finalScore;
  final String? feedback;

  factory RecallTraceItem.fromJson(Map<String, dynamic> json) {
    return RecallTraceItem(
      cardPath: json['cardPath'] as String? ?? '',
      title: json['title'] as String? ?? '',
      track: json['track'] as String? ?? 'cross_vector',
      finalScore: (json['finalScore'] as num?)?.toDouble() ?? 0.0,
      feedback: json['feedback'] as String?,
    );
  }

  RecallTraceItem copyWith({String? feedback}) {
    return RecallTraceItem(
      cardPath: cardPath,
      title: title,
      track: track,
      finalScore: finalScore,
      feedback: feedback ?? this.feedback,
    );
  }
}

@immutable
class SseEventFrame {
  const SseEventFrame({
    required this.event,
    required this.data,
  });

  final String event;
  final Map<String, dynamic> data;
}
