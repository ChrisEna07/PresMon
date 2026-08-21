import type { TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/format';

export function TableWrap({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('w-full overflow-x-auto rounded-xl border border-slate-200 bg-white', className)}>
      <table className="w-full min-w-max text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-slate-200 bg-slate-50">
      <tr>{children}</tr>
    </thead>
  );
}

export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide text-slate-500 uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function TR({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-slate-50/70', className)} {...props} />;
}

export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
}
