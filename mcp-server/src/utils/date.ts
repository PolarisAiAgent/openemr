/**
 * Date utility helpers.
 * The spec allows natural-language date phrases in addition to YYYY-MM-DD.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function fmt(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Resolve a date string (natural phrase OR YYYY-MM-DD) to a YYYY-MM-DD string. */
export function resolveDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const lower = input.toLowerCase().trim();
  const today = new Date();

  if (lower === 'today') return fmt(today);
  if (lower === 'tomorrow') return fmt(addDays(today, 1));
  if (lower === 'next week') return fmt(addDays(today, 7));
  if (lower === 'yesterday') return fmt(addDays(today, -1));

  const nextMatch = lower.match(/^next\s+(\w+)$/);
  if (nextMatch) {
    const dayIdx = DAY_NAMES.indexOf(nextMatch[1]);
    if (dayIdx !== -1) {
      const todayIdx = today.getDay();
      let diff = dayIdx - todayIdx;
      if (diff <= 0) diff += 7;
      return fmt(addDays(today, diff));
    }
  }

  // Pass through YYYY-MM-DD (and anything else) unchanged
  return input;
}

export function todayIso(): string {
  return fmt(new Date());
}

/**
 * Parse HH:MM into { h, m } integers. Returns null if unparseable.
 */
export function parseHHMM(s: string): { h: number; m: number } | null {
  const match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** Add minutes to a HH:MM string. Returns HH:MM or null on overflow. */
export function addMinutes(hhmm: string, minutes: number): string | null {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return null;
  const total = parsed.h * 60 + parsed.m + minutes;
  if (total >= 24 * 60) return null;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
