import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cloud,
  CloudUpload,
  DatabaseBackup,
  Info,
  KeyRound,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { db } from '../db/db';
import { useAuth } from '../store/auth';
import {
  clearFirebaseConfig,
  loadFirebaseConfig,
  saveFirebaseConfig,
  type FirebaseConfig,
} from '../lib/sync/firebaseConfig';
import { getLastSync, runSync, setLastSync } from '../lib/sync/syncEngine';
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
      toast(
        `No se pudo conectar: ${err instanceof Error ? err.message : 'error desconocido'}`,
        'error',
      );
    }
  }

  async function handleSyncNow() {
    if (!session) return;
    setSyncing(true);
    try {
      const result = await runSync(isSuperAdmin ? undefined : session.tenantId);
      setLastSync(session.tenantId || 'global');
      setLastSyncAt(Date.now());
      if (result.errors.length) toast(`Errores: ${result.errors[0]}`, 'error');
      else toast(`Sincronizado: ${result.pushed} enviados · ${result.pulled} recibidos.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error de sincronización', 'error');
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
    const dump = {
      app: 'PresMon',
      version: 1,
      exportedAt: new Date().toISOString(),
      tenants: isSuperAdmin ? await db.tenants.toArray() : [],
      users: isSuperAdmin
        ? (await db.users.toArray()).map((u) => ({ ...u, passHash: '***' }))
        : [],
      borrowers: tenantId ? await db.borrowers.where('tenantId').equals(tenantId).toArray() : [],
      loans: tenantId ? await db.loans.where('tenantId').equals(tenantId).toArray() : [],
      installments: tenantId
        ? await db.installments.where('tenantId').equals(tenantId).toArray()
        : [],
      audit_logs: tenantId
        ? await db.audit_logs.where('tenantId').equals(tenantId).toArray()
        : [],
    };
    downloadBlob(
      new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }),
      `presmon-respaldo-${new Date().toISOString().slice(0, 10)}.json`,
    );
    await logAudit({
      tenantId,
      action: 'DATA_EXPORTED',
      actorId: session.userId,
      actorName: session.displayName,
      payloadSnapshot: { tipo: 'respaldo-completo-json' },
    });
    toast('Respaldo descargado.', 'success');
  }

  async function handleImportAll(file: File) {
    try {
      const text = await readFileAsText(file);
      const dump = JSON.parse(text) as Record<string, unknown[]>;
      let count = 0;
      for (const table of ['tenants', 'users', 'borrowers', 'loans', 'installments', 'audit_logs']) {
        const rows = dump[table];
        if (!Array.isArray(rows)) continue;
        const stamped = rows.map((r) => ({
          ...(r as object),
          updatedAt: new Date().toISOString(),
          syncStatus: 'PENDING',
        })) as never[];
        await db.table(table).bulkPut(stamped);
        count += rows.length;
      }
      toast(`Respaldo importado: ${count} registros marcados para sincronizar.`, 'success');
    } catch {
      toast('Archivo de respaldo inválido.', 'error');
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
    <div className="max-w-3xl">
      <PageHeader title="Ajustes" description="Seguridad, respaldos y mantenimiento local" />

      {isSuperAdmin && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cloud size={17} /> Sincronización en la nube (Firebase)
            </CardTitle>
            <CardDescription>
              La app funciona 100% offline. Las credenciales ya vienen precargadas de forma segura
              en el build (.env); puedes sobrescribirlas aquí si cambias de proyecto.
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
            <DatabaseBackup size={17} /> Respaldo local (inyección de datos)
          </CardTitle>
          <CardDescription>
            Exporta todos los datos a JSON o restaura/hidrata la base local desde un volcado.
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
            <p className="font-semibold text-slate-700">PresMon by ChrizDev · v1.1.0</p>
            <p>
              PWA offline-first con IndexedDB (Dexie.js), motor de mora automática, score crediticio
              dinámico según comportamiento de pago, generación de pagarés PDF en el dispositivo y
              sincronización opcional con Firebase Firestore (Last-Write-Wins).
            </p>
          </div>
        </CardContent>
      </Card>

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
