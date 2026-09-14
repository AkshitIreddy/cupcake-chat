import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/** App-owned timing, instead of the platform's slow native title hover. */
export function Tooltips() {
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let closing: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    let active: HTMLElement | null = null;
    const clear = () => {
      clearTimeout(pending);
      clearTimeout(closing);
    };
    const dismiss = () => {
      clear();
      active = null;
      shown = false;
      setTip(null);
    };
    const show = (target: EventTarget | null, delay: number) => {
      const anchor =
        target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
      if (anchor === active) {
        clear();
        if (shown) return;
      } else dismiss();
      if (!anchor?.dataset.tooltip?.trim()) return;
      active = anchor;
      pending = setTimeout(() => {
        if (anchor.isConnected) {
          shown = true;
          setTip({ anchor, text: anchor.dataset.tooltip! });
        }
      }, delay);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (event.target instanceof Node && bubble.current?.contains(event.target)) {
        clearTimeout(closing);
        return;
      }
      show(event.target, 150);
    };
    const out = (event: PointerEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        (active?.contains(event.relatedTarget) || bubble.current?.contains(event.relatedTarget))
      )
        return;
      clear();
      closing = setTimeout(dismiss, 90);
    };
    const focus = (event: FocusEvent) => show(event.target, 0);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', dismiss);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      clear();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', dismiss);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !bubble.current) return;
    const { anchor } = tip;
    const rect = anchor.getBoundingClientRect();
    const bounds = bubble.current.getBoundingClientRect();
    const theme = getComputedStyle(anchor);
    setPosition({
      left: Math.max(
        8,
        Math.min(
          rect.left + rect.width / 2 - bounds.width / 2,
          window.innerWidth - bounds.width - 8,
        ),
      ),
      top:
        rect.bottom + bounds.height + 16 <= window.innerHeight
          ? rect.bottom + 8
          : Math.max(8, rect.top - bounds.height - 8),
      background: theme.getPropertyValue('--paper'),
      color: theme.getPropertyValue('--cocoa'),
      borderColor: theme.getPropertyValue('--line'),
    });
    const describedBy = anchor.getAttribute('aria-describedby');
    anchor.setAttribute(
      'aria-describedby',
      [describedBy, 'cupcake-tooltip'].filter(Boolean).join(' '),
    );
    return () => {
      if (describedBy === null) anchor.removeAttribute('aria-describedby');
      else anchor.setAttribute('aria-describedby', describedBy);
    };
  }, [tip]);

  return tip
    ? createPortal(
        <div
          ref={bubble}
          id="cupcake-tooltip"
          role="tooltip"
          className="cupcake-tooltip"
          style={position}
        >
          {tip.text}
        </div>,
        document.body,
      )
    : null;
}
