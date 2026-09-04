import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  CalendarClock,
  Calculator,
  ClipboardList,
  Cloud,
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
import { db, wipeLocalTenantData } from '../db/db';
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
import { computeMonthlyInvoice } from '../lib/billingEngine';
import { cn, formatCOP, formatDateShort, todayStr } from '../lib/format';
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

  const currentPlan = useLiveQuery(
    async () => {
      if (!session || session.role !== 'TENANT_ADMIN' || !session.tenantId) return null;
      const orgPlans = await db.plans.where('tenantId').equals(session.tenantId).toArray();
      return orgPlans[0] ?? null;
    },
    [session?.userId, session?.tenantId],
  );

  const monthlyInvoice = useMemo(
    () => computeMonthlyInvoice(currentPlan, todayStr()),
    [currentPlan],
  );

  const [bannerDismissedFor, setBannerDismissedFor] = useState('');
  const [noticeDismissedAt, setNoticeDismissedAt] = useState('');

  const isOverdueMoreThan5Days = monthlyInvoice.isOverdueMoreThan5Days;
  const unlockedByAdmin = tenantRecord?.unlockedByAdmin === true;
  const isAutoLockedForMora = isOverdueMoreThan5Days && !unlockedByAdmin;

  const showMonthlyInvoiceBanner =
    session?.role === 'TENANT_ADMIN' &&
    monthlyInvoice.totalInvoiceAmount > 0 &&
    (monthlyInvoice.maxDaysOverdue > 0 ||
      bannerDismissedFor !== `${currentPlan?.planId}:${monthlyInvoice.totalInvoiceAmount}`);

  const activeNotice = tenantRecord?.notice;
  const showNotice =
    session?.role === 'TENANT_ADMIN' &&
    !!activeNotice &&
    activeNotice.message.trim() !== '' &&
    noticeDismissedAt !== activeNotice.updatedAt;

  const appLocked =
    session?.role === 'TENANT_ADMIN' &&
    (tenantRecord?.appLocked === true || isAutoLockedForMora);

  /**
   * Canal de CONTROL DE CUENTA: consulta el documento remoto de la
   * organización y persiste bloqueos/avisos/borrado local para que sobrevivan
   * recargas sin internet.
   */
  async function pollRemoteControl(): Promise<void> {
    if (!session || session.role !== 'TENANT_ADMIN' || !session.tenantId) return;
    if (!isSyncConfigured()) return;
    const local = await db.tenants.get(session.tenantId);
    if (local?.remoteControlEnabled === false) return;
    const remote = await fetchRemoteTenant(session.tenantId);
    if (!remote || !remote.found || !remote.data) return;
    if (remote.status === 'DELETED') return; // el guardia de sesión ya lo maneja

    // Orden remota de borrado local emitida por Super Admin
    if (remote.data.wipeLocalData === true) {
      await wipeLocalTenantData(session.tenantId);
      logout();
      toast(
        'Los datos locales de esta organización fueron borrados por el Super Administrador.',
        'error',
      );
      navigate('/login', { replace: true });
      return;
    }

    const nextLocked = remote.data.appLocked === true;
    const nextUnlocked = remote.data.unlockedByAdmin === true;
    const nextOfflineBlocked = remote.data.offlineBlocked === true;
    const nextNotice = (remote.data.notice ?? undefined) as Tenant['notice'];
    if (!local) return;
    const changed =
      local.appLocked !== nextLocked ||
      local.unlockedByAdmin !== nextUnlocked ||
      local.offlineBlocked !== nextOfflineBlocked ||
      JSON.stringify(local.notice ?? null) !== JSON.stringify(nextNotice ?? null);
    if (!changed) return;
    await db.tenants.put({
      ...local,
      appLocked: nextLocked,
      unlockedByAdmin: nextUnlocked,
      offlineBlocked: nextOfflineBlocked,
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
    { to: '/requests', label: 'Solicitudes', icon: ClipboardList },
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

        {showMonthlyInvoiceBanner && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm',
              monthlyInvoice.maxDaysOverdue > 5
                ? 'bg-red-600 text-white font-medium'
                : monthlyInvoice.maxDaysOverdue > 0
                  ? 'bg-amber-400 text-slate-950 font-medium'
                  : 'bg-sky-100 text-sky-900',
            )}
          >
            {monthlyInvoice.maxDaysOverdue > 0 ? (
              <AlertTriangle
                size={16}
                className={monthlyInvoice.maxDaysOverdue > 5 ? 'text-white' : 'text-slate-900'}
              />
            ) : (
              <Cloud size={16} className="text-sky-600" />
            )}
            <span className="font-bold">
              {monthlyInvoice.maxDaysOverdue > 5
                ? `¡Factura mensual con mora de ${monthlyInvoice.maxDaysOverdue} días!`
                : monthlyInvoice.maxDaysOverdue > 0
                  ? `Factura mensual VENCIDA (${monthlyInvoice.maxDaysOverdue} días de atraso):`
                  : 'Factura mensual del período:'}
            </span>
            <span>
              Total {formatCOP(monthlyInvoice.totalInvoiceAmount)} · {monthlyInvoice.summaryText}
            </span>
            {monthlyInvoice.maxDaysOverdue === 0 && (
              <button
                onClick={() =>
                  setBannerDismissedFor(
                    `${currentPlan?.planId}:${monthlyInvoice.totalInvoiceAmount}`,
                  )
                }
                className="ml-auto cursor-pointer rounded p-1 opacity-70 hover:opacity-100"
                aria-label="Ocultar aviso"
              >
                <X size={15} />
              </button>
            )}
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
              <h2 className="text-xl font-bold text-white">
                {isAutoLockedForMora
                  ? 'Servicio suspendido por mora (> 5 días)'
                  : 'Servicio suspendido'}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                {isAutoLockedForMora
                  ? `Tienes ${monthlyInvoice.maxDaysOverdue} días de vencimiento en tu factura mensual con ChrizDev. Para proteger la plataforma, tus operaciones están bloqueadas hasta que realices el pago o hasta que el Super Administrador desbloquee tu cuenta.`
                  : 'El acceso a PresMon está bloqueado por decisión del Super Administrador. Tus datos están a salvo y se restituirá el acceso inmediatamente después de ponerte al día.'}
              </p>
              {monthlyInvoice.totalInvoiceAmount > 0 && (
                <div className="mt-4 rounded-lg bg-red-500/10 p-3.5 text-left text-sm border border-red-500/20">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-semibold text-slate-400 uppercase">Factura mensual exigible</span>
                    {monthlyInvoice.maxDaysOverdue > 0 && (
                      <span className="font-mono text-xs font-bold text-red-400">
                        {monthlyInvoice.maxDaysOverdue} días de mora
                      </span>
                    )}
                  </div>
                  <p className="text-xl font-black text-red-400">
                    {formatCOP(monthlyInvoice.totalInvoiceAmount)}
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    {monthlyInvoice.summaryText}
                  </p>
                </div>
              )}
              <button
                onClick={() =>
                  openWhatsApp(
                    `Hola ChrizDev, soy ${session?.tenantName ?? 'un cliente'} de PresMon. Mi servicio está suspendido por factura pendiente de ${formatCOP(monthlyInvoice.totalInvoiceAmount)} (${monthlyInvoice.maxDaysOverdue} días de mora). Quiero ponerme al día o solicitar desbloqueo.`,
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
