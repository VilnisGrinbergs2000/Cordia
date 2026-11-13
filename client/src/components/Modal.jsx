import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  width = 480,
  footer,
  headless = false,
  hideClose = false,
  className = '',
  ariaLabel
}) {
  const dialogRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape' && !hideClose) onClose?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, hideClose]);

  // Move focus into the dialog on open and hand it back to the trigger on
  // close, so keyboard and screen-reader users are not dropped at the top of
  // the page behind it.
  useEffect(() => {
    const node = dialogRef.current;
    const active = document.activeElement;
    // Kept in a ref so a re-run (StrictMode, remount) still hands focus back to
    // the original trigger rather than to this dialog's own first control.
    if (active && active !== document.body && !node?.contains(active)) {
      restoreRef.current = active;
    }
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector(FOCUSABLE);
      if (first) first.focus();
      else node.focus();
    }
    return () => {
      const target = restoreRef.current;
      if (target && document.contains(target)) target.focus();
    };
  }, []);

  // aria-modal on its own does not stop Tab from walking into the page behind
  // the dialog, so the cycle is closed by hand.
  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const items = Array.from(node.querySelectorAll(FOCUSABLE));
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !hideClose && onClose?.()
      }
    >
      <div
        ref={dialogRef}
        className={`modal ${className}`.trim()}
        style={{ '--modal-width': `${width}px` }}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title || 'Dialog'}
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        {!headless && (
          <div className="modal-head">
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            {!hideClose && (
              <button className="icon-btn" onClick={onClose} aria-label="Close">
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
