'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Info } from 'lucide-react';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action. */
  destructive?: boolean;
}

interface PendingRequest extends ConfirmOptions {
  kind: 'confirm' | 'notice';
  resolve: (ok: boolean) => void;
}

let current: PendingRequest | null = null;
const listeners = new Set<(req: PendingRequest | null) => void>();

function publish(req: PendingRequest | null) {
  current = req;
  listeners.forEach((fn) => fn(req));
}

function request(kind: PendingRequest['kind'], opts: ConfirmOptions): Promise<boolean> {
  // A newer request replaces one still open; the old one counts as cancelled.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => publish({ ...opts, kind, resolve }));
}

/** In-app replacement for window.confirm(). Resolves true only when the user confirms. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return request('confirm', opts);
}

/** In-app replacement for window.alert(). Resolves when the user dismisses it. */
export function noticeDialog(opts: Omit<ConfirmOptions, 'cancelLabel' | 'destructive'>): Promise<void> {
  return request('notice', opts).then(() => undefined);
}

/** Renders the confirm/notice dialog. Mount once in the editor. */
export function ConfirmDialogHost() {
  const [req, setReq] = useState<PendingRequest | null>(current);

  useEffect(() => {
    listeners.add(setReq);
    return () => {
      listeners.delete(setReq);
    };
  }, []);

  const finish = (ok: boolean) => {
    if (!req) return;
    req.resolve(ok);
    if (current === req) publish(null);
  };

  const isNotice = req?.kind === 'notice';
  const Icon = isNotice ? Info : AlertTriangle;

  return (
    <Dialog.Root open={!!req} onOpenChange={(next) => { if (!next) finish(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-[var(--scrim)] backdrop-blur-sm" />
        <Dialog.Content
          data-testid="confirm-dialog"
          className="fixed left-1/2 top-1/2 z-[91] w-[min(420px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-5 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.3)] animate-scale-in space-y-4"
        >
          <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Icon
              size={16}
              className={req?.destructive ? 'text-red-500' : isNotice ? 'text-primary' : 'text-amber-600 dark:text-amber-400'}
            />
            {req?.title}
          </Dialog.Title>
          {req?.description ? (
            <Dialog.Description className="text-[13px] leading-relaxed text-muted-foreground">
              {req.description}
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{req?.title}</Dialog.Description>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {!isNotice && (
              <button
                type="button"
                onClick={() => finish(false)}
                className="rounded-lg border border-border bg-panel-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
              >
                {req?.cancelLabel ?? 'Cancel'}
              </button>
            )}
            <button
              type="button"
              autoFocus
              data-testid="confirm-dialog-ok"
              onClick={() => finish(true)}
              className={
                req?.destructive
                  ? 'rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500'
                  : 'rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:brightness-105'
              }
            >
              {req?.confirmLabel ?? (isNotice ? 'OK' : 'Continue')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
