/** Small formatting helpers for user-facing text. */

/** "1 page", "2 pages"; pass `many` for irregular plurals. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Join the non-empty parts with a middle dot, so separators never dangle. */
export function joinParts(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ');
}

/**
 * Format a PDF date ("D:20261025181122+00'00'") or an ISO date as a readable
 * local date and time. Returns the input unchanged when it can't be parsed.
 */
export function formatPdfDate(value: string | null | undefined): string {
  if (!value) return '';
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(value.trim());
  let date: Date | null = null;
  if (m) {
    const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz] = m;
    let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    if (!tz || tz === 'Z') iso += 'Z';
    else iso += `${tz.slice(0, 3)}:${tz.replace(/'/g, '').slice(3, 5) || '00'}`;
    date = new Date(iso);
  } else {
    date = new Date(value);
  }
  if (!date || Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
