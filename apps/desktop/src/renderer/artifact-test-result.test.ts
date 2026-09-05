import { describe, expect, it } from 'vitest';

import { summarizeArtifactTestEvidence } from './artifact-test-result';

describe('summarizeArtifactTestEvidence', () => {
  it('reports a completed suite with test errors as a finished test result', () => {
    const summary = summarizeArtifactTestEvidence({
      exitStatus: 1,
      stdout: '',
      stderr: "Ran 8 tests\nFAILED (errors=1)\nKeyError: 'A17'",
      testSummary: { run: 8, failures: 0, errors: 1, skipped: 0, successful: false },
    });

    expect(summary).toEqual({
      completed: true,
      headline: '7 of 8 tests passed',
      detail: 'The test run finished with 1 error. Open the output to see what needs attention.',
      output: "Ran 8 tests\nFAILED (errors=1)\nKeyError: 'A17'",
    });
  });

  it('keeps infrastructure failures separate when there is no native test summary', () => {
    expect(
      summarizeArtifactTestEvidence({
        exitStatus: null,
        stderr: 'The isolated environment could not start.',
      }),
    ).toEqual({
      completed: false,
      headline: 'Tests could not run',
      detail: '',
      output: 'The isolated environment could not start.',
    });
  });
});
