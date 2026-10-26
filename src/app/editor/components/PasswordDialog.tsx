'use client';

import { useState, useCallback, FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { LockDoodle } from '@/components/art/Illustrations';

interface PasswordDialogProps {
  fileName?: string;
  error?: string | null;
  isVerifying?: boolean;
  onSubmit: (password: string) => void;
  onCancel?: () => void;
}

/**
 * Prompt for PDF open password (Security Engine Phase 3 UI).
 */
export function PasswordDialog({
  fileName,
  error,
  isVerifying,
  onSubmit,
  onCancel,
}: PasswordDialogProps) {
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      onSubmit(password);
    },
    [onSubmit, password],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background bg-paper p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 sm:p-7 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.35)] animate-scale-in"
      >
        <LockDoodle className="mx-auto mb-2 w-28 h-28 text-primary" />
        <div className="mb-5 text-center">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-foreground">Password required</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground text-balance">
              {fileName ? (
                <>
                  {/* Only a long file name may wrap mid-word; the rest wraps at spaces. */}
                  <span className="[overflow-wrap:anywhere]">&quot;{fileName}&quot;</span> is encrypted
                </>
              ) : (
                'This PDF is encrypted'
              )}
            </p>
          </div>
        </div>

        <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-muted-foreground" htmlFor="pdf-password">
          Document password
        </label>
        <input
          id="pdf-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-3 w-full h-11 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          placeholder="Enter password"
          disabled={isVerifying}
        />

        {error && (
          <p className="mb-3 text-xs font-medium text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isVerifying}
              className="h-10 rounded-xl px-4 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={isVerifying}
            className="inline-flex items-center gap-2 h-10 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground hover:brightness-105 disabled:opacity-60 shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)] transition-all"
          >
            {isVerifying ? <Loader2 size={14} className="animate-spin" /> : null}
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}
