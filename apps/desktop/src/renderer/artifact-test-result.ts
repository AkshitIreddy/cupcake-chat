export interface ArtifactTestResultSummary {
  completed: boolean;
  headline: string;
  detail: string;
  output: string;
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function summarizeArtifactTestEvidence(
  evidence: Record<string, unknown> | undefined,
): ArtifactTestResultSummary {
  const testSummary = record(evidence?.testSummary);
  const run = nonNegativeCount(testSummary?.run ?? testSummary?.total);
  const errors = nonNegativeCount(testSummary?.errors) ?? 0;
  const failures = nonNegativeCount(testSummary?.failures) ?? 0;
  const skipped = nonNegativeCount(testSummary?.skipped) ?? 0;
  const stdout = typeof evidence?.stdout === 'string' ? evidence.stdout.trim() : '';
  const stderr = typeof evidence?.stderr === 'string' ? evidence.stderr.trim() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n\n');

  if (run === null) {
    return {
      completed: false,
      headline: 'Tests could not run',
      detail: '',
      output,
    };
  }

  if (run === 0) {
    return {
      completed: true,
      headline: 'No tests were found',
      detail: 'The local Python environment started, but this file did not define any tests.',
      output,
    };
  }

  const passed = Math.max(0, run - errors - failures - skipped);
  const issues = [
    errors ? countLabel(errors, 'error') : '',
    failures ? countLabel(failures, 'failure') : '',
    skipped ? countLabel(skipped, 'skipped test') : '',
  ].filter(Boolean);
  if (errors || failures) {
    return {
      completed: true,
      headline: `${passed} of ${run} tests passed`,
      detail: `The test run finished with ${issues.join(' and ')}. Open the output to see what needs attention.`,
      output,
    };
  }
  if (skipped) {
    return {
      completed: true,
      headline: `${passed} of ${run} tests passed`,
      detail: `The test run finished with ${countLabel(skipped, 'skipped test')}.`,
      output,
    };
  }
  return {
    completed: true,
    headline: `${run} ${run === 1 ? 'test' : 'tests'} passed`,
    detail: 'The saved revision finished in the isolated local Python environment.',
    output,
  };
}
