import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  artifacts as fixtureArtifacts,
  conversations as initialConversations,
  memories as initialMemories,
  models as initialModels,
  tasks as initialTasks,
  tools as initialTools,
} from './data';
import { Icon, type IconName } from './icons';
import { ConversationScrollController } from './conversation-scroll';
import { RichMarkdown } from './RichMarkdown';
import {
  canonicalModelId,
  modelSelectionParams,
  requiresCompatibilityAcknowledgement,
} from './model-selection';
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
  scopedReferenceOptions,
  useWorkspace,
  type ArtifactRecord,
  type AttachmentRecord,
  type HardwareRecord,
  type LocalRuntimeRecord,
  type MessageRecord,
  type OutboundIntent,
  type ProviderSetupInput,
  type ProviderTestResult,
  type ReasoningEffort,
  type ReferenceRecord,
  type SearchRecord,
  type StagedAttachmentRecord,
  type ToolActivity,
  type WorkspaceSettings,
} from './workspace';
import type { WindowPreferences, WorkspaceLockStatus } from '../shared/desktop-api';

const navItems: { id: View; label: string; icon: IconName; shortcut?: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'chats', label: 'Chats', icon: 'chat' },
  { id: 'projects', label: 'Projects', icon: 'project' },
  { id: 'tasks', label: 'Tasks', icon: 'task' },
  { id: 'artifacts', label: 'Artifacts', icon: 'artifact' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'models', label: 'Models', icon: 'model' },
  { id: 'tools', label: 'Tools', icon: 'tool' },
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

const CUPCAKE_AVATARS = Array.from({ length: 20 }, (_, index) => ({
  value: `atlas:${index}`,
  label: [
    'Astronomer',
    'Garden keeper',
    'Pixel explorer',
    'Paper librarian',
    'Folk musician',
    'Glass alchemist',
    'Pastry engineer',
    'Ink detective',
    'Comic pilot',
    'Enamel botanist',
    'Pastel dreamer',
    'Woodblock navigator',
    'Plush baker',
    'Mosaic oceanographer',
    'Pencil architect',
    'Synthwave DJ',
    'Art nouveau naturalist',
    'Storybook wizard',
    'Low-poly helper',
    'Gouache historian',
  ][index]!,
}));

function atlasStyle(index: number, columns: number, rows: number, image: string): CSSProperties {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    backgroundImage: `url(${image})`,
    backgroundSize: `${columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${columns === 1 ? 0 : (column / (columns - 1)) * 100}% ${rows === 1 ? 0 : (row / (rows - 1)) * 100}%`,
  };
}

function CupcakePortrait({
  value,
  className,
  label = 'Cupcake portrait',
}: {
  value?: string;
  className?: string;
  label?: string;
}) {
  const match = /^atlas:(\d+)$/.exec(value ?? '');
  if (match) {
    const index = Math.max(0, Math.min(19, Number(match[1])));
    return (
      <span
        className={cx('cupcake-portrait', className)}
        style={atlasStyle(index, 5, 4, '/art/cupcake-avatar-atlas-v1.webp')}
        role="img"
        aria-label={label}
      />
    );
  }
  return <img className={className} src={value || '/brand/cupcake-mark.svg'} alt={label} />;
}

function OnboardingStoryArt({ step }: { step: number }) {
  return (
    <span
      className="onboarding-story-art"
      style={atlasStyle(step, 3, 2, '/art/onboarding-story-atlas-v1.webp')}
      aria-hidden="true"
    />
  );
}

function Dreamscape({ scene, className }: { scene: number; className?: string }) {
  return (
    <span
      className={cx('workspace-dreamscape', className)}
      style={atlasStyle(scene % 4, 2, 2, '/art/workspace-dreamscapes-v1.webp')}
      aria-hidden="true"
    />
  );
}

function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={cx('brand', large && 'brand--large')}>
      <img src="/brand/cupcake-mark.svg" alt="" className="brand__mark" />
      <div>
        <strong>CUPCAKE</strong>
        <span>AI</span>
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

function useModalFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
) {
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    const focusable = container?.querySelector<HTMLElement>(
      '[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab' || !container) return;
      const items = [
        ...container.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      previousFocus.current?.focus();
    };
  }, [active, containerRef, onEscape]);
}

function CupcakeTitlebar() {
  const [maximized, setMaximized] = useState(false);
  const refreshMaximized = useCallback(async () => {
    setMaximized((await window.cupcake?.window?.isMaximized?.()) ?? false);
  }, []);
  useEffect(() => {
    void refreshMaximized();
    const onResize = () => void refreshMaximized();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [refreshMaximized]);
  const toggleMaximize = async () => {
    const next = await window.cupcake?.window?.toggleMaximize?.();
    setMaximized(next ?? !maximized);
  };
  return (
    <header className="cupcake-titlebar" aria-label="Application window controls">
      <div className="cupcake-titlebar__identity" aria-hidden="true">
        <img src="/brand/cupcake-mark.svg" alt="" />
        <span>CUPCAKEAI</span>
      </div>
      <div
        className="cupcake-titlebar__drag"
        data-tauri-drag-region
        onDoubleClick={() => void toggleMaximize()}
        aria-hidden="true"
      />
      <div className="cupcake-titlebar__controls">
        <button
          type="button"
          className="window-control"
          aria-label="Minimize window"
          onClick={() => void window.cupcake?.window?.minimize?.()}
        >
          <span aria-hidden="true" className="window-control__minimize" />
        </button>
        <button
          type="button"
          className="window-control"
          aria-label={maximized ? 'Restore window' : 'Maximize window'}
          aria-pressed={maximized}
          onClick={() => void toggleMaximize()}
        >
          <span
            aria-hidden="true"
            className={maximized ? 'window-control__restore' : 'window-control__maximize'}
          />
        </button>
        <button
          type="button"
          className="window-control window-control--close"
          aria-label="Close window"
          onClick={() => void window.cupcake?.window?.close?.()}
        >
          <span aria-hidden="true" className="window-control__close" />
        </button>
      </div>
    </header>
  );
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

function WorkspaceOpening() {
  const [scene] = useState(() => Math.floor(Math.random() * 4));
  return (
    <main className="workspace-opening" aria-live="polite">
      <Dreamscape scene={scene} />
      <section className="workspace-opening__card">
        <span className="eyebrow">Encrypted workspace</span>
        <h2>Bringing your history into view</h2>
        <p>
          Your conversations open first. Hardware scans, catalogs, and local models stay asleep
          until their page or a message needs them.
        </p>
        <div className="workspace-opening__meter" aria-label="Opening workspace">
          <i />
        </div>
        <div className="workspace-opening__stages">
          <span className="is-done">
            <Icon name="check" /> Key accepted
          </span>
          <span className="is-active">
            <i /> Opening recent chats
          </span>
          <span>
            <i /> Optional services on demand
          </span>
        </div>
      </section>
    </main>
  );
}

function Shelf({
  view,
  setView,
  developerMode,
  mobileOpen,
  closeMobile,
  conversations,
  activeTaskCount,
  onNewChat,
  onSelectConversation,
  profile,
}: {
  view: View;
  setView: (v: View) => void;
  developerMode: boolean;
  mobileOpen: boolean;
  closeMobile: () => void;
  conversations: Conversation[];
  activeTaskCount: number;
  onNewChat?: () => void;
  onSelectConversation?: (id: string) => void;
  profile?: WorkspaceSettings['profile'];
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
      <button className="shelf-search" onClick={() => navigate('search')}>
        <Icon name="search" size={15} />
        <span>Search CupcakeAI</span>
        <span className="shortcut-keycaps" aria-label="Control F">
          <kbd>Ctrl</kbd>
          <kbd>F</kbd>
        </span>
      </button>
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
            data-tour={item.id}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.id === 'tasks' && activeTaskCount > 0 && (
              <em
                aria-label={`${activeTaskCount} active ${activeTaskCount === 1 ? 'task' : 'tasks'}`}
                title={`${activeTaskCount} active ${activeTaskCount === 1 ? 'task' : 'tasks'}`}
              >
                {activeTaskCount} active
              </em>
            )}
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
          data-tour="settings"
          onClick={() => navigate('settings')}
        >
          <Icon name="settings" />
          <span>Settings</span>
        </button>
        <button className="profile-row" data-tour="profile" onClick={() => navigate('settings')}>
          <span className="avatar">
            <CupcakePortrait
              value={profile?.avatar}
              label={`${profile?.displayName || 'Local'} profile`}
            />
          </span>
          <span>
            <strong>{profile?.displayName || 'Akshit'}</strong>
            <small>{profile?.role || 'Local profile'}</small>
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
  const workspace = useWorkspace();
  const hour = new Date().getHours();
  const name = workspace.settings.profile.displayName.trim() || 'there';
  return (
    <>
      {hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {name}.
    </>
  );
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
          <CupcakePortrait
            value={workspace.settings.assistantAvatar}
            label="Selected CupcakeAI assistant"
          />
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
            {conversations.length === 0 && (
              <div className="continue-empty">
                <Icon name="chat" />
                <span>
                  <strong>Your first thread will stay within reach</strong>
                  <small>Start above, then return here without searching through history.</small>
                </span>
              </div>
            )}
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
            <div className="working-idle">
              <span className="working-idle__icon">
                <Icon name="task" />
              </span>
              <div>
                <strong>Your task queue is clear</strong>
                <p>Ask CupcakeAI for longer work and its progress will stay visible here.</p>
              </div>
              <button className="text-button" onClick={openChat}>
                Start something <Icon name="chevron" size={14} />
              </button>
            </div>
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

interface ComposerSendInput {
  content: string;
  modelId: string;
  attachments: StagedAttachmentRecord[];
  references: ReferenceRecord[];
  reasoningEffort: ReasoningEffort;
  enabledToolIds: string[];
  outboundConfirmationToken?: string;
  outboundIntent?: OutboundIntent;
  conversationId?: string;
  branchId?: string;
  projectId?: string | null;
}

function Composer({
  onSend,
  compact = false,
  onModel,
  selectedModel,
  offline,
}: {
  onSend: (input: ComposerSendInput) => Promise<boolean> | boolean;
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
      modelId: string;
      attachments: StagedAttachmentRecord[];
      references: ReferenceRecord[];
      reasoningEffort: ReasoningEffort;
      enabledToolIds: string[];
      conversationId?: string;
      branchId?: string;
      projectId?: string | null;
    };
    confirmationToken: string;
    outboundIntent: OutboundIntent;
    disclosure: { privacyRoute?: string; costClass?: string };
    modelName: string;
    providerName: string;
    memoryLabels: string[];
    toolLabels: string[];
  }>(null);
  const [disclosureError, setDisclosureError] = useState('');
  const [attachments, setAttachments] = useState<StagedAttachmentRecord[]>([]);
  const [sending, setSending] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const routeAtSend: AttachmentRecord['destination'] =
    selectedModel.route === 'Cloud' && !offline ? 'cloud' : 'local';
  const clearSuccessfulDraft = async (sentAttachments: StagedAttachmentRecord[]) => {
    setValue('');
    setAttachments([]);
    setReferences([]);
    setReference(false);
    const desktop = window.cupcake;
    if (desktop) {
      await Promise.allSettled(
        sentAttachments.map((item) => desktop.dialog.releaseHandle(item.handleId)),
      );
    }
  };
  const submit = async (input: ComposerSendInput) => {
    setSending(true);
    setDisclosureError('');
    try {
      const success = await onSend(input);
      if (success) await clearSuccessfulDraft(input.attachments);
      else setDisclosureError('Message not sent. Your draft and file access are still available.');
      return success;
    } catch (reason) {
      setDisclosureError(reason instanceof Error ? reason.message : 'Message could not be sent');
      return false;
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (sending) return;
    const clean = value.trim();
    if (!clean && attachments.length === 0) return;
    if (offline && selectedModel.route === 'Cloud') return;
    setSending(true);
    const context =
      workspace.activeConversationId && workspace.activeBranchId
        ? {
            conversationId: workspace.activeConversationId,
            branchId: workspace.activeBranchId,
            projectId: workspace.activeProjectId,
          }
        : attachments.length > 0
          ? await workspace.createConversation('New conversation')
          : {
              conversationId: undefined,
              branchId: undefined,
              projectId: workspace.activeProjectId,
            };
    if (!context) {
      setDisclosureError('A conversation could not be created. Your draft is still here.');
      setSending(false);
      return;
    }
    const input = {
      content: clean || 'Please review the attached file.',
      modelId: canonicalModelId(selectedModel),
      attachments: attachments.map((item) => ({ ...item, destination: routeAtSend })),
      references,
      reasoningEffort: supportedReasoning.includes(workspace.settings.reasoningEffort)
        ? workspace.settings.reasoningEffort
        : supportedReasoning[0]!,
      enabledToolIds: workspace.settings.enabledToolIds,
      ...context,
    };
    const requiresDisclosure = selectedModel.route === 'Cloud';
    if (requiresDisclosure && !workspace.fixtureMode) {
      setDisclosureError('');
      void workspace
        .preflightCloudDisclosure({
          content: input.content,
          modelId: input.modelId,
          attachments,
          references,
          enabledToolIds: input.enabledToolIds,
          conversationId: input.conversationId,
          branchId: input.branchId,
          projectId: input.projectId,
        })
        .then((result) => {
          if (!result.confirmationToken) {
            throw new Error('The provider did not return a cloud confirmation token.');
          }
          setPendingDisclosure({
            input,
            confirmationToken: result.confirmationToken,
            outboundIntent: result.outboundIntent,
            disclosure: result.disclosure,
            modelName: selectedModel.name,
            providerName: selectedModel.provider,
            memoryLabels: workspace.memories
              .filter((item) => result.outboundIntent.memoryIds.includes(item.id))
              .map((item) => item.title),
            toolLabels: workspace.tools
              .filter((item) => result.outboundIntent.toolIds.includes(item.id))
              .map((item) => item.name),
          });
        })
        .catch((reason) =>
          setDisclosureError(
            reason instanceof Error ? reason.message : 'Disclosure preflight failed',
          ),
        )
        .finally(() => setSending(false));
      return;
    }
    void submit(input);
  };
  const attach = async () => {
    const files = await window.cupcake?.dialog.openFiles({
      title: 'Attach files to this conversation',
      multiple: true,
    });
    if (files?.length)
      setAttachments((current) => [
        ...current,
        ...files
          .filter((file) => !current.some((item) => item.handleId === file.id))
          .map((file): StagedAttachmentRecord => ({
            handleId: file.id,
            name: file.name,
            size: file.size,
            extension: file.extension,
            destination: routeAtSend,
          })),
      ]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
    if (event.key === '@') setReference(true);
  };
  const referenceOptions: ReferenceRecord[] = workspace.fixtureMode
    ? [
        { id: 'fixture-file', type: 'artifact', label: 'architecture.md' },
        { id: 'fixture-cupcake', type: 'project', label: 'Cupcake 2.0' },
        { id: 'fixture-task', type: 'task', label: 'Repository redesign' },
      ]
    : scopedReferenceOptions({
        projects: workspace.projects,
        tasks: workspace.tasks,
        artifacts: workspace.artifacts,
        memories: workspace.memories,
        activeProjectId: workspace.activeProjectId,
        activeConversationId: workspace.activeConversationId,
      });
  const referenceScopeKey = referenceOptions.map((item) => `${item.type}:${item.id}`).join('|');
  useEffect(() => {
    const allowed = new Set(referenceScopeKey.split('|').filter(Boolean));
    setReferences((current) => {
      const next = current.filter((item) => allowed.has(`${item.type}:${item.id}`));
      return next.length === current.length ? current : next;
    });
  }, [referenceScopeKey]);
  useEffect(() => {
    const focus = () => textRef.current?.focus();
    const requestAttach = () => void attach();
    window.addEventListener('cupcake:focus-composer', focus);
    window.addEventListener('cupcake:attach', requestAttach);
    return () => {
      window.removeEventListener('cupcake:focus-composer', focus);
      window.removeEventListener('cupcake:attach', requestAttach);
    };
  }, [routeAtSend]);
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
                  current.some((entry) => entry.id === item.id && entry.type === item.type)
                    ? current
                    : [...current, item],
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
          {referenceOptions.length === 0 && (
            <small className="reference-popover__empty">
              No files, tasks, memories, or artifacts are available in this scope.
            </small>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((file) => (
            <span key={file.handleId}>
              <Icon name="file" />
              {file.name}
              <RouteBadge route={routeAtSend === 'cloud' ? 'Cloud' : 'Local'} />
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
      {references.length > 0 && (
        <div className="composer-references" aria-label="Selected references">
          {references.map((item) => (
            <span key={`${item.type}:${item.id}`}>
              <Icon
                name={item.type === 'memory' ? 'memory' : item.type === 'task' ? 'task' : 'file'}
              />
              <b>@{item.label}</b>
              <small>{cap(item.type)}</small>
              <button
                aria-label={`Remove reference ${item.label}`}
                onClick={() =>
                  setReferences((current) =>
                    current.filter((entry) => entry.id !== item.id || entry.type !== item.type),
                  )
                }
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
            onClick={() => void send()}
            disabled={
              (!value.trim() && attachments.length === 0) ||
              (offline && selectedModel.route === 'Cloud') ||
              sending
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
                <h2>Send this context to {pendingDisclosure.providerName}?</h2>
              </div>
            </header>
            <div className="security-note">
              <Icon name="cloud" />
              <div>
                <strong>
                  {pendingDisclosure.modelName} ·{' '}
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
                <dd>{pendingDisclosure.memoryLabels.join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt>Tools</dt>
                <dd>{pendingDisclosure.toolLabels.join(', ') || 'None'}</dd>
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
                  setPendingDisclosure(null);
                  void submit({
                    ...pendingDisclosure.input,
                    outboundConfirmationToken: pendingDisclosure.confirmationToken,
                    outboundIntent: pendingDisclosure.outboundIntent,
                  });
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
      {user && onEdit && (
        <button title="Edit" onClick={onEdit}>
          <Icon name="edit" />
        </button>
      )}
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
              <li>Tauri 2 security and capability reference</li>
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
            <strong>Desktop / Code Palace / CupcakeAI</strong>
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
        <strong>CupcakeAI architecture.md</strong>
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
  const [pendingAction, setPendingAction] = useState<null | {
    message: MessageRecord;
    mode: 'retry' | 'edit' | 'regenerate' | 'continue';
    content: string;
    confirmationToken: string;
    outboundIntent: OutboundIntent;
  }>(null);
  const [actionError, setActionError] = useState('');
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
  const executeAction = (
    message: MessageRecord,
    mode: 'retry' | 'edit' | 'regenerate' | 'continue',
    content: string,
    confirmation?: { confirmationToken: string; outboundIntent: OutboundIntent },
  ) => {
    void workspace.sendMessage({
      content,
      modelId: confirmation?.outboundIntent.modelId ?? canonicalModelId(selectedModel),
      attachments: [],
      references: [],
      reasoningEffort: workspace.settings.reasoningEffort,
      enabledToolIds: workspace.settings.enabledToolIds,
      mode,
      messageId: message.id,
      outboundConfirmationToken: confirmation?.confirmationToken,
      outboundIntent: confirmation?.outboundIntent,
    });
  };
  const runAction = async (
    message: MessageRecord,
    mode: 'retry' | 'edit' | 'regenerate' | 'continue',
  ) => {
    let content = mode === 'continue' ? 'Continue from the previous response.' : message.content;
    if (mode === 'edit') {
      const edited = window.prompt('Edit message and create a sibling branch', content)?.trim();
      if (!edited) return;
      content = edited;
    }
    if (selectedModel.route !== 'Cloud' || workspace.fixtureMode) {
      executeAction(message, mode, content);
      return;
    }
    try {
      setActionError('');
      const result = await workspace.preflightCloudDisclosure({
        content,
        modelId: canonicalModelId(selectedModel),
        attachments: [],
        references: [],
        enabledToolIds: workspace.settings.enabledToolIds,
        messageId: message.id,
      });
      if (!result.confirmationToken) throw new Error('Cloud confirmation is unavailable.');
      setPendingAction({
        message,
        mode,
        content,
        confirmationToken: result.confirmationToken,
        outboundIntent: result.outboundIntent,
      });
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Action preflight failed.');
    }
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
      {actionError && (
        <p className="field-error conversation-action-error" role="alert">
          {actionError}
        </p>
      )}
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
                {message.attachments?.map((attachment, index) => (
                  <div
                    className="file-attachment"
                    key={attachment.id ?? attachment.handleId ?? `${attachment.name}-${index}`}
                  >
                    <span className="file-icon">
                      {attachment.extension?.toUpperCase() ?? 'FILE'}
                    </span>
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>
                        {attachment.handleId
                          ? 'Temporary desktop access · raw path hidden'
                          : 'Safe attachment metadata · raw path not stored'}
                      </small>
                    </span>
                    <RouteBadge route={attachment.destination === 'cloud' ? 'Cloud' : 'Local'} />
                  </div>
                ))}
                {message.references && message.references.length > 0 && (
                  <div className="message-references" aria-label="Message references">
                    {message.references.map((reference) => (
                      <span key={`${reference.type}:${reference.id}`}>
                        <Icon
                          name={
                            reference.type === 'memory'
                              ? 'memory'
                              : reference.type === 'task'
                                ? 'task'
                                : 'file'
                          }
                        />
                        <b>@{reference.label}</b>
                        <small>{cap(reference.type)}</small>
                      </span>
                    ))}
                  </div>
                )}
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
                  message.role === 'assistant' ? () => void runAction(message, 'retry') : undefined
                }
                onEdit={message.role === 'user' ? () => void runAction(message, 'edit') : undefined}
                onBranch={() =>
                  void workspace.branchConversation(message.id, `Branch from ${message.role}`)
                }
                onContinue={
                  message.role === 'assistant'
                    ? () => void runAction(message, 'continue')
                    : undefined
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
      {pendingAction && (
        <div className="popover-layer">
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm message action"
          >
            <header>
              <div>
                <span className="eyebrow">Point-of-use confirmation</span>
                <h2>
                  {cap(pendingAction.mode)} with {pendingAction.outboundIntent.provider}?
                </h2>
              </div>
            </header>
            <div className="security-note">
              <Icon name="cloud" />
              <div>
                <strong>{pendingAction.outboundIntent.modelId} · Cloud</strong>
                <p>
                  This action sends the selected message and its visible conversation context to the
                  provider. No file grant is reused.
                </p>
              </div>
            </div>
            <footer>
              <button className="button" onClick={() => setPendingAction(null)}>
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                onClick={() => {
                  executeAction(pendingAction.message, pendingAction.mode, pendingAction.content, {
                    confirmationToken: pendingAction.confirmationToken,
                    outboundIntent: pendingAction.outboundIntent,
                  });
                  setPendingAction(null);
                }}
              >
                Confirm {pendingAction.mode}
              </button>
            </footer>
          </section>
        </div>
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
  onSend: (input: ComposerSendInput) => Promise<boolean> | boolean;
}) {
  const workspace = useWorkspace();
  const [contextOpen, setContextOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversationScroll = useRef(new ConversationScrollController());
  const latestMessage = workspace.messages.at(-1);
  const followSignal = `${workspace.activeConversationId ?? 'new'}:${workspace.messages.length}:${latestMessage?.content.length ?? 0}:${latestMessage?.streaming ? 'streaming' : 'settled'}`;

  useEffect(() => {
    const surface = conversationScrollRef.current;
    if (!surface) return;
    conversationScroll.current.follow(surface);
  }, [followSignal]);

  useEffect(() => {
    const surface = conversationScrollRef.current;
    if (!surface) return;
    conversationScroll.current.follow(surface, { force: true });
    setFollowingLatest(true);
  }, [workspace.activeConversationId]);
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
        <div
          className="conversation-scroll"
          ref={conversationScrollRef}
          onScroll={(event) =>
            setFollowingLatest(conversationScroll.current.observe(event.currentTarget))
          }
        >
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
                        <strong>CupcakeAI repository</strong>
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
          {!followingLatest && (
            <button
              className="jump-to-latest"
              onClick={() => {
                const surface = conversationScrollRef.current;
                if (!surface) return;
                conversationScroll.current.follow(surface, { force: true, smooth: true });
                setFollowingLatest(true);
              }}
            >
              <Icon name="chevron" size={14} />
              Jump to latest
            </button>
          )}
        </div>
        <footer className="chat-composer-wrap">
          <Composer
            compact
            onSend={async (input) => {
              const sent = await onSend(input);
              if (sent) {
                const surface = conversationScrollRef.current;
                if (surface) conversationScroll.current.follow(surface, { force: true });
                setFollowingLatest(true);
              }
              return sent;
            }}
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
        {activeAttachments.map((attachment, index) => (
          <div
            className="context-item"
            key={attachment.id ?? attachment.handleId ?? `${attachment.name}-${index}`}
          >
            <Icon name="file" />
            <span>
              <strong>{attachment.name}</strong>
              <small>Safe message metadata · {attachment.destination} destination</small>
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
  const [showContextHelp, setShowContextHelp] = useState(false);
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
        <button
          className="text-button"
          aria-expanded={showContextHelp}
          onClick={() => setShowContextHelp((value) => !value)}
        >
          How context works <Icon name="external" />
        </button>
      </section>
      {showContextHelp && (
        <section className="callout" role="status">
          <Icon name="info" />
          <p>
            The active project limits retrieval, artifacts, files, and project-scoped memory. A
            conversation can use outside context only after you attach or explicitly reference it.
          </p>
        </section>
      )}
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
  const [showDeveloperTrace, setShowDeveloperTrace] = useState(false);
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
            <button
              className="text-button"
              aria-expanded={showDeveloperTrace}
              onClick={() => setShowDeveloperTrace((value) => !value)}
            >
              {showDeveloperTrace ? 'Hide developer trace' : 'Developer trace'}
            </button>
          </header>
          {showDeveloperTrace && (
            <div className="callout" role="status">
              <Icon name="terminal" />
              <p>
                Task {task.id} · checkpoint {task.progress}% · {task.steps.length} durable steps ·
                status {task.status}. Hidden reasoning and credentials are never included.
              </p>
            </div>
          )}
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
    `# CupcakeAI 2.0 architecture\n\nThe application owns its conversations, memories, and artifacts. Framework state remains replaceable.\n\n## Runtime boundaries\n\n- React renderer for presentation\n- Tauri Rust host for desktop lifecycle\n- Python runtime for model and workflow orchestration\n- Rust broker for permissions and tool execution\n\n> Project scope is a privacy boundary, not a ranking hint.\n\n## Storage\n\nProduct data lives in encrypted SQLite. Large revisions are immutable, encrypted objects addressed by their content hash.`,
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
              <h1>CupcakeAI 2.0 architecture</h1>
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
                  <strong>Tauri Rust host</strong> for desktop lifecycle
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
      <main className="artifact-empty-workspace">
        <section className="artifact-empty-hero">
          <span className="eyebrow">Project-owned, encrypted revisions</span>
          <h1>Make the first artifact</h1>
          <p>
            Documents, code, tables, diagrams, and generated assets live here without being mixed
            into another project.
          </p>
          <div className="artifact-empty-actions">
            <button className="button button--primary" onClick={create}>
              <Icon name="plus" /> Create artifact
            </button>
          </div>
        </section>
        <section className="artifact-empty-guide" aria-label="Artifact capabilities">
          <article>
            <Icon name="artifact" />
            <div>
              <strong>Revise safely</strong>
              <p>Every save creates a new immutable revision instead of overwriting history.</p>
            </div>
          </article>
          <article>
            <Icon name="shield" />
            <div>
              <strong>Keep project boundaries</strong>
              <p>Only artifacts from the active project appear in this workspace.</p>
            </div>
          </article>
          <article>
            <Icon name="download" />
            <div>
              <strong>Export deliberately</strong>
              <p>Files leave the encrypted store only when you choose an export location.</p>
            </div>
          </article>
        </section>
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
  const [scopeFilter, setScopeFilter] = useState('all');
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
  const shown = records.filter(
    (m) =>
      (scopeFilter === 'all' || m.scope === scopeFilter) &&
      `${m.title} ${m.body} ${m.scope}`.toLowerCase().includes(query.toLowerCase()),
  );
  const createMemory = () => {
    const key = window.prompt('Memory label')?.trim();
    if (!key) return;
    const body = window.prompt('What should Cupcake remember?')?.trim();
    if (!body) return;
    if (looksLikeCredential(body)) {
      setMemoryNotice(
        'Credentials cannot be saved as memory. Store provider keys only through the encrypted provider setup flow.',
      );
      return;
    }
    void workspace.remember({ key, content: body, kind: 'fact' });
    setMemoryNotice('Memory saved. You can inspect its scope and provenance here.');
  };
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
        <label className="select-control">
          <Icon name="filter" />
          <span className="sr-only">Memory scope</span>
          <select
            aria-label="Memory scope"
            value={scopeFilter}
            onChange={(event) => setScopeFilter(event.target.value)}
          >
            <option value="all">All scopes</option>
            {[...new Set(records.map((record) => record.scope))].map((scope) => (
              <option value={scope} key={scope}>
                {scope}
              </option>
            ))}
          </select>
        </label>
        <button className="button button--primary" onClick={createMemory}>
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
          onAction={createMemory}
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

type DeviceFit = NonNullable<ModelDescriptor['fit']>;

const fitRank: Record<DeviceFit, number> = {
  recommended: 0,
  hybrid: 1,
  'reduced-context': 2,
  'cpu-slow': 3,
  pending: 4,
  incompatible: 5,
};

function formatStorage(bytes?: number) {
  if (!bytes || bytes <= 0) return 'Not reported';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: index > 2 ? 1 : 0 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

function deviceFit(
  model: ModelDescriptor,
  hardware?: HardwareRecord | null,
): { fit: DeviceFit; fitReason: string } {
  if (model.route !== 'Local')
    return { fit: 'recommended', fitReason: 'Runs through its cloud provider.' };
  if (!hardware?.ramBytes) {
    return {
      fit: 'pending',
      fitReason: 'Complete the device scan before Cupcake recommends a runtime profile.',
    };
  }
  const file = model.estimatedDiskBytes ?? model.fileSizeBytes;
  const ram = model.estimatedRamBytes ?? (file ? Math.ceil(file * 1.25) : undefined);
  const vram = model.estimatedVramBytes ?? ram;
  if (file && hardware.diskAvailableBytes && hardware.diskAvailableBytes < file * 1.12) {
    return {
      fit: 'incompatible',
      fitReason: `Needs ${formatStorage(Math.ceil(file * 1.12))} free including download headroom; ${formatStorage(hardware.diskAvailableBytes)} is available.`,
    };
  }
  if (!ram) {
    return {
      fit: 'pending',
      fitReason: 'This catalog entry does not include a memory estimate yet.',
    };
  }
  if (hardware.ramBytes < ram * 0.78) {
    return {
      fit: 'incompatible',
      fitReason: `Estimated memory is ${formatStorage(ram)}; this device reports ${formatStorage(hardware.ramBytes)}.`,
    };
  }
  if (hardware.vramBytes && vram && hardware.vramBytes >= vram) {
    return {
      fit: 'recommended',
      fitReason: `Fits the ${formatStorage(hardware.vramBytes)} detected VRAM profile with the published estimate.`,
    };
  }
  if (hardware.vramBytes && vram && hardware.vramBytes >= vram * 0.55 && hardware.ramBytes >= ram) {
    return {
      fit: 'hybrid',
      fitReason:
        'Fits by sharing weights between detected GPU memory and system RAM; speed will vary by backend.',
    };
  }
  if (hardware.ramBytes >= ram * 1.25) {
    return {
      fit: 'cpu-slow',
      fitReason:
        'Fits system RAM, but no complete GPU fit was detected; expect a slower CPU-heavy load.',
    };
  }
  return {
    fit: 'reduced-context',
    fitReason:
      'Memory is close to the published estimate. Start with a smaller context window and close other heavy apps.',
  };
}

function modelStatusLabel(status: ModelDescriptor['status']) {
  const labels: Record<ModelDescriptor['status'], string> = {
    catalog: 'Available',
    incompatible: 'Does not fit',
    setup: 'Needs setup',
    download: 'Downloading',
    paused: 'Paused',
    verifying: 'Checking SHA-256',
    'checksum-failed': 'Checksum failed',
    installed: 'Installed',
    loading: 'Loading',
    ready: 'Loaded',
    benchmarked: 'Benchmarked',
    unloading: 'Unloading',
    removing: 'Removing',
    offline: 'Not loaded',
    community: 'Community listing',
    error: 'Needs recovery',
  };
  return labels[status];
}

function modelSize(model: ModelDescriptor): 'compact' | 'balanced' | 'large' {
  const parameterCount = Number.parseFloat(model.parameters ?? '0');
  if (parameterCount > 0 && parameterCount <= 5) return 'compact';
  if (parameterCount > 10) return 'large';
  return 'balanced';
}

function providerDialogId(provider: string) {
  const ids: Record<string, string> = {
    OpenAI: 'openai',
    Anthropic: 'anthropic',
    Google: 'google',
    xAI: 'xai',
    Mistral: 'mistral',
    Cohere: 'cohere',
    'NVIDIA NIM': 'nvidia-nim',
  };
  return ids[provider] ?? 'openai-compatible';
}

function ModelsView({
  models,
  selectModel,
  openProvider,
}: {
  models: ModelDescriptor[];
  selectModel: (id: string, options?: { compatibilityConfirmed?: boolean }) => Promise<void>;
  openProvider: (provider: string) => void;
}) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<'all' | 'cloud' | 'local'>('all');
  const [modelQuery, setModelQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const [sizeFilter, setSizeFilter] = useState('all');
  const [fitFilter, setFitFilter] = useState('all');
  const [communityModels, setCommunityModels] = useState<ModelDescriptor[]>([]);
  const [communityLoading, setCommunityLoading] = useState(true);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [pendingDownload, setPendingDownload] = useState<ModelDescriptor | null>(null);
  const [pendingRemove, setPendingRemove] = useState<ModelDescriptor | null>(null);
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [pendingCompatibility, setPendingCompatibility] = useState<ModelDescriptor | null>(null);
  const [compatibilityAcknowledged, setCompatibilityAcknowledged] = useState(false);
  const [pendingRuntime, setPendingRuntime] = useState<LocalRuntimeRecord | null>(null);
  const [runtimeTermsAccepted, setRuntimeTermsAccepted] = useState(false);
  const installRef = useRef<HTMLElement>(null);
  const removeRef = useRef<HTMLElement>(null);
  const runtimeInstallRef = useRef<HTMLElement>(null);
  const closeInstall = useCallback(() => {
    setPendingDownload(null);
    setLicenseAccepted(false);
  }, []);
  const closeRemove = useCallback(() => setPendingRemove(null), []);
  const closeRuntimeInstall = useCallback(() => {
    setPendingRuntime(null);
    setRuntimeTermsAccepted(false);
  }, []);
  useModalFocusTrap(Boolean(pendingDownload), installRef, closeInstall);
  useModalFocusTrap(Boolean(pendingRemove), removeRef, closeRemove);
  useModalFocusTrap(Boolean(pendingRuntime), runtimeInstallRef, closeRuntimeInstall);

  useEffect(() => {
    let active = true;
    setCommunityLoading(true);
    const timer = window.setTimeout(
      () => {
        void workspace
          .discoverCommunityModels(modelQuery)
          .then((items) => {
            if (!active) return;
            setCommunityModels(items);
            setCommunityError(null);
          })
          .catch(() => {
            if (active)
              setCommunityError(
                'Community search is offline. Managed and provider models remain available.',
              );
          })
          .finally(() => {
            if (active) setCommunityLoading(false);
          });
      },
      modelQuery ? 420 : 40,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [modelQuery, workspace.discoverCommunityModels]);

  const rankedModels = useMemo(
    () =>
      [...models, ...communityModels]
        .map((model) => ({
          ...model,
          ...(model.route === 'Local' ? deviceFit(model, workspace.hardware) : {}),
        }))
        .sort((a, b) => {
          if (a.route !== b.route) return a.route === 'Local' ? -1 : 1;
          const fitDifference = fitRank[a.fit ?? 'pending'] - fitRank[b.fit ?? 'pending'];
          if (fitDifference) return fitDifference;
          if (a.route === 'Local' && b.route === 'Local') {
            const memoryDifference =
              (a.estimatedRamBytes ?? Number.MAX_SAFE_INTEGER) -
              (b.estimatedRamBytes ?? Number.MAX_SAFE_INTEGER);
            if (memoryDifference) return memoryDifference;
          }
          return a.name.localeCompare(b.name);
        }),
    [communityModels, models, workspace.hardware],
  );
  const shown = rankedModels.filter((model) => {
    const searchable =
      `${model.name} ${model.tags.join(' ')} ${model.parameters ?? ''}`.toLowerCase();
    return (
      (tab === 'all' || model.route.toLowerCase() === tab) &&
      (taskFilter === 'all' || model.tags.some((tag) => tag.toLowerCase() === taskFilter)) &&
      (sizeFilter === 'all' || modelSize(model) === sizeFilter) &&
      (fitFilter === 'all' || model.route !== 'Local' || model.fit === fitFilter) &&
      searchable.includes(modelQuery.trim().toLowerCase())
    );
  });
  const installedLocal = rankedModels.find(
    (model) =>
      model.route === 'Local' &&
      ['installed', 'ready', 'benchmarked', 'offline'].includes(model.status),
  );

  const runAction = async (
    action:
      | 'download'
      | 'load'
      | 'unload'
      | 'remove'
      | 'status'
      | 'benchmark'
      | 'pause'
      | 'resume'
      | 'cancel'
      | 'reset',
    model: ModelDescriptor,
  ) => {
    if (workingId) return;
    setActionError(null);
    setWorkingId(model.id);
    try {
      await workspace.runModelAction(action, model.runtimeModelId ?? model.id);
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : `Cupcake could not ${action} ${model.name}.`,
      );
    } finally {
      setWorkingId(null);
    }
  };
  const performSelection = async (model: ModelDescriptor, acknowledged = false) => {
    if (selectingId) return;
    if (requiresCompatibilityAcknowledgement(model) && !acknowledged) {
      setSelectionError(null);
      setCompatibilityAcknowledged(false);
      setPendingCompatibility(model);
      return;
    }
    setSelectionError(null);
    setSelectingId(model.id);
    try {
      const params = modelSelectionParams(model, acknowledged);
      await selectModel(params.modelId, { compatibilityConfirmed: params.compatibilityConfirmed });
      setPendingCompatibility(null);
      setCompatibilityAcknowledged(false);
    } catch (reason) {
      setSelectionError(
        reason instanceof Error ? reason.message : 'Cupcake could not select this model.',
      );
    } finally {
      setSelectingId(null);
    }
  };

  const primaryAction = (model: ModelDescriptor) => {
    const busy = workingId === model.id;
    if (model.status === 'community')
      return (
        <button
          className="button"
          onClick={() => {
            if (!model.sourceUrl) return;
            if (window.cupcake?.app) void window.cupcake.app.openExternal(model.sourceUrl);
            else window.open(model.sourceUrl, '_blank', 'noopener,noreferrer');
          }}
        >
          View model card
        </button>
      );
    if (model.selected)
      return (
        <span className="selected-label">
          <Icon name="check" />
          Default model
        </span>
      );
    if (model.route === 'Cloud' && model.status === 'setup')
      return (
        <button className="button" onClick={() => openProvider(providerDialogId(model.provider))}>
          Connect provider
        </button>
      );
    if (model.route === 'Cloud' || ['ready', 'benchmarked'].includes(model.status))
      return (
        <button
          className="button"
          disabled={Boolean(selectingId)}
          aria-busy={selectingId === model.id}
          onClick={() => void performSelection(model)}
        >
          {selectingId === model.id ? 'Selecting…' : 'Make default'}
        </button>
      );
    if (model.status === 'catalog' || model.status === 'incompatible')
      return (
        <button
          className="button"
          disabled={model.fit === 'incompatible'}
          onClick={() => setPendingDownload(model)}
        >
          {model.fit === 'incompatible' ? 'Does not fit' : 'Review install'}
        </button>
      );
    if (model.status === 'download' || model.status === 'verifying')
      return (
        <button className="button" disabled={busy} onClick={() => void runAction('status', model)}>
          Check status
        </button>
      );
    if (model.status === 'paused')
      return (
        <button className="button" disabled={busy} onClick={() => void runAction('resume', model)}>
          Resume download
        </button>
      );
    if (model.status === 'checksum-failed')
      return (
        <button className="button" disabled={busy} onClick={() => void runAction('reset', model)}>
          Discard and retry
        </button>
      );
    if (model.status === 'installed' || model.status === 'offline')
      return (
        <button className="button" disabled={busy} onClick={() => void runAction('load', model)}>
          {busy ? 'Loading…' : 'Load model'}
        </button>
      );
    if (model.status === 'error')
      return (
        <button className="button" disabled={busy} onClick={() => void runAction('resume', model)}>
          Retry download
        </button>
      );
    return (
      <button className="button" disabled>
        {modelStatusLabel(model.status)}
      </button>
    );
  };

  return (
    <main className="page models-page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Explicit routing · verified local catalog</p>
          <h2>Models</h2>
          <p>
            Choose a cloud model or install a signed Cupcake Local model. Cupcake never changes
            routes automatically.
          </p>
        </div>
        <div className="page-intro__actions">
          <button
            className="button"
            disabled={workspace.busy}
            onClick={() => void workspace.refresh()}
          >
            <Icon name="retry" />
            {workspace.busy ? 'Refreshing…' : 'Refresh catalog'}
          </button>
          <button className="button button--primary" onClick={() => openProvider('choose')}>
            <Icon name="plus" />
            Add provider
          </button>
        </div>
      </div>

      <section
        className={cx('hardware-card', !workspace.hardware?.ramBytes && 'is-pending')}
        aria-live="polite"
      >
        <div className="hardware-card__art">
          <span className="chip-lines" />
          <Icon name="local" size={34} />
        </div>
        <div>
          <span className="eyebrow">This computer</span>
          <h3>
            {workspace.hardware?.ramBytes
              ? 'Device profile detected'
              : 'Scanning device compatibility'}
          </h3>
          <p>
            {workspace.hardware?.cpu ?? 'Processor detection pending'}
            {workspace.hardware?.cpuArchitecture
              ? ` · ${workspace.hardware.cpuArchitecture}`
              : ''}{' '}
            · {workspace.hardware?.gpu ?? 'GPU detection pending'}
          </p>
          <div className="hardware-tags">
            <span>
              {workspace.hardware?.ramBytes
                ? `${formatStorage(workspace.hardware.ramBytes)} RAM`
                : 'RAM pending'}
            </span>
            <span>
              {workspace.hardware?.vramBytes
                ? `${formatStorage(workspace.hardware.vramBytes)} VRAM`
                : 'Dedicated VRAM not reported'}
            </span>
            <span>
              {workspace.hardware?.diskAvailableBytes
                ? `${formatStorage(workspace.hardware.diskAvailableBytes)} disk free`
                : 'Disk scan pending'}
            </span>
            {(workspace.hardware?.acceleration ?? []).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <div className="memory-plan-note">
            <Icon name="info" size={15} />
            <span>
              <strong>
                {workspace.settings.allowRamFallback
                  ? 'GPU-first with RAM fallback'
                  : 'VRAM-only placement'}
              </strong>
              {workspace.settings.allowRamFallback
                ? ` llama.cpp offloads as many layers as fit in VRAM, then may use system RAM up to the ${workspace.settings.maxRamGb} GB safety ceiling. Hybrid placement is slower and is never hidden.`
                : ' Cupcake requests all accelerated layers in VRAM with automatic fitting disabled. A model that does not fit fails clearly instead of spilling into RAM.'}
            </span>
          </div>
        </div>
        <div className="hardware-meter">
          <span>
            <strong>
              {workspace.hardware?.vramBytes ? formatStorage(workspace.hardware.vramBytes) : '—'}
            </strong>{' '}
            detected VRAM
          </span>
          <div>
            <i
              style={{
                width:
                  workspace.hardware?.vramBytes && workspace.hardware?.ramBytes
                    ? `${Math.min(100, Math.round((workspace.hardware.vramBytes / workspace.hardware.ramBytes) * 100))}%`
                    : '0%',
              }}
            />
          </div>
          <small>
            {workspace.hardware?.windowsVersion ??
              workspace.hardware?.os ??
              'Waiting for the runtime hardware report.'}
          </small>
        </div>
        <button
          className="button"
          disabled={!installedLocal || Boolean(workingId)}
          onClick={() => installedLocal && void runAction('benchmark', installedLocal)}
        >
          {workingId === installedLocal?.id
            ? 'Benchmarking…'
            : installedLocal
              ? `Benchmark ${installedLocal.name}`
              : 'Install a model to benchmark'}
        </button>
      </section>

      <section className="runtime-packs" aria-labelledby="runtime-packs-title">
        <header>
          <div>
            <span className="eyebrow">App-managed acceleration</span>
            <h3 id="runtime-packs-title">Local inference runtime</h3>
          </div>
          <p>
            The signed CPU baseline is always available. Optional GPU packs are verified and kept
            inside Cupcake—no third-party model server is required.
          </p>
        </header>
        <div className="runtime-pack-grid">
          {workspace.localRuntimes.map((runtime) => (
            <article
              className={cx(
                'runtime-pack',
                runtime.active && 'is-active',
                runtime.compatible === false && 'is-incompatible',
              )}
              key={runtime.id}
            >
              <div>
                <Icon name={runtime.backend?.startsWith('cuda') ? 'sparkle' : 'local'} />
                <span>
                  <strong>{runtime.name}</strong>
                  <small>
                    {runtime.active
                      ? 'Active runtime'
                      : runtime.status === 'installed'
                        ? 'Installed'
                        : runtime.recommended
                          ? 'Recommended for this device'
                          : cap(runtime.status.replace('-', ' '))}
                  </small>
                </span>
              </div>
              <p>{runtime.detail || 'Verified against the detected Windows hardware profile.'}</p>
              <footer>
                <span>{formatStorage(runtime.totalDownloadBytes ?? runtime.sizeBytes)}</span>
                {runtime.active ? (
                  <span className="selected-label">
                    <Icon name="check" /> Active
                  </span>
                ) : runtime.status === 'installed' ? (
                  <button
                    className="button"
                    disabled={workspace.busy}
                    onClick={() => void workspace.activateRuntimePack(runtime)}
                  >
                    Activate
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={runtime.compatible === false || workspace.busy}
                    onClick={() => setPendingRuntime(runtime)}
                  >
                    Review pack
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className="community-model-intro" aria-live="polite">
        <div className="community-model-intro__mark">HF</div>
        <div>
          <span className="eyebrow">Live Hugging Face discovery</span>
          <h3>Explore the wider GGUF community</h3>
          <p>
            Popular community model cards appear beside Cupcake's verified catalog. Search stays
            read-only: review upstream files, terms, and quantization before importing anything.
          </p>
        </div>
        <span className={cx('community-model-intro__state', communityError && 'is-error')}>
          {communityLoading
            ? 'Searching Hub…'
            : (communityError ?? `${communityModels.length} community results`)}
        </span>
      </section>

      <div className="toolbar model-toolbar">
        <div className="segmented" aria-label="Model location">
          {(['all', 'cloud', 'local'] as const).map((value) => (
            <button
              className={tab === value ? 'is-active' : ''}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
              key={value}
            >
              {value === 'all' ? 'All models' : cap(value)}
            </button>
          ))}
        </div>
        <label className="filter-field">
          <span>Task</span>
          <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}>
            <option value="all">Any task</option>
            <option value="coding">Coding</option>
            <option value="reasoning">Reasoning</option>
            <option value="vision">Vision</option>
            <option value="tools">Tools</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Size</span>
          <select value={sizeFilter} onChange={(event) => setSizeFilter(event.target.value)}>
            <option value="all">Any size</option>
            <option value="compact">Compact</option>
            <option value="balanced">Balanced</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Device fit</span>
          <select value={fitFilter} onChange={(event) => setFitFilter(event.target.value)}>
            <option value="all">Any fit</option>
            <option value="recommended">Recommended</option>
            <option value="hybrid">Hybrid</option>
            <option value="reduced-context">Reduced context</option>
            <option value="cpu-slow">CPU-heavy</option>
            <option value="pending">Scan pending</option>
          </select>
        </label>
        <label className="filter-field model-search-field">
          <span>Find a model</span>
          <div className="search-field">
            <Icon name="search" />
            <input
              aria-label="Find a model"
              placeholder="Search model families, capabilities, or parameter sizes"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
            />
            {modelQuery && (
              <button
                className="icon-button"
                onClick={() => setModelQuery('')}
                aria-label="Clear model search"
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        </label>
      </div>

      {(selectionError || actionError) && (
        <p className="field-error model-page-error" role="alert">
          {selectionError ?? actionError}
        </p>
      )}
      {shown.length ? (
        <div className="model-grid">
          {shown.map((model) => {
            const fit = model.fit ?? 'pending';
            const progress = model.download?.totalBytes
              ? Math.min(
                  100,
                  Math.round((model.download.bytesReceived / model.download.totalBytes) * 100),
                )
              : 0;
            const removable =
              model.route === 'Local' &&
              ![
                'catalog',
                'community',
                'download',
                'paused',
                'verifying',
                'loading',
                'unloading',
                'removing',
              ].includes(model.status);
            return (
              <article
                className={cx(
                  'model-card',
                  model.selected && 'is-selected',
                  model.fit === 'incompatible' && 'is-incompatible',
                )}
                key={model.id}
              >
                <header>
                  <span
                    className={cx(
                      'provider-logo',
                      model.route === 'Local' && 'provider-logo--cupcake-local',
                    )}
                  >
                    {model.provider === 'Hugging Face' ? (
                      <span className="hugging-face-mark" aria-label="Hugging Face">
                        🤗
                      </span>
                    ) : model.route === 'Local' ? (
                      <Icon name="local" />
                    ) : (
                      <img
                        src={`/providers/${providerDialogId(model.provider)}.svg`}
                        alt={`${model.provider} logo`}
                      />
                    )}
                  </span>
                  <div>
                    <span>{model.provider}</span>
                    <h3>{model.name}</h3>
                  </div>
                  <RouteBadge route={model.route} />
                </header>
                {model.route === 'Local' && (
                  <div className={cx('model-fit', `model-fit--${fit}`)}>
                    <strong>
                      {model.status === 'community'
                        ? 'Fit after quantization choice'
                        : fit === 'pending'
                          ? 'Device scan pending'
                          : cap(fit.replace('-', ' '))}
                    </strong>
                    <span>{model.fitReason}</span>
                  </div>
                )}
                <p>{model.description}</p>
                <div className="model-tags">
                  {model.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                  {model.quantization && <em>{model.quantization}</em>}
                  {model.parameters && <em>{model.parameters}</em>}
                </div>
                <dl className="model-specs">
                  <div>
                    <dt>Context</dt>
                    <dd>{model.context}</dd>
                  </div>
                  <div>
                    <dt>{model.route === 'Local' ? 'Download' : 'Cost'}</dt>
                    <dd>
                      {model.route === 'Local'
                        ? model.status === 'community'
                          ? `${(model.downloads ?? 0).toLocaleString()} downloads`
                          : formatStorage(model.fileSizeBytes ?? model.estimatedDiskBytes)
                        : model.cost}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <StatusDot status={model.status} />
                      {modelStatusLabel(model.status)}
                    </dd>
                  </div>
                  {model.status === 'community' ? (
                    <>
                      <div>
                        <dt>Source</dt>
                        <dd>Hugging Face</dd>
                      </div>
                      <div>
                        <dt>License</dt>
                        <dd>{model.license ?? 'Review card'}</dd>
                      </div>
                      <div>
                        <dt>Access</dt>
                        <dd>{model.gated ? 'Gated' : 'Public card'}</dd>
                      </div>
                    </>
                  ) : model.route === 'Local' ? (
                    <>
                      <div>
                        <dt>RAM estimate</dt>
                        <dd>{formatStorage(model.estimatedRamBytes)}</dd>
                      </div>
                      <div>
                        <dt>VRAM estimate</dt>
                        <dd>{formatStorage(model.estimatedVramBytes)}</dd>
                      </div>
                      <div>
                        <dt>License</dt>
                        <dd>{model.license ?? 'See catalog'}</dd>
                      </div>
                    </>
                  ) : null}
                </dl>
                {['download', 'paused', 'verifying'].includes(model.status) &&
                  model.download &&
                  model.download.totalBytes > 0 && (
                    <div className="download-progress" aria-label={`${model.name} download`}>
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                      >
                        <i style={{ width: `${progress}%` }} />
                      </div>
                      <span>
                        {progress}% · {formatStorage(model.download.bytesReceived)} of{' '}
                        {formatStorage(model.download.totalBytes)}
                        {model.download.bytesPerSecond
                          ? ` · ${formatStorage(model.download.bytesPerSecond)}/s`
                          : ''}
                        <br />
                        Checksum: {model.download.checksumState ?? 'pending'}
                      </span>
                      <button
                        aria-label={`${model.status === 'paused' ? 'Resume' : 'Pause'} download for ${model.name}`}
                        onClick={() =>
                          void runAction(model.status === 'paused' ? 'resume' : 'pause', model)
                        }
                      >
                        <Icon name={model.status === 'paused' ? 'play' : 'pause'} />
                      </button>
                      <button
                        aria-label={`Cancel download for ${model.name}`}
                        onClick={() => void runAction('cancel', model)}
                      >
                        <Icon name="x" />
                      </button>
                    </div>
                  )}
                {model.benchmark && (
                  <p className="benchmark-result">
                    <strong>{model.benchmark.tokensPerSecond.toFixed(1)} tok/s</strong> ·{' '}
                    {model.benchmark.contextTokens.toLocaleString()} token test ·{' '}
                    {new Date(model.benchmark.measuredAt).toLocaleDateString()}
                  </p>
                )}
                <footer>
                  <div className="model-actions">
                    {primaryAction(model)}
                    {['ready', 'benchmarked'].includes(model.status) && model.route === 'Local' && (
                      <button
                        className="button button--quiet"
                        disabled={workingId === model.id}
                        onClick={() => void runAction('unload', model)}
                      >
                        Unload
                      </button>
                    )}
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${model.name}`}
                    onClick={() => setPendingRemove(model)}
                    disabled={!removable}
                  >
                    <Icon name="trash" />
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="empty-state model-empty">
          <Icon name="model" size={30} />
          <h3>No models match these filters</h3>
          <p>
            Clear a filter or refresh the signed catalog. Cupcake Local remains available without a
            third-party model server.
          </p>
          <button
            className="button"
            onClick={() => {
              setTab('all');
              setTaskFilter('all');
              setSizeFilter('all');
              setFitFilter('all');
              setModelQuery('');
            }}
          >
            Clear filters
          </button>
        </section>
      )}

      {pendingDownload && (
        <div className="popover-layer">
          <section
            ref={installRef}
            className="provider-dialog model-install-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-install-title"
          >
            <header>
              <div>
                <span className="eyebrow">Signed Cupcake Local catalog</span>
                <h2 id="model-install-title">Review {pendingDownload.name}</h2>
              </div>
              <button className="icon-button" onClick={closeInstall} aria-label="Cancel install">
                <Icon name="x" />
              </button>
            </header>
            <div className={cx('model-fit', `model-fit--${pendingDownload.fit ?? 'pending'}`)}>
              <strong>
                {pendingDownload.fit === 'pending'
                  ? 'Device scan pending'
                  : cap((pendingDownload.fit ?? 'pending').replace('-', ' '))}
              </strong>
              <span>{pendingDownload.fitReason}</span>
            </div>
            <dl className="permission-list">
              <div>
                <dt>Catalog source</dt>
                <dd>{pendingDownload.source ?? 'Cupcake Local signed catalog'}</dd>
              </div>
              <div>
                <dt>Artifact</dt>
                <dd>
                  {pendingDownload.parameters ?? 'Size not reported'} ·{' '}
                  {pendingDownload.quantization ?? 'Quantization not reported'} ·{' '}
                  {formatStorage(pendingDownload.fileSizeBytes)}
                </dd>
              </div>
              <div>
                <dt>Memory estimate</dt>
                <dd>
                  {formatStorage(pendingDownload.estimatedRamBytes)} RAM ·{' '}
                  {formatStorage(pendingDownload.estimatedVramBytes)} VRAM ·{' '}
                  {formatStorage(pendingDownload.estimatedDiskBytes)} disk
                </dd>
              </div>
              <div>
                <dt>Integrity</dt>
                <dd>
                  Catalog signature is checked before download; SHA-256 is checked before install.
                </dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>
                  {pendingDownload.license ?? 'Open the catalog source to review the model terms.'}
                </dd>
              </div>
            </dl>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={licenseAccepted}
                onChange={(event) => setLicenseAccepted(event.target.checked)}
              />
              <span>I reviewed this catalog entry, its license, and the storage estimate.</span>
            </label>
            <footer>
              <button className="button" onClick={closeInstall}>
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                disabled={
                  !licenseAccepted ||
                  pendingDownload.fit === 'incompatible' ||
                  workingId === pendingDownload.id
                }
                onClick={() => {
                  void runAction('download', pendingDownload);
                  closeInstall();
                }}
              >
                Start verified download
              </button>
            </footer>
          </section>
        </div>
      )}
      {pendingRuntime && (
        <div className="popover-layer">
          <section
            ref={runtimeInstallRef}
            className="provider-dialog model-install-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-install-title"
          >
            <header>
              <div>
                <span className="eyebrow">Signed acceleration component</span>
                <h2 id="runtime-install-title">Install {pendingRuntime.name}?</h2>
              </div>
              <button
                className="icon-button"
                onClick={closeRuntimeInstall}
                aria-label="Cancel runtime install"
              >
                <Icon name="x" />
              </button>
            </header>
            <dl className="permission-list">
              <div>
                <dt>Download</dt>
                <dd>{formatStorage(pendingRuntime.totalDownloadBytes)}</dd>
              </div>
              <div>
                <dt>Integrity</dt>
                <dd>Signed catalog, pinned revision, SHA-256, and per-file hashes.</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>{pendingRuntime.license ?? 'See the pinned upstream catalog.'}</dd>
              </div>
              {(pendingRuntime.prerequisites ?? []).map((item) => (
                <div key={item}>
                  <dt>Requirement</dt>
                  <dd>{item}</dd>
                </div>
              ))}
              {(pendingRuntime.licenseUrls ?? []).map((url) => (
                <div key={url}>
                  <dt>Required terms</dt>
                  <dd>
                    <a
                      href={url}
                      onClick={(event) => {
                        event.preventDefault();
                        void window.cupcake?.app.openExternal(url);
                      }}
                    >
                      Review NVIDIA CUDA Toolkit EULA
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={runtimeTermsAccepted}
                onChange={(event) => setRuntimeTermsAccepted(event.target.checked)}
              />
              <span>
                I reviewed the runtime license, device requirements, and any required companion
                terms shown above.
              </span>
            </label>
            <footer>
              <button className="button" onClick={closeRuntimeInstall}>
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                disabled={!runtimeTermsAccepted || workspace.busy}
                onClick={() => {
                  const runtime = pendingRuntime;
                  void workspace
                    .installRuntimePack(runtime.id, runtime.licenseUrls ?? [])
                    .finally(closeRuntimeInstall);
                }}
              >
                {workspace.busy ? 'Installing…' : 'Download and verify'}
              </button>
            </footer>
          </section>
        </div>
      )}
      {pendingRemove && (
        <div className="popover-layer">
          <section
            ref={removeRef}
            className="provider-dialog model-remove-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="model-remove-title"
          >
            <header>
              <div>
                <span className="eyebrow">Remove local files</span>
                <h2 id="model-remove-title">Remove {pendingRemove.name}?</h2>
              </div>
              <button className="icon-button" onClick={closeRemove} aria-label="Cancel removal">
                <Icon name="x" />
              </button>
            </header>
            <div className="provider-remove-warning">
              <Icon name="trash" />
              <div>
                <strong>This deletes the installed weights from this device.</strong>
                <p>
                  The signed catalog entry stays available, so you can download it again later.
                  Cloud providers and other local models are untouched.
                </p>
              </div>
            </div>
            <footer>
              <button className="button" onClick={closeRemove}>
                Keep model
              </button>
              <span />
              <button
                className="button button--danger"
                onClick={() => {
                  void runAction('remove', pendingRemove);
                  closeRemove();
                }}
              >
                Remove local files
              </button>
            </footer>
          </section>
        </div>
      )}
      <ModelCompatibilityDialog
        model={pendingCompatibility}
        acknowledged={compatibilityAcknowledged}
        setAcknowledged={setCompatibilityAcknowledged}
        busy={selectingId !== null}
        error={selectionError}
        cancel={() => {
          if (selectingId) return;
          setPendingCompatibility(null);
          setCompatibilityAcknowledged(false);
        }}
        confirm={() => {
          if (pendingCompatibility) void performSelection(pendingCompatibility, true);
        }}
      />
    </main>
  );
}

function ModelCompatibilityDialog({
  model,
  acknowledged,
  setAcknowledged,
  busy,
  error,
  cancel,
  confirm,
}: {
  model: ModelDescriptor | null;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  busy: boolean;
  error: string | null;
  cancel: () => void;
  confirm: () => void;
}) {
  if (!model) return null;
  return (
    <div className="popover-layer">
      <section
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm unverified model compatibility"
      >
        <header>
          <div>
            <span className="eyebrow">Compatibility acknowledgement</span>
            <h2>Confirm {model.name}</h2>
          </div>
          <button className="icon-button" onClick={cancel} disabled={busy} aria-label="Cancel">
            <Icon name="x" />
          </button>
        </header>
        <div className="security-note">
          <Icon name="info" />
          <div>
            <strong>NVIDIA did not declare this model as a chat endpoint.</strong>
            <p>
              It may reject chat requests or return an unexpected format. CupcakeAI will remember
              this acknowledgement for this exact model only.
            </p>
          </div>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>I checked the model information and accept the unverified compatibility.</span>
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button className="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <span />
          <button
            className="button button--primary"
            disabled={!acknowledged || busy}
            aria-busy={busy}
            onClick={confirm}
          >
            {busy ? 'Selecting…' : 'Confirm and select'}
          </button>
        </footer>
      </section>
    </div>
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
  const [toolQuery, setToolQuery] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [freedomPhrase, setFreedomPhrase] = useState('');
  const shown = tools.filter(
    (tool) =>
      (tab === 'all' || tool.kind === tab) &&
      `${tool.name} ${tool.provider} ${tool.description}`
        .toLowerCase()
        .includes(toolQuery.trim().toLowerCase()),
  );
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
      <div
        className={cx(
          'security-note',
          workspace.settings.permissionMode === 'full-freedom' && 'is-danger',
        )}
      >
        <Icon name="shield" />
        <div>
          <strong>
            {workspace.settings.permissionMode === 'full-freedom'
              ? 'Full freedom is active.'
              : 'High-impact actions always ask.'}
          </strong>
          <p>
            {workspace.settings.permissionMode === 'full-freedom'
              ? 'CupcakeAI can run tools without approval prompts. Tool activity remains audited.'
              : 'Deletion, external communication, purchases, installation, system changes, and unsandboxed execution require a fresh approval.'}
          </p>
        </div>
        <button className="text-button" onClick={() => setPolicyOpen(true)}>
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
          <input
            aria-label="Find a tool"
            placeholder="Find a tool"
            value={toolQuery}
            onChange={(event) => setToolQuery(event.target.value)}
          />
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
      {tools.length > 0 && shown.length === 0 && (
        <EmptyState
          icon="search"
          title="No matching tools"
          body="Try a shorter name or switch tool categories."
          action="Clear search"
          onAction={() => {
            setToolQuery('');
            setTab('all');
          }}
        />
      )}
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
      {policyOpen && (
        <div
          className="popover-layer"
          onMouseDown={(event) => event.target === event.currentTarget && setPolicyOpen(false)}
        >
          <section
            className="provider-dialog permission-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Permission policy"
          >
            <header>
              <div>
                <span className="eyebrow">Tool authority</span>
                <h2>Permission policy</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setPolicyOpen(false)}
                aria-label="Close permission policy"
              >
                <Icon name="x" />
              </button>
            </header>
            <div className="permission-mode-list">
              <button
                className={cx(workspace.settings.permissionMode === 'guarded' && 'is-active')}
                onClick={() => {
                  void workspace.updateSettings({ permissionMode: 'guarded' });
                  setFreedomPhrase('');
                }}
              >
                <Icon name="shield" />
                <span>
                  <strong>Guarded</strong>
                  <small>Ask before high-impact actions. Recommended.</small>
                </span>
                {workspace.settings.permissionMode === 'guarded' && <Icon name="check" />}
              </button>
              <div
                className={cx(
                  'permission-mode-danger',
                  workspace.settings.permissionMode === 'full-freedom' && 'is-active',
                )}
              >
                <div>
                  <Icon name="info" />
                  <span>
                    <strong>Full freedom</strong>
                    <small>
                      No permission prompts, including deletion, external communication, installs,
                      system changes, and unsandboxed execution.
                    </small>
                  </span>
                </div>
                {workspace.settings.permissionMode === 'full-freedom' ? (
                  <button
                    className="button"
                    onClick={() => void workspace.updateSettings({ permissionMode: 'guarded' })}
                  >
                    Return to guarded
                  </button>
                ) : (
                  <>
                    <label>
                      <span>Type FULL FREEDOM to enable</span>
                      <input
                        value={freedomPhrase}
                        onChange={(event) => setFreedomPhrase(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <button
                      className="button button--danger"
                      disabled={freedomPhrase !== 'FULL FREEDOM'}
                      onClick={() => {
                        void workspace.updateSettings({ permissionMode: 'full-freedom' });
                        setFreedomPhrase('');
                      }}
                    >
                      Enable full freedom
                    </button>
                  </>
                )}
              </div>
            </div>
            <footer>
              <span>
                Changes apply at the local Rust tool broker and are recorded in its security store.
              </span>
            </footer>
          </section>
        </div>
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
          title: 'CupcakeAI architecture.md',
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

function ProviderLogo({ id, name }: { id: string; name: string }) {
  if (id === 'openai-compatible') {
    return (
      <span className="provider-logo provider-logo--generic" aria-hidden="true">
        <Icon name="cloud" size={18} />
      </span>
    );
  }
  return (
    <span className="provider-logo">
      <img src={`/providers/${id}.svg`} alt={`${name} logo`} />
    </span>
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
  onReplayOnboarding,
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
  onReplayOnboarding?: () => void;
}) {
  const workspace = useWorkspace();
  const tabs = [
    'General',
    'Profile',
    'Personality',
    'Appearance',
    'Window',
    'Local models',
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
  const [currentWorkspacePassword, setCurrentWorkspacePassword] = useState('');
  const [newWorkspacePassword, setNewWorkspacePassword] = useState('');
  const [confirmWorkspacePassword, setConfirmWorkspacePassword] = useState('');
  const [workspacePasswordBusy, setWorkspacePasswordBusy] = useState(false);
  const [workspacePasswordMessage, setWorkspacePasswordMessage] = useState('');
  const [profileUploadError, setProfileUploadError] = useState('');
  const [windowPreferences, setWindowPreferences] = useState<WindowPreferences>({
    startupBehavior: 'open',
    closeBehavior: 'quit',
    minimizeBehavior: 'taskbar',
    showInTaskbar: true,
    alwaysOnTop: false,
    launchAtLogin: false,
  });
  const [windowPreferencesError, setWindowPreferencesError] = useState('');
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
    ['Remote OpenAI-compatible', 'openai-compatible'],
  ] as const;
  const semanticModels = workspace.models.filter(
    (model) =>
      model.provider === 'NVIDIA NIM' && model.tags.some((tag) => /embed|rerank/i.test(tag)),
  );
  const updateProfile = (patch: Partial<WorkspaceSettings['profile']>) =>
    workspace.updateSettings({ profile: { ...workspace.settings.profile, ...patch } });
  const uploadProfileImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setProfileUploadError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setProfileUploadError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > 750 * 1024) {
      setProfileUploadError('Keep the profile image under 750 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') void updateProfile({ avatar: reader.result });
      else setProfileUploadError('CupcakeAI could not read that image.');
    };
    reader.onerror = () => setProfileUploadError('CupcakeAI could not read that image.');
    reader.readAsDataURL(file);
  };
  useEffect(() => {
    void window.cupcake?.window
      .getPreferences?.()
      .then(setWindowPreferences)
      .catch((error: unknown) => setWindowPreferencesError(hostErrorMessage(error)));
  }, []);
  const updateWindowPreferences = (patch: Partial<WindowPreferences>) => {
    const next = { ...windowPreferences, ...patch };
    setWindowPreferences(next);
    setWindowPreferencesError('');
    if (!window.cupcake?.window.setPreferences) return;
    void window.cupcake.window
      .setPreferences(next)
      .then(setWindowPreferences)
      .catch((error: unknown) => {
        setWindowPreferences(windowPreferences);
        setWindowPreferencesError(hostErrorMessage(error));
      });
  };
  return (
    <main className="settings-layout">
      <aside>
        <h2>Settings</h2>
        {tabs.map((t) => (
          <button
            className={tab === t ? 'is-active' : ''}
            onClick={() => setTab(t)}
            data-tour={t === 'Profile' ? 'profile' : t === 'Privacy' ? 'permissions' : undefined}
            key={t}
          >
            <Icon
              name={
                t === 'Personality'
                  ? 'sparkle'
                  : t === 'Profile'
                    ? 'user'
                    : t === 'Appearance'
                      ? 'palette'
                      : t === 'Window'
                        ? 'window'
                        : t === 'Local models'
                          ? 'local'
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
              <label className="instruction-editor">
                <span className="instruction-editor__bar">
                  <span>
                    <Icon name="edit" size={14} /> Your guidance
                  </span>
                  <small>{workspace.settings.personalityInstructions.length}/4,000</small>
                </span>
                <textarea
                  maxLength={4000}
                  value={workspace.settings.personalityInstructions}
                  onChange={(event) =>
                    void workspace.updateSettings({ personalityInstructions: event.target.value })
                  }
                  placeholder="For example: Lead with the decision and show exact tradeoffs."
                />
                <span className="instruction-suggestions">
                  {[
                    'Lead with the answer',
                    'Explain unfamiliar terms',
                    'Point out important risks',
                  ].map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion}
                      onClick={() =>
                        void workspace.updateSettings({
                          personalityInstructions: [
                            workspace.settings.personalityInstructions.trim(),
                            suggestion,
                          ]
                            .filter(Boolean)
                            .join('\n'),
                        })
                      }
                    >
                      <Icon name="plus" size={11} /> {suggestion}
                    </button>
                  ))}
                </span>
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
            <div className="setting-row">
              <span>
                <strong>Scrollbars</strong>
                <small>Keep them easy to grab, make them minimal, or hide them completely.</small>
              </span>
              <div className="segmented-control" aria-label="Scrollbar visibility">
                {(['slim', 'minimal', 'hidden'] as const).map((mode) => (
                  <button
                    className={workspace.settings.scrollbarMode === mode ? 'is-active' : ''}
                    onClick={() => void workspace.updateSettings({ scrollbarMode: mode })}
                    key={mode}
                  >
                    {cap(mode)}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}
        {tab === 'Profile' && (
          <>
            <section className="settings-section profile-editor">
              <header>
                <h2>Your local profile</h2>
                <p>This information personalizes the app and stays in your encrypted workspace.</p>
              </header>
              <div className="profile-editor__identity">
                <span className="profile-editor__portrait">
                  <CupcakePortrait
                    value={workspace.settings.profile.avatar}
                    label="Current profile"
                  />
                </span>
                <div>
                  <strong>{workspace.settings.profile.displayName || 'Your name'}</strong>
                  <small>{workspace.settings.profile.role || 'Add what you do'}</small>
                </div>
              </div>
              <div className="profile-fields">
                <label>
                  Display name
                  <input
                    maxLength={80}
                    value={workspace.settings.profile.displayName}
                    onChange={(event) => void updateProfile({ displayName: event.target.value })}
                  />
                </label>
                <label>
                  Role or focus
                  <input
                    maxLength={120}
                    value={workspace.settings.profile.role}
                    onChange={(event) => void updateProfile({ role: event.target.value })}
                    placeholder="Builder, researcher, student…"
                  />
                </label>
                <label className="profile-fields__wide">
                  A little context for Cupcake
                  <textarea
                    maxLength={500}
                    value={workspace.settings.profile.bio}
                    onChange={(event) => void updateProfile({ bio: event.target.value })}
                    placeholder="What are you working toward, and how can Cupcake help?"
                  />
                </label>
              </div>
            </section>
            <section className="settings-section">
              <header>
                <h2>Profile picture</h2>
                <p>Pick a Cupcake or upload a small image of your own.</p>
              </header>
              <div className="avatar-picker">
                {CUPCAKE_AVATARS.map(({ value, label }) => (
                  <button
                    className={workspace.settings.profile.avatar === value ? 'is-active' : ''}
                    onClick={() => void updateProfile({ avatar: value })}
                    title={label}
                    key={value}
                  >
                    <CupcakePortrait value={value} label={label} />
                    {workspace.settings.profile.avatar === value && <Icon name="check" />}
                  </button>
                ))}
                <label className="avatar-upload">
                  <Icon name="upload" />
                  <span>Upload</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={uploadProfileImage}
                  />
                </label>
              </div>
              {profileUploadError && <p className="field-error">{profileUploadError}</p>}
            </section>
            <section className="settings-section assistant-identity-editor">
              <header>
                <h2>Your CupcakeAI assistant</h2>
                <p>Choose the Cupcake who appears on Home and beside assistant messages.</p>
              </header>
              <div className="assistant-identity-preview">
                <CupcakePortrait
                  value={workspace.settings.assistantAvatar}
                  label="Selected CupcakeAI assistant"
                />
                <span>
                  <strong>This is your Cupcake</strong>
                  <small>The portrait changes the character you see, not model behavior.</small>
                </span>
              </div>
              <div className="avatar-picker avatar-picker--assistant">
                {CUPCAKE_AVATARS.map(({ value, label }) => (
                  <button
                    className={workspace.settings.assistantAvatar === value ? 'is-active' : ''}
                    onClick={() => void workspace.updateSettings({ assistantAvatar: value })}
                    title={label}
                    key={`assistant-${value}`}
                  >
                    <CupcakePortrait value={value} label={`${label} assistant`} />
                    {workspace.settings.assistantAvatar === value && <Icon name="check" />}
                  </button>
                ))}
              </div>
            </section>
          </>
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
            <div className="setting-row">
              <span>
                <strong>Welcome tour</strong>
                <small>
                  Replay the guided introduction to chats, projects, tasks, models, and privacy.
                </small>
              </span>
              <button className="button" onClick={onReplayOnboarding}>
                <Icon name="sparkle" /> Replay onboarding
              </button>
            </div>
          </section>
        )}
        {tab === 'Local models' && (
          <section className="settings-section">
            <header>
              <h2>GPU and system memory</h2>
              <p>Control what happens when a local model cannot fit entirely in NVIDIA VRAM.</p>
            </header>
            <div className="setting-row">
              <span>
                <strong>Allow system RAM fallback</strong>
                <small>
                  Offload overflow layers to system RAM. This can run larger models, but it is much
                  slower than VRAM.
                </small>
              </span>
              <Toggle
                checked={workspace.settings.allowRamFallback}
                onChange={() =>
                  void workspace.updateSettings({
                    allowRamFallback: !workspace.settings.allowRamFallback,
                  })
                }
                label="Allow system RAM fallback"
              />
            </div>
            <div
              className={cx('setting-row', !workspace.settings.allowRamFallback && 'is-disabled')}
            >
              <span>
                <strong>Maximum system RAM for a model</strong>
                <small>
                  Safety ceiling for model weights and context cache. Cupcake leaves the rest for
                  Windows.
                </small>
              </span>
              <label className="number-setting">
                <input
                  type="number"
                  min="4"
                  max="256"
                  step="1"
                  disabled={!workspace.settings.allowRamFallback}
                  value={workspace.settings.maxRamGb}
                  onChange={(event) =>
                    void workspace.updateSettings({
                      maxRamGb: Math.max(4, Math.min(256, Number(event.target.value) || 4)),
                    })
                  }
                />
                <span>GB</span>
              </label>
            </div>
            <div className="setting-row">
              <span>
                <strong>Unload idle local models</strong>
                <small>Release RAM and VRAM automatically after the selected idle period.</small>
              </span>
              <Toggle
                checked={workspace.settings.autoEvictLocalModels}
                onChange={() =>
                  void workspace.updateSettings({
                    autoEvictLocalModels: !workspace.settings.autoEvictLocalModels,
                  })
                }
                label="Unload idle local models"
              />
            </div>
            <div
              className={cx(
                'setting-row',
                !workspace.settings.autoEvictLocalModels && 'is-disabled',
              )}
            >
              <span>
                <strong>Idle time before unload</strong>
                <small>Each local chat resets this timer.</small>
              </span>
              <label className="number-setting">
                <input
                  type="number"
                  min="1"
                  max="240"
                  disabled={!workspace.settings.autoEvictLocalModels}
                  value={workspace.settings.localModelIdleMinutes}
                  onChange={(event) =>
                    void workspace.updateSettings({
                      localModelIdleMinutes: Math.max(
                        1,
                        Math.min(240, Number(event.target.value) || 1),
                      ),
                    })
                  }
                />
                <span>min</span>
              </label>
            </div>
            <div className="setting-row">
              <span>
                <strong>Keep RAM free for Windows</strong>
                <small>Cupcake subtracts this reserve from the live available-memory budget.</small>
              </span>
              <label className="number-setting">
                <input
                  type="number"
                  min="2"
                  max="64"
                  step="1"
                  value={workspace.settings.reserveSystemRamGb}
                  onChange={(event) =>
                    void workspace.updateSettings({
                      reserveSystemRamGb: Math.max(
                        2,
                        Math.min(64, Number(event.target.value) || 2),
                      ),
                    })
                  }
                />
                <span>GB</span>
              </label>
            </div>
            <div className="setting-row">
              <span>
                <strong>Keep VRAM free for the desktop</strong>
                <small>Leaves headroom for WebView2, displays, and other GPU applications.</small>
              </span>
              <label className="number-setting">
                <input
                  type="number"
                  min="0.5"
                  max="16"
                  step="0.5"
                  value={workspace.settings.reserveVramGb}
                  onChange={(event) =>
                    void workspace.updateSettings({
                      reserveVramGb: Math.max(0.5, Math.min(16, Number(event.target.value) || 0.5)),
                    })
                  }
                />
                <span>GB</span>
              </label>
            </div>
            <div className="security-note">
              <Icon name="info" />
              <div>
                <strong>
                  {workspace.settings.allowRamFallback
                    ? 'Hybrid loading is allowed'
                    : 'VRAM-only loading'}
                </strong>
                <p>
                  {workspace.settings.allowRamFallback
                    ? 'Cupcake may use both VRAM and RAM when the runtime supports layer offload. The Models page reports the active placement.'
                    : 'Cupcake asks the runtime to keep all accelerated layers in VRAM and fails clearly if the selected model does not fit.'}
                </p>
              </div>
            </div>
          </section>
        )}
        {tab === 'Window' && (
          <>
            <section className="settings-section">
              <header>
                <h2>Startup and Windows</h2>
                <p>Choose where CupcakeAI appears and how it behaves with the Windows session.</p>
              </header>
              <div className="setting-row">
                <span>
                  <strong>Open at sign-in</strong>
                  <small>Register CupcakeAI for the current Windows user.</small>
                </span>
                <Toggle
                  checked={windowPreferences.launchAtLogin}
                  onChange={() =>
                    updateWindowPreferences({ launchAtLogin: !windowPreferences.launchAtLogin })
                  }
                  label="Open CupcakeAI at sign-in"
                />
              </div>
              <div className="setting-row">
                <span>
                  <strong>When CupcakeAI starts</strong>
                  <small>Open the window, minimize it, or remain quietly in the tray.</small>
                </span>
                <div className="segmented-control" aria-label="Startup behavior">
                  {(['open', 'minimized', 'tray'] as const).map((behavior) => (
                    <button
                      className={windowPreferences.startupBehavior === behavior ? 'is-active' : ''}
                      onClick={() => updateWindowPreferences({ startupBehavior: behavior })}
                      key={behavior}
                    >
                      {behavior === 'open'
                        ? 'Open'
                        : behavior === 'minimized'
                          ? 'Minimized'
                          : 'Tray'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>
                  <strong>Show on the taskbar</strong>
                  <small>Turn this off for a tray-first workspace.</small>
                </span>
                <Toggle
                  checked={windowPreferences.showInTaskbar}
                  onChange={() =>
                    updateWindowPreferences({ showInTaskbar: !windowPreferences.showInTaskbar })
                  }
                  label="Show on taskbar"
                />
              </div>
              <div className="setting-row">
                <span>
                  <strong>Always on top</strong>
                  <small>Keep the CupcakeAI window above ordinary desktop windows.</small>
                </span>
                <Toggle
                  checked={windowPreferences.alwaysOnTop}
                  onChange={() =>
                    updateWindowPreferences({ alwaysOnTop: !windowPreferences.alwaysOnTop })
                  }
                  label="Always on top"
                />
              </div>
            </section>
            <section className="settings-section">
              <header>
                <h2>Minimize and close</h2>
                <p>These choices are enforced by the native desktop host.</p>
              </header>
              <div className="setting-row">
                <span>
                  <strong>Minimize button</strong>
                  <small>Send the window to the taskbar or hide it in the tray.</small>
                </span>
                <div className="segmented-control" aria-label="Minimize behavior">
                  {(['taskbar', 'tray'] as const).map((behavior) => (
                    <button
                      className={windowPreferences.minimizeBehavior === behavior ? 'is-active' : ''}
                      onClick={() => updateWindowPreferences({ minimizeBehavior: behavior })}
                      key={behavior}
                    >
                      {cap(behavior)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>
                  <strong>Close button</strong>
                  <small>
                    Quit immediately by default, or explicitly keep CupcakeAI running in the tray.
                  </small>
                </span>
                <div className="segmented-control" aria-label="Close behavior">
                  {(['quit', 'tray'] as const).map((behavior) => (
                    <button
                      className={
                        windowPreferences.closeBehavior === behavior ||
                        (behavior === 'quit' && windowPreferences.closeBehavior === 'ask')
                          ? 'is-active'
                          : ''
                      }
                      onClick={() => updateWindowPreferences({ closeBehavior: behavior })}
                      key={behavior}
                    >
                      {behavior === 'quit' ? 'Close app' : 'Close to tray'}
                    </button>
                  ))}
                </div>
              </div>
              {windowPreferencesError && (
                <p className="field-error" role="alert">
                  {windowPreferencesError}
                </p>
              )}
            </section>
          </>
        )}
        {tab === 'Privacy' && (
          <>
            <section className="settings-section">
              <header>
                <h2>Workspace password</h2>
                <p>
                  CupcakeAI requires this password before starting local models, tools, or cloud
                  provider connections.
                </p>
              </header>
              <form
                className="workspace-password-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setWorkspacePasswordMessage('');
                  if (newWorkspacePassword !== confirmWorkspacePassword) {
                    setWorkspacePasswordMessage('The new passwords do not match.');
                    return;
                  }
                  if (newWorkspacePassword.length < 15) {
                    setWorkspacePasswordMessage('Use at least 15 characters.');
                    return;
                  }
                  setWorkspacePasswordBusy(true);
                  void window.cupcake?.workspace
                    .changePassword(currentWorkspacePassword, newWorkspacePassword)
                    .then(() => {
                      setCurrentWorkspacePassword('');
                      setNewWorkspacePassword('');
                      setConfirmWorkspacePassword('');
                      setWorkspacePasswordMessage('Password changed.');
                    })
                    .catch((error: unknown) => setWorkspacePasswordMessage(hostErrorMessage(error)))
                    .finally(() => setWorkspacePasswordBusy(false));
                }}
              >
                <label>
                  Current password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={currentWorkspacePassword}
                    onChange={(event) => setCurrentWorkspacePassword(event.target.value)}
                    required
                  />
                </label>
                <label>
                  New password
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={128}
                    value={newWorkspacePassword}
                    onChange={(event) => setNewWorkspacePassword(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={128}
                    value={confirmWorkspacePassword}
                    onChange={(event) => setConfirmWorkspacePassword(event.target.value)}
                    required
                  />
                </label>
                {workspacePasswordMessage && (
                  <p
                    className={cx(
                      'field-message',
                      workspacePasswordMessage !== 'Password changed.' && 'field-error',
                    )}
                    role="status"
                  >
                    {workspacePasswordMessage}
                  </p>
                )}
                <div className="workspace-password-form__actions">
                  <button className="button button--primary" disabled={workspacePasswordBusy}>
                    {workspacePasswordBusy ? 'Changing…' : 'Change password'}
                  </button>
                  <button
                    className="button"
                    type="button"
                    onClick={() => void window.cupcake?.workspace.lock()}
                  >
                    <Icon name="shield" /> Lock now
                  </button>
                </div>
              </form>
              <div className="security-note">
                <Icon name="shield" />
                <div>
                  <strong>Two local protection layers</strong>
                  <p>
                    The app password blocks CupcakeAI itself. Windows DPAPI separately protects the
                    encrypted workspace key and provider credentials at rest.
                  </p>
                </div>
              </div>
            </section>
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
              <div className={cx('provider-row', providerStates[id] && 'is-connected')} key={id}>
                <ProviderLogo id={id} name={name} />
                <span>
                  <strong>{name}</strong>
                  <small>
                    {providerStates[id]
                      ? 'Connected · protected by Windows DPAPI'
                      : 'Not connected'}
                  </small>
                </span>
                <span className={cx('provider-status', providerStates[id] && 'is-connected')}>
                  <i /> {providerStates[id] ? 'Connected' : 'Not connected'}
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
              <span className="select-button" aria-label="Diagnostic retention: 30 days">
                30 days · fixed policy
              </span>
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
              ['Global search', 'Ctrl', 'F'],
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
  const [eventQuery, setEventQuery] = useState('');
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
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
  const visibleEvents = events.filter((event) => {
    const matchesTab =
      tab === 'Events' ||
      (tab === 'Errors' && event.type.toLowerCase().includes('error')) ||
      (tab === 'Retrieval' && event.type.toLowerCase().includes('retrieval')) ||
      (tab === 'Runs' && /run|task|checkpoint|subagent/i.test(event.type));
    return (
      matchesTab &&
      `${event.time} ${event.type} ${event.detail}`
        .toLowerCase()
        .includes(eventQuery.trim().toLowerCase())
    );
  });
  const selectedEvent = events.find((event) => `${event.time}:${event.type}` === selectedEventKey);
  const exportTrace = () => {
    const blob = new Blob([`${JSON.stringify(workspace.runtimeEvents, null, 2)}\n`], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cupcakeai-redacted-trace-${new Date().toISOString().replaceAll(':', '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const copyTrace = (value: string) => void navigator.clipboard.writeText(value);
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
          <button className="button" onClick={exportTrace}>
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
            <span className="connection-state" aria-label="Runtime event stream is live">
              <span className="pulse-dot" />
              Streaming
            </span>
            <div className="search-field">
              <Icon name="search" />
              <input
                placeholder="Filter events"
                value={eventQuery}
                onChange={(event) => setEventQuery(event.target.value)}
              />
            </div>
            <button
              className="icon-button"
              aria-label="Clear event filter"
              disabled={!eventQuery}
              onClick={() => setEventQuery('')}
            >
              <Icon name="trash" />
            </button>
          </div>
          <div className="event-table">
            <div className="event-table__head">
              <span>Time</span>
              <span>Event</span>
              <span>Detail</span>
            </div>
            {visibleEvents.map((e) => (
              <button
                className={cx(
                  'event-row',
                  selectedEventKey === `${e.time}:${e.type}` && 'is-active',
                )}
                onClick={() => setSelectedEventKey(`${e.time}:${e.type}`)}
                key={`${e.time}:${e.type}`}
              >
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
          {selectedEvent && (
            <div className="callout" role="status">
              <Icon name="terminal" />
              <p>
                <strong>{selectedEvent.type}</strong> · {selectedEvent.time}
                <br />
                {selectedEvent.detail}
              </p>
            </div>
          )}
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
            <button onClick={() => copyTrace('019d2c…b841')} aria-label="Copy trace ID">
              <span>trace_id</span>
              <code>019d2c…b841</code>
              <Icon name="copy" />
            </button>
            <button onClick={() => copyTrace('run_019d…92c')} aria-label="Copy run ID">
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
          <p className="eyebrow">From the original Cupcake</p>
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
            <strong>CupcakeAI 2.0</strong>
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
                    React renders; Tauri owns desktop lifecycle; Python owns product state and agent
                    workflows; the verified packaged Rust broker owns credentials, grants,
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
  manageModels,
}: {
  open: boolean;
  close: () => void;
  models: ModelDescriptor[];
  select: (id: string, options?: { compatibilityConfirmed?: boolean }) => Promise<void>;
  manageModels: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [pendingCompatibility, setPendingCompatibility] = useState<ModelDescriptor | null>(null);
  const [compatibilityAcknowledged, setCompatibilityAcknowledged] = useState(false);
  if (!open) return null;
  const shown = models.filter(
    (m) =>
      m.name.toLowerCase().includes(query.toLowerCase()) ||
      m.provider.toLowerCase().includes(query.toLowerCase()),
  );
  const selectFromPicker = async (model: ModelDescriptor, acknowledged = false) => {
    if (selectingId) return;
    if (requiresCompatibilityAcknowledgement(model) && !acknowledged) {
      setSelectionError(null);
      setCompatibilityAcknowledged(false);
      setPendingCompatibility(model);
      return;
    }
    setSelectionError(null);
    setSelectingId(model.id);
    try {
      const params = modelSelectionParams(model, acknowledged);
      await select(params.modelId, {
        compatibilityConfirmed: params.compatibilityConfirmed,
      });
      setPendingCompatibility(null);
      setCompatibilityAcknowledged(false);
      close();
    } catch (reason) {
      setSelectionError(
        reason instanceof Error ? reason.message : 'Cupcake could not select this model.',
      );
    } finally {
      setSelectingId(null);
    }
  };
  if (pendingCompatibility) {
    return (
      <ModelCompatibilityDialog
        model={pendingCompatibility}
        acknowledged={compatibilityAcknowledged}
        setAcknowledged={setCompatibilityAcknowledged}
        busy={selectingId !== null}
        error={selectionError}
        cancel={() => {
          if (selectingId) return;
          setPendingCompatibility(null);
          setCompatibilityAcknowledged(false);
        }}
        confirm={() => void selectFromPicker(pendingCompatibility, true)}
      />
    );
  }
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
                selectingId !== null ||
                m.status !== 'ready' ||
                (m.provider === 'NVIDIA NIM' && m.chatCompatibility === 'non_chat')
              }
              onClick={() => void selectFromPicker(m)}
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
              {selectingId === m.id ? (
                <small>Selecting…</small>
              ) : (
                m.selected && <Icon name="check" />
              )}
              {m.status !== 'ready' && (
                <small className="unavailable">{modelStatusLabel(m.status)}</small>
              )}
              {m.provider === 'NVIDIA NIM' && m.chatCompatibility !== 'chat' && (
                <small className="unavailable">Chat compatibility unverified</small>
              )}
            </button>
          ))}
        </div>
        {selectionError && (
          <p className="field-error" role="alert">
            {selectionError}
          </p>
        )}
        <footer>
          <button
            className="text-button"
            onClick={() => {
              close();
              manageModels();
            }}
          >
            Manage models <Icon name="chevron" />
          </button>
          <span>Ctrl M</span>
        </footer>
      </div>
    </div>
  );
}

type ProviderSetupStep =
  | 'choice'
  | 'credentials'
  | 'testing'
  | 'review'
  | 'saving'
  | 'success'
  | 'remove-confirm'
  | 'error';

interface ProviderDefinition {
  id: string;
  name: string;
  route: string;
  privacy: string;
  cost: string;
  keyUrl?: string;
  keyHint: string;
  supportsOrganization?: boolean;
  supportsEndpoint?: boolean;
  supportsModelId?: boolean;
}

const providerDefinitions: ProviderDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    route: 'OpenAI API',
    privacy: 'Prompts and selected files go to OpenAI under your API account and data controls.',
    cost: 'API usage is billed separately from ChatGPT. Trial credits are account-dependent.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Usually begins with sk-',
    supportsOrganization: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    route: 'Anthropic API',
    privacy: 'Prompts and selected files go to Anthropic under your API account.',
    cost: 'Usage-based API pricing applies; free access is not guaranteed.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Usually begins with sk-ant-',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    route: 'Google AI Gemini API',
    privacy: 'Prompts and selected files go to Google. Review the terms for your billing tier.',
    cost: 'A limited free tier may be available; quotas and model access can change.',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'Paste a Google AI Studio API key',
  },
  {
    id: 'xai',
    name: 'xAI',
    route: 'xAI API',
    privacy: 'Prompts and selected files go to xAI under your API account.',
    cost: 'Usage-based API billing and account limits apply.',
    keyUrl: 'https://console.x.ai/',
    keyHint: 'Paste an xAI API key',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    route: 'Mistral La Plateforme API',
    privacy: 'Prompts and selected files go to Mistral under your API account.',
    cost: 'Usage-based pricing applies; trial access varies by account.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHint: 'Paste a Mistral API key',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    route: 'Cohere API',
    privacy: 'Prompts and selected files go to Cohere under your API account.',
    cost: 'Trial and production keys have different limits; check the current dashboard terms.',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    keyHint: 'Paste a Cohere trial or production key',
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    route: 'NVIDIA API Catalog',
    privacy: 'Prompts and selected files go to NVIDIA-hosted model endpoints.',
    cost: 'Evaluation access and rate limits vary. It is not presented as unlimited.',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyHint: 'Usually begins with nvapi-',
  },
  {
    id: 'openai-compatible',
    name: 'Remote OpenAI-compatible',
    route: 'Your HTTPS endpoint',
    privacy:
      'Prompts and selected files go to the endpoint you enter. Cupcake cannot verify its operator.',
    cost: 'Your endpoint operator controls pricing, retention, capabilities, and availability.',
    keyHint: 'Paste the credential required by this remote endpoint',
    supportsEndpoint: true,
    supportsModelId: true,
  },
];

type ProviderSheetError = { title: string; detail: string; code?: string };

type ProviderHostResult = {
  provider?: string;
  state?: 'ready' | 'degraded' | 'failed' | 'cancelled';
  configured?: boolean;
  masked_identity?: string;
  tested_at_ms?: number;
  latency_ms?: number;
  models?: Array<Record<string, unknown> | string>;
  diagnostic?: { code?: string; message?: string; detail?: string } | string | null;
};

function diagnosticError(value: ProviderHostResult | undefined): ProviderSheetError | null {
  if (!value || value.state === 'ready' || value.state === 'degraded') return null;
  const diagnostic = value.diagnostic;
  const code = typeof diagnostic === 'object' && diagnostic ? diagnostic.code : undefined;
  const message =
    typeof diagnostic === 'string'
      ? diagnostic
      : (diagnostic?.message ??
        diagnostic?.detail ??
        `Provider returned ${value.state ?? 'an unknown state'}.`);
  const classified = classifyProviderError(new Error(`${code ? `${code}: ` : ''}${message}`));
  return { ...classified, code: code ?? classified.code };
}

function classifyProviderError(reason: unknown): ProviderSheetError {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Unknown provider error';
  const code = /^([A-Z][A-Z0-9_-]{2,}):\s*/.exec(message)?.[1];
  if (/401|403|auth|credential|key/i.test(message))
    return {
      title: 'The credential was rejected',
      detail: message,
      code: code ?? 'AUTHENTICATION_FAILED',
    };
  if (/429|rate|quota/i.test(message))
    return {
      title: 'The provider is rate-limiting this test',
      detail: message,
      code: code ?? 'RATE_LIMITED',
    };
  if (/offline|network|dns|timeout|fetch/i.test(message))
    return {
      title: 'Cupcake could not reach the provider',
      detail: message,
      code: code ?? 'PROVIDER_OFFLINE',
    };
  return { title: 'The connection test did not complete', detail: message, code };
}

function ProviderDialog({ provider, close }: { provider: string | null; close: () => void }) {
  const workspace = useWorkspace();
  const dialogRef = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const providerRegistry = useRef(workspace.providers);
  providerRegistry.current = workspace.providers;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [step, setStep] = useState<ProviderSetupStep>('choice');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [organization, setOrganization] = useState('');
  const [modelId, setModelId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState<ProviderSheetError | null>(null);
  const active = provider !== null;
  const selected = providerDefinitions.find((item) => item.id === selectedId) ?? null;
  const connected = selected ? Boolean(workspace.providers[selected.id]) : false;
  const closeStable = useCallback(() => {
    generation.current += 1;
    setApiKey('');
    close();
  }, [close]);
  useModalFocusTrap(active, dialogRef, closeStable);
  useEffect(() => {
    generation.current += 1;
    const initial = provider && provider !== 'choose' ? provider : null;
    setSelectedId(initial);
    setStep(initial ? (providerRegistry.current[initial] ? 'success' : 'credentials') : 'choice');
    setApiKey('');
    setShowKey(false);
    setEndpoint('');
    setOrganization('');
    setModelId('');
    setConnectionName('');
    setTestResult(null);
    setError(null);
  }, [provider]);
  if (!active) return null;

  const input = (): ProviderSetupInput => ({
    provider: selected!.id,
    apiKey,
    endpoint: endpoint.trim() || undefined,
    organization: organization.trim() || undefined,
    modelId: modelId.trim() || undefined,
    connectionName: connectionName.trim() || undefined,
  });
  const validate = (): string | null => {
    if (!apiKey.trim()) return 'Enter an API key before testing the connection.';
    if (selected?.supportsEndpoint && !/^https:\/\//i.test(endpoint.trim()))
      return 'Enter a complete HTTPS endpoint, such as https://api.example.com/v1.';
    if (selected?.supportsModelId && !modelId.trim()) return 'Enter the exact remote model ID.';
    return null;
  };
  const testConnection = async () => {
    const issue = validate();
    if (issue) {
      setError({ title: 'More information is needed', detail: issue });
      setStep('error');
      return;
    }
    const token = ++generation.current;
    setError(null);
    setStep('testing');
    try {
      const setup = input();
      let result: ProviderTestResult;
      if (window.cupcake?.provider) {
        const response = await window.cupcake.provider.test({
          provider: setup.provider,
          secret: setup.apiKey,
          baseUrl: setup.endpoint,
          organization: setup.organization,
          modelId: setup.modelId,
          displayName: setup.connectionName,
        });
        if (!response.ok)
          throw new Error(
            `${response.error?.code ? `${response.error.code}: ` : ''}${response.error?.message ?? 'Provider test failed'}`,
          );
        const hostResult = response.result as ProviderHostResult | undefined;
        const hostError = diagnosticError(hostResult);
        if (hostError) {
          setError(hostError);
          setStep('error');
          return;
        }
        const catalogItems = Array.isArray(hostResult?.models) ? hostResult.models : [];
        result = {
          maskedIdentity: hostResult?.masked_identity ?? `••••${setup.apiKey.slice(-4)}`,
          lastTested: new Date(hostResult?.tested_at_ms ?? Date.now()).toISOString(),
          models: catalogItems.map((item) => {
            const idValue =
              typeof item === 'string'
                ? item
                : ([item.id, item.model_id].find(
                    (value): value is string => typeof value === 'string',
                  ) ?? '');
            const nameValue =
              typeof item === 'string'
                ? item
                : ([item.display_name, item.name, item.id, item.model_id].find(
                    (value): value is string => typeof value === 'string',
                  ) ?? 'Provider model');
            return { id: idValue, name: nameValue };
          }),
          detail:
            hostResult?.state === 'degraded'
              ? `Connected with a degraded provider response${hostResult.latency_ms ? ` in ${hostResult.latency_ms} ms` : ''}. Review the provider diagnostic before relying on this route.`
              : hostResult?.latency_ms
                ? `Verified in ${hostResult.latency_ms} ms.`
                : undefined,
        };
      } else {
        await Promise.resolve();
        result = {
          maskedIdentity: `••••${setup.apiKey.slice(-4)}`,
          lastTested: new Date().toISOString(),
          models: [{ id: `${setup.provider}:verified-model`, name: 'Verified provider model' }],
          detail: 'Deterministic desktop-preview test. No network request left this browser.',
        };
      }
      if (token !== generation.current) return;
      setTestResult(result);
      setStep('review');
    } catch (reason) {
      if (token !== generation.current) return;
      setError(classifyProviderError(reason));
      setStep('error');
    }
  };
  const cancelTest = () => {
    generation.current += 1;
    setStep('credentials');
  };
  const saveConnection = async () => {
    setStep('saving');
    try {
      const setup = input();
      const result = testResult!;
      if (window.cupcake?.provider) {
        const response = await window.cupcake.provider.connect({
          provider: setup.provider,
          secret: setup.apiKey,
          baseUrl: setup.endpoint,
          organization: setup.organization,
          modelId: setup.modelId,
          displayName: setup.connectionName,
        });
        if (!response.ok)
          throw new Error(
            `${response.error?.code ? `${response.error.code}: ` : ''}${response.error?.message ?? 'Provider connection failed'}`,
          );
        const hostResult = response.result as ProviderHostResult | undefined;
        const hostError = diagnosticError(hostResult);
        if (hostError)
          throw new Error(`${hostError.code ? `${hostError.code}: ` : ''}${hostError.detail}`);
        if (hostResult?.configured !== true) {
          throw new Error(
            'CONFIGURATION_NOT_PERSISTED: The provider test passed, but the desktop vault did not confirm a saved credential.',
          );
        }
      }
      setApiKey('');
      setTestResult(result);
      void workspace.refresh();
      setStep('success');
    } catch (reason) {
      setApiKey('');
      setError(classifyProviderError(reason));
      setStep('error');
    }
  };
  const removeConnection = async () => {
    if (!selected) return;
    if (window.cupcake?.provider) {
      const response = await window.cupcake.provider.disconnect(selected.id);
      if (!response.ok) {
        setError(classifyProviderError(response.error?.message));
        setStep('error');
        return;
      }
    }
    void workspace.refresh();
    setTestResult(null);
    setStep('credentials');
  };
  const choose = (id: string) => {
    setSelectedId(id);
    setStep(workspace.providers[id] ? 'success' : 'credentials');
  };

  return (
    <div className="popover-layer provider-setup-layer">
      <section
        ref={dialogRef}
        className="provider-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-setup-title"
      >
        <header className="provider-setup__header">
          <div>
            <span className="eyebrow">Private setup inside Cupcake</span>
            <h2 id="provider-setup-title">
              {selected
                ? `${connected ? 'Manage' : 'Connect'} ${selected.name}`
                : 'Choose a provider'}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={closeStable}
            aria-label="Close provider setup"
          >
            <Icon name="x" />
          </button>
        </header>

        <div className="provider-setup__progress" aria-label="Setup progress">
          {['Choose', 'Credentials', 'Test', 'Review', 'Connected'].map((label, index) => {
            const order =
              step === 'choice'
                ? 0
                : step === 'credentials' || step === 'error'
                  ? 1
                  : step === 'testing'
                    ? 2
                    : step === 'review' || step === 'saving'
                      ? 3
                      : 4;
            return (
              <span className={index <= order ? 'is-active' : ''} key={label}>
                {label}
              </span>
            );
          })}
        </div>

        <div className="provider-setup__body">
          {step === 'choice' && (
            <div className="provider-choice-grid">
              {providerDefinitions.map((item) => (
                <button type="button" key={item.id} onClick={() => choose(item.id)}>
                  <span className="provider-logo">{item.name.charAt(0)}</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.route}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))}
            </div>
          )}

          {selected && ['credentials', 'testing', 'error'].includes(step) && (
            <form
              className="provider-credentials"
              onSubmit={(event) => {
                event.preventDefault();
                void testConnection();
              }}
            >
              <div className="provider-disclosure">
                <div>
                  <Icon name="cloud" />
                  <span>
                    <strong>Where data goes</strong>
                    <small>{selected.privacy}</small>
                  </span>
                </div>
                <div>
                  <Icon name="database" />
                  <span>
                    <strong>Cost & limits</strong>
                    <small>{selected.cost}</small>
                  </span>
                </div>
              </div>
              {selected.keyUrl && (
                <a
                  className="provider-key-link"
                  href={selected.keyUrl}
                  onClick={(event) => {
                    event.preventDefault();
                    if (selected.keyUrl) void window.cupcake?.app.openExternal(selected.keyUrl);
                  }}
                >
                  Get a {selected.name} API key <span aria-hidden="true">↗</span>
                </a>
              )}
              {selected.supportsEndpoint && (
                <label>
                  HTTPS endpoint
                  <input
                    autoFocus
                    name="endpoint"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
              )}
              {selected.id === 'openai-compatible' && (
                <label>
                  Connection name
                  <input
                    name="connection-name"
                    autoComplete="off"
                    value={connectionName}
                    onChange={(e) => setConnectionName(e.target.value)}
                    placeholder="Research gateway"
                  />
                </label>
              )}
              {selected.supportsModelId && (
                <label>
                  Model ID
                  <input
                    name="model-id"
                    autoComplete="off"
                    spellCheck={false}
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder="provider/model-name"
                  />
                </label>
              )}
              <div className="provider-field">
                <label htmlFor="provider-api-key">API key</label>
                <span className="secret-input">
                  <input
                    id="provider-api-key"
                    autoFocus={!selected.supportsEndpoint}
                    name="api-key"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selected.keyHint}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? 'Hide API key' : 'Reveal API key'}
                  >
                    <Icon name="eye" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setApiKey('')}
                    aria-label="Clear API key"
                    disabled={!apiKey}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              </div>
              {selected.supportsOrganization && (
                <label>
                  Organization ID <span>Optional</span>
                  <input
                    name="organization"
                    autoComplete="off"
                    spellCheck={false}
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                    placeholder="org-…"
                  />
                </label>
              )}
              <p className="provider-vault-note">
                <Icon name="shield" /> The key is sent once to the trusted desktop boundary,
                protected with Windows DPAPI, and never returned to this screen.
              </p>
              {step === 'testing' && (
                <div className="provider-testing" role="status" aria-live="polite">
                  <span className="provider-spinner" />
                  <span>
                    <strong>Testing the connection…</strong>
                    <small>Checking authentication, network access, and supported models.</small>
                  </span>
                </div>
              )}
              {step === 'error' && error && (
                <div className="provider-error" role="alert">
                  <Icon name="info" />
                  <span>
                    <strong>{error.title}</strong>
                    {error.code && <code>{error.code}</code>}
                    <small>{error.detail}</small>
                  </span>
                </div>
              )}
              <footer>
                <button type="button" className="text-button" onClick={() => setStep('choice')}>
                  Choose another provider
                </button>
                <span />
                {step === 'testing' ? (
                  <button type="button" className="button" onClick={cancelTest}>
                    Cancel test
                  </button>
                ) : (
                  <button type="submit" className="button button--primary">
                    Test connection
                  </button>
                )}
              </footer>
            </form>
          )}

          {selected && step === 'review' && testResult && (
            <div className="provider-review">
              <div className="provider-success-mark">
                <Icon name="check" />
              </div>
              <h3>Connection verified</h3>
              <p>
                {testResult.detail ??
                  `Cupcake authenticated with ${selected.name} and discovered ${testResult.models.length || 'the available'} model catalog.`}
              </p>
              <dl>
                <div>
                  <dt>Privacy route</dt>
                  <dd>{selected.route}</dd>
                </div>
                <div>
                  <dt>Saved identity</dt>
                  <dd>{testResult.maskedIdentity}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {testResult.models.length
                      ? `${testResult.models.length} models discovered`
                      : 'Provider catalog verified'}
                  </dd>
                </div>
              </dl>
              {testResult.models.length > 0 && (
                <div className="provider-model-preview">
                  {testResult.models.slice(0, 6).map((model) => (
                    <span key={model.id}>{model.name}</span>
                  ))}
                </div>
              )}
              <div className="provider-review-note">
                <Icon name="info" />
                <span>
                  Prompts or files are sent only when you explicitly select a {selected.name} model.
                  Automatic provider routing stays off.
                </span>
              </div>
              <footer>
                <button type="button" className="button" onClick={() => setStep('credentials')}>
                  Back
                </button>
                <span />
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void saveConnection()}
                >
                  Save & connect
                </button>
              </footer>
            </div>
          )}

          {selected && step === 'saving' && (
            <div className="provider-state-panel" role="status">
              <span className="provider-spinner" />
              <h3>Protecting this credential…</h3>
              <p>Cupcake is saving only the encrypted desktop credential and provider metadata.</p>
            </div>
          )}

          {selected && step === 'success' && (
            <div className="provider-connected">
              <div className="provider-success-mark">
                <Icon name="check" />
              </div>
              <h3>{selected.name} is connected</h3>
              <p>
                Cloud use remains explicit. Cupcake never switches to this provider automatically.
              </p>
              <dl>
                <div>
                  <dt>Credential</dt>
                  <dd>{testResult?.maskedIdentity ?? '•••• saved credential'}</dd>
                </div>
                <div>
                  <dt>Last tested</dt>
                  <dd>
                    {testResult?.lastTested
                      ? new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(testResult.lastTested))
                      : 'Test again to refresh'}
                  </dd>
                </div>
                <div>
                  <dt>Privacy route</dt>
                  <dd>{selected.route}</dd>
                </div>
              </dl>
              <div className="provider-connected__actions">
                <button type="button" className="button" onClick={() => setStep('credentials')}>
                  Reconnect
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => setStep('remove-confirm')}
                >
                  Remove credential
                </button>
              </div>
            </div>
          )}

          {selected && step === 'remove-confirm' && (
            <div className="provider-remove-confirm">
              <Icon name="shield" />
              <h3>Remove {selected.name}?</h3>
              <p>
                Cupcake will delete the DPAPI-protected credential and disable its models.
                Conversations remain intact.
              </p>
              <footer>
                <button type="button" className="button" onClick={() => setStep('success')}>
                  Keep connection
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void removeConnection()}
                >
                  Remove credential
                </button>
              </footer>
            </div>
          )}
        </div>
      </section>
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
      key: 'Ctrl F',
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
  const selectModel = async (
    id: string,
    options?: { compatibilityConfirmed?: boolean },
  ): Promise<void> => {
    const model = models.find((m) => m.id === id);
    if (model) {
      const response = await window.cupcake?.runtime.request({
        method: 'models.select',
        params: {
          modelId: canonicalModelId(model),
          compatibilityConfirmed: options?.compatibilityConfirmed === true,
        },
      });
      if (response && !response.ok)
        throw new Error(response.error?.message ?? 'Cupcake could not select this model.');
    }
    setModels((list) => list.map((m) => ({ ...m, selected: m.id === id })));
    setToast(`Model changed to ${model?.name}`);
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
      } else if (meta && event.key.toLowerCase() === 'f') {
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
        return true;
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
        params: { content, modelId: canonicalModelId(selectedModel) },
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
        onSend={(input) => {
          sendChat(input.content);
          return true;
        }}
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
  else if (view === 'models')
    content = (
      <ModelsView models={models} selectModel={selectModel} openProvider={setProviderDialog} />
    );
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
      <CupcakeTitlebar />
      <Shelf
        view={view}
        setView={navigate}
        developerMode={developerMode}
        mobileOpen={mobileOpen}
        closeMobile={() => setMobileOpen(false)}
        conversations={conversationRecords}
        activeTaskCount={
          taskList.filter((task) => task.status === 'working' || task.status === 'waiting').length
        }
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
        manageModels={() => navigate('models')}
      />
      <ProviderDialog provider={providerDialog} close={() => setProviderDialog(null)} />
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
        aria-label="Original Cupcake 1.0 data migration"
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

const onboardingSteps = [
  {
    eyebrow: 'Welcome to CupcakeAI',
    title: 'One calm place for serious work',
    body: 'Chat with cloud or local models, let durable tasks continue in the background, and keep the resulting files, decisions, and memories organized.',
    icon: 'sparkle' as IconName,
    points: [
      'Encrypted local workspace',
      'Cloud destinations are labeled',
      'Your projects stay isolated',
    ],
    view: 'home' as View,
    target: null,
  },
  {
    eyebrow: 'Conversations',
    title: 'Ask, attach, branch, and keep context',
    body: 'Use @ references to include a project, memory, task, or artifact. Long answers stream into the Frosting Thread, and you can branch from any message without losing the original.',
    icon: 'chat' as IconName,
    points: [
      'Ctrl N starts a chat',
      'Ctrl F searches everything',
      'Ctrl M changes the active model',
    ],
    view: 'chat' as View,
    target: 'chats',
  },
  {
    eyebrow: 'Projects and tasks',
    title: 'Separate quick questions from durable work',
    body: 'Projects are privacy and retrieval boundaries. Tasks checkpoint multi-step work so a model or app restart does not erase useful progress.',
    icon: 'task' as IconName,
    points: [
      'Projects contain chats and artifacts',
      'Tasks show approvals and checkpoints',
      'Artifacts keep revision history',
    ],
    view: 'projects' as View,
    target: 'projects',
  },
  {
    eyebrow: 'Models and providers',
    title: 'Choose local privacy or connected capability',
    body: 'CupcakeAI can use app-managed local models or providers you connect. Local model cards explain fit, runtime, download state, and whether weights can spill from VRAM into RAM.',
    icon: 'model' as IconName,
    points: [
      'Local means content stays on this PC',
      'Cloud routes name the provider',
      'Offline mode blocks cloud routes',
    ],
    view: 'models' as View,
    target: 'models',
  },
  {
    eyebrow: 'Permission policy',
    title: 'You decide how much autonomy to grant',
    body: 'Guarded mode asks before sensitive effects. Full Freedom removes routine confirmations, while destructive and irreversible boundaries remain clearly surfaced.',
    icon: 'shield' as IconName,
    points: [
      'Review tool effects in context',
      'Stop active generation with Ctrl .',
      'Lock the workspace from Privacy settings',
    ],
    view: 'settings' as View,
    target: 'settings',
  },
  {
    eyebrow: 'Ready when you are',
    title: 'Make CupcakeAI feel like yours',
    body: 'Set your profile, communication style, theme, window behavior, model memory policy, and scrollbars in Settings. You can replay this tour there at any time.',
    icon: 'check' as IconName,
    points: [
      'Profile and cupcake avatars',
      'Personality and custom instructions',
      'Startup, taskbar, close, GPU and RAM controls',
    ],
    view: 'settings' as View,
    target: 'profile',
  },
] as const;

function OnboardingTour({
  open,
  close,
  navigate,
}: {
  open: boolean;
  close: (completed: boolean) => void;
  navigate: (view: View) => void;
}) {
  const workspace = useWorkspace();
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);
  const item = onboardingSteps[step]!;
  const last = step === onboardingSteps.length - 1;
  useEffect(() => {
    if (!open) return;
    navigate(item.view);
    setTargetRect(null);
    let target: HTMLElement | null = null;
    const advance = () => setStep((value) => Math.min(onboardingSteps.length - 1, value + 1));
    const timer = window.setTimeout(() => {
      target = item.target
        ? document.querySelector<HTMLElement>(`[data-tour="${item.target}"]`)
        : null;
      if (!target) return;
      setTargetRect(target.getBoundingClientRect());
      target.addEventListener('click', advance, { once: true });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      target?.removeEventListener('click', advance);
    };
  }, [item.target, item.view, navigate, open]);
  const configuredProviderCount = Object.values(workspace.providers).filter(Boolean).length;
  const setupChecks = [
    { label: 'Encrypted profile', done: true },
    {
      label: 'At least one model route',
      done: workspace.models.some((model) => model.status !== 'setup'),
    },
    { label: 'Provider connected', done: configuredProviderCount > 0 },
    { label: 'Hardware profile scanned', done: Boolean(workspace.hardware?.ramBytes) },
    {
      label: 'Local acceleration ready',
      done: workspace.localRuntimes.some((runtime) => runtime.active),
    },
  ];
  if (!open) return null;
  return (
    <div className={cx('onboarding-layer', targetRect && 'has-target')} role="presentation">
      {targetRect && (
        <span
          className="onboarding-spotlight"
          style={{
            left: targetRect.left - 7,
            top: targetRect.top - 7,
            width: targetRect.width + 14,
            height: targetRect.height + 14,
          }}
          aria-hidden="true"
        />
      )}
      <section className="onboarding-card" role="dialog" aria-labelledby="onboarding-title">
        <aside className="onboarding-art" aria-hidden="true">
          <OnboardingStoryArt step={step} />
          <span className="onboarding-step-icon">
            <Icon name={item.icon} size={22} />
          </span>
        </aside>
        <div className="onboarding-copy">
          <header>
            <span className="eyebrow">{item.eyebrow}</span>
            <button
              className="icon-button"
              onClick={() => close(true)}
              aria-label="Skip onboarding"
            >
              <Icon name="x" />
            </button>
          </header>
          <h1 id="onboarding-title">{item.title}</h1>
          <p>{item.body}</p>
          <div className="onboarding-points">
            {item.points.map((point) => (
              <span key={point}>
                <Icon name="check" size={13} /> {point}
              </span>
            ))}
          </div>
          {step === 3 && (
            <div className="onboarding-setup-checks" aria-label="Configuration status">
              {setupChecks.map((check) => (
                <span className={check.done ? 'is-done' : ''} key={check.label}>
                  <Icon name={check.done ? 'check' : 'more'} size={13} />
                  {check.label}
                  <small>{check.done ? 'Ready' : 'Optional'}</small>
                </span>
              ))}
              <button className="text-button" onClick={() => navigate('settings')}>
                Configure what remains <Icon name="chevron" size={13} />
              </button>
            </div>
          )}
          {last && (
            <div className="onboarding-destinations">
              <button
                onClick={() => {
                  navigate('chat');
                  close(true);
                }}
              >
                <Icon name="chat" />
                <span>
                  <strong>Start chatting</strong>
                  <small>Ask CupcakeAI anything</small>
                </span>
              </button>
              <button
                onClick={() => {
                  navigate('settings');
                  close(true);
                }}
              >
                <Icon name="settings" />
                <span>
                  <strong>Personalize first</strong>
                  <small>Profile, models, and window</small>
                </span>
              </button>
            </div>
          )}
          <footer>
            <div
              className="onboarding-progress"
              aria-label={`Step ${step + 1} of ${onboardingSteps.length}`}
            >
              {onboardingSteps.map((_, index) => (
                <i
                  className={index === step ? 'is-active' : index < step ? 'is-done' : ''}
                  key={index}
                />
              ))}
            </div>
            <span />
            {step > 0 && (
              <button className="button" onClick={() => setStep((value) => value - 1)}>
                Back
              </button>
            )}
            <button
              className="button button--primary"
              onClick={() => (last ? close(true) : setStep((value) => value + 1))}
            >
              {last ? 'Finish tour' : 'Continue'}
            </button>
          </footer>
        </div>
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
  const [onboardingOpen, setOnboardingOpen] = useState(
    new URLSearchParams(window.location.search).get('onboarding') === '1',
  );
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
    const nativeDesktop = '__TAURI_INTERNALS__' in window;
    if (nativeDesktop && workspace.ready && !workspace.settings.onboardingCompleted)
      setOnboardingOpen(true);
  }, [workspace.ready, workspace.settings.onboardingCompleted]);
  useEffect(() => {
    const configured = workspace.settings.theme;
    const urlTheme = new URLSearchParams(window.location.search).get('theme');
    if (configured && !urlTheme) setThemeState(configured);
  }, [workspace.settings.theme]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.scrollbars = workspace.settings.scrollbarMode;
    document.documentElement.dataset.reducedMotion = workspace.settings.reducedMotion
      ? 'true'
      : 'false';
    localStorage.setItem('cupcake-theme', theme);
  }, [theme, workspace.settings.reducedMotion, workspace.settings.scrollbarMode]);
  const setTheme = (next: Theme) => {
    setThemeState(next);
    void workspace.updateSettings({ theme: next });
  };
  const navigate = useCallback((next: View) => {
    setView(next);
    window.scrollTo(0, 0);
  }, []);
  const startNewChat = () => {
    void workspace.createConversation().then(() => navigate('chat'));
  };
  const sendChat = (input: ComposerSendInput) => workspace.sendMessage(input);
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
      } else if (meta && event.key.toLowerCase() === 'f') {
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
      onSend={async (input) => {
        const sent = await sendChat(input);
        if (sent) navigate('chat');
        return sent;
      }}
      onModel={() => setModelOpen(true)}
      selectedModel={selectedModel}
      offline={workspace.settings.offline}
    />
  );
  let content: ReactNode;
  if (!workspace.ready && !workspace.fixtureMode) content = <WorkspaceOpening />;
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
        openProvider={setProviderDialog}
        selectModel={async (id, options) => {
          await workspace.selectModel(id, options);
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
        onReplayOnboarding={() => setOnboardingOpen(true)}
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
      <CupcakeTitlebar />
      <Shelf
        view={view}
        setView={navigate}
        developerMode={workspace.settings.developerMode}
        mobileOpen={mobileOpen}
        closeMobile={() => setMobileOpen(false)}
        conversations={workspace.conversations}
        activeTaskCount={
          workspace.tasks.filter((task) => task.status === 'working' || task.status === 'waiting')
            .length
        }
        onNewChat={startNewChat}
        onSelectConversation={(id) =>
          void workspace.selectConversation(id).then(() => navigate('chat'))
        }
        profile={workspace.settings.profile}
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
        select={(id, options) => workspace.selectModel(id, options)}
        manageModels={() => navigate('models')}
      />
      <ProviderDialog provider={providerDialog} close={() => setProviderDialog(null)} />
      <LegacyMigrationDialog />
      <OnboardingTour
        open={onboardingOpen && workspace.ready}
        navigate={navigate}
        close={(completed) => {
          setOnboardingOpen(false);
          if (completed && !workspace.settings.onboardingCompleted)
            void workspace.updateSettings({ onboardingCompleted: true });
        }}
      />
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

function hostErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'CupcakeAI could not complete that password request.';
}

function WorkspaceUnlockGate({
  status,
  onUnlocked,
}: {
  status: WorkspaceLockStatus | null;
  onUnlocked: (status: WorkspaceLockStatus) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dreamscape] = useState(() => Math.floor(Math.random() * 4));
  const needsSetup = status?.state === 'needs_setup';
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!window.cupcake || !status || busy) return;
    setError('');
    if (needsSetup && password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    const request = needsSetup
      ? window.cupcake.workspace.setup(password)
      : window.cupcake.workspace.unlock(password);
    void request
      .then((next) => {
        setPassword('');
        setConfirmation('');
        onUnlocked(next);
      })
      .catch((reason: unknown) => setError(hostErrorMessage(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="app-shell app-shell--locked">
      <CupcakeTitlebar />
      <main className="workspace-unlock">
        <Dreamscape scene={dreamscape} />
        <section className="workspace-unlock__card">
          <div className="workspace-unlock__mark">
            <Icon name="shield" size={30} />
          </div>
          <span className="eyebrow">App-locked local workspace</span>
          <h1>{needsSetup ? 'Create your CupcakeAI password' : 'Unlock CupcakeAI'}</h1>
          <p>
            {status === null
              ? 'Checking this local profile…'
              : needsSetup
                ? 'Choose a password for this CupcakeAI profile. You will enter it whenever the app starts.'
                : 'Enter the password for this CupcakeAI profile. Models, tools, and providers stay stopped until it is accepted.'}
          </p>
          {status !== null && (
            <form className="workspace-unlock__form" onSubmit={submit}>
              <input
                className="sr-only"
                type="text"
                name="username"
                autoComplete="username"
                value="CupcakeAI local workspace"
                readOnly
                tabIndex={-1}
                aria-hidden="true"
              />
              <label>
                {needsSetup ? 'New password' : 'Password'}
                <span className="password-input">
                  <input
                    type={revealed ? 'text' : 'password'}
                    autoComplete={needsSetup ? 'new-password' : 'current-password'}
                    minLength={15}
                    maxLength={128}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoFocus
                    required
                  />
                  <button type="button" onClick={() => setRevealed((value) => !value)}>
                    {revealed ? 'Hide' : 'Show'}
                  </button>
                </span>
              </label>
              {needsSetup && (
                <label>
                  Confirm password
                  <input
                    type={revealed ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={128}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    required
                  />
                </label>
              )}
              <small>15–128 characters. Spaces and Unicode are welcome.</small>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="button button--primary workspace-unlock__action"
                disabled={busy || (status.retryAfterMs ?? 0) > 0}
              >
                <Icon name="shield" />
                {busy
                  ? 'Protecting…'
                  : needsSetup
                    ? 'Create password and open'
                    : 'Unlock workspace'}
              </button>
              {busy && (
                <div className="workspace-unlock__progress" role="status">
                  <span>
                    <i />
                  </span>
                  <small>
                    Opening encrypted history first. Models and optional services will wake only
                    when needed.
                  </small>
                </div>
              )}
            </form>
          )}
          <div className="workspace-unlock__actions">
            <button
              className="text-button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              How is this protected? <Icon name="chevron" size={13} />
            </button>
          </div>
          {detailsOpen && (
            <div className="workspace-unlock__details">
              <strong>The app password and Windows protection do different jobs.</strong>
              <p>
                This password blocks CupcakeAI and its sidecars. Windows Data Protection (DPAPI)
                separately protects the profile key, which derives encryption keys for SQLCipher
                data and immutable artifacts.
              </p>
            </div>
          )}
        </section>
        <aside className="workspace-unlock__aside">
          <span>LOCAL ONLY</span>
          <h2>One key boundary, three protected stores.</h2>
          <ul>
            <li>
              <Icon name="check" /> Conversations, tasks, memory, and settings
            </li>
            <li>
              <Icon name="check" /> Immutable artifact revisions
            </li>
            <li>
              <Icon name="check" /> Provider credentials in the Windows vault
            </li>
          </ul>
        </aside>
      </main>
    </div>
  );
}

export function App() {
  const workspaceLockApi = window.cupcake?.workspace;
  const [lockStatus, setLockStatus] = useState<WorkspaceLockStatus | null>(
    workspaceLockApi ? null : { state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 },
  );
  useEffect(() => {
    if (!workspaceLockApi) return;
    let active = true;
    void workspaceLockApi.status().then((status) => active && setLockStatus(status));
    const release = workspaceLockApi.onStatus((status) => {
      if (active) setLockStatus(status);
    });
    return () => {
      active = false;
      release();
    };
  }, [workspaceLockApi]);
  if (lockStatus?.state !== 'unlocked') {
    return <WorkspaceUnlockGate status={lockStatus} onUnlocked={setLockStatus} />;
  }
  return (
    <WorkspaceProvider>
      <LiveApp />
    </WorkspaceProvider>
  );
}
