import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function FormDialog({
  open,
  eyebrow,
  title,
  description,
  submitLabel,
  pendingLabel = 'Saving…',
  pending = false,
  error,
  children,
  onClose,
  onSubmit,
}: {
  open: boolean;
  eyebrow?: string;
  title: string;
  description?: string;
  submitLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  error?: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const pendingRef = useRef(pending);
  closeRef.current = onClose;
  pendingRef.current = pending;

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    window.setTimeout(() => {
      const autofocus = dialog?.querySelector<HTMLElement>('[autofocus]');
      const firstField = dialog?.querySelector<HTMLElement>(
        'input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      );
      const fallback = dialog?.querySelector<HTMLElement>('button:not(:disabled)');
      (autofocus ?? firstField ?? fallback)?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dialog) return;
      if (event.key === 'Escape' && !pendingRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [open]);

  if (!open) return null;
  const describedBy = [description ? descriptionId : '', error ? errorId : '']
    .filter(Boolean)
    .join(' ');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pending) void onSubmit();
  };

  return createPortal(
    <div
      className="form-dialog-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy || undefined}
        aria-busy={pending}
      >
        <header className="form-dialog__header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            disabled={pending}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {description && (
          <p className="form-dialog__description" id={descriptionId}>
            {description}
          </p>
        )}
        <form onSubmit={submit}>
          <div className="form-dialog__fields">{children}</div>
          {error && (
            <p className="form-dialog__error" id={errorId} role="alert">
              {error}
            </p>
          )}
          <footer className="form-dialog__actions">
            <button type="button" className="button" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={pending}>
              {pending ? pendingLabel : submitLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
