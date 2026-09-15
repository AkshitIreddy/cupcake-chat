import {
  Children,
  createContext,
  isValidElement,
  memo,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import {
  CitationList,
  CitationMarker,
  CitationProvider,
  type CitationActivation,
  type CitationRecord,
  remarkCupcakeCitations,
} from './citations';
import { prepareStreamingMarkdown } from './markdown-stream';
import { useStreamingAnnouncement } from './streaming-announcer';
import { useStreamingText } from './streaming-text';
import './styles-markdown.css';

const CITATION_PROTOCOL = 'cupcake-citation:';
const SAFE_WEB_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

export interface OpenMarkdownLink {
  readonly href: string;
  readonly label: string;
}

export interface RichMarkdownProps {
  readonly children: string;
  readonly className?: string;
  readonly citations?: readonly CitationRecord[];
  readonly streaming?: boolean;
  readonly showCitationList?: boolean;
  readonly allowRemoteImages?: boolean;
  readonly onCitationActivate?: (activation: CitationActivation) => void;
  readonly onOpenLink?: (link: OpenMarkdownLink) => void;
  readonly onCopyCode?: (code: string) => void | Promise<void>;
  readonly onRunPythonTests?: (code: string) => Promise<{ headline: string; output: string }>;
}

const CodeActions = createContext<{
  onCopyCode?: RichMarkdownProps['onCopyCode'];
  onRunPythonTests?: RichMarkdownProps['onRunPythonTests'];
  streaming: boolean;
}>({ streaming: false });

export function safeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(CITATION_PROTOCOL)) return trimmed;
  if (trimmed.startsWith('#') && !/[\r\n]/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (!SAFE_WEB_PROTOCOLS.has(url.protocol)) return '';
    return defaultUrlTransform(trimmed);
  } catch {
    return '';
  }
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return '';
}

function decodeCitationId(href: string): string | undefined {
  if (!href.startsWith(CITATION_PROTOCOL)) return undefined;
  try {
    return decodeURIComponent(href.slice(CITATION_PROTOCOL.length));
  } catch {
    return undefined;
  }
}

function languageFromClassName(className?: string): string {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? '');
  return match?.[1] ?? 'text';
}

function readableLanguage(language: string): string {
  const labels: Readonly<Record<string, string>> = {
    bash: 'Shell',
    css: 'CSS',
    html: 'HTML',
    javascript: 'JavaScript',
    js: 'JavaScript',
    json: 'JSON',
    jsx: 'JSX',
    markdown: 'Markdown',
    md: 'Markdown',
    python: 'Python',
    py: 'Python',
    rust: 'Rust',
    sh: 'Shell',
    ts: 'TypeScript',
    tsx: 'TSX',
    typescript: 'TypeScript',
    yaml: 'YAML',
    yml: 'YAML',
  };
  return labels[language.toLowerCase()] ?? language;
}

interface CodeBlockProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onCopyCode?: RichMarkdownProps['onCopyCode'];
}

function CodeBlock({ children, className, onCopyCode }: CodeBlockProps) {
  const actions = useContext(CodeActions);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ headline: string; output: string } | null>(null);
  const inFlight = useRef(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const code = textFromNode(children).replace(/\n$/, '');
  const language = languageFromClassName(className);
  const label = readableLanguage(language);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      if (onCopyCode) await onCopyCode(code);
      else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(code);
      } else {
        throw new Error('Clipboard is unavailable');
      }
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 1800);
  }, [code, onCopyCode]);

  return (
    <figure className="markdown-code-block">
      <figcaption>
        <span>{label}</span>
        {actions.onRunPythonTests && ['py', 'python'].includes(language.toLowerCase()) && (
          <button
            disabled={actions.streaming || running}
            type="button"
            onClick={() => {
              if (inFlight.current || !actions.onRunPythonTests) return;
              inFlight.current = true;
              setRunning(true);
              setResult(null);
              void actions
                .onRunPythonTests(code)
                .then(setResult)
                .catch((reason: unknown) => {
                  setResult({
                    headline: 'Tests could not run',
                    output: reason instanceof Error ? reason.message : String(reason),
                  });
                })
                .finally(() => {
                  inFlight.current = false;
                  setRunning(false);
                });
            }}
          >
            {running ? 'Running tests…' : 'Run tests'}
          </button>
        )}
        <button aria-label={`Copy ${label} code`} onClick={() => void copy()} type="button">
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </figcaption>
      <pre aria-label={`${label} code example`} tabIndex={0}>
        <code className={className}>{children}</code>
      </pre>
      {(running || result) && (
        <div className="markdown-code-result" role="status">
          <strong>{running ? 'Running in local Python…' : result?.headline}</strong>
          {result?.output && (
            <details open>
              <summary>Python output</summary>
              <pre>{result.output}</pre>
            </details>
          )}
        </div>
      )}
      <span aria-live="polite" className="markdown-sr-only">
        {copyState === 'copied'
          ? 'Code copied to clipboard'
          : copyState === 'failed'
            ? 'Code could not be copied'
            : ''}
      </span>
    </figure>
  );
}

// A stable component type preserves code actions while Markdown grows or
// workspace task events arrive. Inline component factories remounted this tree.
const MarkdownPre: NonNullable<Components['pre']> = ({ children }) => {
  const actions = useContext(CodeActions);
  const child = Children.only(children) as ReactElement<{
    children?: ReactNode;
    className?: string;
  }>;
  return (
    <CodeBlock className={child.props.className} onCopyCode={actions.onCopyCode}>
      {child.props.children}
    </CodeBlock>
  );
};

class HeadingSlugger {
  readonly #seen = new Map<string, number>();

  slug(value: string): string {
    const base =
      value
        .normalize('NFKD')
        .toLocaleLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
        .trim()
        .replace(/[\s_-]+/g, '-') || 'section';
    const count = this.#seen.get(base) ?? 0;
    this.#seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }
}

function createHeading(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  slugger: HeadingSlugger,
): NonNullable<Components[`h${1 | 2 | 3 | 4 | 5 | 6}`]> {
  const Heading = `h${level}` as const;
  return function MarkdownHeading({ children, node, ...props }) {
    void node;
    const id = slugger.slug(textFromNode(children));
    return (
      <Heading {...props} id={id} tabIndex={-1}>
        {children}
        <a
          aria-label={`Link to ${textFromNode(children)}`}
          className="markdown-heading-link"
          href={`#${id}`}
        >
          <span aria-hidden="true">#</span>
        </a>
      </Heading>
    );
  };
}

function makeComponents(
  slugger: HeadingSlugger,
  options: Pick<RichMarkdownProps, 'allowRemoteImages' | 'onCopyCode' | 'onOpenLink'>,
): Components {
  return {
    h1: createHeading(1, slugger),
    h2: createHeading(2, slugger),
    h3: createHeading(3, slugger),
    h4: createHeading(4, slugger),
    h5: createHeading(5, slugger),
    h6: createHeading(6, slugger),
    a({ children, href = '', node, ...props }) {
      void node;
      const citationId = decodeCitationId(href);
      if (citationId) return <CitationMarker id={citationId}>{children}</CitationMarker>;

      const safeHref = safeMarkdownUrl(href);
      if (!safeHref) return <span className="markdown-link--blocked">{children}</span>;

      const label = textFromNode(children) || safeHref;
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (safeHref.startsWith('#')) {
          document.getElementById(safeHref.slice(1))?.scrollIntoView({ block: 'start' });
          return;
        }
        options.onOpenLink?.({ href: safeHref, label });
      };
      return (
        <a
          {...props}
          aria-disabled={!safeHref.startsWith('#') && !options.onOpenLink}
          href={safeHref}
          onClick={handleClick}
          rel="noreferrer noopener"
        >
          {children}
          {!safeHref.startsWith('#') && (
            <span className="markdown-external-mark" aria-hidden="true">
              ↗
            </span>
          )}
        </a>
      );
    },
    img({ alt = '', src = '', node }) {
      void node;
      const safeSource = safeMarkdownUrl(src);
      if (options.allowRemoteImages && safeSource.startsWith('https:')) {
        return (
          <img
            alt={alt}
            className="markdown-remote-image"
            crossOrigin="anonymous"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={safeSource}
          />
        );
      }
      return (
        <span className="markdown-image-placeholder" role="note">
          <span aria-hidden="true">▧</span> Image not loaded{alt ? `: ${alt}` : ''}
        </span>
      );
    },
    code({ children, className, node, ...props }) {
      void node;
      return (
        <code {...props} className={className}>
          {children}
        </code>
      );
    },
    pre: MarkdownPre,
    table({ children, node, ...props }) {
      void node;
      return (
        <div
          aria-label="Scrollable data table"
          className="markdown-table-wrap"
          role="region"
          tabIndex={0}
        >
          <table {...props}>{children}</table>
        </div>
      );
    },
    input({ type, node, ...props }) {
      void node;
      if (type === 'checkbox') {
        return (
          <input
            {...props}
            aria-label={props.checked ? 'Completed task' : 'Incomplete task'}
            disabled
            type="checkbox"
          />
        );
      }
      return <input {...props} type={type} />;
    },
  };
}

export const RichMarkdown = memo(function RichMarkdown({
  children,
  className = '',
  citations = [],
  streaming = false,
  showCitationList = true,
  allowRemoteImages = false,
  onCitationActivate,
  onOpenLink,
  onCopyCode,
  onRunPythonTests,
}: RichMarkdownProps) {
  const visible = useStreamingText(children, streaming);
  const revealing = streaming || visible !== children;
  const prepared = useMemo(
    () => prepareStreamingMarkdown(visible, revealing),
    [visible, revealing],
  );
  const slugger = useMemo(() => new HeadingSlugger(), [prepared.markdown]);
  const components = useMemo(
    () => makeComponents(slugger, { allowRemoteImages, onCopyCode, onOpenLink }),
    [allowRemoteImages, onCopyCode, onOpenLink, slugger],
  );
  const announcement = useStreamingAnnouncement(children, streaming);

  return (
    <CitationProvider citations={citations} onActivate={onCitationActivate}>
      <CodeActions.Provider value={{ onCopyCode, onRunPythonTests, streaming: revealing }}>
        <div
          aria-busy={revealing || undefined}
          className={`rich-markdown ${revealing ? 'rich-markdown--streaming' : ''} ${className}`.trim()}
          data-stream-completions={prepared.completions
            .map((completion) => completion.kind)
            .join(' ')}
        >
          <Markdown
            components={components}
            rehypePlugins={[
              [rehypeHighlight, { detect: false, ignoreMissing: true }],
              [
                rehypeKatex,
                { output: 'htmlAndMathml', strict: 'warn', throwOnError: false, trust: false },
              ],
            ]}
            remarkPlugins={[remarkGfm, remarkMath, remarkCupcakeCitations]}
            skipHtml
            urlTransform={safeMarkdownUrl}
          >
            {prepared.markdown}
          </Markdown>
          <span
            aria-atomic="true"
            aria-live="polite"
            className="markdown-sr-only"
            data-announcement-kind={announcement?.kind}
            role="status"
          >
            {announcement?.text ?? ''}
          </span>
          {showCitationList && <CitationList />}
        </div>
      </CodeActions.Provider>
    </CitationProvider>
  );
});
