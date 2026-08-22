import { useMemo, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Building2,
  Copy,
  Globe,
  KeyRound,
  Link2,
  Lock,
  LockOpen,
  Megaphone,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { NoticeLevel, Tenant } from '../db/models';
import { db, deleteTenantCascade, saveTenant, saveUser } from '../db/db';
import { useAuth } from '../store/auth';
import { sha256Hex } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { uid } from '../lib/id';
import { formatDateTime } from '../lib/format';
import { PageHeader, StatCard } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, Select } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';
import { isSyncConfigured, purgeDocsFromCloud, runSync } from '../lib/sync/syncEngine';
import { exportBackup } from '../lib/backup';

function pushToCloud(): void {
  void runSync().catch(() => {
    /* reintento automático al detectar conexión */
  });
}

export default function SuperAdminPage() {
  const { session } = useAuth();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetTarget, setResetTarget] = useState<Tenant | null>(null);
  const [resetPass, setResetPass] = useState('');

  const tenants = useLiveQuery(
    () => db.tenants.where('status').notEqual('DELETED').toArray(),
    [],
  );
  const users = useLiveQuery(() => db.users.where('role').equals('TENANT_ADMIN').toArray(), []);
  const loans = useLiveQuery(() => db.loans.toArray(), []);

  const stats = useMemo(
    () => ({
      total: (tenants ?? []).length,
      active: (tenants ?? []).filter((t) => t.status === 'ACTIVE').length,
      portal: (tenants ?? []).filter((t) => t.clientPortalEnabled).length,
      admins: (users ?? []).length,
    }),
    [tenants, users],
  );

  const adminByTenant = useMemo(() => {
    const map = new Map<string, string>();
    (users ?? []).forEach((u) => map.set(u.tenantId, u.username));
    return map;
  }, [users]);

  const [editTarget, setEditTarget] = useState<Tenant | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteCounts, setDeleteCounts] = useState({ users: 0, borrowers: 0, loans: 0, installments: 0 });
  const [deleting, setDeleting] = useState(false);
  const [portalLinkTarget, setPortalLinkTarget] = useState<Tenant | null>(null);
  const [createCloud, setCreateCloud] = useState(true);
  const [noticeTarget, setNoticeTarget] = useState<Tenant | null>(null);
  const [noticeText, setNoticeText] = useState('');
  const [noticeLevel, setNoticeLevel] = useState<NoticeLevel>('info');
  const [noticeAction, setNoticeAction] = useState<'send' | 'clear'>('send');

  const portalUrl = typeof window !== 'undefined' ? `${window.location.origin}/portal` : '/portal';

  async function copyPortalLink() {
    try {
      await navigator.clipboard.writeText(portalUrl);
      toast('Enlace copiado. Compártelo con tus clientes.', 'success');
    } catch {
      toast(`Copia manual: ${portalUrl}`, 'info');
    }
  }

  function sharePortalByWhatsApp() {
    const text = encodeURIComponent(
      `Consulta el estado de tu crédito las 24 horas en este enlace: ${portalUrl} — necesitas tu número de documento y los últimos 4 dígitos de tu teléfono.`,
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  }

  async function openDeleteDialog(tenant: Tenant) {
    setDeleteTarget(tenant);
    setDeleteConfirmText('');
    const [users, borrowers, loans, installments] = await Promise.all([
      db.users.where('tenantId').equals(tenant.tenantId).count(),
      db.borrowers.where('tenantId').equals(tenant.tenantId).count(),
      db.loans.where('tenantId').equals(tenant.tenantId).count(),
      db.installments.where('tenantId').equals(tenant.tenantId).count(),
    ]);
    setDeleteCounts({ users, borrowers, loans, installments });
  }

  async function handleEditSave(e: FormEvent) {
    e.preventDefault();
    if (!session || !editTarget) return;
    if (!editName.trim()) {
      toast('El nombre no puede quedar vacío.', 'error');
      return;
    }
    await saveTenant({
      ...editTarget,
      name: editName.trim(),
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: editTarget.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'name', valor: editName.trim(), anterior: editTarget.name },
    });
    setEditTarget(null);
    pushToCloud();
    toast('Organización actualizada. Sincronizando a la nube…', 'success');
  }

  async function handleDeleteTenant() {
    if (!session || !deleteTarget) return;
    if (deleteConfirmText.trim() !== deleteTarget.name.trim()) {
      toast('El texto de confirmación no coincide con el nombre.', 'error');
      return;
    }
    setDeleting(true);
    try {
      const tenantName = deleteTarget.name;
      // 1) Tumba: la organización queda marcada DELETED y se sube a la nube
      //    ANTES de purgar datos, para que sus dispositivos lo averigüen.
      await saveTenant({
        ...deleteTarget,
        status: 'DELETED',
        updatedAt: new Date().toISOString(),
        syncStatus: 'PENDING',
      });
      let pushFailed = false;
      if (isSyncConfigured()) {
        try {
          await runSync();
        } catch {
          pushFailed = true;
        }
      }
      // 2) Borrado local en cascada + ids para purgar la nube.
      const { removed, ids } = await deleteTenantCascade(deleteTarget.tenantId);
      // 3) Purga de datos operativos en la nube. El documento de la
      //    organización NO se borra: queda como tumba DELETED.
      let purgeFailed = false;
      if (isSyncConfigured()) {
        try {
          await purgeDocsFromCloud(
            (
              ['users', 'borrowers', 'loans', 'installments', 'audit_logs', 'plans'] as const
            )
              .map((collection) => ({ collection, ids: ids[collection] ?? [] }))
              .filter((entry) => entry.ids.length > 0),
          );
        } catch {
          purgeFailed = true;
        }
      }
      await logAudit({
        tenantId: '',
        action: 'TENANT_DELETED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: deleteTarget.tenantId,
        entityType: 'tenants',
        payloadSnapshot: { nombre: tenantName, eliminados: removed },
      });
      setDeleteTarget(null);
      if (!isSyncConfigured() || (!pushFailed && !purgeFailed)) {
        toast(
          `«${tenantName}» eliminada. Sus dispositivos serán cerrados y sus datos borrados automáticamente.`,
          'success',
        );
      } else {
        toast(
          `«${tenantName}» eliminada en este dispositivo, pero sin conexión no se pudo avisar a la nube. Reconecta y vuelve a intentarlo para cerrar sus dispositivos.`,
          'info',
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error al eliminar la organización', 'error');
    } finally {
      setDeleting(false);
    }
  }

  async function toggleCloudSync(tenant: Tenant) {
    if (!session) return;
    const next = tenant.cloudSyncEnabled === false;
    await saveTenant({
      ...tenant,
      cloudSyncEnabled: next,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'cloudSyncEnabled', valor: next },
    });
    toast(
      next
        ? `Respaldo en la nube ACTIVADO para «${tenant.name}».`
        : `Respaldo en la nube DESACTIVADO para «${tenant.name}». Sus datos dejarán de sincronizar.`,
      next ? 'success' : 'warning',
    );
    pushToCloud();
  }

  async function toggleRemoteControl(tenant: Tenant) {
    if (!session) return;
    const next = tenant.remoteControlEnabled !== false;
    await saveTenant({
      ...tenant,
      remoteControlEnabled: !next,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'remoteControlEnabled', valor: !next },
    });
    toast(
      next
        ? `Control de cuenta DESACTIVADO para «${tenant.name}». Ya no recibirán bloqueos, avisos ni banner de pago.`
        : `Control de cuenta ACTIVADO para «${tenant.name}».`,
      next ? 'warning' : 'success',
    );
    pushToCloud();
  }

  async function setAppLock(tenant: Tenant, locked: boolean) {
    if (!session) return;
    await saveTenant({
      ...tenant,
      appLocked: locked,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'appLocked', valor: locked },
    });
    toast(
      locked
        ? `«${tenant.name}» BLOQUEADA. Su app quedará inutilizable al conectarse (≤30 s).`
        : `«${tenant.name}» DESBLOQUEADA. Recuperará el acceso al conectarse.`,
      locked ? 'warning' : 'success',
    );
    pushToCloud();
  }

  async function sendNotice(e: FormEvent) {
    e.preventDefault();
    if (!session || !noticeTarget) return;
    if (!noticeText.trim()) {
      toast('Escribe el mensaje del aviso.', 'error');
      return;
    }
    await saveTenant({
      ...noticeTarget,
      notice:
        noticeAction === 'clear'
          ? undefined
          : {
              message: noticeText.trim(),
              level: noticeLevel,
              updatedAt: new Date().toISOString(),
            },
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: noticeTarget.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'notice', accion: noticeAction, nivel: noticeLevel },
    });
    setNoticeTarget(null);
    setNoticeText('');
    pushToCloud();
    toast(
      noticeAction === 'clear'
        ? 'Aviso retirado.'
        : 'Aviso enviado. Aparecerá en su panel al conectarse.',
      'success',
    );
  }

  async function handleCreateTenant(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    if (!newName.trim() || !newUsername.trim() || newPassword.length < 6) {
      toast('Completa nombre, usuario y contraseña (mín. 6 caracteres).', 'error');
      return;
    }
    const uname = newUsername.trim().toLowerCase();
    const exists = await db.users.where('username').equals(uname).first();
    if (exists) {
      toast('Ese nombre de usuario ya existe.', 'error');
      return;
    }
    const tenantId = uid();
    const adminUserId = uid();
    await saveUser({
      userId: adminUserId,
      tenantId,
      username: uname,
      passHash: await sha256Hex(newPassword),
      displayName: `Admin ${newName.trim()}`,
      role: 'TENANT_ADMIN',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await saveTenant({
      tenantId,
      name: newName.trim(),
      adminUid: adminUserId,
      status: 'ACTIVE',
      clientPortalEnabled: false,
      cloudSyncEnabled: createCloud,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_CREATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenantId,
      entityType: 'tenants',
      payloadSnapshot: { nombre: newName.trim(), admin: uname, cloudSyncEnabled: createCloud },
    });
    setNewName('');
    setNewUsername('');
    setNewPassword('');
    setCreateCloud(true);
    setCreateOpen(false);
    pushToCloud();
    toast('Organización creada y activada. Sincronizando a la nube…', 'success');
  }

  async function toggleStatus(tenant: Tenant) {
    if (!session) return;
    const next = tenant.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    await saveTenant({ ...tenant, status: next });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'status', valor: next },
    });
    toast(next === 'ACTIVE' ? 'Organización activada.' : 'Organización suspendida.', 'success');
    pushToCloud();
  }

  async function togglePortal(tenant: Tenant) {
    if (!session) return;
    const next = !tenant.clientPortalEnabled;
    await saveTenant({ ...tenant, clientPortalEnabled: next });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'clientPortalEnabled', valor: next },
    });
    toast(
      next
        ? 'Portal de clientes HABILITADO. Usa el botón «Enlace» para compartirlo con los clientes.'
        : 'Portal de clientes deshabilitado.',
      'success',
    );
    pushToCloud();
  }

  async function handleResetPassword() {
    if (!session || !resetTarget) return;
    if (resetPass.length < 6) {
      toast('Mínimo 6 caracteres.', 'error');
      return;
    }
    const user = await db.users.get(resetTarget.adminUid);
    if (!user) {
      toast('Usuario administrador no encontrado.', 'error');
      return;
    }
    user.passHash = await sha256Hex(resetPass);
    user.updatedAt = new Date().toISOString();
    user.syncStatus = 'PENDING';
    await db.users.put(user);
    setResetTarget(null);
    setResetPass('');
    pushToCloud();
    toast('Contraseña del administrador restablecida. Sincronizando a la nube…', 'success');
  }

  return (
    <div>
      <PageHeader
        title="Super Admin"
        description="Control global de organizaciones (tenants) · solo ChrizDev"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> Nueva organización
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Organizaciones" value={String(stats.total)} icon={Building2} />
        <StatCard label="Activas" value={String(stats.active)} icon={ShieldCheck} tone="emerald" />
        <StatCard label="Portal habilitado" value={String(stats.portal)} icon={Globe} tone="sky" />
        <StatCard label="Administradores" value={String(stats.admins)} icon={KeyRound} tone="amber" />
      </div>

      <h2 className="mt-6 mb-2 font-semibold text-slate-700">Tenants registrados</h2>
      <TableWrap>
        <THead>
          <TH>Organización</TH>
          <TH>Admin</TH>
          <TH>Préstamos</TH>
          <TH>Creada</TH>
          <TH>Estado</TH>
          <TH>Control cuenta</TH>
          <TH>Respaldo cloud</TH>
          <TH>ENABLE_CLIENT_PORTAL</TH>
          <TH className="text-right">Acciones</TH>
        </THead>
        <TBody>
          {(tenants ?? []).map((t) => (
            <TR key={t.tenantId} className={t.appLocked ? 'bg-red-50/60' : undefined}>
              <TD className="font-medium text-slate-800">
                {t.name}
                {t.appLocked && (
                  <span className="ml-2 inline-flex items-center gap-1 align-middle">
                    <Lock size={12} className="text-red-500" />
                    <Badge variant="danger">BLOQUEADA</Badge>
                  </span>
                )}
                {!t.appLocked && t.notice && t.notice.message.trim() !== '' && (
                  <span className="ml-2">
                    <Megaphone size={12} className="inline text-sky-500" />
                  </span>
                )}
              </TD>
              <TD className="text-slate-600">{adminByTenant.get(t.tenantId) ?? '—'}</TD>
              <TD>
                {(loans ?? []).filter((l) => l.tenantId === t.tenantId).length}
              </TD>
              <TD className="text-xs text-slate-400">{formatDateTime(t.createdAt)}</TD>
              <TD>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={t.status === 'ACTIVE'}
                    onChange={() => void toggleStatus(t)}
                    label="Estado"
                  />
                  <Badge variant={t.status === 'ACTIVE' ? 'success' : 'danger'}>
                    {t.status === 'ACTIVE' ? 'ACTIVA' : 'SUSPENDIDA'}
                  </Badge>
                </div>
              </TD>
              <TD>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={t.remoteControlEnabled !== false}
                    onChange={() => void toggleRemoteControl(t)}
                    label="Control"
                  />
                  <Badge variant={t.remoteControlEnabled !== false ? 'success' : 'muted'}>
                    {t.remoteControlEnabled !== false ? 'CTRL ON' : 'CTRL OFF'}
                  </Badge>
                </div>
              </TD>
              <TD>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={t.cloudSyncEnabled !== false}
                    onChange={() => void toggleCloudSync(t)}
                    label="Respaldo"
                  />
                  <Badge variant={t.cloudSyncEnabled !== false ? 'success' : 'muted'}>
                    {t.cloudSyncEnabled !== false ? 'CLOUD' : 'OFFLINE'}
                  </Badge>
                </div>
              </TD>

              <TD>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={t.clientPortalEnabled}
                    onChange={() => void togglePortal(t)}
                    label="Portal cliente"
                  />
                  <Badge variant={t.clientPortalEnabled ? 'info' : 'muted'}>
                    {t.clientPortalEnabled ? 'ON' : 'OFF'}
                  </Badge>
                  {t.clientPortalEnabled && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Enlace para clientes"
                      onClick={() => setPortalLinkTarget(t)}
                    >
                      <Link2 size={13} /> <span className="hidden xl:inline">Enlace</span>
                    </Button>
                  )}
                </div>
              </TD>
              <TD className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    title={
                      t.appLocked
                        ? 'Desbloquear app (quitar bloqueo por impago)'
                        : 'Bloquear app por falta de pago'
                    }
                    onClick={() => void setAppLock(t, !t.appLocked)}
                  >
                    {t.appLocked ? (
                      <>
                        <LockOpen size={13} />{' '}
                        <span className="hidden xl:inline">Desbloquear</span>
                      </>
                    ) : (
                      <>
                        <Lock size={13} className="text-red-500" />{' '}
                        <span className="hidden xl:inline text-red-600">Bloquear</span>
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Enviar / retirar aviso en su panel"
                    onClick={() => {
                      setNoticeTarget(t);
                      setNoticeAction('send');
                      setNoticeText(t.notice?.message ?? '');
                      setNoticeLevel(t.notice?.level ?? 'info');
                    }}
                  >
                    <Megaphone size={13} />{' '}
                    <span className="hidden xl:inline">Aviso</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Editar nombre"
                    onClick={() => {
                      setEditTarget(t);
                      setEditName(t.name);
                    }}
                  >
                    <Pencil size={13} /> <span className="hidden xl:inline">Editar</span>
                  </Button>
                  <Button variant="ghost" size="sm" title="Restablecer contraseña del administrador" onClick={() => setResetTarget(t)}>
                    <KeyRound size={13} /> <span className="hidden xl:inline">Reset pass</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Eliminar organización"
                    className="text-red-600 hover:bg-red-50"
                    onClick={() => void openDeleteDialog(t)}
                  >
                    <Trash2 size={13} /> <span className="hidden xl:inline">Eliminar</span>
                  </Button>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </TableWrap>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Nueva organización">
        <form onSubmit={handleCreateTenant} className="space-y-3">
          <div>
            <Label>Nombre de la organización *</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ej: Prestamos La 70 S.A.S." />
          </div>
          <div>
            <Label>Usuario administrador *</Label>
            <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="admin-la70" />
          </div>
          <div>
            <Label>Contraseña inicial * (mín. 6)</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <p className="text-[11px] text-slate-400">
            El portal de clientes se crea DESHABILITADO por defecto. Actívalo cuando lo requieras.
          </p>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={createCloud}
              onChange={(e) => setCreateCloud(e.target.checked)}
              className="h-4 w-4 accent-emerald-600"
            />
            Incluye servicios de nube (respaldo y sincronización multi-dispositivo)
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit">Crear organización</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title={`Restablecer contraseña · ${resetTarget?.name ?? ''}`}
      >
        <div className="space-y-3">
          <div>
            <Label>Nueva contraseña del administrador</Label>
            <Input type="password" value={resetPass} onChange={(e) => setResetPass(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleResetPassword()}>Restablecer</Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title={`Editar organización · ${editTarget?.name ?? ''}`}
      >        <form onSubmit={handleEditSave} className="space-y-3">
          <div>
            <Label>Nombre de la organización</Label>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
              Cancelar
            </Button>
            <Button type="submit">Guardar cambios</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title={`Eliminar organización · ${deleteTarget?.name ?? ''}`}
      >
        <div className="space-y-3">
          <div className="rounded-lg bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-700">
            <p className="font-bold">ADVERTENCIA · ACCIÓN IRREVERSIBLE</p>
            <p className="mt-1">
              Se borrarán <strong>permanentemente</strong> todos los datos asociados a esta
              organización, en este dispositivo y en la nube:
            </p>
            <ul className="mt-1.5 list-inside list-disc">
              <li>{deleteCounts.users} cuenta(s) de usuario (incluido su administrador)</li>
              <li>{deleteCounts.borrowers} prestatario(s)</li>
              <li>{deleteCounts.loans} préstamo(s) y sus pagarés</li>
              <li>{deleteCounts.installments} cuota(s) con su historial de pagos</li>
              <li>Registros de auditoría de la organización</li>
            </ul>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void exportBackup()}>
            Descargar respaldo local (.json) por si acaso
          </Button>
          <div>
            <Label>
              Escribe <strong>{deleteTarget?.name}</strong> para habilitar la eliminación
            </Label>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Nombre exacto de la organización"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={deleting || deleteConfirmText.trim() !== (deleteTarget?.name.trim() ?? '')}
              onClick={() => void handleDeleteTenant()}
            >
              <Trash2 size={14} /> {deleting ? 'Eliminando…' : 'Eliminar definitivamente'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={portalLinkTarget !== null}
        onClose={() => setPortalLinkTarget(null)}
        title={`Portal de clientes · ${portalLinkTarget?.name ?? ''}`}
        description="Comparte este enlace con los clientes de la organización para que consulten su crédito sin llamar."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input value={portalUrl} readOnly className="font-mono text-xs" />
            <Button size="sm" variant="secondary" onClick={() => void copyPortalLink()}>
              <Copy size={14} /> Copiar
            </Button>
          </div>
          <div className="rounded-lg bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-800">
            <p className="font-semibold">Cómo ingresa el cliente</p>
            <ol className="mt-1 list-inside list-decimal">
              <li>Abre el enlace (funciona en cualquier navegador, no requiere instalar nada)</li>
              <li>Selecciona la organización «{portalLinkTarget?.name}»</li>
              <li>Escribe su número de documento</li>
              <li>Escribe los últimos 4 dígitos de su teléfono registrado</li>
            </ol>
            <p className="mt-1">Verá saldo, estado y próxima cuota de cada préstamo activo.</p>
          </div>
          <p className="text-[11px] text-slate-400">
            Los clientes solo pueden consultar; no ven datos de otras organizaciones ni pueden
            modificar nada.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPortalLinkTarget(null)}>
              Cerrar
            </Button>
            <Button variant="secondary" onClick={sharePortalByWhatsApp}>
              Compartir por WhatsApp
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={noticeTarget !== null}
        onClose={() => setNoticeTarget(null)}
        title={`Aviso para «${noticeTarget?.name ?? ''}»`}
        description="Se mostrará como banner en su panel al conectarse. Úsalo para recordatorios de pago o comunicados."
      >
        <form onSubmit={sendNotice} className="space-y-3">
          <div>
            <Label>Mensaje</Label>
            <Input
              value={noticeText}
              onChange={(e) => setNoticeText(e.target.value)}
              placeholder="Ej: Tu cuota venció ayer. Por favor ponte al día para evitar el bloqueo."
              autoFocus
            />
          </div>
          <div>
            <Label>Importancia</Label>
            <Select
              value={noticeLevel}
              onChange={(e) => setNoticeLevel(e.target.value as NoticeLevel)}
              disabled={noticeAction === 'clear'}
            >
              <option value="info">Informativo (azul)</option>
              <option value="warning">Advertencia (ámbar)</option>
              <option value="danger">Urgente / cobro (rojo)</option>
            </Select>
          </div>
          {noticeTarget && noticeTarget.notice && noticeTarget.notice.message.trim() !== '' && (
            <p className="text-xs text-slate-500">
              Aviso actual: «{noticeTarget.notice.message}»
            </p>
          )}
          <div className="flex justify-end gap-2">
            {noticeTarget && noticeTarget.notice && noticeTarget.notice.message.trim() !== '' && (
              <Button
                type="button"
                variant="outline"
                className="text-red-600"
                onClick={() => {
                  setNoticeAction('clear');
                  void sendNotice({ preventDefault: () => undefined } as FormEvent);
                }}
              >
                Retirar aviso
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={() => setNoticeTarget(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={noticeAction === 'clear'}>
              Enviar aviso
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
