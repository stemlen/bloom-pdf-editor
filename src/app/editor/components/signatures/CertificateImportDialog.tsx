'use client';

import { joinParts } from '@/lib/format';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Upload, KeyRound, Trash2, Check } from 'lucide-react';
import {
  getCertificateManager,
  formatCertificateSummary,
  type ManagedIdentity,
} from '@/engine';

interface CertificateImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after import / selection / remove so the parent can refresh. */
  onChange?: (identities: ManagedIdentity[]) => void;
}

export function CertificateImportDialog({
  open,
  onOpenChange,
  onChange,
}: CertificateImportDialogProps) {
  const [identities, setIdentities] = useState<ManagedIdentity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pemPaste, setPemPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const mgr = getCertificateManager();
    const list = mgr.list();
    setIdentities(list);
    setSelectedId(mgr.getSelected()?.id ?? null);
    onChange?.(list);
  }, [onChange]);

  // Reset only when the dialog opens. `refresh` changes whenever the parent
  // re-renders (new onChange), and must not wipe a paste or error mid-import.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setError(null);
      setPassword('');
      setPemPaste('');
    }
  }
  useEffect(() => {
    if (!open) return;
    // Hydrate may be async on first open
    const t = window.setTimeout(() => refreshRef.current(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const select = (id: string) => {
    getCertificateManager().select(id);
    setSelectedId(id);
    onChange?.(getCertificateManager().list());
  };

  const remove = (id: string) => {
    getCertificateManager().remove(id);
    refresh();
  };

  const importFile = async (file: File, filePassword = '') => {
    setBusy(true);
    setError(null);
    try {
      const identity = await getCertificateManager().importFile(file, filePassword);
      setSelectedId(identity.id);
      setPendingFile(null);
      setPassword('');
      refresh();
    } catch (err) {
      // Password-protected .p12/.pfx: keep the file and ask for its password.
      if (err instanceof Error && err.name === 'Pkcs12PasswordError') setPendingFile(file);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importPem = async () => {
    if (!pemPaste.trim()) {
      setError('Paste a PEM certificate and/or private key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identity = await getCertificateManager().importPem(pemPaste.trim());
      setSelectedId(identity.id);
      setPemPaste('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-[var(--scrim)] backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[min(520px,94vw)] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-[0_24px_64px_-16px_rgba(0,0,0,0.3)] animate-scale-in flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <Dialog.Title className="text-sm font-semibold text-foreground flex items-center gap-2">
              <KeyRound size={16} /> Certificates
            </Dialog.Title>
            <Dialog.Close className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="p-4 space-y-4 overflow-y-auto flex-1">
            <p className="text-[11px] text-muted-foreground">
              Import a PEM, DER, or password-protected P12/PFX file. Private keys stay in memory for this
              session only.
            </p>

            <div className="space-y-2">
              <label className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                Import file
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".pem,.crt,.cer,.der,.p12,.pfx,.key"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary hover:bg-bloom-600 disabled:opacity-50 text-white text-xs font-semibold"
              >
                <Upload size={14} /> Browse
              </button>
              {pendingFile && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void importFile(pendingFile, password);
                  }}
                >
                  <input
                    type="password"
                    autoFocus
                    aria-label={`Password for ${pendingFile.name}`}
                    placeholder={`Password for ${pendingFile.name}`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="flex-1 min-w-0 rounded-md bg-muted border border-border px-2 py-1.5 text-xs text-foreground outline-none focus:border-border-strong"
                  />
                  <button
                    type="submit"
                    disabled={busy || !password}
                    className="px-3 py-1.5 rounded-md bg-primary hover:bg-bloom-600 disabled:opacity-50 text-white text-xs font-semibold"
                  >
                    Unlock
                  </button>
                </form>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                Or paste PEM
              </label>
              <textarea
                value={pemPaste}
                aria-label="Paste PEM"
                onChange={(e) => setPemPaste(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----BEGIN PRIVATE KEY-----&#10;…"
                rows={5}
                className="w-full rounded-md bg-muted border border-border px-2 py-1.5 text-[11px] font-mono text-foreground outline-none focus:border-border-strong resize-y"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void importPem()}
                className="w-full py-1.5 rounded-md bg-muted border border-border hover:bg-border disabled:opacity-50 text-foreground text-xs font-semibold"
              >
                Import PEM
              </button>
            </div>

            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                Available identities
              </div>
              {identities.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No certificates imported yet.</p>
              )}
              {identities.map((id) => {
                const active = selectedId === id.id;
                const summary = id.leaf
                  ? formatCertificateSummary(id.leaf)
                  : id.label;
                return (
                  <div
                    key={id.id}
                    className={`rounded-lg border p-2.5 cursor-pointer transition-colors ${
                      active
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-border hover:border-border-strong bg-muted'
                    }`}
                    onClick={() => select(id.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-foreground truncate flex items-center gap-1.5">
                          {active && <Check size={12} className="text-emerald-600 dark:text-emerald-400 shrink-0" />}
                          {id.label}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{summary}</div>
                        <div className="text-[10px] text-app-faint mt-1">
                          {joinParts(
                            id.source.toUpperCase(),
                            id.hasPrivateKey ? 'Ready to sign' : 'Certificate only — import its private key to sign',
                            id.certificates.length > 1 && `Chain of ${id.certificates.length} certificates`,
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        title="Remove"
                        className="p-1 rounded text-muted-foreground hover:text-red-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(id.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-3 border-t border-border flex justify-end">
            <Dialog.Close className="px-4 py-1.5 rounded-md bg-muted hover:bg-border text-foreground text-xs font-semibold">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
