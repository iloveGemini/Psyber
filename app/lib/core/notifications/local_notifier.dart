import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

typedef LocalNotificationSender = Future<void> Function({
  required String title,
  required String body,
  String? id,
});

/// macOS 桌面端本地系统通知桥接（基于原生 UNUserNotificationCenter，零外部插件依赖）。
class LocalNotificationService {
  static const MethodChannel _channel = MethodChannel('psyber/local_notifications');

  static bool get isSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  static Future<void> requestPermission() async {
    if (!isSupported) return;
    try {
      await _channel.invokeMethod<bool>('requestPermission');
    } catch (_) {
      // 测试环境或未授权时静默降级
    }
  }

  static Future<void> show({
    required String title,
    required String body,
    String? id,
  }) async {
    if (!isSupported) return;
    try {
      await _channel.invokeMethod<void>('showNotification', {
        'id': id,
        'title': title,
        'body': body,
      });
    } catch (_) {
      // 通知桥接异常不影响主聊天流
    }
  }
}
