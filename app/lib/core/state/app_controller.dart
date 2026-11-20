import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

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
  });

  final String turnId;
  final String mode;
  final String thinking;
  final String text;
  final ExpressionPayload? latestExpression;

  ActiveTurnState copyWith({
    String? thinking,
    String? text,
    ExpressionPayload? latestExpression,
  }) {
    return ActiveTurnState(
      turnId: turnId,
      mode: mode,
      thinking: thinking ?? this.thinking,
      text: text ?? this.text,
      latestExpression: latestExpression ?? this.latestExpression,
    );
  }
}

/// Ring 1 客户端状态协调器：
/// 按连接态、门状态、时间线、流式轮次、具身表达 5 个独立 ValueNotifier 隔离刷新，
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

  /// NG-4：召回评测浮条默认关闭，仅在用户主动开启评测模式后呈现。
  final ValueNotifier<bool> recallEvalModeNotifier = ValueNotifier<bool>(false);

  StreamSubscription<SseEventFrame>? _sseSub;
  Timer? _reconnectTimer;
  Timer? _offlineHintTimer;
  int _reconnectAttempt = 0;
  bool _isPaused = false;
  bool _disposed = false;
  bool _hasMoreHistory = false;
  String? _nextBeforeId;

  bool get hasMoreHistory => _hasMoreHistory;

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
  }

  /// 建连并按 Ring 1 契约拉取 /genesis、/chat/history 与 /door 补齐状态。
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
    _hasMoreHistory = page.hasMore;
    _nextBeforeId = page.nextBefore;
    timelineNotifier.value = List<TimelineItem>.unmodifiable(page.items);
  }

  Future<void> loadOlderHistory() async {
    final profile = profileNotifier.value;
    if (profile == null || !_hasMoreHistory || _nextBeforeId == null) return;
    final page = await _api.getHistory(profile, beforeId: _nextBeforeId, limit: 50);
    if (_disposed) return;
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

  Future<SendMessageResult?> sendMessage(
    String rawText, {
    List<String>? attachments,
    String? stickerId,
  }) async {
    final profile = profileNotifier.value;
    final text = rawText.trim();
    final hasAttachments = attachments != null && attachments.isNotEmpty;
    final hasSticker = stickerId != null && stickerId.trim().isNotEmpty;
    if (profile == null || (text.isEmpty && !hasAttachments && !hasSticker)) {
      return null;
    }

    turnErrorNotifier.value = null;
    final clientMessageId = _generateClientMessageId();
    final res = await _api.sendMessage(
      profile,
      clientMessageId: clientMessageId,
      content: text,
      attachments: attachments,
      stickerId: hasSticker ? stickerId.trim() : null,
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

  Future<void> deleteMessage(String messageId) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.deleteMessage(profile, messageId);
    if (_disposed) return;
    timelineNotifier.value = List<TimelineItem>.unmodifiable(
      timelineNotifier.value.where((e) => e.id != messageId),
    );
  }

  Future<void> abortActiveTurn() async {
    final profile = profileNotifier.value;
    final active = activeTurnNotifier.value;
    if (profile == null || active == null) return;
    await _api.abortTurn(profile, active.turnId);
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
    _sseSub = _api.openEventStream(profile, foreground: true).listen(
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
        if (frame.data['action'] == 'delete') {
          final deletedId = frame.data['deletedId'] as String?;
          if (deletedId != null) {
            timelineNotifier.value = List<TimelineItem>.unmodifiable(
              timelineNotifier.value.where((e) => e.id != deletedId),
            );
          }
        } else {
          final rawMsg = frame.data['message'];
          if (rawMsg is Map<String, dynamic>) {
            _upsertTimelineItem(TimelineItem.fromJson(rawMsg));
          }
        }
        return;
      case 'door.updated':
        doorNotifier.value = doorNotifier.value.copyWith(
          state: DoorState.fromWire(frame.data['state'] as String?),
          note: frame.data['note'] as String?,
          clearNote: frame.data['note'] == null,
          updatedAt: (frame.data['updatedAt'] as num?)?.toInt() ??
              doorNotifier.value.updatedAt,
        );
        return;
      case 'turn.start':
        final turnId = frame.data['turnId'] as String? ?? '';
        final mode = frame.data['mode'] as String? ?? 'chat';
        turnErrorNotifier.value = null;
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
        turnErrorNotifier.value =
            frame.data['message'] as String? ?? '生成遇到了一点问题，请稍后重试';
        activeTurnNotifier.value = null;
        return;
      case 'turn.done':
        activeTurnNotifier.value = null;
        // 补齐最新落盘的助手消息与门状态（确保 recallCount 与持久化 ID 精确一致）
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
    recallEvalModeNotifier.dispose();
  }
}
