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
    this.coolingOffStartedAt,
    this.departedAt,
    this.farewell,
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
  final int? coolingOffStartedAt;
  final int? departedAt;
  final String? farewell;

  factory DoorStatus.fromJson(Map<String, dynamic> json) {
    return DoorStatus(
      state: DoorState.fromWire(json['state'] as String?),
      note: json['note'] as String?,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      unreadDoorNotes: (json['unreadDoorNotes'] as num?)?.toInt() ?? 0,
      coolingOffStartedAt: (json['coolingOffStartedAt'] as num?)?.toInt(),
      departedAt: (json['departedAt'] as num?)?.toInt(),
      farewell: json['farewell'] as String?,
    );
  }

  DoorStatus copyWith({
    DoorState? state,
    String? note,
    bool clearNote = false,
    int? updatedAt,
    int? unreadDoorNotes,
    int? coolingOffStartedAt,
    int? departedAt,
    String? farewell,
  }) {
    return DoorStatus(
      state: state ?? this.state,
      note: clearNote ? null : (note ?? this.note),
      updatedAt: updatedAt ?? this.updatedAt,
      unreadDoorNotes: unreadDoorNotes ?? this.unreadDoorNotes,
      coolingOffStartedAt: coolingOffStartedAt ?? this.coolingOffStartedAt,
      departedAt: departedAt ?? this.departedAt,
      farewell: farewell ?? this.farewell,
    );
  }
}

@immutable
class StickerView {
  const StickerView({
    required this.id,
    required this.label,
    required this.url,
    this.pack = 'default',
    this.useCount = 0,
  });

  final String id;
  final String label;
  final String url;
  final String pack;
  final int useCount;

  factory StickerView.fromJson(Map<String, dynamic> json) {
    return StickerView(
      id: json['id'] as String? ?? '',
      label: json['label'] as String? ?? '',
      url: json['url'] as String? ?? '',
      pack: json['pack'] as String? ?? 'default',
      useCount: (json['useCount'] as num?)?.toInt() ?? 0,
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
class ToolSummaryItem {
  const ToolSummaryItem({
    required this.name,
    required this.label,
    required this.ok,
  });

  final String name;
  final String label;
  final bool ok;

  factory ToolSummaryItem.fromJson(Map<String, dynamic> json) {
    return ToolSummaryItem(
      name: json['name'] as String? ?? '',
      label: json['label'] as String? ?? '',
      ok: json['ok'] != false,
    );
  }
}

@immutable
class ToolProgressItem {
  const ToolProgressItem({
    required this.callId,
    required this.name,
    required this.label,
    required this.status,
  });

  final String callId;
  final String name;
  final String label;
  final String status;

  factory ToolProgressItem.fromJson(Map<String, dynamic> json) {
    return ToolProgressItem(
      callId: json['callId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      label: json['label'] as String? ?? (json['name'] as String? ?? ''),
      status: json['status'] as String? ?? 'running',
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
    this.groupId,
    this.version = 1,
    this.versionCount = 1,
    this.activity,
    this.thinking,
    this.attachments = const <String>[],
    this.sticker,
    this.expressions = const <ExpressionPayload>[],
    this.toolSummary = const <ToolSummaryItem>[],
    this.recallCount,
    this.aborted = false,
  });

  final String id;
  final int seq;
  final String sessionId;
  final String? turnId;
  final String? clientMessageId;
  final String? groupId;
  final int version;
  final int versionCount;
  final String? activity;
  final String role;
  final String kind;
  final String content;
  final String? thinking;
  final List<String> attachments;
  final StickerView? sticker;
  final List<ExpressionPayload> expressions;
  final List<ToolSummaryItem> toolSummary;
  final int? recallCount;
  final bool aborted;
  final int createdAt;

  bool get isUser => role == 'user';
  bool get isAssistant => role == 'assistant';
  bool get isDoorNote => kind == 'door_note';
  bool get isMemoryTask => kind == 'memory_task';
  bool get isSystemNotice =>
      role == 'system' ||
      kind == 'door.updated' ||
      kind == 'privacy.peeked' ||
      kind == 'relationship.departed' ||
      kind == 'activity_event';

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
    final rawTools = json['toolSummary'] ?? metaMap['toolSummary'];
    final toolSummary = <ToolSummaryItem>[];
    if (rawTools is List<dynamic>) {
      for (final item in rawTools) {
        if (item is Map<String, dynamic>) {
          toolSummary.add(ToolSummaryItem.fromJson(item));
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
      groupId: json['groupId'] as String?,
      version: (json['version'] as num?)?.toInt() ?? 1,
      versionCount: (json['versionCount'] as num?)?.toInt() ?? 1,
      activity: json['activity'] as String?,
      role: json['role'] as String? ?? 'system',
      kind: json['kind'] as String? ?? 'chat',
      content: json['content'] as String? ?? '',
      thinking: json['thinking'] as String?,
      attachments: attachments,
      sticker: rawSticker is Map<String, dynamic>
          ? StickerView.fromJson(rawSticker)
          : null,
      expressions: expressions,
      toolSummary: toolSummary,
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
class ProviderSettingsView {
  const ProviderSettingsView({
    required this.id,
    required this.kind,
    required this.authMode,
    required this.authStatus,
    this.baseUrl,
  });

  final String id;
  final String kind;
  final String authMode;
  final String authStatus;
  final String? baseUrl;

  factory ProviderSettingsView.fromJson(String id, Map<String, dynamic> json) {
    return ProviderSettingsView(
      id: id,
      kind: json['kind'] as String? ?? 'openai',
      authMode: json['authMode'] as String? ?? 'api_key',
      authStatus: json['authStatus'] as String? ?? 'unset',
      baseUrl: json['baseUrl'] as String?,
    );
  }
}

@immutable
class ModelSlotView {
  const ModelSlotView({required this.provider, required this.model});

  final String provider;
  final String model;

  factory ModelSlotView.fromJson(Map<String, dynamic> json) {
    return ModelSlotView(
      provider: json['provider'] as String? ?? '',
      model: json['model'] as String? ?? '',
    );
  }
}

@immutable
class CircadianSettings {
  const CircadianSettings({
    this.sleepStart = '23:30',
    this.sleepEnd = '07:30',
    this.heartbeatIntervalMin = 30,
    this.proactiveEnabled = true,
    this.proactiveMinGapMin = 240,
    this.proactiveCooldownMin = 180,
  });

  final String sleepStart;
  final String sleepEnd;
  final int heartbeatIntervalMin;
  final bool proactiveEnabled;
  final int proactiveMinGapMin;
  final int proactiveCooldownMin;

  factory CircadianSettings.fromJson(Map<String, dynamic> json) {
    return CircadianSettings(
      sleepStart: json['sleepStart'] as String? ?? '23:30',
      sleepEnd: json['sleepEnd'] as String? ?? '07:30',
      heartbeatIntervalMin: (json['heartbeatIntervalMin'] as num?)?.toInt() ?? 30,
      proactiveEnabled: json['proactiveEnabled'] != false,
      proactiveMinGapMin: (json['proactiveMinGapMin'] as num?)?.toInt() ?? 240,
      proactiveCooldownMin: (json['proactiveCooldownMin'] as num?)?.toInt() ?? 180,
    );
  }
}

@immutable
class PairedDeviceView {
  const PairedDeviceView({
    required this.deviceId,
    required this.deviceName,
    required this.platform,
    required this.createdAt,
    required this.lastSeenAt,
    this.hasPushToken = false,
  });

  final String deviceId;
  final String deviceName;
  final String platform;
  final int createdAt;
  final int lastSeenAt;
  final bool hasPushToken;

  factory PairedDeviceView.fromJson(Map<String, dynamic> json) {
    return PairedDeviceView(
      deviceId: json['deviceId'] as String? ?? '',
      deviceName: json['deviceName'] as String? ?? 'Device',
      platform: json['platform'] as String? ?? 'unknown',
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      lastSeenAt: (json['lastSeenAt'] as num?)?.toInt() ?? 0,
      hasPushToken: json['hasPushToken'] == true,
    );
  }
}

@immutable
class SettingsSnapshot {
  const SettingsSnapshot({
    this.timezone = 'Asia/Shanghai',
    this.providers = const <String, ProviderSettingsView>{},
    this.chatSlot,
    this.thinkingEnabled = true,
    this.circadian = const CircadianSettings(),
    this.desktopNotifyEnabled = true,
    this.webhookEnabled = false,
    this.webhookUrl = '',
    this.devices = const <PairedDeviceView>[],
  });

  final String timezone;
  final Map<String, ProviderSettingsView> providers;
  final ModelSlotView? chatSlot;
  final bool thinkingEnabled;
  final CircadianSettings circadian;
  final bool desktopNotifyEnabled;
  final bool webhookEnabled;
  final String webhookUrl;
  final List<PairedDeviceView> devices;

  factory SettingsSnapshot.fromJson(Map<String, dynamic> json) {
    final llm = json['llm'] is Map<String, dynamic>
        ? json['llm'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final rawProviders = llm['providers'];
    final providers = <String, ProviderSettingsView>{};
    if (rawProviders is Map<String, dynamic>) {
      for (final entry in rawProviders.entries) {
        if (entry.value is Map<String, dynamic>) {
          providers[entry.key] = ProviderSettingsView.fromJson(
            entry.key,
            entry.value as Map<String, dynamic>,
          );
        }
      }
    }
    final slots = llm['slots'] is Map<String, dynamic>
        ? llm['slots'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final rawChat = slots['chat'];
    final chatSlot = rawChat is Map<String, dynamic>
        ? ModelSlotView.fromJson(rawChat)
        : null;
    final thinking = llm['thinking'] is Map<String, dynamic>
        ? llm['thinking'] as Map<String, dynamic>
        : const <String, dynamic>{};

    final rawCircadian = json['circadian'] is Map<String, dynamic>
        ? json['circadian'] as Map<String, dynamic>
        : const <String, dynamic>{};

    final rawNotif = json['notifications'] is Map<String, dynamic>
        ? json['notifications'] as Map<String, dynamic>
        : const <String, dynamic>{};
    // 兼容服务端 Ring 1 结构 {desktop: {enabled}, webhook: {enabled, url}}
    // 以及 Spec 04 预留结构 {channels: {desktop: {enabled}}}
    final rawChannels = rawNotif['channels'] is Map<String, dynamic>
        ? rawNotif['channels'] as Map<String, dynamic>
        : rawNotif;
    final desktopMap = rawChannels['desktop'] is Map<String, dynamic>
        ? rawChannels['desktop'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final webhookMap = rawChannels['webhook'] is Map<String, dynamic>
        ? rawChannels['webhook'] as Map<String, dynamic>
        : const <String, dynamic>{};

    final rawDevices = json['devices'];
    final devices = <PairedDeviceView>[];
    if (rawDevices is List<dynamic>) {
      for (final item in rawDevices) {
        if (item is Map<String, dynamic>) {
          devices.add(PairedDeviceView.fromJson(item));
        }
      }
    }

    return SettingsSnapshot(
      timezone: json['timezone'] as String? ?? 'Asia/Shanghai',
      providers: providers,
      chatSlot: chatSlot,
      thinkingEnabled: thinking['enabled'] != false,
      circadian: CircadianSettings.fromJson(rawCircadian),
      desktopNotifyEnabled: desktopMap['enabled'] != false,
      webhookEnabled: webhookMap['enabled'] == true,
      webhookUrl: webhookMap['url'] as String? ?? '',
      devices: devices,
    );
  }
}

/// Ring 1.5 活动会话视图（如观影伴看 cinema）。
@immutable
class ActivitySessionView {
  const ActivitySessionView({
    required this.id,
    required this.slug,
    required this.title,
    required this.topicHint,
    required this.status,
    required this.startedAt,
    required this.lastHeartbeatAt,
    this.endedAt,
    this.metadata = const <String, dynamic>{},
  });

  final String id;
  final String slug;
  final String title;
  final String topicHint;
  final String status;
  final int startedAt;
  final int? endedAt;
  final int lastHeartbeatAt;
  final Map<String, dynamic> metadata;

  bool get isStale => status == 'stale';
  bool get isEnded => status == 'ended';

  factory ActivitySessionView.fromJson(Map<String, dynamic> json) {
    final rawMeta = json['metadata'];
    return ActivitySessionView(
      id: json['id'] as String? ?? '',
      slug: json['slug'] as String? ?? 'activity',
      title: json['title'] as String? ?? '',
      topicHint: json['topicHint'] as String? ?? '',
      status: json['status'] as String? ?? 'active',
      startedAt: (json['startedAt'] as num?)?.toInt() ?? 0,
      endedAt: (json['endedAt'] as num?)?.toInt(),
      lastHeartbeatAt: (json['lastHeartbeatAt'] as num?)?.toInt() ?? 0,
      metadata: rawMeta is Map<String, dynamic>
          ? rawMeta
          : const <String, dynamic>{},
    );
  }
}

/// Ring 1.5 上锁抽屉清单条目（拆封前绝不含正文）。
@immutable
class DrawerEntryView {
  const DrawerEntryView({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.updatedAt,
    required this.peeked,
    this.lastPeekedAt,
  });

  final String id;
  final String title;
  final int createdAt;
  final int updatedAt;
  final bool peeked;
  final int? lastPeekedAt;

  factory DrawerEntryView.fromJson(Map<String, dynamic> json) {
    return DrawerEntryView(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '未命名日记',
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      peeked: json['peeked'] == true,
      lastPeekedAt: (json['lastPeekedAt'] as num?)?.toInt(),
    );
  }
}

@immutable
class DrawerOpenedContent {
  const DrawerOpenedContent({
    required this.id,
    required this.title,
    required this.content,
    required this.createdAt,
    required this.updatedAt,
    required this.peekedEventId,
  });

  final String id;
  final String title;
  final String content;
  final int createdAt;
  final int updatedAt;
  final String peekedEventId;

  factory DrawerOpenedContent.fromJson(Map<String, dynamic> json) {
    return DrawerOpenedContent(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      content: json['content'] as String? ?? '',
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      peekedEventId: json['peekedEventId'] as String? ?? '',
    );
  }
}

@immutable
class SseEventFrame {
  const SseEventFrame({
    required this.event,
    required this.data,
    this.id,
  });

  final String event;
  final Map<String, dynamic> data;
  final String? id;
}
