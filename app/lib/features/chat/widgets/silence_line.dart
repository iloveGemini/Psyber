import 'package:flutter/material.dart';

import '../../../shared/theme.dart';

const List<String> _replySilencePhrases = [
  '这次只是安静看了看，没有开口',
  '听着，暂时没有说话',
  '把话留在心里了，没有打扰',
];

const List<String> _ownTimeSilencePhrases = [
  '在自己的时间里安静待了一会儿',
  '醒来看了看，决定先不打扰',
  '翻了翻门缝，安静留在这里',
];

String pickSilencePhrase(String seed, {required bool ownTime}) {
  final pool = ownTime ? _ownTimeSilencePhrases : _replySilencePhrases;
  var hash = 0;
  for (final code in seed.codeUnits) {
    hash = (hash * 31 + code) & 0x7fffffff;
  }
  return pool[hash % pool.length];
}

/// 住户主动选择沉默（Spec 04 §5.4）：
/// 视觉语域与系统故障中断严格隔离——仅一条极轻的横线与斜体短语，无边框、无警示色。
class SilenceLine extends StatelessWidget {
  const SilenceLine({
    super.key,
    required this.seed,
    this.ownTime = false,
  });

  final String seed;
  final bool ownTime;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PsyberTheme.readingMaxWidth),
        child: Padding(
          key: const Key('silence_line'),
          padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
          child: Row(
            children: [
              Text(
                '—',
                style: TextStyle(
                  fontSize: 11.5,
                  color: colors.inkFaint.withValues(alpha: 0.7),
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  pickSilencePhrase(seed, ownTime: ownTime),
                  style: PsyberTheme.editorialSerif.copyWith(
                    fontSize: 12.5,
                    fontStyle: FontStyle.italic,
                    color: colors.inkQuiet,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
