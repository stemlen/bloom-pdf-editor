'use client';

import React from 'react';
import { Search, Replace, ChevronUp, ChevronDown, CaseSensitive, X, Loader2 } from 'lucide-react';

export interface FindReplacePanelProps {
  findText: string;
  onFindTextChange: (val: string) => void;
  replaceText: string;
  onReplaceTextChange: (val: string) => void;
  matchCount: number;
  currentMatchIndex: number;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  onClose?: () => void;
  busy?: boolean;
}

export function FindReplacePanel({
  findText,
  onFindTextChange,
  replaceText,
  onReplaceTextChange,
  matchCount,
  currentMatchIndex,
  onNextMatch,
  onPrevMatch,
  onReplaceCurrent,
  onReplaceAll,
  caseSensitive,
  onToggleCaseSensitive,
  onClose,
  busy = false,
}: FindReplacePanelProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevMatch();
      } else {
        onNextMatch();
      }
    }
  };

  const noMatches = findText.trim() !== '' && matchCount === 0;

  return (
    <div className="p-3 space-y-2.5 bg-popover backdrop-blur-md rounded-xl border border-border shadow-2xl w-full md:w-72 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-foreground/90 uppercase">
          <Search size={13} className="text-primary" />
          Find & Replace
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted transition-colors"
            title="Close Search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Find input row with navigation & case sensitive controls */}
      <div className="space-y-1">
        <div className="relative flex items-center">
          <input
            value={findText}
            onChange={(e) => onFindTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search text in PDF…"
            autoFocus
            className={`w-full bg-muted border border-border focus:border-primary focus:ring-1 focus:ring-primary rounded-lg pl-2.5 ${noMatches ? 'pr-36' : 'pr-24'} py-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none transition-all`}
          />

          <div className="absolute right-1 flex items-center gap-0.5">
            {/* Match Counter Badge */}
            {findText.trim() !== '' && (
              <span data-testid="match-count" className="text-[10px] font-mono whitespace-nowrap px-1.5 py-0.5 rounded bg-muted text-foreground/90 mr-1">
                {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : 'No matches'}
              </span>
            )}

            {/* Case Sensitivity Toggle */}
            <button
              onClick={onToggleCaseSensitive}
              title={caseSensitive ? 'Match Case (Active)' : 'Match Case (Inactive)'}
              className={`p-1 rounded transition-colors ${
                caseSensitive
                  ? 'bg-primary/20 text-primary font-bold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-border'
              }`}
            >
              <CaseSensitive size={14} />
            </button>

            {/* Prev / Next Buttons */}
            <button
              onClick={onPrevMatch}
              disabled={matchCount === 0}
              title="Previous Match (Shift+Enter)"
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-border rounded disabled:opacity-30 transition-colors"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={onNextMatch}
              disabled={matchCount === 0}
              title="Next Match (Enter)"
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-border rounded disabled:opacity-30 transition-colors"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Replace input row */}
      <div className="space-y-1">
        <input
          value={replaceText}
          onChange={(e) => onReplaceTextChange(e.target.value)}
          placeholder="Replace with…"
          className="w-full bg-muted border border-border focus:border-primary focus:ring-1 focus:ring-primary rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none transition-all"
        />
      </div>

      {/* Replace Actions */}
      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
        <button
          onClick={onReplaceCurrent}
          disabled={busy || matchCount === 0 || !findText.trim()}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-muted hover:bg-border text-foreground border border-border hover:border-border-strong rounded-lg text-xs font-semibold disabled:opacity-40 transition-all"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Replace size={12} />}
          Replace
        </button>
        <button
          onClick={onReplaceAll}
          disabled={busy || matchCount === 0 || !findText.trim()}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-primary/20 hover:bg-primary/30 text-primary border border-primary/40 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Replace size={12} />}
          Replace All
        </button>
      </div>
    </div>
  );
}
