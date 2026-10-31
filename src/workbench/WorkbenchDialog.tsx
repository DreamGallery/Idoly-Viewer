import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

export function WorkbenchDialog({ open = true, className = '', title, description, children, onClose, onAfterClose }: {
  open?: boolean; className?: string; title: string; description: string; children: ReactNode; onClose: () => void;
  onAfterClose?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const restoreScroll = useRef<(() => void) | null>(null), afterClose = useRef(onAfterClose);
  const titleId = useId(), descriptionId = useId();
  useLayoutEffect(() => { afterClose.current = onAfterClose; }, [onAfterClose]);
  useLayoutEffect(() => {
    const element = dialog.current!;
    let active = true;
    element.dataset.state = open ? 'open' : 'closing';
    element.inert = !open;
    if (open && !element.open) {
      const overflow = document.body.style.overflow;
      restoreScroll.current = () => { document.body.style.overflow = overflow; };
      document.body.style.overflow = 'hidden';
      element.showModal();
    } else if (!open && element.open) {
      // Keep the modal and scroll lock until its CSS exit transition finishes.
      void Promise.allSettled(element.getAnimations().map(animation => animation.finished)).then(() => {
        if (!active) return;
        element.close();
        restoreScroll.current?.();
        restoreScroll.current = null;
        afterClose.current?.();
      });
    }
    return () => { active = false; };
  }, [open]);
  useLayoutEffect(() => {
    const element = dialog.current!;
    return () => {
      element.close();
      restoreScroll.current?.();
      restoreScroll.current = null;
    };
  }, []);
  return <dialog ref={dialog} className={`work-confirm-dialog ${className}`} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (open) onClose(); }}
    onClick={event => { if (open && event.target === event.currentTarget) onClose(); }}>
    <div className="work-confirm-content">
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      {children}
    </div>
  </dialog>;
}
