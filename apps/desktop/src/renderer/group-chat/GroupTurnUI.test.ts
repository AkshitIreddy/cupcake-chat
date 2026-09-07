import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GroupTurnState } from '../types';
import { GroupTurnRail } from './GroupTurnUI';

function renderStatus(update: Partial<GroupTurnState>) {
  const turn: GroupTurnState = {
    turnId: 'turn',
    conversationId: 'conversation',
    planRevision: 'plan',
    rosterRevision: 1,
    status: 'completed',
    mode: 'smart',
    callIndex: 1,
    maxSelectorCalls: 2,
    maxReplies: 2,
    speakers: [],
    ...update,
  };
  return renderToStaticMarkup(
    React.createElement(GroupTurnRail, { turn, onStop: () => {}, onRepair: () => {} }),
  );
}

describe('group completion presentation', () => {
  it('leaves completed replies in the transcript without a redundant status banner', () => {
    expect(renderStatus({ status: 'completed' })).toBe('');
  });

  it('does not call a turn quiet after one member already replied', () => {
    expect(
      renderStatus({
        status: 'waiting_for_you',
        speakers: [
          {
            sequence: 1,
            status: 'completed',
            speaker: {
              participantId: 'member',
              personaId: 'persona',
              name: 'Mara',
              handle: 'mara',
              avatar: '',
              role: 'Planner',
              modelId: 'groq:planner',
              providerId: 'groq',
              privacyRoute: 'cloud',
            },
          },
        ],
      }),
    ).toBe('');
  });

  it('explains a quiet turn only when the user opens its details', () => {
    const html = renderStatus({
      status: 'waiting_for_you',
      selectionSummary: 'No new contribution was requested.',
    });
    expect(html).toContain('No reply needed');
    expect(html).toContain('<details><summary>Why?</summary>');
    expect(html).not.toContain('<details open');
    expect(html).toContain('No new contribution was requested.');
    expect(html).toContain('1 of 2 routing checks');
    expect(html).not.toContain('Waiting for your next message');
    expect(html).not.toContain('group-turn-rail__speakers');
  });

  it('keeps active turn progress and cancellation available', () => {
    const html = renderStatus({ status: 'responding' });
    expect(html).toContain('Group turn in progress');
    expect(html).toContain('Stop group turn');
    expect(html).toContain('data-testid="group-stop"');
  });

  it('never hides failure or interrupted recovery information as a quiet completion', () => {
    expect(
      renderStatus({ status: 'interrupted', error: 'Restart interrupted the response.' }),
    ).toContain('Restart interrupted the response.');
    expect(
      renderStatus({ status: 'completed', error: 'A saved error still needs attention.' }),
    ).toContain('A saved error still needs attention.');
    expect(
      renderStatus({ status: 'selection_failed', error: 'Reconnect the lead model.' }),
    ).toContain('Reconnect the lead model.');
  });
});
