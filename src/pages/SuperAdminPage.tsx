import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  Building2,
  Check,
  CheckCircle,
  ChevronDown,
  Clock,
  Cloud,
  Copy,
  CreditCard,
  DatabaseZap,
  DollarSign,
  Eye,
  FileCode,
  Globe,
  HandCoins,
  HardDriveDownload,
  Image as ImageIcon,
  KeyRound,
  Landmark,
  Link2,
  Lock,
  LockOpen,
  LogOut,
  Megaphone,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  TrendingUp,
  UserX,
  Users,
  Wallet,
  Wifi,
  WifiOff,
  XCircle,
  Printer,
  Scale,
  RefreshCw,
  CloudUpload,
} from 'lucide-react';
import type {
  BankAccountInfo,
  LegalAcceptance,
  NoticeLevel,
  PaymentReport,
  PaymentReportStatus,
  PlanInstallment,
  ServicePlan,
  SingleUseSocioToken,
  Tenant,
  UserAccount,
} from '../db/models';
import { db, deleteTenantCascade, saveTenant, saveUser, wipeLocalTenantData } from '../db/db';
import { useAuth } from '../store/auth';
import { sha256Hex } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { uid } from '../lib/id';
import { addDaysStr, addMonthsStr, cn, formatCOP, formatDateShort, formatDateTime, nowISO, todayStr } from '../lib/format';
import { computeMonthlyInvoice } from '../lib/billingEngine';
import { PageHeader, StatCard } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, Select } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';
import { PortalShareModal } from '../components/PortalShareModal';
import { deepSanitize, isSyncConfigured, purgeDocsFromCloud, runSync } from '../lib/sync/syncEngine';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';
import { backupLocalTenantDataToCloud } from '../lib/offlineTelemetry';
import { exportBackup } from '../lib/backup';
import { generateLicenseKey, offlineLinkFor } from '../lib/offlineEdition';
import {
  CHRIZDEV_WHATSAPP_DISPLAY,
  CHRIZDEV_WHATSAPP_PHONE,
  CHRIZDEV_WHATSAPP_RAW,
  openWhatsApp,
} from '../lib/share';

function pushToCloud(): void {
  void runSync().catch(() => {
    /* reintento automático al detectar conexión */
  });
}

function formatDeviceSummary(deviceStr: string): string {
  if (!deviceStr) return 'Dispositivo conectado';
  const ua = deviceStr.toLowerCase();
  let browser = 'Navegador Web';
  if (ua.includes('firefox')) browser = 'Mozilla Firefox';
  else if (ua.includes('edg')) browser = 'Microsoft Edge';
  else if (ua.includes('chrome')) browser = 'Google Chrome';
  else if (ua.includes('safari')) browser = 'Apple Safari';

  let os = '';
  if (ua.includes('windows nt 10.0')) os = 'Windows 10/11';
  else if (ua.includes('windows')) os = 'Windows PC';
  else if (ua.includes('android')) os = 'Android Móvil';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS (Apple)';
  else if (ua.includes('macintosh') || ua.includes('mac os')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';

  if (os) return `${browser} en ${os}`;
  return deviceStr.length > 40 ? `${deviceStr.slice(0, 37)}…` : deviceStr;
}

export default function SuperAdminPage() {
  const { session } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
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
  const allUsers = useLiveQuery(() => db.users.toArray(), []);
  const users = useMemo(
    () => (allUsers ?? []).filter((u) => u.role === 'TENANT_ADMIN' || u.role === 'ADMIN'),
    [allUsers],
  );
  const auditLogs = useLiveQuery(() => db.audit_logs.toArray(), []);
  const loans = useLiveQuery(() => db.loans.toArray(), []);
  const plans = useLiveQuery(() => db.plans.toArray(), []);
  const installments = useLiveQuery(() => db.installments.toArray(), []);
  const borrowers = useLiveQuery(() => db.borrowers.toArray(), []);

  const latestAuditByTenant = useMemo(() => {
    const map = new Map<string, string>();
    (auditLogs ?? []).forEach((l) => {
      if (!l.tenantId) return;
      const prev = map.get(l.tenantId);
      const ts = l.timestamp || l.createdAt || '';
      if (!prev || ts > prev) {
        map.set(l.tenantId, ts);
      }
    });
    return map;
  }, [auditLogs]);

  const adminsByTenant = useMemo(() => {
    const map = new Map<string, UserAccount[]>();
    (allUsers ?? []).forEach((u) => {
      if (u.role === 'TENANT_ADMIN' || u.role === 'ADMIN') {
        const list = map.get(u.tenantId) ?? [];
        list.push(u);
        map.set(u.tenantId, list);
      }
    });
    return map;
  }, [allUsers]);

  const planByTenant = useMemo(() => {
    const map = new Map<string, ServicePlan>();
    (plans ?? []).forEach((p) => map.set(p.tenantId, p));
    return map;
  }, [plans]);

  const [wipeTarget, setWipeTarget] = useState<Tenant | null>(null);
  const [wiping, setWiping] = useState(false);
  const [wipeLockOrg, setWipeLockOrg] = useState(false);
  const [wipeForceReissue, setWipeForceReissue] = useState(false);

  // Estados para Administrar Administradores y Sesiones
  const [adminManageTarget, setAdminManageTarget] = useState<Tenant | null>(null);
  const [adminPolicyMax, setAdminPolicyMax] = useState<number>(1);
  const [adminPolicyMultiSession, setAdminPolicyMultiSession] = useState<boolean>(false);

  // Estados para Módulo Socio y Tokens de Único Uso
  const [socioLinkTarget, setSocioLinkTarget] = useState<Tenant | null>(null);
  const [generatedSocioLink, setGeneratedSocioLink] = useState<string | null>(null);

  // Estado de carga para switches
  const [togglingTenantId, setTogglingTenantId] = useState<string | null>(null);

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
  const [offlineTargetId, setOfflineTargetId] = useState('');
  const [offlinePaid, setOfflinePaid] = useState(false);
  const [noticeTarget, setNoticeTarget] = useState<Tenant | null>(null);
  const [noticeText, setNoticeText] = useState('');
  const [noticeLevel, setNoticeLevel] = useState<NoticeLevel>('info');
  const [noticeAction, setNoticeAction] = useState<'send' | 'clear'>('send');

  // Estados para Migración Asistida de Offline a Online
  const [migrateTarget, setMigrateTarget] = useState<Tenant | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateConfirmText, setMigrateConfirmText] = useState('');

  // Filtro de Organizaciones: Todas / En Línea / Offline
  const [orgFilterMode, setOrgFilterMode] = useState<'ALL' | 'ONLINE' | 'OFFLINE'>('ALL');

  const onlineTenantsCount = useMemo(
    () => (tenants ?? []).filter((t) => !t.offlineLicense).length,
    [tenants],
  );
  const offlineTenantsCount = useMemo(
    () => (tenants ?? []).filter((t) => Boolean(t.offlineLicense)).length,
    [tenants],
  );

  const filteredTenants = useMemo(() => {
    return (tenants ?? []).filter((t) => {
      if (orgFilterMode === 'ONLINE') return !t.offlineLicense;
      if (orgFilterMode === 'OFFLINE') return Boolean(t.offlineLicense);
      return true;
    });
  }, [tenants, orgFilterMode]);

  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'tenants' | 'banners' | 'reports' | 'legal'>(() => {
    if (urlTab === 'banners' || urlTab === 'reports' || urlTab === 'legal') return urlTab;
    return 'tenants';
  });

  const paymentReports = useLiveQuery(() => db.payment_reports.reverse().sortBy('createdAt'), []);
  const pendingReportsCount = useMemo(
    () => (paymentReports ?? []).filter((r) => r.status === 'PENDING').length,
    [paymentReports],
  );

  const legalAcceptances = useLiveQuery(() => db.legal_acceptances.reverse().sortBy('acceptedAt'), []);
  const [selectedCertificate, setSelectedCertificate] = useState<LegalAcceptance | null>(null);
  const [legalSearchTenant, setLegalSearchTenant] = useState<string>('');

  // Estados para Banners y Cobros
  const [selectedBannerTenantId, setSelectedBannerTenantId] = useState<string>(
    searchParams.get('tenantId') || '',
  );

  // Menú desplegable de acciones flotante (posicionado de forma fija para evitar recorte por overflow)
  interface ActionMenuState {
    tenant: Tenant;
    top: number;
    right: number;
  }
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);

  useEffect(() => {
    function handleClose() {
      if (actionMenu) setActionMenu(null);
    }
    window.addEventListener('scroll', handleClose, true);
    window.addEventListener('resize', handleClose);
    return () => {
      window.removeEventListener('scroll', handleClose, true);
      window.removeEventListener('resize', handleClose);
    };
  }, [actionMenu]);

  // Escucha en tiempo real de Firestore para Super Admin:
  // Permite reflejar latidos de conexión (online/offline), confirmaciones de purga
  // y cambios de estado en menos de 1 segundo sin requerir recargar la página.
  useEffect(() => {
    if (!isSyncConfigured()) return;
    let unsubTenants: (() => void) | undefined;
    let unsubPlans: (() => void) | undefined;
    let isCancelled = false;

    (async () => {
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        const cfg = loadFirebaseConfig();
        if (!cfg || isCancelled) return;
        const { initializeApp, getApps } = await import('firebase/app');
        const { getFirestore, collection, onSnapshot } = await import('firebase/firestore');
        const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));

        if (isCancelled) return;

        unsubTenants = onSnapshot(
          collection(fs, 'tenants'),
          async (snap) => {
            try {
              const remoteTenants = snap.docs.map((d) => d.data() as Tenant);
              if (remoteTenants.length > 0) {
                await db.tenants.bulkPut(remoteTenants.map((t) => ({ ...t, syncStatus: 'SYNCED' })));
              }
            } catch (err) {
              console.warn('[SuperAdmin] Error almacenando tenants en vivo:', err);
            }
          },
          (err) => {
            console.warn('[SuperAdmin] Listener tenants offline o desconectado:', err);
          },
        );

        unsubPlans = onSnapshot(
          collection(fs, 'plans'),
          async (snap) => {
            try {
              const remotePlans = snap.docs.map((d) => d.data() as ServicePlan);
              if (remotePlans.length > 0) {
                await db.plans.bulkPut(remotePlans.map((p) => ({ ...p, syncStatus: 'SYNCED' })));
              }
            } catch (err) {
              console.warn('[SuperAdmin] Error almacenando planes en vivo:', err);
            }
          },
          (err) => {
            console.warn('[SuperAdmin] Listener plans offline o desconectado:', err);
          },
        );
      } catch (err) {
        console.warn('[SuperAdmin] Error en realtime listener:', err);
      }
    })();

    return () => {
      isCancelled = true;
      try {
        unsubTenants?.();
        unsubPlans?.();
      } catch {
        /* noop */
      }
    };
  }, []);

  function getTenantOnlineInfo(t: Tenant): {
    badgeVariant: 'success' | 'warning' | 'muted' | 'danger' | 'info';
    text: string;
    tooltip: string;
    isLive: boolean;
  } {
    const auditTime = latestAuditByTenant.get(t.tenantId);
    const candidates = [t.lastSeenOnlineAt, t.offlineOnlineDetectedAt, auditTime].filter(Boolean) as string[];
    candidates.sort();
    const seenAt = candidates.pop();

    if (!seenAt) {
      return {
        badgeVariant: 'muted',
        text: 'Sin registro',
        tooltip: 'Esta organización no ha registrado conexiones online ni actividad en auditoría todavía.',
        isLive: false,
      };
    }

    const timeVal = new Date(seenAt).getTime();
    if (isNaN(timeVal)) {
      return {
        badgeVariant: 'muted',
        text: 'Sin registro',
        tooltip: 'Esta organización no ha registrado conexiones válidas.',
        isLive: false,
      };
    }

    const elapsedMs = Math.max(0, Date.now() - timeVal);
    const elapsedMins = elapsedMs / 60000;
    const device = t.lastSeenDevice || t.offlineDeviceInfo || (auditTime === seenAt ? 'Registro en Auditoría' : 'Navegador Web');

    if (elapsedMins <= 4) {
      if (t.offlineLicense || t.offlineOnlineDetected) {
        return {
          badgeVariant: 'warning',
          text: '🟢 OFFLINE CON RED',
          tooltip: `App edición offline con internet activo ahora. Último latido: ${formatDateTime(seenAt)}. Dispositivo: ${device}`,
          isLive: true,
        };
      }
      return {
        badgeVariant: 'success',
        text: '🟢 EN LÍNEA',
        tooltip: `Conexión activa ahora en la plataforma. Último latido: ${formatDateTime(seenAt)}. Dispositivo: ${device}`,
        isLive: true,
      };
    }

    if (elapsedMins < 60) {
      return {
        badgeVariant: 'info',
        text: `Hace ${Math.round(elapsedMins)} min`,
        tooltip: `Última conexión registrada: ${formatDateTime(seenAt)}. Dispositivo: ${device}`,
        isLive: false,
      };
    }

    const hours = Math.round(elapsedMins / 60);
    if (hours < 24) {
      return {
        badgeVariant: 'muted',
        text: `Hace ${hours} h`,
        tooltip: `Última conexión registrada: ${formatDateTime(seenAt)}. Dispositivo: ${device}`,
        isLive: false,
      };
    }

    return {
      badgeVariant: 'muted',
      text: `Visto ${formatDateTime(seenAt).slice(0, 10)}`,
      tooltip: `Última conexión registrada: ${formatDateTime(seenAt)}. Dispositivo: ${device}`,
      isLive: false,
    };
  }

  const [analyticsViewOpen, setAnalyticsViewOpen] = useState(true);
  const [showOrgPortfolio, setShowOrgPortfolio] = useState(false);
  const [selectedPortfolioOrgId, setSelectedPortfolioOrgId] = useState<string>('ALL');

  const globalMetrics = useMemo(() => {
    const activeTenantsList = (tenants ?? []).filter((t) => t.status !== 'DELETED');
    const tenantIdsSet = new Set(activeTenantsList.map((t) => t.tenantId));

    // 1. Cobros e Ingresos de PresMon a las Organizaciones (Finanzas SaaS ChrizDev)
    let totalPlanContracted = 0;
    let totalPlanCollected = 0;
    let totalPlanOverdue = 0;
    let totalOverdueInstallmentsAmount = 0;
    let totalOverdueCloudAmount = 0;
    let tenantsInMoraCount = 0;
    let totalCloudRecurringMonthly = 0;
    let contadoTenantsCount = 0;
    let contadoTotalAmount = 0;
    let financedTenantsCount = 0;

    activeTenantsList.forEach((t) => {
      const plan = planByTenant.get(t.tenantId);
      if (!plan) return;
      const invoice = computeMonthlyInvoice(plan);
      if (invoice.isOverdueMoreThan5Days) tenantsInMoraCount++;
      totalPlanOverdue += invoice.totalOverdueAmount;

      const cloudOverdue = (invoice.overdueCloudCyclesCount || 0) * (Number(plan.cloudMonthlyFee) || 0);
      totalOverdueCloudAmount += cloudOverdue;
      totalOverdueInstallmentsAmount += Math.max(0, invoice.totalOverdueAmount - cloudOverdue);

      if (plan.cloudServiceIncluded && (Number(plan.cloudMonthlyFee) || 0) > 0) {
        totalCloudRecurringMonthly += Number(plan.cloudMonthlyFee) || 0;
      }

      if (plan.appPaymentMode === 'FULL' || Boolean(t.offlineLicense)) {
        const fullVal = Number(plan.appTotalAmount) || (t.offlineLicense ? 150000 : 0);
        totalPlanContracted += fullVal;
        totalPlanCollected += fullVal;
        contadoTenantsCount++;
        contadoTotalAmount += fullVal;
      } else {
        financedTenantsCount++;
      }
      (plan.installments ?? []).forEach((inst) => {
        if (inst.status === 'CANCELLED') return;
        totalPlanContracted += Number(inst.amount) || 0;
        if (inst.status === 'PAID') {
          totalPlanCollected += Number(inst.amount) || 0;
        } else {
          totalPlanCollected += Number(inst.paidAmount) || 0;
        }
      });
    });

    const totalPlanPending = Math.max(0, totalPlanContracted - totalPlanCollected);

    // 2. Operación Global de Préstamos (Cartera en calle de las Organizaciones)
    const validLoans = (loans ?? []).filter((l) => tenantIdsSet.has(l.tenantId) && l.status !== 'CANCELLED');
    const validInstallments = (installments ?? []).filter((i) => tenantIdsSet.has(i.tenantId));
    
    const totalLoansPrincipal = validLoans.reduce((sum, l) => sum + (Number(l.principalAmount) || 0), 0);
    const totalLoansPaid = validInstallments.reduce((sum, i) => sum + (Number(i.amountPaid) || 0), 0);
    const totalInstallmentsReceivable = validInstallments.reduce((sum, i) => sum + (Number(i.totalAmountWithLateFee || i.baseAmountDue) || 0), 0);
    const totalLoansPending = Math.max(0, totalInstallmentsReceivable - totalLoansPaid);

    // 3. Top Organizaciones con más Uso (Eventos de Auditoría)
    const auditCountByTenant = new Map<string, number>();
    (auditLogs ?? []).forEach((l) => {
      if (!l.tenantId || !tenantIdsSet.has(l.tenantId)) return;
      auditCountByTenant.set(l.tenantId, (auditCountByTenant.get(l.tenantId) ?? 0) + 1);
    });

    const topTenantsByUsage = [...activeTenantsList]
      .map((t) => ({
        tenant: t,
        auditCount: auditCountByTenant.get(t.tenantId) ?? 0,
        onlineInfo: getTenantOnlineInfo(t),
      }))
      .sort((a, b) => b.auditCount - a.auditCount)
      .slice(0, 5);

    // 4. Top Organizaciones con más Préstamos y Cartera
    const loansByTenantMap = new Map<string, { count: number; totalAmount: number }>();
    validLoans.forEach((l) => {
      const prev = loansByTenantMap.get(l.tenantId) ?? { count: 0, totalAmount: 0 };
      loansByTenantMap.set(l.tenantId, {
        count: prev.count + 1,
        totalAmount: prev.totalAmount + (Number(l.principalAmount) || 0),
      });
    });

    const topTenantsByPortfolio = [...activeTenantsList]
      .map((t) => {
        const stats = loansByTenantMap.get(t.tenantId) ?? { count: 0, totalAmount: 0 };
        return {
          tenant: t,
          loansCount: stats.count,
          totalAmount: stats.totalAmount,
        };
      })
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 5);

    // 5. Organizaciones con Deuda Pendiente (Cálculo exacto: cuotas pendientes + mensualidades cloud exigibles)
    const tenantsWithDebtList = activeTenantsList
      .map((t) => {
        const plan = planByTenant.get(t.tenantId);
        const invoice = plan ? computeMonthlyInvoice(plan) : null;
        let pendingApp = 0;
        if (plan && plan.appPaymentMode !== 'FULL' && !t.offlineLicense) {
          (plan.installments ?? []).forEach((i) => {
            if (i.status === 'PENDING') {
              pendingApp += Math.max(0, (Number(i.amount) || 0) - (Number(i.paidAmount) || 0));
            }
          });
        }
        // cloudDue es la porción de servicios cloud exigibles en la factura
        const cloudDue = (invoice && !t.offlineLicense) ? Math.max(0, invoice.totalInvoiceAmount - invoice.installmentsAmount) : 0;
        const totalDue = pendingApp + cloudDue;

        return {
          tenant: t,
          invoice,
          pendingApp,
          totalDue,
          isOverdue: invoice?.isOverdueMoreThan5Days ?? false,
        };
      })
      .filter((item) => item.totalDue > 0)
      .sort((a, b) => b.totalDue - a.totalDue)
      .slice(0, 5);

    return {
      totalPlanContracted,
      totalPlanCollected,
      totalPlanPending,
      totalPlanOverdue,
      totalOverdueInstallmentsAmount,
      totalOverdueCloudAmount,
      totalCloudRecurringMonthly,
      tenantsInMoraCount,
      contadoTenantsCount,
      contadoTotalAmount,
      financedTenantsCount,
      totalLoansPrincipal,
      totalLoansPaid,
      totalLoansPending,
      validLoansCount: validLoans.length,
      borrowersCount: (borrowers ?? []).filter((b) => tenantIdsSet.has(b.tenantId)).length,
      topTenantsByUsage,
      topTenantsByPortfolio,
      tenantsWithDebtList,
    };
  }, [tenants, planByTenant, loans, installments, auditLogs, borrowers]);

  const portfolioMetrics = useMemo(() => {
    const activeTenantsList = (tenants ?? []).filter((t) => t.status !== 'DELETED');
    const tenantIdsSet = new Set(activeTenantsList.map((t) => t.tenantId));

    // Filtrar préstamos según la organización seleccionada ('ALL' o tenantId específico)
    const targetLoans = (loans ?? []).filter((l) => {
      if (l.status === 'CANCELLED') return false;
      if (!tenantIdsSet.has(l.tenantId)) return false;
      if (selectedPortfolioOrgId !== 'ALL' && l.tenantId !== selectedPortfolioOrgId) return false;
      return true;
    });

    const targetLoanIds = new Set(targetLoans.map((l) => l.loanId));
    const targetInstallments = (installments ?? []).filter((i) => targetLoanIds.has(i.loanId));

    // 1. Capital colocado (prestado)
    const totalPrincipalPlaced = targetLoans.reduce((sum, l) => sum + (Number(l.principalAmount) || 0), 0);

    // 2. Tasa promedio de colocación
    const avgInterestRate = targetLoans.length > 0
      ? targetLoans.reduce((sum, l) => sum + (Number(l.interestRatePercent) || 0), 0) / targetLoans.length
      : 0;

    let minRate = targetLoans.length > 0 ? Number(targetLoans[0].interestRatePercent) || 0 : 0;
    let maxRate = minRate;
    targetLoans.forEach((l) => {
      const r = Number(l.interestRatePercent) || 0;
      if (r < minRate) minRate = r;
      if (r > maxRate) maxRate = r;
    });

    // 3. Ganancias fijas (ya pagadas) y Ganancia esperada (por pagar)
    let fixedEarningsPaid = 0;
    let totalContractInterest = 0;
    let principalPaid = 0;

    targetInstallments.forEach((inst) => {
      const instInterest = Number(inst.interestAmount) || 0;
      const instPrincipal = Number(inst.principalAmount) || 0;
      const instBase = Number(inst.baseAmountDue) || (instInterest + instPrincipal);
      const paid = Number(inst.amountPaid) || 0;

      totalContractInterest += instInterest;

      if (inst.status === 'PAID') {
        fixedEarningsPaid += instInterest;
        principalPaid += instPrincipal;
      } else if (paid > 0 && instBase > 0) {
        const ratio = Math.min(1, paid / instBase);
        fixedEarningsPaid += instInterest * ratio;
        principalPaid += instPrincipal * ratio;
      }
    });

    const expectedEarningsPending = Math.max(0, totalContractInterest - fixedEarningsPaid);
    const principalPending = Math.max(0, totalPrincipalPlaced - principalPaid);
    const uniqueBorrowersCount = new Set(targetLoans.map((l) => l.borrowerId)).size;

    return {
      totalPrincipalPlaced: Math.round(totalPrincipalPlaced),
      avgInterestRate: Number(avgInterestRate.toFixed(1)),
      minRate,
      maxRate,
      fixedEarningsPaid: Math.round(fixedEarningsPaid),
      expectedEarningsPending: Math.round(expectedEarningsPending),
      totalContractInterest: Math.round(totalContractInterest),
      principalPaid: Math.round(principalPaid),
      principalPending: Math.round(principalPending),
      loansCount: targetLoans.length,
      borrowersCount: uniqueBorrowersCount,
    };
  }, [loans, installments, tenants, selectedPortfolioOrgId]);

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam === 'banners' || tabParam === 'reports' || tabParam === 'tenants' || tabParam === 'legal') {
      setActiveTab(tabParam);
    }
    const tenantParam = searchParams.get('tenantId');
    if (tenantParam) {
      setSelectedBannerTenantId(tenantParam);
    }
  }, [searchParams]);

  function handleSelectTab(tab: 'tenants' | 'banners' | 'reports' | 'legal') {
    setActiveTab(tab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'tenants') next.delete('tab');
      else next.set('tab', tab);
      return next;
    });
  }

  const bannerTenant = useMemo(() => {
    if (!tenants || tenants.length === 0) return null;
    return (
      tenants.find((t) => t.tenantId === selectedBannerTenantId) ?? tenants[0]
    );
  }, [tenants, selectedBannerTenantId]);

  const [bannerTitle, setBannerTitle] = useState('');
  const [bannerMessage, setBannerMessage] = useState('');
  const [bannerLevel, setBannerLevel] = useState<NoticeLevel>('warning');
  const [bannerExpiresAt, setBannerExpiresAt] = useState('');
  const [bannerDismissible, setBannerDismissible] = useState(false);
  const [bannerDisplayMode, setBannerDisplayMode] = useState<'banner' | 'card_window'>('banner');
  const [paymentPhone, setPaymentPhone] = useState('');
  const [paymentDismissible, setPaymentDismissible] = useState(false);

  useEffect(() => {
    if (!bannerTenant) return;
    setBannerTitle(bannerTenant.notice?.title ?? '');
    setBannerMessage(bannerTenant.notice?.message ?? '');
    setBannerLevel(bannerTenant.notice?.level ?? 'warning');
    setBannerExpiresAt(bannerTenant.notice?.expiresAt ?? '');
    setBannerDismissible(bannerTenant.notice?.dismissible ?? false);
    setBannerDisplayMode(bannerTenant.notice?.displayMode ?? 'banner');
    setPaymentPhone(bannerTenant.paymentWhatsAppPhone ?? '');
    setPaymentDismissible(bannerTenant.paymentBannerDismissible ?? false);
  }, [bannerTenant?.tenantId]);

  // Cuentas bancarias
  const [bankDialogOpen, setBankDialogOpen] = useState(false);
  const [editingBankId, setEditingBankId] = useState<string | null>(null);
  const [bankName, setBankName] = useState('');
  const [bankAccountType, setBankAccountType] = useState<BankAccountInfo['accountType']>('WALLET');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankHolderName, setBankHolderName] = useState('');
  const [bankHolderDoc, setBankHolderDoc] = useState('');
  const [bankNotes, setBankNotes] = useState('');

  // Comprobantes de pago
  const [reportFilter, setReportFilter] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const [viewingReceipt, setViewingReceipt] = useState<PaymentReport | null>(null);
  const [rejectReportTarget, setRejectReportTarget] = useState<PaymentReport | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const portalUrlFor = (tenant: Tenant | null) =>
    typeof window !== 'undefined' && tenant
      ? `${window.location.origin}/portal?t=${tenant.tenantId}`
      : '/portal';

  async function copyPortalLink() {
    try {
      await navigator.clipboard.writeText(portalUrlFor(portalLinkTarget));
      toast('Enlace copiado. Solo da acceso a esta organización.', 'success');
    } catch {
      toast(`Copia manual: ${portalUrlFor(portalLinkTarget)}`, 'info');
    }
  }

  function sharePortalByWhatsApp() {
    const url = portalUrlFor(portalLinkTarget);
    const org = portalLinkTarget?.name ?? '';
    const text = encodeURIComponent(
      `Consulta el estado de tu crédito las 24 horas en este enlace (${org}): ${url} — necesitas tu número de documento y los últimos 4 dígitos de tu teléfono. ¿Buscas un préstamo? También puedes solicitarlo desde ahí.`,
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  }

  const offlineTarget = useMemo(
    () => (tenants ?? []).find((t) => t.tenantId === offlineTargetId) ?? null,
    [tenants, offlineTargetId],
  );

  async function issueOfflineLicense() {
    if (!session || !offlineTarget) return;
    if (!offlinePaid) {
      toast('Confirma el pago TOTAL de la licencia antes de generar el enlace.', 'error');
      return;
    }
    await saveTenant({
      ...offlineTarget,
      offlineLicense: {
        key: generateLicenseKey(),
        issuedAt: new Date().toISOString(),
        issuedByName: session.displayName,
      },
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: offlineTarget.tenantId,
      actorId: session.userId,
      actorName: session.displayName,
      action: 'TENANT_UPDATED',
      entityType: 'tenants',
      entityId: offlineTarget.tenantId,
      payloadSnapshot: {
        campo: 'offlineLicense',
        org: offlineTarget.name,
        clave: 'OFF-****',
      },
    });
    pushToCloud();
    toast('Licencia generada. Envíale el enlace al cliente.', 'success');
  }

  async function copyOfflineLink() {
    try {
      await navigator.clipboard.writeText(offlineLinkFor(offlineTarget!));
      toast('Enlace de instalación copiado.', 'success');
    } catch {
      toast(`Copia manual: ${offlineLinkFor(offlineTarget!)}`, 'info');
    }
  }

  function shareOfflineByWhatsApp() {
    const url = offlineLinkFor(offlineTarget!);
    const org = offlineTarget?.name ?? '';
    const text = encodeURIComponent(
      `Tu edición OFFLINE de PresMon (${org}) está lista. Abre este enlace con internet UNA sola vez para instalar la app y tu base de datos en el dispositivo: ${url}`,
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
              ['users', 'borrowers', 'loans', 'installments', 'audit_logs', 'plans', 'loan_requests'] as const
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

  async function toggleRemoteControl(tenant: Tenant) {
    if (!session || togglingTenantId) return;
    setTogglingTenantId(tenant.tenantId);
    try {
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
    } finally {
      setTogglingTenantId(null);
    }
  }

  async function setAppLock(tenant: Tenant, locked: boolean) {
    if (!session) return;
    if (tenant.appLocked === locked) {
      toast(
        `«${tenant.name}» ya se encuentra ${locked ? 'BLOQUEADA' : 'DESBLOQUEADA'}. No es necesario repetir la acción.`,
        'info',
      );
      return;
    }
    const now = new Date().toISOString();
    await saveTenant({
      ...tenant,
      appLocked: locked,
      unlockedByAdmin: !locked,
      paymentBannerDeactivated: !locked ? true : tenant.paymentBannerDeactivated,
      wipeLocalData: false,
      notice: !locked
        ? {
            title: 'Aviso del Servicio Cloud',
            message:
              'Recuerda que no pagar tu servicio cloud mensual es causal de bloqueo ya que los gastos de servicio cloud no pueden ser pagados si tu no pagas el servicio',
            level: 'warning',
            dismissible: true,
            updatedAt: now,
            active: true,
          }
        : tenant.notice,
      updatedAt: now,
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: '',
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'appLocked', valor: locked, unlockedByAdmin: !locked },
    });
    toast(
      locked
        ? `«${tenant.name}» BLOQUEADA. Su app quedará inutilizable al conectarse (≤30 s).`
        : `«${tenant.name}» DESBLOQUEADA. Desbloqueo administrativo aplicado (incluso si tiene mora > 5 días).`,
      locked ? 'warning' : 'success',
    );
    pushToCloud();
  }

  async function handleWipeTenantLocalData() {
    if (!session || !wipeTarget) return;
    setWiping(true);
    try {
      await wipeLocalTenantData(wipeTarget.tenantId);
      const updated: Tenant = {
        ...wipeTarget,
        wipeLocalData: true,
        wipeConfirmedAt: undefined, // Reinicia confirmación para la nueva orden
        wipeConfirmedDevice: undefined,
        offlineBlocked: true,
        appLocked: wipeLockOrg ? true : (wipeTarget.appLocked ?? false),
        unlockedByAdmin: wipeLockOrg ? false : (wipeTarget.unlockedByAdmin ?? false),
        updatedAt: new Date().toISOString(),
        syncStatus: 'PENDING',
      };
      await saveTenant(updated);

      // Enviar orden de purga inmediatamente a Firestore
      const cfg = loadFirebaseConfig();
      if (cfg) {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getFirestore, doc, setDoc } = await import('firebase/firestore');
        const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
        await setDoc(doc(fs, 'tenants', wipeTarget.tenantId), deepSanitize(updated), { merge: true });
      }

      await logAudit({
        tenantId: '',
        action: 'TENANT_UPDATED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: wipeTarget.tenantId,
        entityType: 'tenants',
        payloadSnapshot: {
          accion: 'BORRADO_DATOS_LOCALES_Y_REVOCACION_OFFLINE',
          nombre: wipeTarget.name,
          bloqueoOrgAplicado: wipeLockOrg,
        },
      });
      pushToCloud();
      toast(
        wipeLockOrg
          ? `Datos locales de «${wipeTarget.name}» purgados en este equipo. Se emitió orden remota de purga y se bloqueó el acceso a la organización.`
          : `Datos locales de «${wipeTarget.name}» purgados en este equipo. Se emitió orden remota de purga offline sin bloquear el acceso online de la organización.`,
        'success',
      );
      setWipeTarget(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error al purgar datos locales', 'error');
    } finally {
      setWiping(false);
    }
  }

  async function handleMigrateToOnline(t: Tenant) {
    setMigrating(true);
    try {
      const now = nowISO();
      // 1. Crear respaldo seguro de la organización en Firestore antes de migrar
      await backupLocalTenantDataToCloud(t.tenantId, 'MIGRATE_TO_ONLINE');

      // 2. Actualizar documento de la organización en Firestore
      const cfg = loadFirebaseConfig();
      if (cfg) {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getFirestore, doc, setDoc } = await import('firebase/firestore');
        const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));

        await setDoc(
          doc(fs, 'tenants', t.tenantId),
          deepSanitize({
            offlineLicense: null,
            offlineEditionEnabled: false,
            tenantMode: 'online',
            migrationAction: 'MIGRATE_TO_ONLINE',
            migrationRequestedAt: now,
            appLocked: false,
            offlineBlocked: false,
            unlockedByAdmin: true,
            updatedAt: now,
          }),
          { merge: true },
        );
      }

      // 3. Actualizar registro en Dexie local
      await db.tenants.update(t.tenantId, {
        offlineLicense: undefined,
        offlineBlocked: false,
        appLocked: false,
        unlockedByAdmin: true,
        updatedAt: now,
      });

      toast(`¡Organización «${t.name}» migrada exitosamente a Modo Online con respaldo en la nube!`, 'success');
      setMigrateTarget(null);
      setMigrateConfirmText('');
      pushToCloud();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error durante la migración a online.', 'error');
    } finally {
      setMigrating(false);
    }
  }

  async function handleReactivateCloudSync(tenant: Tenant) {
    if (!session) return;
    const now = new Date().toISOString();
    const updated: Tenant = {
      ...tenant,
      wipeLocalData: false,
      wipeConfirmedAt: tenant.wipeConfirmedAt || now,
      wipeConfirmedDevice: tenant.wipeConfirmedDevice || 'Super Admin (Manual)',
      appLocked: false,
      unlockedByAdmin: true,
      updatedAt: now,
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);

    const cfg = loadFirebaseConfig();
    if (cfg) {
      const { initializeApp, getApps } = await import('firebase/app');
      const { getFirestore, doc, setDoc } = await import('firebase/firestore');
      const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
      await setDoc(doc(fs, 'tenants', tenant.tenantId), deepSanitize(updated), { merge: true });
    }

    await logAudit({
      tenantId: tenant.tenantId,
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: {
        accion: 'REANUDAR_ACCESO_NUBE_Y_LIMPIAR_PURGA',
        nombre: tenant.name,
      },
    });
    pushToCloud();
    toast(`Sincronización y acceso a la nube restaurados para «${tenant.name}».`, 'success');
  }

  async function toggleOfflineAccess(tenant: Tenant) {
    if (!session) return;
    const nextBlocked = !tenant.offlineBlocked;
    const now = new Date().toISOString();
    const updated: Tenant = {
      ...tenant,
      offlineBlocked: nextBlocked,
      updatedAt: now,
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    await logAudit({
      tenantId: tenant.tenantId,
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: {
        campo: 'offlineBlocked',
        valor: nextBlocked,
        nombre: tenant.name,
      },
    });
    pushToCloud();
    toast(
      nextBlocked
        ? `Modo offline revocado para «${tenant.name}» (Se exigirá conexión a la nube).`
        : `Modo offline habilitado para «${tenant.name}».`,
      nextBlocked ? 'warning' : 'success',
    );
  }

  async function togglePaymentBanner(t: Tenant) {
    if (!session) return;
    const nextState = !t.paymentBannerDeactivated;
    const isActivating = !nextState;
    await saveTenant({
      ...t,
      paymentBannerDeactivated: nextState,
      unlockedByAdmin: isActivating ? false : t.unlockedByAdmin,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    pushToCloud();
    toast(
      isActivating
        ? `Cobro insistente ACTIVADO para «${t.name}». La app quedará suspendida en cobro hasta que pague.`
        : `Cobro insistente desactivado para «${t.name}».`,
      isActivating ? 'warning' : 'info',
    );
  }

  async function handleSavePaymentParams() {
    if (!session || !bannerTenant) return;
    const updated: Tenant = {
      ...bannerTenant,
      paymentWhatsAppPhone: paymentPhone.trim() || undefined,
      paymentBannerDismissible: paymentDismissible,
      unlockedByAdmin: paymentDismissible ? bannerTenant.unlockedByAdmin : false,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    await logAudit({
      tenantId: bannerTenant.tenantId,
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: bannerTenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: {
        campo: 'parametros_cobro',
        descartable: paymentDismissible,
        telefonoCobro: paymentPhone || CHRIZDEV_WHATSAPP_PHONE,
      },
    });
    toast(`Parámetros de cobro insistente guardados para «${bannerTenant.name}».`, 'success');
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

  async function handleSaveBannerNotice(e: FormEvent) {
    e.preventDefault();
    if (!session || !bannerTenant) return;
    if (!bannerMessage.trim()) {
      toast('Escribe el mensaje del aviso.', 'error');
      return;
    }

    const updated: Tenant = {
      ...bannerTenant,
      notice: {
        title: bannerTitle.trim() || undefined,
        message: bannerMessage.trim(),
        level: bannerLevel,
        expiresAt: bannerExpiresAt.trim() || undefined,
        dismissible: bannerDismissible,
        displayMode: bannerDisplayMode,
        updatedAt: new Date().toISOString(),
        active: true,
      },
      paymentWhatsAppPhone: paymentPhone.trim() || undefined,
      paymentBannerDismissible: paymentDismissible,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };

    await saveTenant(updated);
    await logAudit({
      tenantId: bannerTenant.tenantId,
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: bannerTenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: {
        campo: 'banner_y_cobros',
        titulo: bannerTitle,
        nivel: bannerLevel,
        expiracion: bannerExpiresAt || 'Permanente',
        descartable: bannerDismissible,
        telefonoCobro: paymentPhone || CHRIZDEV_WHATSAPP_PHONE,
      },
    });
    pushToCloud();
    toast(`Configuración de banner y cobros guardada para «${bannerTenant.name}».`, 'success');
  }

  async function handleClearBannerNotice() {
    if (!session || !bannerTenant) return;
    const updated: Tenant = {
      ...bannerTenant,
      notice: undefined,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    await logAudit({
      tenantId: bannerTenant.tenantId,
      action: 'TENANT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: bannerTenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: { campo: 'notice', accion: 'clear' },
    });
    setBannerTitle('');
    setBannerMessage('');
    pushToCloud();
    toast(`Aviso retirado para «${bannerTenant.name}».`, 'info');
  }

  function openAddBankModal() {
    setEditingBankId(null);
    setBankName('');
    setBankAccountType('WALLET');
    setBankAccountNumber('');
    setBankHolderName('Christian Romero');
    setBankHolderDoc('');
    setBankNotes('');
    setBankDialogOpen(true);
  }

  function openEditBankModal(acc: BankAccountInfo) {
    setEditingBankId(acc.id);
    setBankName(acc.bankName);
    setBankAccountType(acc.accountType);
    setBankAccountNumber(acc.accountNumber);
    setBankHolderName(acc.holderName);
    setBankHolderDoc(acc.holderDoc ?? '');
    setBankNotes(acc.notes ?? '');
    setBankDialogOpen(true);
  }

  async function handleSaveBankAccount(e: FormEvent) {
    e.preventDefault();
    if (!session || !bannerTenant) return;
    if (!bankName.trim() || !bankAccountNumber.trim() || !bankHolderName.trim()) {
      toast('Completa el banco, número de cuenta y nombre del titular.', 'error');
      return;
    }

    const currentAccounts = [...(bannerTenant.bankAccounts ?? [])];
    if (editingBankId) {
      const idx = currentAccounts.findIndex((a) => a.id === editingBankId);
      if (idx >= 0) {
        currentAccounts[idx] = {
          ...currentAccounts[idx],
          bankName: bankName.trim(),
          accountType: bankAccountType,
          accountNumber: bankAccountNumber.trim(),
          holderName: bankHolderName.trim(),
          holderDoc: bankHolderDoc.trim() || undefined,
          notes: bankNotes.trim() || undefined,
        };
      }
    } else {
      currentAccounts.push({
        id: uid(),
        bankName: bankName.trim(),
        accountType: bankAccountType,
        accountNumber: bankAccountNumber.trim(),
        holderName: bankHolderName.trim(),
        holderDoc: bankHolderDoc.trim() || undefined,
        notes: bankNotes.trim() || undefined,
        active: true,
      });
    }

    await saveTenant({
      ...bannerTenant,
      bankAccounts: currentAccounts,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    pushToCloud();

    // Sincronizar cuentas a nivel plataforma para que cualquier organización las reciba
    try {
      const { loadFirebaseConfig } = await import('../lib/sync/firebaseConfig');
      const cfg = loadFirebaseConfig();
      if (cfg) {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getFirestore, doc, setDoc } = await import('firebase/firestore');
        const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
        await setDoc(doc(fs, 'platform_config', 'bank_accounts'), {
          accounts: currentAccounts,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* ignore */
    }

    toast('Cuenta bancaria guardada y sincronizada.', 'success');
    setBankDialogOpen(false);
  }

  async function handleDeleteBankAccount(accId: string) {
    if (!session || !bannerTenant) return;
    const nextAccounts = (bannerTenant.bankAccounts ?? []).filter((a) => a.id !== accId);
    await saveTenant({
      ...bannerTenant,
      bankAccounts: nextAccounts,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    pushToCloud();

    try {
      const { loadFirebaseConfig } = await import('../lib/sync/firebaseConfig');
      const cfg = loadFirebaseConfig();
      if (cfg) {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getFirestore, doc, setDoc } = await import('firebase/firestore');
        const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
        await setDoc(doc(fs, 'platform_config', 'bank_accounts'), {
          accounts: nextAccounts,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* ignore */
    }

    toast('Cuenta bancaria eliminada.', 'info');
  }

  async function handleToggleBankAccount(accId: string) {
    if (!session || !bannerTenant) return;
    const nextAccounts = (bannerTenant.bankAccounts ?? []).map((a) =>
      a.id === accId ? { ...a, active: !a.active } : a,
    );
    await saveTenant({
      ...bannerTenant,
      bankAccounts: nextAccounts,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    pushToCloud();

    try {
      const { loadFirebaseConfig } = await import('../lib/sync/firebaseConfig');
      const cfg = loadFirebaseConfig();
      if (cfg) {
        const { initializeApp, getApps } = await import('firebase/app');
        const { getFirestore, doc, setDoc } = await import('firebase/firestore');
        const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
        await setDoc(doc(fs, 'platform_config', 'bank_accounts'), {
          accounts: nextAccounts,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* ignore */
    }
  }

  async function handleApproveReport(report: PaymentReport) {
    if (!session) return;
    const tenant = (tenants ?? []).find((t) => t.tenantId === report.tenantId);
    const now = new Date().toISOString();
    const today = todayStr();
    const updatedReport: PaymentReport = {
      ...report,
      status: 'APPROVED',
      reviewedAt: now,
      reviewedBy: session.displayName,
      updatedAt: now,
      syncStatus: 'PENDING',
    };
    await db.payment_reports.put(updatedReport);

    // Validación si la organización tiene plan de pago mensual y actualización de cobertura
    const plan = planByTenant.get(report.tenantId) ?? (await db.plans.where('tenantId').equals(report.tenantId).first());
    const isMonthlyCloudPlan = plan && plan.cloudServiceIncluded === true && (Number(plan.cloudMonthlyFee) || 0) > 0;
    const invoice = plan ? computeMonthlyInvoice(plan, today) : null;
    const isPayingFullOrCloud =
      !invoice ||
      report.amount >= invoice.totalInvoiceAmount ||
      (isMonthlyCloudPlan && report.amount >= (Number(plan?.cloudMonthlyFee) || 0));

    if (plan && isMonthlyCloudPlan && isPayingFullOrCloud) {
      const currentPaidThrough = plan.cloudPaidThrough || today;
      const cloudFee = Math.max(1, Number(plan.cloudMonthlyFee) || 1);
      const monthsCovered = invoice?.cloudCyclesCount && report.amount >= invoice.totalInvoiceAmount
        ? Math.max(1, invoice.cloudCyclesCount)
        : Math.max(1, Math.floor(report.amount / cloudFee));
      const nextMonthDate = addMonthsStr(currentPaidThrough < today ? today : currentPaidThrough, monthsCovered);
      const updatedInstallments = (plan.installments ?? []).map((inst) => {
        if (inst.status === 'PENDING' && (!invoice || report.amount >= invoice.totalInvoiceAmount)) {
          return {
            ...inst,
            status: 'PAID' as const,
            paidAmount: inst.amount,
            paidAt: now,
          };
        }
        return inst;
      });
      await db.plans.put({
        ...plan,
        cloudPaidThrough: nextMonthDate,
        installments: updatedInstallments,
        updatedAt: now,
        syncStatus: 'PENDING',
      });
    }

    if (tenant) {
      await saveTenant({
        ...tenant,
        appLocked: false,
        unlockedByAdmin: true,
        paymentBannerDeactivated: true,
        activeAbono: undefined,
        notice: {
          title: 'Aviso del Servicio Cloud',
          message:
            'Recuerda que no pagar tu servicio cloud mensual es causal de bloqueo ya que los gastos de servicio cloud no pueden ser pagados si tu no pagas el servicio',
          level: 'warning',
          dismissible: true,
          updatedAt: now,
          active: true,
        },
        updatedAt: now,
        syncStatus: 'PENDING',
      });
    }

    await logAudit({
      tenantId: report.tenantId,
      action: 'PAYMENT_REPORT_APPROVED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: report.reportId,
      entityType: 'payment_reports',
      payloadSnapshot: {
        monto: report.amount,
        referencia: report.referenceNumber,
        banco: report.bankName,
        planValidado: isMonthlyCloudPlan,
      },
    });

    pushToCloud();
    toast(`Pago de ${formatCOP(report.amount)} APROBADO. Organización desbloqueada y al día.`, 'success');
  }

  async function handleApproveReportAsAbono(report: PaymentReport) {
    if (!session) return;
    const tenant = (tenants ?? []).find((t) => t.tenantId === report.tenantId);
    const now = new Date().toISOString();
    const today = todayStr();
    const graceUntil = addDaysStr(today, 15);

    // Buscar plan de la organización para aplicar el abono a la cuota pendiente
    const plan = planByTenant.get(report.tenantId);
    let concept = 'Cuota mensual de la app';
    let remaining = 0;
    let totalDue = report.amount;

    if (plan && plan.installments && plan.installments.length > 0) {
      const pendingInst = plan.installments.find(
        (i) => i.status === 'PENDING' && (Number(i.amount) || 0) > (Number(i.paidAmount) || 0),
      );
      if (pendingInst) {
        concept = pendingInst.concept;
        totalDue = Number(pendingInst.amount) || 0;
        const currentPaid = Number(pendingInst.paidAmount) || 0;
        const newPaid = currentPaid + report.amount;
        remaining = Math.max(0, totalDue - newPaid);
        const isFull = remaining === 0 || newPaid >= totalDue;

        const updatedInstallments = plan.installments.map((i) =>
          i.installmentId === pendingInst.installmentId
            ? {
                ...i,
                paidAmount: isFull ? totalDue : newPaid,
                status: (isFull ? 'PAID' : 'PENDING') as PlanInstallment['status'],
                paidAt: isFull ? now : i.paidAt,
                lastAbonoAt: now,
                graceUntil: isFull ? undefined : graceUntil,
              }
            : i,
        );

        await db.plans.put({
          ...plan,
          installments: updatedInstallments,
          updatedAt: now,
          syncStatus: 'PENDING',
        });
      }
    }

    if (tenant?.hasUsedAbonoGrace && remaining > 0) {
      const confirmOverride = window.confirm(
        `ADVERTENCIA DE POLÍTICA Y CONTRATO LEGAL (Ley 527/1999):\n\nLa organización «${tenant.name}» ya utilizó previamente su beneficio único de gracia de 15 días concedido en su primer pago.\n\nSegún los términos contractuales firmados, los pagos posteriores deben realizarse en su totalidad (100%) para desbloquear la plataforma. No proceden cuotas parciales.\n\n¿Deseas aplicar una excepción administrativa extraordinaria y otorgar 15 días más?`
      );
      if (!confirmOverride) return;
    }

    const updatedReport: PaymentReport = {
      ...report,
      status: 'APPROVED',
      reviewedAt: now,
      reviewedBy: session.displayName,
      notes:
        (report.notes ? report.notes + ' · ' : '') +
        `Aprobado como abono con 15 días de vigencia (hasta ${graceUntil}). Saldo restante: ${formatCOP(remaining)}`,
      updatedAt: now,
      syncStatus: 'PENDING',
    };
    await db.payment_reports.put(updatedReport);

    if (tenant) {
      const isFullPayment = remaining === 0;
      await saveTenant({
        ...tenant,
        hasUsedAbonoGrace: true,
        appLocked: isFullPayment ? false : tenant.appLocked,
        unlockedByAdmin: true,
        paymentBannerDeactivated: isFullPayment,
        activeAbono: isFullPayment
          ? undefined
          : {
              abonoId: uid(),
              concept,
              amountPaid: report.amount,
              remainingAmount: remaining,
              totalDue,
              abonoDate: today,
              graceUntil,
              active: true,
              notes: `Comprobante ref: ${report.referenceNumber}`,
            },
        notice: isFullPayment
          ? {
              title: 'Aviso del Servicio Cloud',
              message:
                'Recuerda que no pagar tu servicio cloud mensual es causal de bloqueo ya que los gastos de servicio cloud no pueden ser pagados si tu no pagas el servicio',
              level: 'warning',
              dismissible: true,
              updatedAt: now,
              active: true,
            }
          : {
              title: 'Aviso de Gracia de Abono (Uso Único)',
              message:
                'ADVERTENCIA: Esta prórroga de 15 días concedida tras tu abono aplica por ÚNICA VEZ por ser tu primer pago. Los pagos subsecuentes deben ser cubiertos en su totalidad (100%) y puntualmente en la fecha pactada. No se aceptarán futuros abonos para desbloqueo.',
              level: 'warning',
              dismissible: false,
              displayMode: 'banner',
              updatedAt: now,
              active: true,
            },
        updatedAt: now,
        syncStatus: 'PENDING',
      });
    }

    await logAudit({
      tenantId: report.tenantId,
      action: 'PAYMENT_REPORT_APPROVED_AS_ABONO',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: report.reportId,
      entityType: 'payment_reports',
      payloadSnapshot: {
        montoAbonado: report.amount,
        referencia: report.referenceNumber,
        saldoRestante: remaining,
        vigencia15DiasHasta: graceUntil,
      },
    });

    pushToCloud();
    toast(
      `Comprobante aprobado como ABONO de ${formatCOP(report.amount)}. Se activó el banner de saldo restante con 15 días de vigencia (hasta ${formatDateShort(graceUntil)}).`,
      'success',
    );
  }

  async function handleRejectReport(e: FormEvent) {
    e.preventDefault();
    if (!session || !rejectReportTarget) return;
    if (!rejectReason.trim()) {
      toast('Ingresa el motivo del rechazo.', 'error');
      return;
    }

    const now = new Date().toISOString();
    const updatedReport: PaymentReport = {
      ...rejectReportTarget,
      status: 'REJECTED',
      rejectionReason: rejectReason.trim(),
      reviewedAt: now,
      reviewedBy: session.displayName,
      updatedAt: now,
      syncStatus: 'PENDING',
    };
    await db.payment_reports.put(updatedReport);

    await logAudit({
      tenantId: rejectReportTarget.tenantId,
      action: 'PAYMENT_REPORT_REJECTED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: rejectReportTarget.reportId,
      entityType: 'payment_reports',
      payloadSnapshot: {
        monto: rejectReportTarget.amount,
        referencia: rejectReportTarget.referenceNumber,
        motivo: rejectReason.trim(),
      },
    });

    pushToCloud();
    toast('Comprobante de pago marcado como RECHAZADO.', 'info');
    setRejectReportTarget(null);
    setRejectReason('');
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
      settingsModuleEnabled: true,
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
    if (!session || togglingTenantId) return;
    setTogglingTenantId(tenant.tenantId);
    try {
      const next = tenant.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
      await saveTenant({
        ...tenant,
        status: next,
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
        payloadSnapshot: { campo: 'status', valor: next },
      });
      toast(next === 'ACTIVE' ? 'Organización activada.' : 'Organización suspendida.', 'success');
      pushToCloud();
    } finally {
      setTogglingTenantId(null);
    }
  }

  async function togglePortal(tenant: Tenant) {
    if (!session || togglingTenantId) return;
    setTogglingTenantId(tenant.tenantId);
    try {
      const next = !tenant.clientPortalEnabled;
      await saveTenant({
        ...tenant,
        clientPortalEnabled: next,
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
        payloadSnapshot: { campo: 'clientPortalEnabled', valor: next },
      });
      toast(
        next
          ? 'Portal de clientes HABILITADO. Usa el botón «Enlace» para compartirlo con los clientes.'
          : 'Portal de clientes deshabilitado.',
        'success',
      );
      pushToCloud();
    } finally {
      setTogglingTenantId(null);
    }
  }

  async function toggleSettings(tenant: Tenant) {
    if (!session || togglingTenantId) return;
    setTogglingTenantId(tenant.tenantId);
    try {
      const current = tenant.settingsModuleEnabled !== false;
      const next = !current;
      await saveTenant({
        ...tenant,
        settingsModuleEnabled: next,
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
        payloadSnapshot: { campo: 'settingsModuleEnabled', valor: next },
      });
      toast(
        next
          ? 'Módulo de Configuración HABILITADO para la organización.'
          : 'Módulo de Configuración DESHABILITADO. Se ocultará de la navegación de los clientes.',
        'success',
      );
      pushToCloud();
    } finally {
      setTogglingTenantId(null);
    }
  }

  async function handleDisconnectSession(tenant: Tenant) {
    if (!session) return;
    const prevDevice = tenant.currentDeviceName || tenant.lastSeenDevice || tenant.currentDeviceId || 'Desconocido';
    const updated: Tenant = {
      ...tenant,
      currentSessionId: crypto.randomUUID(), // Invalida el session ID o tokens anteriores
      currentDeviceId: undefined,
      currentDeviceName: undefined,
      sessionStartedAt: undefined,
      lastSeenOnlineAt: undefined,
      offlineOnlineDetectedAt: undefined,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    if (adminManageTarget?.tenantId === tenant.tenantId) {
      setAdminManageTarget(updated);
    }
    await logAudit({
      tenantId: tenant.tenantId,
      action: 'SESSION_KILLED_CONCURRENT',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: {
        razon: 'Desconexión manual forzada por Super Administrador',
        dispositivoAnterior: prevDevice,
      },
    });
    pushToCloud();
    toast(`Sesión de «${tenant.name}» desconectada e invalidada remotamente.`, 'success');
  }

  async function handleDeleteAdminUser(user: UserAccount, tenant: Tenant) {
    if (!session) return;
    const tenantAdmins = adminsByTenant.get(tenant.tenantId) ?? [];
    if (tenantAdmins.length <= 1) {
      toast('No se puede eliminar el único administrador de la organización.', 'error');
      return;
    }
    if (!window.confirm(`¿Seguro que deseas eliminar al administrador «${user.username}» (${user.displayName})? Esta acción no se puede deshacer.`)) {
      return;
    }
    await db.users.delete(user.userId);
    if (isSyncConfigured()) {
      void purgeDocsFromCloud([{ collection: 'users', ids: [user.userId] }]);
    }
    await logAudit({
      tenantId: tenant.tenantId,
      action: 'TENANT_ADMIN_LIMIT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: user.userId,
      entityType: 'users',
      payloadSnapshot: {
        accion: 'ADMIN_ELIMINADO_POR_SUPERADMIN',
        username: user.username,
        organizacion: tenant.name,
      },
    });
    pushToCloud();
    toast(`Administrador «${user.username}» eliminado correctamente.`, 'success');
  }

  async function handleSaveAdminPolicy(tenant: Tenant) {
    if (!session) return;
    const updated: Tenant = {
      ...tenant,
      maxAdmins: Math.max(1, Number(adminPolicyMax) || 1),
      allowMultipleSessions: adminPolicyMultiSession,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    await logAudit({
      tenantId: tenant.tenantId,
      action: 'TENANT_ADMIN_LIMIT_UPDATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: tenant.tenantId,
      entityType: 'tenants',
      payloadSnapshot: {
        maxAdmins: updated.maxAdmins,
        allowMultipleSessions: updated.allowMultipleSessions,
      },
    });
    pushToCloud();
    toast(`Regla de administradores y sesiones guardada para «${tenant.name}».`, 'success');
    setAdminManageTarget(null);
  }

  async function handleGenerateSocioToken(tenant: Tenant) {
    if (!session) return;
    const token = crypto.randomUUID();
    const newToken: SingleUseSocioToken = {
      id: crypto.randomUUID(),
      token,
      tenantId: tenant.tenantId,
      createdAt: new Date().toISOString(),
      used: false,
      active: true,
    };
    const currentTokens = tenant.singleUseSocioTokens || [];
    const updated: Tenant = {
      ...tenant,
      socioModuleEnabled: true,
      singleUseSocioTokens: [...currentTokens, newToken],
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    await logAudit({
      tenantId: tenant.tenantId,
      action: 'SOCIO_TOKEN_GENERATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: token,
      entityType: 'tenants',
      payloadSnapshot: {
        token: `${token.slice(0, 8)}...`,
        organizacion: tenant.name,
      },
    });
    pushToCloud();
    const link = `${window.location.origin}/socio?t=${tenant.tenantId}&token=${token}`;
    setGeneratedSocioLink(link);
    toast('Enlace de Socio generado. Recuerda que es de ÚNICO USO.', 'success');
  }

  async function handleRevokeSocioToken(tenant: Tenant, tokenStr: string) {
    if (!session) return;
    const updatedTokens = (tenant.singleUseSocioTokens || []).filter((t) => t.token !== tokenStr);
    const updated: Tenant = {
      ...tenant,
      singleUseSocioTokens: updatedTokens,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    };
    await saveTenant(updated);
    pushToCloud();
    toast('Enlace de socio revocado.', 'info');
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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setRulesModalOpen(true)}>
              <FileCode size={14} /> Reglas Firestore
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> Nueva organización
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2 border-b border-slate-200 mt-4 mb-6 overflow-x-auto">
        <button
          type="button"
          onClick={() => handleSelectTab('tenants')}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all cursor-pointer whitespace-nowrap',
            activeTab === 'tenants'
              ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          <Building2 size={16} /> Organizaciones ({stats.total})
        </button>
        <button
          type="button"
          onClick={() => handleSelectTab('banners')}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all cursor-pointer whitespace-nowrap',
            activeTab === 'banners'
              ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          <Megaphone size={16} /> Banners, Avisos y Cobros
        </button>
        <button
          type="button"
          onClick={() => handleSelectTab('reports')}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all cursor-pointer whitespace-nowrap',
            activeTab === 'reports'
              ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          <CreditCard size={16} /> Comprobantes de Pago
          {pendingReportsCount > 0 && (
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white animate-pulse">
              {pendingReportsCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => handleSelectTab('legal')}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all cursor-pointer whitespace-nowrap',
            activeTab === 'legal'
              ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-lg'
              : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          <Scale size={16} /> Contratos y Legal ({legalAcceptances?.length ?? 0})
        </button>
      </div>

      {activeTab === 'tenants' && (
        <>
          {/* Panel de Métricas y Estadísticas Globales */}
          <div className="mb-6 rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50/80 via-white to-slate-50/50 p-4 sm:p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200/80 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-emerald-600 text-white shadow-xs">
                  <Activity size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-black tracking-wide text-slate-900">
                    Dashboard Global PresMon · Ingresos, Cartera y Actividad
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Monitoreo en tiempo real de ingresos por licencias, actividad de organizaciones y cartera colocada.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant={!showOrgPortfolio ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setShowOrgPortfolio(false)}
                  className={cn(
                    'text-xs gap-1.5 h-8 cursor-pointer transition-colors',
                    !showOrgPortfolio
                      ? 'bg-slate-900 hover:bg-slate-800 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 border-slate-300'
                  )}
                  title="Ver solo las finanzas y métricas de la plataforma PresMon como desarrollador"
                >
                  <Activity size={13} /> Estadísticas SaaS (Desarrollador)
                </Button>
                <Button
                  variant={showOrgPortfolio ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setShowOrgPortfolio(true)}
                  className={cn(
                    'text-xs gap-1.5 h-8 cursor-pointer transition-colors',
                    showOrgPortfolio
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 border-slate-300'
                  )}
                  title="Ver analítica de préstamos colocados, porcentaje de interés y ganancias de las organizaciones"
                >
                  <TrendingUp size={13} /> Analítica de Préstamos
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAnalyticsViewOpen(!analyticsViewOpen)}
                  className="text-xs gap-1.5 h-8 text-slate-600 hover:text-slate-900 border-slate-300 cursor-pointer"
                >
                  <BarChart3 size={13} /> {analyticsViewOpen ? 'Ocultar Rankings' : 'Ver Rankings'}
                  <ChevronDown size={13} className={cn('transition-transform duration-200', analyticsViewOpen ? 'rotate-180' : '')} />
                </Button>
              </div>
            </div>

            {/* Fila 1: Métricas Financieras del Negocio SaaS PresMon */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 shadow-2xs">
                <div className="flex items-center justify-between text-emerald-700">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Recaudado Planes</span>
                  <DollarSign size={16} />
                </div>
                <p className="mt-1 text-lg sm:text-xl font-black text-emerald-900">
                  {formatCOP(globalMetrics.totalPlanCollected)}
                </p>
                <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-emerald-800">
                  <span>Contado: <strong>{formatCOP(globalMetrics.contadoTotalAmount)}</strong> ({globalMetrics.contadoTenantsCount} orgs)</span>
                  <span>Financiado: <strong>{formatCOP(Math.max(0, globalMetrics.totalPlanCollected - globalMetrics.contadoTotalAmount))}</strong></span>
                </div>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5 shadow-2xs">
                <div className="flex items-center justify-between text-amber-700">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Por Cobrar App</span>
                  <Wallet size={16} />
                </div>
                <p className="mt-1 text-lg sm:text-xl font-black text-amber-900">
                  {formatCOP(globalMetrics.totalPlanPending)}
                </p>
                <p className="text-[10px] text-amber-700 font-medium mt-0.5">Saldo pendiente de cuotas</p>
              </div>

              <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3.5 shadow-2xs">
                <div className="flex items-center justify-between text-sky-700">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Cloud Recurrente</span>
                  <Cloud size={16} />
                </div>
                <p className="mt-1 text-lg sm:text-xl font-black text-sky-900">
                  {formatCOP(globalMetrics.totalCloudRecurringMonthly)}
                </p>
                <p className="text-[10px] text-sky-700 font-medium mt-0.5">Mensualidad activa de clientes</p>
              </div>

              <div className="rounded-xl border border-red-200 bg-red-50/60 p-3.5 shadow-2xs">
                <div className="flex items-center justify-between text-red-700">
                  <span className="text-[11px] font-bold uppercase tracking-wider">Mora Exigible</span>
                  <AlertTriangle size={16} />
                </div>
                <p className="mt-1 text-lg sm:text-xl font-black text-red-900">
                  {formatCOP(globalMetrics.totalPlanOverdue)}
                </p>
                <div className="mt-0.5 space-y-0.5">
                  <p className="text-[10px] text-red-700 font-medium">
                    {globalMetrics.tenantsInMoraCount} organización(es) &gt; 5 días
                  </p>
                  {globalMetrics.totalPlanOverdue > 0 && (
                    <p className="text-[9px] text-red-600 font-medium">
                      Cloud: {formatCOP(globalMetrics.totalOverdueCloudAmount)} · Cuotas: {formatCOP(globalMetrics.totalOverdueInstallmentsAmount)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Vista Especial: Cartera y Analítica de Préstamos de las Organizaciones */}
            {showOrgPortfolio && (
              <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50/70 via-white to-sky-50/40 p-4 sm:p-5 shadow-2xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-indigo-100 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-xl bg-indigo-600 text-white shadow-2xs">
                      <TrendingUp size={18} />
                    </div>
                    <div>
                      <h4 className="text-xs sm:text-sm font-black text-indigo-950 uppercase tracking-wide">
                        Analítica Financiera de Préstamos y Rendimiento de Organizaciones
                      </h4>
                      <p className="text-[11px] text-indigo-700">
                        Monitoreo de capital colocado, porcentaje de interés y ganancias fijas vs esperadas.
                      </p>
                    </div>
                  </div>

                  {/* Selector / Filtro por Organización */}
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <span className="text-xs font-bold text-slate-700 whitespace-nowrap">Filtrar por:</span>
                    <select
                      value={selectedPortfolioOrgId}
                      onChange={(e) => setSelectedPortfolioOrgId(e.target.value)}
                      className="w-full sm:w-64 rounded-xl border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-2xs focus:border-indigo-500 focus:outline-none cursor-pointer"
                    >
                      <option value="ALL">🏢 Todas las Organizaciones (Consolidado)</option>
                      {(tenants ?? [])
                        .filter((t) => t.status !== 'DELETED')
                        .map((t) => {
                          const orgLoansCount = (loans ?? []).filter((l) => l.tenantId === t.tenantId && l.status !== 'CANCELLED').length;
                          return (
                            <option key={t.tenantId} value={t.tenantId}>
                              🏢 {t.name} ({orgLoansCount} créditos)
                            </option>
                          );
                        })}
                    </select>
                  </div>
                </div>

                {/* Rejilla de Métricas Financieras del Préstamo */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {/* Tarjeta 1: Capital Colocado */}
                  <div className="rounded-xl border border-indigo-100 bg-white p-3.5 shadow-2xs">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                      Capital Prestado
                    </span>
                    <p className="mt-1 text-base sm:text-lg font-black text-indigo-950">
                      {formatCOP(portfolioMetrics.totalPrincipalPlaced)}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {portfolioMetrics.loansCount} créditos colocados
                    </p>
                  </div>

                  {/* Tarjeta 2: Porcentaje de Colocación */}
                  <div className="rounded-xl border border-sky-100 bg-white p-3.5 shadow-2xs">
                    <span className="text-[10px] uppercase font-bold text-sky-700 tracking-wider">
                      Tasa Promedio (%)
                    </span>
                    <p className="mt-1 text-base sm:text-lg font-black text-sky-900">
                      {portfolioMetrics.avgInterestRate}% <span className="text-[11px] font-medium text-slate-500">/ período</span>
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      Rango: {portfolioMetrics.minRate}% a {portfolioMetrics.maxRate}%
                    </p>
                  </div>

                  {/* Tarjeta 3: Ganancias Fijas (Ya Pagadas) */}
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 shadow-2xs">
                    <span className="text-[10px] uppercase font-bold text-emerald-800 tracking-wider flex items-center gap-1">
                      <CheckCircle size={12} className="text-emerald-600" /> Ganancias Fijas (Cobradas)
                    </span>
                    <p className="mt-1 text-base sm:text-lg font-black text-emerald-900">
                      {formatCOP(portfolioMetrics.fixedEarningsPaid)}
                    </p>
                    <p className="text-[10px] text-emerald-700 mt-0.5 font-medium">
                      Intereses amortizados y recibidos
                    </p>
                  </div>

                  {/* Tarjeta 4: Ganancia Esperada (Por Pagar) */}
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 shadow-2xs">
                    <span className="text-[10px] uppercase font-bold text-amber-800 tracking-wider flex items-center gap-1">
                      <Clock size={12} className="text-amber-600" /> Ganancia Esperada (Por Pagar)
                    </span>
                    <p className="mt-1 text-base sm:text-lg font-black text-amber-900">
                      {formatCOP(portfolioMetrics.expectedEarningsPending)}
                    </p>
                    <p className="text-[10px] text-amber-700 mt-0.5 font-medium">
                      Intereses pendientes en ruta
                    </p>
                  </div>

                  {/* Tarjeta 5: Capital Recuperado vs En Calle */}
                  <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs col-span-2 sm:col-span-1">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                      Capital Recuperado
                    </span>
                    <p className="mt-1 text-base sm:text-lg font-black text-slate-900">
                      {formatCOP(portfolioMetrics.principalPaid)}
                    </p>
                    <p className="text-[10px] text-amber-600 font-medium mt-0.5">
                      En calle: {formatCOP(portfolioMetrics.principalPending)}
                    </p>
                  </div>
                </div>

                {/* Sub-fila informativa de prestatarios */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-indigo-100/80 text-[11px] text-slate-600">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span>👥 Total Prestatarios: <strong className="text-slate-900">{portfolioMetrics.borrowersCount}</strong></span>
                    <span>•</span>
                    <span>📑 Contratos de Crédito: <strong className="text-slate-900">{portfolioMetrics.loansCount}</strong></span>
                    <span>•</span>
                    <span>💰 Total Intereses Proyectados: <strong className="text-indigo-900">{formatCOP(portfolioMetrics.totalContractInterest)}</strong></span>
                  </div>
                  {selectedPortfolioOrgId !== 'ALL' && (
                    <button
                      type="button"
                      onClick={() => setSelectedPortfolioOrgId('ALL')}
                      className="text-indigo-600 hover:text-indigo-800 font-bold underline cursor-pointer"
                    >
                      Ver Consolidado Todas las Organizaciones
                    </button>
                  )}
                </div>
              </div>
            )}

            {analyticsViewOpen && (
              <div className={cn('grid gap-4 pt-2', showOrgPortfolio ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 md:grid-cols-2')}>
                {/* Ranking 1: Organizaciones con Más Uso / Actividad */}
                <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5 shadow-2xs">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Activity size={14} className="text-indigo-600" /> Top Uso de la App (Auditoría)
                    </span>
                    <Badge variant="info" className="text-[9px] px-1.5">Eventos</Badge>
                  </div>
                  {globalMetrics.topTenantsByUsage.length === 0 ? (
                    <p className="text-xs text-slate-400 py-2 text-center">Sin actividad registrada</p>
                  ) : (
                    <div className="space-y-2">
                      {globalMetrics.topTenantsByUsage.map((item, i) => (
                        <div key={item.tenant.tenantId} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                          <div className="min-w-0 flex-1 pr-2">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-slate-400 text-[10px]">#{i + 1}</span>
                              <p className="font-bold text-slate-900 truncate">{item.tenant.name}</p>
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
                              <span className="font-mono">{item.auditCount} eventos</span>
                              <span>·</span>
                              <span className="truncate">{item.tenant.lastSeenDevice || 'Web'}</span>
                            </div>
                          </div>
                          <Badge variant={item.onlineInfo.badgeVariant} className="text-[9px] shrink-0 font-bold">
                            {item.onlineInfo.text}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Ranking 2 (Opcional): Organizaciones con Mayor Cartera / Préstamos */}
                {showOrgPortfolio && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5 shadow-2xs">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                        <TrendingUp size={14} className="text-emerald-600" /> Mayor Cartera de Préstamos
                      </span>
                      <Badge variant="success" className="text-[9px] px-1.5">Capital</Badge>
                    </div>
                    {globalMetrics.topTenantsByPortfolio.length === 0 ? (
                      <p className="text-xs text-slate-400 py-2 text-center">Sin préstamos activos</p>
                    ) : (
                      <div className="space-y-2">
                        {globalMetrics.topTenantsByPortfolio.map((item, i) => (
                          <div key={item.tenant.tenantId} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                            <div className="min-w-0 flex-1 pr-2">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-slate-400 text-[10px]">#{i + 1}</span>
                                <p className="font-bold text-slate-900 truncate">{item.tenant.name}</p>
                              </div>
                              <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                                {item.loansCount} crédito(s) colocados
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-black text-emerald-700 text-xs">{formatCOP(item.totalAmount)}</p>
                              <p className="text-[9px] text-slate-400">Total prestado</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Ranking 3: Organizaciones con Deuda Pendiente de Licencias / Cuotas */}
                <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5 shadow-2xs">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <AlertTriangle size={14} className="text-amber-600" /> Deuda de Planes y Facturación
                    </span>
                    <Badge variant="warning" className="text-[9px] px-1.5">Pendiente</Badge>
                  </div>
                  {globalMetrics.tenantsWithDebtList.length === 0 ? (
                    <div className="p-3 text-center text-xs text-emerald-700 bg-emerald-50 rounded-lg font-medium">
                      ✓ Todas las organizaciones están al día con sus planes
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {globalMetrics.tenantsWithDebtList.map((item, i) => (
                        <div key={item.tenant.tenantId} className={cn('flex items-center justify-between p-2 rounded-lg border text-xs', item.isOverdue ? 'bg-red-50/70 border-red-200' : 'bg-slate-50 border-slate-100')}>
                          <div className="min-w-0 flex-1 pr-2">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-slate-400 text-[10px]">#{i + 1}</span>
                              <p className="font-bold text-slate-900 truncate">{item.tenant.name}</p>
                              {item.isOverdue && (
                                <Badge variant="danger" className="text-[8px] px-1 py-0 font-bold shrink-0">MORA &gt; 5d</Badge>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-500 mt-0.5">
                              {item.invoice?.summaryText || 'Cuotas pendientes'}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className={cn('font-black text-xs', item.isOverdue ? 'text-red-700' : 'text-amber-800')}>
                              {formatCOP(item.totalDue)}
                            </p>
                            <p className="text-[9px] text-slate-400">Por pagar</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Organizaciones" value={String(stats.total)} icon={Building2} />
            <StatCard label="Activas" value={String(stats.active)} icon={ShieldCheck} tone="emerald" />
            <StatCard label="Portal habilitado" value={String(stats.portal)} icon={Globe} tone="sky" />
            <StatCard label="Administradores" value={String(stats.admins)} icon={KeyRound} tone="amber" />
          </div>

      <div className="mt-6 mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-800 text-base">Organizaciones Registradas</h2>
          <p className="text-xs text-slate-500">
            Control de tenants, licencias en línea (Cloud) y edición offline 100% local.
          </p>
        </div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1 border border-slate-200 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setOrgFilterMode('ALL')}
            className={cn(
              'px-3 py-1.5 text-xs font-bold rounded-lg transition-colors cursor-pointer',
              orgFilterMode === 'ALL'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900',
            )}
          >
            Todas ({tenants?.length ?? 0})
          </button>
          <button
            type="button"
            onClick={() => setOrgFilterMode('ONLINE')}
            className={cn(
              'px-3 py-1.5 text-xs font-bold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5',
              orgFilterMode === 'ONLINE'
                ? 'bg-sky-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-sky-700',
            )}
          >
            ☁️ En Línea ({onlineTenantsCount})
          </button>
          <button
            type="button"
            onClick={() => setOrgFilterMode('OFFLINE')}
            className={cn(
              'px-3 py-1.5 text-xs font-bold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5',
              orgFilterMode === 'OFFLINE'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-amber-800',
            )}
          >
            💾 Offline ({offlineTenantsCount})
          </button>
        </div>
      </div>

      <TableWrap>
        <THead>
          <TH>Organización</TH>
          <TH>Admin</TH>
          <TH>Préstamos</TH>
          <TH>Conexión / Red</TH>
          <TH>Creada</TH>
          <TH>Estado</TH>
          <TH>Control cuenta</TH>
          <TH>Portal cliente</TH>
          <TH>Configuración</TH>
          <TH className="text-right">Acciones</TH>
        </THead>
        <TBody>
          {filteredTenants.length === 0 ? (
            <TR>
              <TD colSpan={10} className="text-center py-8 text-xs text-slate-500">
                No se encontraron organizaciones en la categoría seleccionada ({orgFilterMode}).
              </TD>
            </TR>
          ) : (
            filteredTenants.map((t) => {
              const plan = planByTenant.get(t.tenantId);
              const invoice = plan ? computeMonthlyInvoice(plan) : null;
              const hasMora5Days = invoice?.isOverdueMoreThan5Days ?? false;
              const hasCobroInsistente = t.paymentBannerDeactivated !== true && (invoice?.totalInvoiceAmount ?? 0) > 0;
              const isLockedByDebt = t.appLocked || (hasMora5Days && (!t.unlockedByAdmin || hasCobroInsistente)) || (hasCobroInsistente && !t.paymentBannerDismissible);
              const isOfflineOrg = Boolean(t.offlineLicense);
              const isContadoOrg = plan?.appPaymentMode === 'FULL';
              return (
                <TR key={t.tenantId} className={isLockedByDebt ? 'bg-red-50/60' : undefined}>
                  <TD className="font-medium text-slate-800">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{t.name}</span>
                        {isOfflineOrg ? (
                          <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-300 font-extrabold text-[9px]">
                            💾 OFFLINE (PAGO 100%)
                          </Badge>
                        ) : isContadoOrg ? (
                          <Badge variant="success" className="text-[9px] font-bold">
                            CONTADO (100% PAGADO)
                          </Badge>
                        ) : (
                          <Badge variant="info" className="bg-sky-50 text-sky-700 border-sky-200 text-[9px] font-bold">
                            ☁️ EN LÍNEA
                          </Badge>
                        )}
                      {t.appLocked && (
                        <span className="inline-flex items-center gap-1">
                          <Lock size={12} className="text-red-500" />
                          <Badge variant="danger">BLOQUEADA (MANUAL)</Badge>
                        </span>
                      )}
                      {hasMora5Days && !t.appLocked && (
                        <Badge variant="danger">MORA &gt; 5 DÍAS ({invoice?.maxDaysOverdue}d)</Badge>
                      )}
                      {hasCobroInsistente && !t.appLocked && (
                        <Badge variant="danger">COBRO INSISTENTE ({formatCOP(invoice?.totalInvoiceAmount ?? 0)})</Badge>
                      )}
                      {t.unlockedByAdmin && !t.appLocked && !hasCobroInsistente && (
                        <Badge variant="success">DESBLOQUEO ADMIN</Badge>
                      )}
                      {t.offlineBlocked && (
                        <Badge variant="danger">OFFLINE REVOCADO</Badge>
                      )}
                      {t.wipeConfirmedAt && (
                        <Badge variant="success" title={`Confirmado por: ${t.wipeConfirmedDevice ?? 'cliente'}`}>
                          ✓ PURGA CONFIRMADA ({formatDateTime(t.wipeConfirmedAt)})
                        </Badge>
                      )}
                      {t.wipeLocalData && !t.wipeConfirmedAt && (
                        <button
                          type="button"
                          onClick={() => void handleReactivateCloudSync(t)}
                          title="Hacer clic para resolver purga y permitir sincronización con el cliente"
                          className="cursor-pointer inline-flex"
                        >
                          <Badge variant="warning" className="animate-pulse hover:bg-amber-200 transition-colors">
                            ⏳ PURGA PENDIENTE DE CLIENTE ↺
                          </Badge>
                        </button>
                      )}
                      {t.offlineLicense && t.offlineOnlineDetected && t.offlineOnlineDetectedAt && (
                        <Badge variant="warning" title={`Dispositivo: ${t.offlineDeviceInfo ?? ''}`}>
                          🟢 OFFLINE ONLINE ({formatDateTime(t.offlineOnlineDetectedAt)})
                        </Badge>
                      )}
                      {invoice && invoice.totalInvoiceAmount > 0 && (
                        t.paymentBannerDeactivated ? (
                          <Badge variant="muted">Banner cobro inactivo</Badge>
                        ) : (
                          <Badge variant="danger">Banner cobro activo</Badge>
                        )
                      )}
                      {!t.appLocked && t.notice && t.notice.message.trim() !== '' && (
                        <Megaphone size={12} className="inline text-sky-500" />
                      )}
                    </div>
                    {invoice && invoice.totalInvoiceAmount > 0 && (
                      <span className="text-[11px] text-slate-500">
                        Factura mes: {formatCOP(invoice.totalInvoiceAmount)}{' '}
                        {invoice.maxDaysOverdue > 0 && (
                          <span className="text-red-600 font-bold">({invoice.maxDaysOverdue} días mora)</span>
                        )}
                      </span>
                    )}
                  </div>
                </TD>
                <TD>
                  {(() => {
                    const orgAdmins = adminsByTenant.get(t.tenantId) ?? [];
                    const primary = orgAdmins[0]?.username ?? adminByTenant.get(t.tenantId) ?? '—';
                    return (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-slate-700 font-medium">{primary}</span>
                        {orgAdmins.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => {
                              setAdminManageTarget(t);
                              setAdminPolicyMax(t.maxAdmins || 1);
                              setAdminPolicyMultiSession(t.allowMultipleSessions === true);
                            }}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-bold hover:bg-amber-200 transition-colors cursor-pointer"
                            title="Esta organización tiene múltiples administradores. Haz clic para controlar el límite o remover administradores."
                          >
                            <AlertTriangle size={11} className="text-amber-600 shrink-0" />
                            {orgAdmins.length} admins ⚠️
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setAdminManageTarget(t);
                              setAdminPolicyMax(t.maxAdmins || 1);
                              setAdminPolicyMultiSession(t.allowMultipleSessions === true);
                            }}
                            className="text-[10px] text-slate-400 hover:text-emerald-600 underline cursor-pointer"
                            title="Gestionar límite de administradores y sesiones"
                          >
                            Gestionar
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </TD>
                <TD>
                  {(loans ?? []).filter((l) => l.tenantId === t.tenantId).length}
                </TD>
                <TD>
                  {(() => {
                    const onlineInfo = getTenantOnlineInfo(t);
                    return (
                      <div className="flex flex-col gap-0.5" title={onlineInfo.tooltip}>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={onlineInfo.badgeVariant} className={onlineInfo.isLive ? 'font-bold tracking-wide' : undefined}>
                            {onlineInfo.text}
                          </Badge>
                        </div>
                        {onlineInfo.isLive && (
                          <span className="text-[10px] text-slate-500 font-mono">
                            {formatDateTime(t.lastSeenOnlineAt || t.offlineOnlineDetectedAt || '').slice(11, 19)}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </TD>
                <TD className="text-xs text-slate-400">{formatDateTime(t.createdAt)}</TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={t.status === 'ACTIVE'}
                      onChange={() => void toggleStatus(t)}
                      disabled={togglingTenantId === t.tenantId}
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
                      disabled={togglingTenantId === t.tenantId}
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
                      checked={t.clientPortalEnabled}
                      onChange={() => void togglePortal(t)}
                      disabled={togglingTenantId === t.tenantId}
                      label="Portal cliente"
                    />
                    <Badge variant={t.clientPortalEnabled ? 'info' : 'muted'}>
                      {t.clientPortalEnabled ? 'ON' : 'OFF'}
                    </Badge>
                  </div>
                </TD>

                <TD>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={t.settingsModuleEnabled !== false}
                      onChange={() => void toggleSettings(t)}
                      disabled={togglingTenantId === t.tenantId}
                      label="Módulo Configuración"
                    />
                    <Badge variant={t.settingsModuleEnabled !== false ? 'info' : 'muted'}>
                      {t.settingsModuleEnabled !== false ? 'ON' : 'OFF'}
                    </Badge>
                  </div>
                </TD>
                <TD className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 font-medium shadow-xs hover:bg-slate-100 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (actionMenu?.tenant.tenantId === t.tenantId) {
                        setActionMenu(null);
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setActionMenu({
                          tenant: t,
                          top: rect.bottom + 4,
                          right: Math.max(12, window.innerWidth - rect.right),
                        });
                      }
                    }}
                  >
                    <span>Acciones</span>
                    <ChevronDown
                      size={14}
                      className={cn(
                        'transition-transform duration-200 text-slate-500',
                        actionMenu?.tenant.tenantId === t.tenantId && 'rotate-180',
                      )}
                    />
                  </Button>
                </TD>
              </TR>
            );
          }))}
        </TBody>
      </TableWrap>

      {/* Menú flotante desplegable de acciones (renderizado fuera de TableWrap con position: fixed para evitar recorte por overflow) */}
      {actionMenu && (() => {
        const t = actionMenu.tenant;
        const plan = planByTenant.get(t.tenantId);
        const invoice = plan ? computeMonthlyInvoice(plan) : null;
        const hasMora5Days = invoice?.isOverdueMoreThan5Days ?? false;

        return (
          <>
            <div
              className="fixed inset-0 z-50 bg-black/10 backdrop-blur-2xs"
              onClick={() => setActionMenu(null)}
            />
            <div
              className="fixed z-50 w-64 rounded-xl border border-slate-200 bg-white py-1.5 shadow-2xl ring-1 ring-black/5 text-xs divide-y divide-slate-100 text-slate-700 animate-in fade-in zoom-in-95 duration-100"
              style={{
                top: Math.min(actionMenu.top, window.innerHeight - 380),
                right: actionMenu.right,
              }}
            >
              {/* Encabezado con el nombre de la organización */}
              <div className="px-3.5 py-2 bg-slate-50 border-b border-slate-100">
                <p className="font-bold text-slate-900 truncate">{t.name}</p>
                <p className="text-[10px] text-slate-500 truncate">Admin: {adminByTenant.get(t.tenantId) ?? '—'}</p>
              </div>

              {/* Grupo 1: Acceso y Pagos */}
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    void setAppLock(t, !(t.appLocked || (hasMora5Days && !t.unlockedByAdmin)));
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left font-medium cursor-pointer"
                >
                  {t.appLocked || (hasMora5Days && !t.unlockedByAdmin) ? (
                    <>
                      <LockOpen size={14} className="text-emerald-600 shrink-0" />
                      <span className="text-emerald-700">Desbloquear app</span>
                    </>
                  ) : (
                    <>
                      <Lock size={14} className="text-red-500 shrink-0" />
                      <span className="text-red-600">Bloquear app por mora</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setSelectedBannerTenantId(t.tenantId);
                    setActiveTab('banners');
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                >
                  <Megaphone size={14} className="text-sky-600 shrink-0" />
                  <span>Administrar avisos y banners</span>
                </button>

                {invoice && invoice.totalInvoiceAmount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setActionMenu(null);
                      void togglePaymentBanner(t);
                    }}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                  >
                    <AlertTriangle
                      size={14}
                      className={cn('shrink-0', t.paymentBannerDeactivated ? 'text-slate-400' : 'text-amber-600')}
                    />
                    <span>{t.paymentBannerDeactivated ? 'Activar banner cobro' : 'Desactivar banner cobro'}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    navigate('/super/plans');
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-emerald-50/70 transition-colors text-left text-emerald-800 font-medium cursor-pointer"
                >
                  <HandCoins size={14} className="text-emerald-600 shrink-0" />
                  <span>Gestionar plan y abonar a cuota</span>
                </button>
              </div>

              {/* Grupo 2: Control de Usuarios, Admins y Cobradores */}
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setAdminManageTarget(t);
                    setAdminPolicyMax(t.maxAdmins || 1);
                    setAdminPolicyMultiSession(t.allowMultipleSessions === true);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-amber-50/80 transition-colors text-left text-amber-800 font-medium cursor-pointer"
                >
                  <Users size={14} className="text-amber-600 shrink-0" />
                  <span>Control de Admins y Sesiones</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setSocioLinkTarget(t);
                    setGeneratedSocioLink(null);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-purple-50/80 transition-colors text-left text-purple-800 font-medium cursor-pointer"
                >
                  <Smartphone size={14} className="text-purple-600 shrink-0" />
                  <span>Módulo Socio / Enlace Único</span>
                </button>
              </div>

              {/* Grupo 3: Seguridad, Purga y Sincronización Nube */}
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    void handleReactivateCloudSync(t);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-emerald-50/80 transition-colors text-left text-emerald-800 font-medium cursor-pointer"
                >
                  <Cloud size={14} className="text-emerald-600 shrink-0" />
                  <span>Reanudar sincronización nube y limpiar purga</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setWipeTarget(t);
                    setWipeLockOrg(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-amber-50/80 transition-colors text-left text-amber-800 font-medium cursor-pointer"
                >
                  <DatabaseZap size={14} className="text-amber-600 shrink-0" />
                  <span>Purgar base local y revocar offline</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    void toggleOfflineAccess(t);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                >
                  {t.offlineBlocked ? (
                    <>
                      <Wifi size={14} className="text-emerald-600 shrink-0" />
                      <span>Restaurar permiso de modo offline</span>
                    </>
                  ) : (
                    <>
                      <WifiOff size={14} className="text-amber-600 shrink-0" />
                      <span>Revocar modo offline (Solo nube)</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setOfflineTargetId(t.tenantId);
                    setOfflinePaid(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                >
                  <HardDriveDownload size={14} className="text-indigo-600 shrink-0" />
                  <span>{t.offlineLicense ? 'Ver enlace Edición Offline' : 'Emitir Edición Offline'}</span>
                </button>

                {Boolean(t.offlineLicense || t.offlineOnlineDetected) && (
                  <button
                    type="button"
                    onClick={() => {
                      setActionMenu(null);
                      setMigrateTarget(t);
                      setMigrateConfirmText('');
                    }}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-sky-50 transition-colors text-left text-sky-800 font-semibold cursor-pointer"
                  >
                    <CloudUpload size={14} className="text-sky-600 shrink-0" />
                    <span>Migrar de Offline a Modo Online (con Respaldo Cloud)</span>
                  </button>
                )}
              </div>

              {/* Grupo 3: Edición y Credenciales */}
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setEditTarget(t);
                    setEditName(t.name);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                >
                  <Pencil size={14} className="text-slate-500 shrink-0" />
                  <span>Editar nombre</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    setResetTarget(t);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                >
                  <KeyRound size={14} className="text-slate-500 shrink-0" />
                  <span>Restablecer contraseña admin</span>
                </button>

                {t.clientPortalEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setActionMenu(null);
                      setPortalLinkTarget(t);
                    }}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                  >
                    <Link2 size={14} className="text-sky-600 shrink-0" />
                    <span>Enlace para clientes</span>
                  </button>
                )}
              </div>

              {/* Grupo 4: Zona de Peligro */}
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => {
                    setActionMenu(null);
                    void openDeleteDialog(t);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-red-50 transition-colors text-left text-red-600 font-medium cursor-pointer"
                >
                  <Trash2 size={14} className="text-red-600 shrink-0" />
                  <span>Eliminar organización</span>
                </button>
              </div>
            </div>
          </>
        );
      })()}
        </>
      )}

      {activeTab === 'banners' && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <Label className="text-xs uppercase font-bold text-slate-500 tracking-wider">
                  Organización a Administrar
                </Label>
                <Select
                  value={bannerTenant?.tenantId ?? ''}
                  onChange={(e) => setSelectedBannerTenantId(e.target.value)}
                  className="w-full sm:w-80 font-medium"
                >
                  {(tenants ?? []).map((t) => (
                    <option key={t.tenantId} value={t.tenantId}>
                      {t.name} {t.appLocked ? '(BLOQUEADA)' : ''}
                    </option>
                  ))}
                </Select>
              </div>
              {bannerTenant && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={bannerTenant.status === 'ACTIVE' ? 'success' : 'danger'}>
                    {bannerTenant.status === 'ACTIVE' ? 'ACTIVA' : 'SUSPENDIDA'}
                  </Badge>
                  {bannerTenant.notice && bannerTenant.notice.message.trim() !== '' && (
                    <Badge variant={bannerTenant.notice.level === 'danger' ? 'danger' : bannerTenant.notice.level === 'warning' ? 'warning' : 'info'}>
                      Aviso {bannerTenant.notice.level.toUpperCase()} Activo
                    </Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className={bannerTenant.paymentBannerDeactivated ? 'text-slate-600' : 'text-red-600 border-red-200 bg-red-50'}
                    onClick={() => void togglePaymentBanner(bannerTenant)}
                  >
                    <AlertTriangle size={14} />
                    {bannerTenant.paymentBannerDeactivated ? 'Reactivar cobro insistente' : 'Desactivar cobro insistente'}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {bannerTenant && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Panel 1: Administración de Aviso / Advertencia */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Megaphone size={18} className="text-emerald-600" />
                    <h3 className="font-bold text-slate-800">Banner de Aviso / Advertencia</h3>
                  </div>
                  {bannerTenant.notice && bannerTenant.notice.message.trim() !== '' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:bg-red-50"
                      onClick={() => void handleClearBannerNotice()}
                    >
                      <Trash2 size={13} /> Retirar aviso
                    </Button>
                  )}
                </div>

                <form onSubmit={handleSaveBannerNotice} className="space-y-3.5">
                  <div>
                    <Label>Título del aviso (opcional)</Label>
                    <Input
                      value={bannerTitle}
                      onChange={(e) => setBannerTitle(e.target.value)}
                      placeholder="Ej: Mantenimiento programado / Aviso de facturación"
                    />
                  </div>

                  <div>
                    <Label>Mensaje del aviso *</Label>
                    <textarea
                      value={bannerMessage}
                      onChange={(e) => setBannerMessage(e.target.value)}
                      rows={3}
                      className="w-full rounded-xl border border-slate-300 p-3 text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none"
                      placeholder="Escribe el texto que verá la organización en el banner superior..."
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label>Modo de Visualización</Label>
                      <Select
                        value={bannerDisplayMode}
                        onChange={(e) => setBannerDisplayMode(e.target.value as 'banner' | 'card_window')}
                      >
                        <option value="banner">Cintillo / Banner Superior</option>
                        <option value="card_window">Ventana Card Modal Flotante</option>
                      </Select>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {bannerDisplayMode === 'card_window'
                          ? 'Modal flotante en el centro.'
                          : 'Cintillo con slide si es largo.'}
                      </p>
                    </div>

                    <div>
                      <Label>Nivel de Severidad</Label>
                      <Select
                        value={bannerLevel}
                        onChange={(e) => setBannerLevel(e.target.value as NoticeLevel)}
                      >
                        <option value="info">Informativo (Azul)</option>
                        <option value="warning">Advertencia (Ámbar)</option>
                        <option value="danger">Urgente / Cobro (Rojo)</option>
                      </Select>
                    </div>

                    <div>
                      <Label>Fecha límite de vigencia (opcional)</Label>
                      <Input
                        type="datetime-local"
                        value={bannerExpiresAt}
                        onChange={(e) => setBannerExpiresAt(e.target.value)}
                      />
                      <p className="mt-1 text-[11px] text-slate-400">
                        En blanco = Permanente.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={bannerDismissible}
                        onChange={(e) => setBannerDismissible(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <div>
                        <span className="font-semibold text-xs text-slate-800">
                          Permitir al usuario cerrar el banner con botón (X)
                        </span>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {bannerDismissible
                            ? '✓ El usuario podrá ocultar el banner en su sesión.'
                            : '🔒 Consistente e inamovible: el usuario NO podrá cerrarlo hasta que expire o lo retires.'}
                        </p>
                      </div>
                    </label>
                  </div>

                  <Button type="submit" className="w-full">
                    <Check size={15} /> Guardar y Publicar Aviso
                  </Button>
                </form>
              </div>

              {/* Panel 2: Cobros, WhatsApp y Opciones de Pago */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                  <AlertTriangle size={18} className="text-red-500" />
                  <h3 className="font-bold text-slate-800">Cobro y Contacto WhatsApp</h3>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label>Número de WhatsApp para Pagos (esta organización)</Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        value={paymentPhone}
                        onChange={(e) => setPaymentPhone(e.target.value)}
                        placeholder={`Ej: ${CHRIZDEV_WHATSAPP_RAW} (por defecto)`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          openWhatsApp(
                            `Prueba de contacto de pago para PresMon (${bannerTenant.name})`,
                            paymentPhone || CHRIZDEV_WHATSAPP_PHONE,
                          )
                        }
                        title="Abrir WhatsApp con este número"
                      >
                        <Phone size={14} /> Probar
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Por defecto: {CHRIZDEV_WHATSAPP_DISPLAY}. Si lo dejas vacío, se usa el número predeterminado.
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={paymentDismissible}
                        onChange={(e) => setPaymentDismissible(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <div>
                        <span className="font-semibold text-xs text-slate-800">
                          Permitir botón de cerrar (X) en el banner de cobro
                        </span>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {paymentDismissible
                            ? '✓ El cliente puede ocultar temporalmente el aviso de cobro.'
                            : '🔒 Consistente e insistente: el banner de cobro NO se puede cerrar hasta que pague o sea desactivado por el Super Admin.'}
                        </p>
                      </div>
                    </label>
                  </div>

                  {(() => {
                    const plan = planByTenant.get(bannerTenant.tenantId);
                    const invoice = plan ? computeMonthlyInvoice(plan) : null;
                    return (
                      <div className="rounded-xl border border-slate-200 p-3 text-xs space-y-1.5 bg-gradient-to-br from-slate-50 to-white">
                        <p className="font-bold text-slate-700">Estado de Facturación Actual:</p>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Saldo exigible:</span>
                          <strong className={invoice && invoice.totalInvoiceAmount > 0 ? 'text-red-600 font-bold' : 'text-emerald-600'}>
                            {invoice ? formatCOP(invoice.totalInvoiceAmount) : '$0'}
                          </strong>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Días de mora:</span>
                          <span className="font-semibold text-slate-700">
                            {invoice ? `${invoice.maxDaysOverdue} días` : '0 días'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Banner de cobro:</span>
                          <span className="font-semibold">
                            {bannerTenant.paymentBannerDeactivated ? (
                              <span className="text-slate-400">DESACTIVADO</span>
                            ) : (
                              <span className="text-red-600 font-bold">ACTIVO</span>
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                  <Button
                    type="button"
                    className="w-full"
                    onClick={handleSavePaymentParams}
                  >
                    <Check size={15} /> Guardar Parámetros de Cobro
                  </Button>
                </div>
              </div>

              {/* Panel 3: Cuentas Bancarias para Depósito Directo */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4 lg:col-span-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Landmark size={18} className="text-indigo-600" />
                    <div>
                      <h3 className="font-bold text-slate-800">Cuentas Bancarias para Depósito Directo</h3>
                      <p className="text-xs text-slate-500">
                        Estas cuentas aparecerán en el banner de la organización para que depositen sin necesidad de preguntar.
                      </p>
                    </div>
                  </div>
                  <Button size="sm" onClick={openAddBankModal}>
                    <Plus size={14} /> Añadir Cuenta Bancaria
                  </Button>
                </div>

                {(!bannerTenant.bankAccounts || bannerTenant.bankAccounts.length === 0) ? (
                  <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
                    <Landmark size={32} className="mx-auto text-slate-400 mb-2" />
                    <p className="text-sm font-semibold text-slate-600">No hay cuentas bancarias personalizadas</p>
                    <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                      La organización verá las cuentas oficiales predeterminadas (Nequi y Bancolombia de ChrizDev) a menos que agregues cuentas específicas aquí.
                    </p>
                    <Button size="sm" variant="outline" className="mt-4" onClick={openAddBankModal}>
                      <Plus size={14} /> Configurar primera cuenta
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {bannerTenant.bankAccounts.map((acc) => (
                      <div
                        key={acc.id}
                        className={cn(
                          'rounded-xl border p-3.5 space-y-2 relative transition-all',
                          acc.active ? 'border-slate-200 bg-slate-50/70' : 'border-slate-200 bg-slate-100/50 opacity-60',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-800 uppercase">
                              {acc.accountType}
                            </span>
                            <h4 className="font-bold text-slate-900 mt-1 text-sm">{acc.bankName}</h4>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              title="Editar"
                              onClick={() => openEditBankModal(acc)}
                            >
                              <Pencil size={12} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-red-600 hover:bg-red-50"
                              title="Eliminar"
                              onClick={() => void handleDeleteBankAccount(acc.id)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-1 text-xs">
                          <p className="font-mono font-bold text-slate-800 text-sm">{acc.accountNumber}</p>
                          <p className="text-slate-600">Titular: <span className="font-medium">{acc.holderName}</span></p>
                          {acc.holderDoc && <p className="text-slate-500 text-[11px]">{acc.holderDoc}</p>}
                          {acc.notes && <p className="text-slate-500 text-[11px] italic">«{acc.notes}»</p>}
                        </div>

                        <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs">
                          <span className="text-slate-500">Estado:</span>
                          <button
                            type="button"
                            onClick={() => void handleToggleBankAccount(acc.id)}
                            className={cn(
                              'cursor-pointer font-semibold text-xs',
                              acc.active ? 'text-emerald-700' : 'text-slate-400',
                            )}
                          >
                            {acc.active ? '✓ Activa' : 'Inactiva'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'reports' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <h3 className="font-bold text-slate-800 text-lg">Comprobantes y Capturas de Pago</h3>
              <p className="text-xs text-slate-500">
                Revisa y verifica los comprobantes de depósito enviados por las organizaciones antes de aplicar los abonos.
              </p>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {(['PENDING', 'ALL', 'APPROVED', 'REJECTED'] as const).map((filter) => {
                const count =
                  filter === 'ALL'
                    ? (paymentReports ?? []).length
                    : (paymentReports ?? []).filter((r) => r.status === filter).length;
                return (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setReportFilter(filter)}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5',
                      reportFilter === filter
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                    )}
                  >
                    <span>{filter === 'ALL' ? 'Todos' : filter === 'PENDING' ? 'Pendientes' : filter === 'APPROVED' ? 'Aprobados' : 'Rechazados'}</span>
                    <span className={cn('rounded-full px-1.5 py-0.2 text-[10px]', reportFilter === filter ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700')}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {(() => {
            const filteredReports = (paymentReports ?? []).filter((r) => {
              if (reportFilter === 'ALL') return true;
              return r.status === reportFilter;
            });

            if (filteredReports.length === 0) {
              return (
                <div className="rounded-2xl border border-dashed border-slate-300 p-12 text-center bg-white">
                  <CreditCard size={40} className="mx-auto text-slate-300 mb-2" />
                  <p className="font-semibold text-slate-600">No hay comprobantes en esta categoría</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Los pagos reportados por las organizaciones mediante transferencia o depósito aparecerán aquí para tu verificación.
                  </p>
                </div>
              );
            }

            return (
              <TableWrap>
                <THead>
                  <TH>Fecha Reporte</TH>
                  <TH>Organización</TH>
                  <TH>Monto</TH>
                  <TH>Referencia / Banco</TH>
                  <TH>Comprobante</TH>
                  <TH>Estado</TH>
                  <TH className="text-right">Acciones</TH>
                </THead>
                <TBody>
                  {filteredReports.map((r) => {
                    const tenant = (tenants ?? []).find((t) => t.tenantId === r.tenantId);
                    return (
                      <TR key={r.reportId}>
                        <TD className="text-xs text-slate-600 whitespace-nowrap">
                          {formatDateTime(r.createdAt)}
                        </TD>
                        <TD className="font-semibold text-slate-800 text-sm">
                          {tenant?.name ?? r.tenantId}
                        </TD>
                        <TD className="font-mono font-bold text-slate-900 text-sm">
                          {formatCOP(r.amount)}
                        </TD>
                        <TD className="text-xs">
                          <div className="font-mono font-semibold text-slate-800">{r.referenceNumber || 'S/N'}</div>
                          <div className="text-slate-500">{r.bankName || 'Depósito'} {r.accountNumber ? `· ${r.accountNumber}` : ''}</div>
                        </TD>
                        <TD>
                          {r.receiptImageBase64 ? (
                            <button
                              type="button"
                              onClick={() => setViewingReceipt(r)}
                              className="group flex items-center gap-1.5 cursor-pointer rounded-lg border border-slate-200 p-1 hover:border-emerald-500 transition-all bg-white"
                              title="Ver captura completa"
                            >
                              <img
                                src={r.receiptImageBase64}
                                alt="Comprobante"
                                className="h-10 w-10 rounded object-cover"
                              />
                              <div className="text-left text-[11px] text-slate-600 group-hover:text-emerald-700">
                                <span className="flex items-center gap-1 font-semibold"><Eye size={12} /> Ver</span>
                              </div>
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400 italic">Sin captura</span>
                          )}
                        </TD>
                        <TD>
                          {r.status === 'PENDING' && (
                            <Badge variant="warning" className="animate-pulse">
                              ⏳ PENDIENTE
                            </Badge>
                          )}
                          {r.status === 'APPROVED' && (
                            <Badge variant="success">
                              ✓ APROBADO
                            </Badge>
                          )}
                          {r.status === 'REJECTED' && (
                            <Badge variant="danger" title={r.rejectionReason}>
                              ✗ RECHAZADO
                            </Badge>
                          )}
                        </TD>
                        <TD className="text-right">
                          {r.status === 'PENDING' ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-amber-700 border-amber-300 hover:bg-amber-50"
                                onClick={() => void handleApproveReportAsAbono(r)}
                                title="Aprobar como Abono y otorgar 15 días de vigencia para pagar el resto"
                              >
                                <HandCoins size={13} /> Abono 15d
                              </Button>
                              <Button
                                size="sm"
                                className="bg-emerald-600 hover:bg-emerald-500 text-white"
                                onClick={() => void handleApproveReport(r)}
                                title="Aprobar pago completo y desactivar aviso de cobro"
                              >
                                <CheckCircle size={13} /> Aprobar
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-red-600 border-red-200 hover:bg-red-50"
                                onClick={() => {
                                  setRejectReportTarget(r);
                                  setRejectReason('');
                                }}
                                title="Rechazar pago con motivo"
                              >
                                <XCircle size={13} /> Rechazar
                              </Button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">
                              {r.reviewedAt ? formatDateTime(r.reviewedAt) : 'Revisado'}
                            </span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </TableWrap>
            );
          })()}
        </div>
      )}

      {activeTab === 'legal' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <Scale size={20} className="text-emerald-600" />
                <h3 className="font-bold text-slate-800 text-lg">Contratos y Validez Legal (Ley 527 de 1999)</h3>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Registros electrónicos vinculantes de aceptación contractual, telemetría IP y acuerdos de pago bajo la legislación de la República de Colombia. Genera certificados con mérito probatorio judicial.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Input
                placeholder="Filtrar por organización o usuario..."
                value={legalSearchTenant}
                onChange={(e) => setLegalSearchTenant(e.target.value)}
                className="max-w-xs text-xs"
              />
            </div>
          </div>

          {(() => {
            const query = legalSearchTenant.trim().toLowerCase();
            const list = (legalAcceptances ?? []).filter((item) => {
              if (!query) return true;
              return (
                item.tenantName.toLowerCase().includes(query) ||
                item.userDisplayName.toLowerCase().includes(query) ||
                item.userName.toLowerCase().includes(query) ||
                (item.ipAddress && item.ipAddress.toLowerCase().includes(query))
              );
            });

            if (list.length === 0) {
              return (
                <div className="rounded-2xl border border-dashed border-slate-300 p-12 text-center bg-white">
                  <Scale size={40} className="mx-auto text-slate-300 mb-2" />
                  <p className="font-semibold text-slate-600">No se encontraron registros de aceptación legal</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Cada vez que un administrador de organización acepte los términos al ingresar, su firma y sello digital quedarán archivados aquí.
                  </p>
                </div>
              );
            }

            return (
              <TableWrap>
                <THead>
                  <TH>Fecha / Hora Oficial</TH>
                  <TH>Organización</TH>
                  <TH>Usuario / Representante</TH>
                  <TH>Versión Contrato</TH>
                  <TH>Dirección IP</TH>
                  <TH>Dispositivo / Navegador</TH>
                  <TH>Estado</TH>
                  <TH className="text-right">Certificado Judicial</TH>
                </THead>
                <TBody>
                  {list.map((rec) => (
                    <TR key={rec.acceptanceId}>
                      <TD className="text-xs font-mono text-slate-600 whitespace-nowrap">
                        {formatDateTime(rec.acceptedAt)}
                      </TD>
                      <TD className="font-semibold text-slate-900 text-sm">
                        {rec.tenantName}
                      </TD>
                      <TD className="text-xs">
                        <span className="font-bold text-slate-800">{rec.userDisplayName}</span>
                        <span className="text-slate-500 block text-[11px] font-mono">@{rec.userName}</span>
                      </TD>
                      <TD>
                        <Badge variant="outline" className="font-mono text-xs border-emerald-300 text-emerald-800 bg-emerald-50">
                          {rec.contractVersion}
                        </Badge>
                      </TD>
                      <TD className="font-mono text-xs text-slate-700">
                        {rec.ipAddress || 'No capturada'}
                      </TD>
                      <TD className="text-[11px] text-slate-500 max-w-xs truncate" title={rec.userAgent}>
                        {rec.userAgent}
                      </TD>
                      <TD>
                        <Badge variant="success">VINCULANTE</Badge>
                      </TD>
                      <TD className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-emerald-700 border-emerald-300 hover:bg-emerald-50 text-xs gap-1.5"
                          onClick={() => setSelectedCertificate(rec)}
                        >
                          <Printer size={13} /> Ver / Imprimir Certificado
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </TableWrap>
            );
          })()}
        </div>
      )}

      {/* Modal / Certificado Judicial Imprimible */}
      <Dialog
        open={selectedCertificate !== null}
        onClose={() => setSelectedCertificate(null)}
        title="Certificado de Aceptación Contractual Electrónica"
        wide
      >
        {selectedCertificate && (
          <div className="space-y-4">
            <div id="printable-legal-certificate" className="rounded-xl border border-slate-300 bg-white p-6 shadow-sm text-slate-900 font-sans space-y-4 print:p-0 print:border-0 print:shadow-none">
              <div className="border-b-2 border-emerald-700 pb-3 text-center space-y-1">
                <span className="text-[11px] font-bold tracking-widest uppercase text-emerald-800">
                  REPÚBLICA DE COLOMBIA · LEY 527 DE 1999
                </span>
                <h2 className="text-base font-black text-slate-900 uppercase">
                  CERTIFICADO DE ACREDITACIÓN DE CONSENTIMIENTO Y ACUERDO DE PAGO ELECTRÓNICO
                </h2>
                <p className="text-xs text-slate-600">
                  Equivalencia funcional de firma digital y plena validez probatoria (Arts. 6, 7, 8 y 10 Ley 527/1999)
                </p>
              </div>

              {/* Ficha Técnica de Telemetría */}
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs">
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">ID Firma Digital:</span>
                  <span className="font-mono font-bold text-slate-800 break-all">{selectedCertificate.acceptanceId}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Sello Cronológico (Timestamp ISO):</span>
                  <span className="font-mono font-bold text-slate-800">{formatDateTime(selectedCertificate.acceptedAt)}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Organización Licenciataria:</span>
                  <span className="font-bold text-slate-900">{selectedCertificate.tenantName}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Representante / Aceptante:</span>
                  <span className="font-bold text-slate-900">{selectedCertificate.userDisplayName} (@{selectedCertificate.userName})</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Dirección IP de Captura:</span>
                  <span className="font-mono text-slate-800">{selectedCertificate.ipAddress || 'Red Privada / Local'}</span>
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Versión del Contrato:</span>
                  <span className="font-mono font-bold text-emerald-700">{selectedCertificate.contractVersion}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Agente de Usuario (Navegador y Sistema Operativo):</span>
                  <span className="font-mono text-[11px] text-slate-700 break-words">{selectedCertificate.userAgent}</span>
                </div>
              </div>

              {/* Cláusulas Aceptadas */}
              <div>
                <h3 className="font-bold text-xs uppercase tracking-wide text-slate-800 border-b pb-1 mb-2">
                  Contenido Contractual Suscrito Electrónicamente:
                </h3>
                <div className="max-h-60 overflow-y-auto rounded bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 border border-slate-200 whitespace-pre-wrap font-serif select-text">
                  {selectedCertificate.contractText}
                </div>
              </div>

              {/* Declaración Probatoria */}
              <div className="rounded border border-emerald-600/30 bg-emerald-50/50 p-3 text-xs leading-relaxed text-emerald-950">
                <p className="font-bold text-emerald-900 mb-0.5">DECLARACIÓN PROBATORIA EXPRESA:</p>
                <p className="text-[11px]">
                  Se deja constancia fehaciente de que el Cliente aceptó de manera informada e irrevocable las obligaciones pecuniarias del servicio cloud, declarando aplicable la excepción de contrato no cumplido contemplada en el Artículo 1609 del Código Civil de Colombia, según la cual el no pago oportuno faculta a la suspensión de la plataforma sin que haya lugar a indemnizaciones por perjuicios o lucro cesante.
                </p>
              </div>

              <div className="flex justify-between items-center text-[10px] text-slate-400 pt-2 border-t">
                <span>PresMon Software by ChrizDev · Sistema de Gestión Crediticia</span>
                <span>Firma electrónica registrada con respaldo criptográfico</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setSelectedCertificate(null)}>
                Cerrar
              </Button>
              <Button
                onClick={() => {
                  window.print();
                }}
                className="bg-emerald-600 hover:bg-emerald-500 text-white gap-2"
              >
                <Printer size={15} /> Imprimir Certificado Judicial
              </Button>
            </div>
          </div>
        )}
      </Dialog>

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
            La sincronización en la nube es siempre activa para todas las organizaciones.
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

      <PortalShareModal
        open={portalLinkTarget !== null}
        onClose={() => setPortalLinkTarget(null)}
        portalUrl={portalUrlFor(portalLinkTarget)}
        orgName={portalLinkTarget?.name ?? ''}
      />

      <Dialog
        open={offlineTarget !== null}
        onClose={() => setOfflineTargetId('')}
        title={`Edición Offline · ${offlineTarget?.name ?? ''}`}
        description="App 100% sin internet para un dispositivo: se instala una sola vez con la base de datos incluida."
      >
        <div className="space-y-3">
          {offlineTarget?.offlineLicense ? (
            <>
              <div className="flex items-center gap-2">
                <Input value={offlineLinkFor(offlineTarget)} readOnly className="font-mono text-xs" />
                <Button size="sm" variant="secondary" onClick={() => void copyOfflineLink()}>
                  <Copy size={14} /> Copiar
                </Button>
              </div>
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-800">
                <p className="font-semibold">Licencia emitida</p>
                <p>
                  Clave <strong>{offlineTarget.offlineLicense.key}</strong> ·{' '}
                  {formatDateTime(offlineTarget.offlineLicense.issuedAt)} por{' '}
                  {offlineTarget.offlineLicense.issuedByName}
                </p>
                <p className="mt-1">
                  El cliente abre el enlace con internet UNA sola vez: valida la licencia, descarga
                  su base de datos y a partir de ahí la app jamás se conecta a la nube. Sin cuotas,
                  sin control remoto.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOfflineTargetId('')}>
                  Cerrar
                </Button>
                <Button variant="secondary" onClick={shareOfflineByWhatsApp}>
                  Enviar enlace por WhatsApp
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                <p className="font-semibold">Antes de generar el enlace</p>
                <ul className="mt-1 list-inside list-disc">
                  <li>Pago ÚNICO de licencia (una app offline no admite mensualidades ni bloqueo remoto).</li>
                  <li>Solo se puede instalar en UN dispositivo por enlace.</li>
                  <li>Los datos NO se respaldan en la nube ni se sincronizan entre dispositivos.</li>
                </ul>
              </div>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs text-slate-600 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={offlinePaid}
                  onChange={(e) => setOfflinePaid(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  Confirmo que «{offlineTarget?.name}» ya pagó el total de la licencia Edición
                  Offline.
                </span>
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOfflineTargetId('')}>
                  Cancelar
                </Button>
                <Button onClick={() => void issueOfflineLicense()} disabled={!offlinePaid}>
                  <HardDriveDownload size={14} /> Generar enlace de instalación
                </Button>
              </div>
            </>
          )}
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

      <Dialog
        open={wipeTarget !== null}
        onClose={() => {
          if (!wiping) setWipeTarget(null);
        }}
        title={`Borrar datos locales y revocar offline · ${wipeTarget?.name ?? ''}`}
      >
        <div className="space-y-3">
          <div className="rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700">
            <p className="font-bold">PURGA LOCAL Y REVOCACIÓN DE MODO OFFLINE</p>
            <ul className="mt-1.5 list-inside list-disc space-y-1">
              <li>
                <strong>Purga en este equipo:</strong> Elimina de inmediato todos los préstamos,
                cuotas, prestatarios, usuarios y auditoría de «{wipeTarget?.name}» en la base de
                datos local (IndexedDB).
              </li>
              <li>
                <strong>Orden remota (Wipe):</strong> Cualquier dispositivo de esta organización
                que abra la app o se conecte purgará automáticamente su base de datos local y
                cerrará la sesión.
              </li>
              <li>
                <strong>Bloqueo de ejecución offline:</strong> Se deshabilita la posibilidad de que
                la organización vuelva a usar la aplicación sin conexión.
              </li>
            </ul>
          </div>
          {/* Feedback de ejecución previa: Purga ya confirmada */}
          {wipeTarget?.wipeConfirmedAt && (
            <div className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900 border border-emerald-300 space-y-2">
              <div className="flex items-center gap-2">
                <BadgeCheck size={16} className="text-emerald-600 shrink-0" />
                <p className="font-bold">Purga ya ejecutada y confirmada con éxito previamente</p>
              </div>
              <p className="text-[11px] text-emerald-800">
                Esta organización ya ejecutó la purga el <strong className="font-mono">{formatDateTime(wipeTarget.wipeConfirmedAt)}</strong>
                {wipeTarget.wipeConfirmedDevice ? ` en el equipo «${wipeTarget.wipeConfirmedDevice}»` : ''}.
              </p>
              <p className="text-[11px] text-emerald-700">
                Los datos locales en el dispositivo cliente ya fueron eliminados. <strong>No es necesario volver a emitir la orden</strong> a menos que desees forzar una re-purga deliberada.
              </p>
              <label className="flex items-center gap-2 pt-1.5 border-t border-emerald-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeForceReissue}
                  onChange={(e) => setWipeForceReissue(e.target.checked)}
                  className="h-4 w-4 rounded border-emerald-400 text-emerald-600"
                />
                <span className="font-bold text-[11px] text-emerald-950">
                  Deseo re-emitir la orden de purga de todos modos
                </span>
              </label>
            </div>
          )}

          {/* Feedback de ejecución previa: Purga pendiente de conexión */}
          {wipeTarget?.wipeLocalData && !wipeTarget?.wipeConfirmedAt && (
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 border border-amber-300 space-y-2">
              <div className="flex items-center gap-2">
                <Clock size={16} className="text-amber-600 shrink-0" />
                <p className="font-bold">Orden remota de purga ya activa y en espera</p>
              </div>
              <p className="text-[11px] text-amber-800">
                Ya existe una orden de purga enviada y pendiente de confirmación para «{wipeTarget?.name}». En cuanto cualquier dispositivo de esta organización se conecte a internet o abra la app, se purgará de forma automática.
              </p>
              <p className="text-[11px] text-amber-700">
                <strong>No es necesario volver a enviarla</strong>, pero puedes confirmarlo si deseas renovar la solicitud.
              </p>
              <div className="pt-2 border-t border-amber-200">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full text-emerald-800 border-emerald-400 bg-emerald-50 hover:bg-emerald-100 cursor-pointer font-bold text-xs"
                  onClick={() => {
                    if (wipeTarget) void handleReactivateCloudSync(wipeTarget);
                    setWipeTarget(null);
                  }}
                >
                  <Cloud size={13} className="mr-1.5 shrink-0" />
                  Cancelar orden de purga y restaurar sincronización nube
                </Button>
              </div>
              <label className="flex items-center gap-2 pt-1.5 border-t border-amber-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wipeForceReissue}
                  onChange={(e) => setWipeForceReissue(e.target.checked)}
                  className="h-4 w-4 rounded border-amber-400 text-amber-600"
                />
                <span className="font-bold text-[11px] text-amber-950">
                  Deseo re-enviar la orden de purga de todos modos
                </span>
              </label>
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-2.5 text-xs text-slate-700 hover:bg-slate-50">
            <input
              type="checkbox"
              checked={wipeLockOrg}
              onChange={(e) => setWipeLockOrg(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <div>
              <span className="font-semibold text-slate-800">
                Bloquear también el acceso web/online de la organización
              </span>
              <p className="text-[11px] text-slate-500">
                Desmarcado por defecto: la purga offline se ejecuta sin suspender la organización en la web. Márcalo solo si deseas bloquear totalmente la cuenta.
              </p>
            </div>
          </label>

          <p className="text-xs text-slate-500">
            Usa esta función si el cliente no ha pagado su licencia o para impedir que continúe
            operando la app de forma clandestina o desconectada.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              disabled={wiping}
              onClick={() => {
                setWipeTarget(null);
                setWipeForceReissue(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={
                wiping ||
                ((!!wipeTarget?.wipeConfirmedAt || (!!wipeTarget?.wipeLocalData && !wipeTarget?.wipeConfirmedAt)) &&
                  !wipeForceReissue)
              }
              onClick={() => void handleWipeTenantLocalData()}
            >
              <DatabaseZap size={14} /> {wiping ? 'Purgando datos…' : wipeLockOrg ? 'Confirmar purga y bloquear cuenta' : 'Confirmar purga offline'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Modal para Migración Asistida de Edición Offline a Modo Online */}
      <Dialog
        open={migrateTarget !== null}
        onClose={() => {
          if (!migrating) setMigrateTarget(null);
        }}
        title={`Migrar a Modo Online (Cloud) · ${migrateTarget?.name ?? ''}`}
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3.5 text-xs text-sky-950 leading-relaxed space-y-2">
            <p className="font-bold flex items-center gap-1.5 text-sky-900 uppercase">
              <CloudUpload size={16} className="text-sky-600" /> Transición Segura a Modo Online
            </p>
            <p>
              Esta acción migra la organización <strong>«{migrateTarget?.name}»</strong> de Edición Offline a Modo Online Multiusuario con sincronización y respaldo continuo en la nube.
            </p>
            <ul className="list-inside list-disc space-y-1 text-[11px] text-sky-800">
              <li>
                <strong>Respaldo Automático:</strong> Se generará una copia de seguridad íntegra en la nube con todos los préstamos, cuotas y clientes antes de cualquier cambio.
              </li>
              <li>
                <strong>Sincronización Multidispositivo:</strong> Se revoca la llave offline exclusiva y se activa el motor cloud de Firestore para que la app opere sincronizada en tiempo real.
              </li>
              <li>
                <strong>Cero Pérdida de Datos:</strong> Al reconectarse el dispositivo cliente, sus datos locales pendientes se subirán automáticamente a las colecciones de la nube.
              </li>
            </ul>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <p className="font-semibold text-slate-900">Validación de Seguridad:</p>
            <p className="mt-1 text-[11px] text-slate-600">
              Para confirmar la migración, escribe exactamente el nombre de la organización: <code className="font-bold text-slate-900 bg-white px-1.5 py-0.5 rounded border border-slate-300">{migrateTarget?.name}</code>
            </p>
            <Input
              value={migrateConfirmText}
              onChange={(e) => setMigrateConfirmText(e.target.value)}
              placeholder="Escribe el nombre aquí..."
              className="mt-2 text-xs bg-white"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              disabled={migrating}
              onClick={() => {
                setMigrateTarget(null);
                setMigrateConfirmText('');
              }}
            >
              Cancelar
            </Button>
            <Button
              disabled={migrating || migrateConfirmText.trim().toLowerCase() !== (migrateTarget?.name ?? '').trim().toLowerCase()}
              className="bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs gap-1.5"
              onClick={() => {
                if (migrateTarget) void handleMigrateToOnline(migrateTarget);
              }}
            >
              <CloudUpload size={14} />
              {migrating ? 'Respaldando y migrando…' : 'Confirmar y Migrar a Online'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Modal para Visualizar Comprobante / Captura en Alta Resolución */}
      <Dialog
        open={viewingReceipt !== null}
        onClose={() => setViewingReceipt(null)}
        title={`Comprobante de Pago · ${(tenants ?? []).find((t) => t.tenantId === viewingReceipt?.tenantId)?.name ?? ''}`}
      >
        <div className="space-y-3">
          {viewingReceipt?.receiptImageBase64 ? (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-900/5 flex items-center justify-center max-h-[60vh] p-1">
              <img
                src={viewingReceipt.receiptImageBase64}
                alt="Comprobante de pago"
                className="max-h-[58vh] w-auto object-contain rounded-lg shadow-sm"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
              <ImageIcon size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-xs">No se adjuntó captura de pantalla para este reporte.</p>
            </div>
          )}

          <div className="rounded-xl bg-slate-50 p-3 text-xs space-y-1.5 border border-slate-200">
            <div className="flex justify-between">
              <span className="text-slate-500">Monto Reportado:</span>
              <strong className="font-mono font-bold text-slate-900 text-sm">
                {viewingReceipt ? formatCOP(viewingReceipt.amount) : ''}
              </strong>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Referencia Bancaria:</span>
              <span className="font-mono font-semibold text-slate-800">{viewingReceipt?.referenceNumber || 'S/N'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Cuenta Destino:</span>
              <span className="text-slate-700">{viewingReceipt?.bankName || 'Depósito'} {viewingReceipt?.accountNumber ? `· ${viewingReceipt.accountNumber}` : ''}</span>
            </div>
            {viewingReceipt?.notes && (
              <div className="pt-1 text-slate-600 italic border-t border-slate-200">
                Notas: {viewingReceipt.notes}
              </div>
            )}
            {viewingReceipt?.rejectionReason && (
              <div className="rounded bg-red-100 p-2 text-red-800 font-medium">
                Motivo de rechazo: {viewingReceipt.rejectionReason}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            {viewingReceipt?.status === 'PENDING' && (
              <>
                <Button
                  variant="outline"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => {
                    const target = viewingReceipt;
                    setViewingReceipt(null);
                    setRejectReportTarget(target);
                    setRejectReason('');
                  }}
                >
                  <XCircle size={14} /> Rechazar
                </Button>
                <Button
                  variant="outline"
                  className="text-amber-700 border-amber-300 hover:bg-amber-50"
                  onClick={() => {
                    const target = viewingReceipt;
                    setViewingReceipt(null);
                    void handleApproveReportAsAbono(target);
                  }}
                  title="Aprobar como abono a cuota y conceder 15 días de vigencia"
                >
                  <HandCoins size={14} /> Abono 15d
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-500 text-white"
                  onClick={() => {
                    const target = viewingReceipt;
                    setViewingReceipt(null);
                    void handleApproveReport(target);
                  }}
                >
                  <CheckCircle size={14} /> Aprobar Total
                </Button>
              </>
            )}
            <Button variant="secondary" onClick={() => setViewingReceipt(null)}>
              Cerrar
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Modal para Rechazar Comprobante con Motivo */}
      <Dialog
        open={rejectReportTarget !== null}
        onClose={() => setRejectReportTarget(null)}
        title="Rechazar Comprobante de Pago"
      >
        <form onSubmit={handleRejectReport} className="space-y-3">
          <p className="text-xs text-slate-600">
            Indica el motivo por el cual rechazas este pago. La organización podrá ver esta observación en su panel.
          </p>
          <div>
            <Label>Motivo del rechazo *</Label>
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Ej: El pago no figura en movimientos bancarios / Comprobante alterado"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setRejectReportTarget(null)}>
              Cancelar
            </Button>
            <Button type="submit" variant="destructive">
              Confirmar Rechazo
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Modal para Añadir / Editar Cuenta Bancaria */}
      <Dialog
        open={bankDialogOpen}
        onClose={() => setBankDialogOpen(false)}
        title={editingBankId ? 'Editar Cuenta Bancaria' : 'Añadir Cuenta Bancaria para Depósito'}
      >
        <form onSubmit={handleSaveBankAccount} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Banco / Entidad *</Label>
              <Input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Ej: Bancolombia / Nequi / Daviplata"
                required
              />
            </div>
            <div>
              <Label>Tipo de Cuenta</Label>
              <Select
                value={bankAccountType}
                onChange={(e) => setBankAccountType(e.target.value as BankAccountInfo['accountType'])}
              >
                <option value="WALLET">Billetera Digital / Bre-B</option>
                <option value="SAVINGS">Cuenta de Ahorros</option>
                <option value="CHECKING">Cuenta Corriente</option>
                <option value="OTHER">Otro Medio</option>
              </Select>
            </div>
          </div>

          <div>
            <Label>Número de Cuenta o Celular *</Label>
            <Input
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              placeholder="Ej: 3183517802 / 123-456789-00"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Nombre del Titular *</Label>
              <Input
                value={bankHolderName}
                onChange={(e) => setBankHolderName(e.target.value)}
                placeholder="Christian Romero"
                required
              />
            </div>
            <div>
              <Label>Documento / NIT (opcional)</Label>
              <Input
                value={bankHolderDoc}
                onChange={(e) => setBankHolderDoc(e.target.value)}
                placeholder="CC 1094958312"
              />
            </div>
          </div>

          <div>
            <Label>Notas o Llave QR (opcional)</Label>
            <Input
              value={bankNotes}
              onChange={(e) => setBankNotes(e.target.value)}
              placeholder="Ej: Transferir por Bre-B, enviar soporte tras pagar"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setBankDialogOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit">
              Guardar Cuenta
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Modal para visualizar y copiar las Reglas Firestore actualizadas */}
      <Dialog
        open={rulesModalOpen}
        onClose={() => setRulesModalOpen(false)}
        title="Reglas de Seguridad Firestore (firestore.rules)"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            Copia estas reglas y pégalas en tu consola de Firebase:{' '}
            <strong className="text-slate-800">Firebase Console &gt; Firestore Database &gt; Reglas (Rules)</strong>{' '}
            y haz clic en <strong className="text-emerald-700">Publicar</strong>. Contemplan sincronización, auditoría,
            control de cuenta remota y el nuevo módulo de reportes de pago.
          </p>

          <div className="rounded-lg border border-slate-200 bg-slate-900 p-3 font-mono text-[11px] text-slate-200 max-h-64 overflow-y-auto">
            <pre className="whitespace-pre">{`rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function hasValidTenantId() {
      return request.resource.data.tenantId is string;
    }

    match /tenants/{doc} {
      allow read: if true;
      allow create, update: if request.resource.data.tenantId is string &&
                               request.resource.data.name is string;
      allow delete: if true;
    }

    match /users/{doc} {
      allow read: if true;
      allow create, update: if request.resource.data.userId is string &&
                               request.resource.data.username is string;
      allow delete: if true;
    }

    match /borrowers/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.borrowerId is string;
      allow delete: if true;
    }

    match /loans/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.loanId is string;
      allow delete: if true;
    }

    match /installments/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.installmentId is string;
      allow delete: if true;
    }

    match /audit_logs/{doc} {
      allow read: if true;
      allow create, update: if request.resource.data.logId is string;
      allow delete: if true;
    }

    match /plans/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.planId is string;
      allow delete: if true;
    }

    match /loan_requests/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.requestId is string;
      allow delete: if true;
    }

    match /payment_reports/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.reportId is string;
      allow delete: if true;
    }

    match /legal_acceptances/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.acceptanceId is string;
      allow delete: if true;
    }
  }
}`}</pre>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                const rulesText = `rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function hasValidTenantId() {
      return request.resource.data.tenantId is string;
    }

    match /tenants/{doc} {
      allow read: if true;
      allow create, update: if request.resource.data.tenantId is string &&
                               request.resource.data.name is string;
      allow delete: if true;
    }

    match /users/{doc} {
      allow read: if true;
      allow create, update: if request.resource.data.userId is string &&
                               request.resource.data.username is string;
      allow delete: if true;
    }

    match /borrowers/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.borrowerId is string;
      allow delete: if true;
    }

    match /loans/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.loanId is string;
      allow delete: if true;
    }

    match /installments/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.installmentId is string;
      allow delete: if true;
    }

    match /audit_logs/{doc} {
      allow read: if true;
      allow create, update: if request.resource.data.logId is string;
      allow delete: if true;
    }

    match /plans/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.planId is string;
      allow delete: if true;
    }

    match /loan_requests/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.requestId is string;
      allow delete: if true;
    }

    match /payment_reports/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.reportId is string;
      allow delete: if true;
    }

    match /legal_acceptances/{doc} {
      allow read: if true;
      allow create, update: if hasValidTenantId() && request.resource.data.acceptanceId is string;
      allow delete: if true;
    }
  }
}`;
                try {
                  await navigator.clipboard.writeText(rulesText);
                  toast('Reglas copiadas al portapapeles', 'success');
                } catch {
                  toast('No se pudo copiar automáticamente', 'error');
                }
              }}
              className="gap-1.5"
            >
              <Copy size={14} /> Copiar Reglas
            </Button>
            <Button type="button" onClick={() => setRulesModalOpen(false)}>
              Entendido
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Modal de Control de Administradores y Sesiones */}
      <Dialog
        open={adminManageTarget !== null}
        onClose={() => setAdminManageTarget(null)}
        title={`Control de Administradores y Sesiones · ${adminManageTarget?.name ?? ''}`}
      >
        {adminManageTarget && (() => {
          const orgAdmins = adminsByTenant.get(adminManageTarget.tenantId) ?? [];
          return (
            <div className="space-y-5">
              {/* Sección 1: Administradores Actuales */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                    <Users size={14} className="text-slate-500" /> Administradores Registrados ({orgAdmins.length})
                  </h4>
                  {orgAdmins.length > 1 && (
                    <Badge variant="warning" className="font-bold">
                      {orgAdmins.length} admins activos
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  Por regla de seguridad, una organización normal solo debe contar con 1 administrador titular. Si hay administradores redundantes, puedes eliminarlos aquí.
                </p>

                <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white overflow-hidden">
                  {orgAdmins.length === 0 ? (
                    <div className="p-3 text-xs text-slate-500 text-center">No hay usuarios administradores registrados.</div>
                  ) : (
                    orgAdmins.map((u) => (
                      <div key={u.userId} className="flex items-center justify-between p-2.5 text-xs">
                        <div>
                          <p className="font-bold text-slate-900">{u.displayName || u.username}</p>
                          <p className="text-[11px] text-slate-500 font-mono">Usuario: @{u.username}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {orgAdmins.length > 1 && (
                            <Button
                              variant="destructive"
                              size="sm"
                              className="h-7 text-xs gap-1"
                              onClick={() => void handleDeleteAdminUser(u, adminManageTarget)}
                              title="Eliminar este administrador para dejar solo 1 titular"
                            >
                              <Trash2 size={12} /> Eliminar
                            </Button>
                          )}
                          {orgAdmins.length === 1 && (
                            <Badge variant="success">Admin Principal</Badge>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Sección 2: Estado de Sesión Activa y Forzar Cierre Remoto */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 space-y-2.5">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                  <Smartphone size={14} className="text-slate-500" /> Sesión Remota en Dispositivo
                </h4>
                {(() => {
                  const onlineInfo = getTenantOnlineInfo(adminManageTarget);
                  const activeDevice = adminManageTarget.currentDeviceName || adminManageTarget.lastSeenDevice || adminManageTarget.offlineDeviceInfo || 'Dispositivo conectado';

                  if (adminManageTarget.currentSessionId) {
                    return (
                      <div className="flex flex-col gap-3 p-3.5 bg-white rounded-xl border border-emerald-200 shadow-2xs">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                            <p className="text-xs font-bold text-slate-900">
                              {formatDeviceSummary(activeDevice)}
                            </p>
                            <Badge variant="success" className="text-[10px] py-0 px-1.5 font-bold">
                              Sesión Activa
                            </Badge>
                          </div>
                          <p className="text-[10px] text-slate-500 font-mono break-all bg-slate-50 p-2 rounded-lg border border-slate-100 my-1 leading-relaxed">
                            {activeDevice}
                          </p>
                          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                            Iniciada: {adminManageTarget.sessionStartedAt ? formatDateTime(adminManageTarget.sessionStartedAt) : 'Sesión en curso'} · {onlineInfo.tooltip}
                          </p>
                        </div>
                        <div className="flex justify-end pt-2 border-t border-slate-100">
                          <Button
                            variant="destructive"
                            size="sm"
                            className="gap-1.5 cursor-pointer w-full sm:w-auto"
                            onClick={() => void handleDisconnectSession(adminManageTarget)}
                          >
                            <LogOut size={13} /> Forzar Desconexión Remota
                          </Button>
                        </div>
                      </div>
                    );
                  }

                  if (onlineInfo.isLive) {
                    return (
                      <div className="flex flex-col gap-3 p-3.5 bg-white rounded-xl border border-emerald-200 shadow-2xs">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                            <p className="text-xs font-bold text-slate-900">
                              {formatDeviceSummary(activeDevice)}
                            </p>
                            <Badge variant={onlineInfo.badgeVariant} className="text-[10px] py-0 px-1.5 font-bold">
                              {onlineInfo.text}
                            </Badge>
                          </div>
                          <p className="text-[10px] text-slate-500 font-mono break-all bg-slate-50 p-2 rounded-lg border border-slate-100 my-1 leading-relaxed">
                            {activeDevice}
                          </p>
                          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                            {onlineInfo.tooltip}
                          </p>
                        </div>
                        <div className="flex justify-end pt-2 border-t border-slate-100">
                          <Button
                            variant="destructive"
                            size="sm"
                            className="gap-1.5 cursor-pointer w-full sm:w-auto"
                            onClick={() => void handleDisconnectSession(adminManageTarget)}
                          >
                            <LogOut size={13} /> Forzar Desconexión Remota
                          </Button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className="flex flex-col gap-3 p-3.5 bg-white rounded-xl border border-slate-200 text-xs text-slate-600 shadow-2xs">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="h-2 w-2 rounded-full bg-slate-300 shrink-0" />
                          <p className="font-bold text-slate-800">Equipo actualmente desconectado</p>
                          <Badge variant="muted" className="text-[10px] py-0 px-1.5">Off-line</Badge>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                          {onlineInfo.text !== 'Sin registro'
                            ? `Última actividad: ${onlineInfo.text} · ${onlineInfo.tooltip}`
                            : 'Esta organización no ha registrado conexiones online.'}
                        </p>
                      </div>
                      <div className="flex justify-end pt-2 border-t border-slate-100">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-slate-600 hover:text-slate-900 cursor-pointer w-full sm:w-auto"
                          onClick={() => void handleDisconnectSession(adminManageTarget)}
                          title="Genera un nuevo identificador de sesión para invalidar cualquier sesión anterior si el equipo intenta reconectar"
                        >
                          <ShieldCheck size={13} /> Invalidar Tokens Previos
                        </Button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Sección 3: Reglas de Límite y Concurrencia */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-slate-500" /> Política de Acceso de la Organización
                </h4>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label className="text-xs font-semibold text-slate-900">Límite máximo de administradores</Label>
                    <p className="text-[11px] text-slate-500">Máximo número de cuentas con rol de administrador permitidas (Recomendado: 1).</p>
                  </div>
                  <Input
                    type="number"
                    min="1"
                    max="10"
                    value={adminPolicyMax}
                    onChange={(e) => setAdminPolicyMax(Number(e.target.value) || 1)}
                    className="w-20 text-center"
                  />
                </div>

                <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-200">
                  <div>
                    <Label className="text-xs font-semibold text-slate-900">Permitir múltiples sesiones simultáneas</Label>
                    <p className="text-[11px] text-slate-500">
                      Si está desactivado (Recomendado), al iniciar sesión en un 2do dispositivo se cerrará la sesión anterior con advertencia de límite de plan (Módulo Socio requerido).
                    </p>
                  </div>
                  <Switch
                    checked={adminPolicyMultiSession}
                    onChange={() => setAdminPolicyMultiSession(!adminPolicyMultiSession)}
                    label="Multi-Sesión"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setAdminManageTarget(null)}>
                  Cerrar
                </Button>
                <Button onClick={() => void handleSaveAdminPolicy(adminManageTarget)}>
                  Guardar Política
                </Button>
              </div>
            </div>
          );
        })()}
      </Dialog>

      {/* Modal de Módulo Socio y Generación de Enlace de Único Uso */}
      <Dialog
        open={socioLinkTarget !== null}
        onClose={() => {
          setSocioLinkTarget(null);
          setGeneratedSocioLink(null);
        }}
        title={`Módulo Socio (Cobrador en Ruta) · ${socioLinkTarget?.name ?? ''}`}
      >
        {socioLinkTarget && (() => {
          const tokens = socioLinkTarget.singleUseSocioTokens || [];
          return (
            <div className="space-y-4">
              <div className="rounded-xl border border-purple-200 bg-purple-50/50 p-3.5 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-purple-100 text-purple-700">
                    <Smartphone size={18} />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-purple-900">Enlace de Acceso Exclusivo y Único Uso</h4>
                    <p className="text-[11px] text-purple-700">
                      Permite al cobrador registrar abonos en calle sin ver métricas financieras.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Por seguridad estricta, cada enlace es de <strong>ÚNICO USO</strong>. Una vez que el socio abre el enlace en su celular, queda permanentemente vinculado a ese dispositivo y el token queda quemado; nadie más puede replicarlo ni abrirlo.
                </p>
                <div className="pt-1">
                  <Button
                    onClick={() => void handleGenerateSocioToken(socioLinkTarget)}
                    className="w-full bg-purple-700 hover:bg-purple-600 text-white font-medium text-xs gap-1.5"
                  >
                    <Plus size={14} /> Generar Nuevo Enlace de Socio
                  </Button>
                </div>
              </div>

              {generatedSocioLink && (
                <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 space-y-2.5 animate-in fade-in duration-200">
                  <div className="flex items-center gap-1.5 text-emerald-800 font-bold text-xs">
                    <CheckCircle size={14} className="text-emerald-600" /> ¡Enlace generado con éxito!
                  </div>
                  <Input
                    readOnly
                    value={generatedSocioLink}
                    className="bg-white font-mono text-xs select-all text-slate-800"
                  />
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs bg-white hover:bg-slate-50"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(generatedSocioLink);
                          toast('Enlace copiado al portapapeles', 'success');
                        } catch {
                          toast('No se pudo copiar automáticamente', 'error');
                        }
                      }}
                    >
                      <Copy size={13} /> Copiar Enlace
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                      onClick={() => {
                        const msg = `Hola, este es tu enlace exclusivo para la ruta de cobros de ${socioLinkTarget.name}: ${generatedSocioLink}\n\n⚠️ Importante: Este enlace es de ÚNICO USO por seguridad. Al abrirlo quedará vinculado a tu dispositivo móvil y no se podrá volver a abrir ni compartir.`;
                        openWhatsApp('', msg);
                      }}
                    >
                      <MessageCircle size={13} /> Enviar por WhatsApp
                    </Button>
                  </div>
                </div>
              )}

              {/* Historial de Tokens */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Historial de Tokens Emitidos ({tokens.length})
                </h4>
                <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white max-h-48 overflow-y-auto">
                  {tokens.length === 0 ? (
                    <div className="p-3 text-xs text-slate-400 text-center">No hay enlaces de socio emitidos todavía.</div>
                  ) : (
                    [...tokens].reverse().map((tok) => (
                      <div key={tok.token} className="flex items-center justify-between p-2.5 text-xs">
                        <div>
                          <p className="font-mono text-[11px] text-slate-700 font-semibold">
                            token_...{tok.token.slice(0, 8)}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            Creado: {formatDateTime(tok.createdAt)}
                          </p>
                          {tok.used && (
                            <p className="text-[10px] text-emerald-600">
                              Canjeado: {tok.usedAt ? formatDateTime(tok.usedAt) : 'Sí'} ({tok.usedByDevice || 'Dispositivo'})
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={tok.used ? 'success' : 'warning'}>
                            {tok.used ? 'Canjeado' : 'Activo (Sin usar)'}
                          </Badge>
                          <button
                            type="button"
                            onClick={() => void handleRevokeSocioToken(socioLinkTarget, tok.token)}
                            className="text-slate-400 hover:text-red-500 p-1 cursor-pointer"
                            title="Revocar token"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSocioLinkTarget(null);
                    setGeneratedSocioLink(null);
                  }}
                >
                  Cerrar
                </Button>
              </div>
            </div>
          );
        })()}
      </Dialog>
    </div>
  );
}
