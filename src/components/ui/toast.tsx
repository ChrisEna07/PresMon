import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '../../lib/format';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const CRITICAL: ToastType[] = ['error', 'warning'];

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = ++counter.current;
      setItems((prev) => [...prev, { id, message, type }]);
      const ttl = CRITICAL.includes(type) ? 7000 : 3800;
      timers.current.push(window.setTimeout(() => dismiss(id), ttl));
    },
    [dismiss],
  );

  const criticalItems = items.filter((i) => CRITICAL.includes(i.type));
  const cornerItems = items.filter((i) => !CRITICAL.includes(i.type));

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 sm:w-96">
        {cornerItems.map((item) => (
          <div
            key={item.id}
            className={cn(
              'toast-in-up pointer-events-auto flex items-start gap-3 rounded-2xl border bg-white p-4 shadow-xl',
              item.type === 'success' && 'border-emerald-200',
              item.type === 'info' && 'border-slate-200',
            )}
          >
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                item.type === 'success' ? 'bg-emerald-100 text-emerald-600' : 'bg-sky-100 text-sky-600',
              )}
            >
              {item.type === 'success' ? (
                <CheckCircle2 size={18} />
              ) : (
                <Info size={18} />
              )}
            </span>
            <span className="flex-1 pt-1 text-sm leading-snug font-medium text-slate-700">
              {item.message}
            </span>
            <button
              onClick={() => dismiss(item.id)}
              className="cursor-pointer pt-1 text-slate-300 transition-colors hover:text-slate-500"
              aria-label="Cerrar"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      {criticalItems.length > 0 && (
        <div className="pointer-events-auto fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/25 p-4 backdrop-blur-[2px]">
          <div className="flex w-full max-w-sm flex-col gap-2.5">
            {criticalItems.map((item) => (
              <div
                key={item.id}
                className={cn(
                  'toast-pop relative flex items-start gap-3.5 rounded-2xl border-2 bg-white p-4 pr-10 shadow-2xl',
                  item.type === 'error'
                    ? 'border-red-300 ring-4 ring-red-100'
                    : 'border-amber-300 ring-4 ring-amber-100',
                )}
              >
                <span
                  className={cn(
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
                    item.type === 'error' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600',
                  )}
                >
                  {item.type === 'error' ? <XCircle size={24} /> : <AlertTriangle size={24} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-xs font-bold tracking-wide uppercase',
                      item.type === 'error' ? 'text-red-500' : 'text-amber-600',
                    )}
                  >
                    {item.type === 'error' ? 'Error' : 'Atención'}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed font-medium text-slate-800">
                    {item.message}
                  </p>
                </div>
                <button
                  onClick={() => dismiss(item.id)}
                  className="absolute top-3 right-3 cursor-pointer text-slate-300 transition-colors hover:text-slate-600"
                  aria-label="Cerrar"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast debe usarse dentro de ToastProvider.');
  return ctx;
}
