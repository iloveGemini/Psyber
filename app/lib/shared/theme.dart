import 'package:flutter/material.dart';

/// Ring 1.5 五套克制阅读/手账色板
enum PsyberPalette {
  warmPaper('暖纸白', false, Color(0xFFF9F9F7), Color(0xFF3C3C38)),
  obsidianNight('曜夜暖黑', true, Color(0xFF1F1F1D), Color(0xFFDEDED7)),
  oldBookPaper('旧书暖纸', false, Color(0xFFEAE4DA), Color(0xFFA2644C)),
  shoreLight('岸线·晨', false, Color(0xFFE2DDD6), Color(0xFF3B4B54)),
  shoreDark('岸线·夜', true, Color(0xFF222B33), Color(0xFF8C9BA5));

  const PsyberPalette(this.label, this.isDark, this.swatchBg, this.swatchAccent);

  final String label;
  final bool isDark;
  final Color swatchBg;
  final Color swatchAccent;
}

/// Psyber「静室信笺」配色系统（支持 5 套克制阅读/手账色板 + 跟随系统）：
/// - 日间态（Warm Paper）：暖纸白画布 (#F9F9F7)、纯白卡片 (#FFFFFF)、暖黑墨色 (#30302D)；
/// - 夜间态（Warm Dark）：曜夜暖黑 (#1F1F1D)、暗调升面 (#292927)、纸白浅字 (#F1F1ED)；
/// - 阅读系（旧书暖纸 / 岸线·晨 / 岸线·夜）自带无字纯纸纤维与颗粒微纹理；
/// - 琥珀色仅留给门状态阈值与未读门缝纸条，克制零噪音。
class PsyberColors extends ThemeExtension<PsyberColors> {
  const PsyberColors({
    required this.mineralCanvas,
    required this.letterSurface,
    required this.celadonWash,
    required this.slipPaper,
    required this.codeSurface,
    required this.inkDeep,
    required this.inkQuiet,
    required this.inkFaint,
    required this.hairline,
    required this.hairlineWarm,
    required this.accent,
    required this.onAccent,
    required this.accentSoft,
    required this.accentBorder,
    required this.statusSuccess,
    required this.statusSuccessSoft,
    required this.thresholdAmber,
    required this.thresholdAmberSoft,
    required this.dangerInk,
    required this.dangerSoft,
    required this.userBubble,
    required this.userText,
    required this.isDark,
    this.hasPaperGrain = false,
    this.useReadingChrome = false,
    this.pageEdgeTint,
  });

  final Color mineralCanvas;
  final Color letterSurface;
  final Color celadonWash;
  final Color slipPaper;
  final Color codeSurface;
  final Color inkDeep;
  final Color inkQuiet;
  final Color inkFaint;
  final Color hairline;
  final Color hairlineWarm;
  final Color accent;
  final Color onAccent;
  final Color accentSoft;
  final Color accentBorder;
  final Color statusSuccess;
  final Color statusSuccessSoft;
  final Color thresholdAmber;
  final Color thresholdAmberSoft;
  final Color dangerInk;
  final Color dangerSoft;
  final Color userBubble;
  final Color userText;
  final bool isDark;
  final bool hasPaperGrain;
  final bool useReadingChrome;
  final Color? pageEdgeTint;

  // 向后兼容旧调用，别名映射至暖质石墨/微灰无彩色，彻底移除突兀的纯绿大色块
  Color get pineAccent => accent;
  Color get pineSoft => accentSoft;

  static const light = PsyberColors(
    mineralCanvas: Color(0xFFF9F9F7), // Roxy Light --bg (暖纸白)
    letterSurface: Color(0xFFFFFFFF), // Roxy Light --surface (纯白信笺)
    celadonWash: Color(0xFFF1F1ED),   // Roxy Light --surface-2 (柔和抬升面)
    slipPaper: Color(0xFFFAF6EE),     // Roxy Light --note-bg (暖黄便签纸)
    codeSurface: Color(0xFFF1F1ED),   // Roxy Light --surface-2
    inkDeep: Color(0xFF30302D),       // Roxy Light --text (暖黑墨色)
    inkQuiet: Color(0xFF94938E),      // Roxy Light --text-muted
    inkFaint: Color(0xFFAFAFA8),      // Roxy Light dim
    hairline: Color(0xFFE5E5DF),      // Roxy Light --border
    hairlineWarm: Color(0xFFE5DFD5),  // Roxy Light --note-border
    accent: Color(0xFF3C3C38),        // Roxy Light --accent (暖石墨深炭黑，主按钮/发送按钮/选中胶囊)
    onAccent: Color(0xFFFFFFFF),      // Roxy Light --accent-contrast (白字)
    accentSoft: Color(0xFFEEEEEA),    // Roxy Light --accent-soft (微灰暖底，选中状态背景)
    accentBorder: Color(0xFFD2D2CC),  // Roxy Light --accent-border (选中边框)
    statusSuccess: Color(0xFF55755D), // Roxy Light --success (仅用作在线状态呼吸微点，绝不用作大按钮色)
    statusSuccessSoft: Color(0xFFEEF3EF),
    thresholdAmber: Color(0xFFB87503), // Roxy Light --warning (门关着琥珀金/门缝纸条)
    thresholdAmberSoft: Color(0xFFFAF2E4),
    dangerInk: Color(0xFFC27A51),      // Roxy Light --danger
    dangerSoft: Color(0xFFF9EDE8),
    userBubble: Color(0xFFF0F0EC),     // Roxy Light 原色（浅灰米，克制）
    userText: Color(0xFF30302D),       // Roxy Light --user-text
    isDark: false,
  );

  static const dark = PsyberColors(
    mineralCanvas: Color(0xFF1F1F1D), // Roxy Dark --bg (曜夜暖黑)
    letterSurface: Color(0xFF292927), // Roxy Dark --surface (暗调升面)
    celadonWash: Color(0xFF343431),   // Roxy Dark --surface-2
    slipPaper: Color(0xFF282622),     // Roxy Dark --note-bg
    codeSurface: Color(0xFF232321),   // Roxy Dark code surface
    inkDeep: Color(0xFFF1F1ED),       // Roxy Dark --text (纸白浅字)
    inkQuiet: Color(0xFF999993),      // Roxy Dark --text-muted
    inkFaint: Color(0xFF70706A),      // Roxy Dark dim
    hairline: Color(0xFF3F3F3B),      // Roxy Dark --border
    hairlineWarm: Color(0xFF3D3830),  // Roxy Dark --note-border
    accent: Color(0xFFDEDED7),        // Roxy Dark --accent (暖象牙白，主按钮/发送按钮/选中胶囊)
    onAccent: Color(0xFF292927),      // Roxy Dark --accent-contrast (深炭字)
    accentSoft: Color(0xFF3D3D39),    // Roxy Dark --accent-soft
    accentBorder: Color(0xFF565650),  // Roxy Dark --accent-border
    statusSuccess: Color(0xFF679374), // Roxy Dark --success
    statusSuccessSoft: Color(0xFF233027),
    thresholdAmber: Color(0xFFD4A34B), // Roxy Dark --warning
    thresholdAmberSoft: Color(0xFF3A3020),
    dangerInk: Color(0xFFD97D64),      // Roxy Dark --danger
    dangerSoft: Color(0xFF3D2A26),
    userBubble: Color(0xFF343431),     // Roxy Dark 原色（深灰，克制）
    userText: Color(0xFFF1F1ED),       // Roxy Dark --user-text
    isDark: true,
  );

  /// 旧书暖纸：古籍米白底纸 (#EAE4DA) + 墨黑正文字 (#313131) + 赤陶强调 (#A2644C) + 纯纸纤维微纹理
  static const oldBookPaper = PsyberColors(
    mineralCanvas: Color(0xFFEAE4DA),
    letterSurface: Color(0xFFF3EFE8),
    celadonWash: Color(0xFFE1DBD0),
    slipPaper: Color(0xFFEFE6D6),
    codeSurface: Color(0xFFE4DDD2),
    inkDeep: Color(0xFF313131),
    inkQuiet: Color(0xFF7B746B),
    inkFaint: Color(0xFFA69F95),
    hairline: Color(0xFFD7CFC2),
    hairlineWarm: Color(0xFFCCA391),
    accent: Color(0xFFA2644C),
    onAccent: Color(0xFFFAF7F2),
    accentSoft: Color(0xFFE9DBD3),
    accentBorder: Color(0xFFCFA898),
    statusSuccess: Color(0xFF5E7A61),
    statusSuccessSoft: Color(0xFFE6ECE6),
    thresholdAmber: Color(0xFFA66D28),
    thresholdAmberSoft: Color(0xFFF2E7D5),
    dangerInk: Color(0xFF9E4B3A),
    dangerSoft: Color(0xFFF2E1DC),
    userBubble: Color(0xFFA2644C),     // 跟随 accent（实心陶土红气泡）
    userText: Color(0xFFFAF7F2),       // onAccent（气泡内暖白字）
    isDark: false,
    hasPaperGrain: true,
    useReadingChrome: true,
    pageEdgeTint: Color(0x0E8A6E4E),
  );

  /// 岸线·晨：石灰纸底 (#E2DDD6) + 深海岩蓝墨 (#3B4B54) + 雾蓝点缀 (#8C9BA5) + 颗粒质感
  static const shoreLight = PsyberColors(
    mineralCanvas: Color(0xFFE2DDD6),
    letterSurface: Color(0xFFECE9E3),
    celadonWash: Color(0xFFD6D3CC),
    slipPaper: Color(0xFFE9E5DC),
    codeSurface: Color(0xFFDAD7D0),
    inkDeep: Color(0xFF28343B),
    inkQuiet: Color(0xFF64737D),
    inkFaint: Color(0xFF939FA6),
    hairline: Color(0xFFC8C5BE),
    hairlineWarm: Color(0xFF8C9BA5),
    accent: Color(0xFF3B4B54),
    onAccent: Color(0xFFF2EFEA),
    accentSoft: Color(0xFFD3D8DB),
    accentBorder: Color(0xFF8C9BA5),
    statusSuccess: Color(0xFF4F6F6D),
    statusSuccessSoft: Color(0xFFDFE7E3),
    thresholdAmber: Color(0xFF876A45),
    thresholdAmberSoft: Color(0xFFEBE3D4),
    dangerInk: Color(0xFF8E5258),
    dangerSoft: Color(0xFFEBDDE0),
    userBubble: Color(0xFF3B4B54),     // 跟随 accent（实心气泡）
    userText: Color(0xFFF2EFEA),       // onAccent
    isDark: false,
    hasPaperGrain: true,
    useReadingChrome: true,
    pageEdgeTint: Color(0x0C5E7382),
  );

  /// 岸线·夜：深海夜蓝 (#222B33) + 岩蓝升面 (#3B4B54) + 雾蓝主色 (#8C9BA5) + 柔白纸字 (#E2DDD6)
  static const shoreDark = PsyberColors(
    mineralCanvas: Color(0xFF222B33),
    letterSurface: Color(0xFF2A353E),
    celadonWash: Color(0xFF33404B),
    slipPaper: Color(0xFF28333C),
    codeSurface: Color(0xFF1C242B),
    inkDeep: Color(0xFFE2DDD6),
    inkQuiet: Color(0xFF9AA5AE),
    inkFaint: Color(0xFF6B7984),
    hairline: Color(0xFF3B4B54),
    hairlineWarm: Color(0xFF566875),
    accent: Color(0xFF8C9BA5),
    onAccent: Color(0xFF182026),
    accentSoft: Color(0xFF2F3D47),
    accentBorder: Color(0xFF5A6C79),
    statusSuccess: Color(0xFF7B9D99),
    statusSuccessSoft: Color(0xFF233330),
    thresholdAmber: Color(0xFFBFA374),
    thresholdAmberSoft: Color(0xFF342E25),
    dangerInk: Color(0xFFC48486),
    dangerSoft: Color(0xFF3A292C),
    userBubble: Color(0xFF8C9BA5),     // 跟随 accent（实心气泡）
    userText: Color(0xFF182026),       // onAccent
    isDark: true,
    hasPaperGrain: true,
    useReadingChrome: true,
    pageEdgeTint: Color(0x180E141A),
  );

  static PsyberColors forPalette(PsyberPalette palette) {
    switch (palette) {
      case PsyberPalette.warmPaper:
        return PsyberColors.light;
      case PsyberPalette.obsidianNight:
        return PsyberColors.dark;
      case PsyberPalette.oldBookPaper:
        return PsyberColors.oldBookPaper;
      case PsyberPalette.shoreLight:
        return PsyberColors.shoreLight;
      case PsyberPalette.shoreDark:
        return PsyberColors.shoreDark;
    }
  }

  @override
  PsyberColors copyWith({
    Color? mineralCanvas,
    Color? letterSurface,
    Color? celadonWash,
    Color? slipPaper,
    Color? codeSurface,
    Color? inkDeep,
    Color? inkQuiet,
    Color? inkFaint,
    Color? hairline,
    Color? hairlineWarm,
    Color? accent,
    Color? onAccent,
    Color? accentSoft,
    Color? accentBorder,
    Color? statusSuccess,
    Color? statusSuccessSoft,
    Color? thresholdAmber,
    Color? thresholdAmberSoft,
    Color? dangerInk,
    Color? dangerSoft,
    Color? userBubble,
    Color? userText,
    bool? isDark,
    bool? hasPaperGrain,
    bool? useReadingChrome,
    Color? pageEdgeTint,
  }) {
    return PsyberColors(
      mineralCanvas: mineralCanvas ?? this.mineralCanvas,
      letterSurface: letterSurface ?? this.letterSurface,
      celadonWash: celadonWash ?? this.celadonWash,
      slipPaper: slipPaper ?? this.slipPaper,
      codeSurface: codeSurface ?? this.codeSurface,
      inkDeep: inkDeep ?? this.inkDeep,
      inkQuiet: inkQuiet ?? this.inkQuiet,
      inkFaint: inkFaint ?? this.inkFaint,
      hairline: hairline ?? this.hairline,
      hairlineWarm: hairlineWarm ?? this.hairlineWarm,
      accent: accent ?? this.accent,
      onAccent: onAccent ?? this.onAccent,
      accentSoft: accentSoft ?? this.accentSoft,
      accentBorder: accentBorder ?? this.accentBorder,
      statusSuccess: statusSuccess ?? this.statusSuccess,
      statusSuccessSoft: statusSuccessSoft ?? this.statusSuccessSoft,
      thresholdAmber: thresholdAmber ?? this.thresholdAmber,
      thresholdAmberSoft: thresholdAmberSoft ?? this.thresholdAmberSoft,
      dangerInk: dangerInk ?? this.dangerInk,
      dangerSoft: dangerSoft ?? this.dangerSoft,
      userBubble: userBubble ?? this.userBubble,
      userText: userText ?? this.userText,
      isDark: isDark ?? this.isDark,
      hasPaperGrain: hasPaperGrain ?? this.hasPaperGrain,
      useReadingChrome: useReadingChrome ?? this.useReadingChrome,
      pageEdgeTint: pageEdgeTint ?? this.pageEdgeTint,
    );
  }

  @override
  PsyberColors lerp(ThemeExtension<PsyberColors>? other, double t) {
    if (other is! PsyberColors) return this;
    return PsyberColors(
      mineralCanvas: Color.lerp(mineralCanvas, other.mineralCanvas, t)!,
      letterSurface: Color.lerp(letterSurface, other.letterSurface, t)!,
      celadonWash: Color.lerp(celadonWash, other.celadonWash, t)!,
      slipPaper: Color.lerp(slipPaper, other.slipPaper, t)!,
      codeSurface: Color.lerp(codeSurface, other.codeSurface, t)!,
      inkDeep: Color.lerp(inkDeep, other.inkDeep, t)!,
      inkQuiet: Color.lerp(inkQuiet, other.inkQuiet, t)!,
      inkFaint: Color.lerp(inkFaint, other.inkFaint, t)!,
      hairline: Color.lerp(hairline, other.hairline, t)!,
      hairlineWarm: Color.lerp(hairlineWarm, other.hairlineWarm, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      onAccent: Color.lerp(onAccent, other.onAccent, t)!,
      accentSoft: Color.lerp(accentSoft, other.accentSoft, t)!,
      accentBorder: Color.lerp(accentBorder, other.accentBorder, t)!,
      statusSuccess: Color.lerp(statusSuccess, other.statusSuccess, t)!,
      statusSuccessSoft: Color.lerp(statusSuccessSoft, other.statusSuccessSoft, t)!,
      thresholdAmber: Color.lerp(thresholdAmber, other.thresholdAmber, t)!,
      thresholdAmberSoft: Color.lerp(thresholdAmberSoft, other.thresholdAmberSoft, t)!,
      dangerInk: Color.lerp(dangerInk, other.dangerInk, t)!,
      dangerSoft: Color.lerp(dangerSoft, other.dangerSoft, t)!,
      userBubble: Color.lerp(userBubble, other.userBubble, t)!,
      userText: Color.lerp(userText, other.userText, t)!,
      isDark: t < 0.5 ? isDark : other.isDark,
      hasPaperGrain: t < 0.5 ? hasPaperGrain : other.hasPaperGrain,
      useReadingChrome: t < 0.5 ? useReadingChrome : other.useReadingChrome,
      pageEdgeTint: Color.lerp(pageEdgeTint, other.pageEdgeTint, t),
    );
  }
}

extension PsyberContextExtension on BuildContext {
  PsyberColors get colors => PsyberTheme.of(this);
}

class PsyberTheme {
  // 兼容老静态常量的 Roxy Light（Warm Paper）Token
  static const Color mineralCanvas = Color(0xFFF9F9F7);
  static const Color letterSurface = Color(0xFFFFFFFF);
  static const Color celadonWash = Color(0xFFF1F1ED);
  static const Color slipPaper = Color(0xFFFAF6EE);
  static const Color codeSurface = Color(0xFFF1F1ED);

  static const Color inkDeep = Color(0xFF30302D);
  static const Color inkQuiet = Color(0xFF94938E);
  static const Color inkFaint = Color(0xFFAFAFA8);

  static const Color hairline = Color(0xFFE5E5DF);
  static const Color hairlineWarm = Color(0xFFE5DFD5);

  // 映射至暖质石墨与微灰无彩色，彻底移除突兀的纯绿大按钮
  static const Color accent = Color(0xFF3C3C38);
  static const Color onAccent = Color(0xFFFFFFFF);
  static const Color accentSoft = Color(0xFFEEEEEA);
  static const Color accentBorder = Color(0xFFD2D2CC);
  static const Color statusSuccess = Color(0xFF55755D);

  static const Color pineAccent = Color(0xFF3C3C38);
  static const Color pineSoft = Color(0xFFEEEEEA);
  static const Color thresholdAmber = Color(0xFFB87503);
  static const Color thresholdAmberSoft = Color(0xFFFAF2E4);

  static const Color dangerInk = Color(0xFFC27A51);
  static const Color dangerSoft = Color(0xFFF9EDE8);
  static const Color userBubble = Color(0xFFF0F0EC);

  static const double readingMaxWidth = 680;
  static const double desktopBreakpoint = 920;

  static const TextStyle editorialSerif = TextStyle(
    fontFamilyFallback: ['Songti SC', 'Noto Serif CJK SC', 'STSong', 'Georgia', 'serif'],
  );

  static const TextStyle monoStyle = TextStyle(
    fontFamilyFallback: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
  );

  static PsyberColors of(BuildContext context) {
    return Theme.of(context).extension<PsyberColors>() ??
        (Theme.of(context).brightness == Brightness.dark
            ? PsyberColors.dark
            : PsyberColors.light);
  }

  static ThemeData fromPalette(PsyberPalette palette) {
    return _buildTheme(PsyberColors.forPalette(palette));
  }

  static ThemeData light() => _buildTheme(PsyberColors.light);

  static ThemeData dark() => _buildTheme(PsyberColors.dark);

  static ThemeData _buildTheme(PsyberColors colors) {
    final brightness = colors.isDark ? Brightness.dark : Brightness.light;
    final scheme = ColorScheme.fromSeed(
      seedColor: colors.accent,
      brightness: brightness,
      primary: colors.accent,
      onPrimary: colors.onAccent,
      surface: colors.mineralCanvas,
      onSurface: colors.inkDeep,
      outline: colors.hairline,
      error: colors.dangerInk,
    );

    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide(color: colors.hairline),
    );
    final focusedBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide(color: colors.accent, width: 1.2),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: colors.mineralCanvas,
      appBarTheme: AppBarTheme(
        backgroundColor: colors.mineralCanvas,
        foregroundColor: colors.inkDeep,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      textTheme: TextTheme(
        bodyMedium: TextStyle(color: colors.inkDeep, fontSize: 15, height: 1.58),
        bodySmall: TextStyle(color: colors.inkQuiet, fontSize: 13, height: 1.45),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: colors.letterSurface,
        border: border,
        enabledBorder: border,
        focusedBorder: focusedBorder,
        labelStyle: TextStyle(color: colors.inkQuiet, fontSize: 13.5),
        hintStyle: TextStyle(color: colors.inkFaint, fontSize: 14),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: colors.accent,
          foregroundColor: colors.onAccent,
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: colors.inkDeep,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) {
            return colors.isDark ? colors.onAccent : Colors.white;
          }
          return colors.inkQuiet;
        }),
        trackColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return colors.accent;
          return colors.celadonWash;
        }),
        trackOutlineColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return colors.accent;
          return colors.hairline;
        }),
      ),
      dividerColor: colors.hairline,
      dividerTheme: DividerThemeData(color: colors.hairline, thickness: 1, space: 1),
      dialogTheme: DialogThemeData(
        backgroundColor: colors.letterSurface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: colors.hairline),
        ),
        titleTextStyle: TextStyle(
          color: colors.inkDeep,
          fontSize: 17,
          fontWeight: FontWeight.w600,
        ),
        contentTextStyle: TextStyle(
          color: colors.inkQuiet,
          fontSize: 14,
          height: 1.5,
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: colors.letterSurface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
          side: BorderSide(color: colors.hairline),
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: colors.letterSurface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: colors.hairline),
        ),
        textStyle: TextStyle(color: colors.inkDeep, fontSize: 13.5),
      ),
      listTileTheme: ListTileThemeData(
        textColor: colors.inkDeep,
        iconColor: colors.inkQuiet,
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: colors.accent,
        selectionColor: colors.accentSoft,
        selectionHandleColor: colors.accent,
      ),
      extensions: <ThemeExtension<dynamic>>[colors],
    );
  }
}
