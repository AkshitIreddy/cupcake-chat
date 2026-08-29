import { describe, expect, it } from 'vitest';
import {
  mapRuntimeMessage,
  scopedReferenceOptions,
  shouldOptimisticallyAppendUser,
  structuredAttachments,
  structuredReferences,
} from './workspace';

describe('workspace attachment and reference contracts', () => {
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
