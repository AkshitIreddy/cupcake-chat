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
  conversations as initialConversations,
  memories as initialMemories,
  models as initialModels,
  tasks as initialTasks,
  tools as initialTools,
} from './data';
import { Icon, type IconName } from './icons';
import { ConversationScrollController } from './conversation-scroll';
import { FormDialog } from './FormDialog';
import { RichMarkdown } from './RichMarkdown';
import { ContentProtectionSettings } from './ContentProtectionSettings';
import { BackupRecoverySettings } from './BackupRecoverySettings';
import {
  MODEL_SIZE_OPTIONS,
  MODEL_TASK_OPTIONS,
  completeModelDescriptor,
  curatedProfileForModel,
  modelAvailabilityDetail,
  modelIsAvailableInChat,
  modelIsCurated,
  modelPriority,
  modelRouteDescription,
  modelSize,
  modelTasks,
  modelWasOperationallyTested,
  publisherForModel,
  publisherLogoAsset,
  publisherMonogram,
  recommendModels,
  recommendationReason,
  selectedModelForChat,
  type ModelSize,
  type ModelTask,
} from './model-intelligence';
import {
  canonicalModelId,
  modelSelectionParams,
  resolvePersistedMessageModel,
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
  automaticRamBudgetGb,
  scopedReferenceOptions,
  useWorkspace,
  type ArtifactTestRun,
  type ArtifactRecord,
  type ArtifactRevisionRecord,
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
  Groq: 'groq',
  OpenRouter: 'openrouter',
  'Cloudflare Workers AI': 'cloudflare',
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
function cap(value: string | null | undefined, fallback = 'Unknown') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : fallback;
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

const WORKSPACE_WALLPAPERS = [
  ['none', 'Quiet paper', 'No artwork'],
  ['moonlit-archive', 'Moonlit archive', 'Midnight blue'],
  ['pistachio-atelier', 'Pistachio atelier', 'Garden light'],
  ['blueberry-observatory', 'Blueberry observatory', 'Violet dusk'],
  ['copper-workshop', 'Copper workshop', 'Warm brass'],
  ['aquamarine-tidepool-library', 'Tidepool library', 'Aquamarine'],
  ['ink-snow-garden', 'Ink snow garden', 'Monochrome'],
  ['raspberry-circuit-conservatory', 'Circuit conservatory', 'Raspberry night'],
  ['saffron-paper-city', 'Saffron paper city', 'Golden paper'],
] as const satisfies ReadonlyArray<readonly [WorkspaceSettings['wallpaper'], string, string]>;

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
  return (
    <img
      className={cx('cupcake-portrait', className)}
      src={value || '/brand/cupcake-mark.svg'}
      alt={label}
    />
  );
}

function OnboardingStoryArt({ step }: { step: number }) {
  return (
    <span
      className="onboarding-story-art"
      style={atlasStyle(step % 6, 3, 2, '/art/onboarding-story-atlas-v1.webp')}
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

function CupcakeTitlebar({ onSearch }: { onSearch: () => void }) {
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
      <div className="cupcake-titlebar__identity" data-tauri-drag-region aria-hidden="true">
        <img src="/brand/cupcake-mark.svg" alt="" />
        <span>CUPCAKEAI</span>
      </div>
      <div className="cupcake-titlebar__center">
        <span
          className="cupcake-titlebar__drag"
          data-tauri-drag-region
          onDoubleClick={() => void toggleMaximize()}
          aria-hidden="true"
        />
        <button
          className="cupcake-titlebar__search"
          aria-label="Search CupcakeAI"
          type="button"
          onClick={onSearch}
          title="Search your workspace (Ctrl+F)"
        >
          <Icon name="search" size={13} />
          <span>Find a chat, a file, an idea…</span>
        </button>
        <span
          className="cupcake-titlebar__drag"
          data-tauri-drag-region
          onDoubleClick={() => void toggleMaximize()}
          aria-hidden="true"
        />
      </div>
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
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx('toggle', checked && 'is-on')}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
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
  const [scene] = useState(() => {
    const requested = Number(new URLSearchParams(window.location.search).get('openingScene'));
    return Number.isInteger(requested) && requested >= 0 && requested <= 3
      ? requested
      : Math.floor(Math.random() * 4);
  });
  useEffect(() => {
    document.documentElement.dataset.openingScene = String(scene);
    return () => {
      delete document.documentElement.dataset.openingScene;
    };
  }, [scene]);
  return (
    <main className="workspace-opening" aria-live="polite">
      <Dreamscape scene={scene} />
      <section className="workspace-opening__card">
        <span className="eyebrow">Opening workspace</span>
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
            <Icon name="check" /> Profile ready
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
            {chat.unread && (
              <span className="recent-unread" aria-label="Unread conversation">
                <Icon name="sparkle" size={10} />
              </span>
            )}
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
            <strong>{profile?.displayName || 'Your workspace'}</strong>
            <small>{profile?.role || 'Local profile'}</small>
          </span>
          <Icon name="settings" size={15} />
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
  openChat: (conversationId?: string) => void;
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
        <div className="home-identity">
          <div className="home-hero__mascot">
            <CupcakePortrait
              value={workspace.settings.assistantAvatar}
              label="Selected CupcakeAI assistant"
            />
            <span className="home-hero__halo" aria-hidden="true" />
          </div>
          <p className="eyebrow">Your workbench is ready</p>
          <h1>
            <Greeting />
          </h1>
          <p>Bring an idea. We’ll give it somewhere to grow.</p>
        </div>
        <div className="home-composer">{composer}</div>
        <div className="home-starts" aria-label="Ideas to start a conversation">
          {[
            [
              'search',
              'Make sense of a document',
              'Help me understand a document. First ask me to attach it, then pull out the key claims, evidence, and open questions.',
            ],
            [
              'code',
              'Build something useful',
              'Help me build a small, useful tool. Ask what problem I want to solve, then suggest a plan and a testable first version.',
            ],
            [
              'project',
              'Plan the next step',
              'Help me turn an idea into a practical project. Ask about my goal, deadline, and constraints, then propose clear next steps.',
            ],
          ].map(([icon, label, prompt]) => (
            <button
              type="button"
              key={label}
              onClick={() =>
                window.dispatchEvent(new CustomEvent('cupcake:draft', { detail: prompt }))
              }
            >
              <Icon name={icon as IconName} size={17} />
              <span>{label}</span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </div>
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
            {conversations.slice(0, 5).map((c, i) => (
              <button onClick={() => openChat(c.id)} key={c.id} className="continue-card">
                <span className={cx('continue-card__index', i === 0 && 'is-berry')}>
                  <Icon name="chat" size={16} />
                </span>
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
                <span>{workingTask.progress}%</span>
                <svg viewBox="0 0 42 42">
                  <circle cx="21" cy="21" r="17" />
                  <circle
                    className="progress-ring"
                    cx="21"
                    cy="21"
                    r="17"
                    pathLength="100"
                    style={{
                      strokeDasharray: '100',
                      strokeDashoffset: 100 - Math.max(0, Math.min(100, workingTask.progress)),
                    }}
                  />
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
                <p>
                  Turn a conversation into a task when it needs several steps. Its progress stays
                  here.
                </p>
              </div>
              <button className="text-button" onClick={() => openChat()}>
                Start something <Icon name="chevron" size={14} />
              </button>
            </div>
          )}
          {proactiveEnabled && workspace.memories.some((memory) => !memory.enabled) && (
            <div className="notice-card">
              <Icon name="sparkle" />
              <div>
                <strong>Memories ready for review</strong>
                <p>Review saved candidates and choose what CupcakeAI should keep using.</p>
              </div>
              <button aria-label="Review memories" onClick={() => setView('memory')}>
                <Icon name="chevron" size={14} />
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
                    chats · {workspace.artifactCounts[project.id] ?? 0}{' '}
                    {(workspace.artifactCounts[project.id] ?? 0) === 1 ? 'artifact' : 'artifacts'}
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
  selectedModel: ModelDescriptor | null;
  offline: boolean;
}) {
  const workspace = useWorkspace();
  const modelReady = selectedModel ? modelIsAvailableInChat(selectedModel) : false;
  const supportedReasoning = selectedModel?.reasoningPresets?.length
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
  useEffect(() => {
    const draft = (event: Event) => {
      const prompt = (event as CustomEvent<unknown>).detail;
      if (typeof prompt !== 'string') return;
      setValue((current) => (current.trim() ? `${current}\n\n${prompt}` : prompt));
      textRef.current?.focus();
    };
    window.addEventListener('cupcake:draft', draft);
    return () => window.removeEventListener('cupcake:draft', draft);
  }, []);
  const routeAtSend: AttachmentRecord['destination'] =
    selectedModel?.route === 'Cloud' && !offline ? 'cloud' : 'local';
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
    if (!selectedModel) {
      setDisclosureError('Choose a ready model before sending. Your draft is still here.');
      return;
    }
    if (!modelReady) {
      setDisclosureError(`${modelAvailabilityDetail(selectedModel)}. Your draft is still here.`);
      return;
    }
    if (offline && selectedModel.route === 'Cloud') {
      setDisclosureError('Offline mode blocks cloud sends. Choose a local model to continue.');
      return;
    }
    setSending(true);
    const activeConversation = workspace.conversations.find(
      (conversation) => conversation.id === workspace.activeConversationId,
    );
    const conversationProjectId = activeConversation
      ? (activeConversation.projectId ?? null)
      : workspace.activeProjectId;
    const context =
      workspace.activeConversationId && workspace.activeBranchId
        ? {
            conversationId: workspace.activeConversationId,
            branchId: workspace.activeBranchId,
            projectId: conversationProjectId,
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
            {selectedModel ? (
              <PublisherLogo
                publisher={publisherForModel(selectedModel)}
                className="composer-model-logo"
              />
            ) : (
              <Icon name="model" size={15} />
            )}
            <span>
              {!selectedModel
                ? 'Choose a model'
                : !modelReady
                  ? `${selectedModel.name} unavailable`
                  : offline && selectedModel.route !== 'Local'
                    ? 'Choose a local model'
                    : selectedModel.name}
            </span>
            <Icon name="chevron" size={13} />
          </button>
          {selectedModel && modelReady && supportedReasoning.length > 1 && (
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
              Thinking:{' '}
              {cap(
                supportedReasoning.includes(workspace.settings.reasoningEffort)
                  ? workspace.settings.reasoningEffort
                  : supportedReasoning[0]!,
              )}
            </button>
          )}
          <button
            className="send-button"
            onClick={() => void send()}
            disabled={
              (!value.trim() && attachments.length === 0) ||
              !modelReady ||
              (offline && selectedModel?.route === 'Cloud') ||
              sending
            }
            aria-label={modelReady ? 'Send message' : 'Choose a ready model before sending'}
          >
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
      {!compact && (
        <div className="composer__hint">
          {selectedModel && <RouteBadge route={selectedModel.route} />}
          <span>
            {!selectedModel
              ? 'Choose a ready model before sending.'
              : !modelReady
                ? modelAvailabilityDetail(selectedModel)
                : selectedModel.route === 'Local'
                  ? 'Runs privately on this computer. Nothing is sent to a model provider.'
                  : offline
                    ? `Sending to ${selectedModel.provider} is paused in offline mode.`
                    : `Sent to ${selectedModel.provider} only when you press Send.`}
          </span>
          <span className="composer__keys">
            <kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> newline
          </span>
        </div>
      )}
      {offline && selectedModel?.route === 'Cloud' && (
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
                  {pendingDisclosure.disclosure.costClass ??
                    selectedModel?.cost ??
                    'Cost unavailable'}
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
  onRename: (id: string, title: string) => void | Promise<void>;
  onArchive: (id: string, archived: boolean) => void | Promise<void>;
  conversations: Conversation[];
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'pinned' | 'archived'>('all');
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [pendingRow, setPendingRow] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const shown = conversations.filter(
    (c) =>
      (tab === 'all' ? !c.archived : tab === 'pinned' ? c.pinned && !c.archived : c.archived) &&
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
      {notice && (
        <div
          className={cx('interaction-notice', notice.tone === 'error' && 'is-error')}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          <Icon name={notice.tone === 'error' ? 'info' : 'check'} size={15} />
          {notice.text}
        </div>
      )}
      {shown.length ? (
        <div className="chat-list">
          {shown.map((c, i) => (
            <article className={cx('chat-list__row', pendingRow === c.id && 'is-busy')} key={c.id}>
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
                  setRenameTarget(c);
                  setRenameTitle(c.title);
                  setDialogError('');
                }}
                disabled={pendingRow === c.id}
              >
                <Icon name="edit" />
              </button>
              <button
                className="icon-button"
                aria-label={`${c.archived ? 'Restore' : 'Archive'} ${c.title}`}
                title={c.archived ? 'Restore' : 'Archive'}
                onClick={() => {
                  void (async () => {
                    setPendingRow(c.id);
                    setNotice(null);
                    try {
                      await onArchive(c.id, !c.archived);
                      setNotice({
                        tone: 'success',
                        text: c.archived
                          ? `Restored “${c.title}”.`
                          : `Archived “${c.title}”. You can find it in Archived.`,
                      });
                    } catch (reason) {
                      setNotice({
                        tone: 'error',
                        text:
                          reason instanceof Error
                            ? reason.message
                            : 'The conversation could not be updated.',
                      });
                    } finally {
                      setPendingRow(null);
                    }
                  })();
                }}
                disabled={pendingRow === c.id}
              >
                <Icon name={c.archived ? 'retry' : 'archive'} />
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
      <FormDialog
        open={Boolean(renameTarget)}
        eyebrow="Conversation title"
        title="Rename conversation"
        description="Choose a clear title you will recognize in search, projects, and recent chats."
        submitLabel="Save title"
        pendingLabel="Saving title…"
        pending={Boolean(renameTarget && pendingRow === renameTarget.id)}
        error={dialogError}
        onClose={() => {
          if (renameTarget && pendingRow === renameTarget.id) return;
          setRenameTarget(null);
          setDialogError('');
        }}
        onSubmit={async () => {
          const title = renameTitle.trim();
          if (!renameTarget) return;
          if (!title) {
            setDialogError('Enter a conversation title.');
            return;
          }
          if (title.length > 160) {
            setDialogError('Keep the title to 160 characters or fewer.');
            return;
          }
          setPendingRow(renameTarget.id);
          setDialogError('');
          try {
            await onRename(renameTarget.id, title);
            setNotice({ tone: 'success', text: `Renamed conversation to “${title}”.` });
            setRenameTarget(null);
          } catch (reason) {
            setDialogError(
              reason instanceof Error ? reason.message : 'The conversation could not be renamed.',
            );
          } finally {
            setPendingRow(null);
          }
        }}
      >
        <label>
          Title
          <input
            autoFocus
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            maxLength={160}
            autoComplete="off"
          />
          <small>{renameTitle.trim().length}/160 characters</small>
        </label>
      </FormDialog>
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
      <button
        aria-label="Copy message"
        title="Copy"
        onClick={onCopy}
        disabled={!message && !onCopy}
      >
        <Icon name="copy" />
      </button>
      {!user && (
        <button aria-label="Retry response" title="Retry" onClick={onRetry} disabled={!onRetry}>
          <Icon name="retry" />
        </button>
      )}
      {user && onEdit && (
        <button aria-label="Edit message" title="Edit" onClick={onEdit}>
          <Icon name="edit" />
        </button>
      )}
      <button
        aria-label="Branch from message"
        title="Branch"
        onClick={onBranch}
        disabled={!onBranch}
      >
        <Icon name="branch" />
      </button>
      {!user && onContinue && (
        <button aria-label="Continue response" title="Continue" onClick={onContinue}>
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

function LiveConversation({ selectedModel }: { selectedModel: ModelDescriptor | null }) {
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
  const [actionNotice, setActionNotice] = useState<null | {
    tone: 'pending' | 'success' | 'error';
    text: string;
  }>(null);
  const [editTarget, setEditTarget] = useState<MessageRecord | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState('');
  const [confirmingAction, setConfirmingAction] = useState(false);
  const [continuingMessageId, setContinuingMessageId] = useState<string | null>(null);
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
  const executeAction = async (
    message: MessageRecord,
    mode: 'retry' | 'edit' | 'regenerate' | 'continue',
    content: string,
    confirmation?: { confirmationToken: string; outboundIntent: OutboundIntent },
    resolvedModelId?: string,
  ) => {
    const labels = {
      retry: ['Retrying response…', 'Response retry started.'],
      edit: ['Creating an edited branch…', 'Edited branch created.'],
      regenerate: ['Regenerating response…', 'Response regeneration started.'],
      continue: ['Continuing response…', 'Continuation started.'],
    } as const;
    setActionError('');
    setActionNotice({ tone: 'pending', text: labels[mode][0] });
    const actionModelId = resolvedModelId ?? confirmation?.outboundIntent.modelId;
    if (!actionModelId) {
      const text = 'Choose a ready model before using message actions.';
      setActionError(text);
      setActionNotice({ tone: 'error', text });
      return false;
    }
    const sent = await workspace.sendMessage({
      content,
      modelId: confirmation?.outboundIntent.modelId ?? actionModelId,
      attachments: [],
      references: [],
      reasoningEffort: workspace.settings.reasoningEffort,
      enabledToolIds: workspace.settings.enabledToolIds,
      mode,
      messageId: message.id,
      outboundConfirmationToken: confirmation?.confirmationToken,
      outboundIntent: confirmation?.outboundIntent,
    });
    if (!sent) {
      const text = workspace.error || 'CupcakeAI could not complete that message action.';
      setActionError(text);
      setActionNotice({ tone: 'error', text });
      return false;
    }
    setActionNotice({ tone: 'success', text: labels[mode][1] });
    return true;
  };
  const runAction = async (
    message: MessageRecord,
    mode: 'retry' | 'edit' | 'regenerate' | 'continue',
    editedContent?: string,
  ) => {
    const content =
      mode === 'continue'
        ? 'Continue from the previous response.'
        : mode === 'edit'
          ? (editedContent?.trim() ?? '')
          : message.content;
    if (!content) return false;
    const hasPersistedRoute = Boolean(message.modelId || message.providerId);
    const actionModel =
      mode === 'continue' && hasPersistedRoute
        ? resolvePersistedMessageModel(workspace.models, message)
        : selectedModel;
    if (!actionModel) {
      const text =
        mode === 'continue' && hasPersistedRoute
          ? 'The original provider route is unavailable, so this response was not continued.'
          : 'Choose a ready model before using message actions.';
      setActionError(text);
      setActionNotice({ tone: 'error', text });
      return false;
    }
    if (!modelIsAvailableInChat(actionModel)) {
      const text = `${modelAvailabilityDetail(actionModel)}. Choose another model to continue.`;
      setActionError(text);
      setActionNotice({ tone: 'error', text });
      return false;
    }
    const actionModelId = canonicalModelId(actionModel);
    if (actionModel.route !== 'Cloud' || workspace.fixtureMode) {
      return executeAction(message, mode, content, undefined, actionModelId);
    }
    try {
      setActionError('');
      setActionNotice({ tone: 'pending', text: 'Checking what will be sent…' });
      const result = await workspace.preflightCloudDisclosure({
        content,
        modelId: actionModelId,
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
      setActionNotice(null);
      return true;
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : 'Action preflight failed.';
      setActionError(text);
      setActionNotice({ tone: 'error', text });
      return false;
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
      {actionError && !actionNotice && (
        <p className="field-error conversation-action-error" role="alert">
          {actionError}
        </p>
      )}
      {actionNotice && (
        <div
          className={cx(
            'interaction-notice',
            actionNotice.tone === 'pending' && 'is-pending',
            actionNotice.tone === 'error' && 'is-error',
          )}
          role={actionNotice.tone === 'error' ? 'alert' : 'status'}
        >
          {actionNotice.tone === 'pending' ? (
            <span className="pulse-dot" />
          ) : (
            <Icon name={actionNotice.tone === 'success' ? 'check' : 'info'} size={15} />
          )}
          {actionNotice.text}
        </div>
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
              <CupcakePortrait
                value={workspace.settings.profile.avatar}
                label={`${workspace.settings.profile.displayName}'s profile picture`}
              />
            ) : message.role === 'status' ? (
              <Icon name="task" />
            ) : (
              <CupcakePortrait
                value={workspace.settings.assistantAvatar}
                label="Cupcake assistant picture"
              />
            )}
          </div>
          <div className={cx('message', message.role === 'user' && 'message--user')}>
            <div className="message-meta">
              <strong>
                {message.role === 'user' ? 'You' : message.role === 'status' ? 'Task' : 'Cupcake'}
              </strong>
              {message.role === 'assistant' && (
                <span className="model-label">
                  {message.modelId ?? selectedModel?.name ?? 'No model selected'}
                </span>
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
                {(message.content || message.responseState !== 'cancelled') && (
                  <RichMarkdown streaming={message.streaming}>
                    {message.content || 'Starting response…'}
                  </RichMarkdown>
                )}
                {message.responseState === 'cancelled' && !message.streaming && (
                  <div className="response-limit-notice response-stopped-notice" role="status">
                    <Icon name="pause" size={17} />
                    <div>
                      <strong>Response stopped</strong>
                      <p>
                        {message.content
                          ? 'The partial response above is preserved.'
                          : 'Your message was saved, but the response stopped before answer text was produced.'}
                      </p>
                    </div>
                  </div>
                )}
                {message.finishReason === 'length' && !message.streaming && (
                  <div className="response-limit-notice" role="note">
                    <Icon name="info" size={17} />
                    <div>
                      <strong>Response limit reached</strong>
                      <p>
                        The provider stopped at its output limit. The partial response above is
                        preserved.
                      </p>
                    </div>
                    <button
                      className="button button--primary"
                      disabled={continuingMessageId !== null}
                      onClick={() => {
                        void (async () => {
                          setContinuingMessageId(message.id);
                          try {
                            await runAction(message, 'continue');
                          } catch (reason) {
                            const text =
                              reason instanceof Error
                                ? reason.message
                                : 'The response could not be continued.';
                            setActionError(text);
                            setActionNotice({ tone: 'error', text });
                          } finally {
                            setContinuingMessageId(null);
                          }
                        })();
                      }}
                    >
                      {continuingMessageId === message.id ? 'Continuing…' : 'Continue response'}
                    </button>
                  </div>
                )}
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
                onCopy={() => {
                  setActionNotice({ tone: 'pending', text: 'Copying message…' });
                  void workspace
                    .copyMessage(message.id)
                    .then((copied) => {
                      if (!copied) throw new Error('This message is no longer available to copy.');
                      setActionNotice({ tone: 'success', text: 'Message copied.' });
                    })
                    .catch((reason) =>
                      setActionNotice({
                        tone: 'error',
                        text:
                          reason instanceof Error
                            ? reason.message
                            : 'The message could not be copied.',
                      }),
                    );
                }}
                onRetry={
                  message.role === 'assistant' ? () => void runAction(message, 'retry') : undefined
                }
                onEdit={
                  message.role === 'user'
                    ? () => {
                        setEditTarget(message);
                        setEditContent(message.content);
                        setEditError('');
                      }
                    : undefined
                }
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
            {actionError && (
              <p className="form-dialog__error" role="alert">
                {actionError}
              </p>
            )}
            <footer>
              <button
                className="button"
                onClick={() => setPendingAction(null)}
                disabled={confirmingAction}
              >
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                disabled={confirmingAction}
                onClick={() => {
                  void (async () => {
                    setConfirmingAction(true);
                    try {
                      const sent = await executeAction(
                        pendingAction.message,
                        pendingAction.mode,
                        pendingAction.content,
                        {
                          confirmationToken: pendingAction.confirmationToken,
                          outboundIntent: pendingAction.outboundIntent,
                        },
                      );
                      if (sent) setPendingAction(null);
                    } catch (reason) {
                      const text =
                        reason instanceof Error
                          ? reason.message
                          : 'The message action could not be sent.';
                      setActionError(text);
                      setActionNotice({ tone: 'error', text });
                    } finally {
                      setConfirmingAction(false);
                    }
                  })();
                }}
              >
                {confirmingAction ? 'Sending…' : `Confirm ${pendingAction.mode}`}
              </button>
            </footer>
          </section>
        </div>
      )}
      <FormDialog
        open={Boolean(editTarget)}
        eyebrow="Immutable conversation branch"
        title="Edit your message"
        description="CupcakeAI keeps the original thread intact and creates a sibling branch from this revised message."
        submitLabel="Create edited branch"
        pendingLabel="Preparing branch…"
        pending={editPending}
        error={editError}
        onClose={() => {
          if (editPending) return;
          setEditTarget(null);
          setEditError('');
        }}
        onSubmit={async () => {
          const content = editContent.trim();
          if (!editTarget) return;
          if (!content) {
            setEditError('Enter the message you want to send on the new branch.');
            return;
          }
          setEditPending(true);
          setEditError('');
          const prepared = await runAction(editTarget, 'edit', content);
          setEditPending(false);
          if (prepared) setEditTarget(null);
          else setEditError(actionError || 'The edited branch could not be created.');
        }}
      >
        <label>
          Revised message
          <textarea
            autoFocus
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            rows={7}
          />
          <small>The original message remains available on its current branch.</small>
        </label>
      </FormDialog>
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
  selectedModel: ModelDescriptor | null;
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
  useEffect(() => {
    if (workspace.activeRunId) setStopped(false);
  }, [workspace.activeRunId]);
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
                  <CupcakePortrait
                    value={workspace.settings.profile.avatar}
                    label={`${workspace.settings.profile.displayName}'s profile picture`}
                  />
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
                  <CupcakePortrait
                    value={workspace.settings.assistantAvatar}
                    label="Cupcake assistant picture"
                  />
                </div>
                <div className="message">
                  <div className="message-meta">
                    <strong>Cupcake</strong>
                    <span className="model-label">
                      {selectedModel?.name ?? 'No model selected'} · High reasoning
                    </span>
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
                  <CupcakePortrait
                    value={workspace.settings.assistantAvatar}
                    label="Cupcake assistant picture"
                  />
                </div>
                <div className="message">
                  <div className="message-meta">
                    <strong>Cupcake</strong>
                    <span className="model-label">
                      {selectedModel?.name ?? 'No model selected'}
                    </span>
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
                      <CupcakePortrait
                        value={workspace.settings.profile.avatar}
                        label={`${workspace.settings.profile.displayName}'s profile picture`}
                      />
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
                        <CupcakePortrait
                          value={workspace.settings.assistantAvatar}
                          label="Cupcake assistant picture"
                        />
                      )}
                    </div>
                    <div className="message">
                      <div className="message-meta">
                        <strong>{message.role === 'status' ? 'Task' : 'Cupcake'}</strong>
                        <span className="model-label">
                          {selectedModel?.name ?? 'No model selected'}
                        </span>
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
  selectedModel: ModelDescriptor | null;
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
            {totalTokens.toLocaleString()}{' '}
            <small>/ {selectedModel?.context ?? 'choose a model'}</small>
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
          {selectedModel ? <RouteBadge route={selectedModel.route} /> : <Icon name="model" />}
          <strong>
            {!selectedModel
              ? 'No model destination selected'
              : !modelIsAvailableInChat(selectedModel)
                ? `${selectedModel.name} is unavailable`
                : offline && selectedModel.route === 'Cloud'
                  ? 'Cloud sending is blocked in offline mode'
                  : selectedModel.route === 'Local'
                    ? 'This message stays local'
                    : `Sent to ${selectedModel.provider}`}
          </strong>
          <p>
            {!selectedModel
              ? 'Choose a ready route before sending.'
              : !modelIsAvailableInChat(selectedModel)
                ? modelAvailabilityDetail(selectedModel)
                : selectedModel.route === 'Local'
                  ? 'No content leaves this computer.'
                  : offline
                    ? 'No content leaves this computer while offline mode is on.'
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

function ProjectsView({ navigate }: { navigate: (view: 'chat' | 'artifacts') => void }) {
  const workspace = useWorkspace();
  const [dialog, setDialog] = useState<'create' | 'edit' | 'archive' | null>(null);
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const activeProject =
    workspace.projects.find((project) => project.id === workspace.activeProjectId) ??
    workspace.projects[0];

  const projectCounts = (projectId: string, projectName: string) => ({
    chats: workspace.conversations.filter((item) => item.project === projectName).length,
    artifacts: workspace.artifactCounts[projectId] ?? 0,
    tasks: workspace.tasks.filter(
      (item) =>
        (item.project === projectId || item.project === projectName) && item.status === 'working',
    ).length,
  });
  const beginCreate = () => {
    setName('');
    setDescription('');
    setDialogProjectId(null);
    setDialogError('');
    setDialog('create');
  };
  const beginEdit = (project: (typeof workspace.projects)[number]) => {
    setName(project.name);
    setDescription(project.description);
    setDialogProjectId(project.id);
    setDialogError('');
    setDialog('edit');
  };
  const runDialogAction = async () => {
    const cleanName = name.trim();
    if (dialog !== 'archive' && !cleanName) {
      setDialogError('Give this project a name.');
      return;
    }
    setPending(true);
    setDialogError('');
    try {
      if (dialog === 'create') await workspace.createProject(cleanName, description.trim());
      else if (dialog === 'edit' && dialogProjectId)
        await workspace.updateProject(dialogProjectId, cleanName, description.trim());
      else if (dialog === 'archive' && dialogProjectId)
        await workspace.archiveProject(dialogProjectId);
      setDialog(null);
    } catch (reason) {
      setDialogError(
        reason instanceof Error ? reason.message : 'The project change could not be saved.',
      );
    } finally {
      setPending(false);
    }
  };
  const openProjectView = (projectId: string, view: 'chat' | 'artifacts') => {
    void workspace.setActiveProject(projectId).catch(() => undefined);
    navigate(view);
  };

  return (
    <main className="page projects-workbench">
      <div className="page-intro projects-intro">
        <div>
          <p className="eyebrow">A room for every body of work</p>
          <h2>Projects</h2>
          <p>Keep chats, artifacts, tasks, and remembered decisions inside one clear boundary.</p>
        </div>
        <button className="button button--primary" onClick={beginCreate}>
          <Icon name="plus" /> New project
        </button>
      </div>

      {activeProject ? (
        <section className="project-focus" aria-label={`Active project: ${activeProject.name}`}>
          <div className="project-focus__identity">
            <span className="project-focus__sigil" aria-hidden="true">
              {activeProject.name
                .split(/\s+/)
                .map((part) => part[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <div>
              <span className="project-focus__state">
                <Icon name="shield" size={14} /> Active context boundary
              </span>
              <h3>{activeProject.name}</h3>
              <p>
                {activeProject.description ||
                  'Add a short brief so Cupcake knows what belongs here.'}
              </p>
            </div>
          </div>
          <div className="project-focus__paths">
            {(() => {
              const counts = projectCounts(activeProject.id, activeProject.name);
              return (
                <>
                  <button onClick={() => openProjectView(activeProject.id, 'chat')}>
                    <span>
                      <Icon name="chat" />
                    </span>
                    <strong>
                      {counts.chats} {counts.chats === 1 ? 'chat' : 'chats'}
                    </strong>
                    <small>Open the conversation room</small>
                    <Icon name="chevron" />
                  </button>
                  <button onClick={() => openProjectView(activeProject.id, 'artifacts')}>
                    <span>
                      <Icon name="artifact" />
                    </span>
                    <strong>
                      {counts.artifacts} {counts.artifacts === 1 ? 'artifact' : 'artifacts'}
                    </strong>
                    <small>Read and revise project work</small>
                    <Icon name="chevron" />
                  </button>
                  <div className="project-focus__task-state">
                    <span>
                      <Icon name="task" />
                    </span>
                    <strong>{counts.tasks} running</strong>
                    <small>Durable work in progress</small>
                  </div>
                </>
              );
            })()}
          </div>
          <button className="project-focus__edit" onClick={() => beginEdit(activeProject)}>
            <Icon name="edit" size={14} /> Edit project
          </button>
        </section>
      ) : (
        <section className="project-first-step">
          <span>
            <Icon name="project" size={28} />
          </span>
          <div>
            <p className="eyebrow">Your first workspace</p>
            <h3>Give a piece of work its own room</h3>
            <p>
              Start with a name and a plain-language brief. You can add chats and artifacts next.
            </p>
          </div>
          <button className="button button--primary" onClick={beginCreate}>
            Create project
          </button>
        </section>
      )}

      {workspace.projects.length > 0 && (
        <section className="project-library">
          <header>
            <div>
              <p className="eyebrow">Project library</p>
              <h3>Switch context deliberately</h3>
            </div>
            <span>
              {workspace.projects.length} {workspace.projects.length === 1 ? 'project' : 'projects'}
            </span>
          </header>
          <div className="project-grid project-grid--workbench">
            {workspace.projects.map((project, index) => {
              const counts = projectCounts(project.id, project.name);
              const active = workspace.activeProjectId === project.id;
              return (
                <article
                  className={cx('project-card project-card--workbench', active && 'is-active')}
                  key={project.id}
                >
                  <header>
                    <span
                      className={`project-sigil ${index % 3 === 0 ? 'berry' : index % 3 === 1 ? 'green' : 'blue'}`}
                    >
                      {project.name
                        .split(/\s+/)
                        .map((part) => part[0])
                        .join('')
                        .slice(0, 2)
                        .toUpperCase()}
                    </span>
                    {active && (
                      <em>
                        <span /> Active
                      </em>
                    )}
                  </header>
                  <button
                    className="project-card__select"
                    onClick={() =>
                      void workspace.setActiveProject(project.id).catch(() => undefined)
                    }
                  >
                    <strong>{project.name}</strong>
                    <span>{project.description || 'No project brief yet.'}</span>
                  </button>
                  <div className="project-card__counts" aria-label="Project contents">
                    <span>
                      <Icon name="chat" size={14} />
                      <strong>{counts.chats}</strong> Chats
                    </span>
                    <span>
                      <Icon name="artifact" size={14} />
                      <strong>{counts.artifacts}</strong> Artifacts
                    </span>
                    <span>
                      <Icon name="task" size={14} />
                      <strong>{counts.tasks}</strong> Running
                    </span>
                  </div>
                  <footer>
                    <small>
                      {project.updatedAt
                        ? `Updated ${new Date(project.updatedAt).toLocaleDateString()}`
                        : 'Ready to use'}
                    </small>
                    <button onClick={() => beginEdit(project)} aria-label={`Edit ${project.name}`}>
                      <Icon name="edit" size={14} />
                    </button>
                  </footer>
                </article>
              );
            })}
            <button className="project-new-card project-new-card--compact" onClick={beginCreate}>
              <span>
                <Icon name="plus" />
              </span>
              <strong>Start another project</strong>
              <small>Create a separate context boundary.</small>
            </button>
          </div>
        </section>
      )}

      <section className="project-boundary-note">
        <Icon name="shield" />
        <div>
          <strong>The active project controls what Cupcake can retrieve.</strong>
          <p>
            Its chats, artifacts, files, and project memory stay scoped here unless you explicitly
            attach outside context.
          </p>
        </div>
      </section>

      <FormDialog
        open={dialog === 'create' || dialog === 'edit'}
        eyebrow={dialog === 'edit' ? 'Project settings' : 'New context boundary'}
        title={dialog === 'edit' ? 'Edit project' : 'Create a project'}
        description="Describe what belongs here. Clear project briefs make chat context and saved work easier to understand later."
        submitLabel={dialog === 'edit' ? 'Save changes' : 'Create project'}
        pendingLabel={dialog === 'edit' ? 'Saving…' : 'Creating…'}
        pending={pending}
        error={dialogError}
        onClose={() => setDialog(null)}
        onSubmit={runDialogAction}
      >
        <label>
          <span>Project name</span>
          <input
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="Research launch plan"
          />
        </label>
        <label>
          <span>What belongs here?</span>
          <textarea
            value={description}
            maxLength={10000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Goals, source material, decisions, and boundaries for this work…"
            rows={5}
          />
          <small>{description.length.toLocaleString()} / 10,000</small>
        </label>
        {dialog === 'edit' && (
          <button
            type="button"
            className="project-archive-link"
            onClick={() => setDialog('archive')}
          >
            Archive this project
          </button>
        )}
      </FormDialog>

      <FormDialog
        open={dialog === 'archive'}
        eyebrow="Reversible cleanup"
        title={`Archive ${name || 'this project'}?`}
        description="The project and its history stay in the encrypted workspace, but disappear from your active library."
        submitLabel="Archive project"
        pendingLabel="Archiving…"
        pending={pending}
        error={dialogError}
        onClose={() => setDialog(null)}
        onSubmit={runDialogAction}
      >
        <div className="project-archive-warning">
          <Icon name="archive" />
          <span>
            Chats, artifacts, and memory are retained. This project can be restored through project
            history in a future release.
          </span>
        </div>
      </FormDialog>
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
  const [followupOpen, setFollowupOpen] = useState(false);
  const [followupPrompt, setFollowupPrompt] = useState('');
  const [followupPending, setFollowupPending] = useState(false);
  const [followupError, setFollowupError] = useState('');
  const [taskAction, setTaskAction] = useState<null | {
    tone: 'pending' | 'success' | 'error';
    text: string;
  }>(null);
  const [controlPending, setControlPending] = useState(false);
  const [steerPending, setSteerPending] = useState(false);
  const statusLabel =
    task.status === 'complete'
      ? 'Complete'
      : task.status === 'waiting'
        ? 'Waiting for input or approval'
        : task.status === 'failed'
          ? 'Stopped before completion'
          : 'In progress';
  return (
    <main className="page task-detail">
      <button className="back-button" onClick={onBack}>
        <Icon name="arrow" />
        All tasks
      </button>
      <div className="task-detail__head">
        <div>
          <div className="status-line">
            {task.status === 'working' && <span className="pulse-dot" />}
            {statusLabel}
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
          </div>
        </div>
        <div>
          <button
            className="button"
            onClick={() => {
              void (async () => {
                setControlPending(true);
                setTaskAction({
                  tone: 'pending',
                  text: paused ? 'Resuming from the saved checkpoint…' : 'Requesting a safe stop…',
                });
                try {
                  await (paused ? workspace.resumeTask(task.id) : workspace.cancelTask(task.id));
                  setTaskAction({
                    tone: 'success',
                    text: paused ? 'Resume request accepted.' : 'Safe stop requested.',
                  });
                } catch (reason) {
                  setTaskAction({
                    tone: 'error',
                    text:
                      reason instanceof Error ? reason.message : 'The task could not be updated.',
                  });
                } finally {
                  setControlPending(false);
                }
              })();
            }}
            disabled={task.status === 'complete' || task.status === 'failed' || controlPending}
          >
            <Icon name={paused ? 'play' : 'pause'} />
            {controlPending ? 'Updating…' : paused ? 'Resume' : 'Cancel safely'}
          </button>
        </div>
      </div>
      {taskAction && (
        <div
          className={cx(
            'interaction-notice',
            taskAction.tone === 'pending' && 'is-pending',
            taskAction.tone === 'error' && 'is-error',
          )}
          role={taskAction.tone === 'error' ? 'alert' : 'status'}
        >
          {taskAction.tone === 'pending' ? (
            <span className="pulse-dot" />
          ) : (
            <Icon name={taskAction.tone === 'success' ? 'check' : 'info'} size={15} />
          )}
          {taskAction.text}
        </div>
      )}
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
                  {step.state === 'active' && <small>Current checkpoint</small>}
                </div>
                {step.state === 'active' && <span className="live-badge">NOW</span>}
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
            {task.steps.map((step) => (
              <div
                className={cx(
                  step.state === 'active' && 'is-active',
                  step.state === 'failed' && 'is-failed',
                )}
                key={step.label}
              >
                {step.state === 'complete' ? (
                  <Icon name="check" />
                ) : step.state === 'active' ? (
                  <span className="pulse-dot" />
                ) : step.state === 'failed' ? (
                  <Icon name="x" />
                ) : (
                  <Icon name="clock" />
                )}
                <span>
                  <strong>{step.label}</strong>
                  <small>
                    {step.state === 'complete'
                      ? 'Checkpoint complete'
                      : step.state === 'active'
                        ? 'In progress'
                        : step.state === 'failed'
                          ? 'Stopped at this checkpoint'
                          : 'Queued'}
                  </small>
                </span>
              </div>
            ))}
            {task.steps.length === 0 && (
              <div>
                <Icon name="info" />
                <span>
                  <strong>No checkpoint details available</strong>
                  <small>The runtime has not reported task steps.</small>
                </span>
              </div>
            )}
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
                aria-label="Queue task guidance"
                disabled={!note.trim() || steerPending}
                onClick={() => {
                  void (async () => {
                    const instruction = note.trim();
                    if (!instruction) return;
                    setSteerPending(true);
                    setTaskAction({ tone: 'pending', text: 'Queueing guidance…' });
                    try {
                      await workspace.steerTask(task.id, instruction);
                      setUpdates((items) => [...items, instruction]);
                      setNote('');
                      setTaskAction({
                        tone: 'success',
                        text: 'Guidance queued for the next safe checkpoint.',
                      });
                    } catch (reason) {
                      setTaskAction({
                        tone: 'error',
                        text:
                          reason instanceof Error
                            ? reason.message
                            : 'Guidance could not be queued.',
                      });
                    } finally {
                      setSteerPending(false);
                    }
                  })();
                }}
              >
                <Icon name="send" />
              </button>
            </div>
            <small className="steer-task__status">
              {steerPending
                ? 'Waiting for the runtime…'
                : 'Guidance is applied only after the runtime confirms it was queued.'}
            </small>
            <button
              className="text-button"
              onClick={() => {
                setFollowupPrompt('');
                setFollowupError('');
                setFollowupOpen(true);
              }}
            >
              Queue follow-up <Icon name="chevron" />
            </button>
          </div>
        </section>
      </div>
      <FormDialog
        open={followupOpen}
        eyebrow="After this task"
        title="Queue a follow-up"
        description="The follow-up starts only after this task reaches a safe completion point."
        submitLabel="Queue follow-up"
        pendingLabel="Queueing follow-up…"
        pending={followupPending}
        error={followupError}
        onClose={() => {
          if (followupPending) return;
          setFollowupOpen(false);
          setFollowupError('');
        }}
        onSubmit={async () => {
          const prompt = followupPrompt.trim();
          if (!prompt) {
            setFollowupError('Describe what CupcakeAI should do next.');
            return;
          }
          setFollowupPending(true);
          setFollowupError('');
          try {
            await workspace.followupTask(task.id, prompt);
            setFollowupOpen(false);
            setTaskAction({
              tone: 'success',
              text: 'Follow-up queued after this task.',
            });
          } catch (reason) {
            setFollowupError(
              reason instanceof Error ? reason.message : 'The follow-up could not be queued.',
            );
          } finally {
            setFollowupPending(false);
          }
        }}
      >
        <label>
          Follow-up instructions
          <textarea
            autoFocus
            value={followupPrompt}
            onChange={(event) => setFollowupPrompt(event.target.value)}
            placeholder="For example: turn the findings into a short implementation plan"
            rows={6}
          />
          <small>You can review the queued follow-up in this task after it is accepted.</small>
        </label>
      </FormDialog>
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

function ArtifactsView({ openTask }: { openTask: (task: Task) => void }) {
  const workspace = useWorkspace();
  const requestedArtifactId = useRef(sessionStorage.getItem('cupcake-open-artifact'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'preview' | 'edit' | 'revisions'>('preview');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [loadingArtifact, setLoadingArtifact] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<'clean' | 'dirty' | 'saving' | 'saved' | 'error'>(
    'clean',
  );
  const [saveMessage, setSaveMessage] = useState('');
  const [history, setHistory] = useState<ArtifactRevisionRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [revisionContent, setRevisionContent] = useState('');
  const [revisionError, setRevisionError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('Untitled note.md');
  const [createKind, setCreateKind] = useState('document');
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState('');
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'success' | 'error'>(
    'idle',
  );
  const [exportMessage, setExportMessage] = useState('');
  const [testRun, setTestRun] = useState<ArtifactTestRun | null>(null);
  const [testState, setTestState] = useState<
    'idle' | 'creating' | 'approval' | 'running' | 'complete' | 'failed'
  >('idle');
  const [testMessage, setTestMessage] = useState('');
  const draftPending = saveState === 'dirty' || saveState === 'saving' || saveState === 'error';
  const activeProject = workspace.projects.find((item) => item.id === workspace.activeProjectId);
  const projectArtifacts = useMemo(
    () =>
      workspace.artifacts.filter(
        (item) => !workspace.activeProjectId || item.projectId === workspace.activeProjectId,
      ),
    [workspace.activeProjectId, workspace.artifacts],
  );
  const selected =
    projectArtifacts.find((item) => item.id === selectedId) ??
    (requestedArtifactId.current ? undefined : projectArtifacts[0]);
  const [content, setContent] = useState(selected?.content ?? '');
  const isPythonArtifact = Boolean(
    selected &&
    selected.kind.toLowerCase().includes('code') &&
    (selected.mimeType?.toLowerCase().includes('python') || selected.name.endsWith('.py')),
  );
  const testSummary = testRun?.evidence?.testSummary;
  const testSummaryRecord =
    testSummary && typeof testSummary === 'object' && !Array.isArray(testSummary)
      ? (testSummary as Record<string, unknown>)
      : null;
  const testsRun =
    typeof testSummaryRecord?.run === 'number'
      ? testSummaryRecord.run
      : typeof testSummaryRecord?.total === 'number'
        ? testSummaryRecord.total
        : null;

  const artifactKinds = [
    {
      id: 'document',
      label: 'Document',
      icon: 'artifact' as IconName,
      mime: 'text/markdown',
      extension: 'md',
      template: '# Untitled note\n\nStart writing here.\n',
    },
    {
      id: 'report',
      label: 'Report',
      icon: 'file' as IconName,
      mime: 'text/markdown',
      extension: 'md',
      template: '# Project report\n\n## Summary\n\n## Findings\n\n## Next steps\n',
    },
    {
      id: 'code',
      label: 'Code',
      icon: 'code' as IconName,
      mime: 'text/plain',
      extension: 'txt',
      template: '// Start a project-scoped code artifact here.\n',
    },
    {
      id: 'table',
      label: 'Table',
      icon: 'database' as IconName,
      mime: 'text/csv',
      extension: 'csv',
      template: 'Item,Status,Owner\nFirst item,Planned,You\n',
    },
    {
      id: 'diagram',
      label: 'Diagram',
      icon: 'branch' as IconName,
      mime: 'text/plain',
      extension: 'mmd',
      template: 'flowchart LR\n  Question --> Evidence\n  Evidence --> Decision\n',
    },
    {
      id: 'webpage',
      label: 'Web page',
      icon: 'code' as IconName,
      mime: 'text/html',
      extension: 'html',
      template: '<main>\n  <h1>Untitled page</h1>\n  <p>Start building here.</p>\n</main>\n',
    },
  ];
  const shownArtifacts = projectArtifacts.filter((artifact) => {
    const matchesKind = kindFilter === 'all' || artifact.kind.toLowerCase() === kindFilter;
    const matchesQuery = `${artifact.name} ${artifact.kind}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    return matchesKind && matchesQuery;
  });
  const displayBytes = (bytes?: number) => {
    if (bytes === undefined) return 'Stored locally';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  const kindIcon = (kind: string): IconName => {
    const value = kind.toLowerCase();
    if (value.includes('table') || value.includes('spreadsheet')) return 'database';
    if (value.includes('diagram')) return 'branch';
    if (value.includes('code') || value.includes('webpage') || value.includes('configuration'))
      return 'code';
    return 'artifact';
  };

  useEffect(() => {
    setSelectedId(null);
    setTab('preview');
    setHistory([]);
  }, [workspace.activeProjectId]);

  useEffect(() => {
    setTestRun(null);
    setTestState('idle');
    setTestMessage('');
  }, [selected?.id]);

  useEffect(() => {
    const requested = requestedArtifactId.current;
    const firstArtifact = projectArtifacts[0];
    if (requested) {
      if (projectArtifacts.some((item) => item.id === requested)) {
        requestedArtifactId.current = null;
        sessionStorage.removeItem('cupcake-open-artifact');
        setSelectedId(requested);
      } else if (firstArtifact) {
        requestedArtifactId.current = null;
        sessionStorage.removeItem('cupcake-open-artifact');
        setSelectedId(firstArtifact.id);
      }
      return;
    }
    if (!selectedId && firstArtifact) setSelectedId(firstArtifact.id);
  }, [projectArtifacts, selectedId]);

  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }
    let current = true;
    setLoadingArtifact(true);
    setLoadError('');
    void workspace
      .getArtifact(selected)
      .then((snapshot) => {
        if (!current) return;
        setContent(snapshot.content ?? '');
        setSaveState('clean');
        setSaveMessage('');
      })
      .catch((reason) => {
        if (!current) return;
        setLoadError(
          reason instanceof Error ? reason.message : 'The artifact could not be opened.',
        );
      })
      .finally(() => {
        if (current) setLoadingArtifact(false);
      });
    return () => {
      current = false;
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected || tab !== 'revisions') return;
    let current = true;
    setHistoryLoading(true);
    setRevisionError('');
    void workspace
      .getArtifactHistory(selected)
      .then((items) => {
        if (!current) return;
        setHistory(items);
        const latest = items.at(-1);
        setSelectedRevisionId(latest?.id ?? null);
        setRevisionContent(content);
      })
      .catch((reason) => {
        if (current)
          setRevisionError(
            reason instanceof Error ? reason.message : 'Revision history could not be opened.',
          );
      })
      .finally(() => {
        if (current) setHistoryLoading(false);
      });
    return () => {
      current = false;
    };
  }, [selected?.id, tab]);

  const beginCreate = () => {
    if (!activeProject) return;
    setCreateKind('document');
    setCreateName('Untitled note.md');
    setCreateError('');
    setCreateOpen(true);
  };
  const chooseCreateKind = (kind: (typeof artifactKinds)[number]) => {
    const previous = artifactKinds.find((item) => item.id === createKind);
    const base = createName.replace(new RegExp(`\\.${previous?.extension ?? 'md'}$`, 'i'), '');
    setCreateKind(kind.id);
    setCreateName(`${base || 'Untitled'}.${kind.extension}`);
  };
  const createArtifact = async () => {
    const kind = artifactKinds.find((item) => item.id === createKind)!;
    if (!createName.trim()) {
      setCreateError('Give this artifact a name.');
      return;
    }
    setCreatePending(true);
    setCreateError('');
    try {
      const record = await workspace.createArtifact({
        name: createName.trim(),
        kind: kind.id,
        mimeType: kind.mime,
        content: kind.template,
      });
      setSelectedId(record.id);
      setContent(record.content ?? kind.template);
      setTab('edit');
      setCreateOpen(false);
    } catch (reason) {
      setCreateError(
        reason instanceof Error ? reason.message : 'The artifact could not be created.',
      );
    } finally {
      setCreatePending(false);
    }
  };
  const saveRevision = async (nextContent = content, summary = 'Edited in Artifacts') => {
    if (!selected) return;
    setSaveState('saving');
    setSaveMessage('');
    try {
      const record = await workspace.reviseArtifact(selected, nextContent, summary);
      setContent(record.content ?? nextContent);
      setSaveState('saved');
      setSaveMessage(`Revision ${record.revisionNumber ?? ''} saved.`.replace('  ', ' '));
      window.setTimeout(() => setSaveState('clean'), 1800);
      if (tab === 'revisions') setHistory(await workspace.getArtifactHistory(record));
    } catch (reason) {
      setSaveState('error');
      setSaveMessage(
        reason instanceof Error
          ? reason.message
          : 'The revision could not be saved. Your draft is still here.',
      );
    }
  };
  const openRevision = async (revision: ArtifactRevisionRecord) => {
    if (!selected) return;
    setSelectedRevisionId(revision.id);
    setRevisionError('');
    try {
      const snapshot = await workspace.getArtifact(selected, revision.id);
      setRevisionContent(snapshot.content ?? '');
    } catch (reason) {
      setRevisionError(
        reason instanceof Error ? reason.message : 'That revision could not be opened.',
      );
    }
  };
  const exportCurrentRevision = async () => {
    if (!selected) return;
    setExportState('exporting');
    setExportMessage('');
    try {
      const receipt = await workspace.exportArtifact(selected);
      if (!receipt) {
        setExportState('idle');
        return;
      }
      setExportState('success');
      setExportMessage(`${receipt.fileName} exported and verified.`);
      window.setTimeout(() => setExportState('idle'), 2400);
    } catch (reason) {
      setExportState('error');
      setExportMessage(
        reason instanceof Error ? reason.message : 'The artifact could not be exported.',
      );
    }
  };
  const applyTestResult = (run: ArtifactTestRun) => {
    setTestRun(run);
    if (run.status === 'approval_required') {
      setTestState('approval');
      setTestMessage('Review this one-time local sandbox run.');
    } else if (run.status === 'completed') {
      setTestState('complete');
      setTestMessage('The saved revision finished in the local Python sandbox.');
    } else if (run.status === 'failed') {
      setTestState('failed');
      setTestMessage(run.message ?? 'The local Python test run did not complete.');
    } else {
      setTestState('running');
      setTestMessage('Running the saved revision in the local Python sandbox…');
    }
  };
  const executeTestRun = async (run: ArtifactTestRun) => {
    setTestRun(run);
    setTestState('running');
    setTestMessage('Running the saved revision in the local Python sandbox…');
    try {
      applyTestResult(await workspace.executeArtifactTestRun(run));
    } catch (reason) {
      setTestState('failed');
      setTestMessage(reason instanceof Error ? reason.message : 'The test run could not start.');
    }
  };
  const beginTestRun = async () => {
    if (!selected || !isPythonArtifact || draftPending || !selected.revisionId) return;
    setTestState('creating');
    setTestMessage('Binding a test task to this saved revision…');
    try {
      const run = await workspace.createArtifactTestRun(selected);
      setTestRun(run);
      if (run.status === 'ready') await executeTestRun(run);
      else applyTestResult(run);
    } catch (reason) {
      setTestState('failed');
      setTestMessage(
        reason instanceof Error ? reason.message : 'The test task could not be created.',
      );
    }
  };
  const cancelTestApproval = async () => {
    if (!testRun) return;
    try {
      await workspace.cancelTask(testRun.task.id);
    } catch {
      // The approval is still dismissed locally when a terminal task no longer accepts cancellation.
    }
    setTestState('idle');
    setTestMessage('');
    setTestRun(null);
  };
  const cancelRunningTest = async () => {
    if (!testRun) return;
    setTestMessage('Stopping the local test run safely…');
    try {
      await workspace.cancelArtifactTestRun(testRun);
      setTestState('failed');
      setTestMessage('The test run was stopped. The saved artifact was not changed.');
    } catch (reason) {
      setTestMessage(
        reason instanceof Error ? reason.message : 'The test run could not be stopped.',
      );
    }
  };

  if (!activeProject) {
    return (
      <main className="artifact-project-gate">
        <section>
          <span className="artifact-project-gate__mark">
            <Icon name="project" size={30} />
          </span>
          <p className="eyebrow">Artifacts belong to projects</p>
          <h1>Choose a project room</h1>
          <p>Each artifact stays with the chats, tasks, and memory that explain why it exists.</p>
          <div className="artifact-project-gate__choices">
            {workspace.projects.map((project) => (
              <button
                key={project.id}
                onClick={() => void workspace.setActiveProject(project.id).catch(() => undefined)}
              >
                <span>
                  {project.name
                    .split(/\s+/)
                    .map((part) => part[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <strong>{project.name}</strong>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
          {!workspace.projects.length && (
            <small>Create a project from Projects, then come back to begin.</small>
          )}
        </section>
      </main>
    );
  }

  if (!selected) {
    return (
      <main className="artifact-empty-workbench">
        <section className="artifact-empty-folio">
          <div className="artifact-empty-folio__binding" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <span className="eyebrow">{activeProject.name} · project folio</span>
            <h1>Turn useful work into something you can keep</h1>
            <p>
              Create a document, report, code file, table, diagram, or safe web preview. Every save
              becomes a new revision.
            </p>
            <button className="button button--primary" onClick={beginCreate}>
              <Icon name="plus" /> Create first artifact
            </button>
          </div>
        </section>
        <section className="artifact-empty-recipes" aria-label="Artifact starting points">
          {artifactKinds.slice(0, 4).map((kind) => (
            <button
              key={kind.id}
              onClick={() => {
                setCreateKind(kind.id);
                setCreateName(`Untitled.${kind.extension}`);
                setCreateError('');
                setCreateOpen(true);
              }}
            >
              <span>
                <Icon name={kind.icon} />
              </span>
              <strong>{kind.label}</strong>
              <small>
                {kind.id === 'document'
                  ? 'Notes and drafts'
                  : kind.id === 'report'
                    ? 'Structured findings'
                    : kind.id === 'code'
                      ? 'Text-based source'
                      : 'CSV rows and columns'}
              </small>
              <Icon name="chevron" />
            </button>
          ))}
        </section>
        <FormDialog
          open={createOpen}
          eyebrow={`${activeProject.name} · new artifact`}
          title="Add to this project folio"
          description="Choose a useful starting shape. You can revise the content immediately after creation."
          submitLabel="Create artifact"
          pendingLabel="Creating…"
          pending={createPending}
          error={createError}
          onClose={() => setCreateOpen(false)}
          onSubmit={createArtifact}
        >
          <label>
            <span>Artifact name</span>
            <input
              autoFocus
              value={createName}
              maxLength={200}
              onChange={(event) => setCreateName(event.target.value)}
            />
          </label>
          <fieldset className="artifact-kind-picker">
            <legend>Starting format</legend>
            {artifactKinds.map((kind) => (
              <button
                type="button"
                className={createKind === kind.id ? 'is-active' : ''}
                onClick={() => chooseCreateKind(kind)}
                key={kind.id}
              >
                <Icon name={kind.icon} />
                <span>{kind.label}</span>
              </button>
            ))}
          </fieldset>
        </FormDialog>
      </main>
    );
  }
  return (
    <main className="artifact-workspace artifact-workspace--folio">
      <aside className="artifact-list artifact-list--folio">
        <div className="artifact-scope">
          <span className="eyebrow">Active project</span>
          <strong>{activeProject.name}</strong>
          <div className="artifact-project-chips" aria-label="Switch artifact project">
            {workspace.projects.map((project) => (
              <button
                className={project.id === activeProject.id ? 'is-active' : ''}
                onClick={() => void workspace.setActiveProject(project.id).catch(() => undefined)}
                key={project.id}
                aria-label={`Show artifacts from ${project.name}`}
                disabled={draftPending && project.id !== activeProject.id}
                title={
                  draftPending && project.id !== activeProject.id
                    ? 'Save the current draft before switching projects'
                    : undefined
                }
              >
                {project.name
                  .split(/\s+/)
                  .map((part) => part[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="artifact-list__head">
          <div>
            <h2>Project folio</h2>
            <small>
              {projectArtifacts.length} {projectArtifacts.length === 1 ? 'artifact' : 'artifacts'}
            </small>
          </div>
          <button
            className="icon-button"
            onClick={beginCreate}
            aria-label="Create artifact"
            disabled={draftPending}
            title={
              draftPending ? 'Save the current draft before creating another artifact' : undefined
            }
          >
            <Icon name="plus" />
          </button>
        </div>
        <label className="artifact-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find in this project"
          />
          <span>{shownArtifacts.length}</span>
        </label>
        <div className="artifact-kind-filters" aria-label="Filter artifact types">
          {['all', ...new Set(projectArtifacts.map((item) => item.kind.toLowerCase()))].map(
            (kind) => (
              <button
                className={kindFilter === kind ? 'is-active' : ''}
                onClick={() => setKindFilter(kind)}
                key={kind}
              >
                {kind === 'all' ? 'All' : cap(kind)}
              </button>
            ),
          )}
        </div>
        <div className="artifact-list__items">
          {shownArtifacts.map((artifact) => (
            <button
              className={cx('artifact-list__item', selected.id === artifact.id && 'is-active')}
              disabled={draftPending && selected.id !== artifact.id}
              title={
                draftPending && selected.id !== artifact.id
                  ? 'Save the current draft before switching artifacts'
                  : undefined
              }
              onClick={() => {
                setSelectedId(artifact.id);
                setTab('preview');
              }}
              key={artifact.id}
            >
              <span className={`artifact-type artifact-type--${artifact.kind.toLowerCase()}`}>
                <Icon name={kindIcon(artifact.kind)} />
              </span>
              <span>
                <strong>{artifact.name}</strong>
                <small>
                  {artifact.revisionNumber
                    ? `${artifact.revisionNumber} ${artifact.revisionNumber === 1 ? 'revision' : 'revisions'}`
                    : cap(artifact.kind)}{' '}
                  ·{' '}
                  {artifact.updatedAt
                    ? new Date(artifact.updatedAt).toLocaleDateString()
                    : 'saved locally'}
                </small>
              </span>
              <Icon name="chevron" />
            </button>
          ))}
          {!shownArtifacts.length && (
            <p className="artifact-list__no-results">No artifacts match this filter.</p>
          )}
        </div>
        <div className="artifact-list__boundary">
          <Icon name="shield" size={14} />
          <span>Only {activeProject.name} appears here.</span>
        </div>
      </aside>
      <section className="artifact-stage artifact-stage--folio">
        <header className="artifact-stage__header">
          <div>
            <span className="eyebrow">
              {cap(selected.kind)} · {activeProject.name}
            </span>
            <h1>{selected.name}</h1>
            <small>
              {displayBytes(selected.size)}
              {selected.revisionNumber ? ` · revision ${selected.revisionNumber}` : ''}
            </small>
          </div>
          <div className="artifact-header-actions">
            <div className={cx('artifact-save-state', `is-${saveState}`)} role="status">
              <span>
                {saveState === 'dirty' || saveState === 'error' ? (
                  '●'
                ) : (
                  <Icon name="check" size={13} />
                )}
              </span>
              {saveState === 'saving'
                ? 'Saving revision…'
                : saveState === 'dirty'
                  ? 'Draft has changes'
                  : saveState === 'error'
                    ? 'Draft preserved'
                    : saveState === 'saved'
                      ? 'Revision saved'
                      : 'Saved locally'}
            </div>
            {isPythonArtifact && (
              <button
                className="button artifact-test-button"
                onClick={() => void beginTestRun()}
                disabled={
                  draftPending ||
                  !selected.revisionId ||
                  testState === 'creating' ||
                  testState === 'running' ||
                  testState === 'approval'
                }
                title={
                  draftPending
                    ? 'Save this draft before running tests'
                    : selected.revisionNumber
                      ? `Run saved revision ${selected.revisionNumber}`
                      : 'Save this artifact before running tests'
                }
              >
                <Icon name={testState === 'complete' ? 'check' : 'play'} />
                {testState === 'creating'
                  ? 'Preparing…'
                  : testState === 'running'
                    ? 'Running…'
                    : testState === 'complete'
                      ? 'Run again'
                      : 'Run tests'}
              </button>
            )}
            {!workspace.fixtureMode && (
              <button
                className="button artifact-export-button"
                onClick={() => void exportCurrentRevision()}
                disabled={
                  exportState === 'exporting' ||
                  saveState === 'dirty' ||
                  saveState === 'saving' ||
                  saveState === 'error'
                }
                title={
                  saveState === 'dirty' || saveState === 'error'
                    ? 'Save this revision before exporting'
                    : undefined
                }
              >
                <Icon
                  name={
                    exportState === 'success'
                      ? 'check'
                      : exportState === 'error'
                        ? 'retry'
                        : 'download'
                  }
                />
                {exportState === 'exporting'
                  ? 'Exporting…'
                  : exportState === 'success'
                    ? 'Exported'
                    : exportState === 'error'
                      ? 'Try export again'
                      : 'Export'}
              </button>
            )}
          </div>
        </header>
        {exportMessage && (
          <div
            className={cx('artifact-export-status', exportState === 'error' && 'is-error')}
            role={exportState === 'error' ? 'alert' : 'status'}
          >
            {exportMessage}
          </div>
        )}
        {testState !== 'idle' && (
          <section
            className={cx('artifact-test-panel', `is-${testState}`)}
            aria-live="polite"
            aria-label="Python test run"
          >
            <span className="artifact-test-panel__mark" aria-hidden="true">
              <Icon
                name={
                  testState === 'complete'
                    ? 'check'
                    : testState === 'failed'
                      ? 'info'
                      : testState === 'approval'
                        ? 'shield'
                        : 'play'
                }
              />
            </span>
            <div className="artifact-test-panel__body">
              <span className="eyebrow">
                {testState === 'approval'
                  ? 'Permission needed'
                  : testState === 'complete'
                    ? 'Local sandbox result'
                    : testState === 'failed'
                      ? 'Test run needs attention'
                      : 'Local sandbox'}
              </span>
              <strong>
                {testState === 'approval'
                  ? 'Run tests for this saved version?'
                  : testState === 'complete'
                    ? testsRun === null
                      ? 'Tests passed'
                      : `${testsRun} ${testsRun === 1 ? 'test' : 'tests'} passed`
                    : testState === 'failed'
                      ? 'Tests did not pass'
                      : testState === 'creating'
                        ? 'Creating a durable test task…'
                        : 'Tests are running…'}
              </strong>
              <p>
                {testState === 'approval'
                  ? `Cupcake will run saved revision ${selected.revisionNumber ?? 'current'} of ${selected.name} in an isolated local Python environment. This permission applies only to this task and saved version.`
                  : testMessage}
              </p>
              {testState === 'complete' &&
                typeof testRun?.evidence?.stdout === 'string' &&
                testRun.evidence.stdout.trim() && (
                  <details>
                    <summary>View test output</summary>
                    <pre>{testRun.evidence.stdout}</pre>
                  </details>
                )}
            </div>
            <div className="artifact-test-panel__actions">
              {testState === 'approval' && testRun ? (
                <>
                  <button className="button" onClick={() => void cancelTestApproval()}>
                    Not now
                  </button>
                  <button
                    className="button button--primary"
                    onClick={() => void executeTestRun(testRun)}
                  >
                    <Icon name="play" /> Allow once
                  </button>
                </>
              ) : testState === 'running' && testRun ? (
                <>
                  <button className="button" onClick={() => void cancelRunningTest()}>
                    Stop tests
                  </button>
                  <button className="button" onClick={() => openTask(testRun.task)}>
                    Open task <Icon name="chevron" />
                  </button>
                </>
              ) : (
                testRun && (
                  <button className="button" onClick={() => openTask(testRun.task)}>
                    Open task <Icon name="chevron" />
                  </button>
                )
              )}
            </div>
          </section>
        )}
        <div className="artifact-tabs">
          {(['preview', 'edit', 'revisions'] as const).map((item) => (
            <button
              className={tab === item ? 'is-active' : ''}
              onClick={() => setTab(item)}
              key={item}
            >
              <Icon name={item === 'preview' ? 'eye' : item === 'edit' ? 'edit' : 'history'} />
              {cap(item)}
              {item === 'revisions' && history.length > 0 && <span>{history.length}</span>}
            </button>
          ))}
        </div>
        {loadError && (
          <div className="artifact-inline-error" role="alert">
            <Icon name="info" />
            <span>{loadError}</span>
            <button onClick={() => setSelectedId(null)}>Close artifact</button>
          </div>
        )}
        {tab === 'preview' && !loadError && (
          <article className="document-preview">
            {loadingArtifact ? (
              <div className="artifact-loading">
                <span />
                <p>Opening the latest immutable revision…</p>
              </div>
            ) : (
              <ArtifactPreview artifact={selected} content={content} />
            )}
          </article>
        )}
        {tab === 'edit' && (
          <div className="artifact-editor artifact-editor--folio">
            <div className="artifact-editor__bar">
              <span>
                <Icon name="edit" size={14} /> Plain text editor
              </span>
              <span>
                {content.split('\n').length} lines · {content.length.toLocaleString()} characters
              </span>
            </div>
            <textarea
              aria-label={`Edit ${selected.name}`}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setSaveState('dirty');
                setSaveMessage('');
              }}
              spellCheck="false"
            />
            {saveMessage && (
              <p
                className={cx('artifact-save-message', saveState === 'error' && 'is-error')}
                role={saveState === 'error' ? 'alert' : 'status'}
              >
                {saveMessage}
              </p>
            )}
            <button
              className="save-float"
              disabled={saveState !== 'dirty' && saveState !== 'error'}
              onClick={() => void saveRevision()}
            >
              <Icon name={saveState === 'error' ? 'retry' : 'check'} />
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'dirty' || saveState === 'error'
                  ? 'Save revision'
                  : 'Saved'}
            </button>
          </div>
        )}
        {tab === 'revisions' && (
          <div className="revision-view revision-view--folio">
            <div className="revision-timeline">
              <header>
                <span className="eyebrow">Immutable history</span>
                <strong>
                  {historyLoading
                    ? 'Loading…'
                    : `${history.length} saved ${history.length === 1 ? 'version' : 'versions'}`}
                </strong>
              </header>
              {[...history].reverse().map((revision, index) => (
                <button
                  className={selectedRevisionId === revision.id ? 'is-active' : ''}
                  onClick={() => void openRevision(revision)}
                  key={revision.id}
                >
                  <span>v{revision.revisionNumber}</span>
                  <div>
                    <strong>{revision.changeSummary}</strong>
                    <small>
                      {index === 0 ? 'Current · ' : ''}
                      {revision.createdAt
                        ? new Date(revision.createdAt).toLocaleString()
                        : 'Saved locally'}{' '}
                      · {cap(revision.authorKind)}
                    </small>
                  </div>
                </button>
              ))}
            </div>
            <div className="revision-inspector">
              {revisionError ? (
                <div className="artifact-inline-error" role="alert">
                  <Icon name="info" />
                  <span>{revisionError}</span>
                </div>
              ) : selectedRevisionId ? (
                <>
                  <header>
                    <div>
                      <span className="eyebrow">Read-only revision</span>
                      <h3>
                        {history.find((item) => item.id === selectedRevisionId)?.changeSummary ??
                          'Saved revision'}
                      </h3>
                    </div>
                    {selectedRevisionId !== selected.revisionId && (
                      <button
                        className="button"
                        onClick={() =>
                          void saveRevision(
                            revisionContent,
                            `Restored revision ${history.find((item) => item.id === selectedRevisionId)?.revisionNumber ?? ''}`,
                          )
                        }
                        disabled={draftPending}
                      >
                        <Icon name="history" /> Restore as new revision
                      </button>
                    )}
                  </header>
                  <div className="revision-preview">
                    <ArtifactPreview artifact={selected} content={revisionContent} />
                  </div>
                </>
              ) : (
                <div className="artifact-loading">
                  <span />
                  <p>Choose a saved revision to inspect it.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
      <FormDialog
        open={createOpen}
        eyebrow={`${activeProject.name} · new artifact`}
        title="Add to this project folio"
        description="Choose a useful starting shape. You can revise the content immediately after creation."
        submitLabel="Create artifact"
        pendingLabel="Creating…"
        pending={createPending}
        error={createError}
        onClose={() => setCreateOpen(false)}
        onSubmit={createArtifact}
      >
        <label>
          <span>Artifact name</span>
          <input
            autoFocus
            value={createName}
            maxLength={200}
            onChange={(event) => setCreateName(event.target.value)}
          />
        </label>
        <fieldset className="artifact-kind-picker">
          <legend>Starting format</legend>
          {artifactKinds.map((kind) => (
            <button
              type="button"
              className={createKind === kind.id ? 'is-active' : ''}
              onClick={() => chooseCreateKind(kind)}
              key={kind.id}
            >
              <Icon name={kind.icon} />
              <span>{kind.label}</span>
            </button>
          ))}
        </fieldset>
      </FormDialog>
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
  const [memoryNotice, setMemoryNotice] = useState('');
  const [memoryNoticeTone, setMemoryNoticeTone] = useState<'success' | 'error'>('success');
  const [undoForget, setUndoForget] = useState<MemoryRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState('');
  const [createBody, setCreateBody] = useState('');
  const [createKind, setCreateKind] = useState<'preference' | 'fact' | 'instruction' | 'decision'>(
    'preference',
  );
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState('');
  const [recordPending, setRecordPending] = useState<string | null>(null);
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
    setCreateKey('');
    setCreateBody('');
    setCreateKind('preference');
    setCreateError('');
    setCreateOpen(true);
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
        {records.length > 0 && (
          <div className="memory-master">
            <span>
              <strong>{records.filter((record) => record.enabled).length} available</strong>
              <small>{records.length} saved memories</small>
            </span>
          </div>
        )}
      </div>
      {records.length > 0 && (
        <div className="toolbar">
          <div className="search-field">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory"
              aria-label="Search memory"
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
      )}
      {memoryNotice && (
        <div
          className={cx('interaction-notice', memoryNoticeTone === 'error' && 'is-error')}
          role={memoryNoticeTone === 'error' ? 'alert' : 'status'}
        >
          <Icon name={memoryNoticeTone === 'error' ? 'info' : 'check'} size={15} />
          <p>{memoryNotice}</p>
          {undoForget && (
            <button
              className="text-button"
              disabled={recordPending === 'restore'}
              onClick={() => {
                void (async () => {
                  setRecordPending('restore');
                  try {
                    await workspace.remember({
                      key: undoForget.title,
                      content: undoForget.body,
                      kind: undoForget.type.toLowerCase(),
                    });
                    setRecords([undoForget, ...records]);
                    setUndoForget(null);
                    setMemoryNoticeTone('success');
                    setMemoryNotice('Memory restored as a new immutable revision.');
                  } catch (reason) {
                    setMemoryNoticeTone('error');
                    setMemoryNotice(
                      reason instanceof Error
                        ? reason.message
                        : 'The memory could not be restored.',
                    );
                  } finally {
                    setRecordPending(null);
                  }
                })();
              }}
            >
              {recordPending === 'restore' ? 'Restoring…' : 'Undo forget'}
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
                      setMemoryNoticeTone('error');
                      setMemoryNotice('Credential-shaped text was not saved to memory.');
                      return;
                    }
                    if (current.type === 'Instruction' || current.type === 'Fact') {
                      setPendingMemoryAction({ record: current, action: 'save' });
                      return;
                    }
                    setRecordPending(current.id);
                    void workspace
                      .updateMemory(current)
                      .then(() => {
                        setMemoryNoticeTone('success');
                        setMemoryNotice('Memory revision saved.');
                      })
                      .catch((reason) => {
                        setMemoryNoticeTone('error');
                        setMemoryNotice(
                          reason instanceof Error
                            ? reason.message
                            : 'The memory could not be saved.',
                        );
                      })
                      .finally(() => setRecordPending(null));
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
                  <strong>{selected.enabled ? 'Available' : 'Needs review'}</strong>
                  <small>
                    {selected.enabled
                      ? 'CupcakeAI can include this memory when relevant'
                      : 'This candidate is not used until you approve it'}
                  </small>
                </span>
                {selected.enabled ? (
                  <span className="memory-availability" aria-label="Memory is available">
                    <Icon name="check" size={15} /> Ready
                  </span>
                ) : (
                  <button
                    className="button"
                    disabled={recordPending === selected.id}
                    onClick={() => setPendingMemoryAction({ record: selected, action: 'enable' })}
                  >
                    Use this memory
                  </button>
                )}
              </div>
              <section className="memory-source">
                <h3>Source and history</h3>
                <div>
                  <Icon name="chat" />
                  <span>
                    <strong>{selected.source}</strong>
                    <small>Runtime provenance · revision history is preserved</small>
                  </span>
                </div>
              </section>
              <footer>
                <button
                  className="button"
                  disabled={recordPending === selected.id}
                  onClick={() => {
                    void (async () => {
                      const next = { ...selected, pinned: !selected.pinned };
                      setRecordPending(selected.id);
                      setMemoryNotice('');
                      try {
                        await workspace.updateMemory(next);
                        update(selected.id, { pinned: next.pinned });
                        setMemoryNoticeTone('success');
                        setMemoryNotice(
                          next.pinned
                            ? 'Memory pinned as a new immutable revision.'
                            : 'Memory unpinned as a new immutable revision.',
                        );
                      } catch (reason) {
                        setMemoryNoticeTone('error');
                        setMemoryNotice(
                          reason instanceof Error
                            ? reason.message
                            : 'The memory could not be updated.',
                        );
                      } finally {
                        setRecordPending(null);
                      }
                    })();
                  }}
                >
                  <Icon name="pin" />
                  {selected.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  className="button button--danger"
                  disabled={recordPending === selected.id}
                  onClick={() => {
                    void (async () => {
                      setRecordPending(selected.id);
                      setMemoryNotice('');
                      try {
                        await workspace.forgetMemory(selected);
                        setRecords(records.filter((m) => m.id !== selected.id));
                        setUndoForget(selected);
                        setMemoryNoticeTone('success');
                        setMemoryNotice(
                          'Memory forgotten. A tombstone preserves the audit history.',
                        );
                        setSelected(null);
                      } catch (reason) {
                        setMemoryNoticeTone('error');
                        setMemoryNotice(
                          reason instanceof Error
                            ? reason.message
                            : 'The memory could not be forgotten.',
                        );
                      } finally {
                        setRecordPending(null);
                      }
                    })();
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
                disabled={recordPending === pendingMemoryAction.record.id}
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
            {memoryNotice && memoryNoticeTone === 'error' && (
              <p className="form-dialog__error" role="alert">
                {memoryNotice}
              </p>
            )}
            <footer>
              <button
                className="button"
                onClick={() => setPendingMemoryAction(null)}
                disabled={recordPending === pendingMemoryAction.record.id}
              >
                Cancel
              </button>
              <span />
              <button
                className="button button--primary"
                disabled={recordPending === pendingMemoryAction.record.id}
                onClick={() => {
                  void (async () => {
                    const { record, action } = pendingMemoryAction;
                    setRecordPending(record.id);
                    setMemoryNotice('');
                    try {
                      if (action === 'enable') {
                        await workspace.setMemoryEnabled(record, true);
                        update(record.id, { enabled: true });
                      } else {
                        await workspace.updateMemory(record);
                      }
                      setMemoryNoticeTone('success');
                      setMemoryNotice('Memory choice saved with provenance.');
                      setPendingMemoryAction(null);
                    } catch (reason) {
                      setMemoryNoticeTone('error');
                      setMemoryNotice(
                        reason instanceof Error
                          ? reason.message
                          : 'The memory could not be updated.',
                      );
                    } finally {
                      setRecordPending(null);
                    }
                  })();
                }}
              >
                {recordPending === pendingMemoryAction.record.id ? 'Saving…' : 'Confirm'}
              </button>
            </footer>
          </section>
        </div>
      )}
      <FormDialog
        open={createOpen}
        eyebrow="Inspectable memory"
        title="Add a memory"
        description={
          workspace.activeProjectId
            ? 'This memory will stay with the active project. You can edit, pause, or forget it at any time.'
            : 'This memory will be available across your workspace. You can edit, pause, or forget it at any time.'
        }
        submitLabel="Save memory"
        pendingLabel="Saving memory…"
        pending={createPending}
        error={createError}
        onClose={() => {
          if (createPending) return;
          setCreateOpen(false);
          setCreateError('');
        }}
        onSubmit={async () => {
          const key = createKey.trim();
          const body = createBody.trim();
          if (!key) {
            setCreateError('Give this memory a short label.');
            return;
          }
          if (!body) {
            setCreateError('Enter what CupcakeAI should remember.');
            return;
          }
          if (looksLikeCredential(`${key}\n${body}`)) {
            setCreateError(
              'Credentials cannot be saved as memory. Store provider keys only through the encrypted provider setup flow.',
            );
            return;
          }
          setCreatePending(true);
          setCreateError('');
          try {
            await workspace.remember({ key, content: body, kind: createKind });
            if (workspace.fixtureMode) {
              setRecords([
                {
                  id: `preview-memory-${Date.now()}`,
                  type: cap(createKind) as MemoryRecord['type'],
                  title: key,
                  body,
                  scope: 'About me',
                  source: 'Preview memory',
                  confidence: 1,
                  enabled: true,
                },
                ...records,
              ]);
            }
            setCreateOpen(false);
            setMemoryNoticeTone('success');
            setMemoryNotice('Memory saved. You can inspect its scope and provenance here.');
          } catch (reason) {
            setCreateError(
              reason instanceof Error ? reason.message : 'The memory could not be saved.',
            );
          } finally {
            setCreatePending(false);
          }
        }}
      >
        <label>
          Label
          <input
            autoFocus
            value={createKey}
            onChange={(event) => setCreateKey(event.target.value)}
            placeholder="For example: Writing preference"
            maxLength={256}
          />
        </label>
        <label>
          Memory type
          <select
            value={createKind}
            onChange={(event) => setCreateKind(event.target.value as typeof createKind)}
          >
            <option value="preference">Preference</option>
            <option value="fact">Fact</option>
            <option value="instruction">Instruction</option>
            <option value="decision">Decision</option>
          </select>
        </label>
        <label>
          What should CupcakeAI remember?
          <textarea
            value={createBody}
            onChange={(event) => setCreateBody(event.target.value)}
            placeholder="Write the exact detail CupcakeAI should carry forward"
            rows={6}
          />
          <small>Provider keys and other credential-shaped text are blocked here.</small>
        </label>
      </FormDialog>
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

function providerDialogId(provider: string) {
  const ids: Record<string, string> = {
    OpenAI: 'openai',
    Anthropic: 'anthropic',
    Google: 'google',
    xAI: 'xai',
    Mistral: 'mistral',
    Cohere: 'cohere',
    'NVIDIA NIM': 'nvidia-nim',
    Groq: 'groq',
    OpenRouter: 'openrouter',
    'Cloudflare Workers AI': 'cloudflare',
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
  const stableModelsRef = useRef(models);
  if (models.length) stableModelsRef.current = models;
  const catalogModels = models.length ? models : stableModelsRef.current;
  const [modelQuery, setModelQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<ModelTask[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<ModelSize[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<Array<'cloud' | 'local'>>([]);
  const [publisherFilter, setPublisherFilter] = useState('all');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [includeCommunity, setIncludeCommunity] = useState(false);
  const [communityModels, setCommunityModels] = useState<ModelDescriptor[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [communityCursor, setCommunityCursor] = useState<string | undefined>();
  const [communityHasMore, setCommunityHasMore] = useState(false);
  const [catalogVisibleCount, setCatalogVisibleCount] = useState(12);
  const [pendingDownload, setPendingDownload] = useState<ModelDescriptor | null>(null);
  const [pendingRemove, setPendingRemove] = useState<ModelDescriptor | null>(null);
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
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
    if (!includeCommunity || modelQuery.trim().length < 2) {
      setCommunityModels([]);
      setCommunityCursor(undefined);
      setCommunityHasMore(false);
      setCommunityLoading(false);
      setCommunityError(null);
      return;
    }
    let active = true;
    setCommunityLoading(true);
    const timer = window.setTimeout(
      () => {
        void workspace
          .discoverCommunityModels(modelQuery, { limit: 36 })
          .then((page) => {
            if (!active) return;
            setCommunityModels(page.models);
            setCommunityCursor(page.nextCursor);
            setCommunityHasMore(page.hasMore);
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
  }, [includeCommunity, modelQuery, workspace.discoverCommunityModels]);

  useEffect(() => {
    setCatalogVisibleCount(12);
  }, [
    modelQuery,
    selectedTasks,
    selectedSizes,
    selectedLocations,
    publisherFilter,
    availableOnly,
    includeCommunity,
  ]);

  const rankedModels = useMemo(
    () =>
      [...catalogModels, ...communityModels]
        .filter((model) => model.status === 'community' || modelIsCurated(model))
        .map((model) => {
          const complete = completeModelDescriptor(model);
          return {
            ...complete,
            ...(complete.route === 'Local' ? deviceFit(complete, workspace.hardware) : {}),
          };
        })
        .sort((a, b) => {
          const priorityDifference = modelPriority(b) - modelPriority(a);
          if (priorityDifference) return priorityDifference;
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
    [catalogModels, communityModels, workspace.hardware],
  );
  const publishers = [...new Set(rankedModels.map(publisherForModel))].sort((a, b) =>
    a.localeCompare(b),
  );
  const filteredModels = rankedModels.filter((model) => {
    const publisher = publisherForModel(model);
    const searchable =
      `${model.provider} ${publisher} ${model.name} ${model.tags.join(' ')} ${model.parameters ?? ''} ${model.description}`.toLowerCase();
    const tasks = modelTasks(model);
    return (
      (selectedLocations.length === 0 ||
        selectedLocations.includes(model.route.toLowerCase() as 'cloud' | 'local')) &&
      (selectedTasks.length === 0 || selectedTasks.some((task) => tasks.includes(task))) &&
      (selectedSizes.length === 0 || selectedSizes.includes(modelSize(model))) &&
      (publisherFilter === 'all' || publisher === publisherFilter) &&
      (!availableOnly || modelIsAvailableInChat(model)) &&
      searchable.includes(modelQuery.trim().toLowerCase())
    );
  });
  const shown = filteredModels.slice(0, catalogVisibleCount);
  const selectedIntent = selectedTasks.length === 1 ? selectedTasks[0] : undefined;
  const recommendations = recommendModels(rankedModels, selectedIntent, 4);
  const selectedModel = rankedModels.find((model) => model.selected);
  const nimModels = catalogModels.filter(
    (model) => model.provider === 'NVIDIA NIM' && model.status !== 'setup' && modelIsCurated(model),
  );
  const nimConfigured = Boolean(workspace.providers['nvidia-nim']);
  const installedLocal = rankedModels.find(
    (model) =>
      model.route === 'Local' &&
      ['installed', 'ready', 'benchmarked', 'offline'].includes(model.status),
  );
  const automaticRamBudget = automaticRamBudgetGb(
    workspace.hardware,
    workspace.settings.reserveSystemRamGb,
  );
  const activeFilterCount = [
    selectedTasks.length > 0,
    selectedSizes.length > 0,
    selectedLocations.length > 0,
    publisherFilter !== 'all',
    availableOnly,
    includeCommunity,
  ].filter(Boolean).length;
  const clearAdvancedFilters = () => {
    setSelectedTasks([]);
    setSelectedSizes([]);
    setSelectedLocations([]);
    setPublisherFilter('all');
    setAvailableOnly(false);
    setIncludeCommunity(false);
  };
  const loadMoreCatalog = async () => {
    if (catalogVisibleCount < filteredModels.length) {
      setCatalogVisibleCount((count) => count + 12);
      return;
    }
    if (!includeCommunity || !communityHasMore || !communityCursor || communityLoading) return;
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const page = await workspace.discoverCommunityModels(modelQuery, {
        limit: 36,
        cursor: communityCursor,
      });
      setCommunityModels((current) => {
        const byId = new Map(current.map((model) => [model.id, model]));
        page.models.forEach((model) => byId.set(model.id, model));
        return [...byId.values()];
      });
      setCommunityCursor(page.nextCursor);
      setCommunityHasMore(page.hasMore);
      setCatalogVisibleCount((count) => count + 12);
    } catch (reason) {
      setCommunityError(
        reason instanceof Error
          ? reason.message
          : 'Hugging Face did not return the next page. Try again.',
      );
    } finally {
      setCommunityLoading(false);
    }
  };
  const toggleListValue = <T extends string>(
    value: T,
    selected: T[],
    setSelected: (items: T[]) => void,
  ) =>
    setSelected(
      selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
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
  const performSelection = async (model: ModelDescriptor) => {
    if (selectingId) return;
    setSelectionError(null);
    setSelectingId(model.id);
    try {
      const params = modelSelectionParams(model);
      await selectModel(params.modelId, { compatibilityConfirmed: params.compatibilityConfirmed });
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
          {model.fit === 'incompatible' ? 'Does not fit' : 'Install'}
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
      <section className="model-atlas-hero" aria-labelledby="model-atlas-title">
        <div className="model-atlas-hero__copy">
          <p className="eyebrow">Model atlas · your routes, mapped clearly</p>
          <h2 id="model-atlas-title">Models</h2>
          <p>
            Start with the work. Cupcake compares privacy, provider access, device fit, and cost,
            while keeping the wider model world close when you want it.
          </p>
          <div className="model-atlas-legend" aria-label="Model route legend">
            <span>
              <i className="model-atlas-legend__local" /> On this computer
            </span>
            <span>
              <i className="model-atlas-legend__cloud" /> Hosted provider
            </span>
            <span>
              <Icon name="check" size={12} /> Ready now
            </span>
          </div>
        </div>
        <div className="model-atlas-current">
          <span className="eyebrow">Current default</span>
          {selectedModel ? (
            <>
              <div>
                <PublisherLogo publisher={publisherForModel(selectedModel)} />
                <span>
                  <strong>{selectedModel.name}</strong>
                  <small>{modelRouteDescription(selectedModel)}</small>
                </span>
              </div>
              <p>{modelAvailabilityDetail(selectedModel)}</p>
            </>
          ) : (
            <p>Choose a ready model below. Cupcake will never switch routes silently.</p>
          )}
        </div>
        <div className="model-atlas-hero__actions">
          <button
            className="button"
            disabled={workspace.busy}
            onClick={() => void workspace.refresh(true)}
          >
            <Icon name="retry" />
            {workspace.busy ? 'Refreshing…' : 'Refresh catalog'}
          </button>
          <button className="button button--primary" onClick={() => openProvider('choose')}>
            <Icon name="plus" />
            Add provider
          </button>
        </div>
      </section>

      <section className="model-finder" aria-labelledby="model-finder-title">
        <header>
          <div>
            <span className="eyebrow">Choose an intent</span>
            <h3 id="model-finder-title">What are you making today?</h3>
          </div>
          {selectedTasks.length > 0 && (
            <button className="text-button" onClick={() => setSelectedTasks([])}>
              Show every task
            </button>
          )}
        </header>
        <div className="model-goal-grid">
          {MODEL_TASK_OPTIONS.map((option) => (
            <label
              className={selectedTasks.includes(option.id) ? 'is-checked' : ''}
              key={option.id}
            >
              <input
                type="checkbox"
                checked={selectedTasks.includes(option.id)}
                onChange={() => toggleListValue(option.id, selectedTasks, setSelectedTasks)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              <Icon name={selectedTasks.includes(option.id) ? 'check' : 'chevron'} size={14} />
            </label>
          ))}
        </div>
      </section>

      <section className="model-recommendations" aria-labelledby="model-recommendations-title">
        <header>
          <div>
            <span className="eyebrow">A useful starting set</span>
            <h3 id="model-recommendations-title">
              {selectedIntent
                ? `Recommended for ${MODEL_TASK_OPTIONS.find((item) => item.id === selectedIntent)?.label.toLowerCase()}`
                : 'Recommended across your routes'}
            </h3>
          </div>
          <p>Up to four choices, ranked by readiness, task fit, and this computer.</p>
        </header>
        <div className="model-recommendation-track">
          {recommendations.map((model) => {
            const publisher = publisherForModel(model);
            return (
              <article
                className={cx('model-recommendation', model.selected && 'is-selected')}
                key={model.id}
              >
                <header>
                  <PublisherLogo publisher={publisher} />
                  <span>
                    <small>
                      {publisher}
                      {publisher !== model.provider ? ` · via ${model.provider}` : ''}
                    </small>
                    <strong>{model.name}</strong>
                  </span>
                </header>
                <p>{recommendationReason(model, selectedIntent)}</p>
                <div>
                  <span>
                    <Icon name={model.route === 'Local' ? 'local' : 'cloud'} size={13} />{' '}
                    {modelRouteDescription(model)}
                  </span>
                  <span>
                    <Icon name="check" size={13} /> {modelAvailabilityDetail(model)}
                  </span>
                </div>
                <footer>{primaryAction(model)}</footer>
              </article>
            );
          })}
        </div>
      </section>

      <details className="model-system-details">
        <summary>
          <span>
            <Icon name="local" size={18} />
            <span>
              <strong>Local system & acceleration</strong>
              <small>
                {workspace.hardware?.gpu ?? 'Detecting GPU'} ·{' '}
                {workspace.settings.allowRamFallback ? 'RAM fallback allowed' : 'VRAM only'}
              </small>
            </span>
          </span>
          <span>
            Hardware, memory, and runtime packs <Icon name="chevron" size={14} />
          </span>
        </summary>
        <div className="model-system-details__body">
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
                {workspace.hardware?.availableVramBytes !== undefined && (
                  <span>{formatStorage(workspace.hardware.availableVramBytes)} VRAM free now</span>
                )}
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
                    ? workspace.settings.ramLimitMode === 'auto'
                      ? ` llama.cpp uses live available memory and currently allows up to ${automaticRamBudget?.toFixed(1) ?? 'a detected'} GB after the Windows reserve. The budget adapts whenever system memory changes.`
                      : ` llama.cpp offloads as many layers as fit in VRAM, then may use system RAM up to the manual ${workspace.settings.maxRamGb} GB safety ceiling.`
                    : ' Cupcake requests all accelerated layers in VRAM with automatic fitting disabled. A model that does not fit fails clearly instead of spilling into RAM.'}
                </span>
              </div>
            </div>
            <div className="hardware-meter">
              <span>
                <strong>
                  {workspace.hardware?.vramBytes
                    ? workspace.hardware.availableVramBytes !== undefined
                      ? formatStorage(workspace.hardware.availableVramBytes)
                      : formatStorage(workspace.hardware.vramBytes)
                    : '—'}
                </strong>{' '}
                {workspace.hardware?.availableVramBytes !== undefined
                  ? `free of ${formatStorage(workspace.hardware.vramBytes)}`
                  : 'detected VRAM'}
              </span>
              <div>
                <i
                  style={{
                    width:
                      workspace.hardware?.vramBytes &&
                      workspace.hardware?.availableVramBytes !== undefined
                        ? `${Math.min(100, Math.round((workspace.hardware.availableVramBytes / workspace.hardware.vramBytes) * 100))}%`
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
                The signed CPU baseline is always available. Optional GPU packs are verified and
                kept inside Cupcake—no third-party model server is required.
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
                              : cap(runtime.status?.replace('-', ' '), 'Available')}
                      </small>
                    </span>
                  </div>
                  <p>
                    {runtime.detail || 'Verified against the detected Windows hardware profile.'}
                  </p>
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
                        Install pack
                      </button>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          </section>
        </div>
      </details>

      <div className="toolbar model-toolbar">
        <label className="filter-field model-search-field">
          <span>Search the catalog</span>
          <div className="search-field">
            <Icon name="search" />
            <input
              aria-label="Find a model"
              placeholder="Search a model, company, or capability"
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
        <button
          type="button"
          className={cx('button model-filter-trigger', filterOpen && 'is-active')}
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((value) => !value)}
        >
          <Icon name="filter" /> Refine results
          {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
        </button>
      </div>
      <div className={cx('model-catalog-summary', communityError && 'is-error')} aria-live="polite">
        <span>
          <strong>{filteredModels.length}</strong> matching catalog entries
        </span>
        {nimModels.length > 0 ? (
          <span>
            <strong>{nimModels.length}</strong> curated NVIDIA NIM routes available
          </span>
        ) : nimConfigured ? (
          <span>NVIDIA NIM connected · refresh the catalog to check current routes</span>
        ) : (
          <span>
            <strong>0</strong> curated NVIDIA NIM routes available
          </span>
        )}
        {includeCommunity && (
          <span>
            <strong>
              {communityLoading && !communityModels.length ? '…' : communityModels.length}
            </strong>{' '}
            Hugging Face cards loaded{communityHasMore ? ' · more available' : ''}
          </span>
        )}
        {communityError && <span>{communityError}</span>}
      </div>
      {filterOpen && (
        <section className="model-filter-panel" aria-label="Model filters">
          <header>
            <div>
              <span className="eyebrow">Plain-language choices</span>
              <h3>Refine the catalog</h3>
            </div>
            <button type="button" className="text-button" onClick={clearAdvancedFilters}>
              Reset all
            </button>
          </header>
          <div className="model-filter-groups">
            <fieldset>
              <legend>Where should it run?</legend>
              {(['cloud', 'local'] as const).map((location) => (
                <label key={location}>
                  <input
                    type="checkbox"
                    checked={selectedLocations.includes(location)}
                    onChange={() =>
                      toggleListValue(location, selectedLocations, setSelectedLocations)
                    }
                  />
                  <span>
                    {location === 'local' ? 'On this computer · private' : 'Cloud provider'}
                  </span>
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={(event) => setAvailableOnly(event.target.checked)}
                />
                <span>Ready to use now</span>
              </label>
            </fieldset>
            <fieldset>
              <legend>How large a model?</legend>
              {MODEL_SIZE_OPTIONS.map((option) => (
                <label key={option.id} title={option.detail}>
                  <input
                    type="checkbox"
                    checked={selectedSizes.includes(option.id)}
                    onChange={() => toggleListValue(option.id, selectedSizes, setSelectedSizes)}
                  />
                  <span>
                    {option.label}
                    <small>{option.detail}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Source</legend>
              <label className="model-filter-select">
                <span>Releasing company</span>
                <select
                  value={publisherFilter}
                  onChange={(event) => setPublisherFilter(event.target.value)}
                >
                  <option value="all">Every curated company</option>
                  {publishers.map((publisher) => (
                    <option value={publisher} key={publisher}>
                      {publisher}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeCommunity}
                  onChange={(event) => setIncludeCommunity(event.target.checked)}
                />
                <span>
                  Search Hugging Face too
                  <small>Only runs after you type at least two characters</small>
                </span>
              </label>
            </fieldset>
          </div>
        </section>
      )}

      {(selectionError || actionError) && (
        <p className="field-error model-page-error" role="alert">
          {selectionError ?? actionError}
        </p>
      )}
      {shown.length ? (
        <>
          <div className="model-grid">
            {shown.map((model) => {
              const publisher = publisherForModel(model);
              const profile = curatedProfileForModel(model);
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
                    <PublisherLogo publisher={publisher} />
                    <div>
                      <span>
                        {publisher}
                        {publisher !== model.provider ? ` · via ${model.provider}` : ''}
                      </span>
                      <h3>{model.name}</h3>
                    </div>
                    <RouteBadge route={model.route} />
                  </header>
                  <p>{model.description}</p>
                  <div className="model-evidence-row">
                    {profile && (
                      <span>
                        <Icon name="sparkle" size={12} /> Best for{' '}
                        {profile.tasks
                          .slice(0, 3)
                          .map((task) => cap(task))
                          .join(', ')}
                      </span>
                    )}
                    <span>
                      <Icon name="model" size={12} /> {cap(modelSize(model))} tier
                    </span>
                    {model.provider === 'NVIDIA NIM' && (
                      <span>
                        <Icon
                          name={modelWasOperationallyTested(model) ? 'check' : 'cloud'}
                          size={12}
                        />
                        {modelWasOperationallyTested(model)
                          ? 'Endpoint smoke-tested · Sep 3'
                          : 'Served via NVIDIA NIM'}
                      </span>
                    )}
                  </div>
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
                      <dt>Size tier</dt>
                      <dd>{cap(modelSize(model))}</dd>
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
                      {['ready', 'benchmarked'].includes(model.status) &&
                        model.route === 'Local' && (
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
          {(shown.length < filteredModels.length || communityHasMore) && (
            <div className="model-catalog-more">
              <span>
                Showing {shown.length} of {filteredModels.length} loaded matches
                {communityHasMore ? ' · Hugging Face has another page' : ''}
              </span>
              <button
                className="button"
                disabled={communityLoading}
                onClick={() => void loadMoreCatalog()}
              >
                {communityLoading
                  ? 'Loading more…'
                  : shown.length < filteredModels.length
                    ? 'Show more results'
                    : 'Load more from Hugging Face'}
              </button>
            </div>
          )}
        </>
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
              setModelQuery('');
              clearAdvancedFilters();
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
                <h2 id="model-install-title">Install {pendingDownload.name}</h2>
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
                Install model
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
  const [mcpPending, setMcpPending] = useState(false);
  const [toolQuery, setToolQuery] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [freedomPhrase, setFreedomPhrase] = useState('');
  const [policyPending, setPolicyPending] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const [pendingToolAction, setPendingToolAction] = useState<string | null>(null);
  const [toolNotice, setToolNotice] = useState<{
    tone: 'pending' | 'success' | 'error';
    text: string;
  } | null>(null);
  const shown = tools.filter(
    (tool) =>
      (tab === 'all' || tool.kind === tab) &&
      `${tool.name} ${tool.provider} ${tool.description}`
        .toLowerCase()
        .includes(toolQuery.trim().toLowerCase()),
  );
  const toggle = async (id: string) => {
    const tool = tools.find((item) => item.id === id);
    if (!tool) return;
    const nextEnabled = !tool.enabled;
    setPendingToolAction(`toggle:${id}`);
    setToolNotice({
      tone: 'pending',
      text: `${nextEnabled ? 'Enabling' : 'Disabling'} ${tool.name}…`,
    });
    try {
      await workspace.setToolEnabled(id, nextEnabled);
      setTools(tools.map((item) => (item.id === id ? { ...item, enabled: nextEnabled } : item)));
      setToolNotice({
        tone: 'success',
        text: `${tool.name} is ${nextEnabled ? 'enabled' : 'disabled'}.`,
      });
    } catch (reason) {
      setToolNotice({
        tone: 'error',
        text: reason instanceof Error ? reason.message : `${tool.name} could not be updated.`,
      });
    } finally {
      setPendingToolAction(null);
    }
  };
  const connectMcp = async () => {
    if (!mcpName.trim() || !mcpEndpoint.trim()) {
      setMcpError('Name and destination are required.');
      return;
    }
    if (mcpTransport === 'streamable-http' && !mcpEndpoint.startsWith('https://')) {
      setMcpError('Remote MCP requires an HTTPS origin.');
      return;
    }
    setMcpPending(true);
    setMcpError('');
    try {
      await workspace.connectMcp({
        name: mcpName.trim(),
        transport: mcpTransport,
        endpoint: mcpEndpoint.trim(),
      });
      const connectedName = mcpName.trim();
      setMcpOpen(false);
      setMcpName('');
      setMcpEndpoint('');
      setToolNotice({ tone: 'success', text: `${connectedName} connected.` });
    } catch (reason) {
      setMcpError(
        reason instanceof Error ? reason.message : 'The MCP server could not be connected.',
      );
    } finally {
      setMcpPending(false);
    }
  };
  const inspectTool = async (tool: ToolDescriptor) => {
    setPendingToolAction(`inspect:${tool.id}`);
    setToolNotice({ tone: 'pending', text: `Inspecting ${tool.name} access…` });
    try {
      await workspace.preflightTool(tool);
      setToolNotice({
        tone: 'success',
        text: `${tool.name} access details were added to broker audit activity.`,
      });
    } catch (reason) {
      setToolNotice({
        tone: 'error',
        text:
          reason instanceof Error ? reason.message : `${tool.name} access could not be inspected.`,
      });
    } finally {
      setPendingToolAction(null);
    }
  };
  const disconnectTool = async (tool: ToolDescriptor) => {
    setPendingToolAction(`disconnect:${tool.id}`);
    setToolNotice({ tone: 'pending', text: `Disconnecting ${tool.name}…` });
    try {
      await workspace.disconnectMcp(tool.id);
      setTools(tools.filter((item) => item.id !== tool.id));
      setToolNotice({ tone: 'success', text: `${tool.name} disconnected.` });
    } catch (reason) {
      setToolNotice({
        tone: 'error',
        text: reason instanceof Error ? reason.message : `${tool.name} could not be disconnected.`,
      });
    } finally {
      setPendingToolAction(null);
    }
  };
  const changePolicy = async (mode: 'guarded' | 'full-freedom') => {
    if (mode === 'full-freedom' && freedomPhrase !== 'FULL FREEDOM') {
      setPolicyError('Type FULL FREEDOM exactly to enable this policy.');
      return;
    }
    setPolicyPending(true);
    setPolicyError('');
    try {
      await workspace.updateSettings({ permissionMode: mode });
      setFreedomPhrase('');
      setToolNotice({
        tone: 'success',
        text:
          mode === 'guarded' ? 'Guarded permission policy is active.' : 'Full freedom is active.',
      });
    } catch (reason) {
      setPolicyError(
        reason instanceof Error ? reason.message : 'The permission policy could not be updated.',
      );
    } finally {
      setPolicyPending(false);
    }
  };
  return (
    <main className="page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Capabilities with boundaries</p>
          <h2>Tools</h2>
          <p>Cupcake chooses tools naturally in chat. You decide what each one can reach.</p>
        </div>
        <button
          className="button button--primary"
          onClick={() => {
            setMcpError('');
            setMcpOpen(true);
          }}
        >
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
        <button
          className="text-button"
          onClick={() => {
            setPolicyError('');
            setFreedomPhrase('');
            setPolicyOpen(true);
          }}
        >
          Permission policy <Icon name="chevron" />
        </button>
      </div>
      {toolNotice && (
        <div
          className={cx('interaction-notice', `is-${toolNotice.tone}`)}
          role={toolNotice.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {toolNotice.tone === 'pending' ? (
            <span className="pulse-dot" aria-hidden="true" />
          ) : (
            <Icon name={toolNotice.tone === 'error' ? 'info' : 'check'} size={15} />
          )}
          <p>{toolNotice.text}</p>
        </div>
      )}
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
          <article
            className={cx('registry-card', !tool.enabled && 'is-disabled')}
            key={tool.id}
            aria-busy={pendingToolAction?.endsWith(`:${tool.id}`)}
          >
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
                onChange={() => {
                  void toggle(tool.id);
                }}
                label={`Enable ${tool.name}`}
                disabled={pendingToolAction !== null}
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
              <button
                disabled={pendingToolAction !== null}
                onClick={() => {
                  void inspectTool(tool);
                }}
              >
                {pendingToolAction === `inspect:${tool.id}` ? 'Inspecting…' : 'Inspect access'}{' '}
                <Icon name="chevron" />
              </button>
              {tool.kind === 'mcp' && (
                <button
                  className="text-button"
                  disabled={pendingToolAction !== null}
                  onClick={() => {
                    void disconnectTool(tool);
                  }}
                >
                  {pendingToolAction === `disconnect:${tool.id}` ? 'Disconnecting…' : 'Disconnect'}
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
      <FormDialog
        open={policyOpen}
        eyebrow="Tool authority"
        title="Permission policy"
        description="Choose how CupcakeAI handles tool actions with external or system effects."
        submitLabel="Done"
        pendingLabel="Saving policy…"
        pending={policyPending}
        error={policyError}
        onClose={() => setPolicyOpen(false)}
        onSubmit={() => setPolicyOpen(false)}
      >
        <div className="permission-mode-list">
          <button
            type="button"
            disabled={policyPending}
            className={cx(workspace.settings.permissionMode === 'guarded' && 'is-active')}
            onClick={() => {
              void changePolicy('guarded');
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
                type="button"
                className="button"
                disabled={policyPending}
                onClick={() => {
                  void changePolicy('guarded');
                }}
              >
                {policyPending ? 'Saving…' : 'Return to guarded'}
              </button>
            ) : (
              <>
                <label>
                  <span>Type FULL FREEDOM to enable</span>
                  <input
                    value={freedomPhrase}
                    onChange={(event) => setFreedomPhrase(event.target.value)}
                    autoComplete="off"
                    disabled={policyPending}
                  />
                </label>
                <button
                  type="button"
                  className="button button--danger"
                  disabled={freedomPhrase !== 'FULL FREEDOM' || policyPending}
                  onClick={() => {
                    void changePolicy('full-freedom');
                  }}
                >
                  {policyPending ? 'Saving…' : 'Enable full freedom'}
                </button>
              </>
            )}
          </div>
        </div>
        <p className="field-hint">
          Changes apply at the local Rust tool broker and are recorded in its security store.
        </p>
      </FormDialog>
      <FormDialog
        open={mcpOpen}
        eyebrow="Isolated MCP session"
        title="Connect MCP server"
        description="Review the destination before CupcakeAI asks the broker to create an isolated connection."
        submitLabel="Review and connect"
        pendingLabel="Connecting…"
        pending={mcpPending}
        error={mcpError}
        onClose={() => setMcpOpen(false)}
        onSubmit={connectMcp}
      >
        <label>
          Connection name
          <input
            autoFocus
            value={mcpName}
            onChange={(event) => setMcpName(event.target.value)}
            disabled={mcpPending}
          />
        </label>
        <label>
          Transport
          <select
            value={mcpTransport}
            disabled={mcpPending}
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
              disabled={mcpPending}
            />
          </label>
        ) : (
          <label>
            Registered manifest
            <select
              value={mcpEndpoint}
              onChange={(event) => setMcpEndpoint(event.target.value)}
              disabled={mcpPending}
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
              approval are enforced by the broker. A changed fingerprint invalidates prior grants.
            </p>
          </div>
        </div>
      </FormDialog>
    </main>
  );
}

function SearchView({ setView }: { setView: (v: View) => void }) {
  const workspace = useWorkspace();
  const [query, setQuery] = useState(workspace.fixtureMode ? 'architecture' : '');
  const [loading, setLoading] = useState(false);
  const [globalScope, setGlobalScope] = useState(!workspace.activeProjectId);
  const [searchError, setSearchError] = useState('');
  const searchSequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const doSearch = (v: string) => {
    setQuery(v);
    setLoading(true);
    setSearchError('');
    const sequence = ++searchSequence.current;
    void workspace
      .querySearch(v, globalScope)
      .catch((reason: unknown) => {
        if (sequence === searchSequence.current)
          setSearchError(
            reason instanceof Error ? reason.message : 'Search could not finish. Try again.',
          );
      })
      .finally(() => {
        if (sequence === searchSequence.current) setLoading(false);
      });
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
  const groups: Array<{
    title: string;
    icon: string;
    items: Array<{
      id?: string;
      projectId?: string | null;
      title: string;
      text: string;
      meta: string;
    }>;
  }> = workspace.fixtureMode
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
          id: item.id,
          projectId: item.projectId,
          title: item.title,
          text: item.snippet.replace(/<\/?mark>/g, ''),
          meta: item.projectId
            ? (workspace.projects.find((project) => project.id === item.projectId)?.name ??
              'Project result')
            : 'Personal workspace',
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
            aria-label="Search workspace"
            placeholder="Search chats, files, projects, memory, tasks…"
          />
          {query && (
            <button className="icon-button" aria-label="Clear search" onClick={() => doSearch('')}>
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
        <div className="search-scopes">
          <button
            className={!globalScope ? 'is-active' : ''}
            disabled={!workspace.activeProjectId}
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
      {searchError && (
        <p className="field-error" role="alert">
          {searchError}
        </p>
      )}
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
            <span>Matches from your saved workspace</span>
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
                  onClick={() => {
                    const kind = group.title.toLowerCase();
                    const destination: View = kind.includes('artifact')
                      ? 'artifacts'
                      : kind.includes('memory')
                        ? 'memory'
                        : kind.includes('task')
                          ? 'tasks'
                          : kind.includes('project') || kind.includes('file')
                            ? 'projects'
                            : 'chat';
                    void (async () => {
                      try {
                        if (item.projectId && item.projectId !== workspace.activeProjectId)
                          await workspace.setActiveProject(item.projectId);
                        if (!alive.current) return;
                        if (destination === 'chat' && item.id)
                          await workspace.selectConversation(item.id);
                        if (!alive.current) return;
                        if (destination === 'artifacts' && item.id)
                          sessionStorage.setItem('cupcake-open-artifact', item.id);
                        setView(destination);
                      } catch (reason) {
                        if (alive.current)
                          setSearchError(
                            reason instanceof Error
                              ? reason.message
                              : 'Could not open this result.',
                          );
                      }
                    })();
                  }}
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

function ProviderLogo({ id, name, className }: { id: string; name: string; className?: string }) {
  const compatibleMarks: Record<string, string> = {
    groq: 'GQ',
    openrouter: 'OR',
    cloudflare: 'CF',
  };
  if (id === 'openai-compatible' || compatibleMarks[id]) {
    return (
      <span
        className={cx('provider-logo provider-logo--generic', className)}
        aria-label={`${name} mark`}
      >
        {compatibleMarks[id] ?? <Icon name="cloud" size={18} />}
      </span>
    );
  }
  const asset = id === 'xai' ? '/providers/xai.webp' : `/providers/${id}.svg`;
  return (
    <span
      className={cx(
        'provider-logo',
        (id === 'openai' || id === 'xai') && 'provider-logo--dark-surface',
        className,
      )}
    >
      <img src={asset} alt={`${name} logo`} />
    </span>
  );
}

function PublisherLogo({ publisher, className }: { publisher: string; className?: string }) {
  const asset = publisherLogoAsset(publisher);
  return (
    <span
      className={cx(
        'provider-logo',
        !asset && 'provider-logo--publisher-monogram',
        (asset?.includes('/openai.') || asset?.includes('/xai.')) && 'provider-logo--dark-surface',
        className,
      )}
      title={publisher}
    >
      {asset ? (
        <img src={asset} alt={`${publisher} logo`} />
      ) : (
        <span aria-label={`${publisher} mark`}>{publisherMonogram(publisher)}</span>
      )}
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
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [backupError, setBackupError] = useState('');
  const createBackup = async () => {
    setBackupBusy(true);
    setBackupMessage('');
    setBackupError('');
    try {
      const receipt = await workspace.createBackup();
      if (receipt)
        setBackupMessage(
          `Saved ${receipt.fileName} · ${(receipt.byteSize / 1024 / 1024).toFixed(1)} MB · encrypted and verified. Restore on this Windows account on this computer.`,
        );
    } catch (reason) {
      setBackupError(
        reason instanceof Error ? reason.message : 'The backup could not be completed.',
      );
    } finally {
      setBackupBusy(false);
    }
  };
  const [currentWorkspacePassword, setCurrentWorkspacePassword] = useState('');
  const [newWorkspacePassword, setNewWorkspacePassword] = useState('');
  const [confirmWorkspacePassword, setConfirmWorkspacePassword] = useState('');
  const [workspacePasswordBusy, setWorkspacePasswordBusy] = useState(false);
  const [workspacePasswordMessage, setWorkspacePasswordMessage] = useState('');
  const workspaceSecurityApi = window.cupcake?.workspace;
  const [workspaceSecurity, setWorkspaceSecurity] = useState<WorkspaceLockStatus | null>(
    workspaceSecurityApi ? null : { state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 },
  );
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
    ['Groq', 'groq'],
    ['OpenRouter', 'openrouter'],
    ['Cloudflare Workers AI', 'cloudflare'],
    ['Remote OpenAI-compatible', 'openai-compatible'],
  ] as const;
  const semanticModels = workspace.models.filter(
    (model) =>
      model.provider === 'NVIDIA NIM' && model.tags.some((tag) => /embed|rerank/i.test(tag)),
  );
  const workspaceLockEnabled = workspaceSecurity?.unlockMode === 'password';
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
  useEffect(() => {
    if (!workspaceSecurityApi) return;
    let active = true;
    void workspaceSecurityApi
      .status()
      .then((status) => active && setWorkspaceSecurity(status))
      .catch((error: unknown) => active && setWorkspacePasswordMessage(hostErrorMessage(error)));
    const release = workspaceSecurityApi.onStatus((status) => {
      if (active) setWorkspaceSecurity(status);
    });
    return () => {
      active = false;
      release();
    };
  }, [workspaceSecurityApi]);
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
            <header className="settings-subheading">
              <h2>Workspace wallpaper</h2>
              <p>The artwork stays vivid while chat surfaces and text adapt to its palette.</p>
            </header>
            <div className="wallpaper-grid">
              {WORKSPACE_WALLPAPERS.map(([value, label, palette]) => (
                <button
                  type="button"
                  className={workspace.settings.wallpaper === value ? 'is-active' : ''}
                  onClick={() => void workspace.updateSettings({ wallpaper: value })}
                  key={value}
                >
                  <span
                    className={cx('wallpaper-sample', value === 'none' && 'is-none')}
                    style={
                      value === 'none'
                        ? undefined
                        : { backgroundImage: `url(/wallpapers/${value}.webp)` }
                    }
                  />
                  <span className="wallpaper-label">
                    <strong>{label}</strong>
                    <small>{palette}</small>
                  </span>
                  {workspace.settings.wallpaper === value && <Icon name="check" size={14} />}
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
                <p>This information personalizes the app and stays in this local workspace.</p>
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
                <strong>RAM safety limit</strong>
                <small>
                  Auto follows live available memory and always leaves your Windows reserve free.
                </small>
              </span>
              <div className="ram-limit-control">
                <div className="segmented-control" aria-label="RAM safety limit mode">
                  {(['auto', 'manual'] as const).map((mode) => (
                    <button
                      type="button"
                      className={workspace.settings.ramLimitMode === mode ? 'is-active' : ''}
                      aria-pressed={workspace.settings.ramLimitMode === mode}
                      onClick={() => void workspace.updateSettings({ ramLimitMode: mode })}
                      disabled={!workspace.settings.allowRamFallback}
                      key={mode}
                    >
                      {mode === 'auto' ? 'Auto' : 'Manual'}
                    </button>
                  ))}
                </div>
                {workspace.settings.ramLimitMode === 'auto' ? (
                  <span className="auto-memory-budget">
                    {(() => {
                      const budget = automaticRamBudgetGb(
                        workspace.hardware,
                        workspace.settings.reserveSystemRamGb,
                      );
                      return budget === null ? 'Detecting…' : `Up to ${budget} GB now`;
                    })()}
                  </span>
                ) : (
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
                )}
              </div>
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
                <h2>Optional workspace lock</h2>
                <p>
                  CupcakeAI opens normally without a password. Turn this on only if you want one.
                </p>
              </header>
              <div className={cx('workspace-lock-status', workspaceLockEnabled && 'is-enabled')}>
                <span className="workspace-lock-status__mark">
                  <Icon name={workspaceLockEnabled ? 'shield' : 'sparkle'} />
                </span>
                <span>
                  <strong>
                    {workspaceLockEnabled ? 'Workspace lock is on' : 'Workspace lock is off'}
                  </strong>
                  <small>
                    {workspaceLockEnabled
                      ? 'CupcakeAI will ask for this password the next time the app starts.'
                      : 'The app opens directly. No password or security setup is required.'}
                  </small>
                </span>
                <em>{workspaceLockEnabled ? 'On' : 'Off by default'}</em>
              </div>
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
                  const request = workspaceLockEnabled
                    ? window.cupcake?.workspace.changePassword(
                        currentWorkspacePassword,
                        newWorkspacePassword,
                      )
                    : window.cupcake?.workspace.setup(newWorkspacePassword);
                  void request
                    ?.then((status) => {
                      setWorkspaceSecurity(status);
                      setCurrentWorkspacePassword('');
                      setNewWorkspacePassword('');
                      setConfirmWorkspacePassword('');
                      setWorkspacePasswordMessage(
                        workspaceLockEnabled
                          ? 'Workspace lock password changed.'
                          : 'Workspace lock enabled. It will be required next launch.',
                      );
                    })
                    .catch((error: unknown) => setWorkspacePasswordMessage(hostErrorMessage(error)))
                    .finally(() => setWorkspacePasswordBusy(false));
                }}
              >
                {workspaceLockEnabled && (
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
                )}
                <label>
                  {workspaceLockEnabled ? 'New password' : 'Create password'}
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
                      !workspacePasswordMessage.startsWith('Workspace lock') && 'field-error',
                    )}
                    role="status"
                  >
                    {workspacePasswordMessage}
                  </p>
                )}
                <div className="workspace-password-form__actions">
                  <button className="button button--primary" disabled={workspacePasswordBusy}>
                    {workspacePasswordBusy
                      ? workspaceLockEnabled
                        ? 'Changing…'
                        : 'Enabling…'
                      : workspaceLockEnabled
                        ? 'Change password'
                        : 'Enable workspace lock'}
                  </button>
                  {workspaceLockEnabled && (
                    <>
                      <button
                        className="button"
                        type="button"
                        disabled={workspacePasswordBusy || !currentWorkspacePassword}
                        onClick={() => {
                          setWorkspacePasswordBusy(true);
                          setWorkspacePasswordMessage('');
                          void window.cupcake?.workspace
                            .disableProtection(currentWorkspacePassword)
                            .then((status) => {
                              setWorkspaceSecurity(status);
                              setCurrentWorkspacePassword('');
                              setNewWorkspacePassword('');
                              setConfirmWorkspacePassword('');
                              setWorkspacePasswordMessage(
                                'Workspace lock disabled. CupcakeAI will open directly.',
                              );
                            })
                            .catch((error: unknown) =>
                              setWorkspacePasswordMessage(hostErrorMessage(error)),
                            )
                            .finally(() => setWorkspacePasswordBusy(false));
                        }}
                      >
                        Turn off password prompt
                      </button>
                      <button
                        className="button"
                        type="button"
                        onClick={() => void window.cupcake?.workspace.lock()}
                      >
                        <Icon name="shield" /> Lock now
                      </button>
                    </>
                  )}
                </div>
              </form>
              <div className="security-note">
                <Icon name="info" />
                <div>
                  <strong>The password prompt and content encryption are separate choices</strong>
                  <p>
                    Turning off the prompt returns CupcakeAI to direct opening. Manage stored
                    content using the encryption controls below. Provider keys stay protected by
                    Windows.
                  </p>
                </div>
              </div>
            </section>
            <ContentProtectionSettings
              fixtureMode={workspace.fixtureMode}
              onUpdated={() => workspace.refresh()}
            />
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
              <p>
                Your workspace stays on this computer. Manage content protection in Privacy
                settings.
              </p>
            </header>
            <div className="setting-row">
              <span>
                <strong>Backups</strong>
                <small>
                  Create an encrypted copy for recovery on this Windows account and computer.
                </small>
              </span>
              <button className="button" disabled={backupBusy} onClick={() => void createBackup()}>
                {backupBusy ? 'Creating and verifying…' : 'Back up now'}
              </button>
            </div>
            {backupMessage && (
              <p className="field-message" role="status">
                {backupMessage}
              </p>
            )}
            {backupError && (
              <p className="field-error" role="alert">
                {backupError}
              </p>
            )}
            <BackupRecoverySettings
              fixtureMode={workspace.fixtureMode}
              onVerify={() => workspace.verifyBackupForRecovery()}
            />
            <div className="setting-row">
              <span>
                <strong>Import your original CupcakeAI workspace</strong>
                <small>
                  Review conversations, memories and paused tasks before importing. Provider keys
                  and executable code are excluded.
                </small>
              </span>
              <button className="button" onClick={() => void workspace.chooseLegacySource()}>
                Import original workspace
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
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [intent, setIntent] = useState<ModelTask | undefined>();
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const stableModelsRef = useRef(models);
  if (models.length) stableModelsRef.current = models;
  const pickerModels = models.length ? models : stableModelsRef.current;
  useModalFocusTrap(open, pickerRef, close);
  if (!open) return null;
  const search = query.trim().toLowerCase();
  const searched = recommendModels(pickerModels, intent, Number.MAX_SAFE_INTEGER).filter(
    (model) => {
      const publisher = publisherForModel(model);
      return `${model.name} ${model.provider} ${publisher} ${model.tags.join(' ')} ${model.description}`
        .toLowerCase()
        .includes(search);
    },
  );
  const shown = searched.filter((model) => showUnavailable || modelIsAvailableInChat(model));
  const grouped = new Map<string, ModelDescriptor[]>();
  shown.forEach((model) => {
    const publisher = publisherForModel(model);
    grouped.set(publisher, [...(grouped.get(publisher) ?? []), model]);
  });
  const groups = [...grouped.entries()];
  const hiddenUnavailable = searched.length - shown.length;
  const currentModel = pickerModels.find((model) => model.selected);
  const selectFromPicker = async (model: ModelDescriptor) => {
    if (selectingId) return;
    setSelectionError(null);
    setSelectingId(model.id);
    try {
      const params = modelSelectionParams(model);
      await select(params.modelId, {
        compatibilityConfirmed: params.compatibilityConfirmed,
      });
      close();
    } catch (reason) {
      setSelectionError(
        reason instanceof Error ? reason.message : 'Cupcake could not select this model.',
      );
    } finally {
      setSelectingId(null);
    }
  };
  return (
    <div
      className="popover-layer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={pickerRef}
        className="model-picker model-picker--atlas"
        role="dialog"
        aria-modal="true"
        aria-label="Choose model"
      >
        <header>
          <div>
            <span className="eyebrow">One conversation, one clear route</span>
            <h2>Choose a model</h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close model picker">
            <Icon name="x" />
          </button>
        </header>
        {currentModel ? (
          <div
            className={cx(
              'model-picker__current',
              !modelIsAvailableInChat(currentModel) && 'is-unavailable',
            )}
          >
            <PublisherLogo publisher={publisherForModel(currentModel)} />
            <span>
              <small>
                {modelIsAvailableInChat(currentModel)
                  ? 'Current model'
                  : 'Current model unavailable'}
              </small>
              <strong>{currentModel.name}</strong>
              <em>
                {modelIsAvailableInChat(currentModel)
                  ? modelRouteDescription(currentModel)
                  : modelAvailabilityDetail(currentModel)}
              </em>
            </span>
            <Icon name={modelIsAvailableInChat(currentModel) ? 'check' : 'info'} />
          </div>
        ) : (
          <div className="model-picker__current is-unavailable" role="status">
            <Icon name="model" />
            <span>
              <small>No current model</small>
              <strong>Choose a ready route</strong>
              <em>Cupcake will not select a provider or model for you.</em>
            </span>
          </div>
        )}
        <div className="model-picker__intents" aria-label="Filter by task">
          <button className={!intent ? 'is-active' : ''} onClick={() => setIntent(undefined)}>
            Any task
          </button>
          {MODEL_TASK_OPTIONS.map((option) => (
            <button
              className={intent === option.id ? 'is-active' : ''}
              onClick={() => setIntent(option.id)}
              key={option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="model-picker__tools">
          <div className="search-field">
            <Icon name="search" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search model, publisher, or route"
            />
          </div>
          <label>
            <input
              type="checkbox"
              checked={showUnavailable}
              onChange={(event) => setShowUnavailable(event.target.checked)}
            />
            <span>Show unavailable</span>
          </label>
        </div>
        <div className="model-picker__list">
          {groups.map(([publisher, publisherModels]) => (
            <section
              className="model-picker__group"
              aria-labelledby={`publisher-${publisher}`}
              key={publisher}
            >
              <header>
                <strong id={`publisher-${publisher}`}>{publisher}</strong>
                <span>{publisherModels.length}</span>
              </header>
              {publisherModels.map((model) => {
                const available = modelIsAvailableInChat(model);
                return (
                  <button
                    className={model.selected ? 'is-active' : ''}
                    disabled={selectingId !== null || !available}
                    onClick={() => void selectFromPicker(model)}
                    key={model.id}
                  >
                    <PublisherLogo publisher={publisher} />
                    <span>
                      <strong>{model.name}</strong>
                      <small>
                        {modelRouteDescription(model)} · {model.context} context
                      </small>
                      <small className={available ? 'model-ready-copy' : 'unavailable'}>
                        {modelAvailabilityDetail(model)} · {model.cost}
                      </small>
                      <span className="model-tags">
                        {model.tags.slice(0, 3).map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                    </span>
                    <RouteBadge route={model.route} />
                    {selectingId === model.id ? (
                      <small>Selecting…</small>
                    ) : model.selected ? (
                      <Icon name="check" />
                    ) : !available ? (
                      <small className="unavailable">{modelStatusLabel(model.status)}</small>
                    ) : null}
                  </button>
                );
              })}
            </section>
          ))}
          {!groups.length && (
            <div className="model-picker__empty">
              <Icon name="search" />
              <strong>No available models match</strong>
              <small>
                {models.length === 0 && !pickerModels.length
                  ? 'No model routes are loaded yet. Open Models to connect or install one.'
                  : 'Try another task, connect a provider, or show unavailable models.'}
              </small>
            </div>
          )}
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
          <span>
            {hiddenUnavailable > 0
              ? `${hiddenUnavailable} unavailable hidden`
              : `${shown.length} ready ${shown.length === 1 ? 'route' : 'routes'}`}
          </span>
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
  supportsAccountId?: boolean;
  supportsModelId?: boolean;
  defaultModelId?: string;
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
    id: 'groq',
    name: 'Groq',
    route: 'Groq OpenAI-compatible API',
    privacy: 'Prompts and generated text go to Groq under your API account.',
    cost: 'Groq publishes per-model free-plan limits. Cupcake will not switch to a paid fallback.',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'Usually begins with gsk_',
    supportsModelId: true,
    defaultModelId: 'openai/gpt-oss-20b',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    route: 'OpenRouter OpenAI-compatible API',
    privacy: 'Prompts and generated text go through OpenRouter to the selected model host.',
    cost: 'The default pins one currently listed free model. Availability and free-tier rate limits can change.',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'Usually begins with sk-or-',
    supportsModelId: true,
    defaultModelId: 'nvidia/nemotron-3.5-lightning:free',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    route: 'Cloudflare account Workers AI API',
    privacy: 'Prompts and generated text go to Workers AI in the Cloudflare account you enter.',
    cost: 'The selected default is outside Cloudflare’s paid-only model list. Cupcake will not switch models silently.',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    keyHint: 'Paste a Workers AI API token',
    supportsAccountId: true,
    supportsModelId: true,
    defaultModelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
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
  const [accountId, setAccountId] = useState('');
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
    setAccountId('');
    setOrganization('');
    setModelId(providerDefinitions.find((item) => item.id === initial)?.defaultModelId ?? '');
    setConnectionName('');
    setTestResult(null);
    setError(null);
  }, [provider]);
  if (!active) return null;

  const input = (): ProviderSetupInput => ({
    provider: selected!.id,
    apiKey,
    endpoint: endpoint.trim() || undefined,
    accountId: accountId.trim() || undefined,
    organization: organization.trim() || undefined,
    modelId: modelId.trim() || undefined,
    connectionName: connectionName.trim() || undefined,
  });
  const validate = (): string | null => {
    if (!apiKey.trim()) return 'Enter an API key before testing the connection.';
    if (selected?.supportsEndpoint && !/^https:\/\//i.test(endpoint.trim()))
      return 'Enter a complete HTTPS endpoint, such as https://api.example.com/v1.';
    if (selected?.supportsAccountId && !accountId.trim())
      return 'Enter the Cloudflare account ID that owns this Workers AI route.';
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
          accountId: setup.accountId,
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
          accountId: setup.accountId,
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
    setAccountId('');
    setModelId(providerDefinitions.find((item) => item.id === id)?.defaultModelId ?? '');
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
                  <ProviderLogo id={item.id} name={item.name} />
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
              {selected.supportsAccountId && (
                <label>
                  Cloudflare account ID
                  <input
                    autoFocus
                    name="account-id"
                    autoComplete="off"
                    spellCheck={false}
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                    placeholder="32-character account ID"
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
                <>
                  <label>
                    Model ID
                    <input
                      name="model-id"
                      autoComplete="off"
                      spellCheck={false}
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      placeholder={selected.defaultModelId ?? 'provider/model-name'}
                    />
                  </label>
                  {selected.id === 'openrouter' && (
                    <p className="provider-vault-note">
                      <Icon name="info" /> <code>openrouter/free</code> is an optional
                      variable-model router. Use it only when a different free model on each request
                      is acceptable.
                    </p>
                  )}
                </>
              )}
              <div className="provider-field">
                <label htmlFor="provider-api-key">API key</label>
                <span className="secret-input">
                  <input
                    id="provider-api-key"
                    autoFocus={!selected.supportsEndpoint && !selected.supportsAccountId}
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
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const closeDialog = useCallback(() => closeRef.current(), []);
  useModalFocusTrap(open, dialogRef, closeDialog);
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);
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
      action: () => void workspace.createConversation().then(() => setView('chat')),
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
      action: () => {
        setView('chat');
        window.setTimeout(() => window.dispatchEvent(new Event('cupcake:attach')), 0);
      },
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
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="command-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            aria-label="Search commands"
            aria-controls="command-results"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) =>
                  shown.length
                    ? (index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
                    : 0,
                );
              } else if (event.key === 'Enter' && shown[activeIndex]) {
                event.preventDefault();
                shown[activeIndex].action();
                close();
              }
            }}
            placeholder="What would you like to do?"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results" id="command-results">
          <span>Commands</span>
          {shown.map((c, i) => (
            <button
              className={i === activeIndex ? 'is-active' : ''}
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
        onRename={(id, title) =>
          setConversationRecords((items) =>
            items.map((item) => (item.id === id ? { ...item, title } : item)),
          )
        }
        onArchive={(id, archived) =>
          setConversationRecords((items) =>
            items.map((item) => (item.id === id ? { ...item, archived } : item)),
          )
        }
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
  else if (view === 'projects') content = <ProjectsView navigate={navigate} />;
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
  else if (view === 'artifacts')
    content = (
      <ArtifactsView
        openTask={(task) => {
          setActiveTask(task);
          navigate('task');
        }}
      />
    );
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
      <CupcakeTitlebar onSearch={() => navigate('search')} />
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
  const counts = report.counts ?? {};
  const conversationCount = Number(
    report.conversations ?? (Number(counts.conversation_message ?? 0) > 0 ? 1 : 0),
  );
  const memoryCount = Number(
    report.memories ??
      Number(counts.personality ?? 0) +
        Number(counts.thought ?? 0) +
        Number(counts.chroma_text ?? 0),
  );
  const taskCount = Number(report.tasks ?? counts.task ?? 0);
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
              Conversations, paused task records, and reviewable personality and memory candidates
              can be imported. Old API keys, executable scripts, generated state, and bytecode are
              always excluded.
            </p>
          </div>
        </div>
        <div className="project-stats">
          <span>
            <strong>{conversationCount}</strong> conversations
          </span>
          <span>
            <strong>{memoryCount}</strong> memories
          </span>
          <span>
            <strong>{taskCount}</strong> paused tasks
          </span>
          <span>
            <strong>{Number(report.messages ?? counts.conversation_message ?? 0)}</strong> messages
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
      'Opens without setup friction',
      'Cloud destinations are labeled',
      'Your projects stay isolated',
    ],
    view: 'home' as View,
    target: null,
  },
  {
    eyebrow: 'Your profile',
    title: 'Choose how CupcakeAI greets you',
    body: 'Your display name and cupcake portrait stay in this local profile. You can change either now or any time from Settings.',
    icon: 'user' as IconName,
    points: [
      'More portraits available in Settings',
      'Custom uploads in Settings',
      'Stored only in this profile',
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
    body: 'Guarded mode asks before sensitive effects. Full freedom skips consent prompts after you choose it; operating-system boundaries, explicit denies and destination checks still apply.',
    icon: 'shield' as IconName,
    points: [
      'Review tool effects in context',
      'Stop active generation with Ctrl .',
      'Optional workspace lock in Privacy settings',
    ],
    view: 'settings' as View,
    target: 'settings',
  },
  {
    eyebrow: 'Appearance',
    title: 'Set the atmosphere for your workspace',
    body: 'Choose a theme, wallpaper, motion level, scrollbar style, startup behavior, and whether closing the window quits or sends CupcakeAI to the tray.',
    icon: 'sparkle' as IconName,
    points: [
      'Readable themes and wallpapers',
      'Slim or hidden scrollbars',
      'Window behavior under your control',
    ],
    view: 'settings' as View,
    target: null,
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
  openProvider,
}: {
  open: boolean;
  close: (completed: boolean) => void;
  navigate: (view: View) => void;
  openProvider: (provider: string) => void;
}) {
  const workspace = useWorkspace();
  const [step, setStep] = useState(0);
  const [profileName, setProfileName] = useState(workspace.settings.profile.displayName);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [workspaceSecurity, setWorkspaceSecurity] = useState<WorkspaceLockStatus | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  const configuredProviderIds = Object.entries(workspace.providers)
    .filter(([, configured]) => configured)
    .map(([provider]) => provider);
  const activeRuntime = workspace.localRuntimes.find((runtime) => runtime.active);
  const profileReady = Boolean(
    workspace.settings.profile.displayName.trim() &&
    workspace.settings.profile.avatar &&
    workspace.settings.assistantAvatar,
  );
  const profileCustomized =
    profileReady &&
    (workspace.settings.profile.displayName !== 'Akshit' ||
      workspace.settings.profile.avatar !== 'atlas:16' ||
      workspace.settings.assistantAvatar !== 'atlas:0');
  const appearanceCustomized =
    workspace.settings.theme !== 'light' || workspace.settings.wallpaper !== 'none';
  const hardwareReady = Boolean(workspace.hardware?.ramBytes);
  const safetyReady =
    workspace.settings.reserveSystemRamGb > 0 && workspace.settings.reserveVramGb > 0;
  const toolsReady = workspace.settings.enabledToolIds.length > 0;
  const memoryStarted = workspace.memories.length > 0;
  const lockEnabled = workspaceSecurity?.unlockMode === 'password';

  const chapters = useMemo(
    () => [
      {
        key: 'welcome',
        eyebrow: onboardingSteps[0].eyebrow,
        title: onboardingSteps[0].title,
        body: 'This is a guided map of your real workbench. Take the parts you want now, skip any setup, and return from Settings whenever you like.',
        icon: 'sparkle' as IconName,
        artFrame: 1,
        view: 'home' as View,
        target: null as string | null,
        state: 'ready' as const,
        status: 'Optional and replayable',
      },
      {
        key: 'identity',
        eyebrow: 'You and your assistant',
        title: 'Give both sides of the conversation a face',
        body: 'Your local profile controls how CupcakeAI greets you. Your chosen assistant portrait follows replies across chats and projects.',
        icon: 'user' as IconName,
        artFrame: 5,
        view: 'home' as View,
        target: 'profile',
        state: !profileReady
          ? ('attention' as const)
          : profileCustomized
            ? ('complete' as const)
            : ('ready' as const),
        status: !profileReady
          ? 'Choose a name and two portraits'
          : profileCustomized
            ? 'Personalized and saved'
            : 'Ready with profile defaults',
      },
      {
        key: 'appearance',
        eyebrow: 'Appearance',
        title: 'Choose a room for your work',
        body: 'Theme and wallpaper travel across the workbench. Every choice keeps the controls readable; more scenes and motion settings live in Appearance.',
        icon: 'palette' as IconName,
        artFrame: 5,
        view: 'settings' as View,
        target: 'settings',
        state: appearanceCustomized ? ('complete' as const) : ('ready' as const),
        status: appearanceCustomized ? 'Personalized' : 'Quiet paper default',
      },
      {
        key: 'providers',
        eyebrow: 'Cloud providers',
        title: 'Connect only the routes you plan to use',
        body: 'CupcakeAI always names the service receiving your message. A provider key stays in the Windows credential vault and can be tested before saving.',
        icon: 'cloud' as IconName,
        artFrame: 1,
        view: 'models' as View,
        target: 'models',
        state: configuredProviderIds.length > 0 ? ('complete' as const) : ('attention' as const),
        status:
          configuredProviderIds.length > 0
            ? `${configuredProviderIds.length} connected`
            : 'Optional · none connected',
      },
      {
        key: 'runtime',
        eyebrow: 'Local CUDA and safety',
        title: 'Let the device fit the model before it loads',
        body: 'Cupcake Local checks usable VRAM and RAM, keeps reserves for Windows, and only starts a model when you explicitly ask. Opening the app never warms the GPU.',
        icon: 'local' as IconName,
        artFrame: 3,
        view: 'models' as View,
        target: 'models',
        state:
          activeRuntime && hardwareReady && safetyReady
            ? ('complete' as const)
            : ('ready' as const),
        status: activeRuntime
          ? `${activeRuntime.name} active`
          : hardwareReady
            ? 'Device measured · runtime on demand'
            : 'Device check pending',
      },
      {
        key: 'projects',
        eyebrow: 'Projects and tasks',
        title: 'Give durable work its own room',
        body: 'Projects keep chats, tasks, references, and artifacts together. They are also the boundary CupcakeAI uses when retrieving context.',
        icon: 'project' as IconName,
        artFrame: 2,
        view: 'projects' as View,
        target: 'projects',
        state: workspace.projects.length > 0 ? ('complete' as const) : ('ready' as const),
        status:
          workspace.projects.length > 0
            ? `${workspace.projects.length} ${workspace.projects.length === 1 ? 'project' : 'projects'}`
            : 'Ready for your first project',
      },
      {
        key: 'tools-memory',
        eyebrow: 'Tools and memory',
        title: 'Choose what CupcakeAI may do and remember',
        body: 'Tools are explicit capabilities you can turn on or off. Memory is inspectable, editable, scoped to a project when needed, and never a hidden transcript.',
        icon: 'memory' as IconName,
        artFrame: 2,
        view: 'tools' as View,
        target: 'tools',
        state: toolsReady && memoryStarted ? ('complete' as const) : ('ready' as const),
        status: `${workspace.settings.enabledToolIds.length} tools on · ${workspace.memories.length} memories`,
      },
      {
        key: 'security',
        eyebrow: 'Permissions, backup, and privacy',
        title: onboardingSteps[onboardingSteps.length - 1]!.title,
        body: 'Opening stays prompt-free by default. Guarded permission mode asks before sensitive effects; workspace password protection and backups remain choices you can make in Privacy and Storage.',
        icon: 'shield' as IconName,
        artFrame: lockEnabled ? 0 : 4,
        view: 'settings' as View,
        target: 'permissions',
        state: lockEnabled ? ('complete' as const) : ('ready' as const),
        status: lockEnabled ? 'Workspace password on' : 'Direct opening · no password required',
      },
    ],
    [
      activeRuntime,
      appearanceCustomized,
      configuredProviderIds.length,
      hardwareReady,
      lockEnabled,
      memoryStarted,
      profileCustomized,
      profileReady,
      safetyReady,
      toolsReady,
      workspace.memories.length,
      workspace.projects.length,
      workspace.settings.enabledToolIds.length,
    ],
  );

  useEffect(() => {
    if (open) {
      setStep(0);
      setProfileName(workspace.settings.profile.displayName);
    }
  }, [open, workspace.settings.profile.displayName]);
  const item = chapters[step]!;
  const last = step === chapters.length - 1;

  useEffect(() => {
    if (!open) return;
    const securityApi = window.cupcake?.workspace;
    if (!securityApi) {
      setWorkspaceSecurity({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 });
      return;
    }
    let active = true;
    void securityApi.status().then((status) => {
      if (active) setWorkspaceSecurity(status);
    });
    const release = securityApi.onStatus((status) => {
      if (active) setWorkspaceSecurity(status);
    });
    return () => {
      active = false;
      release();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const inertRegions = Array.from(
      document.querySelectorAll<HTMLElement>('.app-titlebar, .shelf, .app-content'),
    ).map((node) => ({ node, inert: node.inert }));
    inertRegions.forEach(({ node }) => {
      node.inert = true;
    });
    const focusTimer = window.setTimeout(() => titleRef.current?.focus(), 0);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current(false);
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const lastFocusable = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      inertRegions.forEach(({ node, inert }) => {
        node.inert = inert;
      });
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    navigate(item.view);
    setTargetRect(null);
    let observer: ResizeObserver | null = null;
    const locate = () => {
      const target = item.target
        ? document.querySelector<HTMLElement>(`[data-tour="${item.target}"]`)
        : null;
      targetRef.current = target;
      if (!target) {
        setTargetRect(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight;
      setTargetRect(visible ? rect : null);
    };
    const timer = window.setTimeout(() => {
      locate();
      if (targetRef.current) {
        observer = new ResizeObserver(locate);
        observer.observe(targetRef.current);
      }
    }, 120);
    window.addEventListener('resize', locate);
    document.addEventListener('scroll', locate, true);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener('resize', locate);
      document.removeEventListener('scroll', locate, true);
      targetRef.current = null;
    };
  }, [item.target, item.view, navigate, open]);

  const saveProfileName = () => {
    const displayName = profileName.trim();
    if (!displayName || displayName === workspace.settings.profile.displayName) return;
    void workspace.updateSettings({
      profile: { ...workspace.settings.profile, displayName },
    });
  };
  const move = (direction: -1 | 1) => {
    if (item.key === 'identity') saveProfileName();
    setStep((value) => Math.max(0, Math.min(chapters.length - 1, value + direction)));
  };
  const leaveFor = (view: View, target?: string) => {
    close(false);
    navigate(view);
    if (target)
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(`[data-tour="${target}"]`)?.click();
      }, 80);
  };
  const nextAttention = chapters.findIndex(
    (chapter, index) => index > step && chapter.state === 'attention',
  );
  const configuredAreas = chapters
    .slice(1)
    .filter((chapter) => chapter.state !== 'attention').length;

  if (!open) return null;
  return (
    <div
      className={cx('onboarding-layer', targetRect && 'has-target')}
      data-onboarding-step={item.key}
    >
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
      <section
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        ref={dialogRef}
      >
        <aside className="onboarding-map" aria-label="Tour chapters">
          <div className="onboarding-map__art" aria-hidden="true">
            <OnboardingStoryArt step={item.artFrame} />
            <span className="onboarding-step-icon">
              <Icon name={item.icon} size={20} />
            </span>
          </div>
          <div className="onboarding-map__summary">
            <span className="eyebrow">Your workbench map</span>
            <strong>
              {configuredAreas} of {chapters.length - 1} areas ready
            </strong>
            <span className="onboarding-map__meter" aria-hidden="true">
              <i style={{ width: `${(configuredAreas / (chapters.length - 1)) * 100}%` }} />
            </span>
          </div>
          <nav aria-label="Onboarding chapters">
            {chapters.map((chapter, index) => (
              <button
                type="button"
                className={cx(
                  index === step && 'is-active',
                  chapter.state === 'complete' && 'is-complete',
                  chapter.state === 'attention' && 'needs-attention',
                )}
                onClick={() => setStep(index)}
                aria-current={index === step ? 'step' : undefined}
                key={chapter.key}
              >
                <span>
                  {chapter.state === 'complete' ? <Icon name="check" size={13} /> : index + 1}
                </span>
                <span>
                  <strong>{chapter.eyebrow}</strong>
                  <small>{chapter.status}</small>
                </span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="onboarding-copy">
          <header>
            <div>
              <span className="eyebrow">
                Chapter {step + 1} · {item.eyebrow}
              </span>
              <span className={cx('onboarding-state', `is-${item.state}`)} aria-live="polite">
                <Icon
                  name={
                    item.state === 'complete'
                      ? 'check'
                      : item.state === 'attention'
                        ? 'info'
                        : 'sparkle'
                  }
                  size={12}
                />
                {item.status}
              </span>
            </div>
            <button
              className="icon-button"
              onClick={() => close(false)}
              aria-label="Skip onboarding"
            >
              <Icon name="x" />
            </button>
          </header>
          <h1 id="onboarding-title" tabIndex={-1} ref={titleRef}>
            {item.title}
          </h1>
          <p className="onboarding-lede">{item.body}</p>

          {item.key === 'welcome' && (
            <div className="onboarding-welcome-grid">
              <span>
                <Icon name="chat" />
                <strong>Chat</strong>
                <small>Ask, attach, branch</small>
              </span>
              <span>
                <Icon name="task" />
                <strong>Work</strong>
                <small>Projects that persist</small>
              </span>
              <span>
                <Icon name="model" />
                <strong>Choose</strong>
                <small>Local or named cloud</small>
              </span>
              <span>
                <Icon name="shield" />
                <strong>Control</strong>
                <small>Visible tools and memory</small>
              </span>
            </div>
          )}

          {item.key === 'identity' && (
            <div className="onboarding-profile-editor">
              <label>
                What should CupcakeAI call you?
                <input
                  value={profileName}
                  maxLength={60}
                  onChange={(event) => setProfileName(event.target.value)}
                  onBlur={saveProfileName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      saveProfileName();
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <div className="onboarding-avatar-pair">
                <fieldset>
                  <legend>Your portrait</legend>
                  <div className="onboarding-avatar-grid">
                    {CUPCAKE_AVATARS.slice(12, 18).map(({ value, label }) => (
                      <button
                        type="button"
                        className={workspace.settings.profile.avatar === value ? 'is-selected' : ''}
                        aria-label={`Use ${label} for me`}
                        aria-pressed={workspace.settings.profile.avatar === value}
                        onClick={() =>
                          void workspace.updateSettings({
                            profile: { ...workspace.settings.profile, avatar: value },
                          })
                        }
                        key={value}
                      >
                        <CupcakePortrait value={value} label="" />
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend>CupcakeAI's portrait</legend>
                  <div className="onboarding-avatar-grid">
                    {CUPCAKE_AVATARS.slice(0, 6).map(({ value, label }) => (
                      <button
                        type="button"
                        className={
                          workspace.settings.assistantAvatar === value ? 'is-selected' : ''
                        }
                        aria-label={`Use ${label} for CupcakeAI`}
                        aria-pressed={workspace.settings.assistantAvatar === value}
                        onClick={() => void workspace.updateSettings({ assistantAvatar: value })}
                        key={value}
                      >
                        <CupcakePortrait value={value} label="" />
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
              <button className="text-button" onClick={() => leaveFor('settings', 'profile')}>
                Custom image and full profile <Icon name="chevron" size={13} />
              </button>
            </div>
          )}

          {item.key === 'appearance' && (
            <div className="onboarding-appearance">
              <fieldset>
                <legend>Theme</legend>
                <div className="onboarding-choice-row">
                  {(['light', 'dark', 'minimal', 'classic'] as const).map((theme) => (
                    <button
                      type="button"
                      className={workspace.settings.theme === theme ? 'is-selected' : ''}
                      aria-pressed={workspace.settings.theme === theme}
                      onClick={() => void workspace.updateSettings({ theme })}
                      key={theme}
                    >
                      <span className={`onboarding-theme-dot is-${theme}`} />
                      {cap(theme)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Wallpaper</legend>
                <div className="onboarding-wallpaper-row">
                  {WORKSPACE_WALLPAPERS.slice(0, 5).map(([value, label]) => (
                    <button
                      type="button"
                      className={workspace.settings.wallpaper === value ? 'is-selected' : ''}
                      aria-label={`Use ${label} wallpaper`}
                      aria-pressed={workspace.settings.wallpaper === value}
                      onClick={() => void workspace.updateSettings({ wallpaper: value })}
                      key={value}
                    >
                      <span
                        style={
                          value === 'none'
                            ? undefined
                            : { backgroundImage: `url(/wallpapers/${value}.webp)` }
                        }
                      />
                      <small>{label}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
              <button className="text-button" onClick={() => leaveFor('settings')}>
                See every appearance option <Icon name="chevron" size={13} />
              </button>
            </div>
          )}

          {item.key === 'providers' && (
            <div className="onboarding-provider-guide">
              <p>
                <strong>Choose a provider</strong>
                <small>Connect, test, and save in one focused panel.</small>
              </p>
              <div>
                {(
                  [
                    ['openai', 'OpenAI'],
                    ['anthropic', 'Anthropic'],
                    ['google', 'Google'],
                    ['cohere', 'Cohere'],
                    ['nvidia-nim', 'NVIDIA NIM'],
                    ['choose', 'More providers'],
                  ] as const
                ).map(([id, label]) => {
                  const connected = id !== 'choose' && workspace.providers[id] === true;
                  return (
                    <button
                      type="button"
                      className={connected ? 'is-connected' : ''}
                      onClick={() => {
                        close(false);
                        openProvider(id);
                      }}
                      key={id}
                    >
                      <ProviderLogo id={id === 'choose' ? 'openai-compatible' : id} name={label} />
                      <span>{label}</span>
                      <small>{connected ? 'Connected' : 'Set up'}</small>
                    </button>
                  );
                })}
              </div>
              <span className="onboarding-privacy-note">
                <Icon name="key" size={14} /> Keys remain outside the renderer and are protected for
                your Windows account.
              </span>
            </div>
          )}

          {item.key === 'runtime' && (
            <div className="onboarding-runtime-panel">
              <div className="onboarding-fact-grid">
                <span>
                  <Icon name="database" />
                  <small>System RAM</small>
                  <strong>
                    {workspace.hardware?.ramBytes
                      ? `${Math.round(workspace.hardware.ramBytes / 1024 ** 3)} GB detected`
                      : 'Scan pending'}
                  </strong>
                </span>
                <span>
                  <Icon name="model" />
                  <small>Local engine</small>
                  <strong>{activeRuntime?.name ?? 'Starts on demand'}</strong>
                </span>
                <span>
                  <Icon name="shield" />
                  <small>Windows reserve</small>
                  <strong>
                    {workspace.settings.reserveSystemRamGb} GB RAM ·{' '}
                    {workspace.settings.reserveVramGb} GB VRAM
                  </strong>
                </span>
              </div>
              <button
                type="button"
                className={cx(
                  'onboarding-safety-toggle',
                  workspace.settings.allowRamFallback && 'is-selected',
                )}
                aria-pressed={workspace.settings.allowRamFallback}
                onClick={() =>
                  void workspace.updateSettings({
                    allowRamFallback: !workspace.settings.allowRamFallback,
                  })
                }
              >
                <span>
                  <Icon name={workspace.settings.allowRamFallback ? 'check' : 'database'} />
                </span>
                <span>
                  <strong>Allow measured RAM fallback</strong>
                  <small>
                    Use system memory only within the reserve shown above. This can be slower than
                    full GPU offload.
                  </small>
                </span>
              </button>
              <button className="text-button" onClick={() => leaveFor('models')}>
                Browse local models and runtimes <Icon name="chevron" size={13} />
              </button>
            </div>
          )}

          {item.key === 'projects' && (
            <div className="onboarding-workflow">
              <ol>
                <li>
                  <span>1</span>
                  <strong>Project</strong>
                  <small>Sets the context boundary</small>
                </li>
                <li>
                  <span>2</span>
                  <strong>Task</strong>
                  <small>Tracks steps and approvals</small>
                </li>
                <li>
                  <span>3</span>
                  <strong>Artifact</strong>
                  <small>Keeps each useful revision</small>
                </li>
              </ol>
              <div className="onboarding-current-count">
                <Icon name="project" />
                <span>
                  <strong>{workspace.projects.length || 'No'} saved projects</strong>
                  <small>A quick chat never needs one.</small>
                </span>
              </div>
              <button className="button" onClick={() => leaveFor('projects')}>
                Open Projects
              </button>
            </div>
          )}

          {item.key === 'tools-memory' && (
            <div className="onboarding-capability-grid">
              <button type="button" onClick={() => leaveFor('tools')}>
                <span>
                  <Icon name="tool" />
                </span>
                <strong>Tools</strong>
                <small>
                  {workspace.settings.enabledToolIds.length} enabled · each effect stays visible
                </small>
                <Icon name="chevron" size={14} />
              </button>
              <button type="button" onClick={() => leaveFor('memory')}>
                <span>
                  <Icon name="memory" />
                </span>
                <strong>Memory</strong>
                <small>{workspace.memories.length} saved · inspect, edit, or remove</small>
                <Icon name="chevron" size={14} />
              </button>
              <p>
                <Icon name="info" size={14} /> A project memory stays in that project. Global memory
                is used only where its scope allows it.
              </p>
            </div>
          )}

          {last && (
            <div className="onboarding-finish-panel">
              <div
                className="onboarding-permission-choice"
                role="group"
                aria-label="Permission mode"
              >
                <button
                  type="button"
                  className={workspace.settings.permissionMode === 'guarded' ? 'is-selected' : ''}
                  aria-pressed={workspace.settings.permissionMode === 'guarded'}
                  onClick={() => void workspace.updateSettings({ permissionMode: 'guarded' })}
                >
                  <Icon name="shield" />
                  <span>
                    <strong>Guarded</strong>
                    <small>Ask before sensitive effects</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={
                    workspace.settings.permissionMode === 'full-freedom' ? 'is-selected' : ''
                  }
                  aria-pressed={workspace.settings.permissionMode === 'full-freedom'}
                  onClick={() => void workspace.updateSettings({ permissionMode: 'full-freedom' })}
                >
                  <Icon name="sparkle" />
                  <span>
                    <strong>Full freedom</strong>
                    <small>Fewer routine confirmations</small>
                  </span>
                </button>
              </div>
              <div className="onboarding-security-status">
                <span>
                  <Icon name={lockEnabled ? 'key' : 'window'} />
                </span>
                <span>
                  <strong>
                    {lockEnabled ? 'Workspace password is on' : 'The app opens directly'}
                  </strong>
                  <small>
                    {lockEnabled
                      ? 'Only someone with the password can open this profile.'
                      : 'Password protection is optional and can be added later.'}
                  </small>
                </span>
                <button className="text-button" onClick={() => leaveFor('settings', 'permissions')}>
                  Privacy &amp; backups
                </button>
              </div>
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
                    <small>Privacy, storage, and window</small>
                  </span>
                </button>
              </div>
            </div>
          )}
          <footer>
            <span className="onboarding-step-count">
              {step + 1} / {chapters.length}
            </span>
            {nextAttention >= 0 && (
              <button
                className="text-button onboarding-next-attention"
                onClick={() => setStep(nextAttention)}
              >
                Next unfinished area
              </button>
            )}
            <span />
            {step > 0 && (
              <button className="button" onClick={() => move(-1)}>
                Back
              </button>
            )}
            <button
              className="button button--primary"
              onClick={() => {
                if (last) close(true);
                else move(1);
              }}
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
  const onboardingRequested = new URLSearchParams(window.location.search).get('onboarding') === '1';
  const [view, setView] = useState<View>(initialView);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [providerDialog, setProviderDialog] = useState<string | null>(null);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [onboardingOpen, setOnboardingOpen] = useState(onboardingRequested);
  const onboardingAutoShown = useRef(onboardingRequested);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(workspace.tasks[0]?.id ?? null);
  const [memoryRecords, setMemoryRecords] = useState(workspace.memories);
  const [toolRecords, setToolRecords] = useState(workspace.tools);
  const stopRunRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const pendingProfileApplied = useRef(false);
  stopRunRef.current = () => workspace.stopRun();
  const selectedModel = selectedModelForChat(workspace.models);
  const activeTask = workspace.tasks.find((task) => task.id === activeTaskId) ?? workspace.tasks[0];
  useEffect(() => setMemoryRecords(workspace.memories), [workspace.memories]);
  useEffect(() => setToolRecords(workspace.tools), [workspace.tools]);
  useEffect(() => {
    if (!workspace.ready || !workspace.configurationReady || pendingProfileApplied.current) return;
    const pending = window.sessionStorage.getItem('cupcake-pending-profile');
    if (!pending) return;
    pendingProfileApplied.current = true;
    try {
      const profile = JSON.parse(pending) as { displayName?: string; avatar?: string };
      void workspace
        .updateSettings({
          profile: {
            ...workspace.settings.profile,
            displayName: profile.displayName?.trim() || workspace.settings.profile.displayName,
            avatar: profile.avatar || workspace.settings.profile.avatar,
          },
        })
        .finally(() => window.sessionStorage.removeItem('cupcake-pending-profile'));
    } catch {
      window.sessionStorage.removeItem('cupcake-pending-profile');
    }
  }, [
    workspace.configurationReady,
    workspace.ready,
    workspace.settings.profile,
    workspace.updateSettings,
  ]);
  useEffect(() => {
    const nativeDesktop = '__TAURI_INTERNALS__' in window;
    if (
      nativeDesktop &&
      workspace.ready &&
      workspace.configurationReady &&
      !workspace.settings.onboardingCompleted &&
      !onboardingAutoShown.current
    ) {
      onboardingAutoShown.current = true;
      setOnboardingOpen(true);
    }
  }, [workspace.configurationReady, workspace.ready, workspace.settings.onboardingCompleted]);
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
  const navigationEpoch = useRef(0);
  const navigate = useCallback((next: View) => {
    navigationEpoch.current += 1;
    setView(next);
    document.querySelector('.app-content')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    document.querySelector('.app-content')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [view]);
  const openConversation = (id: string) => {
    const epoch = ++navigationEpoch.current;
    void workspace.selectConversation(id).then(() => {
      if (navigationEpoch.current === epoch) navigate('chat');
    });
  };
  const startNewChat = () => {
    const epoch = ++navigationEpoch.current;
    void workspace.createConversation().then((created) => {
      if (created && navigationEpoch.current === epoch) navigate('chat');
    });
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
  });
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
  const forceOpening =
    workspace.fixtureMode && new URLSearchParams(window.location.search).get('opening') === '1';
  if ((!workspace.ready && !workspace.fixtureMode) || forceOpening) content = <WorkspaceOpening />;
  else if (view === 'home')
    content = (
      <HomeView
        openChat={(id) => (id ? openConversation(id) : startNewChat())}
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
        onOpen={openConversation}
        onRename={(id, title) => workspace.renameConversation(id, title)}
        onArchive={(id, archived) => workspace.archiveConversation(id, archived)}
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
  else if (view === 'projects') content = <ProjectsView navigate={navigate} />;
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
        modelName={selectedModel?.name ?? 'No model selected'}
        onBack={() => navigate('tasks')}
      />
    );
  else if (view === 'artifacts')
    content = (
      <ArtifactsView
        openTask={(task) => {
          setActiveTaskId(task.id);
          navigate('task');
        }}
      />
    );
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
    content = <DeveloperView modelName={selectedModel?.name ?? 'No model selected'} />;
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
  const wallpaperUrl =
    workspace.settings.wallpaper === 'none'
      ? undefined
      : `url(/wallpapers/${workspace.settings.wallpaper}.webp)`;
  const workspaceWallpaper = Boolean(wallpaperUrl);
  return (
    <div
      className={cx('app-shell', workspaceWallpaper && 'app-shell--wallpaper')}
      data-wallpaper={workspaceWallpaper ? workspace.settings.wallpaper : undefined}
      style={
        workspaceWallpaper
          ? ({ '--workspace-wallpaper': wallpaperUrl } as CSSProperties)
          : undefined
      }
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <CupcakeTitlebar onSearch={() => navigate('search')} />
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
        onSelectConversation={openConversation}
        profile={workspace.settings.profile}
      />
      <section
        className={cx(
          'app-content',
          view === 'chat' && 'app-content--chat',
          workspaceWallpaper && 'app-content--wallpaper',
        )}
        id="main-content"
        tabIndex={-1}
      >
        {workspace.fixtureMode && !forceOpening && (
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
        openProvider={setProviderDialog}
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
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dreamscape] = useState(() => Math.floor(Math.random() * 4));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!window.cupcake || !status || busy) return;
    setError('');
    setBusy(true);
    void window.cupcake.workspace
      .unlock(password)
      .then((next) => {
        setPassword('');
        onUnlocked(next);
      })
      .catch((reason: unknown) => setError(hostErrorMessage(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="app-shell app-shell--locked">
      <CupcakeTitlebar onSearch={() => undefined} />
      <main className="workspace-unlock">
        <Dreamscape scene={dreamscape} />
        <section className="workspace-unlock__card">
          <div className="workspace-unlock__mark">
            <Icon name="shield" size={30} />
          </div>
          <span className="eyebrow">Optional workspace lock</span>
          <h1>Unlock CupcakeAI</h1>
          <p>
            {status === null
              ? 'Checking this local profile…'
              : 'This workspace lock was enabled in Settings. Enter its password to continue.'}
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
                Password
                <span className="password-input">
                  <input
                    type={revealed ? 'text' : 'password'}
                    autoComplete="current-password"
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
                {busy ? 'Unlocking…' : 'Unlock workspace'}
              </button>
              {busy && (
                <div className="workspace-unlock__progress" role="status">
                  <span>
                    <i />
                  </span>
                  <small>
                    Opening your history. Models and optional services will wake only when needed.
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
              <strong>This lock is optional and can be turned off after opening.</strong>
              <p>
                CupcakeAI normally opens without a password. This screen appears only because
                workspace lock was explicitly enabled in Privacy settings.
              </p>
            </div>
          )}
        </section>
        <aside className="workspace-unlock__aside">
          <span>OPTIONAL SECURITY</span>
          <h2>Your extra gate, when you want it.</h2>
          <ul>
            <li>
              <Icon name="check" /> Disabled by default
            </li>
            <li>
              <Icon name="check" /> Enabled only from Settings
            </li>
            <li>
              <Icon name="check" /> Removable with your current password
            </li>
          </ul>
        </aside>
      </main>
    </div>
  );
}

export function App() {
  const workspaceLockApi = window.cupcake?.workspace;
  const defaultSetupStarted = useRef(false);
  const [lockStatus, setLockStatus] = useState<WorkspaceLockStatus | null>(
    workspaceLockApi ? null : { state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 },
  );
  useEffect(() => {
    if (!workspaceLockApi) return;
    let active = true;
    const acceptStatus = (status: WorkspaceLockStatus) => {
      if (!active) return;
      if (status.state === 'needs_setup' && !defaultSetupStarted.current) {
        defaultSetupStarted.current = true;
        void workspaceLockApi
          .setupWithoutPassword()
          .then((next) => active && setLockStatus(next))
          .catch(() => active && setLockStatus(status));
        return;
      }
      setLockStatus(status);
    };
    void workspaceLockApi.status().then(acceptStatus);
    const release = workspaceLockApi.onStatus((status) => {
      acceptStatus(status);
    });
    return () => {
      active = false;
      release();
    };
  }, [workspaceLockApi]);
  if (lockStatus === null || lockStatus.state === 'needs_setup') {
    return (
      <div className="app-shell app-shell--locked">
        <CupcakeTitlebar onSearch={() => undefined} />
        <WorkspaceOpening />
      </div>
    );
  }
  if (lockStatus.state === 'locked') {
    return <WorkspaceUnlockGate status={lockStatus} onUnlocked={setLockStatus} />;
  }
  return (
    <WorkspaceProvider>
      <LiveApp />
    </WorkspaceProvider>
  );
}
