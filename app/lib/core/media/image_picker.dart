import 'dart:io';

import 'package:flutter/foundation.dart';

@immutable
class PickedImage {
  const PickedImage({
    required this.bytes,
    required this.filename,
    required this.mimeType,
    this.localPath,
  });

  final List<int> bytes;
  final String filename;
  final String mimeType;
  final String? localPath;

  bool get isVideo =>
      mimeType.startsWith('video/') || isVideoFilename(filename);
}

typedef ImageFilePicker = Future<PickedImage?> Function();

String inferImageMimeType(String filename) {
  final lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

bool isVideoFilename(String filename) {
  final lower = filename.toLowerCase();
  return lower.endsWith('.mp4') ||
      lower.endsWith('.mov') ||
      lower.endsWith('.m4v') ||
      lower.endsWith('.webm');
}

bool isImageFilename(String filename) {
  final lower = filename.toLowerCase();
  return lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.heic') ||
      lower.endsWith('.bmp');
}

Future<PickedImage?> loadPickedFileFromPath(String filePath) async {
  final file = File(filePath);
  if (!await file.exists()) return null;
  final filename = file.uri.pathSegments.isNotEmpty
      ? file.uri.pathSegments.last
      : 'image.png';
  if (!isImageFilename(filename) && !isVideoFilename(filename)) {
    return null;
  }
  final bytes = await file.readAsBytes();
  return PickedImage(
    bytes: bytes,
    filename: filename,
    mimeType: inferImageMimeType(filename),
    localPath: filePath,
  );
}

/// 零第三方依赖的本机图片/短视频选择器（macOS 优先调用原生选文件窗，离线测试可注入 Fake）。
Future<PickedImage?> defaultPlatformImagePicker() async {
  if (kIsWeb || !Platform.isMacOS) return null;
  final result = await Process.run('osascript', [
    '-e',
    'POSIX path of (choose file of type {"public.image", "public.movie"} with prompt "选择图片或短视频")',
  ]);
  if (result.exitCode != 0) return null;
  final filePath = (result.stdout as String).trim();
  if (filePath.isEmpty) return null;
  return loadPickedFileFromPath(filePath);
}
