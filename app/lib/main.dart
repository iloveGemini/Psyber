import 'package:flutter/material.dart';

import 'core/media/image_picker.dart';
import 'core/models/models.dart';
import 'core/network/api_client.dart';
import 'core/state/app_controller.dart';
import 'core/storage/session_storage.dart';
import 'features/chat/chat_page.dart';
import 'features/genesis/genesis_page.dart';
import 'features/pairing/pairing_page.dart';
import 'shared/theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AppController(
    api: HttpPsyberApiClient(),
    storage: FileSessionStorage(),
  );
  try {
    await controller.initialize();
  } catch (e, st) {
    debugPrint('AppController initialize failed: $e\n$st');
  }
  runApp(PsyberApp(controller: controller));
}

class PsyberApp extends StatelessWidget {
  const PsyberApp({
    super.key,
    required this.controller,
    this.imagePicker,
  });

  final AppController controller;
  final ImageFilePicker? imagePicker;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: controller.themeModeNotifier,
      builder: (context, themeMode, _) {
        return ValueListenableBuilder<PsyberPalette>(
          valueListenable: controller.lightPaletteNotifier,
          builder: (context, lightPalette, _) {
            return ValueListenableBuilder<PsyberPalette>(
              valueListenable: controller.darkPaletteNotifier,
              builder: (context, darkPalette, _) {
                return MaterialApp(
                  title: 'Psyber',
                  debugShowCheckedModeBanner: false,
                  theme: PsyberTheme.fromPalette(lightPalette),
                  darkTheme: PsyberTheme.fromPalette(darkPalette),
                  themeMode: themeMode,
                  home: ValueListenableBuilder<ConnectionProfile?>(
                    valueListenable: controller.profileNotifier,
                    builder: (context, profile, _) {
                      if (profile == null) {
                        return PairingPage(controller: controller);
                      }
                      return ValueListenableBuilder<GenesisStatus?>(
                        valueListenable: controller.genesisNotifier,
                        builder: (context, genesis, _) {
                          if (genesis != null && !genesis.initialized) {
                            return GenesisPage(controller: controller);
                          }
                          return ChatPage(
                            controller: controller,
                            imagePicker: imagePicker,
                          );
                        },
                      );
                    },
                  ),
                );
              },
            );
          },
        );
      },
    );
  }
}
