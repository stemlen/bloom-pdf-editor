'use client';

import { useState, useRef, useEffect } from 'react';
import type * as Engine from '@/engine';

/**
 * Lightweight PDF parse debugger.
 * Document conversion runs in the Bloom engine Web Worker (Export panel).
 */
export default function DebugPage() {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<typeof Engine | null>(null);

  useEffect(() => {
    import('@/engine').then((m) => {
      engineRef.current = m;
    });
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !engineRef.current) return;

    setLoading(true);
    setError(null);
    setSummary(null);

    try {
      const buffer = await file.arrayBuffer();
      const pdfBytes = new Uint8Array(buffer);
      const parsed = await engineRef.current.parsePDF(pdfBytes);
      setSummary(
        `Parsed ${file.name}: ${parsed.pages.length} page(s), PDF ${parsed.version}. ` +
          `Document conversion runs in the Export panel.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
    <div className="p-8 max-w-5xl mx-auto font-sans">
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">PDF Parse Debugger</h1>
      <p className="mb-6 text-muted-foreground">
        Upload a PDF to verify the in-browser parser.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={handleFileUpload}
        className="block w-full text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/15 mb-8"
      />

      {loading && <div className="text-primary animate-pulse">Processing PDF…</div>}
      {error && <div className="text-destructive font-medium">Error: {error}</div>}
      {summary && <div className="text-emerald-700 dark:text-emerald-400 font-medium">{summary}</div>}
    </div>
    </div>
  );
}
