import { useLayoutEffect, useRef, useState } from 'react';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Presentation only: authoritative provider text is never delayed or rewritten. */
export class StreamingTextBuffer {
  private target = '';
  private visible = 0;
  private boundaries: number[] = [];
  private lastFrame = 0;
  private deadline = 0;
  private live = false;

  constructor(source = '', streaming = false) {
    this.update(source, streaming, 0);
  }

  update(source: string, streaming: boolean, now: number, immediate = false): string {
    const replaced = !source.startsWith(this.target);
    if (source !== this.target) {
      this.boundaries = [...segmenter.segment(source)].map(
        (item) => item.index + item.segment.length,
      );
      this.deadline = now + 160;
    }
    if (replaced) this.visible = 0;
    this.target = source;
    if (immediate || (!streaming && !this.live)) this.visible = source.length;
    this.live = streaming;
    return this.text;
  }

  advance(now: number): string {
    const elapsed = Math.min(50, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    if (now >= this.deadline) this.visible = this.target.length;
    else {
      const distance = this.target.length - this.visible;
      const next = this.visible + Math.max(1, Math.ceil(distance * (1 - Math.exp(-elapsed / 55))));
      // Never reveal half an emoji, combining character, or surrogate pair.
      const boundary = this.boundaries.find((end) => end >= next);
      this.visible = boundary ?? this.target.length;
    }
    return this.text;
  }

  get text(): string {
    return this.target.slice(0, this.visible);
  }

  get pending(): boolean {
    return this.visible < this.target.length;
  }
}

function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.reducedMotion === 'true' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useStreamingText(source: string, streaming: boolean): string {
  const buffer = useRef<StreamingTextBuffer | null>(null);
  if (!buffer.current)
    buffer.current = new StreamingTextBuffer(source, streaming && typeof window !== 'undefined');
  const [visible, setVisible] = useState(buffer.current.text);
  const frame = useRef<number | undefined>(undefined);
  const lastPaint = useRef(0);

  useLayoutEffect(() => {
    const queue = buffer.current!;
    setVisible(queue.update(source, streaming, performance.now(), reducedMotion()));
    const paint = (now: number) => {
      frame.current = undefined;
      if (now - lastPaint.current >= 1000 / 30) {
        lastPaint.current = now;
        setVisible(
          reducedMotion() ? queue.update(source, streaming, now, true) : queue.advance(now),
        );
      }
      if (queue.pending) frame.current = requestAnimationFrame(paint);
    };
    if (queue.pending) frame.current = requestAnimationFrame(paint);
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [source, streaming]);

  // Replaced/fallback content must not flash the discarded provider's prefix.
  return source.startsWith(visible) ? visible : '';
}
