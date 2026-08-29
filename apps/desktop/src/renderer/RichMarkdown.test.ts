import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CitationList, CitationProvider, remarkCupcakeCitations } from './citations';
import { prepareStreamingMarkdown } from './markdown-stream';
import { RichMarkdown, safeMarkdownUrl } from './RichMarkdown';
import { markdownToAnnouncementText, StreamingAnnouncementBuffer } from './streaming-announcer';

describe('prepareStreamingMarkdown', () => {
  it('temporarily closes unfinished fenced code with the matching marker', () => {
    const prepared = prepareStreamingMarkdown('Before\n\n~~~~ts\nconst value = 1;', true);
    expect(prepared.markdown).toBe('Before\n\n~~~~ts\nconst value = 1;\n~~~~');
    expect(prepared.completions).toEqual([{ kind: 'fenced-code', marker: '~~~~' }]);
    expect(prepared.source).not.toContain('\n~~~~\n~~~~');
  });

  it('does not mistake code content or a completed code block for open inline syntax', () => {
    const complete = ['```js', 'const template = `hello ${name};', '```', '', 'Done.'].join('\n');
    expect(prepareStreamingMarkdown(complete, true).completions).toEqual([]);
    const unfinished = ['```ts', '```not a closing fence'];
    expect(prepareStreamingMarkdown(unfinished.join('\n'), true).completions).toEqual([
      { kind: 'fenced-code', marker: '```' },
    ]);
  });

  it('closes inline code and math without treating currency as math', () => {
    expect(prepareStreamingMarkdown('Use `pnpm test', true).markdown).toBe('Use `pnpm test`');
    expect(prepareStreamingMarkdown('Area: $x + y', true).markdown).toBe('Area: $x + y$');
    expect(prepareStreamingMarkdown('It costs $20', true).completions).toEqual([]);
  });

  it('normalizes transport text and leaves complete messages untouched', () => {
    const prepared = prepareStreamingMarkdown('one\r\ntwo\0', false);
    expect(prepared.source).toBe('one\ntwo\uFFFD');
    expect(prepared.markdown).toBe(prepared.source);
  });
});

describe('citation remark plugin', () => {
  it('converts citation tokens in text but never inside code', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'Claim [[cite:source-7|7]].' }] },
        { type: 'inlineCode', value: '[[cite:do-not-touch]]' },
      ],
    };
    const transform = remarkCupcakeCitations();
    transform(tree);
    expect(tree.children[0]).toMatchObject({
      children: [
        { type: 'text', value: 'Claim ' },
        {
          type: 'link',
          url: 'cupcake-citation:source-7',
          children: [{ type: 'text', value: '7' }],
        },
        { type: 'text', value: '.' },
      ],
    });
    expect(tree.children[1]).toEqual({ type: 'inlineCode', value: '[[cite:do-not-touch]]' });
  });
});

describe('safeMarkdownUrl', () => {
  it('allows product citations, web links, mail, and local headings only', () => {
    expect(safeMarkdownUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeMarkdownUrl('mailto:hello@example.com')).toBe('mailto:hello@example.com');
    expect(safeMarkdownUrl('#local-heading')).toBe('#local-heading');
    expect(safeMarkdownUrl('cupcake-citation:source-1')).toBe('cupcake-citation:source-1');
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(safeMarkdownUrl('file:///C:/private.txt')).toBe('');
    expect(safeMarkdownUrl('/relative/path')).toBe('');
  });
});

describe('streaming screen-reader announcements', () => {
  it('waits for a complete phrase and does not postpone it for token-only updates', () => {
    const buffer = new StreamingAnnouncementBuffer(600);
    expect(buffer.update('The parser is', true, 0)).toBeUndefined();
    expect(buffer.delayUntilFlush(0)).toBeUndefined();

    expect(buffer.update('The parser is safe.', true, 100)).toBeUndefined();
    expect(buffer.delayUntilFlush(100)).toBe(600);
    expect(buffer.update('The parser is safe. It', true, 300)).toBeUndefined();
    expect(buffer.delayUntilFlush(300)).toBe(400);
    expect(buffer.flush(699)).toBeUndefined();
    expect(buffer.flush(700)).toEqual({ kind: 'phrase', text: 'The parser is safe.' });
  });

  it('coalesces phrases arriving within the debounce window, then announces only the new phrase', () => {
    const buffer = new StreamingAnnouncementBuffer(500);
    buffer.update('First phrase.', true, 0);
    buffer.update('First phrase. Second phrase!', true, 200);
    expect(buffer.flush(699)).toBeUndefined();
    expect(buffer.flush(700)).toEqual({
      kind: 'phrase',
      text: 'First phrase. Second phrase!',
    });

    buffer.update('First phrase. Second phrase! Third phrase?', true, 900);
    expect(buffer.flush(1400)).toEqual({ kind: 'phrase', text: 'Third phrase?' });
  });

  it('announces the complete readable response once the stream ends, including an unfinished tail', () => {
    const buffer = new StreamingAnnouncementBuffer(500);
    buffer.update('A complete phrase. Final tail', true, 0);
    expect(buffer.update('A complete phrase. Final tail', false, 100)).toEqual({
      kind: 'complete',
      text: 'Response complete. A complete phrase. Final tail',
    });
    expect(buffer.update('A complete phrase. Final tail', false, 200)).toBeUndefined();
  });

  it('summarizes code, math, links, and images without announcing raw syntax', () => {
    const plain = markdownToAnnouncementText(
      '```ts\nconst secret = token;\n```\n\nSee [docs](https://example.com). $$x^2$$ ![Chart](https://example.com/a.png)',
    );
    expect(plain).toBe('Code block. See docs. Mathematical expression. Image: Chart.');
    expect(plain).not.toContain('secret');
    expect(plain).not.toContain('https://');
  });
});

describe('RichMarkdown', () => {
  it('renders GFM, highlighted code, math, and accessible citations', () => {
    const source = [
      '# Results',
      '',
      '| Item | Ready |',
      '| --- | --- |',
      '| Parser | yes |',
      '',
      '- [x] Safe output',
      '',
      'Inline $x^2$ and [[cite:paper-1|1]].',
      '',
      '```js',
      'const answer = 42;',
      '```',
    ].join('\n');
    const html = renderToStaticMarkup(
      React.createElement(RichMarkdown, {
        citations: [{ id: 'paper-1', index: 1, title: 'Parser study', locator: 'p. 4' }],
        children: source,
      }),
    );
    expect(html).toContain('aria-label="Scrollable data table"');
    expect(html).toContain('aria-label="Completed task"');
    expect(html).toContain('class="katex"');
    expect(html).toContain('markdown-code-block');
    expect(html).toContain('language-js');
    expect(html).toContain('aria-label="Citation 1: Parser study, p. 4"');
    expect(html).toContain('Sources cited in this response');
  });

  it('drops raw HTML, blocks executable links, and does not load remote images by default', () => {
    const source = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(2)">',
      '[bad](javascript:alert(3))',
      '![tracking pixel](https://tracker.example/pixel.gif)',
    ].join('\n\n');
    const html = renderToStaticMarkup(React.createElement(RichMarkdown, { children: source }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('Image not loaded: tracking pixel');
  });

  it('renders a source list with provenance rather than raw URLs', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        CitationProvider,
        {
          citations: [
            {
              id: 'doc',
              index: 2,
              title: 'Architecture decision',
              source: 'Project files',
              locator: 'ADR 0004',
              excerpt: 'Project scope is a hard boundary.',
            },
          ],
        },
        React.createElement(CitationList),
      ),
    );
    expect(html).toContain('Architecture decision');
    expect(html).toContain('Project files · ADR 0004');
    expect(html).toContain('Project scope is a hard boundary.');
  });
});
