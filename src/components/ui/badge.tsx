import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/format';

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'outline' | 'muted';

const variants: Record<Variant, string> = {
  default: 'bg-slate-900 text-white',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-700',
  info: 'bg-sky-100 text-sky-800',
  outline: 'border border-slate-300 text-slate-600',
  muted: 'bg-slate-100 text-slate-500',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Badge({ variant = 'default', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
