export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export function formatCOP(n: number): string {
  return copFormatter.format(Math.round(n || 0));
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return toDateStr(new Date());
}

export function parseDateStr(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDaysStr(iso: string, n: number): string {
  const d = parseDateStr(iso);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

export function addMonthsStr(iso: string, n: number): string {
  const d = parseDateStr(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toDateStr(d);
}

export function diffDays(fromISO: string, toISO: string): number {
  const a = parseDateStr(fromISO).getTime();
  const b = parseDateStr(toISO).getTime();
  return Math.round((b - a) / 86400000);
}

export function formatDateShort(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const longFormatter = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function formatDateLong(iso: string): string {
  return longFormatter.format(parseDateStr(iso));
}

export function formatDateTime(isoDateTime: string): string {
  const d = new Date(isoDateTime);
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}
