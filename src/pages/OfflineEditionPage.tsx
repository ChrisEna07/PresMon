import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  CloudDownload,
  HardDriveDownload,
  Loader2,
  LogIn,
  ShieldCheck,
  Smartphone,
  XCircle,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { activateOfflineEdition, isOfflineEdition, seedOfflineEdition, type SeedResult } from '../lib/offlineEdition';

export default function OfflineEditionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tenantId = searchParams.get('t') ?? '';
  const key = searchParams.get('k') ?? '';

  const alreadyActive = isOfflineEdition();
  const [status, setStatus] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<SeedResult | null>(null);

  // Detección e instalación PWA en pantalla de inicio
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [installedPwa, setInstalledPwa] = useState(false);

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', () => {
      setInstalledPwa(true);
      setDeferredPrompt(null);
    });
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  async function handleInstallPwa() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setInstalledPwa(true);
      }
      setDeferredPrompt(null);
    }
  }

  useEffect(() => {
    if (alreadyActive) return;
    if (!tenantId || !key) {
      setStatus('error');
      setMessage('Enlace incompleto. Debe incluir la organización y la clave de licencia.');
      return;
    }
    void (async () => {
      setStatus('working');
      const res = await seedOfflineEdition(tenantId, key, setMessage);
      setResult(res);
      if (res.ok) {
        // La conexión se corta para siempre en este dispositivo.
        activateOfflineEdition();
        setStatus('done');
      } else {
        setStatus('error');
        setMessage(res.error ?? 'No se pudo instalar la Edición Offline.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, key]);

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-900">
            <HardDriveDownload size={22} />
          </div>
          <h1 className="text-xl font-bold text-white">PresMon · Edición Offline</h1>
          <p className="text-xs text-slate-400">Instalación con base de datos local permanente</p>
        </div>

        {alreadyActive ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-600" /> Este dispositivo ya tiene la
                Edición Offline activa
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-slate-600">
                La app ya funciona 100% sin internet en este equipo. Inicia sesión normalmente con
                las cuentas de tu organización.
              </p>
              {deferredPrompt && !installedPwa && (
                <Button
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold gap-2"
                  onClick={handleInstallPwa}
                >
                  <Smartphone size={16} /> Instalar en Pantalla de Inicio (PWA)
                </Button>
              )}
              <Button className="w-full" onClick={() => navigate('/login')}>
                <LogIn size={15} /> Abrir PresMon
              </Button>
            </CardContent>
          </Card>
        ) : status === 'working' ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <Loader2 size={30} className="animate-spin text-emerald-500" />
              <p className="text-sm font-semibold text-slate-700">{message || 'Conectando…'}</p>
              <p className="max-w-xs text-[11px] leading-relaxed text-slate-400">
                Esta es la ÚNICA vez que necesitas internet: se descarga tu base de datos y queda
                instalada en el dispositivo. Después la app funciona totalmente desconectada.
              </p>
            </CardContent>
          </Card>
        ) : status === 'done' ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600" /> ¡Instalación completada!
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                  <ShieldCheck size={13} /> Modo offline activado: esta app ya no se conecta a
                  ninguna nube.
                </p>
                {result?.counts && result.counts.length > 0 && (
                  <div className="rounded-xl border border-slate-200 p-3">
                    <p className="mb-1.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
                      Base de datos instalada
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      {result.counts.map((c) => (
                        <div key={c.collection} className="flex justify-between">
                          <span className="text-slate-500">{c.collection}</span>
                          <strong>{c.rows}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {deferredPrompt && !installedPwa && (
                  <Button
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold gap-2"
                    onClick={handleInstallPwa}
                  >
                    <Smartphone size={16} /> Instalar en Pantalla de Inicio (PWA)
                  </Button>
                )}
                <p className="text-[11px] leading-relaxed text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                  💡 <strong>Usa PresMon como App:</strong> Si tu navegador no mostró el botón automático, pulsa el menú del navegador (tres puntos o icono compartir) y elige <strong>«Añadir a pantalla de inicio»</strong> o <strong>«Instalar aplicación»</strong>.
                </p>
                <Button className="w-full" onClick={() => navigate('/login')}>
                  <LogIn size={15} /> Abrir PresMon
                </Button>
              </CardContent>
            </Card>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-400">
              <CloudDownload size={12} /> Licencia vinculada a esta organización · pago único
            </p>
          </>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <XCircle size={30} className="text-red-500" />
              <p className="text-sm font-semibold text-red-600">{message}</p>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reintentar
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
