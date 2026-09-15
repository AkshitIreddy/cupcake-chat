export type MarkdownCompletionKind = 'fenced-code' | 'inline-code' | 'block-math' | 'inline-math';

export interface MarkdownCompletion {
  readonly kind: MarkdownCompletionKind;
  readonly marker: string;
}

export interface PreparedStreamingMarkdown {
  /** Normalized user/provider text, before temporary stream-only closers. */
  readonly source: string;
  /** Markdown safe to parse for the current animation frame. */
  readonly markdown: string;
  readonly completions: readonly MarkdownCompletion[];
  readonly streaming: boolean;
}

interface OpenFence {
  readonly character: '`' | '~';
  readonly length: number;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Normalizes transport-level oddities without rewriting authored Markdown.
 * NUL is invalid in the text protocol and is made visible rather than silently
 * truncating a browser or native string at a later boundary.
 */
export function normalizeMarkdownSource(source: string): string {
  return source.replace(/\r\n?/g, '\n').replaceAll('\0', '\uFFFD');
}

function findOpenFence(source: string): OpenFence | undefined {
  let open: OpenFence | undefined;

  for (const line of source.split('\n')) {
    const match = FENCE_PATTERN.exec(line);
    const marker = match?.[1];
    if (!marker) continue;

    const character = marker[0] as '`' | '~';
    if (!open) {
      open = { character, length: marker.length };
      continue;
    }

    if (
      character === open.character &&
      marker.length >= open.length &&
      (match?.[2] ?? '').trim() === ''
    ) {
      open = undefined;
    }
  }

  return open;
}

function sourceOutsideFences(source: string): string {
  const visibleLines: string[] = [];
  let open: OpenFence | undefined;

  for (const line of source.split('\n')) {
    const match = FENCE_PATTERN.exec(line);
    const marker = match?.[1];
    if (marker) {
      const character = marker[0] as '`' | '~';
      if (!open) {
        open = { character, length: marker.length };
        visibleLines.push('');
        continue;
      }
      if (
        character === open.character &&
        marker.length >= open.length &&
        (match?.[2] ?? '').trim() === ''
      ) {
        open = undefined;
      }
      visibleLines.push('');
      continue;
    }

    visibleLines.push(open ? '' : line);
  }

  return visibleLines.join('\n');
}

/** Providers also use LaTeX display delimiters; remark-math expects dollars.
 * Convert only stand-alone display delimiters, never examples inside code. */
function displayMathDelimiters(source: string): string {
  let fence: OpenFence | undefined;
  return source
    .split('\n')
    .map((line) => {
      const match = FENCE_PATTERN.exec(line);
      const marker = match?.[1];
      if (marker) {
        const character = marker[0] as '`' | '~';
        if (!fence) fence = { character, length: marker.length };
        else if (
          character === fence.character &&
          marker.length >= fence.length &&
          !(match?.[2] ?? '').trim()
        )
          fence = undefined;
        return line;
      }
      if (!fence && ['\\[', '\\]'].includes(line.trim())) return '$$';
      return line;
    })
    .join('\n');
}

function isEscaped(source: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findOpenInlineCode(source: string): number | undefined {
  let openRun: number | undefined;

  for (let index = 0; index < source.length;) {
    if (source[index] !== '`' || isEscaped(source, index)) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (source[end] === '`') end += 1;
    const runLength = end - index;

    if (openRun === undefined) openRun = runLength;
    else if (runLength === openRun) openRun = undefined;

    index = end;
  }

  return openRun;
}

interface MathState {
  readonly blockOpen: boolean;
  readonly inlineOpen: boolean;
}

/** Scan math only after code has been completed; dollar signs inside code are data. */
function findOpenMath(source: string): MathState {
  let blockOpen = false;
  let inlineOpen = false;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '$' || isEscaped(source, index)) continue;

    if (source[index + 1] === '$') {
      blockOpen = !blockOpen;
      index += 1;
      continue;
    }

    // A dollar touching a digit is usually currency. remark-math applies more
    // grammar constraints too; this keeps the stream completer conservative.
    const before = source[index - 1] ?? '';
    const after = source[index + 1] ?? '';
    if (/\d/.test(before) || /\d/.test(after)) continue;
    if (!blockOpen) inlineOpen = !inlineOpen;
  }

  return { blockOpen, inlineOpen };
}

/**
 * Produces a parseable frame while a provider is still streaming. Temporary
 * closers never enter persisted message text and disappear on the next frame.
 * This prevents an unfinished code fence or math block from swallowing every
 * following element in a long conversation.
 */
export function prepareStreamingMarkdown(
  source: string,
  streaming = false,
): PreparedStreamingMarkdown {
  const normalized = normalizeMarkdownSource(source);
  const displaySource = displayMathDelimiters(normalized);
  if (!streaming || normalized.length === 0) {
    return { source: normalized, markdown: displaySource, completions: [], streaming };
  }

  const completions: MarkdownCompletion[] = [];
  const fence = findOpenFence(displaySource);
  // A marker-only last line is syntax in transit, not an empty item to display.
  // Keep it in source and preserve intentional empty items once the turn ends.
  const visible = fence
    ? displaySource
    : displaySource.replace(
        /(^|\n)[ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]*(?:\[[ xX]?\]?[ \t]*)?(?:\*{1,2}|_{1,2})?[ \t]*$/u,
        '',
      );

  if (fence) {
    completions.push({ kind: 'fenced-code', marker: fence.character.repeat(fence.length) });
  } else {
    const proseSource = sourceOutsideFences(displaySource);
    const inlineCode = findOpenInlineCode(proseSource);
    if (inlineCode) {
      completions.push({ kind: 'inline-code', marker: '`'.repeat(inlineCode) });
    } else {
      const math = findOpenMath(proseSource);
      if (math.blockOpen) completions.push({ kind: 'block-math', marker: '$$' });
      else if (math.inlineOpen) completions.push({ kind: 'inline-math', marker: '$' });
    }
  }

  const suffix = completions
    .map((completion) =>
      completion.kind === 'fenced-code' || completion.kind === 'block-math'
        ? `\n${completion.marker}`
        : completion.marker,
    )
    .join('');

  return {
    source: normalized,
    markdown: `${visible}${suffix}`,
    completions,
    streaming: true,
  };
}
