import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cloud,
  CloudUpload,
  Copy,
  DatabaseBackup,
  Info,
  KeyRound,
  Link2,
  Lock,
  MessageCircle,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useAuth } from '../store/auth';
import { openWhatsApp } from '../lib/share';
import {
  clearFirebaseConfig,
  loadFirebaseConfig,
  saveFirebaseConfig,
  type FirebaseConfig,
} from '../lib/sync/firebaseConfig';
import {
  ensureSuperAdminSynced,
  friendlySyncError,
  getLastSync,
  runSync,
  setLastSync,
} from '../lib/sync/syncEngine';
import { exportBackup, importBackup } from '../lib/backup';
import { sha256Hex, readFileAsText, downloadBlob } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { formatDateTime } from '../lib/format';
import { PageHeader } from '../components/misc';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { useToast } from '../components/ui/toast';

const EMPTY_CFG: FirebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export default function SettingsPage() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  const [cfg, setCfg] = useState<FirebaseConfig>(EMPTY_CFG);
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [repeatPass, setRepeatPass] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');

  const tenant = useLiveQuery(
    () => (session && !isSuperAdmin ? db.tenants.get(session.tenantId) : undefined),
    [session?.tenantId, isSuperAdmin],
  );
  const portalUrl =
    session && !isSuperAdmin
      ? `${window.location.origin}/portal?t=${session.tenantId}`
      : '';

  async function copyPortalLink() {
    if (!portalUrl) return;
    try {
      await navigator.clipboard.writeText(portalUrl);
      toast('Enlace copiado. Compártelo solo con TUS clientes.', 'success');
    } catch {
      toast(`Copia manual: ${portalUrl}`, 'info');
    }
  }

  function sharePortalByWhatsApp() {
    if (!portalUrl || !session) return;
    const org = tenant?.name ?? 'nuestra organización';
    const text = encodeURIComponent(
      `Consulta el estado de tu crédito las 24 horas en este enlace (${org}): ${portalUrl} — necesitas tu número de documento y los últimos 4 dígitos de tu teléfono. ¿Buscas un préstamo? También puedes solicitarlo desde ahí.`,
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  }

  useEffect(() => {
    const loaded = loadFirebaseConfig();
    if (loaded) setCfg(loaded);
    if (session) setLastSyncAt(getLastSync(session.tenantId || 'global'));
  }, []);

  async function handleSaveConfig() {
    if (!cfg.apiKey || !cfg.projectId || !cfg.appId) {
      toast('Completa al menos apiKey, projectId y appId.', 'error');
      return;
    }
    saveFirebaseConfig(cfg);
    toast('Configuración de Firebase guardada.', 'success');
  }

  async function handleTest() {
    try {
      saveFirebaseConfig(cfg);
      const { initializeApp, getApps, deleteApp } = await import('firebase/app');
      const { getFirestore, collection, getDocs, limit, query } = await import(
        'firebase/firestore'
      );
      const testApp = getApps().length ? getApps()[0] : initializeApp(cfg);
      const fs = getFirestore(testApp);
      await getDocs(query(collection(fs, 'tenants'), limit(1)));
      toast('Conexión exitosa con Firestore.', 'success');
      if (!getApps().length) await deleteApp(testApp);
    } catch (err) {
      toast(`No se pudo conectar: ${friendlySyncError(err)}`, 'error');
    }
  }

  async function handleSyncNow() {
    if (!session) return;
    setSyncing(true);
    try {
      if (isSuperAdmin) {
        await ensureSuperAdminSynced(session.userId);
      }
      const result = await runSync(isSuperAdmin ? undefined : session.tenantId);
      setLastSync(session.tenantId || 'global');
      setLastSyncAt(Date.now());
      if (result.errors.length) toast(`Errores: ${friendlySyncError(result.errors[0])}`, 'error');
      else toast(`Sincronizado: ${result.pushed} enviados · ${result.pulled} recibidos.`, 'success');
    } catch (err) {
      toast(friendlySyncError(err), 'error');
    } finally {
      setSyncing(false);
    }
  }

  async function handleChangePassword() {
    if (!session) return;
    if (newPass.length < 6) {
      toast('La nueva contraseña debe tener al menos 6 caracteres.', 'error');
      return;
    }
    if (newPass !== repeatPass) {
      toast('Las contraseñas nuevas no coinciden.', 'error');
      return;
    }
    const user = await db.users.get(session.userId);
    if (!user) return;
    const currentHash = await sha256Hex(currentPass);
    if (user.passHash !== currentHash) {
      toast('La contraseña actual es incorrecta.', 'error');
      return;
    }
    user.passHash = await sha256Hex(newPass);
    user.updatedAt = new Date().toISOString();
    user.syncStatus = 'PENDING';
    await db.users.put(user);
    await logAudit({
      tenantId: session.tenantId,
      action: 'AUTH_PASSWORD_CHANGED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: session.userId,
      entityType: 'users',
    });
    setCurrentPass('');
    setNewPass('');
    setRepeatPass('');
    toast('Contraseña actualizada.', 'success');
  }

  async function handleExportAll() {
    if (!session) return;
    const tenantId = session.tenantId;
    await exportBackup();
    await logAudit({
      tenantId,
      action: 'DATA_EXPORTED',
      actorId: session.userId,
      actorName: session.displayName,
      payloadSnapshot: { tipo: 'respaldo-completo-json' },
    });
    toast('Respaldo descargado. Incluye cuentas y contraseñas cifradas: guárdalo seguro.', 'success');
  }

  async function handleImportAll(file: File) {
    try {
      const count = await importBackup(file);
      toast(
        `Respaldo importado: ${count} registros restaurados y marcados para sincronizar.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Archivo de respaldo inválido.', 'error');
    }
  }

  async function handleResetDatabase() {
    if (resetConfirmText !== 'ELIMINAR') {
      toast('Escribe ELIMINAR para confirmar.', 'error');
      return;
    }
    try {
      let superUsers = await db.users.where('role').equals('SUPER_ADMIN').toArray();
      if (superUsers.length === 0) {
        superUsers = (await db.users.toArray()).filter((u) => u.role === 'SUPER_ADMIN');
      }
      if (superUsers.length === 0) {
        toast(
          'No hay cuentas Super Admin en este dispositivo. Usa Borrar datos del sitio para restaurar el acceso.',
          'error',
        );
        return;
      }
      await db.transaction('rw', db.tables, async () => {
        for (const table of db.tables) {
          await table.clear();
        }
        await db.users.bulkPut(superUsers);
      });
      localStorage.setItem('presmon_seeded_v1', 'done');
      setResetOpen(false);
      setResetConfirmText('');
      logout();
      navigate('/login');
      toast(
        'Base de datos restablecida. Solo se conservaron las cuentas Super Admin.',
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error al restablecer la base', 'error');
    }
  }

  return (
    <div className="relative max-w-3xl">
      <PageHeader title="Ajustes" description="Seguridad, respaldos y mantenimiento local" />

      {!isSuperAdmin && (
        <div className="absolute inset-x-0 top-20 bottom-0 z-30 flex items-start justify-center pt-8 sm:pt-14 pointer-events-auto">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-slate-200/90 bg-white/95 p-6 md:p-8 text-center shadow-2xl backdrop-blur-xl ring-1 ring-slate-900/10">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 ring-8 ring-amber-500/5">
              <Lock size={32} />
            </div>
            <span className="inline-block rounded-full bg-amber-100 px-3 py-1 text-[11px] font-bold text-amber-800 uppercase tracking-wide">
              Módulo restringido
            </span>
            <h2 className="mt-3 text-xl font-extrabold text-slate-800">
              Configuraciones Bloqueadas
            </h2>
            <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-700">
              Contacta al Desarrollador para cualquier cambio que necesites.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Los parámetros del sistema, sincronización en la nube, credenciales de base de datos y respaldos de tu organización están centralizados para proteger la integridad operativa.
            </p>
            <div className="mt-6 flex flex-col gap-2.5">
              <Button
                size="lg"
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-2 shadow-md shadow-emerald-600/20 cursor-pointer"
                onClick={() =>
                  openWhatsApp(
                    `Hola ChrizDev, soy ${session?.tenantName ?? 'un administrador'} de PresMon. Necesito solicitar un cambio o ajuste en la configuración de mi organización.`,
                  )
                }
              >
                <MessageCircle size={18} /> Contactar al Desarrollador
              </Button>
              <Button
                variant="outline"
                className="w-full cursor-pointer"
                onClick={() => navigate('/')}
              >
                Volver al panel principal
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className={!isSuperAdmin ? 'filter blur-sm select-none pointer-events-none opacity-30 transition-all' : undefined}>
        {isSuperAdmin && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cloud size={17} /> Sincronización en la nube (Firebase)
            </CardTitle>
            <CardDescription>
              La app trabaja en línea con respaldo local automático. Las credenciales ya vienen
              precargadas de forma segura en el build (.env); puedes sobrescribirlas aquí si cambias
              de proyecto.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  ['apiKey', 'API Key'],
                  ['authDomain', 'Auth Domain'],
                  ['projectId', 'Project ID'],
                  ['storageBucket', 'Storage Bucket'],
                  ['messagingSenderId', 'Messaging Sender ID'],
                  ['appId', 'App ID'],
                ] as Array<[keyof FirebaseConfig, string]>
              ).map(([field, label]) => (
                <div key={field}>
                  <Label>{label}</Label>
                  <Input
                    value={cfg[field]}
                    onChange={(e) => setCfg({ ...cfg, [field]: e.target.value })}
                    placeholder={field === 'projectId' ? 'mi-proyecto-presmon' : ''}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void handleSaveConfig()}>
                Guardar configuración
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleTest()}>
                Probar conexión
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSyncNow()}
                disabled={syncing}
              >
                <CloudUpload size={14} /> {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-red-500 hover:bg-red-50"
                onClick={() => {
                  clearFirebaseConfig();
                  const loaded = loadFirebaseConfig();
                  if (loaded) setCfg(loaded);
                  else setCfg(EMPTY_CFG);
                  toast('Se restauró la configuración del sistema.', 'info');
                }}
              >
                <Trash2 size={14} /> Restaurar por defecto
              </Button>
            </div>
            <p className="text-[11px] text-slate-400">
              Última sincronización:{' '}
              {lastSyncAt ? formatDateTime(new Date(lastSyncAt).toISOString()) : 'nunca'}
            </p>
          </CardContent>
        </Card>
      )}

      {!isSuperAdmin && (
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <CloudUpload size={16} className="text-slate-400" />
              Última sincronización:{' '}
              {lastSyncAt ? formatDateTime(new Date(lastSyncAt).toISOString()) : 'nunca'}
            </div>
            <Button size="sm" variant="outline" onClick={() => void handleSyncNow()} disabled={syncing}>
              <CloudUpload size={14} /> {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
            </Button>
          </CardContent>
        </Card>
      )}

      {!isSuperAdmin && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 size={17} /> Portal de clientes
            </CardTitle>
            <CardDescription>
              Enlace exclusivo de tu organización: tus clientes consultan saldo, estado y próxima
              cuota, y solicitan créditos sin llamar a la oficina.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tenant && !tenant.clientPortalEnabled ? (
              <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
                El portal está deshabilitado para tu organización. Solicita su activación a
                ChrizDev.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={portalUrl} readOnly className="min-w-0 flex-1 font-mono text-xs" />
                  <Button size="sm" variant="secondary" onClick={() => void copyPortalLink()}>
                    <Copy size={14} /> Copiar enlace
                  </Button>
                  <Button size="sm" variant="outline" onClick={sharePortalByWhatsApp}>
                    Compartir por WhatsApp
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-400">
                  El cliente entra con su número de documento y los últimos 4 dígitos de su
                  teléfono. Solo puede consultar y solicitar; no puede modificar nada. No lo
                  compartas con otras organizaciones.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound size={17} /> Seguridad
          </CardTitle>
          <CardDescription>Cambia tu contraseña local (se guarda cifrada con SHA-256).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label>Contraseña actual</Label>
              <Input type="password" value={currentPass} onChange={(e) => setCurrentPass(e.target.value)} />
            </div>
            <div>
              <Label>Nueva contraseña</Label>
              <Input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
            </div>
            <div>
              <Label>Repetir nueva</Label>
              <Input type="password" value={repeatPass} onChange={(e) => setRepeatPass(e.target.value)} />
            </div>
          </div>
          <Button size="sm" onClick={() => void handleChangePassword()}>
            Actualizar contraseña
          </Button>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DatabaseBackup size={17} /> Respaldos de datos
          </CardTitle>
          <CardDescription>
            Exporta un respaldo completo en JSON (incluye usuarios y contraseñas cifradas para
            restaurar el acceso) o restaura la base local desde un archivo. Guárdalo en un lugar
            seguro.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void handleExportAll()}>
            Exportar todo (JSON)
          </Button>
          <label>
            <span className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Upload size={13} /> Importar respaldo
            </span>
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportAll(f);
                e.target.value = '';
              }}
            />
          </label>
        </CardContent>
      </Card>

      <Card className="mb-4 border-red-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-700">
            <ShieldAlert size={17} /> Zona de peligro
          </CardTitle>
          <CardDescription>
            Restablece la base de datos de este dispositivo: borra prestatarios, préstamos, cuotas,
            auditoría y organizaciones demo. Solo se conservan las cuentas de Super Admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" size="sm" onClick={() => setResetOpen(true)}>
            <Trash2 size={14} /> Restablecer base de datos
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start gap-3 py-4">
          <Info size={18} className="mt-0.5 shrink-0 text-slate-400" />
          <div className="text-xs leading-relaxed text-slate-500">
            <p className="font-semibold text-slate-700">PresMon by ChrizDev · v1.2.0</p>
            <p>
              PWA en línea con caché local IndexedDB (Dexie.js), motor de mora automática, score
              crediticio dinámico según comportamiento de pago, generación de pagarés PDF en el
              dispositivo y sincronización continua con Firebase Firestore (Last-Write-Wins).
            </p>
          </div>
        </CardContent>
      </Card>
      </div>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Restablecer base de datos"
        description="Esta acción es irreversible. Se borrarán TODOS los datos locales, incluida la información demo."
      >
        <div className="space-y-3">
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
            Escribe <strong>ELIMINAR</strong> para confirmar. Al finalizar se cerrará tu sesión.
          </p>
          <Input
            value={resetConfirmText}
            onChange={(e) => setResetConfirmText(e.target.value)}
            placeholder="ELIMINAR"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void handleResetDatabase()}>
              <Trash2 size={14} /> Borrar todo
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
