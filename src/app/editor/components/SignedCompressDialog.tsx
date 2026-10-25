'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert } from 'lucide-react';

export type SignedCompressChoice = 'compress' | 'signed' | 'cancel';

interface SignedCompressDialogProps {
  open: boolean;
  onChoose: (choice: SignedCompressChoice) => void;
}

/** Asks before a compressed download rewrites (and so unsigns) a signed PDF (BE-503). */
export function SignedCompressDialog({ open, onChoose }: SignedCompressDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onChoose('cancel'); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-[var(--scrim)] backdrop-blur-sm" />
        <Dialog.Content
          data-testid="signed-compress-dialog"
          className="fixed left-1/2 top-1/2 z-[81] w-[min(440px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-5 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.3)] animate-scale-in space-y-4"
        >
          <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldAlert size={16} className="text-amber-600 dark:text-amber-400" />
            This PDF is digitally signed
          </Dialog.Title>
          <Dialog.Description className="text-[13px] leading-relaxed text-muted-foreground">
            Compressing rewrites the file, which removes the digital signature. To keep the signature valid,
            download the signed file without compression.
          </Dialog.Description>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => onChoose('compress')}
              className="rounded-lg border border-border bg-panel-elevated px-3 py-2 text-xs font-semibold text-foreground hover:border-red-500/60"
            >
              Compress and remove signature
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => onChoose('signed')}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:brightness-105"
            >
              Download signed file
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
