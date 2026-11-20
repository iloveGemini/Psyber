import 'dart:io';

import 'package:flutter/foundation.dart';

@immutable
class PickedImage {
  const PickedImage({
    required this.bytes,
    required this.filename,
    required this.mimeType,
  });

  final List<int> bytes;
  final String filename;
  final String mimeType;
}

typedef ImageFilePicker = Future<PickedImage?> Function();

String inferImageMimeType(String filename) {
  final lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

/// 零第三方依赖的本机图片选择器（macOS 优先调用原生选文件窗，离线测试可注入 Fake）。
Future<PickedImage?> defaultPlatformImagePicker() async {
  if (kIsWeb || !Platform.isMacOS) return null;
  final result = await Process.run('osascript', [
    '-e',
    'POSIX path of (choose file of type {"public.image"} with prompt "选择要发送的图片")',
  ]);
  if (result.exitCode != 0) return null;
  final filePath = (result.stdout as String).trim();
  if (filePath.isEmpty) return null;
  final file = File(filePath);
  if (!await file.exists()) return null;
  final bytes = await file.readAsBytes();
  final filename = file.uri.pathSegments.isNotEmpty
      ? file.uri.pathSegments.last
      : 'image.png';
  return PickedImage(
    bytes: bytes,
    filename: filename,
    mimeType: inferImageMimeType(filename),
  );
}
