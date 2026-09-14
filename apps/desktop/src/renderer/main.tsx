import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { App } from './App';
import { Tooltips } from './Tooltips';
import { installTauriDesktopApi } from '../shared/tauri-client';
import './styles.css';
import './styles-workspace.css';
import './styles-panels.css';
import './styles-wallpaper.css';
import './styles-wallpaper-gallery.css';
import './styles-responsive.css';
import './styles-artifacts.css';
import './styles-interactions.css';
import './styles-model-catalog.css';
import './styles-onboarding.css';
import './styles-studio.css';
import './styles-group-chat.css';
import './styles-chat-refresh.css';
import './styles-living-motion.css';

installTauriDesktopApi();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <Tooltips />
  </React.StrictMode>,
);
