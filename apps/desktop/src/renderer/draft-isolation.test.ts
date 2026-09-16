import { describe, expect, it } from 'vitest';
import { draftGenerationIsCurrent, shouldRestoreFailedDraft } from './draft-isolation';

describe('composer draft isolation', () => {
  it('ignores an asynchronous failure after a new draft has started', () => {
    expect(
      shouldRestoreFailedDraft({
        accepted: true,
        sent: false,
        submittedGeneration: 4,
        currentGeneration: 5,
      }),
    ).toBe(false);
  });

  it('restores an accepted unsent message only in its original draft generation', () => {
    expect(
      shouldRestoreFailedDraft({
        accepted: true,
        sent: false,
        submittedGeneration: 5,
        currentGeneration: 5,
      }),
    ).toBe(true);
    expect(
      shouldRestoreFailedDraft({
        accepted: false,
        sent: false,
        submittedGeneration: 5,
        currentGeneration: 5,
      }),
    ).toBe(false);
  });

  it('recognizes only the currently mounted composer generation', () => {
    expect(draftGenerationIsCurrent(2, 2)).toBe(true);
    expect(draftGenerationIsCurrent(2, 3)).toBe(false);
  });
});
