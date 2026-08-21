import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CalendarClock,
  Calculator,
  CloudUpload,
  HandCoins,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { db } from '../db/db';
import { useAuth } from '../store/auth';
import { useOnline } from '../hooks/useOnline';
import { friendlySyncError, isSyncConfigured, runSync, setLastSync } from '../lib/sync/syncEngine';
import { cn } from '../lib/format';
import { useToast } from './ui/toast';

export default function Layout() {
  const { session, logout } = useAuth();
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

  useEffect(() => {
    if (!online) return;
    if (!isSyncConfigured() || syncing) return;
    const t = window.setTimeout(() => {
      void handleSync(true);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [online]);

  async function handleSync(silent = false) {
    if (!session || syncing) return;
    if (!isSyncConfigured()) {
      if (!silent) toast('Configura Firebase en Ajustes para sincronizar.', 'info');
      return;
    }
    setSyncing(true);
    try {
      const result = await runSync(session.role === 'SUPER_ADMIN' ? undefined : session.tenantId);
      setLastSync(session.tenantId || 'global');
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
