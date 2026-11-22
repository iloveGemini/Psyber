import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

/// 零第三方依赖的轻量正文渲染器：
/// 支持代码块（带一键复制）、引用块、加粗、斜体与行内代码，并保持文字可选中复制。
class RichMessageText extends StatelessWidget {
  const RichMessageText({
    super.key,
    required this.text,
    this.baseStyle,
  });

  final String text;
  final TextStyle? baseStyle;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final style = baseStyle ??
        TextStyle(
          fontSize: 15,
          height: 1.62,
          color: colors.inkDeep,
        );
    final blocks = _parseBlocks(text);
    if (blocks.length == 1 && blocks.first is _ParagraphBlock) {
      return SelectableText.rich(
        TextSpan(
          style: style,
          children: _parseInline((blocks.first as _ParagraphBlock).text, style, colors),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < blocks.length; i++) ...[
          if (i > 0) const SizedBox(height: 10),
          _buildBlock(context, blocks[i], style, colors),
        ],
      ],
    );
  }

  Widget _buildBlock(
    BuildContext context,
    _ContentBlock block,
    TextStyle style,
    PsyberColors colors,
  ) {
    switch (block) {
      case _CodeBlock(:final language, :final code):
        return Container(
          width: double.infinity,
          decoration: BoxDecoration(
            color: colors.codeSurface,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: colors.hairline),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 8, 4),
                child: Row(
                  children: [
                    Text(
                      language.isEmpty ? 'code' : language,
                      style: PsyberTheme.monoStyle.copyWith(
                        fontSize: 11.5,
                        color: colors.inkQuiet,
                      ),
                    ),
                    const Spacer(),
                    InkWell(
                      borderRadius: BorderRadius.circular(6),
                      onTap: () => Clipboard.setData(ClipboardData(text: code)),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(PhosphorIconsLight.copy, size: 13, color: colors.inkQuiet),
                            const SizedBox(width: 4),
                            Text(
                              '复制',
                              style: TextStyle(fontSize: 11.5, color: colors.inkQuiet),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.all(12),
                child: SelectableText(
                  code,
                  style: PsyberTheme.monoStyle.copyWith(
                    fontSize: 13,
                    height: 1.5,
                    color: colors.inkDeep,
                  ),
                ),
              ),
            ],
          ),
        );
      case _QuoteBlock(:final text):
        return Container(
          padding: EdgeInsets.fromLTRB(
            12,
            colors.useReadingChrome ? 7 : 4,
            colors.useReadingChrome ? 10 : 4,
            colors.useReadingChrome ? 7 : 4,
          ),
          decoration: BoxDecoration(
            color: colors.useReadingChrome
                ? colors.accentSoft.withValues(alpha: 0.42)
                : null,
            borderRadius: colors.useReadingChrome
                ? const BorderRadius.only(
                    topRight: Radius.circular(6),
                    bottomRight: Radius.circular(6),
                  )
                : null,
            border: Border(
              left: BorderSide(
                color: colors.useReadingChrome ? colors.accent : colors.hairlineWarm,
                width: colors.useReadingChrome ? 2.8 : 2.5,
              ),
            ),
          ),
          child: SelectableText.rich(
            TextSpan(
              style: style.copyWith(color: colors.inkQuiet),
              children: _parseInline(text, style.copyWith(color: colors.inkQuiet), colors),
            ),
          ),
        );
      case _ParagraphBlock(:final text):
        return SelectableText.rich(
          TextSpan(
            style: style,
            children: _parseInline(text, style, colors),
          ),
        );
    }
  }
}

sealed class _ContentBlock {
  const _ContentBlock();
}

class _ParagraphBlock extends _ContentBlock {
  const _ParagraphBlock(this.text);
  final String text;
}

class _QuoteBlock extends _ContentBlock {
  const _QuoteBlock(this.text);
  final String text;
}

class _CodeBlock extends _ContentBlock {
  const _CodeBlock({required this.language, required this.code});
  final String language;
  final String code;
}

List<_ContentBlock> _parseBlocks(String input) {
  final lines = input.split('\n');
  final blocks = <_ContentBlock>[];
  final paraBuffer = <String>[];
  final quoteBuffer = <String>[];

  void flushParagraph() {
    if (paraBuffer.isEmpty) return;
    blocks.add(_ParagraphBlock(paraBuffer.join('\n')));
    paraBuffer.clear();
  }

  void flushQuote() {
    if (quoteBuffer.isEmpty) return;
    blocks.add(_QuoteBlock(quoteBuffer.join('\n')));
    quoteBuffer.clear();
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    if (line.trimLeft().startsWith('```')) {
      flushParagraph();
      flushQuote();
      final fence = line.trimLeft();
      final language = fence.substring(3).trim();
      final codeLines = <String>[];
      i += 1;
      while (i < lines.length && !lines[i].trimLeft().startsWith('```')) {
        codeLines.add(lines[i]);
        i += 1;
      }
      blocks.add(_CodeBlock(language: language, code: codeLines.join('\n')));
      i += 1;
      continue;
    }

    if (line.trimLeft().startsWith('> ')) {
      flushParagraph();
      quoteBuffer.add(line.trimLeft().substring(2));
      i += 1;
      continue;
    }

    if (quoteBuffer.isNotEmpty) {
      flushQuote();
    }
    paraBuffer.add(line);
    i += 1;
  }

  flushQuote();
  flushParagraph();
  if (blocks.isEmpty) {
    blocks.add(const _ParagraphBlock(''));
  }
  return blocks;
}

final RegExp _inlinePattern = RegExp(r'(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)');

List<InlineSpan> _parseInline(String text, TextStyle baseStyle, [PsyberColors? colors]) {
  final spans = <InlineSpan>[];
  var cursor = 0;
  for (final match in _inlinePattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, match.start)));
    }
    final token = match.group(0)!;
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      spans.add(
        TextSpan(
          text: ' ${token.substring(1, token.length - 1)} ',
          style: PsyberTheme.monoStyle.copyWith(
            fontSize: (baseStyle.fontSize ?? 15) - 1.5,
            backgroundColor: colors?.codeSurface ?? PsyberTheme.codeSurface,
            color: colors?.inkDeep ?? PsyberTheme.inkDeep,
          ),
        ),
      );
    } else if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
      );
    } else if (token.startsWith('*') && token.endsWith('*') && token.length >= 2) {
      spans.add(
        TextSpan(
          text: token.substring(1, token.length - 1),
          style: const TextStyle(fontStyle: FontStyle.italic),
        ),
      );
    } else {
      spans.add(TextSpan(text: token));
    }
    cursor = match.end;
  }
  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor)));
  }
  return spans;
}
