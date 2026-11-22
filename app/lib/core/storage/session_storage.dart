import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

import '../../shared/theme.dart';
import '../models/models.dart';

/// 本地外观偏好（分别记忆日间与夜间首选阅读色板，跟随系统时自动按昼夜切换）。
class ThemePreferences {
  const ThemePreferences({
    this.themeMode = ThemeMode.system,
    this.lightPalette = PsyberPalette.warmPaper,
    this.darkPalette = PsyberPalette.obsidianNight,
  });

  final ThemeMode themeMode;
  final PsyberPalette lightPalette;
  final PsyberPalette darkPalette;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'themeMode': themeMode.name,
        'lightPalette': lightPalette.name,
        'darkPalette': darkPalette.name,
      };

  static ThemePreferences fromJson(Map<String, dynamic> json) {
    final modeRaw = json['themeMode'] as String?;
    final mode = ThemeMode.values.firstWhere(
      (m) => m.name == modeRaw,
      orElse: () => ThemeMode.system,
    );
    final lightRaw = json['lightPalette'] as String?;
    final light = PsyberPalette.values.firstWhere(
      (p) => !p.isDark && p.name == lightRaw,
      orElse: () => PsyberPalette.warmPaper,
    );
    final darkRaw = json['darkPalette'] as String?;
    final dark = PsyberPalette.values.firstWhere(
      (p) => p.isDark && p.name == darkRaw,
      orElse: () => PsyberPalette.obsidianNight,
    );
    return ThemePreferences(
      themeMode: mode,
      lightPalette: light,
      darkPalette: dark,
    );
  }
}

/// 本地会话凭证与输入草稿存储抽象（Ring 1 原子写 + POSIX 0600 权限）。
abstract class SessionStorage {
  Future<ConnectionProfile?> load();
  Future<void> save(ConnectionProfile profile);
  Future<void> clear();
  Future<String> loadDraft();
  Future<void> saveDraft(String draft);
  Future<ThemePreferences> loadThemePreferences() async => const ThemePreferences();
  Future<void> saveThemePreferences(ThemePreferences prefs) async {}
}

class MemorySessionStorage implements SessionStorage {
  ConnectionProfile? _profile;
  String _draft = '';
  ThemePreferences _themePrefs = const ThemePreferences();

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
    _draft = '';
  }

  @override
  Future<String> loadDraft() async => _draft;

  @override
  Future<void> saveDraft(String draft) async {
    _draft = draft;
  }

  @override
  Future<ThemePreferences> loadThemePreferences() async => _themePrefs;

  @override
  Future<void> saveThemePreferences(ThemePreferences prefs) async {
    _themePrefs = prefs;
  }
}

class FileSessionStorage implements SessionStorage {
  FileSessionStorage({File? file}) : _file = file ?? _defaultFile();

  final File _file;
  Future<void> _themeSaveQueue = Future<void>.value();
  int _tmpSeq = 0;

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
      final draftFile = _draftFile();
      if (await draftFile.exists()) {
        await draftFile.delete();
      }
    } catch (_) {
      // 忽略清理失败
    }
  }

  File _draftFile() => File('${_file.parent.path}/client_draft.txt');

  @override
  Future<String> loadDraft() async {
    try {
      final f = _draftFile();
      if (!await f.exists()) return '';
      return await f.readAsString();
    } catch (_) {
      return '';
    }
  }

  @override
  Future<void> saveDraft(String draft) async {
    try {
      final f = _draftFile();
      if (draft.isEmpty) {
        if (await f.exists()) await f.delete();
        return;
      }
      await f.parent.create(recursive: true);
      final tmp = File('${f.path}.tmp.${DateTime.now().microsecondsSinceEpoch}');
      try {
        await tmp.writeAsString(draft, flush: true);
        await tmp.rename(f.path);
      } finally {
        if (await tmp.exists()) {
          await tmp.delete();
        }
      }
    } catch (_) {
      // 草稿存储失败静默忽略，不干扰主对话
    }
  }

  File _themeFile() => File('${_file.parent.path}/client_theme.json');

  @override
  Future<ThemePreferences> loadThemePreferences() async {
    try {
      final f = _themeFile();
      if (!await f.exists()) return const ThemePreferences();
      final decoded = jsonDecode(await f.readAsString());
      if (decoded is! Map<String, dynamic>) return const ThemePreferences();
      return ThemePreferences.fromJson(decoded);
    } catch (_) {
      return const ThemePreferences();
    }
  }

  @override
  Future<void> saveThemePreferences(ThemePreferences prefs) {
    _themeSaveQueue = _themeSaveQueue.then((_) => _writeThemePreferences(prefs));
    return _themeSaveQueue;
  }

  Future<void> _writeThemePreferences(ThemePreferences prefs) async {
    try {
      final f = _themeFile();
      await f.parent.create(recursive: true);
      _tmpSeq += 1;
      final tmp = File('${f.path}.tmp.${DateTime.now().microsecondsSinceEpoch}.$_tmpSeq');
      try {
        await tmp.writeAsString(jsonEncode(prefs.toJson()), flush: true);
        await tmp.rename(f.path);
      } finally {
        if (await tmp.exists()) {
          await tmp.delete();
        }
      }
    } catch (_) {
      // 主题偏好写入失败静默忽略，不阻塞切换体验
    }
  }
}
