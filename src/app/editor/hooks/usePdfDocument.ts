/**
 * Load PDF from IndexedDB and parse with the engine.
 * Handles encrypted PDFs via SecurityEngine + password callback.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { loadPdfFromStorage } from '@/lib/pdfStorage';
import type { PDFDocumentData, PdfPermissions } from '@/engine';
import { friendlyPdfError } from '@/lib/pdfErrors';

export function usePdfDocument(onParsed?: (doc: PDFDocumentData, engine: typeof import('@/engine')) => void) {
  const router = useRouter();
  const engineRef = useRef<typeof import('@/engine') | null>(null);
  const pendingEncryptedRef = useRef<PDFDocumentData | null>(null);
  const [doc, setDoc] = useState<PDFDocumentData | null>(null);
  const [fileName, setFileName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isVerifyingPassword, setIsVerifyingPassword] = useState(false);
  const [permissions, setPermissions] = useState<PdfPermissions | null>(null);
  const [modifiedKeys] = useState(() => new Set<string>());

  useEffect(() => {
    let cancelled = false;

    async function init() {
      let openedBytes: Uint8Array | undefined;
      try {
        const stored = await loadPdfFromStorage();
        if (stored) openedBytes = new Uint8Array(stored.bytes);
        if (!stored) { router.push('/'); return; }
        if (cancelled) return;
        setFileName(stored.fileName);

        const engine = await import('@/engine');
        engineRef.current = engine;

        const pdfBytes = new Uint8Array(stored.bytes);
        const parsed = await engine.parsePDF(pdfBytes);
        if (cancelled) return;

        if (engine.securityEngine.isEncrypted(parsed)) {
          try {
            const opened = await engine.securityEngine.open(parsed, '');
            if (cancelled) return;
            setDoc(opened.doc);
            setPermissions(opened.permissions);
            onParsed?.(opened.doc, engine);
            setIsLoading(false);
            return;
          } catch {
            pendingEncryptedRef.current = parsed;
            setNeedsPassword(true);
            setIsLoading(false);
            return;
          }
        }

        setDoc(parsed);
        onParsed?.(parsed, engine);
        setIsLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.error('[Editor] Init failed:', e);
        setError(friendlyPdfError(e, openedBytes));
        setIsLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [router, onParsed]);

  const submitPassword = useCallback(async (password: string) => {
    const engine = engineRef.current;
    const pending = pendingEncryptedRef.current;
    if (!engine || !pending) return false;

    setIsVerifyingPassword(true);
    setPasswordError(null);
    try {
      const opened = await engine.securityEngine.open(pending, password);
      setDoc(opened.doc);
      setPermissions(opened.permissions);
      setNeedsPassword(false);
      pendingEncryptedRef.current = null;
      onParsed?.(opened.doc, engine);
      return true;
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : 'Incorrect password');
      return false;
    } finally {
      setIsVerifyingPassword(false);
    }
  }, [onParsed]);

  const markModified = useCallback((key: string) => {
    modifiedKeys.add(key);
  }, [modifiedKeys]);

  const download = useCallback(async (mode: 'quick' | 'optimized' = 'optimized') => {
    if (!doc || !engineRef.current) return;
    const engine = engineRef.current;
    const bytes = mode === 'quick'
      ? await engine.saveQuick(doc, modifiedKeys)
      : await engine.saveOptimized(doc);

    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.pdf$/i, '') + (mode === 'optimized' ? '-edited.pdf' : '-quick.pdf');
    a.click();
    URL.revokeObjectURL(url);
  }, [doc, fileName, modifiedKeys]);

  return {
    engineRef,
    doc,
    setDoc,
    fileName,
    setFileName,
    isLoading,
    error,
    setError,
    needsPassword,
    passwordError,
    isVerifyingPassword,
    submitPassword,
    permissions,
    modifiedKeys,
    markModified,
    download,
  };
}
