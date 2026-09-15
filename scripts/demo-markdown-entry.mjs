/** Recording-only adapter. Uses the production renderer; never ships in the app. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RichMarkdown } from '../apps/desktop/src/renderer/RichMarkdown';

let root;
export function mount(element) {
  root?.unmount();
  root = createRoot(element);
  render('', true);
}
export function render(text, streaming) {
  root?.render(React.createElement(RichMarkdown, { streaming }, text));
}
export function unmount() {
  root?.unmount();
  root = undefined;
}
