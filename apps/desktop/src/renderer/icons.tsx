import type { ReactElement, SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'chat'
  | 'project'
  | 'task'
  | 'artifact'
  | 'memory'
  | 'model'
  | 'tool'
  | 'search'
  | 'settings'
  | 'code'
  | 'plus'
  | 'arrow'
  | 'more'
  | 'send'
  | 'paperclip'
  | 'sparkle'
  | 'check'
  | 'clock'
  | 'pause'
  | 'play'
  | 'download'
  | 'trash'
  | 'edit'
  | 'branch'
  | 'copy'
  | 'retry'
  | 'pin'
  | 'archive'
  | 'shield'
  | 'cloud'
  | 'local'
  | 'chevron'
  | 'filter'
  | 'command'
  | 'x'
  | 'menu'
  | 'external'
  | 'file'
  | 'folder'
  | 'eye'
  | 'terminal'
  | 'history'
  | 'info'
  | 'key'
  | 'palette'
  | 'bell'
  | 'database'
  | 'user'
  | 'window'
  | 'upload';

const paths: Record<IconName, ReactElement> = {
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  project: (
    <>
      <path d="M3 6h7l2 2h9v11H3z" />
      <path d="M3 10h18" />
    </>
  ),
  task: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="m8 9 2 2 4-4m-6 9h8" />
    </>
  ),
  artifact: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5M9 13h6m-6 4h6" />
    </>
  ),
  memory: (
    <>
      <rect x="5" y="4" width="14" height="16" rx="3" />
      <path d="M9 4V2m6 2V2M9 20v2m6-2v2M5 9H3m2 6H3m16-6h2m-2 6h2M9 9h6v6H9z" />
    </>
  ),
  model: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
  tool: <path d="M14 5a5 5 0 0 0-6.6 6.4L3 15.8 8.2 21l4.4-4.4A5 5 0 0 0 19 10l-3 3-4-1-1-4z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.09A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3h4v.09a1.7 1.7 0 0 0 1.03 1.54 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 21 10v4h-.09A1.7 1.7 0 0 0 19.4 15z" />
    </>
  ),
  code: <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-5 3 2-14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="m5 12 6-6m-6 6 6 6m-6-6h14" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </>
  ),
  send: (
    <>
      <path d="m3 4 18 8-18 8 3-8z" />
      <path d="M6 12h15" />
    </>
  ),
  paperclip: <path d="m9 7 6-4a4 4 0 0 1 4 7l-9 7a5 5 0 0 1-7-7l9-7" />,
  sparkle: (
    <>
      <path d="M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10z" />
      <path d="M19 2v4m-2-2h4" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7z" />,
  download: (
    <>
      <path d="M12 3v13m-5-5 5 5 5-5M5 21h14" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16-1 5 5-1L20 8l-4-4z" />
      <path d="m14 6 4 4" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10m2-6c5 0 4-4 8-4" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  retry: (
    <>
      <path d="M20 7v6h-6" />
      <path d="M20 13a8 8 0 1 1-2-7" />
    </>
  ),
  pin: <path d="m9 3 6 6-2 2 3 5-1 1-5-3-4 4-1-1 4-4-3-5 1-1z" />,
  archive: (
    <>
      <path d="M3 6h18v4H3zM5 10v10h14V10m-10 4h6" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-3 8-8 10-5-2-8-5-8-10V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  cloud: <path d="M6 19h12a4 4 0 0 0 0-8h-1a6 6 0 0 0-12-1 4.5 4.5 0 0 0 1 9z" />,
  local: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 22h8m-4-4v4M7 9h5m-5 4h8" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  command: (
    <>
      <path d="M9 7V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  external: <path d="M14 4h6v6m0-6-9 9M20 14v6H4V4h6" />,
  file: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
  folder: <path d="M3 6h7l2 2h9v11H3z" />,
  eye: (
    <>
      <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 7 5 5-5 5m8 0h6" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-7M3 4v6h6" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="5" />
      <path d="m12 12 8-8m-3 3 3 3m-6 0 3 3" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a5 5 0 0 0 0-10z" />
      <circle cx="7" cy="10" r="1" fill="currentColor" />
      <circle cx="10" cy="6" r="1" fill="currentColor" />
      <circle cx="15" cy="7" r="1" fill="currentColor" />
    </>
  ),
  bell: <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zm5 3h4" />,
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 2 4 3 8 3s8-1 8-3V5m-16 7v7c0 2 4 3 8 3s8-1 8-3v-7" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m0 0L7 8m5-5 5 5" />
      <path d="M5 14v6h14v-6" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
