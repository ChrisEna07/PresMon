import { useMemo, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Building2, Globe, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import type { Tenant } from '../db/models';
import { db, saveTenant, saveUser } from '../db/db';
import { useAuth } from '../store/auth';
import { sha256Hex } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { uid } from '../lib/id';
import { formatDateTime } from '../lib/format';
import { PageHeader, StatCard } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';
import { runSync } from '../lib/sync/syncEngine';

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

  const tenants = useLiveQuery(() => db.tenants.toArray(), []);
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
      payloadSnapshot: { nombre: newName.trim(), admin: uname },
    });
    setNewName('');
    setNewUsername('');
    setNewPassword('');
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
        ? 'Portal de clientes HABILITADO para esta organización.'
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
          <TH>ENABLE_CLIENT_PORTAL</TH>
          <TH className="text-right">Acciones</TH>
        </THead>
        <TBody>
          {(tenants ?? []).map((t) => (
            <TR key={t.tenantId}>
              <TD className="font-medium text-slate-800">{t.name}</TD>
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
                    checked={t.clientPortalEnabled}
                    onChange={() => void togglePortal(t)}
                    label="Portal cliente"
                  />
                  <Badge variant={t.clientPortalEnabled ? 'info' : 'muted'}>
                    {t.clientPortalEnabled ? 'ON' : 'OFF'}
                  </Badge>
                </div>
              </TD>
              <TD className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setResetTarget(t)}>
                  <KeyRound size={13} /> Reset pass
                </Button>
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
    </div>
  );
}
