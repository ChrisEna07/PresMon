import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CloudOff, LogIn, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../store/auth';
import { db } from '../db/db';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input, Label } from '../components/ui/input';
import { cn } from '../lib/format';
import { isSyncConfigured, pullBootstrap } from '../lib/sync/syncEngine';

type BootState = 'checking' | 'local' | 'syncing' | 'empty-cloud' | 'ready';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [superMode, setSuperMode] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [boot, setBoot] = useState<BootState>('checking');
  const cloudMode = isSyncConfigured();

  const bootstrap = useCallback(async () => {
    setBoot('syncing');
    try {
      await pullBootstrap();
    } catch {
      /* sin conexión: se conserva lo local */
    }
    const count = await db.users.count().catch(() => 0);
    setBoot(count > 0 ? 'ready' : 'empty-cloud');
  }, []);

  useEffect(() => {
    void (async () => {
      if (!cloudMode) {
        setBoot('local');
        return;
      }
      await bootstrap();
    })();
  }, [cloudMode, bootstrap]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Error al iniciar sesión';
      if (cloudMode && message.includes('Credenciales')) {
        try {
          await pullBootstrap();
          await login(username, password);
          navigate('/', { replace: true });
          return;
        } catch (retryErr) {
          message = retryErr instanceof Error ? retryErr.message : message;
        }
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500 text-xl font-black text-white shadow-lg">
            PM
          </div>
          <h1 className="text-2xl font-bold text-white">PresMon</h1>
          <p className="text-xs tracking-widest text-slate-400 uppercase">by ChrizDev</p>
        </div>

        <Card className="overflow-hidden border-0 shadow-2xl">
          <CardContent className="pt-5">
            {superMode && (
              <p className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold text-white">
                <ShieldCheck size={12} /> Modo Super Admin
              </p>
            )}
            {cloudMode && boot === 'syncing' && (
              <p className="mb-4 flex items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700">
                <RefreshCw size={12} className="animate-spin" />
                Descargando cuentas desde la nube…
              </p>
            )}
            {cloudMode && boot === 'empty-cloud' && (
              <div className="mb-4 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                <span className="inline-flex items-center gap-1.5">
                  <CloudOff size={12} />
                  No hay cuentas en la nube todavía
                </span>
                <button
                  type="button"
                  onClick={() => void bootstrap()}
                  className="cursor-pointer rounded-md bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-700"
                >
                  Reintentar
                </button>
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label>Usuario</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={superMode ? 'Usuario Super Admin' : 'Usuario administrador'}
                  autoComplete="username"
                  autoFocus
                />
              </div>
              <div>
                <Label>Contraseña</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                <LogIn size={16} />
                {loading ? 'Verificando…' : 'Iniciar sesión'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <button
          onClick={() => setSuperMode(!superMode)}
          className={cn(
            'mt-6 cursor-pointer text-center text-[11px] transition-colors',
            superMode ? 'text-emerald-400' : 'text-slate-600 hover:text-slate-400',
          )}
        >
          {superMode ? '← Volver al ingreso de prestamistas' : 'Acceso Super Admin'}
        </button>
      </div>

      <p className="absolute bottom-4 text-[10px] text-slate-700">
        PresMon v1.2 · Tus datos se respaldan en la nube y en este dispositivo
      </p>
    </div>
  );
}
