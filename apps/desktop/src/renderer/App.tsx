import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  artifacts as fixtureArtifacts,
  conversations as initialConversations,
  memories as initialMemories,
  models as initialModels,
  tasks as initialTasks,
  tools as initialTools,
} from './data';
import { Icon, type IconName } from './icons';
import { RichMarkdown } from './RichMarkdown';
import type {
  Conversation,
  LiveChatMessage,
  MemoryRecord,
  ModelDescriptor,
  Task,
  Theme,
  ToolDescriptor,
  View,
} from './types';
import {
  WorkspaceProvider,
  useWorkspace,
  type ArtifactRecord,
  type AttachmentRecord,
  type MessageRecord,
  type ReasoningEffort,
  type ReferenceRecord,
  type SearchRecord,
  type ToolActivity,
} from './workspace';

const navItems: { id: View; label: string; icon: IconName; shortcut?: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'chats', label: 'Chats', icon: 'chat' },
  { id: 'projects', label: 'Projects', icon: 'project' },
  { id: 'tasks', label: 'Tasks', icon: 'task' },
  { id: 'artifacts', label: 'Artifacts', icon: 'artifact' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'models', label: 'Models', icon: 'model' },
  { id: 'tools', label: 'Tools', icon: 'tool' },
  { id: 'search', label: 'Search', icon: 'search', shortcut: 'Ctrl⇧F' },
];

const pageTitles: Partial<Record<View, string>> = {
  chats: 'Conversations',
  projects: 'Projects',
  tasks: 'Tasks',
  artifacts: 'Artifacts',
  memory: 'Memory',
  models: 'Models',
  tools: 'Tools',
  search: 'Search',
  settings: 'Settings',
  developer: 'Developer mode',
  about: 'About Cupcake',
};

const providerIdByName: Record<string, string> = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Google: 'google',
  xAI: 'xai',
  Mistral: 'mistral',
  Cohere: 'cohere',
  'NVIDIA NIM': 'nvidia-nim',
};

interface RuntimeMemoryRecord {
  id: string;
  key: string;
  content: string;
  kind: string;
  state: string;
  confidence: number;
  scope: { kind: string; project_id?: string | null };
}

interface RuntimeTaskRecord {
  run_id: string;
  status: string;
  current_step: number;
  spec: {
    title: string;
    prompt: string;
    project_id?: string | null;
    steps: Array<{ key: string }>;
  };
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}
function cap(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function initialView(): View {
  const candidate = new URLSearchParams(window.location.search).get('view');
  const allowed: View[] = [
    'home',
    'chats',
    'chat',
    'projects',
    'tasks',
    'task',
    'artifacts',
    'memory',
    'models',
    'tools',
    'search',
    'settings',
    'developer',
    'about',
  ];
  return allowed.includes(candidate as View) ? (candidate as View) : 'home';
}
function initialTheme(): Theme {
  const requested = new URLSearchParams(window.location.search).get('theme');
  if (
    requested === 'light' ||
    requested === 'dark' ||
    requested === 'minimal' ||
    requested === 'classic'
  )
    return requested;
  const stored = localStorage.getItem('cupcake-theme');
  return stored === 'dark' || stored === 'minimal' || stored === 'classic' ? stored : 'light';
}

function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={cx('brand', large && 'brand--large')}>
      <img src="/brand/cupcake-mark.svg" alt="" className="brand__mark" />
      <div>
        <strong>CUPCAKE</strong>
        <span>AGI</span>
      </div>
      {large && <small>2.0 preview</small>}
    </div>
  );
}

function RouteBadge({ route }: { route: 'Cloud' | 'Local' }) {
  return (
    <span className={cx('route-badge', route === 'Local' && 'route-badge--local')}>
      <Icon name={route === 'Local' ? 'local' : 'cloud'} size={12} />
      {route}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={cx('status-dot', `status-dot--${status}`)} aria-hidden="true" />;
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={cx('toggle', checked && 'is-on')}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__illustration">
        <Icon name={icon} size={26} />
        <i />
        <i />
        <i />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action && (
        <button className="button button--primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function Shelf({
  view,
  setView,
  developerMode,
  mobileOpen,
  closeMobile,
  conversations,
  onNewChat,
  onSelectConversation,
}: {
  view: View;
  setView: (v: View) => void;
  developerMode: boolean;
  mobileOpen: boolean;
  closeMobile: () => void;
  conversations: Conversation[];
  onNewChat?: () => void;
  onSelectConversation?: (id: string) => void;
}) {
  const navigate = (v: View) => {
    setView(v);
    closeMobile();
  };
  return (
    <aside
      className={cx('shelf', mobileOpen && 'is-mobile-open')}
      aria-label="Primary"
      tabIndex={-1}
    >
      <div className="shelf__top">
        <Brand />
        <button
          className="icon-button shelf__close"
          onClick={closeMobile}
          aria-label="Close navigation"
        >
          <Icon name="x" />
        </button>
      </div>
      <button className="new-chat" onClick={() => (onNewChat ? onNewChat() : navigate('chat'))}>
        <span>
          <Icon name="plus" size={17} />
          New chat
        </span>
        <kbd>Ctrl N</kbd>
      </button>
      <nav className="shelf__nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={cx(
              'nav-item',
              (view === item.id ||
                (view === 'chat' && item.id === 'chats') ||
                (view === 'task' && item.id === 'tasks')) &&
                'is-active',
            )}
            onClick={() => navigate(item.id)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.id === 'tasks' && <em>2</em>}
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ))}
      </nav>
      <div className="shelf__recent">
        <div className="shelf-label">Recent</div>
        {conversations.slice(0, 3).map((chat) => (
          <button
            key={chat.id}
            onClick={() =>
              onSelectConversation ? onSelectConversation(chat.id) : navigate('chat')
            }
          >
            <span>{chat.title}</span>
            {chat.unread && <i />}
          </button>
        ))}
      </div>
      <div className="shelf__bottom">
        {developerMode && (
          <button
            className={cx('nav-item', view === 'developer' && 'is-active')}
            onClick={() => navigate('developer')}
          >
            <Icon name="code" />
            <span>Developer mode</span>
            <em className="live-badge">LIVE</em>
          </button>
        )}
        <button
          className={cx('nav-item', view === 'settings' && 'is-active')}
          onClick={() => navigate('settings')}
        >
          <Icon name="settings" />
          <span>Settings</span>
        </button>
        <button className="profile-row" onClick={() => navigate('about')}>
          <span className="avatar">AI</span>
          <span>
            <strong>Akshit</strong>
            <small>Local profile</small>
          </span>
          <Icon name="more" />
        </button>
      </div>
    </aside>
  );
}

function Topbar({
  view,
  onMenu,
  onCommand,
  onNewChat,
  offline,
  children,
}: {
  view: View;
  onMenu: () => void;
  onCommand: () => void;
  onNewChat: () => void;
  offline: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <button className="icon-button mobile-menu" onClick={onMenu} aria-label="Open navigation">
        <Icon name="menu" />
      </button>
      <div className="topbar__title">
        <h1>{pageTitles[view] ?? (view === 'task' ? 'Task detail' : 'Cupcake')}</h1>
        {offline && (
          <span className="offline-pill">
            <StatusDot status="offline" />
            Offline mode
          </span>
        )}
      </div>
      <div className="topbar__actions">
        {children}
        <button className="command-trigger" onClick={onCommand} aria-label="Open command palette">
          <Icon name="command" size={15} />
          <span>Commands</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="icon-button" onClick={onNewChat} aria-label="New chat">
          <Icon name="edit" />
        </button>
      </div>
    </header>
  );
}

function Greeting() {
  const hour = new Date().getHours();
  return <>{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, Akshit.</>;
}

function HomeView({
  openChat,
  openTask,
  setView,
  composer,
  proactiveEnabled,
  conversations,
}: {
  openChat: () => void;
  openTask: () => void;
  setView: (v: View) => void;
  composer: ReactNode;
  proactiveEnabled: boolean;
  conversations: Conversation[];
}) {
  const workspace = useWorkspace();
  const workingTask = workspace.tasks.find(
    (task) => task.status === 'working' || task.status === 'waiting',
  );
  return (
    <main className="page page--home">
      <section className="home-hero">
        <div className="home-hero__mascot">
          <img src="/brand/cupcake-2-grown.png" alt="Grown CUPCAKEAGI 2.0 mascot" />
          <span />
        </div>
        <p className="eyebrow">Your workbench is ready</p>
        <h1>
          <Greeting />
        </h1>
        <p>What would you like to make sense of?</p>
        <div className="home-composer">{composer}</div>
      </section>
      <div className="home-grid">
        <section className="home-section home-section--continue">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Pick up a thread</span>
              <h2>Continue</h2>
            </div>
            <button className="text-button" onClick={() => setView('chats')}>
              All chats <Icon name="chevron" size={14} />
            </button>
          </div>
          <div className="continue-list">
            {conversations.slice(0, 3).map((c, i) => (
              <button onClick={openChat} key={c.id} className="continue-card">
                <span className={cx('continue-card__index', i === 0 && 'is-berry')}>{i + 1}</span>
                <span>
                  <strong>{c.title}</strong>
                  <small>{c.preview}</small>
                </span>
                <time>{c.updated}</time>
                <Icon name="arrow" />
              </button>
            ))}
          </div>
        </section>
        <section className="home-section home-section--working">
          <div className="section-heading">
            <div>
              <span className="eyebrow">In the oven</span>
              <h2>Working</h2>
            </div>
            <button className="text-button" onClick={() => setView('tasks')}>
              All tasks <Icon name="chevron" size={14} />
            </button>
          </div>
          {workingTask ? (
            <button className="working-card" onClick={openTask}>
              <div className="task-orbit">
                <span>{workingTask.progress}</span>
                <svg viewBox="0 0 42 42">
                  <circle cx="21" cy="21" r="17" />
                  <circle className="progress-ring" cx="21" cy="21" r="17" pathLength="100" />
                </svg>
              </div>
              <div>
                <div className="working-card__title">
                  <StatusDot status="working" />
                  <strong>{workingTask.title}</strong>
                </div>
                <p>{workingTask.detail}</p>
                <small>
                  {workingTask.project} · {workingTask.elapsed}
                </small>
              </div>
              <Icon name="chevron" />
            </button>
          ) : (
            <EmptyState
              icon="task"
              title="Nothing working right now"
              body="Long work appears here after it becomes a durable task."
            />
          )}
          {proactiveEnabled && (
            <div className="notice-card">
              <Icon name="sparkle" />
              <div>
                <strong>Cupcake noticed…</strong>
                <p>The local runtime comparison still has one unanswered benchmark.</p>
              </div>
              <button
                aria-label="Dismiss"
                onClick={() => void workspace.updateSettings({ proactiveEnabled: false })}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
        </section>
        <section className="home-section home-section--projects">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Rooms with context</span>
              <h2>Projects</h2>
            </div>
            <button className="text-button" onClick={() => setView('projects')}>
              All projects <Icon name="chevron" size={14} />
            </button>
          </div>
          <div className="project-mini-grid">
            {workspace.projects.slice(0, 2).map((project, index) => (
              <button
                onClick={() => {
                  void workspace.setActiveProject(project.id);
                  setView('projects');
                }}
                key={project.id}
              >
                <span className={`project-sigil ${index ? 'green' : 'berry'}`}>
                  {project.name
                    .split(/\s+/)
                    .map((part) => part[0])
                    .join('')
                    .slice(0, 2)}
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>
                    {workspace.conversations.filter((item) => item.project === project.name).length}{' '}
                    chats ·{' '}
                    {workspace.artifacts.filter((item) => item.projectId === project.id).length}{' '}
                    artifacts
                  </small>
                </span>
              </button>
            ))}
            <button className="project-add" onClick={() => setView('projects')}>
              <Icon name="plus" />
              <span>New project</span>
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function Composer({
  onSend,
  compact = false,
  onModel,
  selectedModel,
  offline,
}: {
  onSend: (input: {
    content: string;
    attachments: AttachmentRecord[];
    references: ReferenceRecord[];
    reasoningEffort: ReasoningEffort;
    enabledToolIds: string[];
    outboundConfirmationToken?: string;
  }) => void;
  compact?: boolean;
  onModel: () => void;
  selectedModel: ModelDescriptor;
  offline: boolean;
}) {
  const workspace = useWorkspace();
  const supportedReasoning = selectedModel.reasoningPresets?.length
    ? selectedModel.reasoningPresets
    : workspace.fixtureMode
      ? (['none', 'low', 'medium', 'high'] as ReasoningEffort[])
      : (['none'] as ReasoningEffort[]);
  const [value, setValue] = useState('');
  const [reference, setReference] = useState(false);
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [pendingDisclosure, setPendingDisclosure] = useState<null | {
    input: {
      content: string;
      attachments: AttachmentRecord[];
      references: ReferenceRecord[];
      reasoningEffort: ReasoningEffort;
      enabledToolIds: string[];
    };
    confirmationToken: string;
    disclosure: { privacyRoute?: string; costClass?: string };
  }>(null);
  const [disclosureError, setDisclosureError] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const clean = value.trim();
    if (!clean && attachments.length === 0) return;
    if (offline && selectedModel.route === 'Cloud') return;
    const input = {
      content: clean || 'Please review the attached file.',
      attachments,
      references,
      reasoningEffort: supportedReasoning.includes(workspace.settings.reasoningEffort)
        ? workspace.settings.reasoningEffort
        : supportedReasoning[0]!,
      enabledToolIds: workspace.settings.enabledToolIds,
    };
    const requiresDisclosure = selectedModel.route === 'Cloud';
    if (requiresDisclosure && !workspace.fixtureMode) {
      setDisclosureError('');
      void workspace
        .preflightCloudDisclosure({
          content: input.content,
          modelId: selectedModel.runtimeModelId ?? selectedModel.id,
          attachments,
          references,
        })
        .then((result) => setPendingDisclosure({ input, ...result }))
        .catch((reason) =>
          setDisclosureError(
            reason instanceof Error ? reason.message : 'Disclosure preflight failed',
          ),
        );
      return;
    }
    onSend(input);
    setValue('');
    setAttachments([]);
    setReferences([]);
    setReference(false);
  };
  const attach = async () => {
    const files = await window.cupcake?.dialog.openFiles({
      title: 'Attach files to this conversation',
      multiple: true,
    });
    if (files?.length)
      setAttachments((current) => [
        ...current,
        ...files.map((file): AttachmentRecord => ({
          handleId: file.id,
          name: file.name,
          size: file.size,
          extension: file.extension,
          destination:
            selectedModel.route === 'Cloud' && !offline ? ('cloud' as const) : ('local' as const),
        })),
      ]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
    if (event.key === '@') setReference(true);
  };
  const referenceOptions: ReferenceRecord[] = workspace.fixtureMode
    ? [
        { id: 'fixture-file', type: 'artifact', label: 'architecture.md' },
        { id: 'fixture-cupcake', type: 'project', label: 'Cupcake 2.0' },
        { id: 'fixture-task', type: 'task', label: 'Repository redesign' },
      ]
    : [
        ...workspace.projects.map((item) => ({
          id: item.id,
          type: 'project' as const,
          label: item.name,
        })),
        ...workspace.tasks.map((item) => ({
          id: item.id,
          type: 'task' as const,
          label: item.title,
        })),
        ...workspace.artifacts.map((item) => ({
          id: item.id,
          type: 'artifact' as const,
          label: item.name,
        })),
        ...workspace.memories.map((item) => ({
          id: item.id,
          type: 'memory' as const,
          label: item.title,
        })),
      ];
  useEffect(() => {
    const focus = () => textRef.current?.focus();
    const requestAttach = () => void attach();
    window.addEventListener('cupcake:focus-composer', focus);
    window.addEventListener('cupcake:attach', requestAttach);
    return () => {
      window.removeEventListener('cupcake:focus-composer', focus);
      window.removeEventListener('cupcake:attach', requestAttach);
    };
  }, []);
  return (
    <div className={cx('composer', compact && 'composer--compact')}>
      {reference && (
        <div className="reference-popover">
          <span>Reference</span>
          {referenceOptions.slice(0, 12).map((item) => (
            <button
              key={`${item.type}:${item.id}`}
              onClick={() => {
                setValue((v) => `${v}${item.label} `);
                setReferences((current) =>
                  current.some((entry) => entry.id === item.id) ? current : [...current, item],
                );
                setReference(false);
              }}
            >
              <Icon
                name={
                  item.type === 'artifact'
                    ? 'file'
                    : item.type === 'project'
                      ? 'project'
                      : item.type === 'memory'
                        ? 'memory'
                        : 'task'
                }
              />
              {item.label}
              <small>{cap(item.type)} · opaque ID</small>
            </button>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((file) => (
            <span key={file.handleId}>
              <Icon name="file" />
              {file.name}
              <RouteBadge route={file.destination === 'cloud' ? 'Cloud' : 'Local'} />
              <button
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  setAttachments((items) =>
                    items.filter((item) => item.handleId !== file.handleId),
                  );
                  void window.cupcake?.dialog.releaseHandle(file.handleId);
                }}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={compact ? 2 : 3}
        aria-label="Message Cupcake"
        placeholder={
          compact
            ? 'Ask a follow-up…'
            : 'Message Cupcake — add files or type @ to reference your work'
        }
      />
      <div className="composer__footer">
        <div className="composer__tools">
          <button
            className="icon-button"
            aria-label="Attach file"
            title="Attach file"
            onClick={() => void attach()}
          >
            <Icon name="paperclip" />
          </button>
          <span className="composer-chip" title={workspace.settings.enabledToolIds.join(', ')}>
            <Icon name="tool" size={14} />
            {workspace.settings.enabledToolIds.length} tools
          </span>
          <span className="composer-chip" title="Active privacy boundary">
            <Icon name="project" size={14} />
            {workspace.projects.find((project) => project.id === workspace.activeProjectId)?.name ??
              'No project'}
          </span>
        </div>
        <div className="composer__send">
          <button className="model-chip" onClick={onModel}>
            <span className="provider-mark">O</span>
            <span>
              {offline && selectedModel.route !== 'Local'
                ? 'Choose a local model'
                : selectedModel.name}
            </span>
            <Icon name="chevron" size={13} />
          </button>
          <button
            className="reason-chip"
            onClick={() => {
              const current = supportedReasoning.includes(workspace.settings.reasoningEffort)
                ? workspace.settings.reasoningEffort
                : supportedReasoning[0]!;
              const next =
                supportedReasoning[
                  (supportedReasoning.indexOf(current) + 1) % supportedReasoning.length
                ]!;
              void workspace.updateSettings({ reasoningEffort: next });
            }}
            aria-label="Change reasoning effort"
            disabled={supportedReasoning.length < 2}
          >
            {cap(
              supportedReasoning.includes(workspace.settings.reasoningEffort)
                ? workspace.settings.reasoningEffort
                : supportedReasoning[0]!,
            )}
          </button>
          <button
            className="send-button"
            onClick={send}
            disabled={
              (!value.trim() && attachments.length === 0) ||
              (offline && selectedModel.route === 'Cloud')
            }
            aria-label="Send message"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
      {!compact && (
        <div className="composer__hint">
          <RouteBadge route={offline ? 'Local' : selectedModel.route} />
          <span>
            {offline
              ? 'Everything in this message stays on your computer.'
              : `Message content may be sent to ${selectedModel.provider}.`}
          </span>
          <span className="composer__keys">
            <kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> newline
          </span>
        </div>
      )}
      {offline && selectedModel.route === 'Cloud' && (
        <p className="field-error" role="alert">
          Offline mode blocks cloud sends. Choose a local model to continue.
        </p>
      )}
      {disclosureError && (
        <p className="field-error" role="alert">
          {disclosureError}
        </p>
      )}
      {pendingDisclosure && (
        <div className="popover-layer">
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm cloud destination"
          >
            <header>
              <div>
                <span className="eyebrow">Point-of-use confirmation</span>
                <h2>Send this context to {selectedModel.provider}?</h2>
              </div>
            </header>
            <div className="security-note">
              <Icon name="cloud" />
              <div>
                <strong>
                  {selectedModel.name} ·{' '}
                  {pendingDisclosure.disclosure.privacyRoute ?? 'Cloud privacy route'} ·{' '}
                  {pendingDisclosure.disclosure.costClass ?? selectedModel.cost}
                </strong>
                <p>
                  This one-use confirmation is bound to the exact provider, model, files,
                  references, memories, and tools below. Changing them requires another
                  confirmation.
                </p>
              </div>
            </div>
            <dl className="permission-list">
              <div>
                <dt>Files</dt>
                <dd>
                  {pendingDisclosure.input.attachments.length
                    ? pendingDisclosure.input.attachments.map((item) => item.name).join(', ')
                    : 'None'}
                </dd>
              </div>
              <div>
                <dt>References</dt>
                <dd>
                  {pendingDisclosure.input.references.length
                    ? pendingDisclosure.input.references
                        .map((item) => `${item.type}: ${item.label}`)
                        .join(', ')
                    : 'None'}
                </dd>
              </div>
              <div>
                <dt>Memories</dt>
                <dd>
                  {workspace.memories
                    .filter((item) => item.enabled)
                    .map((item) => item.title)
                    .join(', ') || 'None'}
                </dd>
              </div>
              <div>
                <dt>Tools</dt>
                <dd>
                  {workspace.tools
                    .filter((item) => pendingDisclosure.input.enabledToolIds.includes(item.id))
                    .map((item) => item.name)
                    .join(', ') || 'None'}
                </dd>
              </div>
            </dl>
            <footer>
              <button className="button" onClick={() => setPendingDisclosure(null)}>
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                onClick={() => {
                  onSend({
                    ...pendingDisclosure.input,
                    outboundConfirmationToken: pendingDisclosure.confirmationToken,
                  });
                  setPendingDisclosure(null);
                  setValue('');
                  setAttachments([]);
                  setReferences([]);
                }}
              >
                Confirm one send
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function ChatsView({
  onOpen,
  onCreate,
  onRename,
  onArchive,
  conversations,
}: {
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  conversations: Conversation[];
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'pinned' | 'archived'>('all');
  const shown = conversations.filter(
    (c) =>
      (tab === 'all' || (tab === 'pinned' ? c.pinned : c.archived)) &&
      `${c.title} ${c.preview}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Every conversation, still connected</p>
          <h2>Your chats</h2>
          <p>Pick up where you left off, or branch in a new direction.</p>
        </div>
        <button className="button button--primary" onClick={onCreate}>
          <Icon name="plus" />
          New chat
        </button>
      </div>
      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
        </div>
        <div className="segmented">
          {(['all', 'pinned', 'archived'] as const).map((t) => (
            <button className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)} key={t}>
              {cap(t)}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <div className="chat-list">
          {shown.map((c, i) => (
            <article className="chat-list__row" key={c.id}>
              <button className="chat-list__main" onClick={() => onOpen(c.id)}>
                <span
                  className={cx('chat-list__glyph', i % 3 === 1 && 'green', i % 3 === 2 && 'blue')}
                >
                  <Icon name="chat" />
                </span>
                <span>
                  <strong>{c.title}</strong>
                  <small>{c.preview}</small>
                  <em>{c.project ?? 'No project'}</em>
                </span>
              </button>
              <time>{c.updated}</time>
              {c.pinned && <Icon name="pin" size={14} />}
              <button
                className="icon-button"
                aria-label={`Rename ${c.title}`}
                title="Rename"
                onClick={() => {
                  const title = window.prompt('Rename conversation', c.title)?.trim();
                  if (title) onRename(c.id, title);
                }}
              >
                <Icon name="edit" />
              </button>
              <button
                className="icon-button"
                aria-label={`${c.archived ? 'Restore' : 'Archive'} ${c.title}`}
                title={c.archived ? 'Restore' : 'Archive'}
                onClick={() => onArchive(c.id, !c.archived)}
              >
                <Icon name={c.archived ? 'retry' : 'trash'} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="search"
          title="No conversations here"
          body="Try a broader search, or start with a fresh tray."
          action="Start a new chat"
          onAction={onCreate}
        />
      )}
    </main>
  );
}

function MessageActions({
  user = false,
  message,
  onCopy,
  onRetry,
  onEdit,
  onBranch,
  onContinue,
}: {
  user?: boolean;
  message?: MessageRecord;
  onCopy?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onBranch?: () => void;
  onContinue?: () => void;
}) {
  return (
    <div className="message-actions" aria-label="Message actions">
      <button title="Copy" onClick={onCopy} disabled={!message && !onCopy}>
        <Icon name="copy" />
      </button>
      {!user && (
        <button title="Retry" onClick={onRetry} disabled={!onRetry}>
          <Icon name="retry" />
        </button>
      )}
      <button title="Edit" onClick={onEdit} disabled={!onEdit}>
        <Icon name="edit" />
      </button>
      <button title="Branch" onClick={onBranch} disabled={!onBranch}>
        <Icon name="branch" />
      </button>
      {!user && onContinue && (
        <button title="Continue" onClick={onContinue}>
          <Icon name="play" />
        </button>
      )}
    </div>
  );
}

function ToolCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('tool-card', open && 'is-open')}>
      <button
        className="tool-card__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-card__icon">
          <Icon name="search" />
        </span>
        <span>
          <strong>Searched 6 sources</strong>
          <small>Web research · 4.2 seconds</small>
        </span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="tool-card__details">
          <div>
            <span>Query</span>
            <code>durable local-first agent task architecture 2026</code>
          </div>
          <div>
            <span>Sources</span>
            <ul>
              <li>DBOS workflow recovery documentation</li>
              <li>SQLite WAL and FTS5 reference</li>
              <li>Electron security checklist</li>
            </ul>
          </div>
          <button className="text-button">
            Open complete result <Icon name="external" />
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalCard() {
  const [state, setState] = useState<'ask' | 'allowed' | 'denied'>('ask');
  if (state !== 'ask')
    return (
      <div className={cx('approval-card', `is-${state}`)}>
        <Icon name={state === 'allowed' ? 'check' : 'x'} />
        <div>
          <strong>{state === 'allowed' ? 'Access allowed once' : 'Access denied'}</strong>
          <p>
            {state === 'allowed'
              ? 'Cupcake can read the selected folder for this step.'
              : 'The task continued without reading the folder.'}
          </p>
        </div>
      </div>
    );
  return (
    <div className="approval-card">
      <Icon name="shield" />
      <div className="approval-card__body">
        <span className="eyebrow">Your approval is needed</span>
        <strong>Read the project folder?</strong>
        <p>
          Cupcake wants to read 34 files in <b>Cupcake 2.0</b>. Nothing will be changed.
        </p>
        <div className="approval-resource">
          <Icon name="folder" />
          <span>
            <strong>Desktop / Code Palace / Cupcakeagi</strong>
            <small>Local · read only · this task</small>
          </span>
        </div>
        <div className="approval-card__actions">
          <button className="button button--primary" onClick={() => setState('allowed')}>
            Allow once
          </button>
          <button className="button" onClick={() => setState('denied')}>
            Not now
          </button>
          <button className="text-button">Always allow for this project</button>
        </div>
      </div>
    </div>
  );
}

function ArtifactInline({ openArtifacts }: { openArtifacts: () => void }) {
  return (
    <button className="artifact-inline" onClick={openArtifacts}>
      <span className="artifact-inline__page">
        <Icon name="artifact" />
        <i />
        <i />
        <i />
      </span>
      <span>
        <span className="eyebrow">Artifact · Document</span>
        <strong>CUPCAKEAGI architecture.md</strong>
        <small>18.4 KB · 4 revisions · just now</small>
      </span>
      <span className="artifact-inline__open">
        Open <Icon name="chevron" />
      </span>
    </button>
  );
}

function TaskInline({ openTask }: { openTask: () => void }) {
  return (
    <button className="task-inline" onClick={openTask}>
      <div className="task-orbit task-orbit--small">
        <span>68</span>
        <svg viewBox="0 0 42 42">
          <circle cx="21" cy="21" r="17" />
          <circle className="progress-ring" cx="21" cy="21" r="17" pathLength="100" />
        </svg>
      </div>
      <span>
        <span className="eyebrow">Working in the background</span>
        <strong>Repository redesign</strong>
        <small>Comparing persistence options · 12m 41s</small>
      </span>
      <Icon name="chevron" />
    </button>
  );
}

function RuntimeToolActivityCard({ activity }: { activity: ToolActivity }) {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const needsApproval =
    activity.type === 'approval' && !['approved', 'denied'].includes(activity.status);
  return (
    <div className={cx('tool-card', open && 'is-open', needsApproval && 'approval-card')}>
      <button
        className="tool-card__summary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-card__icon">
          <Icon name={needsApproval ? 'shield' : 'tool'} />
        </span>
        <span>
          <strong>{activity.toolName}</strong>
          <small>
            {activity.summary} · {activity.status}
          </small>
        </span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="tool-card__details">
          <div>
            <span>Broker status</span>
            <code>{activity.status}</code>
          </div>
          <div>
            <span>Redacted payload</span>
            <code>{JSON.stringify(activity.payload ?? {}, null, 2)}</code>
          </div>
          {needsApproval && (
            <div className="approval-card__actions">
              <button
                className="button button--primary"
                onClick={() => void workspace.resolveApproval(activity, true)}
              >
                Allow once
              </button>
              <button
                className="button"
                onClick={() => void workspace.resolveApproval(activity, false)}
              >
                Deny
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveConversation({ selectedModel }: { selectedModel: ModelDescriptor }) {
  const workspace = useWorkspace();
  const [windowEnd, setWindowEnd] = useState(workspace.messages.length);
  const [streamAnnouncement, setStreamAnnouncement] = useState('');
  const windowSize = 80;
  useEffect(() => setWindowEnd(workspace.messages.length), [workspace.messages.length]);
  useEffect(() => {
    const latest = [...workspace.messages].reverse().find((message) => message.streaming);
    if (!latest) {
      setStreamAnnouncement('');
      return;
    }
    const timer = window.setTimeout(() => setStreamAnnouncement(latest.content.slice(-180)), 300);
    return () => window.clearTimeout(timer);
  }, [workspace.messages]);
  const start = Math.max(0, windowEnd - windowSize);
  const visible = workspace.messages.slice(start, windowEnd);
  const outlineStep = Math.max(1, Math.ceil(workspace.messages.length / 60));
  const outline = workspace.messages.filter(
    (_, index) => index % outlineStep === 0 || index === workspace.messages.length - 1,
  );
  const runAction = (
    message: MessageRecord,
    mode: 'retry' | 'edit' | 'regenerate' | 'continue',
  ) => {
    let content = message.content;
    if (mode === 'edit') {
      const edited = window.prompt('Edit message and create a sibling branch', content)?.trim();
      if (!edited) return;
      content = edited;
    }
    void workspace.sendMessage({
      content: mode === 'continue' ? 'Continue from the previous response.' : content,
      modelId: selectedModel.runtimeModelId ?? selectedModel.id,
      attachments: message.attachments ?? [],
      reasoningEffort: workspace.settings.reasoningEffort,
      enabledToolIds: workspace.settings.enabledToolIds,
      mode,
      messageId: message.id,
    });
  };
  if (!workspace.activeConversationId && workspace.messages.length === 0) {
    return (
      <div className="conversation">
        <EmptyState
          icon="chat"
          title="Start a new thread"
          body="This conversation is empty. Your first message creates its immutable main branch."
        />
      </div>
    );
  }
  return (
    <div className="conversation live-conversation" data-rendered-messages={visible.length}>
      <div className="markdown-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {streamAnnouncement}
      </div>
      {workspace.branches.length > 1 && (
        <div className="branch-banner">
          <Icon name="branch" />
          <span>{workspace.branches.length} immutable branches</span>
          <div className="branch-nav">
            {workspace.branches.map((branch) => (
              <button
                key={branch.id}
                className={workspace.activeBranchId === branch.id ? 'is-active' : ''}
                onClick={() => void workspace.selectBranch(branch.id)}
              >
                {branch.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {start > 0 && (
        <button
          className="button frosting-load"
          onClick={() => setWindowEnd(Math.max(windowSize, windowEnd - windowSize))}
        >
          Show messages {Math.max(1, start - windowSize + 1)}–{start}
        </button>
      )}
      {windowEnd < workspace.messages.length && (
        <button
          className="button frosting-load"
          onClick={() => setWindowEnd(Math.min(workspace.messages.length, windowEnd + windowSize))}
        >
          Show newer messages
        </button>
      )}
      {visible.map((message) => (
        <article
          className={cx('turn', message.role === 'user' ? 'turn--user' : 'turn--assistant')}
          key={message.id}
          id={`message-${message.id}`}
        >
          <div
            className={cx(
              'thread-node',
              message.role === 'user'
                ? 'thread-node--user'
                : message.role === 'status'
                  ? 'thread-node--tool'
                  : 'thread-node--assistant',
            )}
          >
            {message.role === 'user' ? (
              <span>AK</span>
            ) : message.role === 'status' ? (
              <Icon name="task" />
            ) : (
              <img src="/brand/cupcake-mark.svg" alt="" />
            )}
          </div>
          <div className={cx('message', message.role === 'user' && 'message--user')}>
            <div className="message-meta">
              <strong>
                {message.role === 'user' ? 'You' : message.role === 'status' ? 'Task' : 'Cupcake'}
              </strong>
              {message.role === 'assistant' && (
                <span className="model-label">{message.modelId ?? selectedModel.name}</span>
              )}
              <time>
                {message.createdAt
                  ? new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'now'}
              </time>
            </div>
            {message.role === 'user' ? (
              <div className="user-slip">
                <p>{message.content}</p>
                {message.attachments?.map((attachment) => (
                  <div className="file-attachment" key={attachment.handleId}>
                    <span className="file-icon">
                      {attachment.extension?.toUpperCase() ?? 'FILE'}
                    </span>
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>Opaque desktop handle · raw path hidden</small>
                    </span>
                    <RouteBadge route={attachment.destination === 'cloud' ? 'Cloud' : 'Local'} />
                  </div>
                ))}
              </div>
            ) : message.role === 'assistant' ? (
              <div className={cx('rich-response', message.streaming && 'streaming-message')}>
                {message.reasoningSummary && (
                  <div className="callout">
                    <Icon name="info" />
                    <p>
                      <strong>Provider reasoning summary</strong> — {message.reasoningSummary}
                    </p>
                  </div>
                )}
                <RichMarkdown streaming={message.streaming}>
                  {message.content || 'Starting response…'}
                </RichMarkdown>
                {message.citations && message.citations.length > 0 && (
                  <div className="citations">
                    {message.citations.map((citation) => (
                      <button key={citation.id}>
                        <span>{citation.id}</span>
                        <div>
                          <strong>{citation.title}</strong>
                          <small>{citation.url ? 'Provider citation' : 'Source metadata'}</small>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {message.streaming && (
                  <span className="streaming-caret" aria-label="Response is streaming" />
                )}
              </div>
            ) : (
              <p>{message.content}</p>
            )}
            <div className="message-footer">
              <MessageActions
                user={message.role === 'user'}
                message={message}
                onCopy={() => void workspace.copyMessage(message.id)}
                onRetry={
                  message.role === 'assistant' ? () => runAction(message, 'retry') : undefined
                }
                onEdit={() => runAction(message, 'edit')}
                onBranch={() =>
                  void workspace.branchConversation(message.id, `Branch from ${message.role}`)
                }
                onContinue={
                  message.role === 'assistant' ? () => runAction(message, 'continue') : undefined
                }
              />
              {message.usage && (
                <span>
                  {(message.usage.inputTokens ?? 0) + (message.usage.outputTokens ?? 0)} tokens ·{' '}
                  {message.usage.estimatedCost ?? 'cost unavailable'}
                </span>
              )}
            </div>
          </div>
        </article>
      ))}
      {workspace.toolActivity.slice(0, 12).map((activity) => (
        <RuntimeToolActivityCard activity={activity} key={activity.id} />
      ))}
      {workspace.messages.length > windowSize && (
        <aside className="frosting-outline" aria-label="Long chat outline" tabIndex={-1}>
          <span>{workspace.messages.length} turns</span>
          {outline.map((message, index) => (
            <button
              key={message.id}
              className={`is-${message.role}`}
              title={`${message.role}: ${message.content.slice(0, 80)}`}
              onClick={() => {
                const sourceIndex = workspace.messages.findIndex((item) => item.id === message.id);
                setWindowEnd(
                  Math.min(
                    workspace.messages.length,
                    Math.max(windowSize, sourceIndex + Math.floor(windowSize / 2)),
                  ),
                );
                window.setTimeout(
                  () =>
                    document
                      .getElementById(`message-${message.id}`)
                      ?.scrollIntoView({ block: 'center' }),
                  0,
                );
              }}
              aria-label={`Go to ${message.role} turn ${index * outlineStep + 1}`}
            />
          ))}
        </aside>
      )}
    </div>
  );
}

function ChatView({
  openArtifacts,
  openTask,
  selectedModel,
  setModelOpen,
  offline,
  onSend,
}: {
  openArtifacts: () => void;
  openTask: () => void;
  selectedModel: ModelDescriptor;
  setModelOpen: () => void;
  offline: boolean;
  onSend: (input: {
    content: string;
    attachments: AttachmentRecord[];
    references: ReferenceRecord[];
    reasoningEffort: ReasoningEffort;
    enabledToolIds: string[];
    outboundConfirmationToken?: string;
  }) => void;
}) {
  const workspace = useWorkspace();
  const [contextOpen, setContextOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    const stop = () => setStopped(true);
    window.addEventListener('cupcake:stop', stop);
    return () => window.removeEventListener('cupcake:stop', stop);
  }, []);
  return (
    <div className={cx('chat-layout', contextOpen && 'is-context-open')}>
      <main className="chat-main">
        <header className="chat-header">
          <div>
            <button
              className="icon-button"
              title="Previous conversation (Alt+Up)"
              aria-label="Previous conversation"
              onClick={() => {
                const index = workspace.conversations.findIndex(
                  (item) => item.id === workspace.activeConversationId,
                );
                const previous = workspace.conversations[Math.max(0, index - 1)];
                if (previous) void workspace.selectConversation(previous.id);
              }}
            >
              <Icon name="arrow" />
            </button>
            <button
              className="icon-button"
              title="Next conversation (Alt+Down)"
              aria-label="Next conversation"
              onClick={() => {
                const index = workspace.conversations.findIndex(
                  (item) => item.id === workspace.activeConversationId,
                );
                const next =
                  workspace.conversations[Math.min(workspace.conversations.length - 1, index + 1)];
                if (next) void workspace.selectConversation(next.id);
              }}
            >
              <Icon name="chevron" />
            </button>
            <button
              className="chat-project"
              onClick={() => void workspace.setActiveProject(workspace.activeProjectId)}
            >
              {workspace.projects.find((project) => project.id === workspace.activeProjectId)
                ?.name ?? 'No project'}{' '}
              <Icon name="chevron" size={12} />
            </button>
            <button
              className="context-toggle"
              onClick={() => document.querySelector<HTMLElement>('.frosting-outline')?.focus()}
              title="Long chat outline (Ctrl+J)"
            >
              <Icon name="history" />
              Outline
            </button>
            <h1>
              {workspace.conversations.find(
                (conversation) => conversation.id === workspace.activeConversationId,
              )?.title ?? (workspace.fixtureMode ? 'Architecture review' : 'New conversation')}
            </h1>
          </div>
          <div>
            <button className="context-toggle" onClick={() => setContextOpen((v) => !v)}>
              <Icon name="eye" />
              Context{' '}
              <span>
                {workspace.memories.filter((item) => item.enabled).length +
                  workspace.settings.enabledToolIds.length}
              </span>
            </button>
          </div>
        </header>
        <div className="conversation-scroll">
          {workspace.fixtureMode ? (
            <div className="conversation" aria-label="Deterministic fixture conversation">
              <div className="branch-banner">
                <Icon name="branch" />
                <span>
                  Exploring branch <strong>Storage architecture</strong>
                </span>
                <button>View original</button>
              </div>
              <article className="turn turn--user" id="turn-user-1">
                <div className="thread-node thread-node--user">
                  <span>AK</span>
                </div>
                <div className="message message--user">
                  <div className="message-meta">
                    <strong>You</strong>
                    <time>10:32</time>
                  </div>
                  <div className="user-slip">
                    <p>
                      Deeply analyze this repository and propose a durable architecture for
                      conversations, tasks, artifacts, and memory. Keep projects isolated and make
                      the tradeoffs understandable.
                    </p>
                    <div className="file-attachment">
                      <span className="file-icon">ZIP</span>
                      <span>
                        <strong>Cupcakeagi repository</strong>
                        <small>34 files · 286 KB · indexed</small>
                      </span>
                      <RouteBadge route="Local" />
                    </div>
                  </div>
                  <MessageActions user />
                </div>
              </article>
              <article className="turn turn--assistant">
                <div className="thread-node thread-node--assistant">
                  <img src="/brand/cupcake-mark.svg" alt="" />
                </div>
                <div className="message">
                  <div className="message-meta">
                    <strong>Cupcake</strong>
                    <span className="model-label">{selectedModel.name} · High reasoning</span>
                    <time>10:33</time>
                  </div>
                  <p>
                    This is substantial enough to keep working in the background. I’ll map the
                    repository first, then compare persistence boundaries before drafting the
                    architecture.
                  </p>
                  <TaskInline openTask={openTask} />
                  <ApprovalCard />
                </div>
              </article>
              <article className="turn turn--assistant">
                <div className="thread-node thread-node--tool">
                  <Icon name="tool" />
                </div>
                <div className="message">
                  <ToolCard />
                </div>
              </article>
              <article className="turn turn--assistant" id="turn-answer">
                <div className="thread-node thread-node--assistant">
                  <img src="/brand/cupcake-mark.svg" alt="" />
                </div>
                <div className="message">
                  <div className="message-meta">
                    <strong>Cupcake</strong>
                    <span className="model-label">{selectedModel.name}</span>
                    <time>10:45</time>
                  </div>
                  <div className="rich-response">
                    <p>
                      The cleanest boundary is to keep{' '}
                      <strong>product truth separate from framework state</strong>. Conversations,
                      branches, memories, and artifacts should be yours; model SDK objects and
                      workflow checkpoints should remain replaceable.
                    </p>
                    <h2>A durable shape</h2>
                    <p>Use three stores with explicit responsibilities:</p>
                    <ol>
                      <li>
                        <strong>Product database</strong> — encrypted conversations, immutable
                        message branches, projects, memory, and artifact metadata.
                      </li>
                      <li>
                        <strong>Workflow database</strong> — recoverable execution checkpoints and
                        idempotency records.
                      </li>
                      <li>
                        <strong>Object store</strong> — encrypted, content-addressed file and
                        artifact revisions.
                      </li>
                    </ol>
                    <div className="callout">
                      <Icon name="info" />
                      <p>
                        <strong>Why separate them?</strong> You can change orchestration frameworks
                        without migrating the user’s conversation history or memory model.
                      </p>
                    </div>
                    <pre>
                      <div className="code-head">
                        <span>TypeScript</span>
                        <button>
                          <Icon name="copy" size={14} />
                          Copy
                        </button>
                      </div>
                      <code>{`interface ConversationBranch {\n  id: UUID;\n  parentMessageId?: UUID;\n  headMessageId: UUID;\n  projectId?: UUID;\n}`}</code>
                    </pre>
                    <h3>Storage comparison</h3>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Concern</th>
                            <th>SQLite + objects</th>
                            <th>Flat files</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>Atomic writes</td>
                            <td>
                              <span className="good">Strong</span>
                            </td>
                            <td>Manual</td>
                          </tr>
                          <tr>
                            <td>Branch queries</td>
                            <td>
                              <span className="good">Natural</span>
                            </td>
                            <td>Expensive</td>
                          </tr>
                          <tr>
                            <td>Recovery</td>
                            <td>WAL + checkpoints</td>
                            <td>Partial writes</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p>
                      Project scope must be a hard filter during retrieval—not a ranking hint. That
                      keeps a question inside <em>Atlas research</em> from quietly pulling details
                      out of <em>Cupcake 2.0</em>.<sup className="citation">1</sup>
                    </p>
                    <ArtifactInline openArtifacts={openArtifacts} />
                    <div className="citations">
                      <button>
                        <span>1</span>
                        <div>
                          <strong>SQLite FTS5 Extension</strong>
                          <small>sqlite.org · sections 2 & 4</small>
                        </div>
                        <Icon name="external" />
                      </button>
                      <button>
                        <span>2</span>
                        <div>
                          <strong>DBOS workflow recovery</strong>
                          <small>docs.dbos.dev · recovery</small>
                        </div>
                        <Icon name="external" />
                      </button>
                    </div>
                  </div>
                  <div className="message-footer">
                    <MessageActions />
                    <span>2,184 tokens · $0.042</span>
                  </div>
                </div>
              </article>
              {workspace.messages.map((message) =>
                message.role === 'user' ? (
                  <article className="turn turn--user" key={message.id}>
                    <div className="thread-node thread-node--user">
                      <span>AK</span>
                    </div>
                    <div className="message message--user">
                      <div className="message-meta">
                        <strong>You</strong>
                        <time>now</time>
                      </div>
                      <div className="user-slip">
                        <p>{message.content}</p>
                      </div>
                      <MessageActions user />
                    </div>
                  </article>
                ) : (
                  <article className="turn turn--assistant" key={message.id}>
                    <div
                      className={cx(
                        'thread-node',
                        message.role === 'status' ? 'thread-node--tool' : 'thread-node--assistant',
                      )}
                    >
                      {message.role === 'status' ? (
                        <Icon name="task" />
                      ) : (
                        <img src="/brand/cupcake-mark.svg" alt="" />
                      )}
                    </div>
                    <div className="message">
                      <div className="message-meta">
                        <strong>{message.role === 'status' ? 'Task' : 'Cupcake'}</strong>
                        <span className="model-label">{selectedModel.name}</span>
                        <time>now</time>
                      </div>
                      <p className={cx(message.streaming && 'streaming-message')}>
                        {message.content || 'Thinking…'}
                      </p>
                      {message.streaming && (
                        <span className="streaming-caret" aria-label="Response is streaming" />
                      )}
                    </div>
                  </article>
                ),
              )}
              {stopped && (
                <div className="generation-state">
                  <span>
                    <StatusDot status="waiting" />
                    Response stopped
                  </span>
                  <button className="button" onClick={() => setStopped(false)}>
                    <Icon name="play" />
                    Continue
                  </button>
                </div>
              )}
            </div>
          ) : (
            <LiveConversation selectedModel={selectedModel} />
          )}
        </div>
        <footer className="chat-composer-wrap">
          <Composer
            compact
            onSend={onSend}
            onModel={setModelOpen}
            selectedModel={selectedModel}
            offline={offline}
          />
          {workspace.activeRunId && !stopped && (
            <button
              className="stop-button"
              onClick={() => {
                setStopped(true);
                void workspace.stopRun();
              }}
            >
              <Icon name="pause" size={13} />
              Stop
            </button>
          )}
        </footer>
      </main>
      <ContextInspector
        open={contextOpen}
        close={() => setContextOpen(false)}
        selectedModel={selectedModel}
        offline={offline}
      />
    </div>
  );
}

function ContextInspector({
  open,
  close,
  selectedModel,
  offline,
}: {
  open: boolean;
  close: () => void;
  selectedModel: ModelDescriptor;
  offline: boolean;
}) {
  const workspace = useWorkspace();
  const activeProject = workspace.projects.find(
    (project) => project.id === workspace.activeProjectId,
  );
  const activeAttachments = workspace.messages.flatMap((message) => message.attachments ?? []);
  const activeMemories = workspace.memories.filter((memory) => memory.enabled).slice(0, 8);
  const activeTools = workspace.tools.filter((tool) =>
    workspace.settings.enabledToolIds.includes(tool.id),
  );
  const messageTokens = Math.ceil(
    workspace.messages.reduce((total, message) => total + message.content.length, 0) / 4,
  );
  const fileTokens = activeAttachments.length * 350;
  const memoryTokens = Math.ceil(
    activeMemories.reduce((total, memory) => total + memory.body.length, 0) / 4,
  );
  const totalTokens = messageTokens + fileTokens + memoryTokens;
  return (
    <aside
      className={cx('context-panel', open && 'is-open')}
      aria-label="Context inspector"
      tabIndex={-1}
    >
      <header>
        <div>
          <span className="eyebrow">Input, not hidden reasoning</span>
          <h2>Context</h2>
        </div>
        <button className="icon-button" onClick={close} aria-label="Close context inspector">
          <Icon name="x" />
        </button>
      </header>
      <div className="context-budget">
        <div>
          <span>Context budget</span>
          <strong>
            {totalTokens.toLocaleString()} <small>/ {selectedModel.context}</small>
          </strong>
        </div>
        <div className="budget-bar">
          <i style={{ width: `${Math.min(100, totalTokens / 1000)}%` }} />
        </div>
        <div className="budget-key">
          <span>
            <i className="berry" />
            Messages {messageTokens.toLocaleString()}
          </span>
          <span>
            <i className="green" />
            Files {fileTokens.toLocaleString()}
          </span>
          <span>
            <i className="blue" />
            Memory {memoryTokens.toLocaleString()}
          </span>
        </div>
      </div>
      <ContextSection icon="project" title="Active project" count={activeProject ? '1' : '0'}>
        {activeProject ? (
          <div className="context-item">
            <span className="project-sigil berry">
              {activeProject.name
                .split(/\s+/)
                .map((part) => part[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span>
              <strong>{activeProject.name}</strong>
              <small>Project boundary enforced before retrieval</small>
            </span>
          </div>
        ) : (
          <p>No project context is active.</p>
        )}
      </ContextSection>
      <ContextSection icon="file" title="Attached files" count={String(activeAttachments.length)}>
        {activeAttachments.map((attachment) => (
          <div className="context-item" key={attachment.handleId}>
            <Icon name="file" />
            <span>
              <strong>{attachment.name}</strong>
              <small>Opaque handle · {attachment.destination} destination</small>
            </span>
          </div>
        ))}
        {!activeAttachments.length && <p>No file handles are included.</p>}
      </ContextSection>
      <ContextSection
        icon="memory"
        title="Retrieved memories"
        count={String(activeMemories.length)}
      >
        {activeMemories.map((memory) => (
          <div className="memory-context" key={memory.id}>
            <p>{memory.body}</p>
            <small>
              {memory.type} · {Math.round(memory.confidence * 100)}% confidence
            </small>
          </div>
        ))}
        {!activeMemories.length && <p>No enabled memory was retrieved.</p>}
      </ContextSection>
      <ContextSection icon="tool" title="Enabled tools" count={String(activeTools.length)}>
        <div className="context-tags">
          {activeTools.map((tool) => (
            <span key={tool.id}>{tool.name}</span>
          ))}
        </div>
      </ContextSection>
      <ContextSection icon="model" title="Destination" count="">
        <div className="destination-card">
          <RouteBadge route={offline ? 'Local' : selectedModel.route} />
          <strong>
            {offline ? 'This message stays local' : `Sent to ${selectedModel.provider}`}
          </strong>
          <p>
            {offline
              ? 'No content leaves this computer.'
              : 'Messages and selected excerpts may leave this computer.'}
          </p>
        </div>
      </ContextSection>
    </aside>
  );
}

function ContextSection({
  icon,
  title,
  count,
  children,
}: {
  icon: IconName;
  title: string;
  count: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="context-section">
      <button onClick={() => setOpen((v) => !v)}>
        <Icon name={icon} />
        <span>{title}</span>
        <em>{count}</em>
        <Icon name="chevron" />
      </button>
      {open && <div className="context-section__body">{children}</div>}
    </section>
  );
}

function ProjectsView({ openChat }: { openChat: () => void }) {
  const workspace = useWorkspace();
  const create = () => {
    const name = window.prompt('Project name')?.trim();
    if (!name) return;
    const description = window.prompt('What belongs in this project?')?.trim() ?? '';
    void workspace.createProject(name, description);
  };
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Context stays in its room</p>
          <h2>Projects</h2>
          <p>
            Bring conversations, files, decisions, and permissions together without leaking context
            across work.
          </p>
        </div>
        <button className="button button--primary" onClick={create}>
          <Icon name="plus" />
          New project
        </button>
      </div>
      <div className="project-grid">
        {workspace.projects.map((p, index) => (
          <article
            className={cx('project-card', workspace.activeProjectId === p.id && 'is-active')}
            key={p.id}
          >
            <header>
              <span
                className={`project-sigil ${index % 3 === 0 ? 'berry' : index % 3 === 1 ? 'green' : 'blue'}`}
              >
                {p.name
                  .split(/\s+/)
                  .map((part) => part[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </span>
            </header>
            <h3>{p.name}</h3>
            <p>{p.description || 'No project instructions yet.'}</p>
            <div className="project-stats">
              <span>
                <strong>
                  {workspace.conversations.filter((item) => item.project === p.name).length}
                </strong>{' '}
                chats
              </span>
              <span>
                <strong>
                  {workspace.artifacts.filter((item) => item.projectId === p.id).length}
                </strong>{' '}
                artifacts
              </span>
              <span>
                <strong>
                  {
                    workspace.tasks.filter(
                      (item) => item.project === p.id && item.status === 'working',
                    ).length
                  }
                </strong>{' '}
                active
              </span>
            </div>
            <footer>
              <span>
                {workspace.activeProjectId === p.id
                  ? 'Active privacy boundary'
                  : p.updatedAt
                    ? `Updated ${new Date(p.updatedAt).toLocaleDateString()}`
                    : 'Ready'}
              </span>
              <button
                onClick={() => {
                  void workspace.setActiveProject(p.id);
                  openChat();
                }}
              >
                Open <Icon name="chevron" />
              </button>
            </footer>
          </article>
        ))}
        <button className="project-new-card" onClick={create}>
          <span>
            <Icon name="plus" />
          </span>
          <strong>Create a project</strong>
          <small>Add instructions and a folder when you’re ready.</small>
        </button>
      </div>
      <section className="project-explainer">
        <Icon name="shield" />
        <div>
          <strong>Project boundaries are private by default.</strong>
          <p>
            Cupcake only retrieves project files and memories when that project is active. You can
            explicitly bring in outside context at any time.
          </p>
        </div>
        <button className="text-button">
          How context works <Icon name="external" />
        </button>
      </section>
    </main>
  );
}

function TasksView({ tasks, openTask }: { tasks: Task[]; openTask: (task: Task) => void }) {
  const [filter, setFilter] = useState<'all' | Task['status']>('all');
  const shown = tasks.filter((t) => filter === 'all' || t.status === filter);
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Long work, without losing the conversation</p>
          <h2>Tasks</h2>
          <p>Durable work continues while you chat and resumes after restart.</p>
        </div>
      </div>
      <div className="task-summary-strip">
        <div>
          <span className="pulse-dot" />
          <strong>{tasks.filter((task) => task.status === 'working').length}</strong>
          <small>Working</small>
        </div>
        <div>
          <StatusDot status="waiting" />
          <strong>{tasks.filter((task) => task.status === 'waiting').length}</strong>
          <small>Waiting for you</small>
        </div>
        <div>
          <Icon name="check" />
          <strong>{tasks.filter((task) => task.status === 'complete').length}</strong>
          <small>Completed</small>
        </div>
        <span className="summary-divider" />
        <div>
          <strong>{tasks.length}</strong>
          <small>Durable records</small>
        </div>
      </div>
      <div className="toolbar">
        <div className="segmented">
          {(['all', 'working', 'waiting', 'complete', 'failed'] as const).map((t) => (
            <button
              className={filter === t ? 'is-active' : ''}
              onClick={() => setFilter(t)}
              key={t}
            >
              {t === 'all' ? 'All' : cap(t)}
            </button>
          ))}
        </div>
      </div>
      <div className="tasks-list">
        {shown.map((task) => (
          <button className="task-row" key={task.id} onClick={() => openTask(task)}>
            <div className={cx('task-state-icon', `is-${task.status}`)}>
              {task.status === 'complete' ? (
                <Icon name="check" />
              ) : task.status === 'waiting' ? (
                <Icon name="clock" />
              ) : (
                <span />
              )}
            </div>
            <div className="task-row__body">
              <header>
                <strong>{task.title}</strong>
                <span>{task.project}</span>
              </header>
              <p>{task.detail}</p>
              <div className="task-progress">
                <i style={{ width: `${task.progress}%` }} />
              </div>
              <footer>
                <span>{task.progress}% complete</span>
                <span>{task.elapsed}</span>
                <span>
                  {task.steps.filter((s) => s.state === 'complete').length}/{task.steps.length}{' '}
                  steps
                </span>
              </footer>
            </div>
            <Icon name="chevron" />
          </button>
        ))}
      </div>
    </main>
  );
}

function TaskDetail({
  task,
  onBack,
  modelName,
}: {
  task: Task;
  onBack: () => void;
  modelName: string;
}) {
  const workspace = useWorkspace();
  const paused = task.status === 'waiting';
  const [note, setNote] = useState('');
  const [updates, setUpdates] = useState<string[]>([]);
  return (
    <main className="page task-detail">
      <button className="back-button" onClick={onBack}>
        <Icon name="arrow" />
        All tasks
      </button>
      <div className="task-detail__head">
        <div>
          <div className="status-line">
            <span className="pulse-dot" />
            {task.status === 'complete'
              ? 'Complete'
              : paused
                ? 'Waiting'
                : task.status === 'failed'
                  ? 'Stopped'
                  : 'Working'}{' '}
            · durable checkpoint state
          </div>
          <h2>{task.title}</h2>
          <p>{task.detail}</p>
          <div className="task-detail__meta">
            <span>
              <Icon name="project" />
              {task.project}
            </span>
            <span>
              <Icon name="clock" />
              {task.elapsed}
            </span>
            <span>
              <Icon name="model" />
              {modelName}
            </span>
            <span>
              <Icon name="cloud" />
              $0.31
            </span>
          </div>
        </div>
        <div>
          <button
            className="button"
            onClick={() =>
              void (paused ? workspace.resumeTask(task.id) : workspace.cancelTask(task.id))
            }
            disabled={task.status === 'complete'}
          >
            <Icon name={paused ? 'play' : 'pause'} />
            {paused ? 'Resume' : 'Cancel safely'}
          </button>
        </div>
      </div>
      <div className="task-detail__grid">
        <section className="task-panel">
          <header>
            <h3>Progress</h3>
            <strong>{task.progress}%</strong>
          </header>
          <div className="large-progress">
            <i style={{ width: `${task.progress}%` }} />
          </div>
          <div className="step-list">
            {task.steps.map((step, i) => (
              <div className={cx('step', `is-${step.state}`)} key={step.label}>
                <span>
                  {step.state === 'complete' ? (
                    <Icon name="check" />
                  ) : step.state === 'active' ? (
                    <i />
                  ) : (
                    i + 1
                  )}
                </span>
                <div>
                  <strong>{step.label}</strong>
                  {step.state === 'active' && <small>Reviewing 3 candidate designs · 2m 08s</small>}
                </div>
                {step.state === 'active' && <span className="live-badge">LIVE</span>}
              </div>
            ))}
          </div>
        </section>
        <section className="task-panel">
          <header>
            <h3>Activity</h3>
            <button className="text-button">Developer trace</button>
          </header>
          <div className="activity-stream">
            <div>
              <Icon name="check" />
              <span>
                <strong>Read repository</strong>
                <small>34 files · 1m 12s</small>
              </span>
            </div>
            <div>
              <Icon name="search" />
              <span>
                <strong>Compared persistence options</strong>
                <small>6 sources · 4m 38s</small>
              </span>
            </div>
            <div className="is-active">
              <span className="pulse-dot" />
              <span>
                <strong>Testing branch queries</strong>
                <small>SQLite fixture · running now</small>
              </span>
            </div>
            {updates.map((u, i) => (
              <div key={i}>
                <Icon name="chat" />
                <span>
                  <strong>You added guidance</strong>
                  <small>{u}</small>
                </span>
              </div>
            ))}
          </div>
          <div className="steer-task">
            <label htmlFor="task-note">Steer this task</label>
            <div>
              <input
                id="task-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add guidance without restarting…"
              />
              <button
                onClick={() => {
                  if (note.trim()) {
                    setUpdates((u) => [...u, note]);
                    void workspace.steerTask(task.id, note);
                    setNote('');
                  }
                }}
              >
                <Icon name="send" />
              </button>
            </div>
            <small>Your note is queued at the next safe checkpoint.</small>
            <button
              className="text-button"
              onClick={() => {
                const prompt = window.prompt('Queue a follow-up after this task')?.trim();
                if (prompt) void workspace.followupTask(task.id, prompt);
              }}
            >
              Queue follow-up <Icon name="chevron" />
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function FixtureArtifactsView() {
  const [selected, setSelected] = useState(fixtureArtifacts[0]!);
  const [tab, setTab] = useState<'preview' | 'edit' | 'revisions'>('preview');
  const [content, setContent] = useState(
    `# CUPCAKEAGI 2.0 architecture\n\nThe application owns its conversations, memories, and artifacts. Framework state remains replaceable.\n\n## Runtime boundaries\n\n- React renderer for presentation\n- Electron main for desktop lifecycle\n- Python runtime for model and workflow orchestration\n- Rust broker for permissions and tool execution\n\n> Project scope is a privacy boundary, not a ranking hint.\n\n## Storage\n\nProduct data lives in encrypted SQLite. Large revisions are immutable, encrypted objects addressed by their content hash.`,
  );
  const [saved, setSaved] = useState(true);
  return (
    <main className="artifact-workspace">
      <aside className="artifact-list">
        <div className="artifact-list__head">
          <h2>Artifacts</h2>
          <button className="icon-button" aria-label="Create artifact">
            <Icon name="plus" />
          </button>
        </div>
        <div className="search-field">
          <Icon name="search" />
          <input placeholder="Search artifacts" />
        </div>
        <div className="artifact-filter">
          <button className="is-active">All</button>
          <button>Documents</button>
          <button>Code</button>
          <button>More</button>
        </div>
        {fixtureArtifacts.map((a) => (
          <button
            className={cx('artifact-list__item', selected.id === a.id && 'is-active')}
            onClick={() => {
              setSelected(a);
              setTab('preview');
            }}
            key={a.id}
          >
            <span className={`artifact-type artifact-type--${a.type.toLowerCase()}`}>
              <Icon
                name={
                  a.type === 'Table'
                    ? 'database'
                    : a.type === 'Diagram'
                      ? 'branch'
                      : a.type === 'Webpage'
                        ? 'code'
                        : 'artifact'
                }
              />
            </span>
            <span>
              <strong>{a.name}</strong>
              <small>
                {a.project} · {a.updated}
              </small>
            </span>
            <Icon name="more" />
          </button>
        ))}
      </aside>
      <section className="artifact-stage">
        <header>
          <div>
            <span className="eyebrow">
              {selected.type} · {selected.project}
            </span>
            <h1>{selected.name}</h1>
            <small>
              {saved ? 'All changes saved' : 'Unsaved changes'} · {selected.size}
            </small>
          </div>
          <div>
            <button className="button">
              <Icon name="sparkle" />
              Ask Cupcake
            </button>
            <button className="button">
              <Icon name="download" />
              Export
            </button>
            <button className="icon-button" aria-label="Artifact actions">
              <Icon name="more" />
            </button>
          </div>
        </header>
        <div className="artifact-tabs">
          <button
            className={tab === 'preview' ? 'is-active' : ''}
            onClick={() => setTab('preview')}
          >
            <Icon name="eye" />
            Preview
          </button>
          <button className={tab === 'edit' ? 'is-active' : ''} onClick={() => setTab('edit')}>
            <Icon name="edit" />
            Edit
          </button>
          <button
            className={tab === 'revisions' ? 'is-active' : ''}
            onClick={() => setTab('revisions')}
          >
            <Icon name="history" />
            Revisions <span>{selected.revisions}</span>
          </button>
        </div>
        {tab === 'preview' && (
          <article className="document-preview">
            <div className="document-paper">
              <p className="eyebrow">Architecture note · revision 4</p>
              <h1>CUPCAKEAGI 2.0 architecture</h1>
              <p className="lead">
                The application owns its conversations, memories, and artifacts. Framework state
                remains replaceable.
              </p>
              <h2>Runtime boundaries</h2>
              <ul>
                <li>
                  <strong>React renderer</strong> for presentation
                </li>
                <li>
                  <strong>Electron main</strong> for desktop lifecycle
                </li>
                <li>
                  <strong>Python runtime</strong> for model and workflow orchestration
                </li>
                <li>
                  <strong>Rust broker</strong> for permissions and tool execution
                </li>
              </ul>
              <blockquote>Project scope is a privacy boundary, not a ranking hint.</blockquote>
              <h2>Storage</h2>
              <p>
                Product data lives in encrypted SQLite. Large revisions are immutable, encrypted
                objects addressed by their content hash.
              </p>
              <div className="document-note">
                <Icon name="chat" />
                <span>
                  Created in <strong>Architecture review</strong> · linked to message at 10:45
                </span>
                <button>Open chat</button>
              </div>
            </div>
          </article>
        )}
        {tab === 'edit' && (
          <div className="artifact-editor">
            <div className="editor-gutter">
              {content.split('\n').map((_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setSaved(false);
              }}
              spellCheck="false"
            />
            <button className="save-float" onClick={() => setSaved(true)} disabled={saved}>
              <Icon name="check" />
              {saved ? 'Saved' : 'Save revision'}
            </button>
          </div>
        )}
        {tab === 'revisions' && (
          <div className="revision-view">
            <div className="revision-timeline">
              {[4, 3, 2, 1].map((r, i) => (
                <button className={i === 0 ? 'is-active' : ''} key={r}>
                  <span>v{r}</span>
                  <div>
                    <strong>
                      {i === 0
                        ? 'Clarified project boundary'
                        : i === 1
                          ? 'Added storage model'
                          : i === 2
                            ? 'Runtime split'
                            : 'Initial draft'}
                    </strong>
                    <small>
                      {i === 0 ? 'Just now' : `${i * 18} min ago`} · {i === 0 ? 'You' : 'Cupcake'}
                    </small>
                  </div>
                </button>
              ))}
            </div>
            <div className="diff-preview">
              <header>
                <span className="diff-add">+ 7</span>
                <span className="diff-remove">− 2</span>
                <button className="button">Restore this revision</button>
              </header>
              <pre>
                <span> ## Storage</span>
                <span className="remove">- Keep project filtering in the search query.</span>
                <span className="add">+ Treat project scope as a hard privacy boundary.</span>
                <span className="add">+ Apply the filter before retrieval and ranking.</span>
              </pre>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function ArtifactPreview({ artifact, content }: { artifact: ArtifactRecord; content: string }) {
  const kind = artifact.kind.toLowerCase();
  if (kind.includes('code') || kind.includes('config'))
    return (
      <pre>
        <code>{content}</code>
      </pre>
    );
  if (kind.includes('table') || kind.includes('spreadsheet')) {
    const rows = content
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 200)
      .map((row) => row.split(',').slice(0, 30));
    return (
      <div className="table-wrap">
        <table>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) =>
                  rowIndex === 0 ? (
                    <th key={cellIndex}>{cell}</th>
                  ) : (
                    <td key={cellIndex}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (kind.includes('webpage') || kind.includes('html'))
    return (
      <iframe
        title={`${artifact.name} sandboxed preview`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={content}
      />
    );
  if (kind.includes('image'))
    return (
      <div className="empty-state">
        <Icon name="artifact" size={32} />
        <h2>Image preview is broker-mediated</h2>
        <p>
          The renderer does not receive a raw path or arbitrary file URL. Use Export to save this
          immutable image revision.
        </p>
      </div>
    );
  if (kind.includes('diagram'))
    return (
      <div className="document-paper">
        <p className="eyebrow">Diagram source · safe text preview</p>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    );
  return (
    <div className="document-paper">
      <RichMarkdown>{content || '*Empty artifact*'}</RichMarkdown>
    </div>
  );
}

function ArtifactsView() {
  const workspace = useWorkspace();
  const [selectedId, setSelectedId] = useState<string | null>(workspace.artifacts[0]?.id ?? null);
  const [tab, setTab] = useState<'preview' | 'edit' | 'revisions'>('preview');
  const selected =
    workspace.artifacts.find((item) => item.id === selectedId) ?? workspace.artifacts[0];
  const [content, setContent] = useState(selected?.content ?? '');
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    setContent(selected?.content ?? '');
    setSaved(true);
  }, [selected?.id, selected?.content]);
  if (workspace.fixtureMode) return <FixtureArtifactsView />;
  const create = () => {
    const name = window.prompt('Artifact name', 'Untitled document.md')?.trim();
    if (!name) return;
    void workspace.createArtifact(name, 'document', '# Untitled\n');
  };
  if (!selected) {
    return (
      <main className="artifact-workspace">
        <EmptyState
          icon="artifact"
          title="No artifacts in this project"
          body="Artifacts are isolated to the active project boundary."
          action="Create artifact"
          onAction={create}
        />
      </main>
    );
  }
  return (
    <main className="artifact-workspace">
      <aside className="artifact-list">
        <div className="artifact-list__head">
          <h2>Artifacts</h2>
          <button className="icon-button" onClick={create} aria-label="Create artifact">
            <Icon name="plus" />
          </button>
        </div>
        {workspace.artifacts.map((artifact) => (
          <button
            className={cx('artifact-list__item', selected.id === artifact.id && 'is-active')}
            onClick={() => setSelectedId(artifact.id)}
            key={artifact.id}
          >
            <span className={`artifact-type artifact-type--${artifact.kind.toLowerCase()}`}>
              <Icon name="artifact" />
            </span>
            <span>
              <strong>{artifact.name}</strong>
              <small>
                Revision {artifact.revisionNumber ?? 1} ·{' '}
                {artifact.updatedAt
                  ? new Date(artifact.updatedAt).toLocaleDateString()
                  : 'saved locally'}
              </small>
            </span>
          </button>
        ))}
      </aside>
      <section className="artifact-stage">
        <header>
          <div>
            <span className="eyebrow">{selected.kind} · active project only</span>
            <h1>{selected.name}</h1>
            <small>
              {saved ? 'All changes saved' : 'Unsaved changes'} · revision{' '}
              {selected.revisionNumber ?? 1}
            </small>
          </div>
          <div>
            <button className="button" onClick={() => void workspace.exportArtifact(selected)}>
              <Icon name="download" />
              Export
            </button>
          </div>
        </header>
        <div className="artifact-tabs">
          {(['preview', 'edit', 'revisions'] as const).map((item) => (
            <button
              className={tab === item ? 'is-active' : ''}
              onClick={() => setTab(item)}
              key={item}
            >
              <Icon name={item === 'preview' ? 'eye' : item === 'edit' ? 'edit' : 'history'} />
              {cap(item)}
            </button>
          ))}
        </div>
        {tab === 'preview' && (
          <article className="document-preview">
            <ArtifactPreview artifact={selected} content={content} />
          </article>
        )}
        {tab === 'edit' && (
          <div className="artifact-editor">
            <div className="editor-gutter">
              {content.split('\n').map((_, index) => (
                <span key={index}>{index + 1}</span>
              ))}
            </div>
            <textarea
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setSaved(false);
              }}
              spellCheck="false"
            />
            <button
              className="save-float"
              disabled={saved}
              onClick={() => {
                void workspace.reviseArtifact(selected, content);
                setSaved(true);
              }}
            >
              <Icon name="check" />
              {saved ? 'Saved' : 'Save revision'}
            </button>
          </div>
        )}
        {tab === 'revisions' && (
          <div className="revision-view">
            <div className="revision-timeline">
              <button className="is-active">
                <span>v{selected.revisionNumber ?? 1}</span>
                <div>
                  <strong>Current immutable revision</strong>
                  <small>{selected.revisionId ?? 'Runtime-owned revision'}</small>
                </div>
              </button>
            </div>
            <div className="diff-preview">
              <p>
                Revision content is stored as an immutable encrypted object. Saving creates a new
                sibling revision.
              </p>
              {workspace.error?.toLowerCase().includes('conflict') && (
                <div className="callout" role="alert">
                  <Icon name="info" />
                  <p>
                    A newer revision exists. Your edit was preserved; reopen the latest revision and
                    choose whether to create a sibling.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function MemoryView({
  records,
  setRecords,
}: {
  records: MemoryRecord[];
  setRecords: (r: MemoryRecord[]) => void;
}) {
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MemoryRecord | null>(records[0] ?? null);
  const [off, setOff] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState('');
  const [undoForget, setUndoForget] = useState<MemoryRecord | null>(null);
  const [pendingMemoryAction, setPendingMemoryAction] = useState<null | {
    record: MemoryRecord;
    action: 'save' | 'enable';
  }>(null);
  const looksLikeCredential = (value: string) =>
    /(?:sk-[A-Za-z0-9_-]{12,}|nvapi-[A-Za-z0-9_-]{12,}|api[_ -]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{12,})/i.test(
      value,
    );
  const shown = records.filter((m) =>
    `${m.title} ${m.body} ${m.scope}`.toLowerCase().includes(query.toLowerCase()),
  );
  const update = (id: string, patch: Partial<MemoryRecord>) => {
    const next = records.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setRecords(next);
    setSelected(next.find((m) => m.id === id) ?? null);
  };
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">A recipe box you control</p>
          <h2>Memory</h2>
          <p>Review what Cupcake carries between conversations. Nothing here is hidden.</p>
        </div>
        <div className="memory-master">
          <span>
            <strong>Use memory</strong>
            <small>{off ? 'Paused everywhere' : 'On in new chats'}</small>
          </span>
          <Toggle
            checked={!off}
            onChange={() => {
              const next = !off;
              setOff(next);
              records.forEach((record) => void workspace.setMemoryEnabled(record, !next));
            }}
            label="Use memory"
          />
        </div>
      </div>
      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory"
          />
        </div>
        <button className="button">
          <Icon name="filter" />
          All scopes
        </button>
        <button
          className="button button--primary"
          onClick={() => {
            const key = window.prompt('Memory label')?.trim();
            if (!key) return;
            const body = window.prompt('What should Cupcake remember?')?.trim();
            if (!body) return;
            if (looksLikeCredential(body)) {
              setMemoryNotice(
                'Credentials cannot be saved as memory. Store provider keys through Windows Credential UI.',
              );
              return;
            }
            void workspace.remember({ key, content: body, kind: 'fact' });
            setMemoryNotice('Memory saved. You can inspect its scope and provenance here.');
          }}
        >
          <Icon name="plus" />
          Add memory
        </button>
      </div>
      {memoryNotice && (
        <div className="callout" role="status">
          <Icon name="info" />
          <p>{memoryNotice}</p>
          {undoForget && (
            <button
              className="text-button"
              onClick={() => {
                void workspace.remember({
                  key: undoForget.title,
                  content: undoForget.body,
                  kind: undoForget.type.toLowerCase(),
                });
                setRecords([undoForget, ...records]);
                setUndoForget(null);
                setMemoryNotice('Memory restored as a new immutable revision.');
              }}
            >
              Undo forget
            </button>
          )}
        </div>
      )}
      {records.length === 0 ? (
        <EmptyState
          icon="memory"
          title="Nothing in the recipe box yet"
          body="Ask Cupcake to remember something, or add a preference yourself."
          action="Add a memory"
        />
      ) : (
        <div className="memory-layout">
          <section className="memory-list">
            {[...new Set(shown.map((memory) => memory.scope))].map((scope) => {
              const entries = shown.filter(
                (m) => m.scope === scope || (scope === 'About me' && m.scope === 'About me'),
              );
              if (!entries.length) return null;
              return (
                <div className="memory-group" key={scope}>
                  <header>
                    <h3>{scope}</h3>
                    <span>{entries.length}</span>
                  </header>
                  {entries.map((m) => (
                    <button
                      className={cx(
                        'memory-card',
                        selected?.id === m.id && 'is-active',
                        !m.enabled && 'is-disabled',
                      )}
                      onClick={() => setSelected(m)}
                      key={m.id}
                    >
                      <span className={`memory-kind memory-kind--${m.type.toLowerCase()}`}>
                        {m.type}
                      </span>
                      <strong>{m.title}</strong>
                      <p>{m.body}</p>
                      <footer>
                        <span>{m.source}</span>
                        {m.pinned && <Icon name="pin" size={13} />}
                        {m.expires && <em>Expires {m.expires}</em>}
                      </footer>
                    </button>
                  ))}
                </div>
              );
            })}
          </section>
          {selected && (
            <aside className="memory-detail">
              <header>
                <div>
                  <span className={`memory-kind memory-kind--${selected.type.toLowerCase()}`}>
                    {selected.type}
                  </span>
                  <h2>{selected.title}</h2>
                </div>
              </header>
              <label>
                What Cupcake remembers
                <textarea
                  value={selected.body}
                  onChange={(e) => update(selected.id, { body: e.target.value })}
                  onBlur={() => {
                    const current = records.find((record) => record.id === selected.id);
                    if (!current) return;
                    if (looksLikeCredential(current.body)) {
                      setMemoryNotice('Credential-shaped text was not saved to memory.');
                      return;
                    }
                    if (current.type === 'Instruction' || current.type === 'Fact') {
                      setPendingMemoryAction({ record: current, action: 'save' });
                      return;
                    }
                    void workspace.updateMemory(current);
                    setMemoryNotice('Memory revision saved.');
                  }}
                />
              </label>
              <div className="detail-row">
                <span>
                  <strong>Scope</strong>
                  <small>Where this memory can be used</small>
                </span>
                <span className="select-button" aria-label="Memory scope">
                  {selected.scope}
                </span>
              </div>
              <div className="detail-row">
                <span>
                  <strong>Confidence</strong>
                  <small>
                    {Math.round(selected.confidence * 100)}% · based on explicit context
                  </small>
                </span>
                <div className="confidence-meter">
                  <i style={{ width: `${selected.confidence * 100}%` }} />
                </div>
              </div>
              <div className="detail-row">
                <span>
                  <strong>Enabled</strong>
                  <small>Include when relevant</small>
                </span>
                <Toggle
                  checked={selected.enabled}
                  onChange={() => {
                    if (
                      !selected.enabled &&
                      (selected.source === 'Suggested memory' || selected.type === 'Instruction')
                    ) {
                      setPendingMemoryAction({ record: selected, action: 'enable' });
                      return;
                    }
                    update(selected.id, { enabled: !selected.enabled });
                    void workspace.setMemoryEnabled(selected, !selected.enabled);
                  }}
                  label="Enable memory"
                />
              </div>
              <section className="memory-source">
                <h3>Source and history</h3>
                <div>
                  <Icon name="chat" />
                  <span>
                    <strong>{selected.source}</strong>
                    <small>Captured Aug 28 · unchanged</small>
                  </span>
                </div>
              </section>
              <footer>
                <button
                  className="button"
                  onClick={() => {
                    const next = { ...selected, pinned: !selected.pinned };
                    update(selected.id, { pinned: next.pinned });
                    void workspace.updateMemory(next);
                    setMemoryNotice(
                      next.pinned
                        ? 'Memory pinned as a new immutable revision.'
                        : 'Memory unpinned as a new immutable revision.',
                    );
                  }}
                >
                  <Icon name="pin" />
                  {selected.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  className="button button--danger"
                  onClick={() => {
                    setRecords(records.filter((m) => m.id !== selected.id));
                    setUndoForget(selected);
                    setMemoryNotice('Memory forgotten. A tombstone preserves the audit history.');
                    void workspace.forgetMemory(selected);
                    setSelected(null);
                  }}
                >
                  <Icon name="trash" />
                  Forget
                </button>
              </footer>
            </aside>
          )}
        </div>
      )}
      {pendingMemoryAction && (
        <div className="popover-layer">
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm memory"
          >
            <header>
              <div>
                <span className="eyebrow">Confirm sensitive memory use</span>
                <h2>
                  {pendingMemoryAction.action === 'enable'
                    ? 'Enable this memory?'
                    : 'Save this memory revision?'}
                </h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setPendingMemoryAction(null)}
                aria-label="Cancel"
              >
                <Icon name="x" />
              </button>
            </header>
            <div className="security-note">
              <Icon name="memory" />
              <div>
                <strong>
                  {pendingMemoryAction.record.type} · {pendingMemoryAction.record.scope}
                </strong>
                <p>{pendingMemoryAction.record.body}</p>
                <small>Source: {pendingMemoryAction.record.source}</small>
              </div>
            </div>
            <footer>
              <button className="button" onClick={() => setPendingMemoryAction(null)}>
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                onClick={() => {
                  if (pendingMemoryAction.action === 'enable') {
                    update(pendingMemoryAction.record.id, { enabled: true });
                    void workspace.setMemoryEnabled(pendingMemoryAction.record, true);
                  } else {
                    void workspace.updateMemory(pendingMemoryAction.record);
                  }
                  setMemoryNotice('Memory choice saved with provenance.');
                  setPendingMemoryAction(null);
                }}
              >
                Confirm
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function ModelsView({
  models,
  selectModel,
}: {
  models: ModelDescriptor[];
  selectModel: (id: string) => void;
}) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<'all' | 'cloud' | 'local'>('all');
  const [modelQuery, setModelQuery] = useState('');
  const [benchmark, setBenchmark] = useState(false);
  const [providerCatalog, setProviderCatalog] = useState(false);
  const [compatible, setCompatible] = useState({ name: '', baseUrl: '', modelId: '' });
  const [pendingDownload, setPendingDownload] = useState<ModelDescriptor | null>(null);
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const shown = models.filter(
    (m) =>
      (tab === 'all' || m.route.toLowerCase() === tab) &&
      `${m.name} ${m.provider} ${m.tags.join(' ')}`
        .toLowerCase()
        .includes(modelQuery.toLowerCase()),
  );
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">You choose every time</p>
          <h2>Models</h2>
          <p>Cloud and local models share one workspace. Cupcake never routes automatically.</p>
        </div>
        <button className="button button--primary" onClick={() => setProviderCatalog(true)}>
          <Icon name="plus" />
          Add provider
        </button>
      </div>
      <section className="hardware-card">
        <div className="hardware-card__art">
          <span className="chip-lines" />
          <Icon name="local" size={34} />
        </div>
        <div>
          <span className="eyebrow">This computer</span>
          <h3>Ready for strong local models</h3>
          <p>
            {workspace.hardware?.gpu ?? 'GPU detection pending'} ·{' '}
            {workspace.hardware?.vramBytes
              ? `${(workspace.hardware.vramBytes / 1024 ** 3).toFixed(1)} GB VRAM`
              : 'VRAM unknown'}{' '}
            ·{' '}
            {workspace.hardware?.ramBytes
              ? `${(workspace.hardware.ramBytes / 1024 ** 3).toFixed(1)} GB system RAM`
              : 'RAM detection pending'}
          </p>
          <div className="hardware-tags">
            <span>7–9B Q4 recommended</span>
            <span>12–14B possible</span>
            {(workspace.hardware?.acceleration ?? []).map((item) => (
              <span key={item}>{item} available</span>
            ))}
          </div>
        </div>
        <div className="hardware-meter">
          <span>
            <strong>
              {workspace.hardware?.vramBytes
                ? (workspace.hardware.vramBytes / 1024 ** 3).toFixed(1)
                : '—'}
            </strong>{' '}
            GB detected
          </span>
          <div>
            <i />
          </div>
          <small>Measured hardware informs model headroom checks.</small>
        </div>
        <button
          className="button"
          onClick={() => {
            setBenchmark(true);
            const local = models.find((item) => item.route === 'Local');
            if (local) void workspace.runModelAction('benchmark', local.runtimeModelId ?? local.id);
          }}
        >
          {benchmark ? 'Benchmark requested' : 'Run benchmark'}
        </button>
      </section>
      <div className="toolbar">
        <div className="segmented">
          {(['all', 'cloud', 'local'] as const).map((t) => (
            <button className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)} key={t}>
              {t === 'all' ? 'All models' : cap(t)}
            </button>
          ))}
        </div>
        <div className="search-field">
          <Icon name="search" />
          <input
            placeholder="Find a model"
            value={modelQuery}
            onChange={(event) => setModelQuery(event.target.value)}
          />
        </div>
      </div>
      <div className="model-grid">
        {shown.map((model) => (
          <article className={cx('model-card', model.selected && 'is-selected')} key={model.id}>
            <header>
              <span
                className={cx(
                  'provider-logo',
                  `provider-logo--${model.provider.toLowerCase().replaceAll(' ', '-')}`,
                )}
              >
                {model.provider.charAt(0)}
              </span>
              <div>
                <span>{model.provider}</span>
                <h3>{model.name}</h3>
              </div>
              <RouteBadge route={model.route} />
            </header>
            <p>{model.description}</p>
            <div className="model-tags">
              {model.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <dl>
              <div>
                <dt>Context</dt>
                <dd>{model.context}</dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>{model.cost}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusDot status={model.status} />
                  {model.status === 'setup' ? 'Needs setup' : cap(model.status)}
                </dd>
              </div>
            </dl>
            {model.download && model.download.totalBytes > 0 && (
              <div className="download-progress">
                <div>
                  <i
                    style={{
                      width: `${Math.round((model.download.bytesReceived / model.download.totalBytes) * 100)}%`,
                    }}
                  />
                </div>
                <span>
                  {Math.round((model.download.bytesReceived / model.download.totalBytes) * 100)}% ·{' '}
                  {(model.download.bytesReceived / 1024 ** 3).toFixed(2)} of{' '}
                  {(model.download.totalBytes / 1024 ** 3).toFixed(2)} GB
                  {model.download.bytesPerSecond
                    ? ` · ${(model.download.bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`
                    : ''}{' '}
                  · checksum {model.download.checksumState ?? 'pending'}
                </span>
                <button
                  aria-label={`${model.download.state === 'paused' ? 'Resume' : 'Pause'} download for ${model.name}`}
                  onClick={() =>
                    void workspace.runModelAction(
                      model.download?.state === 'paused' ? 'resume' : 'pause',
                      model.runtimeModelId ?? model.id,
                    )
                  }
                >
                  <Icon name={model.download.state === 'paused' ? 'play' : 'pause'} />
                </button>
                <button
                  aria-label={`Cancel download for ${model.name}`}
                  onClick={() =>
                    void workspace.runModelAction('cancel', model.runtimeModelId ?? model.id)
                  }
                >
                  <Icon name="x" />
                </button>
              </div>
            )}
            <footer>
              {model.selected ? (
                <span className="selected-label">
                  <Icon name="check" />
                  Default model
                </span>
              ) : model.status === 'ready' ? (
                <button className="button" onClick={() => selectModel(model.id)}>
                  Make default
                </button>
              ) : model.status === 'download' ? (
                <button
                  className="button"
                  onClick={() =>
                    void workspace.runModelAction('status', model.runtimeModelId ?? model.id)
                  }
                >
                  Check download
                </button>
              ) : model.status === 'offline' ? (
                <button
                  className="button"
                  onClick={() =>
                    void workspace.runModelAction('load', model.runtimeModelId ?? model.id)
                  }
                >
                  Load model
                </button>
              ) : (
                <button
                  className="button"
                  onClick={() =>
                    model.route === 'Local'
                      ? setPendingDownload(model)
                      : void workspace.runModelAction('status', model.runtimeModelId ?? model.id)
                  }
                >
                  {model.route === 'Local' ? 'Review download' : 'Set up'}
                </button>
              )}
              <button
                className="icon-button"
                aria-label={`Remove ${model.name}`}
                onClick={() =>
                  void workspace.runModelAction('remove', model.runtimeModelId ?? model.id)
                }
                disabled={model.route !== 'Local'}
              >
                <Icon name="trash" />
              </button>
            </footer>
          </article>
        ))}
      </div>
      {providerCatalog && (
        <div
          className="popover-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProviderCatalog(false);
          }}
        >
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Add model provider"
          >
            <header>
              <div>
                <span className="eyebrow">Explicit provider setup</span>
                <h2>Add a provider</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setProviderCatalog(false)}
                aria-label="Close provider catalog"
              >
                <Icon name="x" />
              </button>
            </header>
            <div className="model-picker__list">
              {(
                [
                  ['openai', 'OpenAI'],
                  ['anthropic', 'Anthropic'],
                  ['google', 'Google Gemini'],
                  ['xai', 'xAI'],
                  ['mistral', 'Mistral'],
                  ['cohere', 'Cohere'],
                  ['nvidia-nim', 'NVIDIA NIM'],
                ] as const
              ).map(([id, name]) => (
                <button
                  key={id}
                  onClick={() => void workspace.connectProvider(id).then(() => workspace.refresh())}
                >
                  <span className="provider-logo">{name[0]}</span>
                  <span>
                    <strong>{name}</strong>
                    <small>
                      Cloud ·{' '}
                      {id === 'nvidia-nim'
                        ? 'Recommended for experimentation: one key, many hosted models · trial/evaluation only · catalog/terms vary'
                        : 'provider pricing and privacy terms apply'}{' '}
                      · credentials stay broker-owned
                    </small>
                  </span>
                  <RouteBadge route="Cloud" />
                </button>
              ))}
            </div>
            <div className="settings-section">
              <header>
                <h3>OpenAI-compatible endpoint</h3>
                <p>
                  Nonsecret endpoint metadata is validated here. Any key is collected separately by
                  Windows Credential UI.
                </p>
              </header>
              <label>
                Name
                <input
                  value={compatible.name}
                  onChange={(event) =>
                    setCompatible((value) => ({ ...value, name: event.target.value }))
                  }
                />
              </label>
              <label>
                Base URL
                <input
                  value={compatible.baseUrl}
                  onChange={(event) =>
                    setCompatible((value) => ({ ...value, baseUrl: event.target.value }))
                  }
                  placeholder="https://host.example/v1 or http://localhost:port/v1"
                />
              </label>
              <label>
                Model ID
                <input
                  value={compatible.modelId}
                  onChange={(event) =>
                    setCompatible((value) => ({ ...value, modelId: event.target.value }))
                  }
                />
              </label>
              <button
                className="button"
                onClick={() => void workspace.configureCompatibleProvider(compatible)}
              >
                Validate and test
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingDownload && (
        <div className="popover-layer">
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Review local model download"
          >
            <header>
              <div>
                <span className="eyebrow">Verified local model catalog</span>
                <h2>Review {pendingDownload.name}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setPendingDownload(null)}
                aria-label="Cancel download"
              >
                <Icon name="x" />
              </button>
            </header>
            <dl className="permission-list">
              <div>
                <dt>Catalog provenance</dt>
                <dd>
                  {pendingDownload.description ||
                    'Catalog metadata unavailable — download blocked until verified.'}
                </dd>
              </div>
              <div>
                <dt>Quantization</dt>
                <dd>
                  {pendingDownload.tags.find((tag) => /Q\d|quant/i.test(tag)) ?? 'Not reported'}
                </dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{pendingDownload.context}</dd>
              </div>
              <div>
                <dt>RAM / VRAM / disk estimate</dt>
                <dd>Runtime preflight required before bytes are downloaded.</dd>
              </div>
              <div>
                <dt>Version and checksum</dt>
                <dd>Verified by catalog signature and SHA-256 during download.</dd>
              </div>
              <div>
                <dt>Suitability</dt>
                <dd>
                  {pendingDownload.tags.find((tag) =>
                    /recommended|possible|unsuitable|hybrid/i.test(tag),
                  ) ?? 'Awaiting hardware preflight'}
                </dd>
              </div>
            </dl>
            <label>
              <input
                type="checkbox"
                checked={licenseAccepted}
                onChange={(event) => setLicenseAccepted(event.target.checked)}
              />{' '}
              I reviewed the model license and terms shown by its catalog entry.
            </label>
            <footer>
              <button className="button" onClick={() => setPendingDownload(null)}>
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                disabled={!licenseAccepted || !pendingDownload.description}
                onClick={() => {
                  void workspace.runModelAction(
                    'download',
                    pendingDownload.runtimeModelId ?? pendingDownload.id,
                  );
                  setPendingDownload(null);
                  setLicenseAccepted(false);
                }}
              >
                Start verified download
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function ToolsView({
  tools,
  setTools,
}: {
  tools: ToolDescriptor[];
  setTools: (t: ToolDescriptor[]) => void;
}) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<'all' | 'native' | 'mcp' | 'custom'>('all');
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'streamable-http'>('streamable-http');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [mcpError, setMcpError] = useState('');
  const shown = tools.filter((t) => tab === 'all' || t.kind === tab);
  const toggle = (id: string) => {
    const tool = tools.find((item) => item.id === id);
    if (!tool) return;
    setTools(tools.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)));
    void workspace.setToolEnabled(id, !tool.enabled);
  };
  const connectMcp = () => {
    if (!mcpName.trim() || !mcpEndpoint.trim()) {
      setMcpError('Name and destination are required.');
      return;
    }
    if (mcpTransport === 'streamable-http' && !mcpEndpoint.startsWith('https://')) {
      setMcpError('Remote MCP requires an HTTPS origin.');
      return;
    }
    void workspace
      .connectMcp({ name: mcpName.trim(), transport: mcpTransport, endpoint: mcpEndpoint.trim() })
      .then(() => setMcpOpen(false));
  };
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Capabilities with boundaries</p>
          <h2>Tools</h2>
          <p>Cupcake chooses tools naturally in chat. You decide what each one can reach.</p>
        </div>
        <button className="button button--primary" onClick={() => setMcpOpen(true)}>
          <Icon name="plus" />
          Connect MCP server
        </button>
      </div>
      <div className="security-note">
        <Icon name="shield" />
        <div>
          <strong>High-impact actions always ask.</strong>
          <p>
            Deletion, external communication, purchases, installation, system changes, and
            unsandboxed execution cannot be pre-approved.
          </p>
        </div>
        <button className="text-button">
          Permission policy <Icon name="chevron" />
        </button>
      </div>
      <div className="toolbar">
        <div className="segmented">
          {(['all', 'native', 'mcp', 'custom'] as const).map((t) => (
            <button className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)} key={t}>
              {t === 'all' ? 'All tools' : t === 'mcp' ? 'MCP connections' : cap(t)}
            </button>
          ))}
        </div>
        <div className="search-field">
          <Icon name="search" />
          <input placeholder="Find a tool" />
        </div>
      </div>
      <div className="tool-grid">
        {shown.map((tool) => (
          <article className={cx('registry-card', !tool.enabled && 'is-disabled')} key={tool.id}>
            <header>
              <span className={cx('tool-logo', tool.kind === 'mcp' && 'is-mcp')}>
                <Icon
                  name={
                    tool.id === 'python'
                      ? 'terminal'
                      : tool.id === 'files'
                        ? 'folder'
                        : tool.id === 'git'
                          ? 'branch'
                          : tool.id === 'web'
                            ? 'search'
                            : 'tool'
                  }
                />
              </span>
              <div>
                <h3>{tool.name}</h3>
                <span>{tool.provider}</span>
              </div>
              <Toggle
                checked={tool.enabled}
                onChange={() => toggle(tool.id)}
                label={`Enable ${tool.name}`}
              />
            </header>
            <p>{tool.description}</p>
            <div className="registry-meta">
              <RouteBadge route={tool.route} />
              <span className="kind-label">{tool.kind === 'mcp' ? 'MCP' : tool.kind}</span>
            </div>
            <div className="permission-list">
              {tool.permissions.map((p) => (
                <span key={p}>
                  <Icon name={p.includes('Ask') ? 'shield' : p.includes('Not') ? 'x' : 'check'} />
                  {p}
                </span>
              ))}
            </div>
            <footer>
              <span>Last used {tool.lastUsed}</span>
              <button onClick={() => void workspace.preflightTool(tool)}>
                Inspect access <Icon name="chevron" />
              </button>
              {tool.kind === 'mcp' && (
                <button
                  className="text-button"
                  onClick={() => void workspace.disconnectMcp(tool.id)}
                >
                  Disconnect
                </button>
              )}
            </footer>
          </article>
        ))}
      </div>
      {workspace.toolActivity.length > 0 && (
        <section className="settings-section">
          <header>
            <h2>Broker audit activity</h2>
            <p>
              Preflight, approval, and result summaries are redacted. Credentials and raw paths
              never appear here.
            </p>
          </header>
          {workspace.toolActivity.slice(0, 20).map((activity) => (
            <RuntimeToolActivityCard key={activity.id} activity={activity} />
          ))}
        </section>
      )}
      {mcpOpen && (
        <div
          className="popover-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMcpOpen(false);
          }}
        >
          <form
            className="provider-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              connectMcp();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">Isolated MCP session</span>
                <h2>Connect MCP server</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setMcpOpen(false)}
                aria-label="Close MCP form"
              >
                <Icon name="x" />
              </button>
            </header>
            <label>
              Connection name
              <input
                autoFocus
                value={mcpName}
                onChange={(event) => setMcpName(event.target.value)}
              />
            </label>
            <label>
              Transport
              <select
                value={mcpTransport}
                onChange={(event) => {
                  setMcpTransport(event.target.value as 'stdio' | 'streamable-http');
                  setMcpEndpoint('');
                }}
              >
                <option value="streamable-http">Remote Streamable HTTP</option>
                <option value="stdio">Registered local stdio manifest</option>
              </select>
            </label>
            {mcpTransport === 'streamable-http' ? (
              <label>
                HTTPS origin
                <input
                  type="url"
                  value={mcpEndpoint}
                  onChange={(event) => setMcpEndpoint(event.target.value)}
                  placeholder="https://mcp.example.com"
                />
              </label>
            ) : (
              <label>
                Registered manifest
                <select
                  value={mcpEndpoint}
                  onChange={(event) => setMcpEndpoint(event.target.value)}
                >
                  <option value="">Choose a registered manifest</option>
                  {tools
                    .filter((tool) => tool.kind === 'custom')
                    .map((tool) => (
                      <option value={tool.id} key={tool.id}>
                        {tool.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="security-note">
              <Icon name="shield" />
              <div>
                <strong>
                  {mcpTransport === 'streamable-http'
                    ? 'Cloud destination · OAuth/PKCE required when advertised'
                    : 'Local destination · no raw command strings'}
                </strong>
                <p>
                  Origin validation, isolated sessions, allowed-tool filters, and schema fingerprint
                  approval are enforced by the broker. A changed fingerprint invalidates prior
                  grants.
                </p>
              </div>
            </div>
            {mcpError && (
              <p className="field-error" role="alert">
                {mcpError}
              </p>
            )}
            <footer>
              <button type="button" className="button" onClick={() => setMcpOpen(false)}>
                Cancel
              </button>
              <span />
              <button className="button button--primary">Review and connect</button>
            </footer>
          </form>
        </div>
      )}
    </main>
  );
}

function SearchView({ setView }: { setView: (v: View) => void }) {
  const workspace = useWorkspace();
  const [query, setQuery] = useState(workspace.fixtureMode ? 'architecture' : '');
  const [loading, setLoading] = useState(false);
  const [globalScope, setGlobalScope] = useState(false);
  const doSearch = (v: string) => {
    setQuery(v);
    setLoading(true);
    void workspace.querySearch(v, globalScope).finally(() => setLoading(false));
  };
  const fixtureGroups = [
    {
      title: 'Conversations',
      icon: 'chat' as IconName,
      items: [
        {
          title: 'Architecture review',
          text: 'The cleanest boundary is to keep product truth separate from framework state…',
          meta: 'Cupcake 2.0 · 8 min ago',
        },
      ],
    },
    {
      title: 'Artifacts',
      icon: 'artifact' as IconName,
      items: [
        {
          title: 'CUPCAKEAGI architecture.md',
          text: 'Runtime boundaries · Storage · Project isolation',
          meta: 'Document · revision 4',
        },
      ],
    },
    {
      title: 'Memory',
      icon: 'memory' as IconName,
      items: [
        {
          title: 'Model selection',
          text: 'Model choice stays explicit. Automatic model routing is out of scope.',
          meta: 'Decision · Cupcake 2.0',
        },
      ],
    },
    {
      title: 'Files',
      icon: 'file' as IconName,
      items: [
        {
          title: 'architecture.md',
          text: 'docs / architecture / architecture.md',
          meta: '18.4 KB · indexed locally',
        },
      ],
    },
  ];
  const liveSearchGroups = workspace.searchResults.reduce<Record<string, SearchRecord[]>>(
    (all, item) => {
      const key = cap(item.entityType);
      (all[key] ??= []).push(item);
      return all;
    },
    {},
  );
  const groups = workspace.fixtureMode
    ? fixtureGroups
    : Object.entries(liveSearchGroups).map(([title, items]) => ({
        title,
        icon: title.toLowerCase().includes('artifact')
          ? 'artifact'
          : title.toLowerCase().includes('memory')
            ? 'memory'
            : title.toLowerCase().includes('file')
              ? 'file'
              : 'chat',
        items: items.map((item) => ({
          title: item.title,
          text: item.snippet,
          meta: item.projectId ? `Project ${item.projectId}` : 'Global result',
        })),
      }));
  return (
    <main className="page search-page">
      <div className="search-hero">
        <p className="eyebrow">Across everything you’ve made</p>
        <div className="global-search">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => doSearch(e.target.value)}
            placeholder="Search chats, files, projects, memory, tasks…"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="search-scopes">
          <button
            className={!globalScope ? 'is-active' : ''}
            onClick={() => {
              setGlobalScope(false);
              void workspace.querySearch(query, false);
            }}
          >
            Active project
          </button>
          <button
            className={globalScope ? 'is-active' : ''}
            onClick={() => {
              setGlobalScope(true);
              void workspace.querySearch(query, true);
            }}
          >
            Everything
          </button>
        </div>
      </div>
      {!query ? (
        <EmptyState
          icon="search"
          title="Find anything you’ve worked on"
          body="Search by phrase, filename, project, or what you remember about it."
        />
      ) : loading ? (
        <div className="search-loading">
          {[1, 2, 3, 4].map((n) => (
            <span key={n} />
          ))}
        </div>
      ) : (
        <div className="search-results">
          <div className="result-summary">
            <span>
              {workspace.searchResults.length ||
                groups.reduce((count, group) => count + group.items.length, 0)}{' '}
              results for <strong>“{query}”</strong>
            </span>
            <span>Lexical results · semantic matches still arriving</span>
          </div>
          {groups.map((group) => (
            <section className="result-group" key={group.title}>
              <header>
                <Icon name={group.icon as IconName} />
                <h2>{group.title}</h2>
                <span>{group.items.length}</span>
              </header>
              {group.items.map((item) => (
                <button
                  onClick={() =>
                    setView(
                      group.title === 'Artifacts'
                        ? 'artifacts'
                        : group.title === 'Memory'
                          ? 'memory'
                          : 'chat',
                    )
                  }
                  key={item.title}
                >
                  <span>
                    <strong>{item.title}</strong>
                    <p>{item.text}</p>
                    <small>{item.meta}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function SettingsView({
  theme,
  setTheme,
  developerMode,
  setDeveloperMode,
  offline,
  setOffline,
  providerStates,
  openProvider,
  proactiveEnabled,
  setProactiveEnabled,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  developerMode: boolean;
  setDeveloperMode: (v: boolean) => void;
  offline: boolean;
  setOffline: (v: boolean) => void;
  providerStates: Record<string, boolean>;
  openProvider: (provider: string) => void;
  proactiveEnabled: boolean;
  setProactiveEnabled: (enabled: boolean) => void;
}) {
  const workspace = useWorkspace();
  const tabs = [
    'General',
    'Personality',
    'Appearance',
    'Privacy',
    'Providers',
    'Storage',
    'Shortcuts',
  ] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]>('Personality');
  const [clearReview, setClearReview] = useState(false);
  const [clearScopes, setClearScopes] = useState<string[]>([]);
  const [clearPhrase, setClearPhrase] = useState('');
  const [clearPlan, setClearPlan] = useState<Record<string, unknown> | null>(null);
  const [clearUndo, setClearUndo] = useState(false);
  const [preset, setPreset] = useState(cap(workspace.settings.personalityPreset));
  const [values, setValues] = useState({
    Warmth: Math.round(workspace.settings.personality.warmth * 100),
    Brevity: Math.round(workspace.settings.personality.brevity * 100),
    Initiative: Math.round(workspace.settings.personality.initiative * 100),
  });
  const providers = [
    ['OpenAI', 'openai'],
    ['Anthropic', 'anthropic'],
    ['Google', 'google'],
    ['xAI', 'xai'],
    ['Mistral', 'mistral'],
    ['Cohere', 'cohere'],
    ['NVIDIA NIM', 'nvidia-nim'],
  ] as const;
  const semanticModels = workspace.models.filter(
    (model) =>
      model.provider === 'NVIDIA NIM' && model.tags.some((tag) => /embed|rerank/i.test(tag)),
  );
  return (
    <main className="settings-layout">
      <aside>
        <h2>Settings</h2>
        {tabs.map((t) => (
          <button className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)} key={t}>
            <Icon
              name={
                t === 'Personality'
                  ? 'sparkle'
                  : t === 'Appearance'
                    ? 'palette'
                    : t === 'Privacy'
                      ? 'shield'
                      : t === 'Providers'
                        ? 'key'
                        : t === 'Storage'
                          ? 'database'
                          : t === 'Shortcuts'
                            ? 'command'
                            : 'settings'
              }
            />
            {t}
          </button>
        ))}
      </aside>
      <section className="settings-content">
        <div className="settings-title">
          <p className="eyebrow">Make it yours</p>
          <h1>{tab}</h1>
          <p>
            {tab === 'Personality'
              ? 'Tune how Cupcake communicates. These settings never alter the substance of your work.'
              : `Control ${tab.toLowerCase()} preferences for this local profile.`}
          </p>
        </div>
        {tab === 'Personality' && (
          <>
            <section className="settings-section">
              <header>
                <h2>Preset</h2>
                <p>A considered starting point. Fine-tune it below.</p>
              </header>
              <div className="preset-grid">
                {['Classic Cupcake', 'Balanced', 'Focused', 'Playful'].map((p, i) => (
                  <button
                    className={preset === p ? 'is-active' : ''}
                    onClick={() => {
                      setPreset(p);
                      const key =
                        p === 'Focused'
                          ? 'concise'
                          : p === 'Playful'
                            ? 'warm'
                            : p === 'Classic Cupcake'
                              ? 'warm'
                              : 'balanced';
                      void workspace.updateSettings({ personalityPreset: key });
                    }}
                    key={p}
                  >
                    <span className={`preset-face face-${i}`}>
                      <i />
                      <i />
                      <b />
                    </span>
                    <strong>{p}</strong>
                    <small>
                      {i === 0
                        ? 'Warm, curious, a little silly'
                        : i === 1
                          ? 'Warm, clear, and capable'
                          : i === 2
                            ? 'Direct and low-distraction'
                            : 'Expressive and conversational'}
                    </small>
                    {preset === p && <Icon name="check" />}
                  </button>
                ))}
              </div>
            </section>
            <section className="settings-section">
              <header>
                <h2>Tone and behavior</h2>
                <p>Adjust the balance for new conversations.</p>
              </header>
              <div className="slider-list">
                {Object.entries(values).map(([name, value]) => (
                  <label key={name}>
                    <span>
                      <strong>{name}</strong>
                      <small>
                        {name === 'Warmth'
                          ? 'Neutral ↔ Warm'
                          : name === 'Brevity'
                            ? 'Thorough ↔ Concise'
                            : 'Reactive ↔ Proactive'}
                      </small>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={value}
                      onChange={(e) => {
                        const amount = Number(e.target.value);
                        setPreset('Custom');
                        const next = { ...values, [name]: amount };
                        setValues(next);
                        void workspace.updateSettings({
                          personalityPreset: 'custom',
                          personality: {
                            warmth: next.Warmth / 100,
                            brevity: next.Brevity / 100,
                            initiative: next.Initiative / 100,
                          },
                        });
                      }}
                      style={{ '--value': `${value}%` } as React.CSSProperties}
                    />
                    <output>{value}</output>
                  </label>
                ))}
              </div>
            </section>
            <section className="settings-section">
              <header>
                <h2>Custom instructions</h2>
                <p>
                  Visible communication guidance sent with new agent runs. Never hidden reasoning.
                </p>
              </header>
              <label>
                Instructions
                <textarea
                  value={workspace.settings.personalityInstructions}
                  onChange={(event) =>
                    void workspace.updateSettings({ personalityInstructions: event.target.value })
                  }
                  placeholder="For example: Lead with the decision and show exact tradeoffs."
                />
              </label>
              {clearPlan && (
                <div className="security-note" role="status">
                  <Icon name="database" />
                  <div>
                    <strong>Broker-bound removal plan</strong>
                    <p>
                      Counts/bytes:{' '}
                      {JSON.stringify(
                        clearPlan.counts ?? clearPlan.categories ?? 'reported by broker',
                      )}
                    </p>
                    <p>
                      Retained:{' '}
                      {JSON.stringify(
                        clearPlan.retained ?? 'security audit and quarantine manifest',
                      )}
                    </p>
                    <small>
                      {clearPlan.backupStatus
                        ? `Backup: ${typeof clearPlan.backupStatus === 'string' ? clearPlan.backupStatus : JSON.stringify(clearPlan.backupStatus)}. `
                        : ''}
                      The app will restart. Data moves atomically to recoverable quarantine until
                      this app session ends.
                    </small>
                  </div>
                </div>
              )}
            </section>
            <section className="personality-preview">
              <img src="/brand/cupcake-mark.svg" alt="" />
              <div>
                <span className="eyebrow">Preview</span>
                <p>
                  “I found the race condition. The short version: two writers can claim the same
                  checkpoint. I’d bind the lease to a monotonic generation and test recovery after a
                  forced exit.”
                </p>
                <small>Balanced · technical context</small>
              </div>
            </section>
          </>
        )}
        {tab === 'Appearance' && (
          <section className="settings-section">
            <header>
              <h2>Theme</h2>
              <p>Each theme keeps the same hierarchy and accessibility behavior.</p>
            </header>
            <div className="theme-grid">
              {(['light', 'dark', 'minimal', 'classic'] as Theme[]).map((t) => (
                <button
                  className={cx(`theme-card theme-card--${t}`, theme === t && 'is-active')}
                  onClick={() => setTheme(t)}
                  key={t}
                >
                  <span className="theme-sample">
                    <i />
                    <b />
                    <em />
                    <small />
                  </span>
                  <strong>
                    {t === 'light' ? 'Cupcake Light' : t === 'dark' ? 'Cupcake Dark' : cap(t)}
                  </strong>
                  {theme === t && <Icon name="check" />}
                </button>
              ))}
            </div>
            <div className="setting-row">
              <span>
                <strong>Reduce motion</strong>
                <small>Remove translations, flourishes, and smooth scrolling.</small>
              </span>
              <Toggle
                checked={workspace.settings.reducedMotion}
                onChange={() =>
                  void workspace.updateSettings({
                    reducedMotion: !workspace.settings.reducedMotion,
                  })
                }
                label="Reduce motion"
              />
            </div>
          </section>
        )}
        {tab === 'General' && (
          <section className="settings-section">
            <div className="setting-row">
              <span>
                <strong>Offline mode</strong>
                <small>Use only local models and tools. No content leaves this computer.</small>
              </span>
              <Toggle
                checked={offline}
                onChange={() => setOffline(!offline)}
                label="Offline mode"
              />
            </div>
            <div className="setting-row">
              <span>
                <strong>Developer mode</strong>
                <small>Show redacted traces, checkpoints, costs, and subagents.</small>
              </span>
              <Toggle
                checked={developerMode}
                onChange={() => setDeveloperMode(!developerMode)}
                label="Developer mode"
              />
            </div>
            <div className="setting-row">
              <span>
                <strong>Thoughts and Dreams</strong>
                <small>Occasional, quiet memory connections on Home. Disabled by default.</small>
              </span>
              <Toggle
                checked={proactiveEnabled}
                onChange={() => setProactiveEnabled(!proactiveEnabled)}
                label="Thoughts and Dreams"
              />
            </div>
          </section>
        )}
        {tab === 'Privacy' && (
          <>
            <section className="settings-section">
              <header>
                <h2>Data destinations</h2>
                <p>Cupcake shows Local or Cloud before your content moves.</p>
              </header>
              <div className="setting-row">
                <span>
                  <strong>Ask before sending attached files</strong>
                  <small>Confirm the provider and file list for each new destination.</small>
                </span>
                <span className="route-badge">
                  <Icon name="shield" size={12} />
                  Required policy
                </span>
              </div>
              <div className="setting-row">
                <span>
                  <strong>Sensitive memory confirmation</strong>
                  <small>Never infer sensitive facts or instructions without approval.</small>
                </span>
                <span className="route-badge">
                  <Icon name="shield" size={12} />
                  Required policy
                </span>
              </div>
              <div className="setting-row">
                <span>
                  <strong>Cloud semantic enrichment</strong>
                  <small>
                    Lexical FTS stays default. Opt in to send retrieval text to a named NVIDIA Cloud
                    embedding/reranking model.
                  </small>
                </span>
                <Toggle
                  checked={workspace.settings.semanticEnrichment.enabled}
                  onChange={() =>
                    void workspace.updateSettings({
                      semanticEnrichment: workspace.settings.semanticEnrichment.enabled
                        ? { enabled: false, provider: null, modelId: null }
                        : semanticModels[0]
                          ? {
                              enabled: true,
                              provider: 'nvidia-nim',
                              modelId: semanticModels[0].runtimeModelId ?? semanticModels[0].id,
                            }
                          : { enabled: false, provider: null, modelId: null },
                    })
                  }
                  label="Use NVIDIA Cloud semantic enrichment"
                />
              </div>
              {workspace.settings.semanticEnrichment.enabled && (
                <div className="destination-card">
                  <RouteBadge route="Cloud" />
                  <strong>
                    NVIDIA API Catalog · {workspace.settings.semanticEnrichment.modelId}
                  </strong>
                  <p>
                    Selected project text may leave this computer for embeddings/reranking. This
                    never changes the chat model and can be disabled at any time.
                  </p>
                  <select
                    aria-label="NVIDIA semantic model"
                    value={workspace.settings.semanticEnrichment.modelId ?? ''}
                    onChange={(event) =>
                      void workspace.updateSettings({
                        semanticEnrichment: {
                          enabled: true,
                          provider: 'nvidia-nim',
                          modelId: event.target.value,
                        },
                      })
                    }
                  >
                    {semanticModels.map((model) => (
                      <option key={model.id} value={model.runtimeModelId ?? model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {!semanticModels.length && (
                <p className="field-error">
                  Connect NVIDIA NIM and refresh its catalog before cloud semantic enrichment can be
                  enabled.
                </p>
              )}
            </section>
            <section className="settings-section danger-zone">
              <header>
                <h2>Clear local data</h2>
                <p>Export a backup before removing conversations, files, memory, and tasks.</p>
              </header>
              <button className="button button--danger" onClick={() => setClearReview(true)}>
                Review data to remove
              </button>
            </section>
          </>
        )}
        {tab === 'Providers' && (
          <section className="settings-section">
            <header>
              <h2>Provider credentials</h2>
              <p>
                Keys are encrypted for this Windows user with DPAPI and never stored in project
                files.
              </p>
            </header>
            {providers.map(([name, id]) => (
              <div className="provider-row" key={id}>
                <span className="provider-logo">{name.charAt(0)}</span>
                <span>
                  <strong>{name}</strong>
                  <small>
                    {providerStates[id]
                      ? 'Connected · protected by Windows DPAPI'
                      : 'Not connected'}
                  </small>
                </span>
                <RouteBadge route="Cloud" />
                <button className="button" onClick={() => openProvider(id)}>
                  {providerStates[id] ? 'Manage' : 'Connect'}
                </button>
              </div>
            ))}
          </section>
        )}
        {tab === 'Storage' && (
          <section className="settings-section">
            <header>
              <h2>Local storage</h2>
              <p>Encrypted databases and object files stay on this computer.</p>
            </header>
            <div className="storage-chart">
              <div>
                <i className="db" style={{ width: '18%' }} />
                <i className="objects" style={{ width: '54%' }} />
                <i className="models" style={{ width: '28%' }} />
              </div>
              <span>7.8 GB used</span>
            </div>
            <div className="setting-row">
              <span>
                <strong>Backups</strong>
                <small>Last backup: Today at 09:20 · verified</small>
              </span>
              <button className="button" onClick={() => void workspace.createBackup()}>
                Back up now
              </button>
            </div>
            <div className="setting-row">
              <span>
                <strong>Diagnostic retention</strong>
                <small>Redacted developer events are deleted after 30 days.</small>
              </span>
              <button className="select-button">
                30 days <Icon name="chevron" />
              </button>
            </div>
          </section>
        )}
        {tab === 'Shortcuts' && (
          <section className="settings-section shortcut-list">
            <header>
              <h2>Keyboard shortcuts</h2>
              <p>Every shortcut also has a visible control.</p>
            </header>
            {[
              ['Command palette', 'Ctrl', 'K'],
              ['New chat', 'Ctrl', 'N'],
              ['Focus composer', '/', ''],
              ['Global search', 'Ctrl + Shift', 'F'],
              ['Model picker', 'Ctrl', 'M'],
              ['Attach file', 'Ctrl', 'U'],
              ['Stop generation', 'Ctrl', '.'],
            ].map((keys) => (
              <div key={keys[0]}>
                <span>{keys[0]}</span>
                <span>
                  <kbd>{keys[1]}</kbd>
                  {keys[2] && (
                    <>
                      <b>+</b>
                      <kbd>{keys[2]}</kbd>
                    </>
                  )}
                </span>
              </div>
            ))}
          </section>
        )}
        {clearReview && (
          <div className="popover-layer">
            <section
              className="provider-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Clear selected local data"
            >
              <header>
                <div>
                  <span className="eyebrow">Destructive local action</span>
                  <h2>Choose exactly what to remove</h2>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setClearReview(false)}
                  aria-label="Cancel data removal"
                >
                  <Icon name="x" />
                </button>
              </header>
              <div className="security-note">
                <Icon name="shield" />
                <div>
                  <strong>Create a backup first.</strong>
                  <p>
                    Deleted records are removed from active encrypted storage. Artifact objects
                    become reclaimable after retention cleanup; without a backup, content may not be
                    recoverable.
                  </p>
                </div>
              </div>
              <fieldset>
                <legend>Local data scopes</legend>
                {[
                  'conversations',
                  'projects',
                  'tasks',
                  'artifacts',
                  'memory',
                  'developer-events',
                ].map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={clearScopes.includes(scope)}
                      onChange={(event) => {
                        setClearPlan(null);
                        setClearScopes((items) =>
                          event.target.checked
                            ? [...items, scope]
                            : items.filter((item) => item !== scope),
                        );
                      }}
                    />{' '}
                    {cap(scope)}
                  </label>
                ))}
              </fieldset>
              <label>
                Type DELETE SELECTED LOCAL DATA
                <input
                  value={clearPhrase}
                  onChange={(event) => setClearPhrase(event.target.value)}
                />
              </label>
              <footer>
                <button className="button" onClick={() => void workspace.createBackup()}>
                  Create backup
                </button>
                <span />
                <button className="button" onClick={() => setClearReview(false)}>
                  Cancel
                </button>
                <button
                  className="button button--danger"
                  disabled={!clearScopes.length || clearPhrase !== 'DELETE SELECTED LOCAL DATA'}
                  onClick={() => {
                    if (!clearPlan) {
                      void workspace.preflightClearData(clearScopes).then(setClearPlan);
                      return;
                    }
                    void workspace.executeClearData(clearPlan).then(() => {
                      setClearUndo(true);
                      setClearReview(false);
                      setClearPlan(null);
                    });
                  }}
                >
                  {clearPlan ? 'Fresh approve and quarantine' : 'Review exact counts'}
                </button>
              </footer>
            </section>
          </div>
        )}
        {clearUndo && (
          <div className="callout" role="status">
            <Icon name="history" />
            <p>Selected local data is quarantined and recoverable until this app exits.</p>
            <button
              className="text-button"
              onClick={() => void workspace.undoClearData().then(() => setClearUndo(false))}
            >
              Undo clear
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function DeveloperView({ modelName }: { modelName: string }) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState('Events');
  const fixtureEvents = [
    {
      time: '10:45:12.804',
      type: 'message.completed',
      detail: 'run_019d… · 2,184 tokens · $0.042',
      tone: 'green',
    },
    {
      time: '10:45:11.221',
      type: 'artifact.created',
      detail: 'architecture.md · revision 4 · 18.4 KB',
      tone: 'blue',
    },
    {
      time: '10:44:58.093',
      type: 'retrieval.completed',
      detail: '6 sources · 412 ms · project boundary applied',
      tone: 'berry',
    },
    {
      time: '10:44:44.611',
      type: 'checkpoint.saved',
      detail: 'workflow repository-redesign · step 3/5',
      tone: 'grey',
    },
    {
      time: '10:44:39.020',
      type: 'subagent.completed',
      detail: 'researcher · 4m 38s · 18,220 tokens',
      tone: 'purple',
    },
    {
      time: '10:41:08.312',
      type: 'tool.completed',
      detail: 'web.search · 6 sources · 4.2 s',
      tone: 'green',
    },
  ];
  const events = workspace.fixtureMode
    ? fixtureEvents
    : workspace.runtimeEvents.map((event) => ({
        time: new Date(event.timestamp).toLocaleTimeString([], {
          hour12: false,
          fractionalSecondDigits: 3,
        }),
        type: event.type,
        detail: JSON.stringify(event.payload).slice(0, 220),
        tone: event.type.includes('error')
          ? 'berry'
          : event.type.includes('completed')
            ? 'green'
            : 'blue',
      }));
  return (
    <main className="developer-page">
      <header>
        <div>
          {workspace.fixtureMode ? (
            <span className="fixture-badge">DETERMINISTIC FIXTURE</span>
          ) : workspace.runtimeEvents.length > 0 ? (
            <span className="live-badge">LIVE</span>
          ) : (
            <span className="connection-state">WAITING</span>
          )}
          <h1>Runtime inspector</h1>
          <p>Redacted events and product-level traces. Hidden reasoning is never recorded.</p>
        </div>
        <div>
          <span className="connection-state">
            <StatusDot status="ready" />
            {workspace.fixtureMode
              ? 'Desktop bridge absent'
              : workspace.ready
                ? 'Runtime connected'
                : 'Runtime starting'}
          </span>
          <button className="button">
            <Icon name="download" />
            Export trace
          </button>
        </div>
      </header>
      <div className="dev-metrics">
        <div>
          <span>Active runs</span>
          <strong>{workspace.tasks.filter((task) => task.status === 'working').length}</strong>
          <small>
            {workspace.tasks.filter((task) => task.status === 'waiting').length} waiting for you
          </small>
        </div>
        <div>
          <span>Tokens today</span>
          <strong>
            {workspace.runtimeEvents.filter((event) => event.type === 'usage.updated').length}
          </strong>
          <small>usage events retained</small>
        </div>
        <div>
          <span>p95 latency</span>
          <strong>{workspace.runtimeEvents.length}</strong>
          <small>redacted events in this session</small>
        </div>
        <div>
          <span>Checkpoints</span>
          <strong>{workspace.tasks.length}</strong>
          <small>durable task records</small>
        </div>
      </div>
      <div className="developer-grid">
        <section className="dev-main">
          <div className="dev-tabs">
            {['Events', 'Runs', 'Retrieval', 'Errors'].map((t) => (
              <button className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)} key={t}>
                {t}
                {t === 'Errors' && <span>0</span>}
              </button>
            ))}
          </div>
          <div className="event-toolbar">
            <button>
              <span className="pulse-dot" />
              Streaming
            </button>
            <div className="search-field">
              <Icon name="search" />
              <input placeholder="Filter events" />
            </div>
            <button className="icon-button" aria-label="Clear event filter">
              <Icon name="trash" />
            </button>
          </div>
          <div className="event-table">
            <div className="event-table__head">
              <span>Time</span>
              <span>Event</span>
              <span>Detail</span>
            </div>
            {events.map((e) => (
              <button className="event-row" key={e.time}>
                <code>{e.time}</code>
                <span>
                  <i className={e.tone} />
                  {e.type}
                </span>
                <code>{e.detail}</code>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </section>
        <aside className="run-tree">
          <header>
            <h2>Run tree</h2>
            <span>repository-redesign</span>
          </header>
          {!workspace.fixtureMode && workspace.activeRunId ? (
            <div className="run-node is-main">
              <span className="tree-avatar">
                <img src="/brand/cupcake-mark.svg" />
              </span>
              <div>
                <strong>Cupcake</strong>
                <small>{modelName} · active runtime event lineage</small>
              </div>
              <span className="pulse-dot" />
            </div>
          ) : (
            <EmptyState
              icon="task"
              title={workspace.fixtureMode ? 'Fixture run tree' : 'No active run'}
              body={
                workspace.fixtureMode
                  ? 'Live lineage appears only when the desktop runtime emits it.'
                  : 'Start a chat or durable task to inspect its lineage.'
              }
            />
          )}
          {workspace.fixtureMode && (
            <div className="tree-children">
              <div className="run-node is-done">
                <span className="tree-avatar">R</span>
                <div>
                  <strong>Researcher</strong>
                  <small>18.2k tokens · complete</small>
                </div>
                <Icon name="check" />
              </div>
              <div className="run-node is-active">
                <span className="tree-avatar">C</span>
                <div>
                  <strong>Coder</strong>
                  <small>SQLite fixture · active</small>
                </div>
                <span className="pulse-dot" />
              </div>
              <div className="run-node">
                <span className="tree-avatar">V</span>
                <div>
                  <strong>Reviewer</strong>
                  <small>Queued</small>
                </div>
                <Icon name="clock" />
              </div>
            </div>
          )}
          <section className="run-budget">
            <h3>Run budget</h3>
            <div>
              <span>Tokens</span>
              <strong>32.4k / 80k</strong>
            </div>
            <div className="budget-bar">
              <i style={{ width: '41%' }} />
            </div>
            <div>
              <span>Cost</span>
              <strong>$0.31 / $2.00</strong>
            </div>
            <div className="budget-bar">
              <i style={{ width: '16%' }} />
            </div>
          </section>
          <section className="trace-links">
            <h3>Trace</h3>
            <button>
              <span>trace_id</span>
              <code>019d2c…b841</code>
              <Icon name="copy" />
            </button>
            <button>
              <span>run_id</span>
              <code>run_019d…92c</code>
              <Icon name="copy" />
            </button>
          </section>
        </aside>
      </div>
    </main>
  );
}

function AboutView() {
  const [panel, setPanel] = useState<'licenses' | 'architecture' | null>(null);
  return (
    <main className="about-page">
      <div className="about-hero">
        <div className="classic-rays" />
        <img
          className="about-classic"
          src="/brand/cupcake-classic.png"
          alt="Original glossy Cupcake mascot"
        />
        <div>
          <p className="eyebrow">From the original CUPCAKEAGI</p>
          <h1>
            Still curious.
            <br />
            Much better organized.
          </h1>
          <p>
            The first Cupcake experimented with persistent memory, emotions, thoughts, dreams,
            multimodal input, tools, and asynchronous tasks. Version 2.0 revisits that curiosity as
            a calm, modern text-first workbench.
          </p>
          <div className="about-version">
            <strong>CUPCAKEAGI 2.0</strong>
            <span>Local release candidate</span>
            <span>Unlicense</span>
          </div>
        </div>
      </div>
      <section className="about-values">
        <div>
          <span>01</span>
          <strong>Conversation is the product</strong>
          <p>Type naturally, give Cupcake context, and keep chatting while long work continues.</p>
        </div>
        <div>
          <span>02</span>
          <strong>You choose the model</strong>
          <p>Cloud and local providers share one interface without secret automatic routing.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Memory is inspectable</strong>
          <p>Everything carried forward has a source, scope, and switch you control.</p>
        </div>
      </section>
      <footer className="about-footer">
        <Brand large />
        <div>
          <button className="text-button" onClick={() => setPanel('licenses')}>
            Open source licenses <Icon name="external" />
          </button>
          <button className="text-button" onClick={() => setPanel('architecture')}>
            Architecture notes <Icon name="external" />
          </button>
        </div>
      </footer>
      {panel && (
        <div
          className="popover-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={panel === 'licenses' ? 'Open source licenses' : 'Architecture notes'}
          >
            <header>
              <div>
                <span className="eyebrow">Packaged local information</span>
                <h2>{panel === 'licenses' ? 'Open source licenses' : 'Architecture notes'}</h2>
              </div>
              <button className="icon-button" onClick={() => setPanel(null)} aria-label="Close">
                <Icon name="x" />
              </button>
            </header>
            {panel === 'licenses' ? (
              <div className="security-note">
                <Icon name="file" />
                <div>
                  <strong>Font notices are packaged locally.</strong>
                  <p>
                    Bricolage Grotesque, Atkinson Hyperlegible, and IBM Plex Mono notices are
                    included at <code>/licenses/FONT-NOTICES.txt</code>. The application and
                    dependency notices remain available without opening an external site.
                  </p>
                </div>
              </div>
            ) : (
              <div className="security-note">
                <Icon name="branch" />
                <div>
                  <strong>Four isolated runtime boundaries.</strong>
                  <p>
                    React renders; Electron owns desktop lifecycle; Python owns product state and
                    agent workflows; the verified packaged Rust broker owns credentials, grants,
                    approvals, and privileged execution. The renderer receives opaque handles, never
                    raw paths or secrets.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function ModelPicker({
  open,
  close,
  models,
  select,
}: {
  open: boolean;
  close: () => void;
  models: ModelDescriptor[];
  select: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  if (!open) return null;
  const shown = models.filter(
    (m) =>
      m.name.toLowerCase().includes(query.toLowerCase()) ||
      m.provider.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className="popover-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="model-picker" role="dialog" aria-modal="true" aria-label="Choose model">
        <header>
          <div>
            <span className="eyebrow">Explicit selection</span>
            <h2>Choose a model</h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close model picker">
            <Icon name="x" />
          </button>
        </header>
        <div className="picker-notice">
          <Icon name="info" />
          <span>There is no Auto mode. Cupcake uses exactly the model you select.</span>
        </div>
        <div className="search-field">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
          />
        </div>
        <div className="model-picker__list">
          {shown.map((m) => (
            <button
              className={m.selected ? 'is-active' : ''}
              disabled={
                m.status !== 'ready' ||
                (m.provider === 'NVIDIA NIM' && m.chatCompatibility !== 'chat')
              }
              onClick={() => {
                select(m.id);
                close();
              }}
              key={m.id}
            >
              <span className="provider-logo">{m.provider.charAt(0)}</span>
              <span>
                <strong>{m.name}</strong>
                <small>
                  {m.provider} · {m.context} context · {m.cost}
                </small>
                <span className="model-tags">
                  {m.tags.slice(0, 3).map((t) => (
                    <em key={t}>{t}</em>
                  ))}
                </span>
              </span>
              <RouteBadge route={m.route} />
              {m.selected && <Icon name="check" />}
              {m.status !== 'ready' && (
                <small className="unavailable">
                  {m.status === 'setup'
                    ? 'Set up'
                    : m.status === 'offline'
                      ? 'Offline'
                      : 'Downloading'}
                </small>
              )}
              {m.provider === 'NVIDIA NIM' && m.chatCompatibility !== 'chat' && (
                <small className="unavailable">Chat compatibility unverified</small>
              )}
            </button>
          ))}
        </div>
        <footer>
          <button className="text-button">
            Manage models <Icon name="chevron" />
          </button>
          <span>Ctrl M</span>
        </footer>
      </div>
    </div>
  );
}

function ProviderDialog({
  provider,
  close,
  connected,
}: {
  provider: string | null;
  close: () => void;
  connected: (provider: string, value: boolean) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  useEffect(() => {
    setStatus('idle');
  }, [provider]);
  if (!provider) return null;
  const save = async () => {
    if (!window.cupcake) return;
    setStatus('saving');
    const response = await window.cupcake.runtime.request({
      method: 'providers.connectInteractive',
      params: { provider },
      timeoutMs: 120000,
    });
    if (response.ok) {
      connected(provider, true);
      close();
    } else setStatus('error');
  };
  const disconnect = async () => {
    if (!window.cupcake) return;
    const response = await window.cupcake.runtime.request({
      method: 'providers.disconnect',
      params: { provider },
    });
    if (response.ok) {
      connected(provider, false);
      close();
    }
  };
  return (
    <div
      className="popover-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="provider-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">Windows credential vault</span>
            <h2>Connect {cap(provider)}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close provider dialog"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="security-note">
          <Icon name="shield" />
          <div>
            <strong>Protected for this Windows user.</strong>
            <p>
              Continue to Windows Credential UI. The verified packaged broker receives the key
              directly, encrypts it with DPAPI, and returns only connection status to this screen.
            </p>
          </div>
        </div>
        {status === 'error' && (
          <p className="field-error" role="alert">
            The broker could not store this key. Open Developer Mode for the redacted error.
          </p>
        )}
        <footer>
          <button type="button" className="button button--danger" onClick={() => void disconnect()}>
            Disconnect
          </button>
          <span />
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button className="button button--primary" disabled={status === 'saving'}>
            {status === 'saving' ? 'Waiting for Windows…' : 'Continue in Windows'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function CommandPalette({
  open,
  close,
  setView,
  openModel,
}: {
  open: boolean;
  close: () => void;
  setView: (v: View) => void;
  openModel: () => void;
}) {
  const [query, setQuery] = useState('');
  if (!open) return null;
  const commands: {
    label: string;
    detail: string;
    icon: IconName;
    action: () => void;
    key?: string;
  }[] = [
    {
      label: 'New chat',
      detail: 'Start a clean conversation',
      icon: 'edit',
      action: () => setView('chat'),
      key: 'Ctrl N',
    },
    {
      label: 'Change model',
      detail: 'Select a cloud or local model',
      icon: 'model',
      action: openModel,
      key: 'Ctrl M',
    },
    {
      label: 'Attach a file',
      detail: 'Add local context to the current chat',
      icon: 'paperclip',
      action: () => setView('chat'),
      key: 'Ctrl U',
    },
    {
      label: 'Search everything',
      detail: 'Chats, projects, files, tasks, and memory',
      icon: 'search',
      action: () => setView('search'),
      key: 'Ctrl Shift F',
    },
    {
      label: 'Open memory',
      detail: 'Review what Cupcake remembers',
      icon: 'memory',
      action: () => setView('memory'),
    },
    {
      label: 'Open tasks',
      detail: 'See durable background work',
      icon: 'task',
      action: () => setView('tasks'),
    },
    {
      label: 'Open project',
      detail: 'Switch the active context boundary',
      icon: 'project',
      action: () => setView('projects'),
    },
    {
      label: 'Settings',
      detail: 'Appearance, personality, privacy, and more',
      icon: 'settings',
      action: () => setView('settings'),
    },
  ];
  const shown = commands.filter((c) =>
    `${c.label} ${c.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className="popover-layer command-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What would you like to do?"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results">
          <span>Commands</span>
          {shown.map((c, i) => (
            <button
              className={i === 0 ? 'is-active' : ''}
              key={c.label}
              onClick={() => {
                c.action();
                close();
              }}
            >
              <Icon name={c.icon} />
              <span>
                <strong>{c.label}</strong>
                <small>{c.detail}</small>
              </span>
              {c.key && <kbd>{c.key}</kbd>}
              <Icon name="chevron" />
            </button>
          ))}
          {!shown.length && (
            <EmptyState icon="search" title="No matching command" body="Try a shorter phrase." />
          )}
        </div>
        <footer>
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}

function LegacyFixtureApp() {
  const [view, setView] = useState<View>(initialView);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [developerMode, setDeveloperMode] = useState(true);
  const [offline, setOffline] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [models, setModels] = useState(initialModels);
  const [conversationRecords, setConversationRecords] = useState(initialConversations);
  const [taskList, setTaskList] = useState(initialTasks);
  const [activeTask, setActiveTask] = useState(taskList[0]!);
  const [memoryRecords, setMemoryRecords] = useState(initialMemories);
  const [toolRecords, setToolRecords] = useState(initialTools);
  const [toast, setToast] = useState('');
  const [liveMessages, setLiveMessages] = useState<LiveChatMessage[]>([]);
  const [providerDialog, setProviderDialog] = useState<string | null>(null);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [providerStates, setProviderStates] = useState<Record<string, boolean>>({});
  const [proactiveEnabled, setProactiveEnabled] = useState(false);
  void liveMessages;
  void shortcutOpen;
  void setShortcutOpen;
  const activeRun = useRef<string | null>(null);
  const selectedModel = useMemo(
    () => models.find((m) => m.selected) ?? initialModels[0]!,
    [models],
  );
  const selectModel = (id: string) => {
    const model = models.find((m) => m.id === id);
    setModels((list) => list.map((m) => ({ ...m, selected: m.id === id })));
    setToast(`Model changed to ${model?.name}`);
    if (model?.runtimeModelId)
      void window.cupcake?.runtime.request({
        method: 'models.select',
        params: { modelId: model.runtimeModelId },
      });
  };
  const navigate = (next: View) => {
    setView(next);
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cupcake-theme', theme);
  }, [theme]);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      const editing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((v) => !v);
      } else if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        navigate('chat');
      } else if (meta && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setModelOpen(true);
      } else if (meta && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        navigate('search');
      } else if (!editing && !meta && event.key === '/') {
        event.preventDefault();
        window.dispatchEvent(new Event('cupcake:focus-composer'));
      } else if (meta && event.key === '.') {
        event.preventDefault();
        window.dispatchEvent(new Event('cupcake:stop'));
      } else if (event.key === 'Escape') {
        setCommandOpen(false);
        setModelOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(
    () =>
      window.cupcake?.commands.onCommand((command) => {
        if (command === 'chat.new') navigate('chat');
        else if (command === 'chat.stop') window.dispatchEvent(new Event('cupcake:stop'));
        else if (command === 'file.attach') window.dispatchEvent(new Event('cupcake:attach'));
        else if (command === 'search.open') navigate('search');
        else if (command === 'view.command-palette') setCommandOpen(true);
        else if (command === 'view.model-picker') setModelOpen(true);
        else if (command === 'app.preferences') navigate('settings');
        else if (command === 'app.about') navigate('about');
        else if (command === 'view.frosting-thread')
          document.getElementById('turn-answer')?.scrollIntoView({ block: 'start' });
      }),
    [],
  );
  useEffect(() => {
    if (!window.cupcake) return;
    void window.cupcake.runtime
      .request<{
        conversations?: Array<{
          id: string;
          title: string;
          project_id?: string | null;
          updated_at: string;
        }>;
      }>({ method: 'app.bootstrap' })
      .then((response) => {
        if (response.ok) {
          setToast('Local runtime connected');
          if (response.result?.conversations)
            setConversationRecords(
              response.result.conversations.map((conversation) => ({
                id: conversation.id,
                title: conversation.title,
                preview: 'No messages yet',
                updated: new Date(conversation.updated_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                }),
                ...(conversation.project_id ? { project: conversation.project_id } : {}),
              })),
            );
        }
      });
    void window.cupcake.runtime
      .request<RuntimeMemoryRecord[]>({ method: 'memory.list' })
      .then((response) => {
        if (response.ok && response.result)
          setMemoryRecords(
            response.result.map((memory) => ({
              id: memory.id,
              type:
                memory.kind === 'temporary_context'
                  ? 'Temporary'
                  : (cap(memory.kind) as MemoryRecord['type']),
              title: memory.key,
              body: memory.content,
              scope: memory.scope.project_id ?? 'About me',
              source: memory.state === 'candidate' ? 'Suggested memory' : 'Saved memory',
              confidence: memory.confidence,
              enabled: memory.state === 'active',
            })),
          );
      });
    void window.cupcake.runtime
      .request<RuntimeTaskRecord[]>({ method: 'tasks.list' })
      .then((response) => {
        if (response.ok && response.result)
          setTaskList(
            response.result.map((run) => {
              const stepCount = run.spec.steps.length;
              return {
                id: run.run_id,
                title: run.spec.title,
                detail: run.spec.prompt,
                status:
                  run.status === 'succeeded'
                    ? 'complete'
                    : run.status === 'failed' || run.status === 'cancelled'
                      ? 'failed'
                      : run.status.startsWith('waiting')
                        ? 'waiting'
                        : 'working',
                progress: stepCount ? Math.round((run.current_step / stepCount) * 100) : 0,
                project: run.spec.project_id ?? 'No project',
                elapsed: 'Recovered',
                steps: run.spec.steps.map((step, index) => ({
                  label: step.key,
                  state:
                    index < run.current_step
                      ? 'complete'
                      : index === run.current_step
                        ? 'active'
                        : 'queued',
                })),
              } satisfies Task;
            }),
          );
      });
    void window.cupcake.runtime
      .request<{ providers?: Array<{ provider: string; configured: boolean }> }>({
        method: 'providers.status',
      })
      .then((response) => {
        if (response.ok && response.result?.providers) {
          const states = Object.fromEntries(
            response.result.providers.map((item) => [item.provider, item.configured]),
          );
          setProviderStates(states);
          setModels((list) =>
            list.map((model) =>
              providerIdByName[model.provider]
                ? {
                    ...model,
                    status: states[providerIdByName[model.provider]!] ? 'ready' : 'setup',
                  }
                : model,
            ),
          );
        }
      });
    return window.cupcake.runtime.onEvent((event) => {
      const payload = event.payload as
        { runId?: string; delta?: string; content?: string; task?: { title?: string } } | undefined;
      const runId = payload?.runId;
      if (event.type === 'message.started' && runId) {
        activeRun.current = runId;
        setLiveMessages((messages) =>
          messages.some((message) => message.id === runId)
            ? messages
            : [...messages, { id: runId, role: 'assistant', content: '', streaming: true }],
        );
      } else if (event.type === 'message.delta' && runId && payload?.delta) {
        setLiveMessages((messages) =>
          messages.map((message) =>
            message.id === runId
              ? { ...message, content: message.content + payload.delta }
              : message,
          ),
        );
      } else if (event.type === 'message.completed' && runId) {
        activeRun.current = null;
        setLiveMessages((messages) =>
          messages.map((message) =>
            message.id === runId
              ? { ...message, content: payload.content ?? message.content, streaming: false }
              : message,
          ),
        );
      } else if (event.type === 'task.queued') {
        setLiveMessages((messages) => [
          ...messages,
          {
            id: `task-${event.sequence}`,
            role: 'status',
            content: `Working in the background${payload?.task?.title ? `: ${payload.task.title}` : '.'}`,
          },
        ]);
      }
    });
  }, []);
  useEffect(() => {
    const cancel = () => {
      if (activeRun.current) void window.cupcake?.runtime.cancel(activeRun.current);
    };
    window.addEventListener('cupcake:stop', cancel);
    return () => window.removeEventListener('cupcake:stop', cancel);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);
  const topbarNeeded = ![
    'home',
    'chat',
    'task',
    'artifacts',
    'settings',
    'developer',
    'about',
  ].includes(view);
  const homeComposer = (
    <Composer
      onSend={(input) => {
        navigate('chat');
        sendChat(input.content);
      }}
      onModel={() => setModelOpen(true)}
      selectedModel={selectedModel}
      offline={offline}
    />
  );
  const sendChat = (content: string) => {
    const id = `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setLiveMessages((messages) => [...messages, { id, role: 'user', content }]);
    if (!window.cupcake) {
      setLiveMessages((messages) => [
        ...messages,
        {
          id: `${id}-reply`,
          role: 'assistant',
          content:
            'Desktop runtime is unavailable in web preview. Your message remains in this local fixture.',
        },
      ]);
      return;
    }
    void window.cupcake.runtime
      .request<{ runId?: string; content?: string; conversationId?: string }>({
        method: 'chat.send',
        params: { content, modelId: selectedModel.runtimeModelId ?? 'mock:cupcake-deterministic' },
        timeoutMs: 120000,
      })
      .then((response) => {
        const result = response.result;
        if (response.ok && result?.conversationId) {
          const conversationId = result.conversationId;
          setConversationRecords((records) =>
            records.some((record) => record.id === conversationId)
              ? records
              : [
                  {
                    id: conversationId,
                    title: content.length > 80 ? `${content.slice(0, 80)}…` : content,
                    preview: result.content ?? 'Working…',
                    updated: 'now',
                  },
                  ...records,
                ],
          );
        }
        if (!response.ok)
          setLiveMessages((messages) => [
            ...messages,
            {
              id: `${id}-error`,
              role: 'status',
              content:
                response.error?.message ?? 'The local runtime could not complete this message.',
            },
          ]);
      });
  };
  let content: ReactNode;
  if (view === 'home')
    content = (
      <HomeView
        openChat={() => navigate('chat')}
        openTask={() => navigate('task')}
        setView={navigate}
        composer={homeComposer}
        proactiveEnabled={proactiveEnabled}
        conversations={conversationRecords}
      />
    );
  else if (view === 'chats')
    content = (
      <ChatsView
        onOpen={() => navigate('chat')}
        onCreate={() => navigate('chat')}
        onRename={() => undefined}
        onArchive={() => undefined}
        conversations={conversationRecords}
      />
    );
  else if (view === 'chat')
    content = (
      <ChatView
        openArtifacts={() => navigate('artifacts')}
        openTask={() => navigate('task')}
        selectedModel={selectedModel}
        setModelOpen={() => setModelOpen(true)}
        offline={offline}
        onSend={(input) => sendChat(input.content)}
      />
    );
  else if (view === 'projects') content = <ProjectsView openChat={() => navigate('chat')} />;
  else if (view === 'tasks')
    content = (
      <TasksView
        tasks={taskList}
        openTask={(task) => {
          setActiveTask(task);
          navigate('task');
        }}
      />
    );
  else if (view === 'task')
    content = (
      <TaskDetail
        task={activeTask}
        modelName={selectedModel.name}
        onBack={() => navigate('tasks')}
      />
    );
  else if (view === 'artifacts') content = <ArtifactsView />;
  else if (view === 'memory')
    content = <MemoryView records={memoryRecords} setRecords={setMemoryRecords} />;
  else if (view === 'models') content = <ModelsView models={models} selectModel={selectModel} />;
  else if (view === 'tools') content = <ToolsView tools={toolRecords} setTools={setToolRecords} />;
  else if (view === 'search') content = <SearchView setView={navigate} />;
  else if (view === 'settings')
    content = (
      <SettingsView
        theme={theme}
        setTheme={setTheme}
        developerMode={developerMode}
        setDeveloperMode={setDeveloperMode}
        offline={offline}
        setOffline={setOffline}
        providerStates={providerStates}
        openProvider={setProviderDialog}
        proactiveEnabled={proactiveEnabled}
        setProactiveEnabled={setProactiveEnabled}
      />
    );
  else if (view === 'developer') content = <DeveloperView modelName={selectedModel.name} />;
  else content = <AboutView />;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Shelf
        view={view}
        setView={navigate}
        developerMode={developerMode}
        mobileOpen={mobileOpen}
        closeMobile={() => setMobileOpen(false)}
        conversations={conversationRecords}
      />
      <section className="app-content" id="main-content" tabIndex={-1}>
        {topbarNeeded && (
          <Topbar
            view={view}
            onMenu={() => setMobileOpen(true)}
            onCommand={() => setCommandOpen(true)}
            onNewChat={() => navigate('chat')}
            offline={offline}
          />
        )}
        {!topbarNeeded && (
          <button
            className="floating-mobile-menu icon-button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" />
          </button>
        )}
        {content}
      </section>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <CommandPalette
        open={commandOpen}
        close={() => setCommandOpen(false)}
        setView={navigate}
        openModel={() => {
          setCommandOpen(false);
          setModelOpen(true);
        }}
      />
      <ModelPicker
        open={modelOpen}
        close={() => setModelOpen(false)}
        models={models}
        select={selectModel}
      />
      <ProviderDialog
        provider={providerDialog}
        close={() => setProviderDialog(null)}
        connected={(provider, value) => {
          setProviderStates((states) => ({ ...states, [provider]: value }));
          setModels((list) =>
            list.map((model) =>
              providerIdByName[model.provider] === provider
                ? { ...model, status: value ? 'ready' : 'setup' }
                : model,
            ),
          );
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
    </div>
  );
}

// Kept as a source fixture for visual regression comparisons; the live app
// below is the only mounted entry point.
void LegacyFixtureApp;

function LegacyMigrationDialog() {
  const workspace = useWorkspace();
  const state = workspace.legacyMigration;
  if (!state) return null;
  const report = state.report ?? {};
  return (
    <div className="popover-layer">
      <section
        className="provider-dialog migration-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Original CUPCAKEAGI data migration"
      >
        <header>
          <div>
            <span className="eyebrow">One-time local migration</span>
            <h2>Bring forward your original Cupcake data?</h2>
          </div>
        </header>
        <div className="security-note">
          <Icon name="shield" />
          <div>
            <strong>Only safe product data is considered.</strong>
            <p>
              Conversations, memories, task state, and allowlisted documents can be imported. Old
              API keys, executable scripts, generated state, and bytecode are always excluded.
            </p>
          </div>
        </div>
        <div className="project-stats">
          <span>
            <strong>{Number(report.conversations ?? 0)}</strong> conversations
          </span>
          <span>
            <strong>{Number(report.memories ?? 0)}</strong> memories
          </span>
          <span>
            <strong>{Number(report.tasks ?? 0)}</strong> tasks
          </span>
          <span>
            <strong>{Number(report.files ?? 0)}</strong> safe files
          </span>
        </div>
        {Array.isArray(report.warnings) && report.warnings.length > 0 && (
          <div className="callout">
            <Icon name="info" />
            <p>{report.warnings.join(' ')}</p>
          </div>
        )}
        <p>
          No raw folder path is shown to this renderer. Windows provides an opaque directory handle
          for preview.
        </p>
        <footer>
          <button
            className="button button--danger"
            onClick={() => void workspace.declineLegacyMigration()}
          >
            Not now
          </button>
          <span />
          <button className="button" onClick={() => void workspace.chooseLegacySource()}>
            Choose original folder
          </button>
          <button
            className="button button--primary"
            disabled={!state.report}
            onClick={() => void workspace.executeLegacyMigration()}
          >
            Import safe data
          </button>
        </footer>
      </section>
    </div>
  );
}

function LiveApp() {
  const workspace = useWorkspace();
  const [view, setView] = useState<View>(initialView);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [providerDialog, setProviderDialog] = useState<string | null>(null);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(workspace.tasks[0]?.id ?? null);
  const [memoryRecords, setMemoryRecords] = useState(workspace.memories);
  const [toolRecords, setToolRecords] = useState(workspace.tools);
  const stopRunRef = useRef<() => Promise<void>>(() => Promise.resolve());
  stopRunRef.current = () => workspace.stopRun();
  const selectedModel =
    workspace.models.find((model) => model.selected) ?? workspace.models[0] ?? initialModels[0]!;
  const activeTask = workspace.tasks.find((task) => task.id === activeTaskId) ?? workspace.tasks[0];
  useEffect(() => setMemoryRecords(workspace.memories), [workspace.memories]);
  useEffect(() => setToolRecords(workspace.tools), [workspace.tools]);
  useEffect(() => {
    const configured = workspace.settings.theme;
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    if (configured && !urlTheme) setThemeState(configured);
  }, [workspace.settings.theme]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.reducedMotion = workspace.settings.reducedMotion
      ? 'true'
      : 'false';
    localStorage.setItem('cupcake-theme', theme);
  }, [theme, workspace.settings.reducedMotion]);
  const setTheme = (next: Theme) => {
    setThemeState(next);
    void workspace.updateSettings({ theme: next });
  };
  const navigate = (next: View) => {
    setView(next);
    window.scrollTo(0, 0);
  };
  const startNewChat = () => {
    void workspace.createConversation().then(() => navigate('chat'));
  };
  const sendChat = (input: {
    content: string;
    attachments: AttachmentRecord[];
    references: ReferenceRecord[];
    reasoningEffort: ReasoningEffort;
    enabledToolIds: string[];
    outboundConfirmationToken?: string;
  }) => {
    void workspace.sendMessage({
      ...input,
      modelId: selectedModel.runtimeModelId ?? selectedModel.id,
    });
  };
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      const editing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((value) => !value);
      } else if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        startNewChat();
      } else if (meta && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setModelOpen(true);
      } else if (meta && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        navigate('search');
      } else if (!editing && !meta && event.key === '/') {
        event.preventDefault();
        window.dispatchEvent(new Event('cupcake:focus-composer'));
      } else if (meta && event.key === '.') {
        event.preventDefault();
        void stopRunRef.current();
      } else if (!editing && event.key === 'F6') {
        event.preventDefault();
        const regions = [
          ...document.querySelectorAll<HTMLElement>(
            '.shelf, #main-content, .context-panel.is-open',
          ),
        ];
        const current = regions.findIndex((region) => region.contains(document.activeElement));
        regions[(current + 1) % regions.length]?.focus();
      } else if (
        !editing &&
        event.altKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        const index = workspace.conversations.findIndex(
          (item) => item.id === workspace.activeConversationId,
        );
        const nextIndex =
          event.key === 'ArrowUp'
            ? Math.max(0, index - 1)
            : Math.min(workspace.conversations.length - 1, index + 1);
        const conversation = workspace.conversations[nextIndex];
        if (conversation) void workspace.selectConversation(conversation.id);
      } else if (!editing && meta && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        document.querySelector<HTMLElement>('.frosting-outline')?.focus();
      } else if (!editing && event.key === '?') {
        event.preventDefault();
        setShortcutOpen(true);
      } else if (event.key === 'Escape') {
        setCommandOpen(false);
        setModelOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(
    () =>
      window.cupcake?.commands.onCommand((command) => {
        if (command === 'chat.new') startNewChat();
        else if (command === 'chat.stop') void stopRunRef.current();
        else if (command === 'file.attach') window.dispatchEvent(new Event('cupcake:attach'));
        else if (command === 'search.open') navigate('search');
        else if (command === 'view.command-palette') setCommandOpen(true);
        else if (command === 'view.model-picker') setModelOpen(true);
        else if (command === 'app.preferences') navigate('settings');
        else if (command === 'app.about') navigate('about');
        else if (command === 'view.frosting-thread')
          document.querySelector('.frosting-outline')?.scrollIntoView({ block: 'center' });
      }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const homeComposer = (
    <Composer
      onSend={(input) => {
        navigate('chat');
        sendChat(input);
      }}
      onModel={() => setModelOpen(true)}
      selectedModel={selectedModel}
      offline={workspace.settings.offline}
    />
  );
  let content: ReactNode;
  if (!workspace.ready && !workspace.fixtureMode)
    content = (
      <main className="page">
        <EmptyState
          icon="local"
          title="Opening the encrypted workspace"
          body="Starting the local broker and product runtime…"
        />
      </main>
    );
  else if (view === 'home')
    content = (
      <HomeView
        openChat={() => navigate('chat')}
        openTask={() => {
          if (workspace.tasks[0]) setActiveTaskId(workspace.tasks[0].id);
          navigate('task');
        }}
        setView={navigate}
        composer={homeComposer}
        proactiveEnabled={workspace.settings.proactiveEnabled}
        conversations={workspace.conversations}
      />
    );
  else if (view === 'chats')
    content = (
      <ChatsView
        conversations={workspace.conversations}
        onCreate={startNewChat}
        onOpen={(id) => void workspace.selectConversation(id).then(() => navigate('chat'))}
        onRename={(id, title) => void workspace.renameConversation(id, title)}
        onArchive={(id, archived) => void workspace.archiveConversation(id, archived)}
      />
    );
  else if (view === 'chat')
    content = (
      <ChatView
        openArtifacts={() => navigate('artifacts')}
        openTask={() => navigate('task')}
        selectedModel={selectedModel}
        setModelOpen={() => setModelOpen(true)}
        offline={workspace.settings.offline}
        onSend={sendChat}
      />
    );
  else if (view === 'projects') content = <ProjectsView openChat={() => navigate('chat')} />;
  else if (view === 'tasks')
    content = (
      <TasksView
        tasks={workspace.tasks}
        openTask={(task) => {
          setActiveTaskId(task.id);
          navigate('task');
        }}
      />
    );
  else if (view === 'task' && activeTask)
    content = (
      <TaskDetail
        task={activeTask}
        modelName={selectedModel.name}
        onBack={() => navigate('tasks')}
      />
    );
  else if (view === 'artifacts') content = <ArtifactsView />;
  else if (view === 'memory')
    content = <MemoryView records={memoryRecords} setRecords={setMemoryRecords} />;
  else if (view === 'models')
    content = (
      <ModelsView
        models={workspace.models}
        selectModel={(id) => {
          void workspace.selectModel(id);
          setToast('Default model updated');
        }}
      />
    );
  else if (view === 'tools') content = <ToolsView tools={toolRecords} setTools={setToolRecords} />;
  else if (view === 'search') content = <SearchView setView={navigate} />;
  else if (view === 'settings')
    content = (
      <SettingsView
        theme={theme}
        setTheme={setTheme}
        developerMode={workspace.settings.developerMode}
        setDeveloperMode={(value) => void workspace.updateSettings({ developerMode: value })}
        offline={workspace.settings.offline}
        setOffline={(value) => void workspace.updateSettings({ offline: value })}
        providerStates={workspace.providers}
        openProvider={setProviderDialog}
        proactiveEnabled={workspace.settings.proactiveEnabled}
        setProactiveEnabled={(value) => void workspace.updateSettings({ proactiveEnabled: value })}
      />
    );
  else if (view === 'developer' && workspace.settings.developerMode)
    content = <DeveloperView modelName={selectedModel.name} />;
  else content = <AboutView />;
  const topbarNeeded = ![
    'home',
    'chat',
    'task',
    'artifacts',
    'settings',
    'developer',
    'about',
  ].includes(view);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Shelf
        view={view}
        setView={navigate}
        developerMode={workspace.settings.developerMode}
        mobileOpen={mobileOpen}
        closeMobile={() => setMobileOpen(false)}
        conversations={workspace.conversations}
        onNewChat={startNewChat}
        onSelectConversation={(id) =>
          void workspace.selectConversation(id).then(() => navigate('chat'))
        }
      />
      <section
        className={cx('app-content', view === 'chat' && 'app-content--chat')}
        id="main-content"
        tabIndex={-1}
      >
        {workspace.fixtureMode && (
          <div className="fixture-banner" role="status">
            <Icon name="info" />
            Deterministic fixture — desktop bridge absent; no provider, file, or tool call can leave
            this preview.
          </div>
        )}
        {workspace.error && (
          <div className="runtime-error" role="alert">
            <Icon name="info" />
            {workspace.error}
          </div>
        )}
        {topbarNeeded && (
          <Topbar
            view={view}
            onMenu={() => setMobileOpen(true)}
            onCommand={() => setCommandOpen(true)}
            onNewChat={startNewChat}
            offline={workspace.settings.offline}
          />
        )}
        {!topbarNeeded && (
          <button
            className="floating-mobile-menu icon-button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" />
          </button>
        )}
        {content}
      </section>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <CommandPalette
        open={commandOpen}
        close={() => setCommandOpen(false)}
        setView={navigate}
        openModel={() => {
          setCommandOpen(false);
          setModelOpen(true);
        }}
      />
      <ModelPicker
        open={modelOpen}
        close={() => setModelOpen(false)}
        models={workspace.models}
        select={(id) => void workspace.selectModel(id)}
      />
      <ProviderDialog
        provider={providerDialog}
        close={() => setProviderDialog(null)}
        connected={() => void workspace.refresh()}
      />
      <LegacyMigrationDialog />
      {shortcutOpen && (
        <div
          className="popover-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShortcutOpen(false);
          }}
        >
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
          >
            <header>
              <div>
                <span className="eyebrow">Keyboard reference</span>
                <h2>Move around Cupcake</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setShortcutOpen(false)}
                aria-label="Close shortcut reference"
              >
                <Icon name="x" />
              </button>
            </header>
            <div className="shortcut-list">
              {[
                ['F6', 'Cycle app regions'],
                ['Alt + ↑ / ↓', 'Previous or next conversation'],
                ['Ctrl + J', 'Focus the Frosting Thread outline'],
                ['Ctrl + K', 'Open commands'],
                ['Ctrl + M', 'Choose model'],
                ['?', 'Open this reference'],
              ].map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
    </div>
  );
}

export function App() {
  return (
    <WorkspaceProvider>
      <LiveApp />
    </WorkspaceProvider>
  );
}
