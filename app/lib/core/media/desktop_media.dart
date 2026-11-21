import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'image_picker.dart';

@immutable
class ExtractedVideoClip {
  const ExtractedVideoClip({
    required this.filename,
    required this.durationSec,
    required this.frames,
  });

  final String filename;
  final double durationSec;
  final List<List<int>> frames;
}

@immutable
class DesktopClipboardResult {
  const DesktopClipboardResult({
    this.image,
    this.filePaths = const <String>[],
  });

  final PickedImage? image;
  final List<String> filePaths;
}

/// 零第三方依赖的桌面端媒体桥接（macOS 剪贴板粘贴图片、拖拽文件、短视频本地抽帧）。
class DesktopMediaBridge {
  static const MethodChannel _channel = MethodChannel('psyber/desktop_media');

  static bool get isSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  static void listenDropEvents({
    required void Function(bool active) onDragStateChanged,
    required void Function(List<String> paths) onFilesDropped,
  }) {
    if (!isSupported) return;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'onDragStateChanged') {
        onDragStateChanged(call.arguments == true);
      } else if (call.method == 'onFilesDropped') {
        final raw = call.arguments;
        if (raw is List<dynamic>) {
          final paths = raw.whereType<String>().where((p) => p.isNotEmpty).toList();
          if (paths.isNotEmpty) {
            onFilesDropped(paths);
          }
        }
      }
    });
  }

  static void clearDropEvents() {
    if (!isSupported) return;
    _channel.setMethodCallHandler(null);
  }

  static Future<DesktopClipboardResult?> readClipboardMedia() async {
    if (!isSupported) return null;
    try {
      final res = await _channel.invokeMethod<dynamic>('readClipboardMedia');
      if (res is! Map<dynamic, dynamic>) return null;
      final rawPaths = res['filePaths'];
      if (rawPaths is List<dynamic>) {
        final paths = rawPaths.whereType<String>().where((p) => p.isNotEmpty).toList();
        if (paths.isNotEmpty) {
          return DesktopClipboardResult(filePaths: paths);
        }
      }
      final rawBytes = res['bytes'];
      if (rawBytes is Uint8List && rawBytes.isNotEmpty) {
        return DesktopClipboardResult(
          image: PickedImage(
            bytes: rawBytes,
            filename: res['filename'] as String? ?? 'clipboard.png',
            mimeType: res['mimeType'] as String? ?? 'image/png',
          ),
        );
      }
      return null;
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  static Future<ExtractedVideoClip?> extractVideoFrames(
    String path, {
    int maxFrames = 4,
  }) async {
    if (!isSupported) return null;
    try {
      final res = await _channel.invokeMethod<dynamic>('extractVideoFrames', {
        'path': path,
        'maxFrames': maxFrames,
      });
      if (res is! Map<dynamic, dynamic>) return null;
      final duration = (res['durationSec'] as num?)?.toDouble() ?? 0.0;
      final rawFrames = res['frames'];
      if (rawFrames is! List<dynamic>) return null;
      final frames = <List<int>>[];
      for (final f in rawFrames) {
        if (f is Uint8List && f.isNotEmpty) {
          frames.add(f);
        }
      }
      if (frames.isEmpty) return null;
      final file = File(path);
      final name = file.uri.pathSegments.isNotEmpty
          ? file.uri.pathSegments.last
          : 'video.mp4';
      return ExtractedVideoClip(
        filename: name,
        durationSec: duration,
        frames: frames,
      );
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }
}
