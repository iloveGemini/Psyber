import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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

String _generateStableClientId() {
  final rng = Random.secure();
  final buf = StringBuffer('cid_');
  for (var i = 0; i < 16; i++) {
    buf.write(rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return buf.toString();
}

/// 本地会话凭证与输入草稿存储抽象（支持按 instanceId 保存多实例凭证、稳定 clientId 与 POSIX 0600 权限）。
abstract class SessionStorage {
  Future<ConnectionProfile?> load();
  Future<ConnectionProfile?> loadForInstance(String instanceId) async {
    final active = await load();
    if (active != null && active.instanceId == instanceId) return active;
    return null;
  }

  Future<void> save(ConnectionProfile profile);
  Future<void> removeInstance(String instanceId) async => clear();
  Future<void> clear();
  Future<String> loadOrCreateClientId();
  Future<String> loadDraft();
  Future<void> saveDraft(String draft);
  Future<ThemePreferences> loadThemePreferences() async => const ThemePreferences();
  Future<void> saveThemePreferences(ThemePreferences prefs) async {}
}

class MemorySessionStorage implements SessionStorage {
  String? _activeInstanceId;
  final Map<String, ConnectionProfile> _profiles = <String, ConnectionProfile>{};
  final String _clientId;
  String _draft = '';
  ThemePreferences _themePrefs = const ThemePreferences();

  MemorySessionStorage([ConnectionProfile? initial, String? clientId])
      : _clientId = clientId ?? _generateStableClientId() {
    if (initial != null) {
      final key = _profileKey(initial);
      _profiles[key] = initial;
      _activeInstanceId = key;
    }
  }

  static String _profileKey(ConnectionProfile p) =>
      p.instanceId.isNotEmpty ? p.instanceId : p.baseUrl;

  @override
  Future<ConnectionProfile?> load() async {
    final active = _activeInstanceId;
    if (active == null) return null;
    return _profiles[active];
  }

  @override
  Future<ConnectionProfile?> loadForInstance(String instanceId) async =>
      _profiles[instanceId];

  @override
  Future<void> save(ConnectionProfile profile) async {
    final key = _profileKey(profile);
    _profiles[key] = profile;
    _activeInstanceId = key;
  }

  @override
  Future<void> removeInstance(String instanceId) async {
    _profiles.remove(instanceId);
    if (_activeInstanceId == instanceId) {
      _activeInstanceId = null;
    }
  }

  @override
  Future<void> clear() async {
    final active = _activeInstanceId;
    if (active != null) {
      _profiles.remove(active);
    }
    _activeInstanceId = null;
    _draft = '';
  }

  @override
  Future<String> loadOrCreateClientId() async => _clientId;

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

class _SessionStoreData {
  _SessionStoreData({
    required this.activeInstanceId,
    required this.profiles,
  });

  String? activeInstanceId;
  final Map<String, ConnectionProfile> profiles;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'v': 2,
        'activeInstanceId': activeInstanceId,
        'profiles': profiles.map((k, v) => MapEntry(k, v.toJson())),
      };

  static _SessionStoreData fromJson(Map<String, dynamic> json) {
    final rawProfiles = json['profiles'];
    if (json['v'] == 2 && rawProfiles is Map<String, dynamic>) {
      final map = <String, ConnectionProfile>{};
      for (final entry in rawProfiles.entries) {
        if (entry.value is Map<String, dynamic>) {
          final p = ConnectionProfile.fromJson(entry.value as Map<String, dynamic>);
          if (p.baseUrl.isNotEmpty && p.token.isNotEmpty) {
            map[entry.key] = p;
          }
        }
      }
      final active = json['activeInstanceId'] as String?;
      return _SessionStoreData(
        activeInstanceId: active != null && map.containsKey(active) ? active : null,
        profiles: map,
      );
    }
    // 兼容旧版单对象 client_session.json
    final legacy = ConnectionProfile.fromJson(json);
    if (legacy.baseUrl.isEmpty || legacy.token.isEmpty) {
      return _SessionStoreData(
        activeInstanceId: null,
        profiles: <String, ConnectionProfile>{},
      );
    }
    final key = legacy.instanceId.isNotEmpty ? legacy.instanceId : legacy.baseUrl;
    return _SessionStoreData(
      activeInstanceId: key,
      profiles: <String, ConnectionProfile>{key: legacy},
    );
  }
}

class FileSessionStorage implements SessionStorage {
  FileSessionStorage({File? file}) : _explicitFile = file;

  static const MethodChannel _storageChannel = MethodChannel('psyber/storage');

  final File? _explicitFile;
  File? _resolvedFile;
  String? _cachedClientId;
  Future<void> _themeSaveQueue = Future<void>.value();
  int _tmpSeq = 0;

  /// 严禁退化写入全局可访问的 Directory.systemTemp，防止长期 Bearer Token 泄露。
  Future<File> _getFile() async {
    final explicit = _explicitFile;
    if (explicit != null) return explicit;
    final cached = _resolvedFile;
    if (cached != null) return cached;

    if (Platform.isIOS) {
      // iOS GUI 进程默认不注入 HOME 环境变量，需向原生沙盒索取 Application Support 目录。
      final appSupport =
          await _storageChannel.invokeMethod<String>('getAppSupportDir');
      if (appSupport != null && appSupport.trim().isNotEmpty) {
        final file = File('$appSupport/psyber/client_session.json');
        _resolvedFile = file;
        return file;
      }
    }

    final home =
        Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];
    if (home == null || home.trim().isEmpty) {
      throw StateError('无法确定用户私有主目录，已拒绝将访问令牌写入全局临时目录');
    }
    final file = File('$home/.psyber/client_session.json');
    _resolvedFile = file;
    return file;
  }

  Future<_SessionStoreData> _readStore() async {
    try {
      final file = await _getFile();
      if (!await file.exists()) {
        return _SessionStoreData(
          activeInstanceId: null,
          profiles: <String, ConnectionProfile>{},
        );
      }
      final raw = await file.readAsString();
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) {
        return _SessionStoreData(
          activeInstanceId: null,
          profiles: <String, ConnectionProfile>{},
        );
      }
      return _SessionStoreData.fromJson(decoded);
    } catch (_) {
      return _SessionStoreData(
        activeInstanceId: null,
        profiles: <String, ConnectionProfile>{},
      );
    }
  }

  Future<void> _writePrivateFile(File file, String content) async {
    await file.parent.create(recursive: true);
    _tmpSeq += 1;
    final tmp = File('${file.path}.tmp.${DateTime.now().microsecondsSinceEpoch}.$_tmpSeq');
    try {
      await tmp.writeAsString(content, flush: true);
      if (!Platform.isWindows && !Platform.isIOS) {
        try {
          await Process.run('chmod', ['600', tmp.path]);
        } catch (_) {
          // macOS App Sandbox 或受限环境无权限 spawn 子进程，沙盒自身已隔离容器，安全降级
        }
      }
      await tmp.rename(file.path);
      if (!Platform.isWindows && !Platform.isIOS) {
        try {
          await Process.run('chmod', ['600', file.path]);
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
  Future<ConnectionProfile?> load() async {
    final store = await _readStore();
    final active = store.activeInstanceId;
    if (active == null) return null;
    return store.profiles[active];
  }

  @override
  Future<ConnectionProfile?> loadForInstance(String instanceId) async {
    if (instanceId.isEmpty) return null;
    final store = await _readStore();
    return store.profiles[instanceId];
  }

  @override
  Future<void> save(ConnectionProfile profile) async {
    final file = await _getFile();
    final store = await _readStore();
    final key = profile.instanceId.isNotEmpty ? profile.instanceId : profile.baseUrl;
    store.profiles[key] = profile;
    store.activeInstanceId = key;
    await _writePrivateFile(file, jsonEncode(store.toJson()));
  }

  @override
  Future<void> removeInstance(String instanceId) async {
    try {
      final file = await _getFile();
      final store = await _readStore();
      store.profiles.remove(instanceId);
      if (store.activeInstanceId == instanceId) {
        store.activeInstanceId = null;
      }
      if (store.profiles.isEmpty) {
        if (await file.exists()) await file.delete();
      } else {
        await _writePrivateFile(file, jsonEncode(store.toJson()));
      }
    } catch (_) {
      // 忽略清理失败
    }
  }

  @override
  Future<void> clear() async {
    try {
      final file = await _getFile();
      final store = await _readStore();
      if (store.activeInstanceId != null) {
        store.profiles.remove(store.activeInstanceId);
        store.activeInstanceId = null;
      }
      if (store.profiles.isEmpty) {
        if (await file.exists()) {
          await file.delete();
        }
      } else {
        await _writePrivateFile(file, jsonEncode(store.toJson()));
      }
      final draftFile = _draftFile(file);
      if (await draftFile.exists()) {
        await draftFile.delete();
      }
    } catch (_) {
      // 忽略清理失败
    }
  }

  File _clientIdFile(File sessionFile) =>
      File('${sessionFile.parent.path}/client_id.txt');

  @override
  Future<String> loadOrCreateClientId() async {
    if (_cachedClientId != null && _cachedClientId!.isNotEmpty) {
      return _cachedClientId!;
    }
    try {
      final f = _clientIdFile(await _getFile());
      if (await f.exists()) {
        final existing = (await f.readAsString()).trim();
        if (existing.length >= 8 && existing.length <= 64) {
          _cachedClientId = existing;
          return existing;
        }
      }
      final created = _generateStableClientId();
      await _writePrivateFile(f, '$created\n');
      _cachedClientId = created;
      return created;
    } catch (_) {
      final fallback = _generateStableClientId();
      _cachedClientId = fallback;
      return fallback;
    }
  }

  File _draftFile(File sessionFile) =>
      File('${sessionFile.parent.path}/client_draft.txt');

  @override
  Future<String> loadDraft() async {
    try {
      final f = _draftFile(await _getFile());
      if (!await f.exists()) return '';
      return await f.readAsString();
    } catch (_) {
      return '';
    }
  }

  @override
  Future<void> saveDraft(String draft) async {
    try {
      final f = _draftFile(await _getFile());
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

  File _themeFile(File sessionFile) =>
      File('${sessionFile.parent.path}/client_theme.json');

  @override
  Future<ThemePreferences> loadThemePreferences() async {
    try {
      final f = _themeFile(await _getFile());
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
      final f = _themeFile(await _getFile());
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
