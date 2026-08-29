import { useEffect, useRef, useState } from 'react';

export const DEFAULT_ANNOUNCEMENT_DEBOUNCE_MS = 650;

export interface StreamingAnnouncement {
  readonly kind: 'phrase' | 'complete';
  readonly text: string;
}

interface PendingPhrase {
  readonly boundary: number;
  readonly dueAt: number;
}

interface FenceState {
  readonly character: '`' | '~';
  readonly length: number;
}

const BLOCK_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const COMPLETE_PHRASE = /[.!?](?:["')\]}])?(?=\s|$)/g;

function stripFencedCode(markdown: string): string {
  const output: string[] = [];
  let open: FenceState | undefined;

  for (const line of markdown.split('\n')) {
    const match = BLOCK_FENCE.exec(line);
    const marker = match?.[1];
    if (marker) {
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
        output.push('Code block.');
      }
      continue;
    }
    if (!open) output.push(line);
  }

  return output.join('\n');
}

/**
 * Converts rendered concepts to concise speech. This is intentionally not a
 * general Markdown parser: visual content still comes from react-markdown;
 * this representation exists only to avoid reading punctuation and code tokens
 * one character at a time in the live region.
 */
export function markdownToAnnouncementText(markdown: string): string {
  return stripFencedCode(markdown)
    .replace(/\$\$[\s\S]*?\$\$/g, ' Mathematical expression. ')
    .replace(/\$([^$\n]+)\$/g, ' mathematical expression ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) =>
      alt.trim() ? ` Image: ${alt.trim()}. ` : ' Image. ',
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[(?:cite|citation):[^\]|]+(?:\|([^\]]+))?\]\]/gi, (_match, label?: string) =>
      label?.trim() ? ` citation ${label.trim()}` : ' citation',
    )
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*[-:| ]{3,}\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/[*_~]/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\\([\\`*{}[\]()#+.!_>-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function completeBoundary(text: string, after: number): number {
  COMPLETE_PHRASE.lastIndex = Math.max(0, after);
  let boundary = after;
  let match: RegExpExecArray | null;
  while ((match = COMPLETE_PHRASE.exec(text)) !== null) {
    boundary = match.index + match[0].length;
  }
  return boundary;
}

/**
 * Framework-independent state machine used by the React hook and unit tests.
 * A newly completed phrase starts a debounce window. Subsequent token-only
 * updates preserve the original deadline; another complete phrase coalesces
 * into the pending announcement and starts one new window.
 */
export class StreamingAnnouncementBuffer {
  readonly #debounceMs: number;
  #announcedBoundary = 0;
  #pending: PendingPhrase | undefined;
  #wasStreaming = false;
  #latestText = '';

  constructor(debounceMs = DEFAULT_ANNOUNCEMENT_DEBOUNCE_MS) {
    this.#debounceMs = Math.max(0, debounceMs);
  }

  update(markdown: string, streaming: boolean, now: number): StreamingAnnouncement | undefined {
    const text = markdownToAnnouncementText(markdown);

    if (
      text.length < this.#announcedBoundary ||
      !text.startsWith(this.#latestText.slice(0, this.#announcedBoundary))
    ) {
      this.#announcedBoundary = 0;
      this.#pending = undefined;
    }
    this.#latestText = text;

    if (!streaming) {
      const shouldAnnounceCompletion = this.#wasStreaming;
      this.#wasStreaming = false;
      this.#pending = undefined;
      this.#announcedBoundary = text.length;
      return shouldAnnounceCompletion && text
        ? { kind: 'complete', text: `Response complete. ${text}` }
        : undefined;
    }

    this.#wasStreaming = true;
    const boundary = completeBoundary(text, this.#announcedBoundary);
    if (boundary > (this.#pending?.boundary ?? this.#announcedBoundary)) {
      this.#pending = { boundary, dueAt: now + this.#debounceMs };
    }
    return undefined;
  }

  flush(now: number): StreamingAnnouncement | undefined {
    if (!this.#pending || now < this.#pending.dueAt) return undefined;
    const phrase = this.#latestText.slice(this.#announcedBoundary, this.#pending.boundary).trim();
    this.#announcedBoundary = this.#pending.boundary;
    this.#pending = undefined;
    return phrase ? { kind: 'phrase', text: phrase } : undefined;
  }

  delayUntilFlush(now: number): number | undefined {
    return this.#pending ? Math.max(0, this.#pending.dueAt - now) : undefined;
  }
}

export function useStreamingAnnouncement(
  markdown: string,
  streaming: boolean,
  debounceMs = DEFAULT_ANNOUNCEMENT_DEBOUNCE_MS,
): StreamingAnnouncement | undefined {
  const bufferRef = useRef<StreamingAnnouncementBuffer | undefined>(undefined);
  const sourceRef = useRef(markdown);
  const [announcement, setAnnouncement] = useState<StreamingAnnouncement>();

  if (!bufferRef.current) bufferRef.current = new StreamingAnnouncementBuffer(debounceMs);
  sourceRef.current = markdown;

  useEffect(() => {
    const buffer = bufferRef.current!;
    const now = Date.now();
    const immediate = buffer.update(sourceRef.current, streaming, now);
    if (immediate) setAnnouncement(immediate);

    const delay = buffer.delayUntilFlush(now);
    if (delay === undefined || !streaming) return undefined;
    const timer = setTimeout(() => {
      const next = buffer.flush(Date.now());
      if (next) setAnnouncement(next);
    }, delay);
    return () => clearTimeout(timer);
  }, [markdown, streaming]);

  return announcement;
}
