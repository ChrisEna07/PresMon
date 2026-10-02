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
  if (!(d instanceof Date) || isNaN(d.getTime())) return todayStr();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateStr(iso?: string | null): Date {
  if (!iso || typeof iso !== 'string') return new Date();
  const parts = iso.slice(0, 10).split('-').map(Number);
  const y = parts[0] || 1970;
  const m = parts[1] || 1;
  const d = parts[2] || 1;
  const parsed = new Date(y, m - 1, d);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
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

export function diffDays(fromISO?: string | null, toISO?: string | null): number {
  if (!fromISO || !toISO) return 0;
  const a = parseDateStr(fromISO).getTime();
  const b = parseDateStr(toISO).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * Próximo vencimiento de un cobro mensual que cae el día `day` (1-28).
 * Si `paidThrough` (YYYY-MM-DD) está definido, el próximo vencimiento exigible
 * es el ciclo mensual inmediatamente posterior a dicha fecha.
 * Si nunca ha pagado (`paidThrough` vacío), se evalúa el vencimiento del mes en curso.
 */
export function nextMonthlyDue(day: number, paidThrough?: string): string {
  const safeDay = Math.min(28, Math.max(1, Math.round(day) || 1));
  const dayStr = String(safeDay).padStart(2, '0');
  const today = todayStr();

  if (paidThrough && paidThrough.length >= 10) {
    const baseDate = `${paidThrough.slice(0, 8)}${dayStr}`;
    const nextDate = addMonthsStr(baseDate, 1);
    return `${nextDate.slice(0, 8)}${dayStr}`;
  }

  return `${today.slice(0, 8)}${dayStr}`;
}

export function formatDateShort(iso?: string | null): string {
  if (!iso || typeof iso !== 'string') return '—';
  const parts = iso.slice(0, 10).split('-');
  if (parts.length < 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

const longFormatter = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export function formatDateLong(iso?: string | null): string {
  if (!iso || typeof iso !== 'string') return '—';
  try {
    const parsed = parseDateStr(iso);
    if (isNaN(parsed.getTime())) return '—';
    return longFormatter.format(parsed);
  } catch {
    return '—';
  }
}

export function formatDateTime(isoDateTime?: string | null): string {
  if (!isoDateTime || typeof isoDateTime !== 'string') return '—';
  try {
    const d = new Date(isoDateTime);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return '—';
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}
