import 'package:flutter/material.dart';

/// 纸感手账配色与主题（温和低饱和、零花哨装饰）。
class PsyberTheme {
  static const Color paperCanvas = Color(0xFFFAF7F2);
  static const Color paperCard = Color(0xFFFFFDF9);
  static const Color doorNotePaper = Color(0xFFF5EFE2);
  static const Color inkPrimary = Color(0xFF2D2A26);
  static const Color inkMuted = Color(0xFF7A7369);
  static const Color hairline = Color(0xFFE6DEC8);
  static const Color accentWarm = Color(0xFF8C6B4F);
  static const Color userBubble = Color(0xFFEEE6D8);

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(
      seedColor: accentWarm,
      surface: paperCanvas,
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: paperCanvas,
      appBarTheme: const AppBarTheme(
        backgroundColor: paperCanvas,
        foregroundColor: inkPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      textTheme: const TextTheme(
        bodyMedium: TextStyle(color: inkPrimary, fontSize: 15, height: 1.5),
        bodySmall: TextStyle(color: inkMuted, fontSize: 13, height: 1.4),
      ),
      dividerColor: hairline,
    );
  }
}
