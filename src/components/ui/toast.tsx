import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '../../lib/format';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++counter.current;
    setItems((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-white p-3 text-sm shadow-lg',
              item.type === 'success' && 'border-emerald-200',
              item.type === 'error' && 'border-red-200',
              item.type === 'info' && 'border-slate-200',
            )}
          >
            {item.type === 'success' && <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />}
            {item.type === 'error' && <XCircle size={18} className="mt-0.5 shrink-0 text-red-500" />}
            {item.type === 'info' && <Info size={18} className="mt-0.5 shrink-0 text-slate-500" />}
            <span className="text-slate-700">{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast debe usarse dentro de ToastProvider.');
  return ctx;
}
