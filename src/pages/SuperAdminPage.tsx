import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle,
  ChevronDown,
  Clock,
  Copy,
  CreditCard,
  DatabaseZap,
  Eye,
  FileCode,
  Globe,
  HardDriveDownload,
  Image as ImageIcon,
  KeyRound,
  Landmark,
  Link2,
  Lock,
  LockOpen,
  Megaphone,
  Pencil,
  Phone,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  BankAccountInfo,
  NoticeLevel,
  PaymentReport,
  PaymentReportStatus,
  ServicePlan,
  Tenant,
} from '../db/models';
import { db, deleteTenantCascade, saveTenant, saveUser, wipeLocalTenantData } from '../db/db';
import { useAuth } from '../store/auth';
import { sha256Hex } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { uid } from '../lib/id';
import { cn, formatCOP, formatDateTime } from '../lib/format';
import { computeMonthlyInvoice } from '../lib/billingEngine';
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
  const plans = useLiveQuery(() => db.plans.toArray(), []);

  const planByTenant = useMemo(() => {
    const map = new Map<string, ServicePlan>();
    (plans ?? []).forEach((p) => map.set(p.tenantId, p));
    return map;
  }, [plans]);

  const [wipeTarget, setWipeTarget] = useState<Tenant | null>(null);
  const [wiping, setWiping] = useState(false);
  const [wipeLockOrg, setWipeLockOrg] = useState(false);

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

  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'tenants' | 'banners' | 'reports'>(() => {
    if (urlTab === 'banners' || urlTab === 'reports') return urlTab;
    return 'tenants';
  });

  const paymentReports = useLiveQuery(() => db.payment_reports.reverse().sortBy('createdAt'), []);
  const pendingReportsCount = useMemo(
    () => (paymentReports ?? []).filter((r) => r.status === 'PENDING').length,
    [paymentReports],
  );

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

  function getTenantOnlineInfo(t: Tenant): {
    badgeVariant: 'success' | 'warning' | 'muted' | 'danger' | 'info';
    text: string;
    tooltip: string;
    isLive: boolean;
  } {
    const seenAt = t.lastSeenOnlineAt || t.offlineOnlineDetectedAt;
    if (!seenAt) {
      return {
        badgeVariant: 'muted',
        text: 'Sin registro',
        tooltip: 'Esta organización no ha registrado conexiones online todavía.',
        isLive: false,
      };
    }

    const elapsedMs = Date.now() - new Date(seenAt).getTime();
    const elapsedMins = Math.max(0, elapsedMs / 60000);
    const device = t.lastSeenDevice || t.offlineDeviceInfo || 'Navegador Web';

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

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam === 'banners' || tabParam === 'reports' || tabParam === 'tenants') {
      setActiveTab(tabParam);
    }
    const tenantParam = searchParams.get('tenantId');
    if (tenantParam) {
      setSelectedBannerTenantId(tenantParam);
    }
  }, [searchParams]);

  function handleSelectTab(tab: 'tenants' | 'banners' | 'reports') {
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
  const [paymentPhone, setPaymentPhone] = useState('');
  const [paymentDismissible, setPaymentDismissible] = useState(false);

  useEffect(() => {
    if (!bannerTenant) return;
    setBannerTitle(bannerTenant.notice?.title ?? '');
    setBannerMessage(bannerTenant.notice?.message ?? '');
    setBannerLevel(bannerTenant.notice?.level ?? 'warning');
    setBannerExpiresAt(bannerTenant.notice?.expiresAt ?? '');
    setBannerDismissible(bannerTenant.notice?.dismissible ?? false);
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
      unlockedByAdmin: !locked,
      wipeLocalData: false,
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

  async function togglePaymentBanner(t: Tenant) {
    if (!session) return;
    const nextState = !t.paymentBannerDeactivated;
    await saveTenant({
      ...t,
      paymentBannerDeactivated: nextState,
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    pushToCloud();
    toast(
      nextState
        ? `Banner insistente de cobro DESACTIVADO para «${t.name}».`
        : `Banner insistente de cobro ACTIVADO para «${t.name}».`,
      'info',
    );
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
    setBankHolderName('Christian Enao (ChrizDev)');
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
    toast('Cuenta bancaria guardada.', 'success');
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
  }

  async function handleApproveReport(report: PaymentReport) {
    if (!session) return;
    const tenant = (tenants ?? []).find((t) => t.tenantId === report.tenantId);
    const now = new Date().toISOString();
    const updatedReport: PaymentReport = {
      ...report,
      status: 'APPROVED',
      reviewedAt: now,
      reviewedBy: session.displayName,
      updatedAt: now,
      syncStatus: 'PENDING',
    };
    await db.payment_reports.put(updatedReport);

    if (tenant) {
      await saveTenant({
        ...tenant,
        paymentBannerDeactivated: true,
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
      },
    });

    pushToCloud();
    toast(`Pago de ${formatCOP(report.amount)} APROBADO. Se desactivó el banner de cobro para «${tenant?.name ?? 'la organización'}».`, 'success');
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
      </div>

      {activeTab === 'tenants' && (
        <>
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
          <TH>Conexión / Red</TH>
          <TH>Creada</TH>
          <TH>Estado</TH>
          <TH>Control cuenta</TH>
          <TH>Portal cliente</TH>
          <TH className="text-right">Acciones</TH>
        </THead>
        <TBody>
          {(tenants ?? []).map((t) => {
            const plan = planByTenant.get(t.tenantId);
            const invoice = plan ? computeMonthlyInvoice(plan) : null;
            const hasMora5Days = invoice?.isOverdueMoreThan5Days ?? false;
            return (
              <TR key={t.tenantId} className={t.appLocked || (hasMora5Days && !t.unlockedByAdmin) ? 'bg-red-50/60' : undefined}>
                <TD className="font-medium text-slate-800">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>{t.name}</span>
                      {t.appLocked && (
                        <span className="inline-flex items-center gap-1">
                          <Lock size={12} className="text-red-500" />
                          <Badge variant="danger">BLOQUEADA</Badge>
                        </span>
                      )}
                      {hasMora5Days && !t.appLocked && !t.unlockedByAdmin && (
                        <Badge variant="danger">MORA &gt; 5 DÍAS ({invoice?.maxDaysOverdue}d)</Badge>
                      )}
                      {t.unlockedByAdmin && !t.appLocked && (
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
                        <Badge variant="warning" className="animate-pulse">
                          ⏳ PURGA PENDIENTE DE CLIENTE
                        </Badge>
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
                <TD className="text-slate-600">{adminByTenant.get(t.tenantId) ?? '—'}</TD>
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
          })}
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
              </div>

              {/* Grupo 2: Seguridad y Purga Offline */}
              <div className="py-1">
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
                    setOfflineTargetId(t.tenantId);
                    setOfflinePaid(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors text-left cursor-pointer"
                >
                  <HardDriveDownload size={14} className="text-indigo-600 shrink-0" />
                  <span>{t.offlineLicense ? 'Ver enlace Edición Offline' : 'Emitir Edición Offline'}</span>
                </button>
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

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                        En blanco = Permanente hasta que lo retires.
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
                    onClick={handleSaveBannerNotice}
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
                                className="bg-emerald-600 hover:bg-emerald-500 text-white"
                                onClick={() => void handleApproveReport(r)}
                                title="Aprobar pago y desactivar aviso de cobro"
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

      <Dialog
        open={portalLinkTarget !== null}
        onClose={() => setPortalLinkTarget(null)}
        title={`Portal de clientes · ${portalLinkTarget?.name ?? ''}`}
        description="Comparte este enlace con los clientes de la organización para que consulten su crédito sin llamar."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input value={portalUrlFor(portalLinkTarget)} readOnly className="font-mono text-xs" />
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
            Este enlace es EXCLUSIVO para «{portalLinkTarget?.name}»: el cliente no verá otras
            organizaciones, evitando confusiones y registros duplicados. Los clientes solo pueden
            consultar y solicitar; no pueden modificar nada.
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
          {wipeTarget?.wipeConfirmedAt && (
            <div className="rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-800 border border-emerald-200">
              <p className="font-semibold">✓ Última purga confirmada por dispositivo cliente:</p>
              <p className="mt-0.5 font-mono">{formatDateTime(wipeTarget.wipeConfirmedAt)}</p>
              {wipeTarget.wipeConfirmedDevice && (
                <p className="text-[10px] text-emerald-600 truncate mt-0.5">
                  Dispositivo: {wipeTarget.wipeConfirmedDevice}
                </p>
              )}
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
            <Button variant="outline" disabled={wiping} onClick={() => setWipeTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={wiping}
              onClick={() => void handleWipeTenantLocalData()}
            >
              <DatabaseZap size={14} /> {wiping ? 'Purgando datos…' : wipeLockOrg ? 'Confirmar purga y bloquear cuenta' : 'Confirmar purga offline'}
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
                  className="bg-emerald-600 hover:bg-emerald-500 text-white"
                  onClick={() => {
                    const target = viewingReceipt;
                    setViewingReceipt(null);
                    void handleApproveReport(target);
                  }}
                >
                  <CheckCircle size={14} /> Aprobar Pago
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
                placeholder="Christian Enao (ChrizDev)"
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
      allow create: if hasValidTenantId() && request.resource.data.logId is string;
      allow update: if false;
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
      allow create: if hasValidTenantId() && request.resource.data.logId is string;
      allow update: if false;
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
    </div>
  );
}
