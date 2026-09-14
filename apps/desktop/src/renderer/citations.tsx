import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from 'react';

export interface CitationRecord {
  readonly id: string;
  readonly index?: number;
  readonly title: string;
  readonly source?: string;
  readonly locator?: string;
  readonly excerpt?: string;
  readonly url?: string;
}

export interface CitationActivation {
  readonly id: string;
  readonly citation?: CitationRecord;
  readonly origin: 'marker' | 'list';
}

interface CitationContextValue {
  readonly citations: ReadonlyMap<string, CitationRecord>;
  readonly activate?: (activation: CitationActivation) => void;
}

const CitationContext = createContext<CitationContextValue>({ citations: new Map() });

export interface CitationProviderProps extends PropsWithChildren {
  readonly citations?: readonly CitationRecord[];
  readonly onActivate?: (activation: CitationActivation) => void;
}

export function CitationProvider({ citations = [], onActivate, children }: CitationProviderProps) {
  const citationMap = useMemo(
    () => new Map(citations.map((citation) => [citation.id, citation] as const)),
    [citations],
  );
  const value = useMemo(
    () => ({ citations: citationMap, activate: onActivate }),
    [citationMap, onActivate],
  );
  return <CitationContext.Provider value={value}>{children}</CitationContext.Provider>;
}

export function useCitations(): CitationContextValue {
  return useContext(CitationContext);
}

export function useCitation(id: string) {
  const context = useCitations();
  const citation = context.citations.get(id);
  const activate = useCallback(
    (origin: CitationActivation['origin'] = 'marker') =>
      context.activate?.({ id, citation, origin }),
    [citation, context, id],
  );
  return { citation, activate } as const;
}

export interface CitationMarkerProps {
  readonly id: string;
  readonly children?: ReactNode;
}

export function CitationMarker({ id, children }: CitationMarkerProps) {
  const { citation, activate } = useCitation(id);
  const visibleLabel = children ?? citation?.index ?? '?';
  const spokenLabel =
    citation?.index !== undefined
      ? String(citation.index)
      : typeof children === 'string' || typeof children === 'number' || typeof children === 'bigint'
        ? String(children)
        : id;
  const description = citation
    ? `Citation ${spokenLabel}: ${citation.title}${citation.locator ? `, ${citation.locator}` : ''}`
    : `Citation ${spokenLabel} is unavailable`;

  return (
    <button
      aria-label={description}
      className={`markdown-citation${citation ? '' : ' markdown-citation--missing'}`}
      data-citation-id={id}
      onClick={() => activate('marker')}
      data-tooltip={description}
      type="button"
    >
      <span aria-hidden="true">{visibleLabel}</span>
    </button>
  );
}

export interface CitationListProps {
  readonly className?: string;
}

export function CitationList({ className = '' }: CitationListProps) {
  const { citations, activate } = useCitations();
  if (citations.size === 0) return null;

  const ordered = [...citations.values()].sort(
    (left, right) =>
      (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER),
  );

  return (
    <section
      aria-label="Sources cited in this response"
      className={`markdown-sources ${className}`.trim()}
    >
      <h2>Sources</h2>
      <ol>
        {ordered.map((citation, position) => (
          <li id={`citation-${encodeURIComponent(citation.id)}`} key={citation.id}>
            <button
              className="markdown-source"
              onClick={() => activate?.({ id: citation.id, citation, origin: 'list' })}
              type="button"
            >
              <span className="markdown-source__index">{citation.index ?? position + 1}</span>
              <span className="markdown-source__body">
                <strong>{citation.title}</strong>
                {(citation.source || citation.locator) && (
                  <small>{[citation.source, citation.locator].filter(Boolean).join(' · ')}</small>
                )}
                {citation.excerpt && <span>{citation.excerpt}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
}

const CITATION_TOKEN = /\[\[(?:cite|citation):([^\]|]{1,200})(?:\|([^\]]{1,80}))?\]\]/gi;
const CITATION_SKIP_NODES = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'definition',
  'html',
]);

function citationParts(value: string): MarkdownNode[] | undefined {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  CITATION_TOKEN.lastIndex = 0;

  while ((match = CITATION_TOKEN.exec(value)) !== null) {
    const id = match[1]?.trim();
    if (!id) continue;
    if (match.index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.index) });
    const label = match[2]?.trim() || id;
    nodes.push({
      type: 'link',
      url: `cupcake-citation:${encodeURIComponent(id)}`,
      children: [{ type: 'text', value: label }],
    });
    cursor = match.index + match[0].length;
  }

  if (cursor === 0) return undefined;
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes;
}

function transformCitationNodes(node: MarkdownNode): void {
  if (!node.children || CITATION_SKIP_NODES.has(node.type)) return;

  const transformed: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      transformed.push(...(citationParts(child.value) ?? [child]));
    } else {
      transformCitationNodes(child);
      transformed.push(child);
    }
  }
  node.children = transformed;
}

/** remark plugin for product-owned `[[cite:id|label]]` tokens. */
export function remarkCupcakeCitations() {
  return (tree: MarkdownNode) => transformCitationNodes(tree);
}
