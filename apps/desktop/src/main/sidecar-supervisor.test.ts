import { describe, expect, it } from 'vitest';
import { safeLog } from './sidecar-supervisor';

describe('sidecar diagnostic redaction', () => {
  it('redacts a synthetic NVIDIA NIM credential wherever it appears', () => {
    const canary = 'nvapi-synthetic-electron-canary-1234567890';
    const output = safeLog(`provider error for ${canary}`);

    expect(output).not.toContain(canary);
    expect(output).toBe('provider error for [redacted]');
  });
});
