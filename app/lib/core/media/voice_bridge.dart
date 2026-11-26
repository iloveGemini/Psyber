import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

@immutable
class VoicePermissionStatus {
  const VoicePermissionStatus({
    required this.micGranted,
    required this.speechGranted,
  });

  final bool micGranted;
  final bool speechGranted;
}

@immutable
class VoiceRecordingUpdate {
  const VoiceRecordingUpdate({
    required this.transcript,
    required this.durationSec,
    this.level,
  });

  final String transcript;
  final double durationSec;
  final double? level;
}

@immutable
class VoiceRecordingResult {
  const VoiceRecordingResult({
    required this.bytes,
    required this.durationSec,
    required this.transcript,
    this.mimeType = 'audio/mp4',
  });

  final Uint8List bytes;
  final double durationSec;
  final String transcript;
  final String mimeType;
}

@immutable
class VoicePlaybackState {
  const VoicePlaybackState({
    required this.id,
    required this.playing,
    required this.positionSec,
    required this.durationSec,
  });

  final String id;
  final bool playing;
  final double positionSec;
  final double durationSec;
}

/// 跨端语音录制、实时识别与语音条回放抽象（默认走 Apple 原生通道，单测可注入内存实现）。
abstract class VoiceBridge {
  bool get isSupported;

  Stream<VoiceRecordingUpdate> get updates;

  ValueNotifier<VoicePlaybackState?> get playbackNotifier;

  Future<VoicePermissionStatus> checkPermission();

  Future<VoicePermissionStatus> requestPermission();

  Future<void> startRecording({String? locale});

  Future<void> switchLocale(String locale);

  Future<VoiceRecordingResult?> stopRecording();

  Future<void> cancelRecording();

  Future<void> playAudio({
    required String id,
    required String url,
    required String token,
  });

  Future<void> stopAudio();
}

/// 零第三方依赖的 Apple 原生语音桥接（iOS / macOS 复用同一套 `psyber/voice` 通道）。
class NativeVoiceBridge implements VoiceBridge {
  NativeVoiceBridge._() {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  static final NativeVoiceBridge instance = NativeVoiceBridge._();
  static const MethodChannel _channel = MethodChannel('psyber/voice');

  final StreamController<VoiceRecordingUpdate> _updatesController =
      StreamController<VoiceRecordingUpdate>.broadcast();

  @override
  final ValueNotifier<VoicePlaybackState?> playbackNotifier =
      ValueNotifier<VoicePlaybackState?>(null);

  @override
  bool get isSupported =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.iOS ||
          defaultTargetPlatform == TargetPlatform.macOS);

  @override
  Stream<VoiceRecordingUpdate> get updates => _updatesController.stream;

  Future<void> _handleNativeCall(MethodCall call) async {
    if (call.method == 'onVoiceUpdate') {
      final args = call.arguments;
      if (args is Map<dynamic, dynamic>) {
        final transcript = args['transcript'] as String? ?? '';
        final durationSec = (args['durationSec'] as num?)?.toDouble() ?? 0.0;
        final rawLevel = args['level'];
        final level = rawLevel is num ? rawLevel.toDouble().clamp(0.0, 1.0) : null;
        _updatesController.add(
          VoiceRecordingUpdate(
            transcript: transcript,
            durationSec: durationSec,
            level: level,
          ),
        );
      }
    } else if (call.method == 'onPlaybackState') {
      final args = call.arguments;
      if (args is Map<dynamic, dynamic>) {
        final id = args['id'] as String? ?? '';
        final playing = args['playing'] == true;
        final positionSec = (args['positionSec'] as num?)?.toDouble() ?? 0.0;
        final durationSec = (args['durationSec'] as num?)?.toDouble() ?? 0.0;
        if (!playing && playbackNotifier.value?.id == id) {
          playbackNotifier.value = null;
        } else if (playing) {
          playbackNotifier.value = VoicePlaybackState(
            id: id,
            playing: true,
            positionSec: positionSec,
            durationSec: durationSec,
          );
        }
      }
    }
  }

  @override
  Future<VoicePermissionStatus> checkPermission() async {
    if (!isSupported) {
      return const VoicePermissionStatus(micGranted: false, speechGranted: false);
    }
    try {
      final res = await _channel.invokeMethod<dynamic>('checkPermission');
      if (res is Map<dynamic, dynamic>) {
        return VoicePermissionStatus(
          micGranted: res['mic'] == true,
          speechGranted: res['speech'] == true,
        );
      }
    } on MissingPluginException {
      // 测试环境或非支持平台
    }
    return const VoicePermissionStatus(micGranted: false, speechGranted: false);
  }

  @override
  Future<VoicePermissionStatus> requestPermission() async {
    if (!isSupported) {
      return const VoicePermissionStatus(micGranted: false, speechGranted: false);
    }
    try {
      final res = await _channel.invokeMethod<dynamic>('requestPermission');
      if (res is Map<dynamic, dynamic>) {
        return VoicePermissionStatus(
          micGranted: res['mic'] == true,
          speechGranted: res['speech'] == true,
        );
      }
    } on MissingPluginException {
      // 测试环境或非支持平台
    }
    return const VoicePermissionStatus(micGranted: false, speechGranted: false);
  }

  @override
  Future<void> startRecording({String? locale}) async {
    if (!isSupported) {
      throw PlatformException(
        code: 'UNSUPPORTED_PLATFORM',
        message: '当前平台暂不支持原生语音录制',
      );
    }
    await _channel.invokeMethod<dynamic>('startRecording', {
      if (locale != null && locale.isNotEmpty) 'locale': locale,
    });
  }

  @override
  Future<void> switchLocale(String locale) async {
    if (!isSupported || locale.isEmpty) return;
    try {
      await _channel.invokeMethod<dynamic>('switchLocale', {'locale': locale});
    } on MissingPluginException {
      // 忽略
    }
  }

  @override
  Future<VoiceRecordingResult?> stopRecording() async {
    if (!isSupported) return null;
    final res = await _channel.invokeMethod<dynamic>('stopRecording');
    if (res is! Map<dynamic, dynamic>) return null;
    final rawBytes = res['bytes'];
    final bytes = rawBytes is Uint8List ? rawBytes : Uint8List(0);
    final durationSec = (res['durationSec'] as num?)?.toDouble() ?? 0.0;
    final transcript = (res['transcript'] as String? ?? '').trim();
    final mimeType = (res['mimeType'] as String? ?? 'audio/mp4').trim();
    return VoiceRecordingResult(
      bytes: bytes,
      durationSec: durationSec,
      transcript: transcript,
      mimeType: mimeType.isEmpty ? 'audio/mp4' : mimeType,
    );
  }

  @override
  Future<void> cancelRecording() async {
    if (!isSupported) return;
    try {
      await _channel.invokeMethod<dynamic>('cancelRecording');
    } on MissingPluginException {
      // 忽略
    }
  }

  @override
  Future<void> playAudio({
    required String id,
    required String url,
    required String token,
  }) async {
    if (!isSupported) return;
    await _channel.invokeMethod<dynamic>('playAudio', {
      'id': id,
      'url': url,
      'token': token,
    });
  }

  @override
  Future<void> stopAudio() async {
    if (!isSupported) return;
    playbackNotifier.value = null;
    try {
      await _channel.invokeMethod<dynamic>('stopAudio');
    } on MissingPluginException {
      // 忽略
    }
  }
}
