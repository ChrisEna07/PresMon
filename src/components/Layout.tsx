import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  CalendarClock,
  Calculator,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cloud,
  CloudUpload,
  Copy,
  CreditCard,
  HandCoins,
  Landmark,
  LayoutDashboard,
  Lock,
  LogOut,
  Megaphone,
  MessageCircle,
  ScrollText,
  Settings,
  ShieldCheck,
  Upload,
  Users,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { db, wipeLocalTenantData } from '../db/db';
import type { BankAccountInfo, PaymentReport, Tenant } from '../db/models';
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
import {
  openWhatsApp,
  openWhatsAppDev,
  CHRIZDEV_WHATSAPP_DISPLAY,
  CHRIZDEV_WHATSAPP_PHONE,
} from '../lib/share';
import { computeMonthlyInvoice } from '../lib/billingEngine';
import { checkOfflineTelemetry, reportPurgeConfirmation } from '../lib/offlineTelemetry';
import { compressImageFile } from '../lib/imageSupport';
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
  const [paymentBannerDismissed, setPaymentBannerDismissed] = useState(false);

  // Modales de cuentas bancarias y reporte de pago
  const [bankAccountsModalOpen, setBankAccountsModalOpen] = useState(false);
  const [reportPaymentModalOpen, setReportPaymentModalOpen] = useState(false);
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null);

  // Formulario de reporte de pago
  const [reportBank, setReportBank] = useState('');
  const [reportAmount, setReportAmount] = useState<number>(0);
  const [reportRef, setReportRef] = useState('');
  const [reportDate, setReportDate] = useState(todayStr());
  const [reportNotes, setReportNotes] = useState('');
  const [reportImageBase64, setReportImageBase64] = useState<string | null>(null);
  const [reportImageName, setReportImageName] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);

  // Comprobante pendiente de aprobación en vivo
  const pendingPaymentReport = useLiveQuery<PaymentReport | undefined>(
    async () => {
      if (!session?.tenantId) return undefined;
      const reports = await db.payment_reports
        .where('tenantId')
        .equals(session.tenantId)
        .toArray();
      const pendings = reports
        .filter((r) => r.status === 'PENDING')
        .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      return pendings[0];
    },
    [session?.tenantId],
  );

  const effectiveWhatsApp =
    tenantRecord?.paymentWhatsAppPhone?.trim() || CHRIZDEV_WHATSAPP_PHONE;
  const effectiveWhatsAppDisplay =
    tenantRecord?.paymentWhatsAppPhone?.trim() || CHRIZDEV_WHATSAPP_DISPLAY;

  const isOverdueMoreThan5Days = monthlyInvoice.isOverdueMoreThan5Days;
  const unlockedByAdmin = tenantRecord?.unlockedByAdmin === true;
  const isAutoLockedForMora = isOverdueMoreThan5Days && !unlockedByAdmin;

  const showMonthlyInvoiceBanner =
    session?.role === 'TENANT_ADMIN' &&
    monthlyInvoice.totalInvoiceAmount > 0 &&
    (monthlyInvoice.maxDaysOverdue > 0 ||
      bannerDismissedFor !== `${currentPlan?.planId}:${monthlyInvoice.totalInvoiceAmount}`);

  // Persistencia de tiempo y cierre (X) configurado por Super Admin para el banner de cobro
  const isPaymentBannerExpired =
    !!tenantRecord?.paymentBannerExpiresAt &&
    new Date(tenantRecord.paymentBannerExpiresAt).getTime() < Date.now();
  const isPaymentDismissible = tenantRecord?.paymentBannerDismissible === true;

  const showInsistentPaymentBanner =
    session?.role === 'TENANT_ADMIN' &&
    monthlyInvoice.totalInvoiceAmount > 0 &&
    tenantRecord?.paymentBannerDeactivated !== true &&
    !isPaymentBannerExpired &&
    (!isPaymentDismissible || !paymentBannerDismissed);

  // Persistencia de tiempo y cierre (X) para los avisos/notices
  const activeNotice = tenantRecord?.notice;
  const isNoticeExpired =
    !!activeNotice?.expiresAt &&
    new Date(activeNotice.expiresAt).getTime() < Date.now();
  const isNoticeDismissible = activeNotice?.dismissible !== false;

  const showNotice =
    session?.role === 'TENANT_ADMIN' &&
    !!activeNotice &&
    activeNotice.active !== false &&
    activeNotice.message.trim() !== '' &&
    !isNoticeExpired &&
    (!isNoticeDismissible || noticeDismissedAt !== activeNotice.updatedAt);

  const appLocked =
    session?.role === 'TENANT_ADMIN' &&
    (tenantRecord?.appLocked === true || isAutoLockedForMora);

  function handleOpenReportModal() {
    setReportAmount(monthlyInvoice.totalInvoiceAmount);
    setReportDate(todayStr());
    const activeBanks = (tenantRecord?.bankAccounts || []).filter((b) => b.active);
    if (activeBanks.length > 0 && !reportBank) {
      setReportBank(activeBanks[0].bankName);
    }
    setReportPaymentModalOpen(true);
  }

  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAccountId(id);
      toast('Número de cuenta copiado al portapapeles', 'success');
      setTimeout(() => setCopiedAccountId(null), 2500);
    } catch {
      toast('No se pudo copiar automáticamente', 'error');
    }
  }

  async function handleReceiptUpload(file: File) {
    try {
      const comp = await compressImageFile(file);
      setReportImageBase64(comp.dataUrl);
      setReportImageName(comp.fileName);
      toast('Comprobante procesado y optimizado correctamente', 'success');
    } catch (err: any) {
      toast(err?.message || 'Error al procesar la imagen', 'error');
    }
  }

  async function handleSendPaymentReport() {
    if (!session?.tenantId) return;
    if (!reportAmount || reportAmount <= 0) {
      toast('El monto debe ser mayor a 0.', 'error');
      return;
    }
    if (!reportRef.trim()) {
      toast('Ingresa el número de referencia o transacción.', 'error');
      return;
    }
    if (!reportImageBase64) {
      toast('Adjunta la foto o captura del comprobante.', 'error');
      return;
    }

    setSubmittingReport(true);
    try {
      const now = new Date().toISOString();
      const newReport: PaymentReport = {
        reportId: crypto.randomUUID(),
        tenantId: session.tenantId,
        amount: reportAmount,
        paymentDate: reportDate || todayStr(),
        referenceNumber: reportRef.trim(),
        bankName: reportBank.trim() || undefined,
        receiptImageBase64: reportImageBase64,
        notes: reportNotes.trim() || undefined,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        syncStatus: 'NEW',
      };

      await db.payment_reports.put(newReport);
      await db.audit_logs.put({
        logId: crypto.randomUUID(),
        tenantId: session.tenantId,
        timestamp: now,
        action: 'PAYMENT_REPORT_CREATED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: newReport.reportId,
        entityType: 'payment_report',
        payloadSnapshot: JSON.stringify({
          amount: newReport.amount,
          ref: newReport.referenceNumber,
          bank: newReport.bankName,
        }),
        createdAt: now,
        updatedAt: now,
        syncStatus: 'NEW',
      });

      toast('Comprobante enviado exitosamente para verificación.', 'success');
      setReportPaymentModalOpen(false);
      setReportImageBase64(null);
      setReportImageName('');
      setReportRef('');
      setReportNotes('');

      if (online && isSyncConfigured()) {
        void runSync(session.tenantId);
      }
    } catch (err) {
      toast('Error al enviar comprobante: ' + String(err), 'error');
    } finally {
      setSubmittingReport(false);
    }
  }

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
      await reportPurgeConfirmation(session.tenantId);
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
    const nextBannerDeactivated = remote.data.paymentBannerDeactivated === true;
    const nextWhatsApp =
      typeof remote.data.paymentWhatsAppPhone === 'string'
        ? remote.data.paymentWhatsAppPhone
        : undefined;
    const nextBankAccounts = Array.isArray(remote.data.bankAccounts)
      ? (remote.data.bankAccounts as BankAccountInfo[])
      : undefined;
    const nextPaymentDismissible = remote.data.paymentBannerDismissible === true;
    const nextPaymentExpiresAt =
      typeof remote.data.paymentBannerExpiresAt === 'string'
        ? remote.data.paymentBannerExpiresAt
        : undefined;
    const nextNotice = (remote.data.notice ?? undefined) as Tenant['notice'];
    if (!local) return;
    const changed =
      local.appLocked !== nextLocked ||
      local.unlockedByAdmin !== nextUnlocked ||
      local.offlineBlocked !== nextOfflineBlocked ||
      local.paymentBannerDeactivated !== nextBannerDeactivated ||
      local.paymentWhatsAppPhone !== nextWhatsApp ||
      local.paymentBannerDismissible !== nextPaymentDismissible ||
      local.paymentBannerExpiresAt !== nextPaymentExpiresAt ||
      JSON.stringify(local.bankAccounts ?? null) !== JSON.stringify(nextBankAccounts ?? null) ||
      JSON.stringify(local.notice ?? null) !== JSON.stringify(nextNotice ?? null);
    if (!changed) return;
    await db.tenants.put({
      ...local,
      appLocked: nextLocked,
      unlockedByAdmin: nextUnlocked,
      offlineBlocked: nextOfflineBlocked,
      paymentBannerDeactivated: nextBannerDeactivated,
      paymentWhatsAppPhone: nextWhatsApp,
      bankAccounts: nextBankAccounts,
      paymentBannerDismissible: nextPaymentDismissible,
      paymentBannerExpiresAt: nextPaymentExpiresAt,
      notice: nextNotice,
      updatedAt: String(remote.data.updatedAt ?? local.updatedAt),
      syncStatus: 'SYNCED',
    });
  }

  // Telemetría para edición offline y confirmación de purga si detecta red
  useEffect(() => {
    if (!online || !session?.tenantId) return;
    void checkOfflineTelemetry(session.tenantId).then((res) => {
      if (res.wiped) {
        logout();
        toast('Los datos locales fueron purgados por el Super Administrador.', 'error');
        navigate('/login', { replace: true });
      }
    });
  }, [online, session?.tenantId]);

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
            <span className="font-semibold">
              {activeNotice.title?.trim() ? activeNotice.title : 'Aviso de ChrizDev:'}
            </span>
            <span>{activeNotice.message}</span>
            {isNoticeDismissible && (
              <button
                onClick={() => setNoticeDismissedAt(activeNotice.updatedAt)}
                className="ml-auto cursor-pointer rounded p-1 opacity-70 hover:opacity-100"
                aria-label="Ocultar aviso"
              >
                <X size={15} />
              </button>
            )}
          </div>
        )}

        {appLocked && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/95 p-4 backdrop-blur-sm overflow-y-auto">
            <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-6 sm:p-8 text-center shadow-2xl my-8">
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

              {pendingPaymentReport && (
                <div className="mt-3 text-left rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-300">
                  <p className="font-bold flex items-center gap-1.5"><Clock size={14} /> Comprobante en revisión</p>
                  <p className="mt-1 text-slate-300">
                    Has enviado un comprobante por {formatCOP(pendingPaymentReport.amount)} (Ref: {pendingPaymentReport.referenceNumber}). El Super Admin lo está verificando para reactivar tu cuenta.
                  </p>
                </div>
              )}

              <div className="mt-5 space-y-2">
                <button
                  onClick={handleOpenReportModal}
                  className="w-full cursor-pointer rounded-xl bg-emerald-600 px-4 py-2.5 font-bold text-white transition-colors hover:bg-emerald-500 flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/30 text-xs sm:text-sm"
                >
                  <Upload size={16} /> Reportar Comprobante de Pago
                </button>
                <button
                  onClick={() => setBankAccountsModalOpen(true)}
                  className="w-full cursor-pointer rounded-xl bg-slate-800 hover:bg-slate-700 px-4 py-2.5 font-bold text-slate-200 border border-slate-700 transition-colors flex items-center justify-center gap-2 text-xs sm:text-sm"
                >
                  <Landmark size={16} /> Ver Cuentas Bancarias para Depósito
                </button>
                <button
                  onClick={() =>
                    openWhatsApp(
                      `Hola ChrizDev, soy ${session?.tenantName ?? 'un cliente'} de PresMon. Mi servicio está suspendido por factura pendiente de ${formatCOP(monthlyInvoice.totalInvoiceAmount)} (${monthlyInvoice.maxDaysOverdue} días de mora). Quiero ponerme al día o solicitar desbloqueo.`,
                      effectiveWhatsApp,
                    )
                  }
                  className="w-full cursor-pointer rounded-xl bg-slate-800/80 hover:bg-slate-700 px-4 py-2.5 font-bold text-emerald-400 border border-emerald-500/30 transition-colors flex items-center justify-center gap-2 text-xs sm:text-sm"
                >
                  <MessageCircle size={16} /> Contactar WhatsApp ({effectiveWhatsAppDisplay})
                </button>
              </div>

              <button
                onClick={() => {
                  logout();
                  navigate('/login', { replace: true });
                }}
                className="mt-4 cursor-pointer text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline block mx-auto"
              >
                Cerrar sesión en este dispositivo
              </button>
            </div>
          </div>
        )}

        <main className="mx-auto max-w-6xl p-4 pb-24 lg:pb-8">
          {showInsistentPaymentBanner && (
            <div className="relative mb-6 overflow-hidden rounded-2xl border-2 border-red-500 bg-gradient-to-br from-red-50 via-white to-amber-50 p-5 md:p-6 shadow-xl ring-4 ring-red-500/10">
              {isPaymentDismissible && (
                <button
                  onClick={() => setPaymentBannerDismissed(true)}
                  className="absolute top-3 right-3 cursor-pointer rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 transition-colors"
                  title="Cerrar aviso temporalmente"
                  aria-label="Cerrar aviso"
                >
                  <X size={18} />
                </button>
              )}
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <div className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-red-600 text-white shadow-md shadow-red-600/30">
                    <AlertTriangle size={24} />
                  </div>
                  <div className="space-y-1 pr-6">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="rounded-md bg-red-600 px-2.5 py-0.5 text-xs font-bold text-white uppercase tracking-wide">
                        {monthlyInvoice.maxDaysOverdue > 0
                          ? `Mora de ${monthlyInvoice.maxDaysOverdue} días`
                          : 'Factura exigible'}
                      </span>
                      <h3 className="text-base md:text-lg font-extrabold text-slate-900">
                        Aviso Obligatorio de Pago de Servicio
                      </h3>
                    </div>
                    <p className="text-sm font-medium text-slate-700">
                      Tu organización registra un saldo pendiente de{' '}
                      <strong className="text-red-600 text-base">{formatCOP(monthlyInvoice.totalInvoiceAmount)}</strong>
                      {monthlyInvoice.maxDaysOverdue > 0 && (
                        <span> con <strong>{monthlyInvoice.maxDaysOverdue} días de mora acumulados</strong></span>
                      )}.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 pt-0.5">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-semibold">
                        Detalle: {monthlyInvoice.summaryText}
                      </span>
                      {monthlyInvoice.cloudIncluded && (
                        <span className="rounded bg-sky-100 px-2 py-0.5 text-sky-800 font-semibold">
                          Servicio Cloud: {formatCOP(monthlyInvoice.cloudFee)}/mes
                        </span>
                      )}
                      {monthlyInvoice.installmentsAmount > 0 && (
                        <span className="rounded bg-indigo-100 px-2 py-0.5 text-indigo-800 font-semibold">
                          Cuotas app: {formatCOP(monthlyInvoice.installmentsAmount)}
                        </span>
                      )}
                    </div>
                    <p className="pt-2 text-xs font-bold text-red-700 leading-relaxed">
                      ⚠️ Advertencia: El no pago oportuno será causal de desactivación definitiva de la cuenta.
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {isPaymentDismissible
                        ? '* Este aviso cuenta con cierre temporal configurado, pero persistirá si continúa el saldo.'
                        : '* Este aviso es permanente e inamovible. Únicamente puede ser desactivado por el Super Administrador tras verificar tu pago.'}
                    </p>

                    {pendingPaymentReport && (
                      <div className="mt-2.5 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-100/80 p-3 text-xs text-amber-900 shadow-sm">
                        <Clock size={16} className="mt-0.5 shrink-0 text-amber-700" />
                        <div>
                          <p className="font-bold">Comprobante de pago en revisión por Super Admin</p>
                          <p className="text-amber-800">
                            Reportaste un pago por <strong>{formatCOP(pendingPaymentReport.amount)}</strong> (Ref: <code>{pendingPaymentReport.referenceNumber}</code>). El Super Admin está verificando la transacción para desactivar el aviso.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="w-full md:w-auto shrink-0 flex flex-col sm:flex-row md:flex-col gap-2">
                  <button
                    onClick={handleOpenReportModal}
                    className="w-full cursor-pointer rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2.5 text-center text-xs font-bold text-white shadow-md shadow-emerald-600/20 transition-all flex items-center justify-center gap-2"
                  >
                    <Upload size={15} /> Reportar Pago con Comprobante
                  </button>
                  <button
                    onClick={() => setBankAccountsModalOpen(true)}
                    className="w-full cursor-pointer rounded-xl bg-white hover:bg-slate-50 border border-slate-300 px-4 py-2.5 text-center text-xs font-bold text-slate-700 shadow-sm transition-all flex items-center justify-center gap-2"
                  >
                    <Landmark size={15} /> Cuentas para Depósito Directo
                  </button>
                  <button
                    onClick={() =>
                      openWhatsApp(
                        `Hola ChrizDev, soy ${session?.tenantName ?? 'un cliente'} de PresMon. Deseo realizar el pago de mi factura pendiente de ${formatCOP(monthlyInvoice.totalInvoiceAmount)} (${monthlyInvoice.maxDaysOverdue} días de mora) para que desactiven el aviso de cobro.`,
                        effectiveWhatsApp,
                      )
                    }
                    className="w-full cursor-pointer rounded-xl bg-slate-900 hover:bg-slate-800 px-4 py-2.5 text-center text-xs font-bold text-white shadow-sm transition-all flex items-center justify-center gap-2"
                  >
                    <MessageCircle size={15} /> WhatsApp ({effectiveWhatsAppDisplay})
                  </button>
                </div>
              </div>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      {bankAccountsModalOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                  <Landmark size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Cuentas para Depósito Directo
                  </h3>
                  <p className="text-xs text-slate-500">
                    Realiza tu consignación o transferencia sin intermediarios
                  </p>
                </div>
              </div>
              <button
                onClick={() => setBankAccountsModalOpen(false)}
                className="cursor-pointer rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {(tenantRecord?.bankAccounts || []).filter((b) => b.active).length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                  <CreditCard size={32} className="mx-auto text-slate-400 mb-2" />
                  <p className="text-sm font-semibold text-slate-700">
                    No hay cuentas bancarias configuradas aún
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Comunícate por WhatsApp para recibir los datos de transferencia directa.
                  </p>
                  <button
                    onClick={() => {
                      setBankAccountsModalOpen(false);
                      openWhatsApp(
                        `Hola ChrizDev, necesito los datos de cuenta bancaria para pagar mi mensualidad de PresMon (${formatCOP(monthlyInvoice.totalInvoiceAmount)}).`,
                        effectiveWhatsApp,
                      );
                    }}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow hover:bg-emerald-500 cursor-pointer"
                  >
                    <MessageCircle size={14} /> Solicitar Cuentas por WhatsApp
                  </button>
                </div>
              ) : (
                (tenantRecord?.bankAccounts || [])
                  .filter((b) => b.active)
                  .map((acc) => (
                    <div
                      key={acc.id}
                      className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 text-sm">{acc.bankName}</span>
                            <span className="rounded bg-slate-200/80 px-2 py-0.5 text-[10px] font-semibold text-slate-700 uppercase">
                              {acc.accountType === 'SAVINGS'
                                ? 'Ahorros'
                                : acc.accountType === 'CHECKING'
                                  ? 'Corriente'
                                  : acc.accountType === 'WALLET'
                                    ? 'Billetera Digital'
                                    : 'Cuenta'}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <span className="font-mono text-base font-black tracking-wider text-slate-800 select-all">
                              {acc.accountNumber}
                            </span>
                            <button
                              onClick={() => void copyToClipboard(acc.accountNumber, acc.id)}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-xs hover:bg-slate-50 active:scale-95 transition-all"
                              title="Copiar número"
                            >
                              {copiedAccountId === acc.id ? (
                                <>
                                  <Check size={12} className="text-emerald-600" />
                                  <span className="text-emerald-600">¡Copiado!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={12} />
                                  <span>Copiar</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="mt-2.5 border-t border-slate-100 pt-2 text-xs text-slate-600 space-y-0.5">
                        <p>
                          <span className="text-slate-400">Titular:</span> <strong>{acc.holderName}</strong>
                          {acc.holderDoc && (
                            <span className="text-slate-500"> · Doc: {acc.holderDoc}</span>
                          )}
                        </p>
                        {acc.notes && (
                          <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-0.5 mt-1">
                            ℹ️ {acc.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  ))
              )}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <button
                onClick={() => setBankAccountsModalOpen(false)}
                className="cursor-pointer rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cerrar
              </button>
              <button
                onClick={() => {
                  setBankAccountsModalOpen(false);
                  handleOpenReportModal();
                }}
                className="cursor-pointer rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-md hover:bg-emerald-500 flex items-center gap-1.5"
              >
                <Upload size={14} /> Ya consigné, reportar comprobante
              </button>
            </div>
          </div>
        </div>
      )}

      {reportPaymentModalOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl my-8">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                  <Upload size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Reportar Comprobante de Pago
                  </h3>
                  <p className="text-xs text-slate-500">
                    Envía tu captura de transferencia para aprobación del Super Admin
                  </p>
                </div>
              </div>
              <button
                onClick={() => setReportPaymentModalOpen(false)}
                className="cursor-pointer rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Monto consignado (COP) *
                  </label>
                  <input
                    type="number"
                    value={reportAmount || ''}
                    onChange={(e) => setReportAmount(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold focus:border-emerald-500 focus:outline-none"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Fecha de pago *
                  </label>
                  <input
                    type="date"
                    value={reportDate}
                    onChange={(e) => setReportDate(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Banco / Billetera destino
                  </label>
                  <input
                    type="text"
                    value={reportBank}
                    onChange={(e) => setReportBank(e.target.value)}
                    list="registeredBanks"
                    placeholder="Ej. Bancolombia, Nequi..."
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                  <datalist id="registeredBanks">
                    {(tenantRecord?.bankAccounts || [])
                      .filter((b) => b.active)
                      .map((b) => (
                        <option key={b.id} value={b.bankName} />
                      ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    N° de Referencia / Aprobación *
                  </label>
                  <input
                    type="text"
                    value={reportRef}
                    onChange={(e) => setReportRef(e.target.value)}
                    placeholder="Ej. 98412491"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Notas u observaciones adicionales
                </label>
                <input
                  type="text"
                  value={reportNotes}
                  onChange={(e) => setReportNotes(e.target.value)}
                  placeholder="Ej. Pago cuota de mayo y cloud"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Foto o Captura del comprobante *
                </label>
                {reportImageBase64 ? (
                  <div className="relative rounded-xl border border-emerald-300 bg-emerald-50/60 p-3">
                    <div className="flex items-center gap-3">
                      <img
                        src={reportImageBase64}
                        alt="Comprobante"
                        className="h-16 w-16 rounded-lg object-cover border border-emerald-200"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-emerald-900 truncate">
                          {reportImageName || 'Comprobante adjunto'}
                        </p>
                        <p className="text-[11px] text-emerald-700 flex items-center gap-1 mt-0.5">
                          <CheckCircle2 size={12} /> Imagen lista y optimizada
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setReportImageBase64(null);
                          setReportImageName('');
                        }}
                        className="cursor-pointer rounded-lg p-1.5 text-slate-400 hover:bg-emerald-100 hover:text-red-600"
                        title="Eliminar captura"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/80 p-5 text-center cursor-pointer hover:bg-slate-100/80 hover:border-emerald-500 transition-colors">
                    <Upload size={24} className="text-slate-400 mb-1.5" />
                    <span className="text-xs font-bold text-slate-700">
                      Seleccionar imagen o captura de pantalla
                    </span>
                    <span className="text-[11px] text-slate-400 mt-0.5">
                      JPG o PNG (se optimiza automáticamente)
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleReceiptUpload(file);
                      }}
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={() => setReportPaymentModalOpen(false)}
                className="cursor-pointer rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submittingReport || !reportImageBase64 || !reportRef.trim()}
                onClick={() => void handleSendPaymentReport()}
                className="cursor-pointer rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-bold text-white shadow-md hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {submittingReport ? (
                  <>Enviando...</>
                ) : (
                  <>
                    <Upload size={14} /> Enviar Comprobante
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

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
