import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:psyber_app/core/media/image_picker.dart';
import 'package:psyber_app/core/models/models.dart';
import 'package:psyber_app/core/network/api_client.dart';
import 'package:psyber_app/core/state/app_controller.dart';
import 'package:psyber_app/core/storage/session_storage.dart';
import 'package:psyber_app/features/chat/widgets/timeline_items.dart';
import 'package:psyber_app/features/settings/settings_panel.dart';
import 'package:psyber_app/main.dart';
import 'package:psyber_app/shared/theme.dart';

class FakePsyberApiClient implements PsyberApiClient {
  GenesisStatus genesis = GenesisStatus.completedDefault;
  DoorStatus door = DoorStatus.initial;
  List<TimelineItem> history = <TimelineItem>[];
  List<StickerView> stickers = <StickerView>[];
  SettingsSnapshot settings = const SettingsSnapshot(
    timezone: 'Asia/Shanghai',
    providers: {
      'openai': ProviderSettingsView(
        id: 'openai',
        kind: 'openai',
        authMode: 'api_key',
        authStatus: 'configured',
      ),
    },
    chatSlot: ModelSlotView(provider: 'openai', model: 'gpt-4o'),
    circadian: CircadianSettings(
      sleepStart: '23:30',
      sleepEnd: '07:30',
      proactiveEnabled: true,
    ),
    desktopNotifyEnabled: true,
    devices: [
      PairedDeviceView(
        deviceId: 'dev-1',
        deviceName: 'Mac',
        platform: 'macos',
        createdAt: 1795046400000,
        lastSeenAt: 1795046400000,
      ),
    ],
  );
  ActivitySessionView? activeActivity;
  List<DrawerEntryView> drawerEntries = const <DrawerEntryView>[];
  Map<String, DrawerOpenedContent> drawerContents = <String, DrawerOpenedContent>{};
  bool drawerUnavailable = false;

  final List<Map<String, Object?>> sentPayloads = <Map<String, Object?>>[];
  final List<Map<String, dynamic>> settingsPatches = <Map<String, dynamic>>[];
  final List<String> endedCinemaIds = <String>[];
  final List<Map<String, Object?>> switchedVersions = <Map<String, Object?>>[];
  int mediaUploadCount = 0;
  final Map<String, List<RecallTraceItem>> recallByTurn =
      <String, List<RecallTraceItem>>{};
  final List<Map<String, Object?>> feedbackSubmitted = <Map<String, Object?>>[];
  final List<String> abortedTurnIds = <String>[];
  int recallFetchCount = 0;
  int streamOpenCount = 0;
  int historyFetchCount = 0;
  int revokeCount = 0;
  String? lastRevokedDeviceId;
  final List<String> retriedTurnIds = <String>[];
  int wrapUpCallCount = 0;
  UserStatus userStatus = UserStatus.initial;
  final List<String> retractedIds = <String>[];
  final List<String> openedShareIds = <String>[];
  UsageStatsSnapshot usageStats = const UsageStatsSnapshot(
    today: UsageBucket(
      turnCount: 3,
      inputTokens: 4000,
      outputTokens: 600,
      cacheReadTokens: 3000,
      cacheHitRate: 0.4286,
      estimatedCostUsd: 0.0125,
    ),
    total: UsageBucket(
      turnCount: 12,
      inputTokens: 20000,
      outputTokens: 3000,
      cacheReadTokens: 15000,
      cacheHitRate: 0.4286,
      estimatedCostUsd: 0.054,
    ),
    byModel: [
      ModelUsageEntry(
        model: 'gpt-4o',
        bucket: UsageBucket(turnCount: 12, estimatedCostUsd: 0.054),
      ),
    ],
  );
  final List<String> uploadedAvatars = <String>[];
  int llmTestCount = 0;
  final List<String> reconnectedMcpIds = <String>[];
  final List<Map<String, Object?>> resolvedApprovals = <Map<String, Object?>>[];
  List<McpPresetView> mcpPresets = const [
    McpPresetView(
      id: 'fetch',
      label: '网页抓取 (Fetch)',
      description: '按需抓取公开网页正文',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      trustLevel: 'confirm',
    ),
  ];

  StreamController<SseEventFrame>? _streamController;

  void emitSse(String event, Map<String, dynamic> data, {String? id}) {
    _streamController?.add(SseEventFrame(event: event, data: data, id: id));
  }

  Future<void> closeStream() async {
    await _streamController?.close();
    _streamController = null;
  }

  @override
  Future<HealthInfo> checkHealth(String baseUrl) async {
    return const HealthInfo(
      ok: true,
      version: '0.1.0',
      instanceId: 'inst-test-001',
      serverTimeMs: 1795046400000,
    );
  }

  @override
  Future<ConnectionProfile> pair({
    required String baseUrl,
    required String code,
    required String deviceName,
    required String platform,
  }) async {
    if (code.trim() != 'ABCD-1234') {
      throw const ApiException(
        statusCode: 401,
        code: 'PAIR_CODE_INVALID',
        message: '配对码错误',
      );
    }
    return ConnectionProfile(
      baseUrl: baseUrl,
      token: 'demo-session-value',
      deviceId: 'dev-test',
      instanceId: 'inst-test-001',
      deviceName: deviceName,
    );
  }

  @override
  Future<GenesisStatus> getGenesis(ConnectionProfile profile) async => genesis;

  @override
  Future<void> submitGenesis(
    ConnectionProfile profile, {
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
    genesis = GenesisStatus(
      initialized: true,
      named: residentName != null && residentName.trim().isNotEmpty,
      hasChatProvider: apiKey != null && apiKey.trim().isNotEmpty,
      timezone: timezone,
      sleepStart: sleepStart ?? '23:30',
      sleepEnd: sleepEnd ?? '07:30',
    );
  }

  @override
  Future<SettingsSnapshot> getSettings(ConnectionProfile profile) async => settings;

  @override
  Future<SettingsSnapshot> updateSettings(
    ConnectionProfile profile,
    Map<String, dynamic> patch,
  ) async {
    settingsPatches.add(patch);
    final rawCircadian = patch['circadian'];
    if (rawCircadian is Map<String, dynamic>) {
      settings = SettingsSnapshot(
        timezone: settings.timezone,
        providers: settings.providers,
        chatSlot: settings.chatSlot,
        thinkingEnabled: settings.thinkingEnabled,
        circadian: CircadianSettings(
          sleepStart: rawCircadian['sleepStart'] as String? ?? settings.circadian.sleepStart,
          sleepEnd: rawCircadian['sleepEnd'] as String? ?? settings.circadian.sleepEnd,
          proactiveEnabled:
              rawCircadian['proactiveEnabled'] as bool? ?? settings.circadian.proactiveEnabled,
        ),
        desktopNotifyEnabled: settings.desktopNotifyEnabled,
        webhookEnabled: settings.webhookEnabled,
        webhookUrl: settings.webhookUrl,
        devices: settings.devices,
      );
    }
    final rawMcp = patch['mcpServers'];
    if (rawMcp is List<dynamic>) {
      final nextMcp = rawMcp
          .whereType<Map<String, dynamic>>()
          .map(
            (m) => McpServerView(
              id: m['id'] as String? ?? '',
              enabled: m['enabled'] != false,
              transport: m['transport'] as String? ?? 'stdio',
              description: m['description'] as String?,
              command: m['command'] as String?,
              url: m['url'] as String?,
              trustLevel: m['trustLevel'] as String? ?? 'confirm',
              status: m['enabled'] == false ? 'disabled' : 'connected',
              toolCount: m['enabled'] == false ? 0 : 2,
            ),
          )
          .toList(growable: false);
      settings = SettingsSnapshot(
        timezone: settings.timezone,
        providers: settings.providers,
        chatSlot: settings.chatSlot,
        thinkingEnabled: settings.thinkingEnabled,
        thinkingLevel: settings.thinkingLevel,
        userAvatarUrl: settings.userAvatarUrl,
        residentAvatarUrl: settings.residentAvatarUrl,
        circadian: settings.circadian,
        desktopNotifyEnabled: settings.desktopNotifyEnabled,
        webhookEnabled: settings.webhookEnabled,
        webhookUrl: settings.webhookUrl,
        devices: settings.devices,
        mcpServers: nextMcp,
      );
    }
    final revokeIds = patch['revokeDeviceIds'];
    if (revokeIds is List<dynamic> && revokeIds.isNotEmpty) {
      revokeCount += 1;
      lastRevokedDeviceId = revokeIds.first as String;
      settings = SettingsSnapshot(
        timezone: settings.timezone,
        providers: settings.providers,
        chatSlot: settings.chatSlot,
        thinkingEnabled: settings.thinkingEnabled,
        circadian: settings.circadian,
        desktopNotifyEnabled: settings.desktopNotifyEnabled,
        webhookEnabled: settings.webhookEnabled,
        webhookUrl: settings.webhookUrl,
        devices: settings.devices
            .where((d) => !revokeIds.contains(d.deviceId))
            .toList(growable: false),
        mcpServers: settings.mcpServers,
      );
    }
    return settings;
  }

  @override
  Future<void> updateLlmSettings(
    ConnectionProfile profile, {
    required String providerKind,
    required String modelName,
    String? baseUrl,
    String? apiKey,
  }) async {}

  @override
  Future<void> revokeDevice(ConnectionProfile profile, String deviceId) async {
    revokeCount += 1;
    lastRevokedDeviceId = deviceId;
  }

  @override
  Future<DoorStatus> getDoor(ConnectionProfile profile) async => door;

  String? activeTurnId;

  @override
  Future<HistoryPage> getHistory(
    ConnectionProfile profile, {
    String? beforeId,
    int limit = 50,
  }) async {
    historyFetchCount += 1;
    return HistoryPage(
      items: List<TimelineItem>.from(history),
      hasMore: false,
      latestEventSeq: history.isEmpty ? 0 : history.last.seq,
      activeTurnId: activeTurnId,
    );
  }

  @override
  Future<UploadedMedia> uploadMedia(
    ConnectionProfile profile, {
    required List<int> bytes,
    required String filename,
    required String mimeType,
  }) async {
    mediaUploadCount += 1;
    return UploadedMedia(
      hash: 'a' * 64,
      url: '/api/v1/media/${'a' * 64}',
      mimeType: mimeType,
      size: bytes.length,
    );
  }

  @override
  Future<List<StickerView>> listStickers(ConnectionProfile profile) async {
    return List<StickerView>.from(stickers);
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
    throw const ApiException(
      statusCode: 404,
      code: 'HTTP_404',
      message: '未启用',
    );
  }

  @override
  Future<SendMessageResult> sendMessage(
    ConnectionProfile profile, {
    required String clientMessageId,
    required String content,
    List<String>? attachments,
    String? stickerId,
    VideoClipInfo? videoClip,
    bool urgent = false,
  }) async {
    sentPayloads.add({
      'content': content,
      'attachments': attachments,
      'stickerId': stickerId,
      'videoClip': videoClip?.toJson(),
      'urgent': urgent,
    });
    final isUrgentBypass = door.state == DoorState.closed && urgent;
    final isDoorNote = door.state.isDoorNoteMode && !isUrgentBypass;
    final nextSeq = (history.isEmpty ? 0 : history.last.seq) + 1;
    StickerView? matchedSticker;
    if (stickerId != null) {
      for (final s in stickers) {
        if (s.id == stickerId) {
          matchedSticker = s;
          break;
        }
      }
    }
    final msg = TimelineItem(
      id: 'ev_$nextSeq',
      seq: nextSeq,
      sessionId: 'sess_1',
      turnId: isDoorNote ? null : 'turn_$nextSeq',
      clientMessageId: clientMessageId,
      role: 'user',
      kind: isDoorNote ? 'door_note' : 'chat',
      content: content,
      attachments: attachments ?? const <String>[],
      sticker: matchedSticker,
      videoClip: videoClip,
      urgent: isUrgentBypass,
      createdAt: 1795046400000 + nextSeq * 1000,
    );
    history.add(msg);
    return SendMessageResult(
      message: msg,
      deliveredAs: isDoorNote ? 'door_note' : 'chat',
      turnId: msg.turnId,
    );
  }

  @override
  Future<String> retryTurn(ConnectionProfile profile, String turnId) async {
    retriedTurnIds.add(turnId);
    return 'turn_retry_${retriedTurnIds.length}';
  }

  @override
  Future<WrapUpResult> wrapUpSession(ConnectionProfile profile) async {
    wrapUpCallCount += 1;
    return WrapUpResult(
      oldSessionId: 'sess_1',
      newSessionId: 'sess_${wrapUpCallCount + 1}',
      queued: false,
      wrapped: true,
    );
  }

  @override
  Future<void> deleteMessage(ConnectionProfile profile, String messageId) async {
    history.removeWhere((e) => e.id == messageId);
  }

  @override
  Future<TimelineItem> retractMessage(
    ConnectionProfile profile,
    String messageId,
  ) async {
    retractedIds.add(messageId);
    final idx = history.indexWhere((e) => e.id == messageId);
    if (idx < 0) {
      throw const ApiException(statusCode: 404, code: 'NOT_FOUND', message: '未找到消息');
    }
    final old = history[idx];
    final updated = TimelineItem(
      id: old.id,
      seq: old.seq,
      sessionId: old.sessionId,
      turnId: old.turnId,
      role: old.role,
      kind: old.kind,
      content: '',
      retracted: true,
      retractedBy: 'user',
      createdAt: old.createdAt,
    );
    history[idx] = updated;
    return updated;
  }

  @override
  Future<int?> openShare(ConnectionProfile profile, String shareId) async {
    openedShareIds.add(shareId);
    return 1795046900000;
  }

  @override
  Future<UserStatus> getUserStatus(ConnectionProfile profile) async => userStatus;

  @override
  Future<UserStatus> updateUserStatus(
    ConnectionProfile profile, {
    String? moodText,
    bool clearMood = false,
    bool? undisturbed,
  }) async {
    userStatus = userStatus.copyWith(
      moodText: moodText,
      clearMood: clearMood,
      undisturbed: undisturbed,
      updatedAt: 1795046900000,
    );
    return userStatus;
  }

  @override
  Future<TimelineItem> editMessage(
    ConnectionProfile profile,
    String messageId,
    String content,
  ) async {
    final idx = history.indexWhere((e) => e.id == messageId);
    if (idx < 0) {
      throw const ApiException(statusCode: 404, code: 'NOT_FOUND', message: '未找到消息');
    }
    final old = history[idx];
    final updated = TimelineItem(
      id: '${old.id}_v2',
      seq: old.seq,
      sessionId: old.sessionId,
      turnId: 'turn_edited',
      groupId: old.groupId ?? 'grp_${old.id}',
      version: old.version + 1,
      versionCount: old.versionCount + 1,
      role: old.role,
      kind: old.kind,
      content: content,
      createdAt: old.createdAt,
    );
    history[idx] = updated;
    return updated;
  }

  @override
  Future<void> rerollMessage(ConnectionProfile profile, String messageId) async {}

  @override
  Future<TimelineItem> switchMessageVersion(
    ConnectionProfile profile,
    String messageId,
    int version,
  ) async {
    switchedVersions.add({'messageId': messageId, 'version': version});
    final existing = history.firstWhere((e) => e.id == messageId);
    final updated = TimelineItem(
      id: existing.id,
      seq: existing.seq,
      sessionId: existing.sessionId,
      turnId: existing.turnId,
      groupId: existing.groupId,
      version: version,
      versionCount: existing.versionCount,
      role: existing.role,
      kind: existing.kind,
      content: '第 $version 版回复内容',
      createdAt: existing.createdAt,
    );
    final idx = history.indexWhere((e) => e.id == messageId);
    history[idx] = updated;
    return updated;
  }

  @override
  Future<void> abortTurn(ConnectionProfile profile, String turnId) async {
    abortedTurnIds.add(turnId);
  }

  @override
  Future<List<RecallTraceItem>> getTurnRecall(
    ConnectionProfile profile,
    String turnId,
  ) async {
    recallFetchCount += 1;
    return recallByTurn[turnId] ?? const <RecallTraceItem>[];
  }

  @override
  Future<void> submitRecallFeedback(
    ConnectionProfile profile, {
    required String turnId,
    required String verdict,
    String? cardPath,
    String? note,
  }) async {
    feedbackSubmitted.add({
      'turnId': turnId,
      'verdict': verdict,
      'cardPath': cardPath,
      'note': note,
    });
  }

  @override
  Future<ActivitySessionView?> getActiveActivity(ConnectionProfile profile) async {
    return activeActivity;
  }

  @override
  Future<void> endCinemaActivity(
    ConnectionProfile profile, {
    String? sessionId,
  }) async {
    if (sessionId != null) endedCinemaIds.add(sessionId);
    activeActivity = null;
  }

  @override
  Future<List<DrawerEntryView>> listDrawer(ConnectionProfile profile) async {
    if (drawerUnavailable) {
      throw const ApiException(statusCode: 404, code: 'HTTP_404', message: '未开启');
    }
    return drawerEntries;
  }

  @override
  Future<DrawerOpenedContent> openDrawerEntry(
    ConnectionProfile profile,
    String id,
  ) async {
    final content = drawerContents[id];
    if (content == null) {
      throw const ApiException(statusCode: 404, code: 'NOT_FOUND', message: '条目不存在');
    }
    return content;
  }

  @override
  Future<UsageStatsSnapshot> getUsageStats(ConnectionProfile profile) async => usageStats;

  @override
  Future<LlmTestResult> testLlmModel(
    ConnectionProfile profile, {
    required String provider,
    required String model,
  }) async {
    llmTestCount += 1;
    return const LlmTestResult(ok: true, latencyMs: 128);
  }

  @override
  Future<String> uploadAvatar(
    ConnectionProfile profile, {
    required String who,
    required List<int> bytes,
    required String filename,
    required String mimeType,
  }) async {
    uploadedAvatars.add(who);
    final url = '/api/v1/media/avatar_$who';
    settings = SettingsSnapshot(
      timezone: settings.timezone,
      providers: settings.providers,
      chatSlot: settings.chatSlot,
      thinkingEnabled: settings.thinkingEnabled,
      thinkingLevel: settings.thinkingLevel,
      userAvatarUrl: who == 'user' ? url : settings.userAvatarUrl,
      residentAvatarUrl: who == 'resident' ? url : settings.residentAvatarUrl,
      circadian: settings.circadian,
      desktopNotifyEnabled: settings.desktopNotifyEnabled,
      webhookEnabled: settings.webhookEnabled,
      webhookUrl: settings.webhookUrl,
      devices: settings.devices,
    );
    return url;
  }

  @override
  Future<List<McpPresetView>> getMcpPresets(ConnectionProfile profile) async => mcpPresets;

  @override
  Future<McpServerView?> reconnectMcpServer(ConnectionProfile profile, String serverId) async {
    reconnectedMcpIds.add(serverId);
    for (final s in settings.mcpServers) {
      if (s.id == serverId) return s;
    }
    return null;
  }

  @override
  Future<void> resolveToolApproval(
    ConnectionProfile profile, {
    required String turnId,
    required String approvalId,
    required String decision,
    String scope = 'once',
  }) async {
    resolvedApprovals.add({
      'turnId': turnId,
      'approvalId': approvalId,
      'decision': decision,
      'scope': scope,
    });
  }

  @override
  Stream<SseEventFrame> openEventStream(
    ConnectionProfile profile, {
    required bool foreground,
    String? lastEventId,
  }) {
    streamOpenCount += 1;
    _streamController = StreamController<SseEventFrame>.broadcast(sync: true);
    return _streamController!.stream;
  }
}

void main() {
  test('parseSseLines 正确解析 id/event/data 帧并忽略注释行', () async {
    final lines = Stream<String>.fromIterable([
      ': heartbeat comment',
      'event: ping',
      'data: {"ts": 1234}',
      '',
      'id: 42',
      'event: turn.text',
      'data: {"turnId": "t1", "delta": "你好"}',
      '',
    ]);
    final frames = await parseSseLines(lines).toList();
    expect(frames.length, 2);
    expect(frames[0].event, 'ping');
    expect(frames[0].data['ts'], 1234);
    expect(frames[1].id, '42');
    expect(frames[1].event, 'turn.text');
    expect(frames[1].data['delta'], '你好');
  });

  testWidgets('单地址配对连接 -> 进入聊天流 -> 门楣展开与门缝纸条输入切换', (tester) async {
    final api = FakePsyberApiClient();
    final storage = MemorySessionStorage();
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('pair_submit_button')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('pair_code_field')), 'ABCD-1234');
    await tester.tap(find.byKey(const Key('pair_submit_button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('chat_input_field')), findsOneWidget);
    expect(find.byKey(const Key('chat_voice_button')), findsOneWidget);
    expect(find.byKey(const Key('chat_send_button')), findsNothing);

    api.door = const DoorStatus(
      state: DoorState.closed,
      note: '先歇会儿',
      updatedAt: 1795046500000,
      unreadDoorNotes: 0,
    );
    api.emitSse('door.updated', {
      'state': 'closed',
      'note': '先歇会儿',
      'updatedAt': 1795046500000,
    });
    await tester.pump();

    expect(find.text('门关着'), findsOneWidget);
    expect(find.text('先歇会儿'), findsOneWidget);
    expect(find.byKey(const Key('chat_voice_button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('door_threshold_toggle')));
    await tester.pumpAndSettle();
    expect(find.textContaining('门牌便签：先歇会儿'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('chat_input_field')), '晚点再聊，放门口啦');
    await tester.pump();
    expect(find.byKey(const Key('chat_send_button')), findsOneWidget);
    expect(find.byKey(const Key('chat_voice_button')), findsNothing);
    await tester.tap(find.byKey(const Key('chat_send_button')));
    await tester.pumpAndSettle();

    expect(find.text('门缝纸条'), findsOneWidget);
    expect(find.text('晚点再聊，放门口啦'), findsOneWidget);
  });

  testWidgets('流式 thinking 默认折叠、turn.tool 进度与中止生成（含门楣回复指示与输入台三态按钮）', (tester) async {
    final api = FakePsyberApiClient();
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    // 初始空输入：显示语音输入按钮，且左侧图标与右侧按钮垂直居中对齐
    expect(find.byKey(const Key('chat_voice_button')), findsOneWidget);
    expect(find.byKey(const Key('chat_send_button')), findsNothing);
    expect(find.byKey(const Key('chat_stop_button')), findsNothing);
    final imgCenterY = tester.getCenter(find.byKey(const Key('pick_image_button'))).dy;
    final stickerCenterY = tester.getCenter(find.byKey(const Key('open_stickers_button'))).dy;
    final voiceCenterY = tester.getCenter(find.byKey(const Key('chat_voice_button'))).dy;
    expect((imgCenterY - stickerCenterY).abs(), lessThanOrEqualTo(0.5));
    expect((imgCenterY - voiceCenterY).abs(), lessThanOrEqualTo(0.5));

    // 有输入时切换为发送箭头，清空后恢复语音输入
    await tester.enterText(find.byKey(const Key('chat_input_field')), 'hello');
    await tester.pump();
    expect(find.byKey(const Key('chat_send_button')), findsOneWidget);
    expect(find.byKey(const Key('chat_voice_button')), findsNothing);
    await tester.enterText(find.byKey(const Key('chat_input_field')), '');
    await tester.pump();
    expect(find.byKey(const Key('chat_voice_button')), findsOneWidget);

    // AI 开始回复（未出字前）：门楣、气泡与输入台均明确显示正在回复 / 停止按钮
    api.emitSse('turn.start', {'turnId': 'turn_live', 'mode': 'chat'});
    await tester.pump();
    expect(find.byKey(const Key('door_replying_indicator')), findsOneWidget);
    expect(find.byKey(const Key('streaming_replying_placeholder')), findsOneWidget);
    expect(find.byKey(const Key('chat_stop_button')), findsOneWidget);

    api.emitSse('turn.thinking', {'turnId': 'turn_live', 'delta': '先确认对方刚刚提到的事情'});
    api.emitSse('turn.tool', {
      'turnId': 'turn_live',
      'callId': 'c1',
      'name': 'memory_read',
      'label': '翻看日记',
      'status': 'running',
    });
    api.emitSse('turn.expression', {
      'turnId': 'turn_live',
      'atmosphere': {'tone': 'warm', 'intensity': 'noticeable', 'durationSec': 15},
      'motion': 'nod',
    });
    api.emitSse('turn.text', {'turnId': 'turn_live', 'delta': '我在听呢。'});
    await tester.pump();

    expect(find.text('我在听呢。'), findsOneWidget);
    expect(find.text('思考中…'), findsOneWidget);
    expect(find.text('翻看日记 · 进行中'), findsOneWidget);
    expect(find.text('先确认对方刚刚提到的事情'), findsNothing);
    expect(find.byKey(const Key('streaming_replying_badge')), findsOneWidget);

    await tester.tap(find.byKey(const Key('thinking_toggle')));
    await tester.pump();
    expect(find.text('先确认对方刚刚提到的事情'), findsOneWidget);

    await tester.tap(find.byKey(const Key('chat_stop_button')));
    await tester.pump();
    expect(api.abortedTurnIds, ['turn_live']);
    expect(find.byKey(const Key('chat_stop_button')), findsNothing);
    expect(find.byKey(const Key('chat_voice_button')), findsOneWidget);
  });

  testWidgets('召回评测浮条默认关闭，开启后懒加载并可提交标注；切后台静默重连不弹红条', (tester) async {
    final api = FakePsyberApiClient()
      ..history = [
        const TimelineItem(
          id: 'ev_1',
          seq: 1,
          sessionId: 'sess_1',
          turnId: 'turn_eval_1',
          role: 'assistant',
          kind: 'chat',
          content: '记得你上次说过喜欢热红茶。',
          recallCount: 1,
          createdAt: 1795046401000,
        ),
      ]
      ..recallByTurn['turn_eval_1'] = const [
        RecallTraceItem(
          cardPath: 'daily/2026-11-20-tea.md',
          title: '喝热红茶',
          track: 'cross_vector',
          finalScore: 0.88,
        ),
      ];

    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('想起 1 张卡'), findsNothing);
    expect(api.recallFetchCount, 0);

    await tester.tap(find.byKey(const Key('left_drawer_button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings_button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('recall_eval_switch')));
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byKey(const Key('recall_eval_switch')))).pop();
    await tester.pumpAndSettle();

    expect(find.text('想起 1 张卡'), findsOneWidget);
    expect(api.recallFetchCount, 0);

    await tester.tap(find.byKey(const Key('recall_capsule_turn_eval_1')));
    await tester.pumpAndSettle();
    expect(api.recallFetchCount, 1);
    expect(find.textContaining('喝热红茶'), findsOneWidget);

    await tester.tap(find.byKey(const Key('recall_useful_turn_eval_1_0')));
    await tester.pumpAndSettle();
    expect(api.feedbackSubmitted.length, 1);
    expect(api.feedbackSubmitted.first['verdict'], 'useful');

    final prevStreamCount = api.streamOpenCount;
    final prevHistoryCount = api.historyFetchCount;
    controller.onAppPaused();
    controller.onAppResumed();
    await tester.pumpAndSettle();
    expect(api.streamOpenCount, greaterThan(prevStreamCount));
    expect(api.historyFetchCount, greaterThan(prevHistoryCount));
    expect(controller.turnErrorNotifier.value, isNull);
  });

  testWidgets('发图上传预览并发送纯图消息，以及打开贴纸网格面板发送贴纸', (tester) async {
    final api = FakePsyberApiClient()
      ..stickers = const [
        StickerView(id: 'hug', label: '抱抱', url: ''),
      ];
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(
      PsyberApp(
        controller: controller,
        imagePicker: () async => const PickedImage(
          bytes: [137, 80, 78, 71],
          filename: 'sunset.png',
          mimeType: 'image/png',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('pick_image_button')));
    await tester.pumpAndSettle();
    expect(api.mediaUploadCount, 1);
    expect(find.byKey(const Key('pending_attachment_0')), findsOneWidget);
    expect(find.text('sunset.png'), findsOneWidget);

    await tester.tap(find.byKey(const Key('chat_send_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pending_attachment_0')), findsNothing);
    expect(api.sentPayloads.length, 1);
    expect(api.sentPayloads.first['attachments'], ['a' * 64]);

    await tester.tap(find.byKey(const Key('open_stickers_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sticker_option_hug')), findsOneWidget);

    await tester.tap(find.byKey(const Key('sticker_option_hug')));
    await tester.pumpAndSettle();
    // 选中贴纸后先暂存到输入台，不立即发出，保留继续打字的机会
    expect(api.sentPayloads.length, 1);
    expect(find.byKey(const Key('pending_sticker_chip')), findsOneWidget);
    expect(find.text('贴纸：抱抱'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('chat_input_field')), '辛苦啦');
    await tester.tap(find.byKey(const Key('chat_send_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pending_sticker_chip')), findsNothing);
    expect(api.sentPayloads.length, 2);
    expect(api.sentPayloads[1]['stickerId'], 'hug');
    expect(api.sentPayloads[1]['content'], '辛苦啦');
    expect(find.text('[贴纸：抱抱]'), findsOneWidget);
    expect(find.text('辛苦啦'), findsOneWidget);
  });

  testWidgets(
    '宽屏设置侧栏回显与保存、观影伴看槽位及 Ring 1.5 版本切换与上锁抽屉确认',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final api = FakePsyberApiClient()
      ..history = [
        const TimelineItem(
          id: 'ev_user_1',
          seq: 1,
          sessionId: 'sess_1',
          role: 'user',
          kind: 'chat',
          content: '第一句问候',
          createdAt: 1795046400000,
        ),
        const TimelineItem(
          id: 'ev_asst_1',
          seq: 2,
          sessionId: 'sess_1',
          turnId: 'turn_1',
          groupId: 'grp_1',
          version: 1,
          versionCount: 2,
          role: 'assistant',
          kind: 'chat',
          content: '```dart\nprint(1);\n```',
          createdAt: 1795046405000,
        ),
      ]
      ..drawerEntries = const [
        DrawerEntryView(
          id: 'night-note',
          title: '半夜记下的心情',
          createdAt: 1795046400000,
          updatedAt: 1795046400000,
          peeked: false,
        ),
      ]
      ..drawerContents['night-note'] = const DrawerOpenedContent(
        id: 'night-note',
        title: '半夜记下的心情',
        content: '其实今天有点想听雨声。',
        createdAt: 1795046400000,
        updatedAt: 1795046400000,
        peekedEventId: 'ev_peek_1',
      );

    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    // 验证代码块渲染与版本切换器（1 / 2 -> 2 / 2）
    expect(find.text('dart'), findsOneWidget);
    expect(find.text('1 / 2'), findsOneWidget);
    await tester.tap(find.byKey(const Key('version_next_ev_asst_1')));
    await tester.pumpAndSettle();
    expect(api.switchedVersions.first['version'], 2);
    expect(find.text('第 2 版回复内容'), findsOneWidget);

    // 验证点击更多菜单打开上下文操作并触发编辑重发与软删
    await tester.tap(find.byKey(const Key('msg_more_ev_user_1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('edit_msg_ev_user_1')), findsOneWidget);
    await tester.tap(find.byKey(const Key('edit_msg_ev_user_1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, '修改后的问候');
    await tester.tap(find.text('保存并重发'));
    await tester.pumpAndSettle();
    expect(find.text('修改后的问候'), findsOneWidget);

    await tester.tap(find.byKey(const Key('msg_more_ev_user_1_v2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('delete_msg_ev_user_1_v2')));
    await tester.pumpAndSettle();
    expect(find.text('修改后的问候'), findsNothing);

    // 验证 Ring 1.5 观影伴看 SSE 槽位与结束伴看
    api.emitSse('activity.updated', {
      'session': {
        'id': 'act_1',
        'slug': 'cinema',
        'title': '星际穿越',
        'topicHint': 'interstellar',
        'status': 'active',
        'startedAt': 1795046400000,
        'lastHeartbeatAt': 1795046400000,
        'metadata': {'positionSec': 125, 'playbackState': 'playing'},
      },
    });
    await tester.pump();
    expect(find.byKey(const Key('activity_banner_slot')), findsOneWidget);
    expect(find.text('正在一起看：星际穿越'), findsOneWidget);
    await tester.tap(find.byKey(const Key('end_activity_button')));
    await tester.pumpAndSettle();
    expect(api.endedCinemaIds, ['act_1']);
    expect(find.byKey(const Key('activity_banner_slot')), findsNothing);

    // 宽屏默认展开无遮罩左侧边栏，且支持收起/再展开
    expect(find.byKey(const Key('desktop_left_sidebar')), findsOneWidget);
    expect(find.byKey(const Key('settings_button')), findsOneWidget);
    expect(find.byKey(const Key('open_drawer_entry')), findsOneWidget);
    await tester.tap(find.byKey(const Key('left_drawer_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('desktop_left_sidebar')), findsNothing);
    await tester.tap(find.byKey(const Key('left_drawer_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('desktop_left_sidebar')), findsOneWidget);

    // 宽屏点击右上角常用活动应弹出轻量 Popover，而非全屏 Drawer 遮罩
    await tester.tap(find.byKey(const Key('right_drawer_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('activity_popover_card')), findsOneWidget);
    expect(find.text('放映伴看'), findsOneWidget);
    expect(find.byType(Drawer), findsNothing);
    Navigator.of(tester.element(find.byKey(const Key('activity_popover_card')))).pop();
    await tester.pumpAndSettle();

    // 宽屏点击设置应展开右侧栏而非覆盖页面，并回显 GET /settings 内容
    await tester.tap(find.byKey(const Key('settings_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('close_settings_button')), findsOneWidget);
    expect(find.text('openai · gpt-4o'), findsOneWidget);

    // 确保作息保存与已配对设备（本机）可滚入视口并正常交互
    await tester.scrollUntilVisible(
      find.text('保存作息与通知'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.ensureVisible(find.text('保存作息与通知'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存作息与通知'));
    await tester.pumpAndSettle();
    expect(api.settingsPatches.length, 1);

    await tester.scrollUntilVisible(
      find.text('本机'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.text('本机'), findsOneWidget);
    // 设置页中不再保留重复的「上锁的抽屉」入口
    expect(
      find.descendant(
        of: find.byType(SettingsPanelContent),
        matching: find.byKey(const Key('open_drawer_entry')),
      ),
      findsNothing,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('desktop_left_sidebar')),
        matching: find.byKey(const Key('open_drawer_entry')),
      ),
      findsOneWidget,
    );

    // 验证桌面端快捷键：Esc 关闭设置侧栏；Enter 直接发送消息（Shift+Enter 换行）
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('close_settings_button')), findsNothing);

    await tester.enterText(find.byKey(const Key('chat_input_field')), '桌面回车直发');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(api.sentPayloads.length, 1);
    expect(api.sentPayloads.first['content'], '桌面回车直发');

    // 从左侧边栏唯一入口打开「上锁的抽屉」并完成二次确认拆封
    await tester.tap(find.byKey(const Key('open_drawer_entry')));
    await tester.pumpAndSettle();
    expect(find.text('半夜记下的心情'), findsOneWidget);
    await tester.tap(find.text('半夜记下的心情'));
    await tester.pumpAndSettle();
    expect(find.textContaining('确认要打开吗'), findsOneWidget);
    await tester.tap(find.text('确认拆封'));
    await tester.pumpAndSettle();
    expect(find.text('其实今天有点想听雨声。'), findsOneWidget);
    },
  );

  testWidgets('Genesis 初生向导支持选择 OpenAI 兼容并动态展开 Base URL 提交', (tester) async {
    final api = FakePsyberApiClient()
      ..genesis = const GenesisStatus(
        initialized: false,
        named: false,
        hasChatProvider: false,
        timezone: 'Asia/Shanghai',
        sleepStart: '23:30',
        sleepEnd: '07:30',
      );
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('初次见面'), findsOneWidget);
    expect(find.byKey(const Key('genesis_base_url_field')), findsNothing);

    await tester.tap(find.text('OpenAI 兼容'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('genesis_base_url_field')), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('genesis_base_url_field')),
      'https://api.example.com/v1',
    );
    await tester.enterText(find.byKey(const Key('genesis_model_field')), 'deepseek-chat');
    await tester.enterText(find.byKey(const Key('genesis_apikey_field')), 'sk-test-123');
    await tester.ensureVisible(find.byKey(const Key('genesis_submit_button')));
    await tester.tap(find.byKey(const Key('genesis_submit_button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('chat_input_field')), findsOneWidget);
  });

  test('disconnect 通知服务端吊销并清空本地凭证，FileSessionStorage 在沙盒环境下安全降级', () async {
    final tempDir = await Directory.systemTemp.createTemp('psyber_session_test');
    final sessionFile = File('${tempDir.path}/client_session.json');
    final storage = FileSessionStorage(file: sessionFile);
    final api = FakePsyberApiClient();
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    });

    const profile = ConnectionProfile(
      baseUrl: 'http://localhost:3721',
      token: 'psb_test_token',
      deviceId: 'dev_sandbox_01',
      deviceName: 'Mac',
      instanceId: 'inst-001',
    );
    await storage.save(profile);
    expect(await sessionFile.exists(), isTrue);

    await controller.initialize();
    expect(controller.profileNotifier.value?.token, 'psb_test_token');

    await controller.disconnect();
    expect(api.revokeCount, 1);
    expect(api.lastRevokedDeviceId, 'dev_sandbox_01');
    expect(await sessionFile.exists(), isFalse);
    expect(controller.profileNotifier.value, isNull);
    expect(controller.connectionNotifier.value, ConnectionPhase.unpaired);
  });

  test('loadOlderHistory 翻页后触发 refreshSnapshot 不丢失旧消息，且 door.updated 开门清零未读纸条', () async {
    final api = _PaginatedFakeApiClient();
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await Future<void>.delayed(Duration.zero);
    expect(controller.timelineNotifier.value.map((e) => e.id).toList(), ['ev_2']);
    expect(controller.hasMoreHistory, isTrue);

    await controller.loadOlderHistory();
    expect(controller.timelineNotifier.value.map((e) => e.id).toList(), ['ev_1', 'ev_2']);
    expect(controller.hasMoreHistory, isFalse);

    api.latestItems.add(
      const TimelineItem(
        id: 'ev_3',
        seq: 3,
        sessionId: 'sess_1',
        role: 'assistant',
        kind: 'chat',
        content: '最新一条回复',
        createdAt: 1795046403000,
      ),
    );
    api.emitSse('turn.done', {'turnId': 't_3'});
    await Future<void>.delayed(Duration.zero);
    expect(
      controller.timelineNotifier.value.map((e) => e.id).toList(),
      ['ev_1', 'ev_2', 'ev_3'],
    );
    expect(controller.hasMoreHistory, isFalse);

    api.emitSse('door.updated', {'state': 'closed', 'note': '休息', 'unreadDoorNotes': 2});
    expect(controller.doorNotifier.value.unreadDoorNotes, 2);

    api.emitSse('door.updated', {'state': 'open', 'note': null});
    expect(controller.doorNotifier.value.unreadDoorNotes, 0);
  });

  testWidgets(
    'macOS 最小窄窗 420x560 下门楣顶栏不产生 RenderFlex 溢出',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      tester.view.physicalSize = const Size(420, 560);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final api = FakePsyberApiClient()
        ..door = const DoorStatus(
          state: DoorState.open,
          note: '正在看书',
          updatedAt: 1795046400000,
          unreadDoorNotes: 3,
        );
      final storage = MemorySessionStorage(
        const ConnectionProfile(
          baseUrl: 'http://localhost:3721',
          token: 'demo-session-value',
          deviceId: 'dev-1',
          instanceId: 'inst-test-001',
          deviceName: 'Mac',
        ),
      );
      final controller = AppController(api: api, storage: storage);
      addTearDown(() async {
        await api.closeStream();
        controller.dispose();
      });

      await controller.initialize();
      await tester.pumpWidget(PsyberApp(controller: controller));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('door_threshold_toggle')), findsOneWidget);
      expect(find.text('Psyber'), findsOneWidget);
      expect(find.text('门开着'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('turn.error 渲染内联 FailureLine 并原地重试，turn.silence 渲染 SilenceLine', (
    tester,
  ) async {
    final api = FakePsyberApiClient()
      ..history = [
        const TimelineItem(
          id: 'ev_1',
          seq: 1,
          sessionId: 'sess_1',
          turnId: 'turn_1',
          role: 'user',
          kind: 'chat',
          content: '今天风很大',
          createdAt: 1795046401000,
        ),
      ];
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    api.emitSse('turn.error', {
      'turnId': 'turn_1',
      'code': 'PROVIDER_ERROR',
      'message': '上游模型服务暂时超时',
      'retryable': true,
    });
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('failure_line')), findsOneWidget);
    expect(find.text('上一轮中断 · 模型服务暂时没有响应'), findsOneWidget);
    expect(find.text('今天风很大'), findsOneWidget);

    await tester.tap(find.byKey(const Key('retry_failed_turn_button')));
    await tester.pumpAndSettle();

    expect(api.retriedTurnIds, ['turn_1']);
    expect(find.text('今天风很大'), findsOneWidget);
    expect(find.byKey(const Key('failure_line')), findsNothing);

    api.emitSse('turn.silence', {'turnId': 'turn_2', 'ownTime': false});
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('silence_line')), findsOneWidget);
    expect(find.byKey(const Key('failure_line')), findsNothing);
  });

  testWidgets('TurnJournalCard 聚合思考与非隐私工具，看屏独立展示，换模型显示分割线', (
    tester,
  ) async {
    final api = FakePsyberApiClient()
      ..history = [
        const TimelineItem(
          id: 'ev_1',
          seq: 1,
          sessionId: 'sess_1',
          role: 'assistant',
          kind: 'chat',
          content: '我记得你上次说喜欢乌龙茶。',
          model: 'claude-sonnet',
          thinking: '先翻翻之前提到的口味',
          toolSummary: [
            ToolSummaryItem(name: 'recall_memory', label: '翻看记忆库', ok: true, kind: 'memory'),
            ToolSummaryItem(name: 'look_at_screen', label: '看一眼屏幕', ok: true, kind: 'screen'),
          ],
          createdAt: 1795046401000,
        ),
        const TimelineItem(
          id: 'ev_2',
          seq: 2,
          sessionId: 'sess_1',
          role: 'assistant',
          kind: 'chat',
          content: '现在切换过来继续聊。',
          model: 'gpt-4o',
          createdAt: 1795046402000,
        ),
      ];
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.byType(TurnJournalCard), findsOneWidget);
    expect(find.byType(ScreenToolCard), findsOneWidget);
    expect(find.byKey(const Key('model_switch_gpt-4o')), findsOneWidget);
    expect(find.text('思索 · 翻看记忆库'), findsOneWidget);
    expect(find.text('看一眼屏幕'), findsOneWidget);

    await tester.tap(find.byKey(const Key('thinking_toggle')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('thinking_body')), findsOneWidget);
    expect(find.textContaining('先翻翻之前提到的口味'), findsOneWidget);
    expect(find.textContaining('翻看记忆库'), findsWidgets);
  });

  testWidgets('草稿自动保存并恢复，且短视频消息渲染 VideoTile', (tester) async {
    final api = FakePsyberApiClient()
      ..history = [
        const TimelineItem(
          id: 'ev_1',
          seq: 1,
          sessionId: 'sess_1',
          role: 'user',
          kind: 'chat',
          content: '给你看一小段窗外雨景',
          videoClip: VideoClipInfo(durationSec: 6.0, frameHashes: ['h1', 'h2']),
          createdAt: 1795046401000,
        ),
      ];
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );

    final c1 = AppController(api: api, storage: storage);
    await c1.initialize();
    await tester.pumpWidget(PsyberApp(controller: c1));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('video_tile_card')), findsOneWidget);
    expect(find.text('0:06'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('chat_input_field')), '还没说完的一半');
    await tester.pump();
    expect(await storage.loadDraft(), '还没说完的一半');

    await tester.pumpWidget(const SizedBox.shrink());
    await api.closeStream();
    c1.dispose();

    final c2 = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      c2.dispose();
    });
    await c2.initialize();
    await tester.pumpWidget(PsyberApp(controller: c2));
    await tester.pumpAndSettle();

    final field = tester.widget<TextField>(find.byKey(const Key('chat_input_field')));
    expect(field.controller?.text, '还没说完的一半');
  });

  testWidgets(
    '移动端 Enter 不直接发送而是换行',
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
    (tester) async {
      final api = FakePsyberApiClient();
      final storage = MemorySessionStorage(
        const ConnectionProfile(
          baseUrl: 'http://localhost:3721',
          token: 'demo-session-value',
          deviceId: 'dev-1',
          instanceId: 'inst-test-001',
          deviceName: 'iPhone',
        ),
      );
      final controller = AppController(api: api, storage: storage);
      addTearDown(() async {
        await api.closeStream();
        controller.dispose();
      });

      await controller.initialize();
      await tester.pumpWidget(PsyberApp(controller: controller));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('chat_input_field')), '第一行');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(api.sentPayloads, isEmpty);
    },
  );

  testWidgets(
    '桌面端 Enter 发送且侧边栏支持手动存记忆换段',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final api = FakePsyberApiClient();
      final storage = MemorySessionStorage(
        const ConnectionProfile(
          baseUrl: 'http://localhost:3721',
          token: 'demo-session-value',
          deviceId: 'dev-1',
          instanceId: 'inst-test-001',
          deviceName: 'Mac',
        ),
      );
      final controller = AppController(api: api, storage: storage);
      addTearDown(() async {
        await api.closeStream();
        controller.dispose();
      });

      await controller.initialize();
      await tester.pumpWidget(PsyberApp(controller: controller));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('chat_input_field')), '桌面端直接回车发出');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(api.sentPayloads, hasLength(1));
      expect(api.sentPayloads.single['content'], '桌面端直接回车发出');

      await tester.tap(find.byKey(const Key('manual_wrap_up_button')));
      await tester.pumpAndSettle();

      expect(api.wrapUpCallCount, 1);
      expect(find.text('已收拢这段记忆，开启新一段'), findsOneWidget);
    },
  );

  testWidgets('3 秒二次点击防误触删除 + 双向社交撤回占位显示', (tester) async {
    final api = FakePsyberApiClient()
      ..history = [
        const TimelineItem(
          id: 'ev_u1',
          seq: 1,
          sessionId: 'sess_1',
          role: 'user',
          kind: 'chat',
          content: '发错窗口的一句话',
          createdAt: 1795046401000,
        ),
        const TimelineItem(
          id: 'ev_a1',
          seq: 2,
          sessionId: 'sess_1',
          role: 'assistant',
          kind: 'chat',
          content: '测试可删除的回复',
          createdAt: 1795046402000,
        ),
      ];
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    // 1. 删除需要两步点击（首击显示「再点删除」不删，二次点击才删除）
    await tester.tap(find.byKey(const Key('hover_delete_ev_a1')));
    await tester.pump();
    expect(find.text('再点删除'), findsOneWidget);
    expect(find.text('测试可删除的回复'), findsOneWidget);

    await tester.tap(find.byKey(const Key('hover_delete_ev_a1')));
    await tester.pumpAndSettle();
    expect(find.text('测试可删除的回复'), findsNothing);

    // 2. 用户一键撤回自己的消息 -> 变为居中占位「你撤回了一条消息」
    await tester.tap(find.byKey(const Key('hover_retract_ev_u1')));
    await tester.pumpAndSettle();
    expect(api.retractedIds, ['ev_u1']);
    expect(find.text('发错窗口的一句话'), findsNothing);
    expect(find.text('你撤回了一条消息'), findsOneWidget);

    // 3. 住户侧撤回通过 SSE 同步 -> 显示「对方撤回了一条消息」
    api.emitSse('message.updated', {
      'action': 'retract',
      'retractedId': 'ev_a2',
      'message': {
        'id': 'ev_a2',
        'seq': 3,
        'sessionId': 'sess_1',
        'role': 'assistant',
        'kind': 'chat',
        'content': '',
        'retracted': true,
        'retractedBy': 'resident',
        'createdAt': 1795046403000,
      },
    });
    await tester.pumpAndSettle();
    expect(find.text('对方撤回了一条消息'), findsOneWidget);
  });

  testWidgets('折叠分享卡首次点开上报拆阅回执 + 关门态二次确认一次性紧急直达', (tester) async {
    final api = FakePsyberApiClient()
      ..door = const DoorStatus(
        state: DoorState.closed,
        note: '先静一静',
        updatedAt: 1795046400000,
        unreadDoorNotes: 0,
      )
      ..history = [
        const TimelineItem(
          id: 'ev_share_1',
          seq: 1,
          sessionId: 'sess_1',
          role: 'assistant',
          kind: 'chat',
          content: '写了一小段随笔递给你。',
          shares: [
            ShareCardItem(
              id: 'sh_1',
              title: '雨夜随笔',
              content: '窗外下雨了，顺手记几句。',
              createdAt: 1795046401000,
            ),
          ],
          createdAt: 1795046401000,
        ),
      ];
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    // 分享卡默认折叠：仅显示标题，不展示正文，且未上报拆阅
    expect(find.text('雨夜随笔'), findsOneWidget);
    expect(find.text('窗外下雨了，顺手记几句。'), findsNothing);
    expect(api.openedShareIds, isEmpty);

    // 点击展开后显示正文并上报一次拆阅回执
    await tester.tap(find.byKey(const Key('share_card_toggle_sh_1')));
    await tester.pumpAndSettle();
    expect(find.text('窗外下雨了，顺手记几句。'), findsOneWidget);
    expect(api.openedShareIds, ['sh_1']);

    // 关门态点击「有急事」-> 弹二次确认 -> 确认开启 -> 发送一条后自动关闭
    await tester.tap(find.byKey(const Key('urgent_channel_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('confirm_urgent_channel_button')), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm_urgent_channel_button')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('chat_input_field')), '急事直达测试');
    await tester.pump();
    await tester.tap(find.byKey(const Key('chat_send_button')));
    await tester.pumpAndSettle();

    expect(api.sentPayloads.length, 1);
    expect(api.sentPayloads.first['urgent'], true);
    expect(find.text('紧急直达'), findsOneWidget);
    // 发完自动复位回门缝纸条态（「有急事」重新出现而非「取消紧急」）
    expect(find.text('有急事'), findsOneWidget);
  });

  testWidgets(
    '左侧边栏顶部双人状态卡支持快捷留心绪与一键切换勿扰',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final api = FakePsyberApiClient()
        ..door = const DoorStatus(
          state: DoorState.open,
          note: '正在听黑胶',
          updatedAt: 1795046400000,
          unreadDoorNotes: 0,
        );
      final storage = MemorySessionStorage(
        const ConnectionProfile(
          baseUrl: 'http://localhost:3721',
          token: 'demo-session-value',
          deviceId: 'dev-1',
          instanceId: 'inst-test-001',
          deviceName: 'Mac',
        ),
      );
      final controller = AppController(api: api, storage: storage);
      addTearDown(() async {
        await api.closeStream();
        controller.dispose();
      });

      await controller.initialize();
      await tester.pumpWidget(PsyberApp(controller: controller));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('dual_status_card')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const Key('dual_status_card')),
          matching: find.text('正在听黑胶'),
        ),
        findsOneWidget,
      );

      // 一键切换勿扰
      await tester.tap(find.byKey(const Key('user_dnd_toggle')));
      await tester.pumpAndSettle();
      expect(api.userStatus.undisturbed, isTrue);
      expect(find.text('勿扰中'), findsOneWidget);

      // 点击心绪气泡写下一句心绪
      await tester.tap(find.byKey(const Key('user_mood_bubble')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('user_mood_input')), '有点累，刚下班');
      await tester.tap(find.byKey(const Key('user_mood_save_button')));
      await tester.pumpAndSettle();

      expect(api.userStatus.moodText, '有点累，刚下班');
      expect(find.text('有点累，刚下班'), findsOneWidget);
    },
  );

  testWidgets(
    '设置页支持一键测连通、思考档位、消耗统计、双人头像上传与 5 套暖调色板切换',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final api = FakePsyberApiClient();
      final storage = MemorySessionStorage(
        const ConnectionProfile(
          baseUrl: 'http://localhost:3721',
          token: 'demo-session-value',
          deviceId: 'dev-1',
          instanceId: 'inst-test-001',
          deviceName: 'Mac',
        ),
      );
      final controller = AppController(api: api, storage: storage);
      addTearDown(() async {
        await api.closeStream();
        controller.dispose();
      });

      await controller.initialize();
      await tester.pumpWidget(
        PsyberApp(
          controller: controller,
          imagePicker: () async => const PickedImage(
            bytes: [137, 80, 78, 71],
            filename: 'avatar.png',
            mimeType: 'image/png',
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('settings_button')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('test_llm_button')));
      await tester.pumpAndSettle();
      expect(api.llmTestCount, 1);
      expect(find.text('连通正常 · 128 ms'), findsOneWidget);

      await tester.tap(find.byKey(const Key('thinking_level_low')));
      await tester.pumpAndSettle();
      expect(api.settingsPatches.isNotEmpty, isTrue);

      await tester.tap(find.byKey(const Key('load_usage_stats_button')));
      await tester.pumpAndSettle();
      expect(find.text('\$0.0125'), findsOneWidget);
      expect(find.textContaining('42.9%'), findsWidgets);

      await tester.scrollUntilVisible(
        find.byKey(const Key('palette_oldBookPaper')),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.byKey(const Key('upload_user_avatar_button')));
      await tester.pumpAndSettle();
      expect(api.uploadedAvatars, ['user']);
      expect(find.text('我的头像已更新'), findsOneWidget);

      await tester.tap(find.byKey(const Key('palette_oldBookPaper')));
      await tester.pumpAndSettle();
      expect(controller.paletteNotifier.value, PsyberPalette.oldBookPaper);
      expect(find.byKey(const Key('paper_grain_overlay')), findsOneWidget);

      await tester.tap(find.byKey(const Key('palette_shoreLight')));
      await tester.pumpAndSettle();
      expect(controller.paletteNotifier.value, PsyberPalette.shoreLight);
      expect(find.byKey(const Key('paper_grain_overlay')), findsOneWidget);

      await tester.tap(find.byKey(const Key('palette_shoreDark')));
      await tester.pumpAndSettle();
      expect(controller.paletteNotifier.value, PsyberPalette.shoreDark);
      expect(find.byKey(const Key('paper_grain_overlay')), findsOneWidget);

      final switches = tester.widgetList<CupertinoSwitch>(find.byType(CupertinoSwitch));
      expect(switches, isNotEmpty);
      expect(switches.first.activeTrackColor, PsyberColors.shoreDark.accent);

      await tester.tap(find.byKey(const Key('open_drawer_entry')));
      await tester.pumpAndSettle();
      final drawerDialog = tester.widget<Dialog>(find.byType(Dialog));
      expect(drawerDialog.backgroundColor, PsyberColors.shoreDark.letterSurface);
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('palette_warmPaper')));
      await tester.pumpAndSettle();
      expect(controller.paletteNotifier.value, PsyberPalette.warmPaper);
      expect(find.byKey(const Key('paper_grain_overlay')), findsNothing);
    },
  );

  testWidgets(
    '外部 MCP 预设添加、重连与同步高风险工具审批确认卡',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final api = FakePsyberApiClient();
      final storage = MemorySessionStorage(
        const ConnectionProfile(
          baseUrl: 'http://localhost:3721',
          token: 'demo-session-value',
          deviceId: 'dev-1',
          instanceId: 'inst-test-001',
          deviceName: 'Mac',
        ),
      );
      final controller = AppController(api: api, storage: storage);
      addTearDown(() async {
        await api.closeStream();
        controller.dispose();
      });

      await controller.initialize();
      await tester.pumpWidget(PsyberApp(controller: controller));
      await tester.pumpAndSettle();

      // 1. 收到 turn.approval_required 时展示同步审批卡，点击允许后调用审批接口并收起卡片
      api.emitSse('turn.approval_required', {
        'approvalId': 'apr_1',
        'turnId': 'turn_mcp_1',
        'toolName': 'mcp.fetch.get',
        'summary': '抓取公开网页正文',
        'arguments': {'url': 'https://example.com'},
        'expiresAt': 1795046999000,
      });
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('tool_approval_card')), findsOneWidget);
      expect(find.textContaining('mcp.fetch.get'), findsOneWidget);

      await tester.tap(find.byKey(const Key('approval_allow_once_button')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('tool_approval_card')), findsNothing);
      expect(api.resolvedApprovals.length, 1);
      expect(api.resolvedApprovals.first['decision'], 'allow');

      // 2. 在设置页通过预设添加外部 MCP 服务器并验证重连按钮
      await tester.tap(find.byKey(const Key('settings_button')));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('mcp_add_preset_button')),
        240,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.ensureVisible(find.byKey(const Key('mcp_add_preset_button')));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('mcp_add_preset_button')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('mcp_preset_fetch')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('mcp_save_button')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('mcp_save_button')));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byKey(const Key('mcp_reconnect_fetch')));
      await tester.pumpAndSettle();
      expect(find.text('fetch'), findsOneWidget);
      expect(find.text('已连接 · 2 工具'), findsOneWidget);

      await tester.tap(find.byKey(const Key('mcp_reconnect_fetch')));
      await tester.pumpAndSettle();
      expect(api.reconnectedMcpIds, ['fetch']);
    },
  );

  testWidgets('工具轮次断流重连保留流式进度并按 turn.text / message.created 无缝恢复显示', (tester) async {
    final api = FakePsyberApiClient();
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'demo-session-value',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });

    await controller.initialize();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    // 1. 工具轮次开始，客户端已看到思考链与工具调用进度
    api.activeTurnId = 'turn_tool_reconn';
    api.emitSse('turn.start', {'turnId': 'turn_tool_reconn', 'mode': 'chat'}, id: '1');
    api.emitSse(
      'turn.thinking',
      {'turnId': 'turn_tool_reconn', 'delta': '先查一下旧笔记'},
      id: '2',
    );
    api.emitSse(
      'turn.tool',
      {
        'turnId': 'turn_tool_reconn',
        'callId': 'tc_1',
        'name': 'glob',
        'label': '翻了翻记忆目录',
        'status': 'done',
      },
      id: '3',
    );
    await tester.pump();
    expect(find.text('思考中…'), findsOneWidget);

    // 2. 模拟短暂重连：activeTurnId 仍在服务端运行，重连不应清空已收到的流式思考链与工具进度
    await controller.connectAndSync();
    await tester.pump();
    expect(controller.activeTurnNotifier.value?.turnId, 'turn_tool_reconn');
    expect(controller.activeTurnNotifier.value?.thinking, '先查一下旧笔记');
    expect(controller.activeTurnNotifier.value?.tools.length, 1);

    // 3. 即使极端情况下 activeTurnNotifier 为空且错过 turn.start，后续 turn.text 也能自动恢复流式气泡
    controller.activeTurnNotifier.value = null;
    api.emitSse(
      'turn.text',
      {'turnId': 'turn_tool_reconn', 'delta': '我查到了，'},
      id: '4',
    );
    api.emitSse(
      'turn.text',
      {'turnId': 'turn_tool_reconn', 'delta': '内容在这里。'},
      id: '5',
    );
    await tester.pump();
    expect(find.text('我查到了，内容在这里。'), findsOneWidget);

    // 4. 服务端持久化后通过 message.created 落入时间线并无缝收起流式占位
    api.activeTurnId = null;
    api.emitSse(
      'message.created',
      {
        'message': {
          'id': 'ev_tool_1',
          'seq': 10,
          'sessionId': 'sess_1',
          'turnId': 'turn_tool_reconn',
          'role': 'assistant',
          'kind': 'chat',
          'content': '我查到了，内容在这里。',
          'thinking': '先查一下旧笔记',
          'toolSummary': [
            {'name': 'glob', 'label': '翻了翻记忆目录', 'ok': true, 'kind': 'general'},
          ],
          'createdAt': 1795046499000,
        },
      },
      id: '6',
    );
    await tester.pump();
    expect(controller.activeTurnNotifier.value, isNull);
    expect(find.text('我查到了，内容在这里。'), findsOneWidget);
    expect(find.byKey(const Key('streaming_bubble')), findsNothing);
  });

  test('日间与夜间独立色板可持久化保存与恢复', () async {
    final tmpDir = await Directory.systemTemp.createTemp('psyber_theme_prefs_');
    addTearDown(() async {
      if (await tmpDir.exists()) await tmpDir.delete(recursive: true);
    });
    final sessionFile = File('${tmpDir.path}/client_session.json');
    final storage = FileSessionStorage(file: sessionFile);
    await storage.save(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'tok-persist',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );

    final api1 = FakePsyberApiClient();
    final ctrl1 = AppController(api: api1, storage: storage);
    addTearDown(() async {
      await api1.closeStream();
      ctrl1.dispose();
    });
    await ctrl1.initialize();
    ctrl1.setPalette(PsyberPalette.oldBookPaper);
    ctrl1.setPalette(PsyberPalette.shoreDark);
    ctrl1.setThemeMode(ThemeMode.system);
    await Future<void>.delayed(const Duration(milliseconds: 80));

    final api2 = FakePsyberApiClient();
    final ctrl2 = AppController(api: api2, storage: FileSessionStorage(file: sessionFile));
    addTearDown(() async {
      await api2.closeStream();
      ctrl2.dispose();
    });
    await ctrl2.initialize();
    expect(ctrl2.themeModeNotifier.value, ThemeMode.system);
    expect(ctrl2.lightPaletteNotifier.value, PsyberPalette.oldBookPaper);
    expect(ctrl2.darkPaletteNotifier.value, PsyberPalette.shoreDark);
  });

  testWidgets('流式 express 贴纸与动作在正文到齐后可见并继承至落盘气泡', (tester) async {
    final api = FakePsyberApiClient();
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://localhost:3721',
        token: 'tok-expr',
        deviceId: 'dev-1',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });
    await controller.initialize();
    await controller.connectAndSync();
    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    expect(api.streamOpenCount, greaterThanOrEqualTo(1));
    api.emitSse('turn.start', {'turnId': 'turn_expr_1'}, id: '1');
    api.emitSse(
      'turn.expression',
      {
        'turnId': 'turn_expr_1',
        'motion': 'shake',
        'sticker': {'id': 'wave-hi', 'label': '挥手打招呼', 'url': ''},
      },
      id: '2',
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('[贴纸：挥手打招呼]'), findsOneWidget);
    expect(controller.liveMotionForCommittedTurn('turn_expr_1'), 'shake');

    api.emitSse(
      'message.created',
      {
        'message': {
          'id': 'ev_expr_1',
          'seq': 1,
          'sessionId': 'sess_1',
          'turnId': 'turn_expr_1',
          'role': 'assistant',
          'kind': 'chat',
          'content': '摇摇头给你看',
          'metadata': {
            'expressions': [
              {
                'motion': 'shake',
                'sticker': {'id': 'wave-hi', 'label': '挥手打招呼', 'url': ''},
              },
            ],
          },
          'createdAt': 1795046500000,
        },
      },
      id: '3',
    );
    await tester.pumpAndSettle();
    expect(find.text('[贴纸：挥手打招呼]'), findsOneWidget);
    expect(find.text('摇摇头给你看'), findsOneWidget);
    expect(controller.liveMotionForCommittedTurn('turn_expr_1'), isNull);

    // 切离窗口/后台期间新到的动作先保留不丢，切回前台时再补播并消耗
    controller.setAppForeground(false);
    await tester.pump();
    api.emitSse(
      'message.created',
      {
        'message': {
          'id': 'ev_expr_bg',
          'seq': 2,
          'sessionId': 'sess_1',
          'turnId': 'turn_expr_bg',
          'role': 'assistant',
          'kind': 'chat',
          'content': '等你回来再点头',
          'metadata': {
            'expressions': [
              {'motion': 'nod'},
            ],
          },
          'createdAt': 1795046505000,
        },
      },
      id: '4',
    );
    await tester.pump();
    await tester.pump();
    expect(controller.liveMotionForCommittedTurn('turn_expr_bg'), 'nod');

    controller.setAppForeground(true);
    await tester.pumpAndSettle();
    expect(controller.liveMotionForCommittedTurn('turn_expr_bg'), isNull);
  });

  testWidgets('SSE turn.rollover wrapping 展示「正在收拢这段记忆…」，done 后自动收起并更新水位', (
    tester,
  ) async {
    final api = FakePsyberApiClient();
    final storage = MemorySessionStorage(
      const ConnectionProfile(
        baseUrl: 'http://127.0.0.1:3721',
        token: 'tok-rollover',
        deviceId: 'dev-rollover',
        instanceId: 'inst-test-001',
        deviceName: 'Mac',
      ),
    );
    final controller = AppController(api: api, storage: storage);
    addTearDown(() async {
      await api.closeStream();
      controller.dispose();
    });
    await controller.initialize();
    await controller.connectAndSync();

    await tester.pumpWidget(PsyberApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rollover_wrapping_banner')), findsNothing);
    expect(find.text('正在收拢这段记忆…'), findsNothing);

    api.emitSse('turn.rollover', {
      'phase': 'wrapping',
      'reason': 'threshold',
      'oldSessionId': 'sess_1',
    }, id: '10');
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('rollover_wrapping_banner')), findsOneWidget);
    expect(find.text('正在收拢这段记忆…'), findsOneWidget);

    api.emitSse('turn.rollover', {
      'phase': 'done',
      'reason': 'threshold',
      'oldSessionId': 'sess_1',
      'newSessionId': 'sess_2',
      'contextUsage': {'usedTokens': 0, 'limitTokens': 150000, 'ratio': 0.0},
    }, id: '11');
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rollover_wrapping_banner')), findsNothing);
    expect(controller.contextUsageNotifier.value?.usedTokens, 0);
  });
}

class _PaginatedFakeApiClient extends FakePsyberApiClient {
  final List<TimelineItem> latestItems = [
    const TimelineItem(
      id: 'ev_2',
      seq: 2,
      sessionId: 'sess_1',
      role: 'user',
      kind: 'chat',
      content: '第二条消息',
      createdAt: 1795046402000,
    ),
  ];

  @override
  Future<HistoryPage> getHistory(
    ConnectionProfile profile, {
    String? beforeId,
    int limit = 50,
  }) async {
    if (beforeId == 'ev_2') {
      return const HistoryPage(
        items: [
          TimelineItem(
            id: 'ev_1',
            seq: 1,
            sessionId: 'sess_1',
            role: 'user',
            kind: 'chat',
            content: '第一条旧消息',
            createdAt: 1795046401000,
          ),
        ],
        hasMore: false,
        latestEventSeq: 2,
      );
    }
    return HistoryPage(
      items: List<TimelineItem>.from(latestItems),
      hasMore: true,
      nextBefore: 'ev_2',
      latestEventSeq: latestItems.last.seq,
    );
  }
}
