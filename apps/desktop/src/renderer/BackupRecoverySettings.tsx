import { useState } from 'react';
import type { BackupRestoreReceipt } from './workspace';

export function BackupRecoverySettings({
  fixtureMode,
  onVerify,
}: {
  fixtureMode: boolean;
  onVerify: () => Promise<BackupRestoreReceipt | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<BackupRestoreReceipt | null>(null);
  const [error, setError] = useState('');

  async function verify() {
    setBusy(true);
    setError('');
    setReceipt(null);
    try {
      const result = await onVerify();
      if (result) setReceipt(result);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The backup could not be authenticated and opened for recovery.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="setting-row">
        <span>
          <strong>Verify a backup</strong>
          <small>
            Open an encrypted backup in an isolated recovery profile and check every stored file.
            Your current workspace is not replaced.
          </small>
        </span>
        <button
          type="button"
          className="button"
          disabled={fixtureMode || busy}
          onClick={() => void verify()}
        >
          {busy ? 'Opening and checking…' : 'Choose backup'}
        </button>
      </div>
      {fixtureMode && (
        <p className="security-note">
          Open the packaged app to verify a backup against the Windows-protected profile key.
        </p>
      )}
      {receipt && (
        <p className="field-message" role="status">
          Backup verified · {receipt.verifiedContainerPayloads} encrypted payloads ·{' '}
          {receipt.runtimeVerification.reachableObjects} stored files · database integrity OK. The
          recovery profile is isolated and the active workspace is unchanged. This build does not
          switch workspaces automatically.
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
