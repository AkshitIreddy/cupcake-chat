import { describe, expect, it } from 'vitest';
import {
  cancelledSendWasCommitted,
  mapConversation,
  mapRuntimeMessage,
  scopedReferenceOptions,
  sendWasCommitted,
  shouldOptimisticallyAppendUser,
  structuredAttachments,
  structuredReferences,
} from './workspace';

describe('workspace attachment and reference contracts', () => {
  it('recognizes only a persisted completed user turn followed by its cancelled response', () => {
    const committedHistory = [
      {
        id: 'user-current',
        role: 'user' as const,
        content: 'Keep this request.',
        state: 'complete',
        created_at: '2026-09-05T07:38:57.290Z',
      },
      {
        id: 'assistant-current',
        role: 'assistant' as const,
        content: '',
        state: 'cancelled',
        parent_message_id: 'user-current',
        created_at: '2026-09-05T07:38:59.870Z',
      },
    ];

    expect(
      cancelledSendWasCommitted(committedHistory, 'Keep this request.', {
        cancelledMessageId: 'assistant-current',
      }),
    ).toBe(true);
    expect(
      cancelledSendWasCommitted(committedHistory, 'A draft that was never saved.', {
        cancelledMessageId: 'assistant-current',
      }),
    ).toBe(false);
    expect(
      cancelledSendWasCommitted(committedHistory, 'Keep this request.', {
        cancelledMessageId: 'assistant-missing',
      }),
    ).toBe(false);
  });

  it('rehydrates an empty cancelled assistant turn as stopped instead of still starting', () => {
    expect(
      mapRuntimeMessage({
        id: 'assistant-cancelled',
        role: 'assistant',
        content: '',
        state: 'cancelled',
      }),
    ).toMatchObject({ content: '', responseState: 'cancelled' });
  });

  it('rehydrates a partial failed assistant turn with its recoverable error state', () => {
    expect(
      mapRuntimeMessage({
        id: 'assistant-failed',
        role: 'assistant',
        content: 'A useful partial answer',
        state: 'error',
        canonical_metadata: {
          finishReason: 'error',
          errorCode: 'provider_unavailable',
        },
      }),
    ).toMatchObject({
      content: 'A useful partial answer',
      responseState: 'error',
      finishReason: 'error',
      errorCode: 'provider_unavailable',
    });
  });

  it('recognizes a persisted failed response as a committed send', () => {
    const history = [
      {
        id: 'user-current',
        role: 'user' as const,
        content: 'Explain the supply line.',
        state: 'complete',
        created_at: '2026-09-16T05:00:20.000Z',
      },
      {
        id: 'assistant-failed',
        role: 'assistant' as const,
        content: 'The first concern was food',
        state: 'error',
        parent_message_id: 'user-current',
        created_at: '2026-09-16T05:00:21.000Z',
      },
    ];

    expect(
      sendWasCommitted(history, 'Explain the supply line.', {
        assistantMessageId: 'assistant-failed',
      }),
    ).toBe(true);
    expect(
      sendWasCommitted(history, 'A different draft.', {
        assistantMessageId: 'assistant-failed',
      }),
    ).toBe(false);
  });

  it('does not mistake a recent identical prior turn for the current send', () => {
    const history = [
      {
        id: 'user-prior',
        role: 'user' as const,
        content: 'Explain the supply line.',
        state: 'complete',
      },
      {
        id: 'assistant-prior',
        role: 'assistant' as const,
        content: 'A previous answer',
        state: 'complete',
        parent_message_id: 'user-prior',
        created_at: '2026-09-16T05:00:20.999Z',
      },
    ];

    expect(
      sendWasCommitted(history, 'Explain the supply line.', {
        notBefore: Date.parse('2026-09-16T05:00:21.000Z'),
      }),
    ).toBe(false);
  });

  it('preserves the authoritative project identity for conversations', () => {
    const projects = [
      { id: 'project-a', name: 'Alpha', description: '', archived: false },
      { id: 'project-b', name: 'Beta', description: '', archived: false },
    ];

    expect(
      mapConversation(
        {
          id: 'conversation-b',
          title: 'Beta launch room',
          project_id: 'project-b',
          status: 'active',
        },
        projects,
      ),
    ).toMatchObject({
      id: 'conversation-b',
      project: 'Beta',
      projectId: 'project-b',
    });
  });

  it('sends only opaque handle identities and typed reference identities', () => {
    expect(
      structuredAttachments([
        {
          handleId: 'grant-1',
          name: 'private-plan.md',
          size: 42,
          extension: 'md',
          destination: 'cloud',
        },
      ]),
    ).toEqual([{ handleId: 'grant-1' }]);
    expect(
      structuredReferences([
        {
          id: 'artifact-1',
          type: 'artifact',
          label: 'Plan',
          projectId: 'project-1',
          revisionId: 'revision-2',
        },
      ]),
    ).toEqual([{ id: 'artifact-1', type: 'artifact', revisionId: 'revision-2' }]);
  });

  it('maps only safe persisted metadata and never recreates a live desktop handle', () => {
    const message = mapRuntimeMessage({
      id: 'message-1',
      role: 'user',
      content: 'Review this.',
      canonical_metadata: {
        finishReason: 'length',
        _providerContinuity: {
          provider: 'openai-compatible',
          model_family: 'openai-compatible:openrouter:vendor/model',
          opaque_state: { response_id: 'private-provider-state' },
        },
        attachments: [
          {
            id: 'attachment-1',
            name: 'notes.txt',
            size: 123,
            extension: 'txt',
            destination: 'cloud',
            path: 'C:\\Users\\person\\secret.txt',
            handleId: 'expired-grant',
          },
        ],
        references: [
          {
            id: 'memory-1',
            type: 'memory',
            label: 'Writing preference',
            projectId: 'project-1',
          },
        ],
      },
    });

    expect(message.attachments).toEqual([
      {
        id: 'attachment-1',
        name: 'notes.txt',
        size: 123,
        extension: 'txt',
        destination: 'cloud',
      },
    ]);
    expect(message.attachments?.[0]).not.toHaveProperty('path');
    expect(message.attachments?.[0]).not.toHaveProperty('handleId');
    expect(message.references).toEqual([
      expect.objectContaining({
        id: 'memory-1',
        type: 'memory',
        label: 'Writing preference',
        projectId: 'project-1',
      }),
    ]);
    expect(message.finishReason).toBe('length');
    expect(message.modelFamily).toBe('openai-compatible:openrouter:vendor/model');
    expect(message).not.toHaveProperty('providerContinuity');
  });

  it('keeps reference choices inside the active privacy scope', () => {
    const references = scopedReferenceOptions({
      activeProjectId: 'project-1',
      activeConversationId: 'conversation-1',
      projects: [
        { id: 'project-1', name: 'One', description: '', archived: false },
        { id: 'project-2', name: 'Two', description: '', archived: false },
      ],
      tasks: [
        {
          id: 'task-1',
          title: 'In scope',
          detail: '',
          status: 'working',
          progress: 0,
          project: 'project-1',
          projectId: 'project-1',
          elapsed: '',
          steps: [],
        },
        {
          id: 'task-2',
          title: 'Out of scope',
          detail: '',
          status: 'working',
          progress: 0,
          project: 'project-2',
          projectId: 'project-2',
          elapsed: '',
          steps: [],
        },
      ],
      artifacts: [
        { id: 'artifact-1', projectId: 'project-1', name: 'One.md', kind: 'document' },
        { id: 'artifact-2', projectId: 'project-2', name: 'Two.md', kind: 'document' },
      ],
      memories: [
        {
          id: 'memory-global',
          type: 'Preference',
          title: 'Global',
          body: '',
          scope: 'About me',
          source: '',
          confidence: 1,
          enabled: true,
        },
        {
          id: 'memory-local',
          type: 'Decision',
          title: 'Local',
          body: '',
          scope: 'One',
          source: '',
          confidence: 1,
          enabled: true,
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
        {
          id: 'memory-other',
          type: 'Decision',
          title: 'Other',
          body: '',
          scope: 'Two',
          source: '',
          confidence: 1,
          enabled: true,
          projectId: 'project-2',
        },
      ],
    });

    expect(references.map((item) => item.id)).toEqual([
      'project-1',
      'task-1',
      'artifact-1',
      'memory-global',
      'memory-local',
    ]);
  });

  it('does not add optimistic user rows for history-changing actions', () => {
    expect(shouldOptimisticallyAppendUser(undefined)).toBe(true);
    expect(shouldOptimisticallyAppendUser('send')).toBe(true);
    expect(shouldOptimisticallyAppendUser('edit')).toBe(false);
    expect(shouldOptimisticallyAppendUser('retry')).toBe(false);
    expect(shouldOptimisticallyAppendUser('regenerate')).toBe(false);
    expect(shouldOptimisticallyAppendUser('continue')).toBe(false);
  });
});
