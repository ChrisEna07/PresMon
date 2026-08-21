import { cn } from '../../lib/format';

export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ items, value, onChange, className }: TabsProps) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          className={cn(
            'cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors',
            value === item.key
              ? 'bg-slate-900 text-white shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50',
          )}
        >
          {item.label}
          {typeof item.count === 'number' && (
            <span
              className={cn(
                'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
                value === item.key ? 'bg-white/20' : 'bg-slate-100 text-slate-500',
              )}
            >
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
