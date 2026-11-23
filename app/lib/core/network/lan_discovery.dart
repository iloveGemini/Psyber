import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 局域网自动发现的 Psyber 服务端元信息（仅含非敏感地址与实例标识，绝不含配对码）。
@immutable
class DiscoveredServer {
  const DiscoveredServer({
    required this.instanceId,
    required this.urls,
    required this.hostname,
    required this.version,
    this.residentName,
  });

  final String instanceId;
  final List<String> urls;
  final String hostname;
  final String version;
  final String? residentName;

  String get primaryUrl => urls.isNotEmpty ? urls.first : '';

  String get displayLabel {
    final name = residentName?.trim();
    if (name != null && name.isNotEmpty) {
      return '$name · $hostname';
    }
    return hostname.isNotEmpty ? hostname : primaryUrl;
  }
}

/// 解析后的扫码配对二维码载荷（对齐 Spec 04 §1.1）。
@immutable
class ParsedPairQr {
  const ParsedPairQr({
    required this.urls,
    required this.code,
  });

  final List<String> urls;
  final String code;
}

/// 本机桌面端免码配对凭证（仅从当前用户私有的 0600 local_pair.json 读取）。
@immutable
class LocalPairHint {
  const LocalPairHint({
    required this.secret,
    required this.baseUrl,
    required this.instanceId,
  });

  final String secret;
  final String baseUrl;
  final String instanceId;
}

/// 解析二维码扫描结果或粘贴文本，支持 Spec 04 JSON 与 psyber://pair URI 两种格式。
ParsedPairQr? parsePairQrPayload(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return null;

  if (text.startsWith('{')) {
    try {
      final decoded = jsonDecode(text);
      if (decoded is Map<String, dynamic>) {
        final code = (decoded['code'] as String?)?.trim() ?? '';
        final rawUrls = decoded['urls'];
        final urls = <String>[];
        if (rawUrls is List<dynamic>) {
          for (final item in rawUrls) {
            if (item is String && item.trim().isNotEmpty) {
              urls.add(item.trim());
            }
          }
        }
        if (code.isNotEmpty && urls.isNotEmpty) {
          return ParsedPairQr(urls: List<String>.unmodifiable(urls), code: code);
        }
      }
    } catch (_) {
      return null;
    }
  }

  try {
    final uri = Uri.parse(text);
    if (uri.scheme == 'psyber' && uri.host == 'pair') {
      final code = uri.queryParameters['code']?.trim() ?? '';
      final urls = uri.queryParametersAll['url']
              ?.map((u) => u.trim())
              .where((u) => u.isNotEmpty)
              .toList(growable: false) ??
          const <String>[];
      if (code.isNotEmpty && urls.isNotEmpty) {
        return ParsedPairQr(urls: urls, code: code);
      }
    }
  } catch (_) {
    // 忽略解析异常
  }

  return null;
}

/// 判断地址是否指向本机回环地址（localhost / 127.0.0.1 / ::1）。
bool isLoopbackUrl(String rawUrl) {
  try {
    final uri = Uri.parse(rawUrl.trim());
    final host = uri.host.toLowerCase();
    return host == 'localhost' || host == '127.0.0.1' || host == '::1';
  } catch (_) {
    return false;
  }
}

/// 判断地址是否为非本机回环的明文 HTTP（用于在配对页提示局域网明文风险）。
bool isNonLoopbackPlainHttp(String rawUrl) {
  try {
    final uri = Uri.parse(rawUrl.trim());
    if (uri.scheme != 'http') return false;
    return !isLoopbackUrl(rawUrl);
  } catch (_) {
    return false;
  }
}

Future<({LocalPairHint hint, int updatedAt})?> _parseLocalPairFile(File file) async {
  try {
    if (!await file.exists()) return null;
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map<String, dynamic>) return null;
    final secret = (decoded['secret'] as String?)?.trim() ?? '';
    final port = (decoded['port'] as num?)?.toInt() ?? 3721;
    final protocol = (decoded['protocol'] as String?)?.trim() == 'https' ? 'https' : 'http';
    final instanceId = (decoded['instanceId'] as String?)?.trim() ?? '';
    final updatedAt = (decoded['updatedAt'] as num?)?.toInt() ?? 0;
    if (secret.isEmpty || port <= 0) return null;
    return (
      hint: LocalPairHint(
        secret: secret,
        baseUrl: '$protocol://127.0.0.1:$port',
        instanceId: instanceId,
      ),
      updatedAt: updatedAt,
    );
  } catch (_) {
    return null;
  }
}

/// 仅在本机桌面端（macOS/Windows/Linux）尝试读取服务端写入的 0600 local_pair.json
/// （同时兼容自定义 PSYBER_DATA_DIR 与多实例切换时的 active_local_pair.json）。
Future<LocalPairHint?> readLocalDesktopPairHint({String? dataDirOverride}) async {
  if (kIsWeb) return null;
  if (!Platform.isMacOS && !Platform.isWindows && !Platform.isLinux) {
    return null;
  }
  try {
    final home = Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];
    final candidatePaths = <String>{};

    void addDataDir(String? raw) {
      if (raw == null || raw.trim().isEmpty) return;
      var dir = raw.trim();
      if (dir.startsWith('~/')) {
        if (home == null || home.trim().isEmpty) return;
        dir = '$home/${dir.substring(2)}';
      }
      candidatePaths.add('$dir/local_pair.json');
    }

    addDataDir(dataDirOverride);
    addDataDir(Platform.environment['PSYBER_DATA_DIR']);
    if (home != null && home.trim().isNotEmpty) {
      candidatePaths.add('$home/.psyber/active_local_pair.json');
      candidatePaths.add('$home/.psyber/default/local_pair.json');
      final psyberRoot = Directory('$home/.psyber');
      if (await psyberRoot.exists()) {
        await for (final entity in psyberRoot.list(followLinks: false)) {
          if (entity is Directory) {
            candidatePaths.add('${entity.path}/local_pair.json');
          }
        }
      }
    }

    ({LocalPairHint hint, int updatedAt})? best;
    for (final p in candidatePaths) {
      final parsed = await _parseLocalPairFile(File(p));
      if (parsed == null) continue;
      if (best == null || parsed.updatedAt >= best.updatedAt) {
        best = parsed;
      }
    }
    return best?.hint;
  } catch (_) {
    return null;
  }
}

/// 局域网自动发现接口（测试环境可注入假实现避免触碰真实 UDP 套接字）。
abstract class LanDiscoveryService {
  Future<List<DiscoveredServer>> discover({
    Duration timeout = const Duration(milliseconds: 1400),
  });
}

class UdpLanDiscoveryService implements LanDiscoveryService {
  const UdpLanDiscoveryService({this.discoveryPort = 37219});

  final int discoveryPort;

  @override
  Future<List<DiscoveredServer>> discover({
    Duration timeout = const Duration(milliseconds: 1400),
  }) async {
    if (kIsWeb) return const <DiscoveredServer>[];
    RawDatagramSocket? socket;
    try {
      socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      socket.broadcastEnabled = true;

      final nonce = 'p_${Random().nextInt(1 << 30).toRadixString(36)}';
      final probeBytes = utf8.encode(
        jsonEncode({'type': 'psyber.discover', 'v': 1, 'nonce': nonce}),
      );
      final found = <String, DiscoveredServer>{};
      final completer = Completer<void>();

      final sub = socket.listen((event) {
        if (event != RawSocketEvent.read) return;
        while (true) {
          final dg = socket?.receive();
          if (dg == null) break;
          try {
            final decoded = jsonDecode(utf8.decode(dg.data));
            if (decoded is! Map<String, dynamic>) continue;
            if (decoded['type'] != 'psyber.announce') continue;
            final replyNonce = decoded['nonce'] as String?;
            if (replyNonce != null && replyNonce != nonce) continue;
            final instanceId = (decoded['instanceId'] as String?)?.trim() ?? '';
            final protocol = (decoded['protocol'] as String?) == 'https' ? 'https' : 'http';
            final port = (decoded['port'] as num?)?.toInt() ?? 3721;
            final rawUrls = decoded['urls'];
            final urls = <String>[];
            if (rawUrls is List<dynamic>) {
              for (final u in rawUrls) {
                if (u is String && u.trim().isNotEmpty) {
                  urls.add(u.trim());
                }
              }
            }
            final senderUrl = '$protocol://${dg.address.address}:$port';
            if (!urls.contains(senderUrl) && !dg.address.isLoopback) {
              urls.insert(0, senderUrl);
            }
            if (urls.isEmpty) {
              urls.add(senderUrl);
            }
            final key = instanceId.isNotEmpty ? instanceId : urls.first;
            found[key] = DiscoveredServer(
              instanceId: instanceId,
              urls: List<String>.unmodifiable(urls),
              hostname: (decoded['hostname'] as String?)?.trim() ?? dg.address.address,
              version: (decoded['version'] as String?)?.trim() ?? '',
              residentName: (decoded['residentName'] as String?)?.trim(),
            );
          } catch (_) {
            // 忽略非法 UDP 报文
          }
        }
      });

      final targets = <InternetAddress>{InternetAddress('255.255.255.255')};
      try {
        final ifaces = await NetworkInterface.list(type: InternetAddressType.IPv4);
        for (final iface in ifaces) {
          for (final addr in iface.addresses) {
            if (addr.isLoopback) continue;
            final parts = addr.address.split('.');
            if (parts.length == 4) {
              targets.add(InternetAddress('${parts[0]}.${parts[1]}.${parts[2]}.255'));
            }
          }
        }
      } catch (_) {
        // 部分移动沙盒无法列举网卡时仅用 255.255.255.255
      }

      for (final target in targets) {
        try {
          socket.send(probeBytes, target, discoveryPort);
        } catch (_) {
          // 忽略单个广播接口发送失败
        }
      }

      Timer(timeout, () {
        if (!completer.isCompleted) completer.complete();
      });
      await completer.future;
      await sub.cancel();
      return found.values.toList(growable: false);
    } catch (_) {
      return const <DiscoveredServer>[];
    } finally {
      socket?.close();
    }
  }
}

/// 原生二维码摄像头扫码通道（iOS 通过 AVFoundation 实现，其余平台安全返回 null）。
class QrScannerChannel {
  static const MethodChannel _channel = MethodChannel('psyber/qr');

  static bool get isCameraSupported => !kIsWeb && Platform.isIOS;

  static Future<String?> scan() async {
    if (!isCameraSupported) return null;
    try {
      return await _channel.invokeMethod<String>('scanQrCode');
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
  }
}
