import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:psyber_app/core/media/image_picker.dart';
import 'package:psyber_app/core/models/models.dart';
import 'package:psyber_app/core/network/api_client.dart';
import 'package:psyber_app/core/state/app_controller.dart';
import 'package:psyber_app/core/storage/session_storage.dart';
import 'package:psyber_app/main.dart';

class FakePsyberApiClient implements PsyberApiClient {
  GenesisStatus genesis = GenesisStatus.completedDefault;
  DoorStatus door = DoorStatus.initial;
  List<TimelineItem> history = <TimelineItem>[];
  List<StickerView> stickers = <StickerView>[];
  final List<Map<String, Object?>> sentPayloads = <Map<String, Object?>>[];
  int mediaUploadCount = 0;
  final Map<String, List<RecallTraceItem>> recallByTurn =
      <String, List<RecallTraceItem>>{};
  final List<Map<String, Object?>> feedbackSubmitted = <Map<String, Object?>>[];
  final List<String> abortedTurnIds = <String>[];
  int recallFetchCount = 0;
  int streamOpenCount = 0;
  int historyFetchCount = 0;

  StreamController<SseEventFrame>? _streamController;

  void emitSse(String event, Map<String, dynamic> data) {
    _streamController?.add(SseEventFrame(event: event, data: data));
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
  Future<void> updateLlmSettings(
    ConnectionProfile profile, {
    required String providerKind,
    required String modelName,
    String? baseUrl,
    String? apiKey,
  }) async {}

  int revokeCount = 0;
  String? lastRevokedDeviceId;

  @override
  Future<void> revokeDevice(ConnectionProfile profile, String deviceId) async {
    revokeCount += 1;
    lastRevokedDeviceId = deviceId;
  }

  @override
  Future<DoorStatus> getDoor(ConnectionProfile profile) async => door;

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
  Future<SendMessageResult> sendMessage(
    ConnectionProfile profile, {
    required String clientMessageId,
    required String content,
    List<String>? attachments,
    String? stickerId,
  }) async {
    sentPayloads.add({
      'content': content,
      'attachments': attachments,
      'stickerId': stickerId,
    });
    final isClosed = door.state.isDoorNoteMode;
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
      turnId: isClosed ? null : 'turn_$nextSeq',
      clientMessageId: clientMessageId,
      role: 'user',
      kind: isClosed ? 'door_note' : 'chat',
      content: content,
      attachments: attachments ?? const <String>[],
      sticker: matchedSticker,
      createdAt: 1795046400000 + nextSeq * 1000,
    );
    history.add(msg);
    return SendMessageResult(
      message: msg,
      deliveredAs: isClosed ? 'door_note' : 'chat',
      turnId: msg.turnId,
    );
  }

  @override
  Future<void> deleteMessage(ConnectionProfile profile, String messageId) async {
    history.removeWhere((e) => e.id == messageId);
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
  Stream<SseEventFrame> openEventStream(
    ConnectionProfile profile, {
    required bool foreground,
  }) {
    streamOpenCount += 1;
    _streamController = StreamController<SseEventFrame>.broadcast(sync: true);
    return _streamController!.stream;
  }
}

void main() {
  test('parseSseLines 正确解析 event/data 帧并忽略注释行', () async {
    final lines = Stream<String>.fromIterable([
      ': heartbeat comment',
      'event: ping',
      'data: {"ts": 1234}',
      '',
      'event: turn.text',
      'data: {"turnId": "t1", "delta": "你好"}',
      '',
    ]);
    final frames = await parseSseLines(lines).toList();
    expect(frames.length, 2);
    expect(frames[0].event, 'ping');
    expect(frames[0].data['ts'], 1234);
    expect(frames[1].event, 'turn.text');
    expect(frames[1].data['delta'], '你好');
  });

  testWidgets('单地址配对连接 -> 进入聊天流 -> 门缝纸条输入切换', (tester) async {
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
    expect(find.text('发送'), findsOneWidget);

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
    expect(find.text('塞纸条'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('chat_input_field')), '晚点再聊，放门口啦');
    await tester.tap(find.byKey(const Key('chat_send_button')));
    await tester.pumpAndSettle();

    expect(find.text('门缝纸条'), findsOneWidget);
    expect(find.text('晚点再聊，放门口啦'), findsOneWidget);
  });

  testWidgets('流式 thinking 默认折叠、ExpressionRenderer 渲染与中止生成', (tester) async {
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

    api.emitSse('turn.start', {'turnId': 'turn_live', 'mode': 'chat'});
    api.emitSse('turn.thinking', {'turnId': 'turn_live', 'delta': '先确认对方刚刚提到的事情'});
    api.emitSse('turn.expression', {
      'turnId': 'turn_live',
      'atmosphere': {'tone': 'warm', 'intensity': 'noticeable', 'durationSec': 15},
      'motion': 'nod',
    });
    api.emitSse('turn.text', {'turnId': 'turn_live', 'delta': '我在听呢。'});
    await tester.pump();

    expect(find.text('我在听呢。'), findsOneWidget);
    expect(find.text('思考中…'), findsOneWidget);
    expect(find.text('先确认对方刚刚提到的事情'), findsNothing);

    await tester.tap(find.byKey(const Key('thinking_toggle')));
    await tester.pump();
    expect(find.text('先确认对方刚刚提到的事情'), findsOneWidget);

    await tester.tap(find.byKey(const Key('abort_turn_button')));
    await tester.pump();
    expect(api.abortedTurnIds, ['turn_live']);
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

  testWidgets('发图上传预览并发送纯图消息，以及打开贴纸面板发送贴纸', (tester) async {
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
    expect(api.sentPayloads.length, 2);
    expect(api.sentPayloads[1]['stickerId'], 'hug');
    expect(find.text('[贴纸：抱抱]'), findsOneWidget);
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

    // 调用 disconnect，通知后端吊销并清空本地存储
    await controller.disconnect();
    expect(api.revokeCount, 1);
    expect(api.lastRevokedDeviceId, 'dev_sandbox_01');
    expect(await sessionFile.exists(), isFalse);
    expect(controller.profileNotifier.value, isNull);
    expect(controller.connectionNotifier.value, ConnectionPhase.unpaired);
  });
}
