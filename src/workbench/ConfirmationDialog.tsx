import { useState } from 'react';
import { WorkbenchDialog } from './WorkbenchDialog';

export type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel: string;
};

export function ConfirmationDialog({ title, description, confirmLabel, onResolve }: ConfirmationOptions & {
  onResolve: (confirmed: boolean) => void;
}) {
  const [result, setResult] = useState<boolean | null>(null);
  return <WorkbenchDialog open={result === null} title={title} description={description} onClose={() => setResult(false)}
    onAfterClose={() => { if (result !== null) onResolve(result); }}>
      <div className="work-confirm-actions">
        <button type="button" autoFocus onClick={() => setResult(false)}>取消</button>
        <button type="button" className="work-primary" onClick={() => setResult(true)}>{confirmLabel}</button>
      </div>
  </WorkbenchDialog>;
}
