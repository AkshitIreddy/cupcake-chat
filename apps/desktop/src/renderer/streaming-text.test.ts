import { describe, expect, it } from 'vitest';
import { StreamingTextBuffer } from './streaming-text';

describe('streaming presentation buffer', () => {
  it('spreads a transport burst over frames and catches up within 160 ms', () => {
    const text = 'Grain, ships and supply depots. '.repeat(20);
    const buffer = new StreamingTextBuffer('', true);
    buffer.update(text, true, 100);
    const frames = [116, 149, 182, 215, 248, 281].map((now) => buffer.advance(now));
    expect(frames[0]!.length).toBeGreaterThan(0);
    expect(frames[0]!.length).toBeLessThan(text.length);
    expect(new Set(frames.map((frame) => frame.length)).size).toBeGreaterThan(3);
    frames.forEach((frame, i) => {
      expect(text.startsWith(frame)).toBe(true);
      if (i) expect(frame.startsWith(frames[i - 1]!)).toBe(true);
    });
    expect(frames.at(-1)).toBe(text);
    expect(buffer.pending).toBe(false);
  });

  it('keeps saved messages instant and flushes reduced-motion updates', () => {
    const buffer = new StreamingTextBuffer('Saved answer');
    expect(buffer.text).toBe('Saved answer');
    expect(buffer.update('New answer', true, 100, true)).toBe('New answer');
  });

  it('finishes without truncation and discards a replaced stream immediately', () => {
    const buffer = new StreamingTextBuffer('', true);
    buffer.update('Old answer', true, 100);
    buffer.advance(116);
    expect(buffer.update('Replacement', true, 120)).toBe('');
    buffer.update('Replacement finished.', false, 130);
    expect(buffer.advance(300)).toBe('Replacement finished.');
  });

  it('reveals only whole graphemes', () => {
    const text = '🧁👨‍👩‍👧‍👦e\u0301🇮🇳'.repeat(5);
    const ends = new Set(
      [...new Intl.Segmenter().segment(text)].map((s) => s.index + s.segment.length),
    );
    const buffer = new StreamingTextBuffer('', true);
    buffer.update(text, true, 10);
    for (let now = 16; now < 190; now += 16)
      expect(ends.has(buffer.advance(now).length)).toBe(true);
  });
});
