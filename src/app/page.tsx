'use client';

import { useCallback, useState, useId } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowUpRight, Heart, Loader2 } from 'lucide-react';
import { savePdfToStorage } from '@/lib/pdfStorage';
import { looksLikePdf, actionErrorMessage } from '@/lib/pdfErrors';
import { Logo } from '@/components/art/Logo';
import { UploadDoodle } from '@/components/art/Illustrations';
import { CategoryIcon } from '@/components/art/CategoryIcon';
import { Lotus, Shield, Sparkle, Underline } from '@/components/art/Doodles';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { cn } from '@/lib/utils';

const SITE_URL = 'https://bloompdf.app';

const FEATURES = [
  { cat: 'edit', title: 'Edit text in place', body: 'Click any line to rewrite it in the original font.' },
  { cat: 'organize', title: 'Pages & images', body: 'Add, move, rotate and delete pages; place images and draw shapes.' },
  { cat: 'security', title: 'Fill, sign & protect', body: 'Forms, signatures, redaction, passwords and watermarks.' },
  { cat: 'convert-from', title: 'Export anywhere', body: 'Word, Excel, PowerPoint, HTML, Markdown, images…' },
];

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const router = useRouter();

  const handleFile = useCallback(async (file: File) => {
    if (file.size === 0) {
      setError(`"${file.name}" is empty.`);
      return;
    }
    // Decide by content, not by name: a renamed PNG is still not a PDF, and a
    // real PDF without the .pdf extension still opens.
    const head = new Uint8Array(await file.slice(0, 1029).arrayBuffer());
    if (!looksLikePdf(head)) {
      setError(`"${file.name}" isn't a PDF. Please choose a PDF file.`);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const buffer = await file.arrayBuffer();
      await savePdfToStorage(buffer, file.name);
      router.push('/editor');
    } catch (e) {
      setError(actionErrorMessage('Couldn\'t open the file', e));
      setIsLoading(false);
    }
  }, [router]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ── Header (mirrors bloompdf.app) ── */}
      <header className="sticky top-0 z-50 h-[58px] bg-background/85 backdrop-blur-xl border-b border-border">
        <div className="max-w-screen-xl mx-auto h-full px-4 sm:px-6 flex items-center gap-3">
          <a href={SITE_URL} target="_blank" rel="noopener noreferrer" aria-label="BloomPDF home (opens in a new tab)" className="flex items-center flex-shrink-0 -ml-2 sm:-ml-1 mr-2 sm:mr-4 overflow-visible">
            <Logo variant="nav" />
          </a>
          <span className="hidden sm:inline-flex items-center h-7 px-2.5 rounded-full bg-primary/10 text-primary text-[12px] font-semibold">
            PDF Editor
          </span>
          <div className="flex-1" />
          <a
            href={SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="All PDF tools (opens in a new tab)"
            className="h-9 px-3 inline-flex items-center gap-1 rounded-lg text-[13.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
          >
            <span className="hidden sm:inline">All PDF tools</span>
            <span className="sm:hidden">Tools</span>
            <ArrowUpRight className="w-3.5 h-3.5 opacity-60" />
          </a>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero ── */}
        <section className="relative overflow-hidden">
          <div aria-hidden className="absolute inset-0 bg-paper opacity-60 [mask-image:radial-gradient(ellipse_at_top,black_25%,transparent_75%)]" />
          <div aria-hidden className="absolute -top-40 right-[-8%] w-[520px] h-[520px] max-w-full rounded-full bg-primary/10 blur-[110px]" />
          <div aria-hidden className="absolute bottom-[-30%] -left-32 w-[380px] h-[380px] rounded-full bg-sky-400/10 blur-[100px]" />
          <Sparkle size={22} className="absolute top-12 left-[18%] text-primary/40 hidden lg:block animate-wiggle" />

          <div className="relative max-w-screen-xl mx-auto px-4 sm:px-6 pt-12 sm:pt-16 pb-10 grid gap-10 lg:grid-cols-[1fr_1.05fr] items-center">
            <div className="hero-in text-center lg:text-left">
              <p className="font-hand text-[24px] leading-none text-primary flex items-center gap-1.5 justify-center lg:justify-start">
                <Sparkle size={18} />
                edit anything, right here
              </p>
              <h1 className="mt-3 text-[38px] sm:text-[52px] lg:text-[46px] xl:text-[54px] font-extrabold tracking-[-0.03em] leading-[1.06]">
                Edit your PDF
                <br />
                <span className="relative inline-block">
                  <span className="relative z-10 bg-gradient-to-r from-bloom-500 via-bloom-400 to-amber-400 bg-clip-text text-transparent">
                    without uploading it
                  </span>
                  <Underline className="absolute left-0 -bottom-1.5 w-full h-3.5 text-primary/60" />
                </span>
              </h1>
              <p className="mt-5 text-[16.5px] sm:text-[18px] leading-relaxed text-muted-foreground max-w-xl mx-auto lg:mx-0">
                Change text in the original font, move images, fill forms, sign and export — a full editor that runs
                entirely in your browser.
              </p>
              <p className="mt-6 inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[12.5px] font-semibold">
                <Shield size={15} /> Runs on your device · free & open source
              </p>
            </div>

            {/* ── Upload zone ── */}
            <div className="hero-in" style={{ animationDelay: '120ms' }}>
              <label
                htmlFor={inputId}
                data-testid="upload-zone"
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) void handleFile(file);
                }}
                className={cn(
                  'group relative flex flex-col items-center justify-center text-center cursor-pointer rounded-3xl transition-all',
                  'border-2 border-dashed bg-card/80 backdrop-blur-sm p-8 sm:p-12 gap-3 min-h-[340px]',
                  'shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]',
                  isDragging ? 'border-primary bg-primary/5 scale-[1.01]' : 'border-border hover:border-primary/60 hover:bg-card',
                  isLoading && 'pointer-events-none',
                )}
              >
                <input
                  id={inputId}
                  type="file"
                  data-testid="file-input"
                  accept=".pdf,application/pdf"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                    e.target.value = '';
                  }}
                />
                {isLoading ? (
                  <>
                    <Loader2 className="w-12 h-12 animate-spin text-primary" />
                    <p className="text-[15px] font-semibold">Opening your PDF…</p>
                  </>
                ) : (
                  <>
                    <UploadDoodle active={isDragging} className="w-40 h-32 sm:w-48 sm:h-36 text-primary" />
                    <div>
                      <p className="font-bold text-[19px] sm:text-[21px]">Drop a PDF to start editing</p>
                      <p className="text-[13px] text-muted-foreground mt-1">or click to browse from your device</p>
                    </div>
                    <span className="inline-flex items-center gap-2 mt-1 h-10 px-5 rounded-full bg-primary text-primary-foreground text-[13px] font-semibold shadow-sm group-hover:shadow-md transition-shadow">
                      Choose PDF
                    </span>
                    <p className="text-[11px] text-muted-foreground/80 font-medium tracking-wide">PDF · stays on your device</p>
                  </>
                )}
              </label>

              {error && (
                <p
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-[13px] font-medium text-destructive"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {error}
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ── What you can do ── */}
        <section className="max-w-screen-xl mx-auto px-4 sm:px-6 pb-16">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-border bg-card p-5 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.06)]">
                <CategoryIcon id={f.cat} size={18} tile />
                <h2 className="mt-3 text-[15px] font-bold">{f.title}</h2>
                <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground text-pretty">{f.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="relative border-t border-border bg-card overflow-hidden">
        <Lotus size={180} className="absolute -right-10 -bottom-14 text-primary/[0.06] pointer-events-none" />
        <div className="relative max-w-screen-xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[12.5px] text-muted-foreground">
          <p>
            © {new Date().getFullYear()} BloomPDF · A product by{' '}
            <a href="https://stemlen.com" target="_blank" rel="noopener" className="font-semibold text-foreground hover:text-primary">
              Stemlen
            </a>
          </p>
          <p className="flex items-center gap-1.5">
            Made with <Heart size={14} className="text-primary fill-current shrink-0" role="img" aria-label="love" /> for everyone who just needs their PDF done.
          </p>
        </div>
      </footer>
    </div>
  );
}
