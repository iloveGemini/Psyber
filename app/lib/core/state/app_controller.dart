import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../shared/theme.dart';
import '../models/models.dart';
import '../network/api_client.dart';
import '../network/lan_discovery.dart';
import '../notifications/local_notifier.dart';
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
    this.journalSteps = const <TurnJournalStep>[],
  });

  final String turnId;
  final String mode;
  final String thinking;
  final String text;
  final ExpressionPayload? latestExpression;
  final List<ToolProgressItem> tools;
  final List<TurnJournalStep> journalSteps;

  ActiveTurnState copyWith({
    String? thinking,
    String? text,
    ExpressionPayload? latestExpression,
    List<ToolProgressItem>? tools,
    List<TurnJournalStep>? journalSteps,
  }) {
    return ActiveTurnState(
      turnId: turnId,
      mode: mode,
      thinking: thinking ?? this.thinking,
      text: text ?? this.text,
      latestExpression: latestExpression ?? this.latestExpression,
      tools: tools ?? this.tools,
      journalSteps: journalSteps ?? this.journalSteps,
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
    LocalNotificationSender? localNotifier,
    LanDiscoveryService? lanDiscovery,
    Future<LocalPairHint?> Function()? localPairHintLoader,
    Duration offlineHintDelay = const Duration(seconds: 5),
    List<Duration> reconnectBackoff = const [
      Duration(seconds: 2),
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 30),
    ],
  })  : _api = api,
        _storage = storage,
        _localNotifier = localNotifier,
        _lanDiscovery = lanDiscovery ?? const UdpLanDiscoveryService(),
        _localPairHintLoader = localPairHintLoader ?? readLocalDesktopPairHint,
        _offlineHintDelay = offlineHintDelay,
        _reconnectBackoff = reconnectBackoff;

  final PsyberApiClient _api;
  final SessionStorage _storage;
  final LocalNotificationSender? _localNotifier;
  final LanDiscoveryService _lanDiscovery;
  final Future<LocalPairHint?> Function() _localPairHintLoader;
  final Duration _offlineHintDelay;
  final List<Duration> _reconnectBackoff;
  final Random _random = Random();
  bool _manuallyDisconnected = false;

  final ValueNotifier<ConnectionProfile?> profileNotifier =
      ValueNotifier<ConnectionProfile?>(null);
  final ValueNotifier<GenesisStatus?> genesisNotifier =
      ValueNotifier<GenesisStatus?>(null);
  final ValueNotifier<IdentityInfo> identityNotifier =
      ValueNotifier<IdentityInfo>(IdentityInfo.empty);
  final ValueNotifier<ConnectionPhase> connectionNotifier =
      ValueNotifier<ConnectionPhase>(ConnectionPhase.unpaired);
  final ValueNotifier<bool> showReconnectingHintNotifier =
      ValueNotifier<bool>(false);
  final ValueNotifier<DoorStatus> doorNotifier =
      ValueNotifier<DoorStatus>(DoorStatus.initial);
  final ValueNotifier<UserStatus> userStatusNotifier =
      ValueNotifier<UserStatus>(UserStatus.initial);
  final ValueNotifier<List<TimelineItem>> timelineNotifier =
      ValueNotifier<List<TimelineItem>>(const <TimelineItem>[]);
  final ValueNotifier<ActiveTurnState?> activeTurnNotifier =
      ValueNotifier<ActiveTurnState?>(null);
  final ValueNotifier<ExpressionPayload?> expressionNotifier =
      ValueNotifier<ExpressionPayload?>(null);
  final ValueNotifier<String?> turnErrorNotifier = ValueNotifier<String?>(null);
  final ValueNotifier<bool> instanceMismatchNotifier = ValueNotifier<bool>(false);
  final ValueNotifier<TurnFailureState?> turnFailureNotifier =
      ValueNotifier<TurnFailureState?>(null);
  final ValueNotifier<TurnSilenceNotice?> turnSilenceNotifier =
      ValueNotifier<TurnSilenceNotice?>(null);
  final ValueNotifier<ContextUsageInfo?> contextUsageNotifier =
      ValueNotifier<ContextUsageInfo?>(null);
  final ValueNotifier<bool> retryingTurnNotifier = ValueNotifier<bool>(false);
  final ValueNotifier<bool> wrappingUpNotifier = ValueNotifier<bool>(false);
  bool _manualWrapUpInFlight = false;
  final ValueNotifier<String?> pendingModelSwitchNotifier =
      ValueNotifier<String?>(null);
  final ValueNotifier<SettingsSnapshot?> settingsNotifier =
      ValueNotifier<SettingsSnapshot?>(null);
  final ValueNotifier<ActivitySessionView?> activeActivityNotifier =
      ValueNotifier<ActivitySessionView?>(null);
  final ValueNotifier<CinemaBridgeInfo?> cinemaBridgeNotifier =
      ValueNotifier<CinemaBridgeInfo?>(null);

  /// NG-4：召回评测浮条默认关闭，仅在用户主动开启评测模式后呈现。
  final ValueNotifier<bool> recallEvalModeNotifier = ValueNotifier<bool>(false);

  /// 外观日夜模式：默认跟随系统，支持随时手动切换。
  final ValueNotifier<ThemeMode> themeModeNotifier =
      ValueNotifier<ThemeMode>(ThemeMode.system);

  /// 日间首选阅读色板（跟随系统浅色或手动浅色时启用并持久化）。
  final ValueNotifier<PsyberPalette> lightPaletteNotifier =
      ValueNotifier<PsyberPalette>(PsyberPalette.warmPaper);

  /// 夜间首选阅读色板（跟随系统深色或手动深色时启用并持久化）。
  final ValueNotifier<PsyberPalette> darkPaletteNotifier =
      ValueNotifier<PsyberPalette>(PsyberPalette.obsidianNight);

  /// 当前显式选中的色板（仅跟随系统时为 null）。
  final ValueNotifier<PsyberPalette?> paletteNotifier =
      ValueNotifier<PsyberPalette?>(null);

  /// Ring 1.5/2 同步高风险工具待审批状态（多端同步销除）。
  final ValueNotifier<PendingToolApproval?> pendingApprovalNotifier =
      ValueNotifier<PendingToolApproval?>(null);

  final ValueNotifier<bool> isAppForegroundNotifier = ValueNotifier<bool>(true);

  /// 语音条实时转写语言偏好（默认简体中文，可一键切换英文并持久化）。
  final ValueNotifier<String> voiceLocaleNotifier = ValueNotifier<String>('zh-CN');

  final Map<String, String> _liveTurnMotions = <String, String>{};
  final Map<String, DateTime> _liveMotionStartedAt = <String, DateTime>{};
  final Set<String> _consumedMotionTurnIds = <String>{};
  bool _initialSnapshotLoaded = false;
  int _highestSeqSeen = 0;

  void setAppForeground(bool foreground) {
    if (isAppForegroundNotifier.value == foreground) return;
    isAppForegroundNotifier.value = foreground;
  }

  void setVoiceLocale(String locale) {
    final normalized = (locale == 'en-US') ? 'en-US' : 'zh-CN';
    if (voiceLocaleNotifier.value == normalized) return;
    voiceLocaleNotifier.value = normalized;
    unawaited(_storage.saveVoiceLocale(normalized));
  }

  void setThemeMode(ThemeMode mode) {
    themeModeNotifier.value = mode;
    paletteNotifier.value = switch (mode) {
      ThemeMode.light => lightPaletteNotifier.value,
      ThemeMode.dark => darkPaletteNotifier.value,
      ThemeMode.system => null,
    };
    _persistThemePreferences();
  }

  void setPalette(PsyberPalette? palette) {
    if (palette == null) {
      setThemeMode(ThemeMode.system);
      return;
    }
    if (palette.isDark) {
      darkPaletteNotifier.value = palette;
      themeModeNotifier.value = ThemeMode.dark;
    } else {
      lightPaletteNotifier.value = palette;
      themeModeNotifier.value = ThemeMode.light;
    }
    paletteNotifier.value = palette;
    _persistThemePreferences();
  }

  void _persistThemePreferences() {
    unawaited(
      _storage.saveThemePreferences(
        ThemePreferences(
          themeMode: themeModeNotifier.value,
          lightPalette: lightPaletteNotifier.value,
          darkPalette: darkPaletteNotifier.value,
        ),
      ),
    );
  }

  String? liveMotionForCommittedTurn(String? turnId) {
    if (turnId == null || turnId.isEmpty) return null;
    if (_consumedMotionTurnIds.contains(turnId)) return null;
    final motion = _liveTurnMotions[turnId];
    if (motion == null) return null;
    final startedAt = _liveMotionStartedAt[turnId];
    if (startedAt != null && DateTime.now().difference(startedAt).inMilliseconds >= 250) {
      _consumedMotionTurnIds.add(turnId);
      return null;
    }
    return motion;
  }

  void markTurnMotionStarted(String? turnId) {
    if (turnId == null || turnId.isEmpty) return;
    _liveMotionStartedAt.putIfAbsent(turnId, DateTime.now);
  }

  void markTurnMotionConsumed(String? turnId) {
    if (turnId == null || turnId.isEmpty) return;
    _consumedMotionTurnIds.add(turnId);
  }

  StreamSubscription<SseEventFrame>? _sseSub;
  Timer? _reconnectTimer;
  Timer? _offlineHintTimer;
  int _reconnectAttempt = 0;
  bool _isPaused = false;
  bool _inBackgroundStream = false;
  bool _disposed = false;
  final Set<String> _notifiedEventIds = <String>{};
  bool _hasMoreHistory = false;
  bool _hasLoadedOlder = false;
  String? _nextBeforeId;
  String? _lastStreamSeq;

  bool get hasMoreHistory => _hasMoreHistory;

  Future<String> loadDraft() => _storage.loadDraft();

  Future<void> saveDraft(String draft) => _storage.saveDraft(draft);

  Future<void> initialize() async {
    if (LocalNotificationService.isSupported && _localNotifier == null) {
      unawaited(LocalNotificationService.requestPermission());
    }
    final themePrefs = await _storage.loadThemePreferences();
    final savedVoiceLocale = await _storage.loadVoiceLocale();
    if (_disposed) return;
    voiceLocaleNotifier.value = savedVoiceLocale;
    lightPaletteNotifier.value = themePrefs.lightPalette;
    darkPaletteNotifier.value = themePrefs.darkPalette;
    themeModeNotifier.value = themePrefs.themeMode;
    paletteNotifier.value = switch (themePrefs.themeMode) {
      ThemeMode.light => themePrefs.lightPalette,
      ThemeMode.dark => themePrefs.darkPalette,
      ThemeMode.system => null,
    };

    final saved = await _storage.load();
    if (_disposed) return;
    if (saved == null) {
      if (_isDesktopPlatform && !_manuallyDisconnected) {
        final hint = await _localPairHintLoader();
        if (!_disposed && hint != null) {
          try {
            await localPairAndConnect(
              baseUrl: hint.baseUrl,
              secret: hint.secret,
              deviceName: _defaultDesktopDeviceName(),
              platform: _defaultDesktopWirePlatform(),
            );
            return;
          } catch (_) {
            // 本机免码失败时静默回退至配对页，不阻断手动或扫码配对
          }
        }
      }
      if (!_disposed) {
        connectionNotifier.value = ConnectionPhase.unpaired;
      }
      return;
    }
    profileNotifier.value = saved;
    unawaited(connectAndSync());
  }

  String _defaultDesktopDeviceName() {
    switch (defaultTargetPlatform) {
      case TargetPlatform.macOS:
        return 'Mac';
      case TargetPlatform.windows:
        return 'Windows';
      case TargetPlatform.linux:
        return 'Linux';
      default:
        return 'Desktop';
    }
  }

  String _defaultDesktopWirePlatform() {
    switch (defaultTargetPlatform) {
      case TargetPlatform.macOS:
        return 'macos';
      case TargetPlatform.windows:
        return 'windows';
      case TargetPlatform.linux:
        return 'linux';
      default:
        return 'macos';
    }
  }

  Future<List<DiscoveredServer>> discoverLanServers() => _lanDiscovery.discover();

  Future<LocalPairHint?> loadLocalDesktopPairHint() => _localPairHintLoader();

  /// 首次通过一次性配对码绑定后端并落盘长期 Token + instanceId。
  Future<void> pairAndConnect({
    required String baseUrl,
    required String code,
    required String deviceName,
    required String platform,
  }) async {
    final clientId = await _storage.loadOrCreateClientId();
    final profile = await _api.pair(
      baseUrl: baseUrl,
      code: code,
      deviceName: deviceName,
      platform: platform,
      clientId: clientId,
    );
    _manuallyDisconnected = false;
    await _storage.save(profile);
    if (_disposed) return;
    profileNotifier.value = profile;
    await connectAndSync();
  }

  /// 仅限本机桌面端免码配对：使用 0600 local_pair.json 启动密钥换取常规长期 Token。
  Future<void> localPairAndConnect({
    required String baseUrl,
    required String secret,
    required String deviceName,
    required String platform,
  }) async {
    final clientId = await _storage.loadOrCreateClientId();
    final profile = await _api.localPair(
      baseUrl: baseUrl,
      secret: secret,
      deviceName: deviceName,
      platform: platform,
      clientId: clientId,
    );
    _manuallyDisconnected = false;
    await _storage.save(profile);
    if (_disposed) return;
    profileNotifier.value = profile;
    await connectAndSync();
  }

  /// 通过扫码或粘贴二维码载荷完成配对：自动探测候选地址中首个可达节点再兑换 Token。
  Future<void> pairFromQrPayload({
    required String rawPayload,
    required String deviceName,
    required String platform,
  }) async {
    final parsed = parsePairQrPayload(rawPayload);
    if (parsed == null) {
      throw const ApiException(
        statusCode: 400,
        code: 'INVALID_QR_PAYLOAD',
        message: '二维码内容无效，请重新扫码',
      );
    }
    var chosenUrl = parsed.urls.first;
    if (parsed.urls.length > 1) {
      for (final candidate in parsed.urls) {
        try {
          await _api.checkHealth(candidate);
          chosenUrl = candidate;
          break;
        } catch (_) {
          // 继续尝试下一个候选地址
        }
      }
    }
    await pairAndConnect(
      baseUrl: chosenUrl,
      code: parsed.code,
      deviceName: deviceName,
      platform: platform,
    );
  }

  /// 已配对设备为新设备签发 5 分钟一次性配对码与扫码二维码载荷。
  Future<IssuedPairCodeView?> issueNewDevicePairCode() async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.issuePairCode(profile);
  }

  Future<void> completeGenesis({
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
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.submitGenesis(
      profile,
      residentName: residentName,
      userName: userName,
      userPronoun: userPronoun,
      timezone: timezone,
      sleepStart: sleepStart,
      sleepEnd: sleepEnd,
      providerKind: providerKind,
      baseUrl: baseUrl,
      modelName: modelName,
      apiKey: apiKey,
    );
    if (_disposed) return;
    final genesis = await _api.getGenesis(profile);
    genesisNotifier.value = genesis;
    identityNotifier.value = genesis.toIdentityInfo();
    await refreshSnapshot();
    unawaited(loadSettings());
  }

  Future<SettingsSnapshot?> loadSettings() async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    try {
      final snap = await _api.getSettings(profile);
      if (!_disposed) {
        settingsNotifier.value = snap;
        if (snap.identity != null) {
          identityNotifier.value = snap.identity!;
        }
      }
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
    _manuallyDisconnected = true;
    final profile = profileNotifier.value;
    if (notifyServer && profile != null && profile.deviceId.isNotEmpty) {
      try {
        await _api.revokeDevice(profile, profile.deviceId);
      } catch (_) {
        // 网络不通或服务端已停机时静默忽略，优先保证客户端本地清空返回配对
      }
    }
    _initialSnapshotLoaded = false;
    _highestSeqSeen = 0;
    _liveTurnMotions.clear();
    _liveMotionStartedAt.clear();
    _consumedMotionTurnIds.clear();
    _cancelSseAndTimers();
    await _storage.clear();
    if (_disposed) return;
    profileNotifier.value = null;
    genesisNotifier.value = null;
    identityNotifier.value = IdentityInfo.empty;
    connectionNotifier.value = ConnectionPhase.unpaired;
    showReconnectingHintNotifier.value = false;
    timelineNotifier.value = const <TimelineItem>[];
    doorNotifier.value = DoorStatus.initial;
    userStatusNotifier.value = UserStatus.initial;
    activeTurnNotifier.value = null;
    turnErrorNotifier.value = null;
    instanceMismatchNotifier.value = false;
    turnFailureNotifier.value = null;
    turnSilenceNotifier.value = null;
    contextUsageNotifier.value = null;
    pendingModelSwitchNotifier.value = null;
    settingsNotifier.value = null;
    activeActivityNotifier.value = null;
    cinemaBridgeNotifier.value = null;
    pendingApprovalNotifier.value = null;
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

    void resetInMemorySessionState() {
      _initialSnapshotLoaded = false;
      _highestSeqSeen = 0;
      _hasLoadedOlder = false;
      _hasMoreHistory = false;
      _nextBeforeId = null;
      _lastStreamSeq = null;
      timelineNotifier.value = const <TimelineItem>[];
      activeTurnNotifier.value = null;
      instanceMismatchNotifier.value = false;
      turnErrorNotifier.value = null;
    }

    try {
      final health = await _api.checkHealth(profile.baseUrl);
      if (_disposed || _isPaused) return;
      if (profile.instanceId.isNotEmpty &&
          health.instanceId.isNotEmpty &&
          health.instanceId != profile.instanceId) {
        // 1. 优先复用本地多实例凭证缓存（切回曾经配对过的实例无需重新配对，也不增加重复设备）
        final cached = await _storage.loadForInstance(health.instanceId);
        if (!_disposed && cached != null) {
          final switched = ConnectionProfile(
            baseUrl: profile.baseUrl,
            token: cached.token,
            deviceId: cached.deviceId,
            instanceId: cached.instanceId,
            deviceName: cached.deviceName,
          );
          resetInMemorySessionState();
          await _storage.save(switched);
          if (_disposed) return;
          profileNotifier.value = switched;
          await connectAndSync();
          return;
        }
        // 2. 本地未缓存该实例凭证时，若为本机桌面端回环地址且 0600 local_pair.json 匹配，自动免码切入
        if (_isDesktopPlatform && isLoopbackUrl(profile.baseUrl)) {
          final hint = await _localPairHintLoader();
          if (!_disposed && hint != null && hint.instanceId == health.instanceId) {
            try {
              resetInMemorySessionState();
              await localPairAndConnect(
                baseUrl: profile.baseUrl,
                secret: hint.secret,
                deviceName: _defaultDesktopDeviceName(),
                platform: _defaultDesktopWirePlatform(),
              );
              return;
            } catch (_) {
              // 免码切入失败则回落至实例不一致提示与一键重新配对入口
            }
          }
        }
        instanceMismatchNotifier.value = true;
        turnErrorNotifier.value = '当前地址对应的实例 ID 与配对记录不一致，请检查后端地址或重新配对';
        connectionNotifier.value = ConnectionPhase.reconnecting;
        return;
      }
      instanceMismatchNotifier.value = false;
      if (turnErrorNotifier.value != null &&
          turnErrorNotifier.value!.contains('实例 ID 与配对记录不一致')) {
        turnErrorNotifier.value = null;
      }

      final genesis = await _api.getGenesis(profile);
      if (_disposed || _isPaused) return;
      genesisNotifier.value = genesis;
      identityNotifier.value = genesis.toIdentityInfo();

      await refreshSnapshot();
      if (_disposed || _isPaused) return;

      unawaited(loadSettings());
      unawaited(_refreshActivitySlot(profile));

      _reconnectAttempt = 0;
      _offlineHintTimer?.cancel();
      showReconnectingHintNotifier.value = false;
      connectionNotifier.value = ConnectionPhase.connected;
      _startSse(profile, foreground: !_inBackgroundStream);
    } on CanceledException {
      // 预期内取消，静默忽略
    } on ApiException catch (e) {
      if (_disposed || _isPaused) return;
      if (e.statusCode == 401) {
        await _storage.removeInstance(profile.instanceId);
        // 若本机桌面端旧令牌已被吊销，自动尝试用 0600 local_pair.json 重新免码恢复
        if (_isDesktopPlatform && isLoopbackUrl(profile.baseUrl)) {
          final hint = await _localPairHintLoader();
          if (!_disposed && hint != null && hint.instanceId == profile.instanceId) {
            try {
              await localPairAndConnect(
                baseUrl: profile.baseUrl,
                secret: hint.secret,
                deviceName: _defaultDesktopDeviceName(),
                platform: _defaultDesktopWirePlatform(),
              );
              return;
            } catch (_) {
              // 回落至配对页
            }
          }
        }
        await disconnect(notifyServer: false);
        return;
      }
      _scheduleReconnect();
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
      _api.getUserStatus(profile).catchError((_) => userStatusNotifier.value),
    ]);
    if (_disposed) return;
    doorNotifier.value = results[0] as DoorStatus;
    userStatusNotifier.value = results[2] as UserStatus;
    final page = results[1] as HistoryPage;
    if (page.identity != null) {
      identityNotifier.value = page.identity!;
    }
    if (page.contextUsage != null) {
      contextUsageNotifier.value = page.contextUsage;
    }
    if (!_manualWrapUpInFlight) {
      wrappingUpNotifier.value = page.rolloverInProgress;
    }
    if (_hasLoadedOlder && page.items.isNotEmpty) {
      final latestMinSeq = page.items.first.seq;
      final latestIds = page.items.map((e) => e.id).toSet();
      final preservedOlder = timelineNotifier.value
          .where((e) => e.seq < latestMinSeq && !latestIds.contains(e.id));
      final merged = <TimelineItem>[...preservedOlder, ...page.items]
        ..sort((a, b) => a.seq.compareTo(b.seq));
      timelineNotifier.value = List<TimelineItem>.unmodifiable(merged);
    } else {
      _hasMoreHistory = page.hasMore;
      _nextBeforeId = page.nextBefore;
      timelineNotifier.value = List<TimelineItem>.unmodifiable(page.items);
    }
    if (!_initialSnapshotLoaded) {
      for (final item in page.items) {
        if (item.turnId != null && item.turnId!.isNotEmpty) {
          _consumedMotionTurnIds.add(item.turnId!);
        }
        if (item.seq > _highestSeqSeen) {
          _highestSeqSeen = item.seq;
        }
      }
      _initialSnapshotLoaded = true;
    } else {
      for (final item in page.items) {
        if (item.seq > _highestSeqSeen) {
          _recordTurnMotionFromItem(item);
          _highestSeqSeen = item.seq;
        }
      }
    }
    final active = activeTurnNotifier.value;
    if (active != null) {
      final completedInHistory = page.items.any(
        (e) => e.isAssistant && e.turnId == active.turnId,
      );
      final stillRunningOnServer =
          page.activeTurnId != null && page.activeTurnId == active.turnId;
      if (completedInHistory || !stillRunningOnServer) {
        activeTurnNotifier.value = null;
      }
    }
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

  bool get _isDesktopPlatform =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.macOS ||
          defaultTargetPlatform == TargetPlatform.windows ||
          defaultTargetPlatform == TargetPlatform.linux);

  /// App 切后台：移动端静默中止 SSE 省电；桌面端保留 foreground=false 后台 SSE 以接收本地通知。
  void onAppPaused() {
    isAppForegroundNotifier.value = false;
    if (_isDesktopPlatform && profileNotifier.value != null) {
      _isPaused = false;
      _inBackgroundStream = true;
      _cancelSseAndTimers();
      _startSse(profileNotifier.value!, foreground: false);
      return;
    }
    _isPaused = true;
    _inBackgroundStream = false;
    _cancelSseAndTimers();
  }

  /// App 切回前台：合并为单次静默重连并拉取最新历史与门状态。
  void onAppResumed() {
    isAppForegroundNotifier.value = true;
    if (!_isPaused && !_inBackgroundStream) return;
    _isPaused = false;
    _inBackgroundStream = false;
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
    VoiceClipInfo? voiceClip,
    bool urgent = false,
  }) async {
    final profile = profileNotifier.value;
    final text = rawText.trim();
    final hasAttachments = attachments != null && attachments.isNotEmpty;
    final hasSticker = stickerId != null && stickerId.trim().isNotEmpty;
    final hasVideo = videoClip != null && videoClip.frameHashes.isNotEmpty;
    final hasVoice = voiceClip != null && voiceClip.mediaHash.isNotEmpty;
    if (profile == null ||
        (text.isEmpty && !hasAttachments && !hasSticker && !hasVideo && !hasVoice)) {
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
      voiceClip: voiceClip,
      urgent: urgent,
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

  /// 手动触发「存记忆换段」：先同步完成旧段整理再切新 session_id。
  Future<WrapUpResult?> wrapUpMemorySession() async {
    final profile = profileNotifier.value;
    if (profile == null || wrappingUpNotifier.value) return null;
    _manualWrapUpInFlight = true;
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
      _manualWrapUpInFlight = false;
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

  Future<void> retractMessage(String messageId) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final updated = await _api.retractMessage(profile, messageId);
    if (_disposed) return;
    if (updated.id.isNotEmpty) {
      _upsertTimelineItem(updated);
    }
  }

  /// 重新触发指定消息的附件摘要生成（失败点击提醒图标或主动重生成）。
  Future<void> retryAttachmentDigest(String messageId) async {
    final profile = profileNotifier.value;
    if (profile == null || messageId.isEmpty) return;
    _setLocalAttachmentDigestStatus(messageId, 'pending');
    try {
      await _api.retryAttachmentDigest(profile, messageId);
    } catch (_) {
      if (!_disposed) {
        _setLocalAttachmentDigestStatus(messageId, 'failed');
      }
    }
  }

  void _setLocalAttachmentDigestStatus(String messageId, String status) {
    var changed = false;
    final next = timelineNotifier.value.map((item) {
      if (item.id != messageId || item.attachmentDigestStatus == status) {
        return item;
      }
      changed = true;
      return item.copyWith(attachmentDigestStatus: status);
    }).toList(growable: false);
    if (changed) {
      timelineNotifier.value = List<TimelineItem>.unmodifiable(next);
    }
  }

  Future<void> openShare(String shareId) async {
    final profile = profileNotifier.value;
    if (profile == null || shareId.isEmpty) return;
    try {
      final openedAt = await _api.openShare(profile, shareId);
      if (_disposed || openedAt == null) return;
      _markShareOpenedLocal(shareId, openedAt);
    } catch (_) {
      // 拆阅回执网络失败静默降级，不打断阅读
    }
  }

  Future<void> openDoorNote(String messageId) async {
    final profile = profileNotifier.value;
    if (profile == null || messageId.isEmpty) return;
    final localNow = DateTime.now().millisecondsSinceEpoch;
    _markDoorNoteOpenedLocal(messageId, localNow);
    try {
      final openedAt = await _api.openDoorNote(profile, messageId);
      if (_disposed || openedAt == null) return;
      _markDoorNoteOpenedLocal(messageId, openedAt);
    } catch (_) {
      // 拆封回执网络失败静默降级，本地已展开不打断阅读
    }
  }

  Future<void> updateUserStatus({
    String? moodText,
    bool clearMood = false,
    bool? undisturbed,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final next = await _api.updateUserStatus(
      profile,
      moodText: moodText,
      clearMood: clearMood,
      undisturbed: undisturbed,
    );
    if (!_disposed) {
      userStatusNotifier.value = next;
    }
  }

  Future<void> editMessage(String messageId, String newContent) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    final updated = await _api.editMessage(profile, messageId, newContent);
    if (_disposed) return;
    if (updated.id.isNotEmpty) {
      _replaceGroupAndUpsertTimelineItem(updated);
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
      _replaceGroupAndUpsertTimelineItem(activated);
    }
  }

  Future<CinemaBridgeInfo?> refreshCinemaBridgeStatus() async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    try {
      final info = await _api.getCinemaBridgeStatus(profile);
      if (!_disposed) {
        cinemaBridgeNotifier.value = info;
      }
      return info;
    } catch (_) {
      return null;
    }
  }

  Future<ActivitySessionView?> startCinemaActivity({String? title}) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    final session = await _api.startCinemaActivity(profile, title: title);
    if (!_disposed) {
      activeActivityNotifier.value = session;
    }
    return session;
  }

  Future<List<CinemaWindowItem>> listCinemaWindows() async {
    final profile = profileNotifier.value;
    if (profile == null) return const <CinemaWindowItem>[];
    return _api.listCinemaWindows(profile);
  }

  Future<void> selectCinemaWindow(int windowId) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.selectCinemaWindow(profile, windowId);
    await refreshCinemaBridgeStatus();
  }

  Future<void> setCinemaMode(String mode) async {
    final profile = profileNotifier.value;
    if (profile == null) return;
    await _api.setCinemaMode(profile, mode);
    await refreshCinemaBridgeStatus();
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

  Future<UsageStatsSnapshot?> loadUsageStats({int? days}) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.getUsageStats(profile, days: days);
  }

  Future<List<DiscoveredModelView>> loadLlmModels({String? provider}) async {
    final profile = profileNotifier.value;
    if (profile == null) return const <DiscoveredModelView>[];
    return _api.listLlmModels(profile, provider: provider);
  }

  Future<ModelCatalogSyncResult?> syncModelCatalog() async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    final res = await _api.syncModelCatalog(profile);
    if (!_disposed) {
      unawaited(loadSettings());
    }
    return res;
  }

  Future<LlmTestResult?> testLlmModel({
    required String provider,
    required String model,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.testLlmModel(profile, provider: provider, model: model);
  }

  Future<NotificationTestResult?> testNotifications() async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    return _api.testNotifications(profile);
  }

  Future<String?> uploadAvatar({
    required String who,
    required List<int> bytes,
    required String filename,
    required String mimeType,
  }) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    final url = await _api.uploadAvatar(
      profile,
      who: who,
      bytes: bytes,
      filename: filename,
      mimeType: mimeType,
    );
    if (!_disposed) {
      await loadSettings();
    }
    return url;
  }

  Future<List<McpPresetView>> loadMcpPresets() async {
    final profile = profileNotifier.value;
    if (profile == null) return const <McpPresetView>[];
    return _api.getMcpPresets(profile);
  }

  Future<McpServerView?> reconnectMcpServer(String serverId) async {
    final profile = profileNotifier.value;
    if (profile == null) return null;
    final updated = await _api.reconnectMcpServer(profile, serverId);
    if (!_disposed) {
      await loadSettings();
    }
    return updated;
  }

  Future<void> respondToApproval({
    required String decision,
    String scope = 'once',
  }) async {
    final profile = profileNotifier.value;
    final pending = pendingApprovalNotifier.value;
    if (profile == null || pending == null) return;
    pendingApprovalNotifier.value = null;
    try {
      await _api.resolveToolApproval(
        profile,
        turnId: pending.turnId,
        approvalId: pending.approvalId,
        decision: decision,
        scope: scope,
      );
    } on ApiException catch (e) {
      if (e.code != 'APPROVAL_ALREADY_RESOLVED' && !_disposed) {
        turnErrorNotifier.value = e.message;
      }
    } catch (_) {
      if (!_disposed) {
        turnErrorNotifier.value = '审批提交失败，请检查网络连接';
      }
    }
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

  void _startSse(ConnectionProfile profile, {bool foreground = true}) {
    _sseSub = _api
        .openEventStream(
          profile,
          foreground: foreground,
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

  ActiveTurnState? _ensureActiveTurn(String? turnId) {
    final current = activeTurnNotifier.value;
    if (current != null) return current;
    if (turnId == null || turnId.isEmpty) return null;
    final alreadyPersisted = timelineNotifier.value.any(
      (e) => e.isAssistant && e.turnId == turnId,
    );
    if (alreadyPersisted) return null;
    final recovered = ActiveTurnState(turnId: turnId, mode: 'chat');
    activeTurnNotifier.value = recovered;
    return recovered;
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
          final item = TimelineItem.fromJson(rawMsg);
          _recordTurnMotionFromItem(item);
          _upsertTimelineItem(item);
          if (item.isAssistant &&
              item.turnId != null &&
              activeTurnNotifier.value?.turnId == item.turnId) {
            activeTurnNotifier.value = null;
          }
          _maybeNotifyMessageInBackground(item);
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
            _replaceGroupAndUpsertTimelineItem(TimelineItem.fromJson(rawMsg));
          }
        }
        return;
      case 'door.updated':
        final prevDoorState = doorNotifier.value.state;
        final nextState = DoorState.fromWire(frame.data['state'] as String?);
        final rawUnread = frame.data['unreadDoorNotes'];
        final nextUnread = rawUnread is num
            ? rawUnread.toInt()
            : (nextState == DoorState.open
                ? 0
                : doorNotifier.value.unreadDoorNotes);
        final nextNote = frame.data['note'] as String?;
        if (nextState != prevDoorState) {
          _maybeNotifyDoorInBackground(nextState, nextNote);
        }
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
      case 'identity.updated':
        identityNotifier.value = IdentityInfo.fromJson(frame.data);
        return;
      case 'user_status.updated':
        userStatusNotifier.value = UserStatus.fromJson(frame.data);
        return;
      case 'share.opened':
        final shareId = frame.data['shareId'] as String?;
        final openedAt = (frame.data['openedAt'] as num?)?.toInt();
        if (shareId != null && shareId.isNotEmpty && openedAt != null) {
          _markShareOpenedLocal(shareId, openedAt);
        }
        return;
      case 'door_note.opened':
        final noteId = frame.data['id'] as String?;
        final openedAt = (frame.data['openedAt'] as num?)?.toInt();
        if (noteId != null && noteId.isNotEmpty && openedAt != null) {
          _markDoorNoteOpenedLocal(noteId, openedAt);
        }
        return;
      case 'door_notes.read':
        final upToId = frame.data['upToId'] as String?;
        if (upToId != null && upToId.isNotEmpty) {
          _markDoorNotesReadLocal(upToId);
        }
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
        final delta = frame.data['delta'] as String? ?? '';
        if (delta.isNotEmpty) {
          final current = _ensureActiveTurn(frame.data['turnId'] as String?);
          if (current != null) {
            final rawStep = (frame.data['step'] as num?)?.toInt();
            final steps = List<TurnJournalStep>.from(current.journalSteps);
            final targetStep = rawStep ??
                (steps.isEmpty
                    ? 0
                    : (steps.last.progressTools.isNotEmpty
                        ? steps.last.step + 1
                        : steps.last.step));
            final idx = steps.indexWhere((s) => s.step == targetStep);
            if (idx >= 0) {
              steps[idx] = steps[idx].copyWith(
                thinking: steps[idx].thinking + delta,
              );
            } else {
              steps.add(TurnJournalStep(step: targetStep, thinking: delta));
            }
            final sep = (current.thinking.isNotEmpty &&
                    idx < 0 &&
                    !current.thinking.endsWith('\n\n'))
                ? '\n\n'
                : '';
            activeTurnNotifier.value = current.copyWith(
              thinking: '${current.thinking}$sep$delta',
              journalSteps: List<TurnJournalStep>.unmodifiable(steps),
            );
          }
        }
        return;
      case 'turn.tool':
        final current = _ensureActiveTurn(frame.data['turnId'] as String?);
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
          final steps = List<TurnJournalStep>.from(current.journalSteps);
          if (!tool.isScreen) {
            final targetStep = tool.step ?? (steps.isEmpty ? 0 : steps.last.step);
            final sIdx = steps.indexWhere((s) => s.step == targetStep);
            if (sIdx >= 0) {
              final stTools = List<ToolProgressItem>.from(steps[sIdx].progressTools);
              final tIdx = stTools.indexWhere(
                (t) => t.callId.isNotEmpty && t.callId == tool.callId,
              );
              if (tIdx >= 0) {
                stTools[tIdx] = tool;
              } else {
                stTools.add(tool);
              }
              steps[sIdx] = steps[sIdx].copyWith(
                progressTools: List<ToolProgressItem>.unmodifiable(stTools),
              );
            } else {
              steps.add(
                TurnJournalStep(
                  step: targetStep,
                  progressTools: <ToolProgressItem>[tool],
                ),
              );
            }
          }
          activeTurnNotifier.value = current.copyWith(
            tools: nextTools,
            journalSteps: List<TurnJournalStep>.unmodifiable(steps),
          );
        }
        return;
      case 'turn.text':
        final delta = frame.data['delta'] as String? ?? '';
        if (delta.isNotEmpty) {
          final current = _ensureActiveTurn(frame.data['turnId'] as String?);
          if (current != null) {
            activeTurnNotifier.value = current.copyWith(
              text: current.text + delta,
            );
          }
        }
        return;
      case 'turn.expression':
        final payload = ExpressionPayload.fromJson(frame.data);
        expressionNotifier.value = payload;
        final current = _ensureActiveTurn(frame.data['turnId'] as String?);
        final exprTurnId =
            (frame.data['turnId'] as String?) ?? current?.turnId;
        if (payload.motion != null &&
            payload.motion!.isNotEmpty &&
            exprTurnId != null &&
            exprTurnId.isNotEmpty) {
          _liveTurnMotions[exprTurnId] = payload.motion!;
        }
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
      case 'turn.approval_required':
        final approval = PendingToolApproval.fromJson(frame.data);
        pendingApprovalNotifier.value = approval;
        _maybeNotifyApprovalInBackground(approval);
        return;
      case 'turn.approval_resolved':
        final resolvedId = frame.data['approvalId'] as String?;
        if (pendingApprovalNotifier.value?.approvalId == resolvedId) {
          pendingApprovalNotifier.value = null;
        }
        return;
      case 'turn.tidy':
        final tidyPhase = frame.data['phase'] as String? ?? '';
        if (tidyPhase == 'started') {
          wrappingUpNotifier.value = true;
        } else {
          if (!_manualWrapUpInFlight) {
            wrappingUpNotifier.value = false;
          }
          if (tidyPhase == 'error') {
            final msg = frame.data['message'] as String?;
            if (msg != null && msg.isNotEmpty) {
              turnErrorNotifier.value = msg;
            }
          }
        }
        return;
      case 'turn.rollover':
        final phase = frame.data['phase'] as String? ?? '';
        if (phase == 'wrapping') {
          wrappingUpNotifier.value = true;
        } else {
          if (!_manualWrapUpInFlight) {
            wrappingUpNotifier.value = false;
          }
          final rawUsage = frame.data['contextUsage'];
          if (rawUsage is Map<String, dynamic>) {
            contextUsageNotifier.value = ContextUsageInfo.fromJson(rawUsage);
          }
          if (phase == 'error') {
            final msg = frame.data['message'] as String?;
            if (msg != null && msg.isNotEmpty) {
              turnErrorNotifier.value = msg;
            }
          }
        }
        return;
      case 'turn.done':
        final rawUsage = frame.data['contextUsage'];
        if (rawUsage is Map<String, dynamic>) {
          contextUsageNotifier.value = ContextUsageInfo.fromJson(rawUsage);
        }
        turnFailureNotifier.value = null;
        pendingModelSwitchNotifier.value = null;
        pendingApprovalNotifier.value = null;
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

  void _replaceGroupAndUpsertTimelineItem(TimelineItem item) {
    if (item.id.isEmpty) return;
    if (item.groupId != null) {
      final list = List<TimelineItem>.from(timelineNotifier.value);
      list.removeWhere(
        (e) => e.groupId == item.groupId && e.role == item.role && e.id != item.id,
      );
      timelineNotifier.value = List<TimelineItem>.unmodifiable(list);
    }
    _upsertTimelineItem(item);
  }

  void _recordTurnMotionFromItem(TimelineItem item) {
    final tid = item.turnId;
    if (!item.isAssistant || tid == null || tid.isEmpty) return;
    if (_consumedMotionTurnIds.contains(tid) || _liveTurnMotions.containsKey(tid)) {
      return;
    }
    for (var i = item.expressions.length - 1; i >= 0; i--) {
      final motion = item.expressions[i].motion;
      if (motion != null && motion.isNotEmpty) {
        _liveTurnMotions[tid] = motion;
        return;
      }
    }
  }

  void _upsertTimelineItem(TimelineItem item) {
    if (item.id.isEmpty) return;
    if (item.seq > _highestSeqSeen) {
      _highestSeqSeen = item.seq;
    }
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

  void _markShareOpenedLocal(String shareId, int openedAt) {
    var changed = false;
    final next = timelineNotifier.value.map((item) {
      if (item.shares.isEmpty) return item;
      final hasTarget = item.shares.any((s) => s.id == shareId && s.openedAt == null);
      if (!hasTarget) return item;
      changed = true;
      return item.copyWith(
        shares: item.shares
            .map((s) => s.id == shareId ? s.copyWith(openedAt: openedAt) : s)
            .toList(growable: false),
      );
    }).toList(growable: false);
    if (changed) {
      timelineNotifier.value = List<TimelineItem>.unmodifiable(next);
    }
  }

  void _markDoorNoteOpenedLocal(String messageId, int openedAt) {
    var changed = false;
    final next = timelineNotifier.value.map((item) {
      if (item.id != messageId || item.openedAt == openedAt) return item;
      changed = true;
      return item.copyWith(openedAt: openedAt);
    }).toList(growable: false);
    if (changed) {
      timelineNotifier.value = List<TimelineItem>.unmodifiable(next);
    }
  }

  void _markDoorNotesReadLocal(String upToId) {
    var changed = false;
    final next = timelineNotifier.value.map((item) {
      if (!item.isUser || !item.isDoorNote || item.readByResident) return item;
      if (item.id.compareTo(upToId) > 0) return item;
      changed = true;
      return item.copyWith(readByResident: true);
    }).toList(growable: false);
    if (changed) {
      timelineNotifier.value = List<TimelineItem>.unmodifiable(next);
    }
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

  void _maybeNotifyMessageInBackground(TimelineItem item) {
    if (!item.isAssistant ||
        item.isDoorNote ||
        item.isSilence ||
        item.isMemoryTask ||
        item.isShareOpened ||
        item.retracted) {
      return;
    }
    if (userStatusNotifier.value.undisturbed && !item.urgent) return;
    final raw = item.content.replaceAll(RegExp(r'\s+'), ' ').trim();
    final body = raw.isNotEmpty
        ? (raw.length > 80 ? '${raw.substring(0, 80)}…' : raw)
        : (item.voiceClip != null
            ? '[发来一条语音]'
            : (item.sticker != null
                ? '[贴纸：${item.sticker!.label}]'
                : (item.attachments.isNotEmpty ? '[发来一张图片]' : '发来一条新消息')));
    _dispatchBackgroundLocalNotification(
      id: 'msg_${item.id}',
      title: item.urgent
          ? '${identityNotifier.value.displayResidentName} · 紧急消息'
          : identityNotifier.value.displayResidentName,
      body: body,
    );
  }

  void _maybeNotifyDoorInBackground(DoorState nextState, String? note) {
    if (userStatusNotifier.value.undisturbed) return;
    final trimmed = note?.trim() ?? '';
    final body = switch (nextState) {
      DoorState.open => trimmed.isNotEmpty ? '门打开了：$trimmed' : '门打开了',
      DoorState.closed => trimmed.isNotEmpty ? '门关上了：$trimmed' : '门关上了',
      DoorState.quiet => trimmed.isNotEmpty ? '安静一会儿：$trimmed' : '安静一会儿',
      DoorState.coolingOff => '暂时静一静',
      DoorState.departed => '已经离开',
    };
    _dispatchBackgroundLocalNotification(
      id: 'door_${nextState.name}_${DateTime.now().millisecondsSinceEpoch ~/ 5000}',
      title: identityNotifier.value.displayResidentName,
      body: body,
    );
  }

  void _maybeNotifyApprovalInBackground(PendingToolApproval approval) {
    _dispatchBackgroundLocalNotification(
      id: 'apr_${approval.approvalId}',
      title: '需要确认 · ${approval.toolName}',
      body: approval.summary.isNotEmpty
          ? approval.summary
          : '有外部工具调用正在等待你的确认',
    );
  }

  void _dispatchBackgroundLocalNotification({
    required String id,
    required String title,
    required String body,
  }) {
    if (isAppForegroundNotifier.value) return;
    if (!(settingsNotifier.value?.desktopNotifyEnabled ?? true)) return;
    final sender = _localNotifier ??
        (LocalNotificationService.isSupported ? LocalNotificationService.show : null);
    if (sender == null) return;
    if (!_notifiedEventIds.add(id)) return;
    if (_notifiedEventIds.length > 200) {
      _notifiedEventIds.remove(_notifiedEventIds.first);
    }
    unawaited(sender(id: id, title: title, body: body));
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
    identityNotifier.dispose();
    connectionNotifier.dispose();
    showReconnectingHintNotifier.dispose();
    doorNotifier.dispose();
    userStatusNotifier.dispose();
    timelineNotifier.dispose();
    activeTurnNotifier.dispose();
    expressionNotifier.dispose();
    turnErrorNotifier.dispose();
    instanceMismatchNotifier.dispose();
    turnFailureNotifier.dispose();
    turnSilenceNotifier.dispose();
    contextUsageNotifier.dispose();
    retryingTurnNotifier.dispose();
    wrappingUpNotifier.dispose();
    pendingModelSwitchNotifier.dispose();
    settingsNotifier.dispose();
    activeActivityNotifier.dispose();
    cinemaBridgeNotifier.dispose();
    recallEvalModeNotifier.dispose();
    themeModeNotifier.dispose();
    lightPaletteNotifier.dispose();
    darkPaletteNotifier.dispose();
    paletteNotifier.dispose();
    pendingApprovalNotifier.dispose();
    isAppForegroundNotifier.dispose();
    voiceLocaleNotifier.dispose();
  }
}
