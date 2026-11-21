import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../models/models.dart';
import '../network/api_client.dart';
import '../storage/session_storage.dart';

enum ConnectionPhase {
  unpaired,
  connecting,
  connected,
  reconnecting,
}

@immutable
class ActiveTurnState {
  const ActiveTurnState({
    required this.turnId,
    required this.mode,
    this.thinking = '',
    this.text = '',
    this.latestExpression,
    this.tools = const <ToolProgressItem>[],
  });

  final String turnId;
  final String mode;
  final String thinking;
  final String text;
  final ExpressionPayload? latestExpression;
  final List<ToolProgressItem> tools;

  ActiveTurnState copyWith({
    String? thinking,
    String? text,
    ExpressionPayload? latestExpression,
    List<ToolProgressItem>? tools,
  }) {
    return ActiveTurnState(
      turnId: turnId,
      mode: mode,
      thinking: thinking ?? this.thinking,
      text: text ?? this.text,
      latestExpression: latestExpression ?? this.latestExpression,
      tools: tools ?? this.tools,
    );
  }
}

/// 客户端状态协调器：
/// 按连接态、门状态、时间线、流式轮次、具身表达、设置与活跃活动独立隔离刷新，
/// 避免高频 turn.text 触发整页重绘；切后台静默中止连接，回前台合并重连绝不弹红条。
class AppController {
  AppController({
    required PsyberApiClient api,
    required SessionStorage storage,
    Duration offlineHintDelay = const Duration(seconds: 5),
    List<Duration> reconnectBackoff = const [
      Duration(seconds: 2),
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 30),
    ],
  })  : _api = api,
        _storage = storage,
        _offlineHintDelay = offlineHintDelay,
        _reconnectBackoff = reconnectBackoff;

  final PsyberApiClient _api;
  final SessionStorage _storage;
  final Duration _offlineHintDelay;
  final List<Duration> _reconnectBackoff;
  final Random _random = Random();

  final ValueNotifier<ConnectionProfile?> profileNotifier =
      ValueNotifier<ConnectionProfile?>(null);
  final ValueNotifier<GenesisStatus?> genesisNotifier =
      ValueNotifier<GenesisStatus?>(null);
  final ValueNotifier<ConnectionPhase> connectionNotifier =
      ValueNotifier<ConnectionPhase>(ConnectionPhase.unpaired);
  final ValueNotifier<bool> showReconnectingHintNotifier =
      ValueNotifier<bool>(false);
  final ValueNotifier<DoorStatus> doorNotifier =
      ValueNotifier<DoorStatus>(DoorStatus.initial);
  final ValueNotifier<List<TimelineItem>> timelineNotifier =
      ValueNotifier<List<TimelineItem>>(const <TimelineItem>[]);
  final ValueNotifier<ActiveTurnState?> activeTurnNotifier =
      ValueNotifier<ActiveTurnState?>(null);
  final ValueNotifier<ExpressionPayload?> expressionNotifier =
      ValueNotifier<ExpressionPayload?>(null);
  final ValueNotifier<String?> turnErrorNotifier = ValueNotifier<String?>(null);
  final ValueNotifier<TurnFailureState?> turnFailureNotifier =
      ValueNotifier<TurnFailureState?>(null);
  final ValueNotifier<TurnSilenceNotice?> turnSilenceNotifier =
      ValueNotifier<TurnSilenceNotice?>(null);
  final ValueNotifier<ContextUsageInfo?> contextUsageNotifier =
      ValueNotifier<ContextUsageInfo?>(null);
  final ValueNotifier<bool> retryingTurnNotifier = ValueNotifier<bool>(false);
  final ValueNotifier<bool> wrappingUpNotifier = ValueNotifier<bool>(false);
  final ValueNotifier<String?> pendingModelSwitchNotifier =
      ValueNotifier<String?>(null);
  final ValueNotifier<SettingsSnapshot?> settingsNotifier =
      ValueNotifier<SettingsSnapshot?>(null);
  final ValueNotifier<ActivitySessionView?> activeActivityNotifier =
      ValueNotifier<ActivitySessionView?>(null);

  /// NG-4：召回评测浮条默认关闭，仅在用户主动开启评测模式后呈现。
  final ValueNotifier<bool> recallEvalModeNotifier = ValueNotifier<bool>(false);

  /// 外观日夜模式：默认跟随系统，支持随时手动切换。
  final ValueNotifier<ThemeMode> themeModeNotifier =
      ValueNotifier<ThemeMode>(ThemeMode.system);

  void setThemeMode(ThemeMode mode) {
    themeModeNotifier.value = mode;
  }

  StreamSubscription<SseEventFrame>? _sseSub;
  Timer? _reconnectTimer;
  Timer? _offlineHintTimer;
  int _reconnectAttempt = 0;
  bool _isPaused = false;
  bool _disposed = false;
  bool _hasMoreHistory = false;
  bool _hasLoadedOlder = false;
  String? _nextBeforeId;
  String? _lastStreamSeq;

  bool get hasMoreHistory => _hasMoreHistory;

  Future<String> loadDraft() => _storage.loadDraft();

  Future<void> saveDraft(String draft) => _storage.saveDraft(draft);

  Future<void> initialize() async {
    final saved = await _storage.load();
    if (_disposed) return;
    if (saved == null) {
      connectionNotifier.value = ConnectionPhase.unpaired;
      return;
    }
    profileNotifier.value = saved;
    unawaited(connectAndSync());
  }

  /// 首次通过一次性配对码绑定后端并落盘长期 Token + instanceId。
  Future<void> pairAndConnect({
    required String baseUrl,
    required String code,
    required String deviceName,
    required String platform,
  }) async {
    final profile = await _api.pair(
      baseUrl: baseUrl,
      code: code,
      deviceName: deviceName,
      platform: platform,
    );
    await _storage.save(profile);
    if (_disposed) return;
    profileNotifier.value = profile;
    await connectAndSync();
  }

  Future<void> completeGenesis({
    String? residentName,
    String? userName,
    required String timezone,
    String? sleepStart,
    String? sleepEnd,
    String? providerKind,
    String? baseUrl,
    String? modelName,
    String? apiKey,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.submitGenesis(
      profile,
      residentName: residentName,
      userName: userName,
      timezone: timezone,
      sleepStart: sleepStart,
      sleepEnd: sleepEnd,
      providerKind: providerKind,
      baseUrl: baseUrl,
      modelName: modelName,
      apiKey: apiKey,
    );
    if (_disposed) return;
    genesisNotifier.value = await _api.getGenesis(profile);
    await refreshSnapshot();
    unawaited(loadSettings());
  }

  Future<SettingsSnapshot?> loadSettings() async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    try {
      final snap = await _api.getSettings(profile);
      if (!_disposed) settingsNotifier.value = snap;
      return snap;
    } on ApiException {
      return settingsNotifier.value;
    } catch (_) {
      return settingsNotifier.value;
    }
  }

  Future<SettingsSnapshot?> patchSettings(Map<String, dynamic> patch) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    final snap = await _api.updateSettings(profile, patch);
    if (_disposed) return snap;
    settingsNotifier.value = snap;
    turnErrorNotifier.value = null;
    return snap;
  }

  Future<void> updateLlmSettings({
    required String providerKind,
    required String modelName,
    String? baseUrl,
    String? apiKey,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.updateLlmSettings(
      profile,
      providerKind: providerKind,
      modelName: modelName,
      baseUrl: baseUrl,
      apiKey: apiKey,
    );
    if (_disposed) return;
    turnErrorNotifier.value = null;
    unawaited(loadSettings());
  }

  Future<void> revokeOtherDevice(String deviceId) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final snap = await _api.updateSettings(profile, {
      'revokeDeviceIds': [deviceId],
    });
    if (!_disposed) {
      settingsNotifier.value = snap;
    }
  }

  /// 断开当前连接并清除本地凭证，返回配对页。
  Future<void> disconnect({bool notifyServer = true}) async {
    final profile = profileNotifier.value;
    if (notifyServer && profile != null && profile.deviceId.isNotEmpty) {
      try {
        await _api.revokeDevice(profile, profile.deviceId);
      } catch (_) {
        // 网络不通或服务端已停机时静默忽略，优先保证客户端本地清空返回配对
      }
    }
    _cancelSseAndTimers();
    await _storage.clear();
    if (_disposed) return;
    profileNotifier.value = null;
    genesisNotifier.value = null;
    connectionNotifier.value = ConnectionPhase.unpaired;
    showReconnectingHintNotifier.value = false;
    timelineNotifier.value = const <TimelineItem>[];
    doorNotifier.value = DoorStatus.initial;
    activeTurnNotifier.value = null;
    turnErrorNotifier.value = null;
    turnFailureNotifier.value = null;
    turnSilenceNotifier.value = null;
    contextUsageNotifier.value = null;
    pendingModelSwitchNotifier.value = null;
    settingsNotifier.value = null;
    activeActivityNotifier.value = null;
    _hasLoadedOlder = false;
    _hasMoreHistory = false;
    _nextBeforeId = null;
    _lastStreamSeq = null;
  }

  /// 建连并按契约拉取 /genesis、/chat/history、/door 与 /settings 补齐状态。
  Future<void> connectAndSync() async {
    final profile = profileNotifier.value;
    if (profile == null || _disposed || _isPaused) return;

    _cancelSseAndTimers();
    connectionNotifier.value = ConnectionPhase.connecting;

    try {
      final health = await _api.checkHealth(profile.baseUrl);
      if (_disposed || _isPaused) return;
      if (profile.instanceId.isNotEmpty &&
          health.instanceId.isNotEmpty &&
          health.instanceId != profile.instanceId) {
        turnErrorNotifier.value = '当前地址对应的实例 ID 与配对记录不一致，请检查后端地址';
        connectionNotifier.value = ConnectionPhase.reconnecting;
        return;
      }

      final genesis = await _api.getGenesis(profile);
      if (_disposed || _isPaused) return;
      genesisNotifier.value = genesis;

      await refreshSnapshot();
      if (_disposed || _isPaused) return;

      activeTurnNotifier.value = null;
      unawaited(loadSettings());
      unawaited(_refreshActivitySlot(profile));

      _reconnectAttempt = 0;
      _offlineHintTimer?.cancel();
      showReconnectingHintNotifier.value = false;
      connectionNotifier.value = ConnectionPhase.connected;
      _startSse(profile);
    } on CanceledException {
      // 预期内取消，静默忽略
    } catch (_) {
      if (_disposed || _isPaused) return;
      _scheduleReconnect();
    }
  }

  Future<void> _refreshActivitySlot(ConnectionProfile profile) async {
    try {
      final session = await _api.getActiveActivity(profile);
      if (_disposed) return;
      activeActivityNotifier.value =
          (session != null && !session.isEnded) ? session : null;
    } catch (_) {
      // Ring 1 后端未挂载 /activities 或网络抖动时静默忽略
    }
  }

  Future<void> refreshSnapshot() async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final results = await Future.wait<Object>([
      _api.getDoor(profile),
      _api.getHistory(profile, limit: 50),
    ]);
    if (_disposed) return;
    doorNotifier.value = results[0] as DoorStatus;
    final page = results[1] as HistoryPage;
    if (page.contextUsage != null) {
      contextUsageNotifier.value = page.contextUsage;
    }
    if (_hasLoadedOlder && page.items.isNotEmpty) {
      final latestMinSeq = page.items.first.seq;
      final latestIds = page.items.map((e) => e.id).toSet();
      final preservedOlder = timelineNotifier.value
          .where((e) => e.seq < latestMinSeq && !latestIds.contains(e.id));
      final merged = <TimelineItem>[...preservedOlder, ...page.items]
        ..sort((a, b) => a.seq.compareTo(b.seq));
      timelineNotifier.value = List<TimelineItem>.unmodifiable(merged);
      return;
    }
    _hasMoreHistory = page.hasMore;
    _nextBeforeId = page.nextBefore;
    timelineNotifier.value = List<TimelineItem>.unmodifiable(page.items);
  }

  Future<void> loadOlderHistory() async {
    final profile = profileNotifier.value;
    if (profile == null || !_hasMoreHistory || _nextBeforeId == null) return;
    final page = await _api.getHistory(profile, beforeId: _nextBeforeId, limit: 50);
    if (_disposed) return;
    _hasLoadedOlder = true;
    _hasMoreHistory = page.hasMore;
    _nextBeforeId = page.nextBefore;
    final existingIds = timelineNotifier.value.map((e) => e.id).toSet();
    final merged = <TimelineItem>[
      ...page.items.where((item) => !existingIds.contains(item.id)),
      ...timelineNotifier.value,
    ];
    timelineNotifier.value = List<TimelineItem>.unmodifiable(merged);
  }

  /// App 切后台：主动静默中止 SSE，绝不触发红色错误条。
  void onAppPaused() {
    _isPaused = true;
    _cancelSseAndTimers();
  }

  /// App 切回前台：合并为单次静默重连并拉取最新历史与门状态。
  void onAppResumed() {
    if (!_isPaused) return;
    _isPaused = false;
    _reconnectAttempt = 0;
    if (profileNotifier.value != null) {
      unawaited(connectAndSync());
    }
  }

  Future<UploadedMedia?> uploadImage({
    required List<int> bytes,
    required String filename,
    required String mimeType,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.uploadMedia(
      profile,
      bytes: bytes,
      filename: filename,
      mimeType: mimeType,
    );
  }

  Future<List<StickerView>> loadStickers() async {
    final profile = profileNotifier.value;
    if (profile == null) return const <StickerView>[];
    return _api.listStickers(profile);
  }

  Future<StickerView?> uploadSticker({
    required List<int> bytes,
    required String filename,
    required String mimeType,
    required String id,
    required String label,
    String pack = 'default',
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.uploadSticker(
      profile,
      bytes: bytes,
      filename: filename,
      mimeType: mimeType,
      id: id,
      label: label,
      pack: pack,
    );
  }

  Future<SendMessageResult?> sendMessage(
    String rawText, {
    List<String>? attachments,
    String? stickerId,
    VideoClipInfo? videoClip,
  }) async {
    final profile = profileNotifier.value;
    final text = rawText.trim();
    final hasAttachments = attachments != null && attachments.isNotEmpty;
    final hasSticker = stickerId != null && stickerId.trim().isNotEmpty;
    final hasVideo = videoClip != null && videoClip.frameHashes.isNotEmpty;
    if (profile == null ||
        (text.isEmpty && !hasAttachments && !hasSticker && !hasVideo)) {
      return null;
    }

    turnErrorNotifier.value = null;
    turnFailureNotifier.value = null;
    turnSilenceNotifier.value = null;
    final clientMessageId = _generateClientMessageId();
    final res = await _api.sendMessage(
      profile,
      clientMessageId: clientMessageId,
      content: text,
      attachments: attachments,
      stickerId: hasSticker ? stickerId.trim() : null,
      videoClip: videoClip,
    );
    if (_disposed) return res;
    _upsertTimelineItem(res.message);
    if (res.deliveredAs == 'door_note') {
      doorNotifier.value = doorNotifier.value.copyWith(
        unreadDoorNotes: doorNotifier.value.unreadDoorNotes + 1,
      );
    }
    return res;
  }

  /// 失败轮次原地无痕重试（不重复插入用户消息）。
  Future<void> retryFailedTurn() async {
    final profile = profileNotifier.value;
    final failure = turnFailureNotifier.value;
    final turnId = failure?.turnId;
    if (profile == null || turnId == null || turnId.isEmpty || retryingTurnNotifier.value) {
      return;
    }
    retryingTurnNotifier.value = true;
    try {
      await _api.retryTurn(profile, turnId);
      if (!_disposed) {
        turnFailureNotifier.value = null;
        turnErrorNotifier.value = null;
      }
    } on ApiException catch (e) {
      if (!_disposed) {
        turnFailureNotifier.value = TurnFailureState(
          turnId: turnId,
          code: e.code,
          message: e.message,
          retryable: e.statusCode >= 500 || e.code == 'RATE_LIMITED',
        );
      }
    } catch (_) {
      if (!_disposed) {
        turnErrorNotifier.value = '重试失败，请检查网络连接';
      }
    } finally {
      if (!_disposed) {
        retryingTurnNotifier.value = false;
      }
    }
  }

  /// 手动触发「存记忆换段」：立即切新 session_id 并将旧对话送去后台异步整理。
  Future<WrapUpResult?> wrapUpMemorySession() async {
    final profile = profileNotifier.value;
    if (profile == null || wrappingUpNotifier.value) return null;
    wrappingUpNotifier.value = true;
    try {
      final res = await _api.wrapUpSession(profile);
      if (_disposed) return res;
      final cur = contextUsageNotifier.value;
      contextUsageNotifier.value = ContextUsageInfo(
        usedTokens: 0,
        limitTokens: cur?.limitTokens ?? 150000,
        ratio: 0.0,
      );
      unawaited(refreshSnapshot());
      return res;
    } finally {
      if (!_disposed) {
        wrappingUpNotifier.value = false;
      }
    }
  }

  Future<void> deleteMessage(String messageId) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.deleteMessage(profile, messageId);
    if (_disposed) return;
    timelineNotifier.value = List<TimelineItem>.unmodifiable(
      timelineNotifier.value.where((e) => e.id != messageId),
    );
  }

  Future<void> editMessage(String messageId, String newContent) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final updated = await _api.editMessage(profile, messageId, newContent);
    if (_disposed) return;
    if (updated.id.isNotEmpty) {
      _upsertTimelineItem(updated);
    }
    await refreshSnapshot();
  }

  Future<void> rerollMessage(String messageId) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.rerollMessage(profile, messageId);
  }

  Future<void> switchMessageVersion(String messageId, int version) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final activated = await _api.switchMessageVersion(profile, messageId, version);
    if (_disposed) return;
    if (activated.id.isNotEmpty) {
      _upsertTimelineItem(activated);
    }
  }

  Future<void> endActiveCinema() async {
    final profile = profileNotifier.value;
    final session = activeActivityNotifier.value;
    if (profile == null || session == null) return;
    await _api.endCinemaActivity(profile, sessionId: session.id);
    if (!_disposed) {
      activeActivityNotifier.value = null;
    }
  }

  Future<List<DrawerEntryView>> listDrawer() async {
    final profile = profileNotifier.value;
    if (profile == null) return const <DrawerEntryView>[];
    return _api.listDrawer(profile);
  }

  Future<DrawerOpenedContent?> openDrawerEntry(String id) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.openDrawerEntry(profile, id);
  }

  Future<void> abortActiveTurn() async {
    final profile = profileNotifier.value;
    final active = activeTurnNotifier.value;
    if (profile == null || active == null) return;
    activeTurnNotifier.value = null;
    try {
      await _api.abortTurn(profile, active.turnId);
    } catch (_) {
      // 容错忽略网络异常
    }
    unawaited(refreshSnapshot());
  }

  Future<List<RecallTraceItem>> loadTurnRecall(String turnId) async {
    final profile = profileNotifier.value;
    if (profile == null) return const <RecallTraceItem>[];
    return _api.getTurnRecall(profile, turnId);
  }

  Future<void> submitRecallFeedback({
    required String turnId,
    required String verdict,
    String? cardPath,
    String? note,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.submitRecallFeedback(
      profile,
      turnId: turnId,
      verdict: verdict,
      cardPath: cardPath,
      note: note,
    );
  }

  void toggleRecallEvalMode(bool enabled) {
    recallEvalModeNotifier.value = enabled;
  }

  void _startSse(ConnectionProfile profile) {
    _sseSub = _api
        .openEventStream(
          profile,
          foreground: true,
          lastEventId: _lastStreamSeq,
        )
        .listen(
      _handleSseFrame,
      onError: (Object err) {
        if (_disposed || _isPaused || err is CanceledException) return;
        _scheduleReconnect();
      },
      onDone: () {
        if (_disposed || _isPaused) return;
        _scheduleReconnect();
      },
    );
  }

  void _handleSseFrame(SseEventFrame frame) {
    if (_disposed) return;
    if (frame.id != null && frame.id!.isNotEmpty) {
      _lastStreamSeq = frame.id;
    }
    switch (frame.event) {
      case 'ping':
        return;
      case 'message.created':
        final rawMsg = frame.data['message'];
        if (rawMsg is Map<String, dynamic>) {
          _upsertTimelineItem(TimelineItem.fromJson(rawMsg));
        }
        return;
      case 'message.updated':
        final action = frame.data['action'] as String?;
        if (action == 'delete') {
          final deletedId = frame.data['deletedId'] as String?;
          if (deletedId != null) {
            timelineNotifier.value = List<TimelineItem>.unmodifiable(
              timelineNotifier.value.where((e) => e.id != deletedId),
            );
          }
        } else {
          final rawMsg = frame.data['message'];
          if (rawMsg is Map<String, dynamic>) {
            final item = TimelineItem.fromJson(rawMsg);
            // 版本切换或编辑时替换同 groupId 的旧展示项
            if (item.groupId != null) {
              final list = List<TimelineItem>.from(timelineNotifier.value);
              list.removeWhere(
                (e) => e.groupId == item.groupId && e.role == item.role && e.id != item.id,
              );
              timelineNotifier.value = List<TimelineItem>.unmodifiable(list);
            }
            _upsertTimelineItem(item);
          }
        }
        return;
      case 'door.updated':
        final nextState = DoorState.fromWire(frame.data['state'] as String?);
        final rawUnread = frame.data['unreadDoorNotes'];
        final nextUnread = rawUnread is num
            ? rawUnread.toInt()
            : (nextState == DoorState.open
                ? 0
                : doorNotifier.value.unreadDoorNotes);
        doorNotifier.value = doorNotifier.value.copyWith(
          state: nextState,
          note: frame.data['note'] as String?,
          clearNote: frame.data['note'] == null,
          updatedAt: (frame.data['updatedAt'] as num?)?.toInt() ??
              doorNotifier.value.updatedAt,
          unreadDoorNotes: nextUnread,
          coolingOffStartedAt:
              (frame.data['coolingOffStartedAt'] as num?)?.toInt(),
          departedAt: (frame.data['departedAt'] as num?)?.toInt(),
          farewell: frame.data['farewell'] as String?,
        );
        return;
      case 'turn.start':
        final turnId = frame.data['turnId'] as String? ?? '';
        final mode = frame.data['mode'] as String? ?? 'chat';
        turnErrorNotifier.value = null;
        turnFailureNotifier.value = null;
        turnSilenceNotifier.value = null;
        activeTurnNotifier.value = ActiveTurnState(turnId: turnId, mode: mode);
        return;
      case 'turn.thinking':
        final current = activeTurnNotifier.value;
        final delta = frame.data['delta'] as String? ?? '';
        if (current != null && delta.isNotEmpty) {
          activeTurnNotifier.value = current.copyWith(
            thinking: current.thinking + delta,
          );
        }
        return;
      case 'turn.tool':
        final current = activeTurnNotifier.value;
        if (current != null) {
          final tool = ToolProgressItem.fromJson(frame.data);
          final nextTools = List<ToolProgressItem>.from(current.tools);
          final idx = nextTools.indexWhere(
            (t) => t.callId.isNotEmpty && t.callId == tool.callId,
          );
          if (idx >= 0) {
            nextTools[idx] = tool;
          } else {
            nextTools.add(tool);
          }
          activeTurnNotifier.value = current.copyWith(tools: nextTools);
        }
        return;
      case 'turn.text':
        final current = activeTurnNotifier.value;
        final delta = frame.data['delta'] as String? ?? '';
        if (current != null && delta.isNotEmpty) {
          activeTurnNotifier.value = current.copyWith(
            text: current.text + delta,
          );
        }
        return;
      case 'turn.expression':
        final payload = ExpressionPayload.fromJson(frame.data);
        expressionNotifier.value = payload;
        final current = activeTurnNotifier.value;
        if (current != null) {
          activeTurnNotifier.value = current.copyWith(latestExpression: payload);
        }
        return;
      case 'turn.error':
        final errTurnId = frame.data['turnId'] as String?;
        final errCode = frame.data['code'] as String? ?? 'PROVIDER_ERROR';
        final errMsg =
            frame.data['message'] as String? ?? '生成遇到了一点问题，请稍后重试';
        final retryable = frame.data['retryable'] != false;
        if (errTurnId != null && errTurnId.isNotEmpty) {
          turnFailureNotifier.value = TurnFailureState(
            turnId: errTurnId,
            code: errCode,
            message: errMsg,
            retryable: retryable,
          );
          turnErrorNotifier.value = null;
        } else {
          turnErrorNotifier.value = errMsg;
        }
        activeTurnNotifier.value = null;
        return;
      case 'turn.silence':
        turnSilenceNotifier.value = TurnSilenceNotice(
          turnId: frame.data['turnId'] as String? ?? 'silence',
          ownTime: frame.data['ownTime'] == true,
          createdAt: DateTime.now().millisecondsSinceEpoch,
        );
        activeTurnNotifier.value = null;
        return;
      case 'turn.model_switched':
        final nextModel = frame.data['model'] as String?;
        if (nextModel != null && nextModel.isNotEmpty) {
          pendingModelSwitchNotifier.value = nextModel;
        }
        return;
      case 'turn.done':
        final rawUsage = frame.data['contextUsage'];
        if (rawUsage is Map<String, dynamic>) {
          contextUsageNotifier.value = ContextUsageInfo.fromJson(rawUsage);
        }
        turnFailureNotifier.value = null;
        pendingModelSwitchNotifier.value = null;
        activeTurnNotifier.value = null;
        // 补齐最新落盘的助手消息与门状态（确保 recallCount 与持久化 ID 精确一致）
        unawaited(refreshSnapshot());
        return;
      case 'activity.updated':
        final rawSession = frame.data['session'];
        if (rawSession is Map<String, dynamic>) {
          final parsed = ActivitySessionView.fromJson(rawSession);
          activeActivityNotifier.value = parsed.isEnded ? null : parsed;
        } else {
          activeActivityNotifier.value = null;
        }
        return;
      case 'sync.reset':
        final latestSeq = frame.data['latestStreamSeq'];
        if (latestSeq != null) {
          _lastStreamSeq = '$latestSeq';
        }
        unawaited(refreshSnapshot());
        return;
    }
  }

  void _upsertTimelineItem(TimelineItem item) {
    if (item.id.isEmpty) return;
    final list = List<TimelineItem>.from(timelineNotifier.value);
    final idx = list.indexWhere((e) => e.id == item.id);
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.add(item);
      list.sort((a, b) => a.seq.compareTo(b.seq));
    }
    timelineNotifier.value = List<TimelineItem>.unmodifiable(list);
  }

  void _scheduleReconnect() {
    if (_disposed || _isPaused || profileNotifier.value == null) return;
    connectionNotifier.value = ConnectionPhase.reconnecting;
    _offlineHintTimer ??= Timer(_offlineHintDelay, () {
      if (!_disposed &&
          !_isPaused &&
          connectionNotifier.value == ConnectionPhase.reconnecting) {
        showReconnectingHintNotifier.value = true;
      }
    });
    final idx = _reconnectAttempt.clamp(0, _reconnectBackoff.length - 1);
    final delay = _reconnectBackoff[idx];
    _reconnectAttempt += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      unawaited(connectAndSync());
    });
  }

  void _cancelSseAndTimers() {
    unawaited(_sseSub?.cancel());
    _sseSub = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _offlineHintTimer?.cancel();
    _offlineHintTimer = null;
  }

  String _generateClientMessageId() {
    final ts = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    final rand = _random.nextInt(1 << 30).toRadixString(36);
    return 'cm_${ts}_$rand';
  }

  void dispose() {
    _disposed = true;
    _cancelSseAndTimers();
    profileNotifier.dispose();
    genesisNotifier.dispose();
    connectionNotifier.dispose();
    showReconnectingHintNotifier.dispose();
    doorNotifier.dispose();
    timelineNotifier.dispose();
    activeTurnNotifier.dispose();
    expressionNotifier.dispose();
    turnErrorNotifier.dispose();
    turnFailureNotifier.dispose();
    turnSilenceNotifier.dispose();
    contextUsageNotifier.dispose();
    retryingTurnNotifier.dispose();
    wrappingUpNotifier.dispose();
    pendingModelSwitchNotifier.dispose();
    settingsNotifier.dispose();
    activeActivityNotifier.dispose();
    recallEvalModeNotifier.dispose();
    themeModeNotifier.dispose();
  }
}
