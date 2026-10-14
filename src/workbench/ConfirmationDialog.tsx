import { useEffect, useId, useRef } from 'react';

export type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel: string;
};

export function ConfirmationDialog({ title, description, confirmLabel, onResolve }: ConfirmationOptions & {
  onResolve: (confirmed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
    };
  }, []);
  return <dialog ref={dialog} className="work-confirm-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onResolve(false); }}
    onClick={event => { if (event.target === event.currentTarget) onResolve(false); }}>
    <div className="work-confirm-content">
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      <div className="work-confirm-actions">
        <button type="button" autoFocus onClick={() => onResolve(false)}>取消</button>
        <button type="button" className="work-primary" onClick={() => onResolve(true)}>{confirmLabel}</button>
      </div>
    </div>
  </dialog>;
}
