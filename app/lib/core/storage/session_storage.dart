import 'dart:convert';
import 'dart:io';

import '../models/models.dart';

/// 本地会话凭证存储抽象（Ring 1 原子写 + POSIX 0600 权限；Ring 1.5 升级为 flutter_secure_storage）。
abstract class SessionStorage {
  Future<ConnectionProfile?> load();
  Future<void> save(ConnectionProfile profile);
  Future<void> clear();
}

class MemorySessionStorage implements SessionStorage {
  ConnectionProfile? _profile;

  MemorySessionStorage([this._profile]);

  @override
  Future<ConnectionProfile?> load() async => _profile;

  @override
  Future<void> save(ConnectionProfile profile) async {
    _profile = profile;
  }

  @override
  Future<void> clear() async {
    _profile = null;
  }
}

class FileSessionStorage implements SessionStorage {
  FileSessionStorage({File? file}) : _file = file ?? _defaultFile();

  final File _file;

  /// 严禁退化写入全局可访问的 Directory.systemTemp，防止长期 Bearer Token 泄露。
  static File _defaultFile() {
    final home = Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];
    if (home == null || home.trim().isEmpty) {
      throw StateError('无法确定用户私有主目录，已拒绝将访问令牌写入全局临时目录');
    }
    return File('$home/.psyber/client_session.json');
  }

  @override
  Future<ConnectionProfile?> load() async {
    try {
      if (!await _file.exists()) return null;
      final raw = await _file.readAsString();
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final profile = ConnectionProfile.fromJson(decoded);
      if (profile.baseUrl.isEmpty || profile.token.isEmpty) return null;
      return profile;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> save(ConnectionProfile profile) async {
    await _file.parent.create(recursive: true);
    final tmp = File('${_file.path}.tmp.${DateTime.now().microsecondsSinceEpoch}');
    try {
      await tmp.writeAsString(jsonEncode(profile.toJson()), flush: true);
      if (!Platform.isWindows) {
        try {
          await Process.run('chmod', ['600', tmp.path]);
        } catch (_) {
          // macOS App Sandbox 或受限环境无权限 spawn 子进程，沙盒自身已隔离容器，安全降级
        }
      }
      await tmp.rename(_file.path);
      if (!Platform.isWindows) {
        try {
          await Process.run('chmod', ['600', _file.path]);
        } catch (_) {
          // 安全降级
        }
      }
    } finally {
      if (await tmp.exists()) {
        await tmp.delete();
      }
    }
  }

  @override
  Future<void> clear() async {
    try {
      if (await _file.exists()) {
        await _file.delete();
      }
    } catch (_) {
      // 忽略清理失败
    }
  }
}
