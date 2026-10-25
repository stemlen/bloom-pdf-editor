'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Shield,
  Lock,
  Unlock,
  FileSearch,
  Eraser,
  Sparkles,
  ScrollText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PanelLeftClose,
} from 'lucide-react';
import type { PDFDocumentData, FullSecurityReport } from '@/engine';

interface SecurityPanelProps {
  doc: PDFDocumentData | null;
  engine: typeof import('@/engine') | null;
  onDocChange: (doc: PDFDocumentData) => void;
  markDirty?: () => void;
  onClose?: () => void;
  isMobile?: boolean;
}

type Tab = 'inspect' | 'protect' | 'sanitize' | 'policies';

export function SecurityPanel({ doc, engine, onDocChange, markDirty, onClose, isMobile = false }: SecurityPanelProps) {
  const [tab, setTab] = useState<Tab>('inspect');
  const [report, setReport] = useState<FullSecurityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [algorithm, setAlgorithm] = useState<'AES-256' | 'AES-128' | 'RC4-128'>('AES-256');
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowModify, setAllowModify] = useState(false);
  const [policyName, setPolicyName] = useState('Confidential');
  const [policies, setPolicies] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!doc || !engine) return;
    try {
      const full = await engine.securityEngine.inspector.inspectFull(doc);
      setReport(full);
      setPolicies(engine.securityEngine.policy.listPolicies());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [doc, engine]);

  // Inspect whenever the document changes; ignore results for a stale document.
  useEffect(() => {
    if (!doc || !engine) return;
    let cancelled = false;
    engine.securityEngine.inspector
      .inspectFull(doc)
      .then((full) => {
        if (cancelled) return;
        setReport(full);
        setPolicies(engine.securityEngine.policy.listPolicies());
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [doc, engine]);

  const run = useCallback(async (fn: () => Promise<string>) => {
    if (!doc || !engine) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const msg = await fn();
      onDocChange(doc);
      markDirty?.();
      setMessage(msg);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [doc, engine, onDocChange, markDirty, refresh]);

  if (!doc || !engine) {
    return (
      <div className="w-72 bg-card border-r border-border p-4 text-xs text-muted-foreground">
        Load a PDF to manage security.
      </div>
    );
  }

  return (
    <>
      {isMobile && (
        <div className="fixed inset-0 z-40 mobile-backdrop" onClick={onClose} />
      )}
      <div className={isMobile
        ? 'fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-2xl border-t border-border flex flex-col overflow-hidden mobile-sheet-up shadow-[0_-8px_40px_rgba(0,0,0,0.15)]'
        : 'w-72 bg-card border-r border-border flex flex-col shrink-0 z-10 overflow-hidden min-h-0 h-full'
      } style={isMobile ? { maxHeight: '65vh' } : undefined} data-testid="security-panel">
      <div className="p-4 pb-2 border-b border-app">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] font-bold tracking-wider text-foreground uppercase">
            <Shield size={14} className="text-emerald-600 dark:text-emerald-400" />
            Document Security
          </div>
          {onClose && (
            <button
              onClick={onClose}
              title="Hide sidebar panel"
              className="text-app-muted hover:text-app p-1 rounded-lg hover:bg-panel-elevated transition-colors"
            >
              <PanelLeftClose size={14} />
            </button>
          )}
        </div>
        {report && (
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-app-muted">Score</span>
            <span className={`font-semibold ${report.score >= 70 ? 'text-emerald-500' : report.score >= 40 ? 'text-amber-600 dark:text-amber-400' : 'text-red-500'}`}>
              {report.score}/100
            </span>
          </div>
        )}
      </div>

      <div className="flex border-b border-app text-[10px]">
        {([
          ['inspect', 'Inspect'],
          ['protect', 'Protect'],
          ['sanitize', 'Clean'],
          ['policies', 'Policy'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 py-2.5 font-semibold uppercase tracking-wide transition-colors ${
              tab === id ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
        {tab === 'inspect' && report && (
          <>
            <Row label="Encryption" value={report.encrypted ? `${report.handler} / ${report.algorithm ?? '?'}` : 'None'} />
            <Row label="Revision" value={report.revision != null ? String(report.revision) : '—'} />
            <Row label="Metadata" value={report.metadata.hasInfo || report.metadata.hasXmp ? 'Present' : 'Clean'} />
            <Row label="Attachments" value={String(report.embeddedFiles.count)} />
            <Row label="JavaScript" value={report.javascript.present ? 'Detected' : 'None'} warn={report.javascript.present} />
            <Row label="Integrity" value={report.integrity.ok ? 'OK' : `${report.integrity.issueCount} issue(s)`} warn={!report.integrity.ok} />
            <Row label="Redact marks" value={String(report.redactionMarks)} />

            <div className="pt-2 space-y-1.5">
              <div className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Recommendations</div>
              {report.recommendations.map((r) => (
                <div key={r} className="flex gap-2 text-app-muted leading-relaxed">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                  <span>{r}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                await engine.securityEngine.integrity.scan(doc);
                return 'Integrity scan complete';
              })}
              className="w-full mt-2 flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app font-medium"
            >
              <FileSearch size={14} /> Rescan
            </button>
          </>
        )}

        {tab === 'protect' && (
          <>
            <label className="block text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">User password</label>
            <input
              type="password"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app outline-none focus:border-primary"
              placeholder="Optional open password"
            />
            <label className="block text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Owner password</label>
            <input
              type="password"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app outline-none focus:border-primary"
              placeholder="Required for permissions"
            />
            <label className="block text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Algorithm</label>
            <select
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as typeof algorithm)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app"
            >
              <option value="AES-256">AES-256 (recommended)</option>
              <option value="AES-128">AES-128</option>
              <option value="RC4-128">RC4-128 (legacy)</option>
            </select>

            <div className="space-y-2 pt-1">
              <Toggle label="Allow print" checked={allowPrint} onChange={setAllowPrint} />
              <Toggle label="Allow copy" checked={allowCopy} onChange={setAllowCopy} />
              <Toggle label="Allow modify" checked={allowModify} onChange={setAllowModify} />
            </div>

            <button
              type="button"
              disabled={busy || engine.securityEngine.isEncrypted(doc)}
              onClick={() => run(async () => {
                await engine.securityEngine.encrypt(doc, {
                  userPassword,
                  ownerPassword: ownerPassword || userPassword || 'owner',
                  algorithm,
                  permissions: {
                    print: allowPrint,
                    printHighQuality: allowPrint,
                    copy: allowCopy,
                    modify: allowModify,
                    annotate: allowModify,
                    fillForms: true,
                    accessibility: true,
                    assemble: allowModify,
                  },
                });
                return 'Document encrypted';
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary hover:brightness-105 disabled:opacity-50 py-2.5 text-primary-foreground font-bold shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)]"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              Encrypt PDF
            </button>

            {engine.securityEngine.isEncrypted(doc) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(async () => {
                  await engine.securityEngine.decrypt(doc, userPassword);
                  return 'Document decrypted (Encrypt dict removed)';
                })}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
              >
                <Unlock size={14} /> Remove encryption
              </button>
            )}
          </>
        )}

        {tab === 'sanitize' && (
          <>
            <p className="text-app-faint leading-relaxed">
              Remove metadata, JavaScript, attachments, and unused objects.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const r = await engine.securityEngine.sanitization.sanitize(doc);
                return r.report.join(' · ') || 'Sanitized';
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary hover:brightness-105 py-2.5 text-primary-foreground font-bold shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)]"
            >
              <Eraser size={14} /> Sanitize document
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                engine.securityEngine.javascript.removeJavaScript(doc);
                return 'JavaScript / risky actions removed';
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              Remove JavaScript
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const n = engine.securityEngine.embeddedFiles.removeAllAttachments(doc);
                return `Removed ${n} attachment(s)`;
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              Remove attachments
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                engine.securityEngine.metadata.stripMetadata(doc);
                return 'Metadata stripped';
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              Strip metadata
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const r = await engine.securityEngine.optimizer.optimizeWithReport(doc);
                return r.notes.join(' · ');
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              <Sparkles size={14} /> Optimize (keep security)
            </button>
          </>
        )}

        {tab === 'policies' && (
          <>
            <label className="block text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">Policy</label>
            <select
              value={policyName}
              onChange={(e) => setPolicyName(e.target.value)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app"
            >
              {policies.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <p className="text-app-faint leading-relaxed">
              {engine.securityEngine.policy.getPolicy(policyName)?.description}
            </p>
            <p className="text-[10px] text-app-faint leading-relaxed">
              Policies that encrypt use built-in sample passwords — set your own via Protect tab for production use.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                await engine.securityEngine.policy.applyPolicy(doc, policyName, {
                  userPassword: userPassword || undefined,
                  ownerPassword: ownerPassword || undefined,
                });
                return `Applied policy: ${policyName}`;
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary hover:brightness-105 py-2.5 text-primary-foreground font-bold shadow-[0_6px_20px_-6px_rgba(232,96,122,0.6)]"
            >
              <ScrollText size={14} /> Apply policy
            </button>
          </>
        )}

        {message && (
          <div className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-500 font-medium">
            <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
            <span>{message}</span>
          </div>
        )}
        {error && (
          <div className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-red-500 font-medium">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-app-faint">{label}</span>
      <span className={`font-medium text-right ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-app'}`}>{value}</span>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-app-muted">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted border border-border'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}
