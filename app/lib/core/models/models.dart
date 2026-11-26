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
class IdentityInfo {
  const IdentityInfo({
    this.residentName,
    this.residentPronoun,
    this.named = false,
    this.userName,
    this.userPronoun,
  });

  static const IdentityInfo empty = IdentityInfo();

  final String? residentName;
  final String? residentPronoun;
  final bool named;
  final String? userName;
  final String? userPronoun;

  String get displayResidentName =>
      (residentName != null && residentName!.trim().isNotEmpty)
          ? residentName!.trim()
          : 'Psyber';

  String get residentSubject => displayResidentName;

  String get avatarInitial {
    final name = residentName?.trim();
    if (name != null && name.isNotEmpty) {
      return String.fromCharCode(name.runes.first);
    }
    return 'P';
  }

  factory IdentityInfo.fromJson(Map<String, dynamic> json) {
    String? clean(Object? v) {
      if (v is! String) return null;
      final t = v.trim();
      return t.isEmpty ? null : t;
    }

    return IdentityInfo(
      residentName: clean(json['residentName']),
      residentPronoun: clean(json['residentPronoun']),
      named: json['named'] == true,
      userName: clean(json['userName']),
      userPronoun: clean(json['userPronoun']),
    );
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
    this.residentName,
    this.residentPronoun,
    this.userName,
    this.userPronoun,
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
  final String? residentName;
  final String? residentPronoun;
  final String? userName;
  final String? userPronoun;

  IdentityInfo toIdentityInfo() => IdentityInfo(
        residentName: residentName,
        residentPronoun: residentPronoun,
        named: named,
        userName: userName,
        userPronoun: userPronoun,
      );

  factory GenesisStatus.fromJson(Map<String, dynamic> json) {
    final sleep = json['sleepWindow'];
    final sleepMap = sleep is Map<String, dynamic> ? sleep : const <String, dynamic>{};
    String? clean(Object? v) {
      if (v is! String) return null;
      final t = v.trim();
      return t.isEmpty ? null : t;
    }

    return GenesisStatus(
      initialized: json['initialized'] == true,
      named: json['named'] == true,
      hasChatProvider: json['hasChatProvider'] == true,
      timezone: json['timezone'] as String? ?? 'Asia/Shanghai',
      sleepStart: sleepMap['start'] as String? ?? '23:30',
      sleepEnd: sleepMap['end'] as String? ?? '07:30',
      residentName: clean(json['residentName']),
      residentPronoun: clean(json['residentPronoun']),
      userName: clean(json['userName']),
      userPronoun: clean(json['userPronoun']),
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
    this.kind = 'general',
    this.screenshotUrl,
    this.reason,
  });

  final String name;
  final String label;
  final bool ok;
  final String kind;
  final String? screenshotUrl;
  final String? reason;

  bool get isScreen => kind == 'screen' || name == 'look_at_screen';

  factory ToolSummaryItem.fromJson(Map<String, dynamic> json) {
    return ToolSummaryItem(
      name: json['name'] as String? ?? '',
      label: json['label'] as String? ?? '',
      ok: json['ok'] != false,
      kind: json['kind'] as String? ?? 'general',
      screenshotUrl: json['screenshotUrl'] as String?,
      reason: json['reason'] as String?,
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
    this.kind = 'general',
    this.step,
    this.screenshotUrl,
    this.reason,
  });

  final String callId;
  final String name;
  final String label;
  final String status;
  final String kind;
  final int? step;
  final String? screenshotUrl;
  final String? reason;

  bool get isScreen => kind == 'screen' || name == 'look_at_screen';

  factory ToolProgressItem.fromJson(Map<String, dynamic> json) {
    return ToolProgressItem(
      callId: json['callId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      label: json['label'] as String? ?? (json['name'] as String? ?? ''),
      status: json['status'] as String? ?? 'running',
      kind: json['kind'] as String? ?? 'general',
      step: (json['step'] as num?)?.toInt(),
      screenshotUrl: json['screenshotUrl'] as String?,
      reason: json['reason'] as String?,
    );
  }
}

@immutable
class TurnJournalStep {
  const TurnJournalStep({
    required this.step,
    this.thinking = '',
    this.progressTools = const <ToolProgressItem>[],
    this.summaryTools = const <ToolSummaryItem>[],
  });

  final int step;
  final String thinking;
  final List<ToolProgressItem> progressTools;
  final List<ToolSummaryItem> summaryTools;

  TurnJournalStep copyWith({
    String? thinking,
    List<ToolProgressItem>? progressTools,
    List<ToolSummaryItem>? summaryTools,
  }) {
    return TurnJournalStep(
      step: step,
      thinking: thinking ?? this.thinking,
      progressTools: progressTools ?? this.progressTools,
      summaryTools: summaryTools ?? this.summaryTools,
    );
  }

  factory TurnJournalStep.fromJson(Map<String, dynamic> json) {
    final rawTools = json['tools'];
    final tools = <ToolSummaryItem>[];
    if (rawTools is List<dynamic>) {
      for (final item in rawTools) {
        if (item is Map<String, dynamic>) {
          tools.add(ToolSummaryItem.fromJson(item));
        }
      }
    }
    return TurnJournalStep(
      step: (json['step'] as num?)?.toInt() ?? 0,
      thinking: json['thinking'] as String? ?? '',
      summaryTools: tools,
    );
  }
}

@immutable
class VideoClipInfo {
  const VideoClipInfo({
    required this.durationSec,
    required this.frameHashes,
  });

  final double durationSec;
  final List<String> frameHashes;

  factory VideoClipInfo.fromJson(Map<String, dynamic> json) {
    final rawHashes = json['frameHashes'];
    final hashes = <String>[];
    if (rawHashes is List<dynamic>) {
      for (final h in rawHashes) {
        if (h is String && h.isNotEmpty) hashes.add(h);
      }
    }
    return VideoClipInfo(
      durationSec: (json['durationSec'] as num?)?.toDouble() ?? 0.0,
      frameHashes: hashes,
    );
  }

  Map<String, dynamic> toJson() => {
        'durationSec': durationSec,
        'frameHashes': frameHashes,
      };
}

@immutable
class VoiceClipInfo {
  const VoiceClipInfo({
    required this.mediaHash,
    required this.durationSec,
    this.mimeType = 'audio/mp4',
  });

  final String mediaHash;
  final double durationSec;
  final String mimeType;

  factory VoiceClipInfo.fromJson(Map<String, dynamic> json) {
    return VoiceClipInfo(
      mediaHash: (json['mediaHash'] as String? ?? '').trim(),
      durationSec: (json['durationSec'] as num?)?.toDouble() ?? 0.0,
      mimeType: (json['mimeType'] as String? ?? 'audio/mp4').trim(),
    );
  }

  Map<String, dynamic> toJson() => {
        'mediaHash': mediaHash,
        'durationSec': durationSec,
        'mimeType': mimeType,
      };
}

@immutable
class ContextUsageInfo {
  const ContextUsageInfo({
    required this.usedTokens,
    required this.limitTokens,
    required this.ratio,
  });

  final int usedTokens;
  final int limitTokens;
  final double ratio;

  factory ContextUsageInfo.fromJson(Map<String, dynamic> json) {
    return ContextUsageInfo(
      usedTokens: (json['usedTokens'] as num?)?.toInt() ?? 0,
      limitTokens: (json['limitTokens'] as num?)?.toInt() ?? 150000,
      ratio: ((json['ratio'] as num?)?.toDouble() ?? 0.0).clamp(0.0, 1.0),
    );
  }
}

@immutable
class TurnFailureState {
  const TurnFailureState({
    required this.code,
    required this.message,
    required this.retryable,
    this.turnId,
  });

  final String? turnId;
  final String code;
  final String message;
  final bool retryable;
}

@immutable
class TurnSilenceNotice {
  const TurnSilenceNotice({
    required this.turnId,
    required this.ownTime,
    required this.createdAt,
  });

  final String turnId;
  final bool ownTime;
  final int createdAt;
}

@immutable
class WrapUpResult {
  const WrapUpResult({
    required this.oldSessionId,
    required this.newSessionId,
    required this.queued,
    this.wrapped = false,
  });

  final String oldSessionId;
  final String newSessionId;
  final bool queued;
  final bool wrapped;

  factory WrapUpResult.fromJson(Map<String, dynamic> json) {
    return WrapUpResult(
      oldSessionId: json['oldSessionId'] as String? ?? '',
      newSessionId: json['newSessionId'] as String? ?? '',
      queued: json['queued'] == true,
      wrapped: json['wrapped'] == true,
    );
  }
}

@immutable
class ShareCardItem {
  const ShareCardItem({
    required this.id,
    required this.title,
    required this.content,
    this.createdAt = 0,
    this.openedAt,
  });

  final String id;
  final String title;
  final String content;
  final int createdAt;
  final int? openedAt;

  bool get isOpened => openedAt != null;

  ShareCardItem copyWith({int? openedAt}) {
    return ShareCardItem(
      id: id,
      title: title,
      content: content,
      createdAt: createdAt,
      openedAt: openedAt ?? this.openedAt,
    );
  }

  factory ShareCardItem.fromJson(Map<String, dynamic> json) {
    return ShareCardItem(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '分享',
      content: json['content'] as String? ?? '',
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      openedAt: (json['openedAt'] as num?)?.toInt(),
    );
  }
}

@immutable
class UserStatus {
  const UserStatus({
    this.moodText,
    this.undisturbed = false,
    this.updatedAt = 0,
  });

  static const UserStatus initial = UserStatus();

  final String? moodText;
  final bool undisturbed;
  final int updatedAt;

  UserStatus copyWith({
    String? moodText,
    bool clearMood = false,
    bool? undisturbed,
    int? updatedAt,
  }) {
    return UserStatus(
      moodText: clearMood ? null : (moodText ?? this.moodText),
      undisturbed: undisturbed ?? this.undisturbed,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  factory UserStatus.fromJson(Map<String, dynamic> json) {
    final rawMood = json['moodText'] as String?;
    return UserStatus(
      moodText: rawMood != null && rawMood.trim().isNotEmpty ? rawMood.trim() : null,
      undisturbed: json['undisturbed'] == true,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
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
    this.shares = const <ShareCardItem>[],
    this.toolSummary = const <ToolSummaryItem>[],
    this.journalSteps = const <TurnJournalStep>[],
    this.model,
    this.videoClip,
    this.voiceClip,
    this.recallCount,
    this.aborted = false,
    this.retracted = false,
    this.retractedBy,
    this.urgent = false,
    this.openedAt,
    this.readByResident = false,
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
  final List<ShareCardItem> shares;
  final List<ToolSummaryItem> toolSummary;
  final List<TurnJournalStep> journalSteps;
  final String? model;
  final VideoClipInfo? videoClip;
  final VoiceClipInfo? voiceClip;
  final int? recallCount;
  final bool aborted;
  final bool retracted;
  final String? retractedBy;
  final bool urgent;
  final int? openedAt;
  final bool readByResident;
  final int createdAt;

  bool get isUser => role == 'user';
  bool get isAssistant => role == 'assistant';
  bool get isDoorNote => kind == 'door_note';
  bool get isOpened => openedAt != null;
  bool get isMemoryTask => kind == 'memory_task';
  bool get isSilence => kind == 'silence';
  bool get isShareOpened => kind == 'share.opened';
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
    final rawJournalSteps = json['journalSteps'] ?? metaMap['journalSteps'];
    final journalSteps = <TurnJournalStep>[];
    if (rawJournalSteps is List<dynamic>) {
      for (final item in rawJournalSteps) {
        if (item is Map<String, dynamic>) {
          journalSteps.add(TurnJournalStep.fromJson(item));
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
    final rawShares = json['shares'] ?? metaMap['shares'];
    final shares = <ShareCardItem>[];
    if (rawShares is List<dynamic>) {
      for (final item in rawShares) {
        if (item is Map<String, dynamic>) {
          shares.add(ShareCardItem.fromJson(item));
        }
      }
    }
    final rawRecall = json['recallCount'] ?? metaMap['recallCount'];
    final rawModel = json['model'] ?? metaMap['model'];
    final rawVideoClip = json['videoClip'] ?? metaMap['videoClip'];
    final rawVoiceClip = json['voiceClip'] ?? metaMap['voiceClip'];
    final retracted = json['retracted'] == true || json['status'] == 'retracted';
    final retractedBy = (json['retractedBy'] ?? metaMap['retractedBy']) as String?;
    final urgent = json['urgent'] == true || metaMap['urgent'] == true;
    StickerView? resolvedSticker =
        rawSticker is Map<String, dynamic> ? StickerView.fromJson(rawSticker) : null;
    if (resolvedSticker == null) {
      for (var i = expressions.length - 1; i >= 0; i--) {
        if (expressions[i].sticker != null) {
          resolvedSticker = expressions[i].sticker;
          break;
        }
      }
    }
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
      content: retracted ? '' : (json['content'] as String? ?? ''),
      thinking: retracted ? null : (json['thinking'] as String?),
      attachments: retracted ? const <String>[] : attachments,
      sticker: retracted ? null : resolvedSticker,
      expressions: retracted ? const <ExpressionPayload>[] : expressions,
      shares: retracted ? const <ShareCardItem>[] : shares,
      toolSummary: retracted ? const <ToolSummaryItem>[] : toolSummary,
      journalSteps: retracted ? const <TurnJournalStep>[] : journalSteps,
      model: rawModel is String && rawModel.isNotEmpty ? rawModel : null,
      videoClip: retracted
          ? null
          : (rawVideoClip is Map<String, dynamic>
              ? VideoClipInfo.fromJson(rawVideoClip)
              : null),
      voiceClip: retracted
          ? null
          : (rawVoiceClip is Map<String, dynamic>
              ? VoiceClipInfo.fromJson(rawVoiceClip)
              : null),
      recallCount: rawRecall is num ? rawRecall.toInt() : null,
      aborted: json['aborted'] == true || metaMap['aborted'] == true,
      retracted: retracted,
      retractedBy: retractedBy,
      urgent: urgent,
      openedAt: (json['openedAt'] as num?)?.toInt() ??
          (metaMap['openedAt'] as num?)?.toInt(),
      readByResident: json['readByResident'] == true,
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
    );
  }

  TimelineItem copyWith({
    int? openedAt,
    bool? readByResident,
    List<ShareCardItem>? shares,
  }) {
    return TimelineItem(
      id: id,
      seq: seq,
      sessionId: sessionId,
      turnId: turnId,
      clientMessageId: clientMessageId,
      groupId: groupId,
      version: version,
      versionCount: versionCount,
      activity: activity,
      role: role,
      kind: kind,
      content: content,
      thinking: thinking,
      attachments: attachments,
      sticker: sticker,
      expressions: expressions,
      shares: shares ?? this.shares,
      toolSummary: toolSummary,
      journalSteps: journalSteps,
      model: model,
      videoClip: videoClip,
      voiceClip: voiceClip,
      recallCount: recallCount,
      aborted: aborted,
      retracted: retracted,
      retractedBy: retractedBy,
      urgent: urgent,
      openedAt: openedAt ?? this.openedAt,
      readByResident: readByResident ?? this.readByResident,
      createdAt: createdAt,
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
    this.activeTurnId,
    this.rolloverInProgress = false,
    this.identity,
    this.contextUsage,
  });

  final List<TimelineItem> items;
  final bool hasMore;
  final String? nextBefore;
  final int latestEventSeq;
  final String? activeTurnId;
  final bool rolloverInProgress;
  final IdentityInfo? identity;
  final ContextUsageInfo? contextUsage;

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
    final rawUsage = json['contextUsage'];
    final rawIdentity = json['identity'];
    return HistoryPage(
      items: items,
      hasMore: json['hasMore'] == true,
      nextBefore: json['nextBefore'] as String?,
      latestEventSeq: (json['latestEventSeq'] as num?)?.toInt() ?? 0,
      activeTurnId: json['activeTurnId'] as String?,
      rolloverInProgress: json['rolloverInProgress'] == true,
      identity: rawIdentity is Map<String, dynamic>
          ? IdentityInfo.fromJson(rawIdentity)
          : null,
      contextUsage: rawUsage is Map<String, dynamic>
          ? ContextUsageInfo.fromJson(rawUsage)
          : null,
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
class ModelMetadataOverrideView {
  const ModelMetadataOverrideView({
    this.contextWindow,
    this.maxTokens,
    this.inputModalities,
    this.outputModalities,
    this.reasoning,
    this.toolCall,
  });

  final int? contextWindow;
  final int? maxTokens;
  final List<String>? inputModalities;
  final List<String>? outputModalities;
  final bool? reasoning;
  final bool? toolCall;

  factory ModelMetadataOverrideView.fromJson(Map<String, dynamic> json) {
    List<String>? parseList(Object? raw) => raw is List<dynamic>
        ? raw.whereType<String>().toList(growable: false)
        : null;
    return ModelMetadataOverrideView(
      contextWindow: (json['contextWindow'] as num?)?.toInt(),
      maxTokens: (json['maxTokens'] as num?)?.toInt(),
      inputModalities: parseList(json['inputModalities']),
      outputModalities: parseList(json['outputModalities']),
      reasoning: json['reasoning'] is bool ? json['reasoning'] as bool : null,
      toolCall: json['toolCall'] is bool ? json['toolCall'] as bool : null,
    );
  }

  Map<String, dynamic> toJson() => {
        if (contextWindow != null) 'contextWindow': contextWindow,
        if (maxTokens != null) 'maxTokens': maxTokens,
        if (inputModalities != null) 'inputModalities': inputModalities,
        if (outputModalities != null) 'outputModalities': outputModalities,
        if (reasoning != null) 'reasoning': reasoning,
        if (toolCall != null) 'toolCall': toolCall,
      };
}

@immutable
class ProviderSettingsView {
  const ProviderSettingsView({
    required this.id,
    required this.kind,
    required this.authMode,
    required this.authStatus,
    this.baseUrl,
    this.models = const <String>[],
    this.modelOverrides = const <String, ModelMetadataOverrideView>{},
  });

  final String id;
  final String kind;
  final String authMode;
  final String authStatus;
  final String? baseUrl;
  final List<String> models;
  final Map<String, ModelMetadataOverrideView> modelOverrides;

  factory ProviderSettingsView.fromJson(String id, Map<String, dynamic> json) {
    final rawModels = json['models'];
    final rawOverrides = json['modelOverrides'];
    final overrides = <String, ModelMetadataOverrideView>{};
    if (rawOverrides is Map<String, dynamic>) {
      for (final e in rawOverrides.entries) {
        if (e.value is Map<String, dynamic>) {
          overrides[e.key] = ModelMetadataOverrideView.fromJson(
            e.value as Map<String, dynamic>,
          );
        }
      }
    }
    return ProviderSettingsView(
      id: id,
      kind: json['kind'] as String? ?? 'openai',
      authMode: json['authMode'] as String? ?? 'api_key',
      authStatus: json['authStatus'] as String? ?? 'unset',
      baseUrl: json['baseUrl'] as String?,
      models: rawModels is List<dynamic>
          ? rawModels.whereType<String>().toList(growable: false)
          : const <String>[],
      modelOverrides: overrides,
    );
  }
}

@immutable
class DiscoveredModelView {
  const DiscoveredModelView({
    required this.id,
    required this.name,
    required this.provider,
    this.contextWindow,
    this.maxTokens,
    this.inputModalities = const <String>['text'],
    this.outputModalities = const <String>['text'],
    this.reasoning = false,
    this.toolCall = true,
    this.source,
  });

  final String id;
  final String name;
  final String provider;
  final int? contextWindow;
  final int? maxTokens;
  final List<String> inputModalities;
  final List<String> outputModalities;
  final bool reasoning;
  final bool toolCall;
  final String? source;

  factory DiscoveredModelView.fromJson(Map<String, dynamic> json) {
    List<String> parseList(Object? raw, List<String> fallback) {
      if (raw is! List<dynamic>) return fallback;
      final out = raw.whereType<String>().toList(growable: false);
      return out.isNotEmpty ? out : fallback;
    }
    return DiscoveredModelView(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? (json['id'] as String? ?? ''),
      provider: json['provider'] as String? ?? '',
      contextWindow: (json['contextWindow'] as num?)?.toInt(),
      maxTokens: (json['maxTokens'] as num?)?.toInt(),
      inputModalities: parseList(json['inputModalities'], const <String>['text']),
      outputModalities: parseList(json['outputModalities'], const <String>['text']),
      reasoning: json['reasoning'] == true,
      toolCall: json['toolCall'] != false,
      source: json['source'] as String?,
    );
  }
}

@immutable
class ToolCatalogItemView {
  const ToolCatalogItemView({
    required this.name,
    required this.tier,
    required this.category,
    required this.security,
    required this.description,
    required this.locked,
    required this.enabled,
  });

  final String name;
  final int tier;
  final String category;
  final String security;
  final String description;
  final bool locked;
  final bool enabled;

  factory ToolCatalogItemView.fromJson(Map<String, dynamic> json) {
    return ToolCatalogItemView(
      name: json['name'] as String? ?? '',
      tier: (json['tier'] as num?)?.toInt() ?? 3,
      category: json['category'] as String? ?? '其他工具',
      security: json['security'] as String? ?? 'auto',
      description: json['description'] as String? ?? '',
      locked: json['locked'] == true,
      enabled: json['enabled'] != false,
    );
  }
}

@immutable
class SystemInfoView {
  const SystemInfoView({
    required this.version,
    this.dataDir,
    this.configPath,
    this.memoryDir,
    this.catalogUpdatedAt,
    this.catalogModelCount,
  });

  final String version;
  final String? dataDir;
  final String? configPath;
  final String? memoryDir;
  final int? catalogUpdatedAt;
  final int? catalogModelCount;

  factory SystemInfoView.fromJson(Map<String, dynamic> json) {
    return SystemInfoView(
      version: json['version'] as String? ?? '0.1.0',
      dataDir: json['dataDir'] as String?,
      configPath: json['configPath'] as String?,
      memoryDir: json['memoryDir'] as String?,
      catalogUpdatedAt: (json['catalogUpdatedAt'] as num?)?.toInt(),
      catalogModelCount: (json['catalogModelCount'] as num?)?.toInt(),
    );
  }
}

@immutable
class ModelCatalogSyncResult {
  const ModelCatalogSyncResult({
    required this.ok,
    required this.count,
    required this.updatedAt,
    this.error,
  });

  final bool ok;
  final int count;
  final int updatedAt;
  final String? error;

  factory ModelCatalogSyncResult.fromJson(Map<String, dynamic> json) {
    return ModelCatalogSyncResult(
      ok: json['ok'] == true,
      count: (json['count'] as num?)?.toInt() ?? 0,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      error: json['error'] as String?,
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

  Map<String, dynamic> toJson() => {'provider': provider, 'model': model};
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
    this.fallbackSlots = const <ModelSlotView>[],
    this.memoryTaskSlot,
    this.digestSlot,
    this.decisionSlot,
    this.embeddingSlot,
    this.rerankerSlot,
    this.visionSlot,
    this.imageGenSlot,
    this.thinkingEnabled = true,
    this.thinkingLevel = 'medium',
    this.chatContextLimit,
    this.soloContextLimit,
    this.userAvatarUrl,
    this.residentAvatarUrl,
    this.identity,
    this.circadian = const CircadianSettings(),
    this.desktopNotifyEnabled = true,
    this.webhookEnabled = false,
    this.webhookUrl = '',
    this.barkEnabled = false,
    this.barkServerUrl = '',
    this.hasBarkKey = false,
    this.ntfyEnabled = false,
    this.ntfyServerUrl = '',
    this.ntfyTopic = '',
    this.hasNtfyToken = false,
    this.devices = const <PairedDeviceView>[],
    this.mcpServers = const <McpServerView>[],
    this.tools = const <ToolCatalogItemView>[],
    this.disabledTools = const <String>[],
    this.systemInfo,
    this.recallEvalNoticeResident = false,
  });

  final String timezone;
  final Map<String, ProviderSettingsView> providers;
  final ModelSlotView? chatSlot;
  final List<ModelSlotView> fallbackSlots;
  final ModelSlotView? memoryTaskSlot;
  final ModelSlotView? digestSlot;
  final ModelSlotView? decisionSlot;
  final ModelSlotView? embeddingSlot;
  final ModelSlotView? rerankerSlot;
  final ModelSlotView? visionSlot;
  final ModelSlotView? imageGenSlot;
  final bool thinkingEnabled;
  final String thinkingLevel;
  final int? chatContextLimit;
  final int? soloContextLimit;
  final String? userAvatarUrl;
  final String? residentAvatarUrl;
  final IdentityInfo? identity;
  final CircadianSettings circadian;
  final bool desktopNotifyEnabled;
  final bool webhookEnabled;
  final String webhookUrl;
  final bool barkEnabled;
  final String barkServerUrl;
  final bool hasBarkKey;
  final bool ntfyEnabled;
  final String ntfyServerUrl;
  final String ntfyTopic;
  final bool hasNtfyToken;
  final List<PairedDeviceView> devices;
  final List<McpServerView> mcpServers;
  final List<ToolCatalogItemView> tools;
  final List<String> disabledTools;
  final SystemInfoView? systemInfo;
  final bool recallEvalNoticeResident;

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
    ModelSlotView? parseSlot(String key) {
      final raw = slots[key];
      return raw is Map<String, dynamic> ? ModelSlotView.fromJson(raw) : null;
    }
    final rawFallbacks = slots['fallbacks'];
    final fallbackSlots = <ModelSlotView>[];
    if (rawFallbacks is List<dynamic>) {
      for (final f in rawFallbacks) {
        if (f is Map<String, dynamic>) {
          fallbackSlots.add(ModelSlotView.fromJson(f));
        }
      }
    }
    final thinking = llm['thinking'] is Map<String, dynamic>
        ? llm['thinking'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final thinkingEnabled = thinking['enabled'] != false;
    final rawLevel = thinking['level'] as String?;
    final thinkingLevel = (rawLevel == 'auto' ||
            rawLevel == 'off' ||
            rawLevel == 'low' ||
            rawLevel == 'medium' ||
            rawLevel == 'high')
        ? rawLevel!
        : (thinkingEnabled ? 'auto' : 'off');
    final rawLimits = llm['contextLimits'] is Map<String, dynamic>
        ? llm['contextLimits'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final rawAvatars = json['avatars'] is Map<String, dynamic>
        ? json['avatars'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final rawIdentity = json['identity'];

    final rawCircadian = json['circadian'] is Map<String, dynamic>
        ? json['circadian'] as Map<String, dynamic>
        : const <String, dynamic>{};

    final rawNotif = json['notifications'] is Map<String, dynamic>
        ? json['notifications'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final rawChannels = rawNotif['channels'] is Map<String, dynamic>
        ? rawNotif['channels'] as Map<String, dynamic>
        : rawNotif;
    final desktopMap = rawChannels['desktop'] is Map<String, dynamic>
        ? rawChannels['desktop'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final webhookMap = rawChannels['webhook'] is Map<String, dynamic>
        ? rawChannels['webhook'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final barkMap = rawChannels['bark'] is Map<String, dynamic>
        ? rawChannels['bark'] as Map<String, dynamic>
        : const <String, dynamic>{};
    final ntfyMap = rawChannels['ntfy'] is Map<String, dynamic>
        ? rawChannels['ntfy'] as Map<String, dynamic>
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
    final rawSystem = json['system'];

    return SettingsSnapshot(
      timezone: json['timezone'] as String? ?? 'Asia/Shanghai',
      providers: providers,
      chatSlot: parseSlot('chat'),
      fallbackSlots: fallbackSlots,
      memoryTaskSlot: parseSlot('memory_task'),
      digestSlot: parseSlot('digest'),
      decisionSlot: parseSlot('decision'),
      embeddingSlot: parseSlot('embedding'),
      rerankerSlot: parseSlot('reranker'),
      visionSlot: parseSlot('vision'),
      imageGenSlot: parseSlot('image_gen'),
      thinkingEnabled: thinkingEnabled,
      thinkingLevel: thinkingLevel,
      chatContextLimit: (rawLimits['chat'] as num?)?.toInt(),
      soloContextLimit: (rawLimits['solo'] as num?)?.toInt(),
      userAvatarUrl: rawAvatars['userUrl'] as String?,
      residentAvatarUrl: rawAvatars['residentUrl'] as String?,
      identity: rawIdentity is Map<String, dynamic>
          ? IdentityInfo.fromJson(rawIdentity)
          : null,
      circadian: CircadianSettings.fromJson(rawCircadian),
      desktopNotifyEnabled: desktopMap['enabled'] != false,
      webhookEnabled: webhookMap['enabled'] == true,
      webhookUrl: webhookMap['url'] as String? ?? '',
      barkEnabled: barkMap['enabled'] == true,
      barkServerUrl: barkMap['serverUrl'] as String? ?? '',
      hasBarkKey: rawNotif['hasBarkKey'] == true,
      ntfyEnabled: ntfyMap['enabled'] == true,
      ntfyServerUrl: ntfyMap['serverUrl'] as String? ?? '',
      ntfyTopic: ntfyMap['topic'] as String? ?? '',
      hasNtfyToken: rawNotif['hasNtfyToken'] == true,
      devices: devices,
      mcpServers: (json['mcpServers'] is List<dynamic>)
          ? (json['mcpServers'] as List<dynamic>)
              .whereType<Map<String, dynamic>>()
              .map(McpServerView.fromJson)
              .toList(growable: false)
          : const <McpServerView>[],
      tools: (json['tools'] is List<dynamic>)
          ? (json['tools'] as List<dynamic>)
              .whereType<Map<String, dynamic>>()
              .map(ToolCatalogItemView.fromJson)
              .toList(growable: false)
          : const <ToolCatalogItemView>[],
      disabledTools: (json['disabledTools'] is List<dynamic>)
          ? (json['disabledTools'] as List<dynamic>).whereType<String>().toList(growable: false)
          : const <String>[],
      systemInfo: rawSystem is Map<String, dynamic>
          ? SystemInfoView.fromJson(rawSystem)
          : null,
      recallEvalNoticeResident: json['recallEvalNoticeResident'] == true,
    );
  }
}

@immutable
class McpServerView {
  const McpServerView({
    required this.id,
    required this.enabled,
    required this.transport,
    this.description,
    this.command,
    this.args = const <String>[],
    this.url,
    this.trustLevel = 'confirm',
    this.timeoutMs = 30000,
    this.status = 'disabled',
    this.toolCount = 0,
    this.tools = const <String>[],
    this.lastError,
  });

  final String id;
  final bool enabled;
  final String transport;
  final String? description;
  final String? command;
  final List<String> args;
  final String? url;
  final String trustLevel;
  final int timeoutMs;
  final String status;
  final int toolCount;
  final List<String> tools;
  final String? lastError;

  factory McpServerView.fromJson(Map<String, dynamic> json) {
    final rawArgs = json['args'];
    final rawTools = json['tools'];
    return McpServerView(
      id: json['id'] as String? ?? '',
      enabled: json['enabled'] != false,
      transport: json['transport'] as String? ?? 'stdio',
      description: json['description'] as String?,
      command: json['command'] as String?,
      args: rawArgs is List<dynamic>
          ? rawArgs.whereType<String>().toList(growable: false)
          : const <String>[],
      url: json['url'] as String?,
      trustLevel: json['trustLevel'] as String? ?? 'confirm',
      timeoutMs: (json['timeoutMs'] as num?)?.toInt() ?? 30000,
      status: json['status'] as String? ?? 'disabled',
      toolCount: (json['toolCount'] as num?)?.toInt() ?? 0,
      tools: rawTools is List<dynamic>
          ? rawTools.whereType<String>().toList(growable: false)
          : const <String>[],
      lastError: json['lastError'] as String?,
    );
  }

  Map<String, dynamic> toConfigJson({bool? overrideEnabled, String? overrideTrustLevel}) => {
        'id': id,
        'enabled': overrideEnabled ?? enabled,
        'transport': transport,
        if (description != null && description!.isNotEmpty) 'description': description,
        if (command != null && command!.isNotEmpty) 'command': command,
        if (args.isNotEmpty) 'args': args,
        if (url != null && url!.isNotEmpty) 'url': url,
        'trustLevel': overrideTrustLevel ?? trustLevel,
        'timeoutMs': timeoutMs,
      };
}

@immutable
class McpPresetView {
  const McpPresetView({
    required this.id,
    required this.label,
    required this.description,
    required this.transport,
    this.command,
    this.args = const <String>[],
    this.env = const <String, String>{},
    this.url,
    this.headers = const <String, String>{},
    this.trustLevel = 'confirm',
    this.secretKeys = const <String>[],
  });

  final String id;
  final String label;
  final String description;
  final String transport;
  final String? command;
  final List<String> args;
  final Map<String, String> env;
  final String? url;
  final Map<String, String> headers;
  final String trustLevel;
  final List<String> secretKeys;

  factory McpPresetView.fromJson(Map<String, dynamic> json) {
    Map<String, String> parseMap(Object? raw) {
      if (raw is! Map<String, dynamic>) return const <String, String>{};
      return {
        for (final e in raw.entries)
          if (e.value is String) e.key: e.value as String,
      };
    }

    final rawArgs = json['args'];
    final rawSecrets = json['secretKeys'];
    return McpPresetView(
      id: json['id'] as String? ?? '',
      label: json['label'] as String? ?? '',
      description: json['description'] as String? ?? '',
      transport: json['transport'] as String? ?? 'stdio',
      command: json['command'] as String?,
      args: rawArgs is List<dynamic>
          ? rawArgs.whereType<String>().toList(growable: false)
          : const <String>[],
      env: parseMap(json['env']),
      url: json['url'] as String?,
      headers: parseMap(json['headers']),
      trustLevel: json['trustLevel'] as String? ?? 'confirm',
      secretKeys: rawSecrets is List<dynamic>
          ? rawSecrets.whereType<String>().toList(growable: false)
          : const <String>[],
    );
  }
}

@immutable
class PendingToolApproval {
  const PendingToolApproval({
    required this.approvalId,
    required this.turnId,
    required this.toolName,
    required this.summary,
    this.arguments = const <String, dynamic>{},
    this.expiresAt = 0,
  });

  final String approvalId;
  final String turnId;
  final String toolName;
  final String summary;
  final Map<String, dynamic> arguments;
  final int expiresAt;

  factory PendingToolApproval.fromJson(Map<String, dynamic> json) {
    final rawArgs = json['arguments'];
    return PendingToolApproval(
      approvalId: json['approvalId'] as String? ?? '',
      turnId: json['turnId'] as String? ?? '',
      toolName: json['toolName'] as String? ?? '',
      summary: json['summary'] as String? ?? '',
      arguments: rawArgs is Map<String, dynamic> ? rawArgs : const <String, dynamic>{},
      expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
    );
  }
}

@immutable
class UsageBucket {
  const UsageBucket({
    this.turnCount = 0,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.cacheReadTokens = 0,
    this.cacheWriteTokens = 0,
    this.cacheHitRate = 0.0,
    this.estimatedCostUsd = 0.0,
  });

  final int turnCount;
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheWriteTokens;
  final double cacheHitRate;
  final double estimatedCostUsd;

  factory UsageBucket.fromJson(Map<String, dynamic> json) {
    return UsageBucket(
      turnCount: (json['turnCount'] as num?)?.toInt() ?? 0,
      inputTokens: (json['inputTokens'] as num?)?.toInt() ?? 0,
      outputTokens: (json['outputTokens'] as num?)?.toInt() ?? 0,
      cacheReadTokens: (json['cacheReadTokens'] as num?)?.toInt() ?? 0,
      cacheWriteTokens: (json['cacheWriteTokens'] as num?)?.toInt() ?? 0,
      cacheHitRate: (json['cacheHitRate'] as num?)?.toDouble() ?? 0.0,
      estimatedCostUsd: (json['estimatedCostUsd'] as num?)?.toDouble() ?? 0.0,
    );
  }
}

@immutable
class DailyUsageEntry {
  const DailyUsageEntry({required this.date, required this.bucket});
  final String date;
  final UsageBucket bucket;

  factory DailyUsageEntry.fromJson(Map<String, dynamic> json) => DailyUsageEntry(
        date: json['date'] as String? ?? '',
        bucket: UsageBucket.fromJson(json),
      );
}

@immutable
class ModelUsageEntry {
  const ModelUsageEntry({required this.model, required this.bucket});
  final String model;
  final UsageBucket bucket;

  factory ModelUsageEntry.fromJson(Map<String, dynamic> json) => ModelUsageEntry(
        model: json['model'] as String? ?? 'unknown',
        bucket: UsageBucket.fromJson(json),
      );
}

@immutable
class UsageStatsSnapshot {
  const UsageStatsSnapshot({
    this.today = const UsageBucket(),
    this.total = const UsageBucket(),
    this.range,
    this.rangeDays,
    this.daily = const <DailyUsageEntry>[],
    this.byModel = const <ModelUsageEntry>[],
  });

  final UsageBucket today;
  final UsageBucket total;
  final UsageBucket? range;
  final int? rangeDays;
  final List<DailyUsageEntry> daily;
  final List<ModelUsageEntry> byModel;

  UsageBucket get activeBucket => range ?? total;

  factory UsageStatsSnapshot.fromJson(Map<String, dynamic> json) {
    final rawToday = json['today'];
    final rawTotal = json['total'];
    final rawRange = json['range'];
    final rawDaily = json['daily'];
    final rawByModel = json['byModel'];
    return UsageStatsSnapshot(
      today: rawToday is Map<String, dynamic>
          ? UsageBucket.fromJson(rawToday)
          : const UsageBucket(),
      total: rawTotal is Map<String, dynamic>
          ? UsageBucket.fromJson(rawTotal)
          : const UsageBucket(),
      range: rawRange is Map<String, dynamic>
          ? UsageBucket.fromJson(rawRange)
          : null,
      rangeDays: (json['rangeDays'] as num?)?.toInt(),
      daily: rawDaily is List<dynamic>
          ? rawDaily
              .whereType<Map<String, dynamic>>()
              .map(DailyUsageEntry.fromJson)
              .toList(growable: false)
          : const <DailyUsageEntry>[],
      byModel: rawByModel is List<dynamic>
          ? rawByModel
              .whereType<Map<String, dynamic>>()
              .map(ModelUsageEntry.fromJson)
              .toList(growable: false)
          : const <ModelUsageEntry>[],
    );
  }
}

@immutable
class LlmTestResult {
  const LlmTestResult({required this.ok, required this.latencyMs, this.error});
  final bool ok;
  final int latencyMs;
  final String? error;

  factory LlmTestResult.fromJson(Map<String, dynamic> json) => LlmTestResult(
        ok: json['ok'] == true,
        latencyMs: (json['latencyMs'] as num?)?.toInt() ?? 0,
        error: json['error'] as String?,
      );
}

@immutable
class NotificationTestResult {
  const NotificationTestResult({
    this.sentChannels = const <String>[],
    this.failedChannels = const <String>[],
    this.suppressedReason,
  });

  final List<String> sentChannels;
  final List<String> failedChannels;
  final String? suppressedReason;

  factory NotificationTestResult.fromJson(Map<String, dynamic> json) {
    List<String> parseList(Object? raw) => raw is List<dynamic>
        ? raw.whereType<String>().toList(growable: false)
        : const <String>[];
    return NotificationTestResult(
      sentChannels: parseList(json['sentChannels']),
      failedChannels: parseList(json['failedChannels']),
      suppressedReason: json['suppressedReason'] as String?,
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
class IssuedPairCodeView {
  const IssuedPairCodeView({
    required this.code,
    required this.expiresAt,
    required this.urls,
    required this.qrPayload,
  });

  final String code;
  final int expiresAt;
  final List<String> urls;
  final String qrPayload;

  factory IssuedPairCodeView.fromJson(Map<String, dynamic> json) {
    final rawUrls = json['urls'];
    final urls = rawUrls is List<dynamic>
        ? rawUrls.whereType<String>().toList(growable: false)
        : const <String>[];
    return IssuedPairCodeView(
      code: json['code'] as String? ?? '',
      expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
      urls: urls,
      qrPayload: json['qrPayload'] as String? ?? '',
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
