import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  CalendarClock,
  Calculator,
  CloudUpload,
  HandCoins,
  LayoutDashboard,
  Lock,
  LogOut,
  Megaphone,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { db } from '../db/db';
import type { Tenant } from '../db/models';
import { useAuth } from '../store/auth';
import { useOnline } from '../hooks/useOnline';
import {
  ensureSuperAdminSynced,
  fetchRemoteTenant,
  friendlySyncError,
  isSyncConfigured,
  runSync,
  setLastSync,
} from '../lib/sync/syncEngine';
import { openWhatsApp } from '../lib/share';
import { cn, addDaysStr, formatCOP, formatDateShort, todayStr } from '../lib/format';
import { useToast } from './ui/toast';

export default function Layout() {
  const { session, logout, refreshSessionFlags } = useAuth();
  const online = useOnline();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);

  const pendingCount = useLiveQuery(
    () =>
      session
        ? db.loans
            .where('syncStatus')
            .notEqual('SYNCED')
            .filter((l) => !session.tenantId || l.tenantId === session.tenantId)
            .count()
        : Promise.resolve(0),
    [session?.tenantId],
  );

  const tenantRecord = useLiveQuery<Tenant | undefined>(
    () => (session?.tenantId ? db.tenants.get(session.tenantId) : Promise.resolve(undefined)),
    [session?.tenantId],
  );
  const cloudDisabled =
    session?.role === 'TENANT_ADMIN' && tenantRecord?.cloudSyncEnabled === false;

  const duePlanItem = useLiveQuery(
    async () => {
      if (!session || session.role !== 'TENANT_ADMIN' || !session.tenantId) return null;
      const orgPlans = await db.plans.where('tenantId').equals(session.tenantId).toArray();
      const todayDate = todayStr();
      const horizon = addDaysStr(todayDate, 7);
      const pendings = orgPlans
        .flatMap((p) =>
          p.installments.map((inst) => ({ ...inst, planName: p.name, tenantRef: p.tenantId })),
        )
        .filter((i) => i.status === 'PENDING' && i.dueDate <= horizon)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const first = pendings[0];
      return first ?? null;
    },
    [session?.userId],
  );

  const [bannerDismissedFor, setBannerDismissedFor] = useState('');
  const [noticeDismissedAt, setNoticeDismissedAt] = useState('');
  const showPlanBanner = !!duePlanItem && bannerDismissedFor !== duePlanItem.installmentId;

  const activeNotice = tenantRecord?.notice;
  const showNotice =
    session?.role === 'TENANT_ADMIN' &&
    !!activeNotice &&
    activeNotice.message.trim() !== '' &&
    noticeDismissedAt !== activeNotice.updatedAt;
  const appLocked =
    session?.role === 'TENANT_ADMIN' && tenantRecord?.appLocked === true;

  /**
   * Canal de CONTROL DE CUENTA: consulta el documento remoto de la
   * organización (aunque el respaldo de datos esté apagado) y persiste
   * bloqueos/avisos localmente para que sobrevivan recargas sin internet.
   */
  async function pollRemoteControl(): Promise<void> {
    if (!session || session.role !== 'TENANT_ADMIN' || !session.tenantId) return;
    if (!isSyncConfigured()) return;
    const local = await db.tenants.get(session.tenantId);
    if (local?.remoteControlEnabled === false) return;
    const remote = await fetchRemoteTenant(session.tenantId);
    if (!remote || !remote.found || !remote.data) return;
    if (remote.status === 'DELETED') return; // el guardia de sesión ya lo maneja
    const nextLocked = remote.data.appLocked === true;
    const nextNotice = (remote.data.notice ?? undefined) as Tenant['notice'];
    if (!local) return;
    const changed =
      local.appLocked !== nextLocked ||
      JSON.stringify(local.notice ?? null) !== JSON.stringify(nextNotice ?? null);
    if (!changed) return;
    await db.tenants.put({
      ...local,
      appLocked: nextLocked,
      notice: nextNotice,
      updatedAt: String(remote.data.updatedAt ?? local.updatedAt),
      syncStatus: 'SYNCED',
    });
  }

  useEffect(() => {
    if (!online) return;
    if (!isSyncConfigured() || syncing) return;
    const t = window.setTimeout(() => {
      void handleSync(true);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [online]);

  async function enforceSessionGuard(): Promise<boolean> {
    const result = await refreshSessionFlags();
    if (result === 'org-deleted') {
      logout();
      toast(
        'Esta organización fue eliminada de la plataforma. Los datos locales fueron borrados.',
        'error',
      );
      navigate('/login', { replace: true });
      return false;
    }
    if (result === 'forced-logout') {
      logout();
      toast(
        'Tu sesión fue cerrada: la organización o la cuenta ya no están activas.',
        'error',
      );
      navigate('/login', { replace: true });
      return false;
    }
    void pollRemoteControl().catch(() => undefined);
    return true;
  }

  useEffect(() => {
    if (!session) return;
    void enforceSessionGuard();
    const id = window.setInterval(() => {
      void enforceSessionGuard();
    }, 30000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId, session?.tenantId]);

  async function handleSync(silent = false) {
    if (!session || syncing) return;
    if (cloudDisabled) {
      if (!silent)
        toast('La sincronización en la nube está desactivada para esta organización.', 'warning');
      return;
    }
    if (!isSyncConfigured()) {
      if (!silent) toast('Configura Firebase en Ajustes para sincronizar.', 'info');
      return;
    }
    setSyncing(true);
    try {
      if (session.role === 'SUPER_ADMIN') {
        await ensureSuperAdminSynced(session.userId);
      }
      const result = await runSync(session.role === 'SUPER_ADMIN' ? undefined : session.tenantId);
      setLastSync(session.tenantId || 'global');
      const guardOk = await enforceSessionGuard();
      if (!guardOk) return;
      if (result.errors.length > 0) {
        toast(`Sincronización con errores: ${friendlySyncError(result.errors[0])}`, 'error');
      } else if (!silent) {
        toast(`Sincronizado: ${result.pushed} enviados, ${result.pulled} recibidos.`, 'success');
      }
    } catch (err) {
      if (!silent) toast(friendlySyncError(err), 'error');
    } finally {
      setSyncing(false);
    }
  }

  const navItems = [
    { to: '/', label: 'Inicio', icon: LayoutDashboard, end: true },
    { to: '/borrowers', label: 'Prestatarios', icon: Users },
    { to: '/loans', label: 'Préstamos', icon: HandCoins },
    { to: '/collections', label: 'Cobros', icon: CalendarClock },
    { to: '/simulator', label: 'Simulador', icon: Calculator },
    { to: '/audit', label: 'Auditoría', icon: ScrollText },
    { to: '/settings', label: 'Ajustes', icon: Settings },
  ];
  if (session?.role === 'SUPER_ADMIN') {
    navItems.push({ to: '/super-admin', label: 'Super Admin', icon: ShieldCheck });
    navItems.push({ to: '/super/plans', label: 'Planes', icon: Wallet });
  }

  return (
    <div className="min-h-full">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-slate-900 lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 font-black text-white">
            PM
          </div>
          <div>
            <p className="leading-tight font-bold text-white">PresMon</p>
            <p className="text-[10px] tracking-wide text-slate-400 uppercase">by ChrizDev</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
                )
              }
            >
              <item.icon size={17} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-800 p-3">
          <div className="mb-2 px-2">
            <p className="truncate text-sm font-semibold text-slate-200">{session?.displayName}</p>
            <p className="truncate text-[11px] text-slate-500">{session?.tenantName}</p>
          </div>
          <button
            onClick={() => {
              logout();
              navigate('/login');
            }}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800/60 hover:text-red-300"
          >
            <LogOut size={16} /> Cerrar sesión
          </button>
        </div>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-13 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur">
          <div className="flex items-center gap-1.5 lg:hidden">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500 text-xs font-black text-white">
              PM
            </div>
            <span className="font-bold text-slate-800">PresMon</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
                online ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600',
              )}
            >
              {online ? <Wifi size={12} /> : <WifiOff size={12} />}
              {online ? 'En línea' : 'Sin conexión'}
            </span>
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors',
                (pendingCount ?? 0) > 0
                  ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200',
                syncing && 'animate-pulse',
              )}
              title="Sincronizar ahora"
            >
              <CloudUpload size={13} />
              {(pendingCount ?? 0) > 0 ? `${pendingCount} pendientes` : 'Sincronizado'}
            </button>
          </div>
        </header>

        {showPlanBanner && duePlanItem && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm',
              duePlanItem.dueDate < todayStr()
                ? 'bg-red-600 text-white'
                : 'bg-amber-100 text-amber-900',
            )}
          >
            <AlertTriangle size={16} className={duePlanItem.dueDate < todayStr() ? '' : 'text-amber-600'} />
            <span className="font-bold">
              {duePlanItem.dueDate < todayStr() ? 'Cuota vencida con ChrizDev:' : 'Recordatorio de pago:'}
            </span>
            <span>
              {duePlanItem.concept} · {formatCOP(duePlanItem.amount)} ·{' '}
              {formatDateShort(duePlanItem.dueDate)} · plan «{duePlanItem.planName}»
            </span>
            <button
              onClick={() => setBannerDismissedFor(duePlanItem.installmentId)}
              className="ml-auto cursor-pointer rounded p-1 opacity-70 hover:opacity-100"
              aria-label="Ocultar aviso"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {showNotice && activeNotice && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm',
              activeNotice.level === 'danger'
                ? 'bg-red-600 text-white'
                : activeNotice.level === 'warning'
                  ? 'bg-amber-100 text-amber-900'
                  : 'bg-sky-100 text-sky-900',
            )}
          >
            <Megaphone size={16} />
            <span className="font-semibold">Aviso de ChrizDev:</span>
            <span>{activeNotice.message}</span>
            <button
              onClick={() => setNoticeDismissedAt(activeNotice.updatedAt)}
              className="ml-auto cursor-pointer rounded p-1 opacity-70 hover:opacity-100"
              aria-label="Ocultar aviso"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {appLocked && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/95 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-8 text-center shadow-2xl">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15">
                <Lock size={32} className="text-red-500" />
              </div>
              <h2 className="text-xl font-bold text-white">Servicio suspendido</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                El acceso a PresMon está bloqueado por pagos pendientes con ChrizDev. Tus datos
                están a salvo y se restituirá el acceso inmediatamente después de ponerte al día.
              </p>
              {duePlanItem && (
                <div className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-left text-sm">
                  <p className="font-bold text-red-400">
                    Saldo pendiente: {formatCOP(duePlanItem.amount)}
                  </p>
                  <p className="text-slate-300">
                    {duePlanItem.concept} · vencía {formatDateShort(duePlanItem.dueDate)}
                  </p>
                </div>
              )}
              <button
                onClick={() =>
                  openWhatsApp(
                    `Hola ChrizDev, soy ${session?.tenantName ?? 'un cliente'} de PresMon. Quiero ponerme al día con mi plan para reactivar la app.`,
                  )
                }
                className="mt-5 w-full cursor-pointer rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white transition-colors hover:bg-emerald-500"
              >
                Contactar para pagar y reactivar
              </button>
              <button
                onClick={() => {
                  logout();
                  navigate('/login', { replace: true });
                }}
                className="mt-3 cursor-pointer text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
              >
                Cerrar sesión en este dispositivo
              </button>
            </div>
          </div>
        )}

        <main className="mx-auto max-w-6xl p-4 pb-24 lg:pb-8">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex overflow-x-auto border-t border-slate-200 bg-white lg:hidden">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex min-w-16 flex-1 flex-col items-center gap-0.5 px-2 py-2 text-[10px] font-medium',
                isActive ? 'text-emerald-600' : 'text-slate-400',
              )
            }
          >
            <item.icon size={19} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
