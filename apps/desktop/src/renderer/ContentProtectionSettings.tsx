import { useEffect, useState } from 'react';
import { Icon } from './icons';

interface ProtectionStatus {
  mode: 'encrypted' | 'plaintext';
  databaseEncrypted: boolean;
  objectsEncrypted: boolean;
  credentialsProtected: boolean;
  requiresRestart?: boolean;
  retainedEncryptedRollbackCopies?: number;
}

export function ContentProtectionSettings({
  fixtureMode,
  onUpdated,
}: {
  fixtureMode: boolean;
  onUpdated: () => Promise<void>;
}) {
  const [status, setStatus] = useState<ProtectionStatus | null>(null);
  const [choice, setChoice] = useState<'encrypted' | 'plaintext'>('encrypted');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function request(method: string, params?: unknown) {
    const response = await window.cupcake?.runtime.request<ProtectionStatus>({
      method,
      params,
      timeoutMs: 180_000,
    });
    if (!response?.ok || !response.result)
      throw new Error(
        response?.error?.message ??
          'Content protection did not respond. Reopen Settings to check the active protection mode.',
      );
    return response.result;
  }
  useEffect(() => {
    if (fixtureMode) return;
    let active = true;
    void request('content_protection.status')
      .then((value) => {
        if (active) {
          setStatus(value);
          setChoice(value.mode);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Could not read content protection.');
      });
    return () => {
      active = false;
    };
  }, [fixtureMode]);
  const apply = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request('content_protection.set', { mode: choice });
      // The trusted broker restarts its private runtime after activating the verified generation.
      const value = await request('content_protection.status');
      setStatus(value);
      setChoice(value.mode);
      await onUpdated();
      setMessage(
        value.mode === 'plaintext'
          ? 'Content encryption is off. Provider keys remain protected by Windows.'
          : 'Content encryption is on. Your workspace still opens without a password unless you enable its lock.',
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The change could not finish. Reopen Settings to check the active protection mode.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section content-protection">
      <header>
        <h2>Content encryption</h2>
        <p>
          Choose how the main workspace database and CupcakeAI-managed file and artifact copies are
          stored on this computer. This is separate from the optional password prompt.
        </p>
      </header>
      {fixtureMode ? (
        <p className="security-note">
          The preview cannot inspect or change a Windows workspace. Open the packaged app to manage
          content encryption.
        </p>
      ) : (
        <>
          <div className="protection-choices" role="group" aria-label="Content encryption mode">
            {(['encrypted', 'plaintext'] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                disabled={!status || busy}
                aria-pressed={choice === mode}
                className={choice === mode ? 'is-selected' : ''}
                onClick={() => {
                  setChoice(mode);
                  setMessage('');
                }}
              >
                <Icon name={mode === 'encrypted' ? 'shield' : 'file'} />
                <span>
                  <strong>{mode === 'encrypted' ? 'Encryption on' : 'Encryption off'}</strong>
                  <small>
                    {mode === 'encrypted'
                      ? 'Protect stored content with your Windows profile.'
                      : 'Store readable content without at-rest encryption.'}
                  </small>
                </span>
                {status?.mode === mode && <em>Active</em>}
              </button>
            ))}
          </div>
          {!status && !error && <p role="status">Checking the active content store…</p>}
          {status && choice !== status.mode && (
            <div className="protection-review">
              <strong>
                {choice === 'plaintext'
                  ? 'Your content will be readable on disk'
                  : 'CupcakeAI will migrate your content to an encrypted store'}
              </strong>
              <p>
                {choice === 'plaintext'
                  ? 'Anyone or any program with access to these files can read them. API keys stay protected by Windows. The app verifies a separate copy before switching stores.'
                  : 'The app verifies a separate encrypted copy before switching stores. Existing exported files and backups keep their original protection; encryption does not erase earlier copies.'}
              </p>
              <p>
                Finish active chats and tasks first. Keep CupcakeAI open while the change is
                applied.
              </p>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                {busy
                  ? 'Migrating content…'
                  : choice === 'plaintext'
                    ? 'Turn off content encryption'
                    : 'Turn on content encryption'}
              </button>
            </div>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="field-message" role="status">
              {message}
            </p>
          )}
          {status?.mode === 'plaintext' && (status.retainedEncryptedRollbackCopies ?? 0) > 0 && (
            <p className="security-note">
              CupcakeAI retained {status.retainedEncryptedRollbackCopies} encrypted rollback{' '}
              {status.retainedEncryptedRollbackCopies === 1 ? 'copy' : 'copies'}. These copies are
              not active or readable without your Windows-protected profile key.
            </p>
          )}
        </>
      )}
      <div className="security-note">
        <Icon name="info" />
        <p>
          Provider credentials remain protected by Windows in either mode. Turning encryption on
          does not add a password prompt. Workflow checkpoints, permission and audit data, and
          developer diagnostics are separate stores and are not changed by this control.
        </p>
      </div>
    </section>
  );
}
