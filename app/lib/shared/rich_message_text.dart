import 'package:flutter/material.dart';
import 'package:phosphoricons_flutter/phosphoricons_flutter.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

/// 零第三方依赖的轻量正文渲染器：
/// 支持段落拆分、分隔线、标题、代码块（带一键复制）、引用块、加粗、斜体与行内代码，并保持文字可选中复制。
class RichMessageText extends StatelessWidget {
  const RichMessageText({
    super.key,
    required this.text,
    this.baseStyle,
    this.selectable = true,
  });

  final String text;
  final TextStyle? baseStyle;
  final bool selectable;

  Widget _buildRichText(TextSpan span, {StrutStyle? strutStyle}) {
    if (selectable) {
      return SelectableText.rich(span, strutStyle: strutStyle);
    }
    return Text.rich(span, strutStyle: strutStyle);
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final style = baseStyle ??
        TextStyle(
          fontSize: 15.5,
          height: 1.72,
          color: colors.inkDeep,
        );
    final strutStyle = StrutStyle(
      fontSize: style.fontSize,
      height: style.height,
      forceStrutHeight: true,
      leadingDistribution: TextLeadingDistribution.even,
    );
    final blocks = _parseBlocks(text);
    if (blocks.length == 1 && blocks.first is _ParagraphBlock) {
      return _buildRichText(
        TextSpan(
          style: style,
          children: _parseInline((blocks.first as _ParagraphBlock).text, style, colors),
        ),
        strutStyle: strutStyle,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < blocks.length; i++) ...[
          if (i > 0) SizedBox(height: _blockGap(blocks[i - 1], blocks[i])),
          _buildBlock(context, blocks[i], style, strutStyle, colors),
        ],
      ],
    );
  }

  double _blockGap(_ContentBlock prev, _ContentBlock curr) {
    if (curr is _HeadingBlock) return 16;
    if (prev is _HeadingBlock) return 6;
    if (prev is _DividerBlock || curr is _DividerBlock) return 12;
    if (prev is _CodeBlock || curr is _CodeBlock) return 12;
    if (prev is _QuoteBlock || curr is _QuoteBlock) return 12;
    return 11;
  }

  Widget _buildBlock(
    BuildContext context,
    _ContentBlock block,
    TextStyle style,
    StrutStyle strutStyle,
    PsyberColors colors,
  ) {
    switch (block) {
      case _DividerBlock():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Divider(
            height: 1,
            thickness: 1,
            color: colors.hairline.withValues(alpha: 0.85),
          ),
        );
      case _HeadingBlock(:final level, :final text):
        final baseSize = style.fontSize ?? 15.5;
        final headingSize = switch (level) {
          1 => baseSize + 4.0,
          2 => baseSize + 2.5,
          3 => baseSize + 1.0,
          _ => baseSize,
        };
        final headingStyle = style.copyWith(
          fontSize: headingSize,
          height: 1.42,
          fontWeight: FontWeight.w600,
        );
        return _buildRichText(
          TextSpan(
            style: headingStyle,
            children: _parseInline(text, headingStyle, colors),
          ),
        );
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
        final quoteStyle = style.copyWith(color: colors.inkQuiet);
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
          child: _buildRichText(
            TextSpan(
              style: quoteStyle,
              children: _parseInline(text, quoteStyle, colors),
            ),
            strutStyle: strutStyle,
          ),
        );
      case _ParagraphBlock(:final text):
        return _buildRichText(
          TextSpan(
            style: style,
            children: _parseInline(text, style, colors),
          ),
          strutStyle: strutStyle,
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

class _HeadingBlock extends _ContentBlock {
  const _HeadingBlock({required this.level, required this.text});
  final int level;
  final String text;
}

class _DividerBlock extends _ContentBlock {
  const _DividerBlock();
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

final RegExp _dividerPattern = RegExp(r'^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$');
final RegExp _headingPattern = RegExp(r'^(#{1,4})\s+(.+)$');

List<_ContentBlock> _parseBlocks(String input) {
  final lines = input.replaceAll('\r\n', '\n').split('\n');
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
    final trimmedLeft = line.trimLeft();

    if (trimmedLeft.startsWith('```')) {
      flushParagraph();
      flushQuote();
      final language = trimmedLeft.substring(3).trim();
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

    if (line.trim().isEmpty) {
      flushParagraph();
      flushQuote();
      i += 1;
      continue;
    }

    if (_dividerPattern.hasMatch(line)) {
      flushParagraph();
      flushQuote();
      blocks.add(const _DividerBlock());
      i += 1;
      continue;
    }

    final headingMatch = _headingPattern.firstMatch(trimmedLeft);
    if (headingMatch != null) {
      flushParagraph();
      flushQuote();
      blocks.add(
        _HeadingBlock(
          level: headingMatch.group(1)!.length,
          text: headingMatch.group(2)!.trim(),
        ),
      );
      i += 1;
      continue;
    }

    if (trimmedLeft.startsWith('> ')) {
      flushParagraph();
      quoteBuffer.add(trimmedLeft.substring(2));
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
            fontSize: (baseStyle.fontSize ?? 15.5) - 1.5,
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
