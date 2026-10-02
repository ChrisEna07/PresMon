import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw, Wifi, WifiOff, Database } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  isNetworkError: boolean;
  isOnline: boolean;
}

function isNetworkOrOfflineError(error: Error | null): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  const name = (error.name || '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('fetch') ||
    msg.includes('socket') ||
    msg.includes('connection') ||
    msg.includes('unavailable') ||
    msg.includes('failed to fetch') ||
    msg.includes('failed to get document because the client is offline') ||
    msg.includes('dynamically imported module') ||
    msg.includes('load chunk') ||
    msg.includes('loading chunk') ||
    name.includes('network')
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    isNetworkError: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    const isNet = isNetworkOrOfflineError(error);
    return {
      hasError: true,
      error,
      isNetworkError: isNet,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Error capturado:', error, errorInfo);
  }

  componentDidMount(): void {
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  componentWillUnmount(): void {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  private handleOnline = (): void => {
    this.setState({ isOnline: true });
    // Si el error fue por pérdida de red, al reconectar intentamos auto-recuperar
    if (this.state.hasError && this.state.isNetworkError) {
      setTimeout(() => {
        this.handleReset();
      }, 500);
    }
  };

  private handleOffline = (): void => {
    this.setState({ isOnline: false, isNetworkError: true });
  };

  private handleReset = (): void => {
    if (this.props.onReset) {
      this.props.onReset();
    }
    this.setState({
      hasError: false,
      error: null,
      isNetworkError: false,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleGoHome = (): void => {
    window.location.href = '/';
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const { error, isNetworkError, isOnline } = this.state;
    const isOffline = isNetworkError || !isOnline;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
          {/* Encabezado con Icono Contextual */}
          <div className="text-center">
            <div
              className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl ring-4 ${
                isOffline
                  ? 'bg-amber-500/10 text-amber-400 ring-amber-500/20'
                  : 'bg-red-500/10 text-red-400 ring-red-500/20'
              }`}
            >
              {isOffline ? <WifiOff size={32} /> : <AlertTriangle size={32} />}
            </div>

            <h1 className="text-lg font-bold text-white">
              {isOffline
                ? 'Conexión interrumpida · Modo Offline'
                : this.props.fallbackTitle || 'Se produjo un inconveniente en la vista'}
            </h1>

            <p className="mt-2 text-xs text-slate-400 leading-relaxed">
              {isOffline
                ? 'Se detectó una desconexión momentánea de red o socket. Todos tus datos locales permanecen seguros e intactos en este dispositivo.'
                : 'La aplicación encontró un error inesperado al procesar la información. Tus datos están a salvo en la base de datos local.'}
            </p>
          </div>

          {/* Tarjeta de Seguridad de Datos */}
          <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-950/30 p-3 text-xs text-emerald-200">
            <div className="flex items-center gap-2 font-semibold text-emerald-300">
              <Database size={14} className="shrink-0 text-emerald-400" />
              <span>Tus datos locales están protegidos</span>
            </div>
            <p className="mt-1 text-[11px] text-emerald-300/80 leading-normal">
              PresMon opera de forma local-first. Puedes reanudar la interfaz o recargar sin riesgo de pérdida de préstamos ni cobros.
            </p>
          </div>

          {/* Mensaje de Reconexión en Vivo si ya volvió la red */}
          {isOnline && isOffline && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-300 border border-emerald-500/30">
              <Wifi size={14} className="animate-pulse" />
              <span>Conexión a internet restablecida. Puedes reanudar.</span>
            </div>
          )}

          {/* Botones de Acción */}
          <div className="mt-6 flex flex-col gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-md hover:bg-emerald-500 transition-colors"
            >
              <RefreshCw size={14} />
              {isOffline ? 'Reanudar con datos locales' : 'Reintentar visualización'}
            </button>

            <button
              type="button"
              onClick={this.handleReload}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white transition-colors border border-slate-700"
            >
              <RefreshCw size={14} />
              Recargar aplicación completa
            </button>

            <button
              type="button"
              onClick={this.handleGoHome}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              <Home size={13} />
              Ir al inicio
            </button>
          </div>

          {/* Diagnóstico técnico colapsable */}
          {error && (
            <details className="mt-4 rounded-lg bg-slate-950 p-2.5 text-[11px] text-slate-500 border border-slate-800">
              <summary className="cursor-pointer font-mono font-medium hover:text-slate-400">
                Detalles técnicos del error
              </summary>
              <div className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-red-400/90 max-h-32">
                {error.name}: {error.message}
                {error.stack && `\n\n${error.stack}`}
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }
}
