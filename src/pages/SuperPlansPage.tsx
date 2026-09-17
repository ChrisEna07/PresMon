import { useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowUpRight,
  BadgeCheck,
  Building2,
  CalendarPlus,
  Cloud,
  Copy,
  CreditCard,
  FileText,
  HandCoins,
  Megaphone,
  MessageCircle,
  Plus,
  Printer,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wallet,
} from 'lucide-react';
import type { AppPaymentMode, PlanInstallment, PlanServiceItem, ServicePlan, Tenant } from '../db/models';
import { db, nowISO } from '../db/db';
import { useAuth } from '../store/auth';
import { uid } from '../lib/id';
import { formatCOP, formatDateShort, todayStr, addDaysStr, nextMonthlyDue } from '../lib/format';
import { logAudit } from '../lib/auditLogger';
import { isSyncConfigured, runSync } from '../lib/sync/syncEngine';
import { openWhatsApp } from '../lib/share';
import { cn } from '../lib/format';
import { PageHeader } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, Select } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';

function pushToCloud(): void {
  void runSync().catch(() => undefined);
}

export const DEFAULT_PLAN_SERVICES: PlanServiceItem[] = [
  { id: 'srv_base', name: 'Software PresMon Base', description: 'Acceso a gestión de préstamos, cobros, prestatarios y simulador', price: 50000, active: true, billingCycle: 'MONTHLY' },
  { id: 'srv_cloud', name: 'Sincronización Cloud Multidispositivo', description: 'Base de datos en tiempo real en la nube, redundancia y respaldo continuo', price: 30000, active: true, billingCycle: 'MONTHLY' },
  { id: 'srv_socio', name: 'Módulo Socio (Cobrador en Ruta)', description: 'Módulo móvil liviano de cobro en calle con enlaces de único uso', price: 25000, active: false, billingCycle: 'MONTHLY' },
  { id: 'srv_audit', name: 'Auditoría Forense Avanzada', description: 'Registro inmutable de actividades y trazabilidad de operaciones', price: 20000, active: false, billingCycle: 'MONTHLY' },
  { id: 'srv_multiadmin', name: 'Multi-Sesión / Multi-Admin', description: 'Hasta 5 administradores y sesiones simultáneas permitidas', price: 35000, active: false, billingCycle: 'MONTHLY' },
  { id: 'srv_portal', name: 'Portal de Clientes Online', description: 'Acceso web para que los deudores consulten su estado de cuenta', price: 15000, active: false, billingCycle: 'MONTHLY' },
  { id: 'srv_support', name: 'Soporte Prioritario ChrizDev', description: 'Atención personalizada prioritaria vía WhatsApp y resolución ágil', price: 15000, active: false, billingCycle: 'MONTHLY' },
];

export default function SuperPlansPage() {
  const { session } = useAuth();
  const { toast } = useToast();
  const today = todayStr();

  const tenants = useLiveQuery(
    async () =>
      (await db.tenants.where('status').notEqual('DELETED').toArray()) as Tenant[],
    [],
  );
  const plans = useLiveQuery(async () => db.plans.toArray() as Promise<ServicePlan[]>, []);
  const pendingReportsCount = useLiveQuery(
    () => db.payment_reports.where('status').equals('PENDING').count(),
    [],
  );

  const [tenantId, setTenantId] = useState('');
  const [name, setName] = useState('');
  const [payMode, setPayMode] = useState<AppPaymentMode>('INSTALLMENTS');
  const [appTotal, setAppTotal] = useState('');
  const [cloudFee, setCloudFee] = useState('');
  const [cloudBillingDay, setCloudBillingDay] = useState('1');
  const [cloudIncluded, setCloudIncluded] = useState(true);
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<PlanInstallment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [genCount, setGenCount] = useState('4');
  const [genAmount, setGenAmount] = useState('');
  const [genStart, setGenStart] = useState(today);
  const [genEveryDays, setGenEveryDays] = useState('30');
  const [saving, setSaving] = useState(false);

  // Servicios y Beneficios del Plan
  const [servicesList, setServicesList] = useState<PlanServiceItem[]>(DEFAULT_PLAN_SERVICES);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [invoiceInstallmentTarget, setInvoiceInstallmentTarget] = useState<PlanInstallment | null>(null);
  const [invoiceCustomAmount, setInvoiceCustomAmount] = useState('');

  // Modal para abonar a cuota
  const [abonoModalOpen, setAbonoModalOpen] = useState(false);
  const [abonoTargetRow, setAbonoTargetRow] = useState<PlanInstallment | null>(null);
  const [abonoAmount, setAbonoAmount] = useState('');
  const [abonoGrace15Days, setAbonoGrace15Days] = useState(true);
  const [abonoNotes, setAbonoNotes] = useState('');
  const [savingAbono, setSavingAbono] = useState(false);

  const planByTenant = useMemo(() => {
    const map = new Map<string, ServicePlan>();
    (plans ?? []).forEach((p) => map.set(p.tenantId, p));
    return map;
  }, [plans]);

  const selectedTenant = useMemo(
    () => (tenants ?? []).find((t) => t.tenantId === tenantId),
    [tenants, tenantId],
  );

  const totalMonthlyServices = useMemo(
    () =>
      servicesList
        .filter((s) => s.active && s.billingCycle !== 'ONE_TIME')
        .reduce((sum, s) => sum + (Number(s.price) || 0), 0),
    [servicesList],
  );

  const totalOneTimeServices = useMemo(
    () =>
      servicesList
        .filter((s) => s.active && s.billingCycle === 'ONE_TIME')
        .reduce((sum, s) => sum + (Number(s.price) || 0), 0),
    [servicesList],
  );

  const totalServicesCost = useMemo(
    () => servicesList.filter((s) => s.active).reduce((sum, s) => sum + (Number(s.price) || 0), 0),
    [servicesList],
  );

  function applyServicesToCloudFee() {
    setCloudFee(String(totalMonthlyServices));
    setDirty(true);
    toast(`Mensualidad Cloud actualizada a ${formatCOP(totalMonthlyServices)} según servicios mensuales seleccionados.`, 'success');
  }

  function applyServicesToAppTotal() {
    setAppTotal(String(totalOneTimeServices));
    setDirty(true);
    toast(`Valor total de la app (contado) actualizado a ${formatCOP(totalOneTimeServices)} según servicios de pago único.`, 'success');
  }

  const existingPlanForOrg = tenantId ? planByTenant.get(tenantId) : undefined;
  const paidThroughDate = existingPlanForOrg?.cloudPaidThrough || '';
  const nextCloudDue = useMemo(
    () => nextMonthlyDue(Number(cloudBillingDay) || 1, paidThroughDate),
    [cloudBillingDay, paidThroughDate],
  );

  /** Marca el ciclo actual de la mensualidad cloud como pagado. */
  async function markCloudPeriodPaid() {
    if (!tenantId) return;
    if (!existingPlanForOrg) {
      toast('Guarda primero el plan con la mensualidad configurada.', 'info');
      return;
    }
    const due = nextMonthlyDue(Number(cloudBillingDay) || 1, existingPlanForOrg.cloudPaidThrough);
    await db.plans.put({
      ...existingPlanForOrg,
      cloudPaidThrough: due,
      updatedAt: nowISO(),
      syncStatus: 'PENDING',
    });
    pushToCloud();
    setDirty(true);
    toast(`Mensualidad registrada como pagada hasta el ${formatDateShort(due)}.`, 'success');
  }

  function selectOrg(id: string) {
    setTenantId(id);
    const existing = id ? planByTenant.get(id) : undefined;
    setName(existing?.name ?? '');
    setPayMode(existing?.appPaymentMode ?? 'INSTALLMENTS');
    setAppTotal(existing?.appTotalAmount != null ? String(existing.appTotalAmount) : '');
    setCloudFee(existing?.cloudMonthlyFee != null ? String(existing.cloudMonthlyFee) : '');
    setCloudBillingDay(String(Number(existing?.cloudBillingDay) || 1));
    setCloudIncluded(existing?.cloudServiceIncluded ?? true);
    setNotes(existing?.notes ?? '');
    setRows(
      existing
        ? [...existing.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        : [],
    );

    if (existing?.services && existing.services.length > 0) {
      const map = new Map(existing.services.map((s) => [s.id, s]));
      setServicesList(
        DEFAULT_PLAN_SERVICES.map((def) => {
          const saved = map.get(def.id);
          if (saved) {
            return {
              ...def,
              ...saved,
              price: Number(saved.price ?? saved.cost ?? def.price) || 0,
              active: saved.active ?? saved.included ?? def.active,
              billingCycle: saved.billingCycle ?? def.billingCycle ?? 'MONTHLY',
            };
          }
          return def;
        }),
      );
    } else {
      const t = (tenants ?? []).find((x) => x.tenantId === id);
      setServicesList(
        DEFAULT_PLAN_SERVICES.map((s) => {
          if (s.id === 'srv_socio') return { ...s, active: t?.socioModuleEnabled === true };
          if (s.id === 'srv_audit') return { ...s, active: t?.auditModuleEnabled === true };
          if (s.id === 'srv_multiadmin') return { ...s, active: t?.allowMultipleSessions === true };
          if (s.id === 'srv_portal') return { ...s, active: t?.clientPortalEnabled === true };
          return s;
        }),
      );
    }
    setDirty(false);
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        installmentId: uid(),
        dueDate: addDaysStr(today, prev.length * 30),
        amount: Number(genAmount) || 0,
        concept: `Cuota de la app (${prev.length + 1})`,
        status: 'PENDING',
      },
    ]);
    setDirty(true);
  }

  function generateSchedule() {
    const n = Math.max(1, Math.min(36, Number(genCount) || 0));
    const amount = Number(genAmount) || 0;
    const every = Math.max(1, Number(genEveryDays) || 30);
    if (!amount) {
      toast('Escribe el valor de cada cuota.', 'error');
      return;
    }
    const generated: PlanInstallment[] = Array.from({ length: n }, (_, i) => ({
      installmentId: uid(),
      dueDate: addDaysStr(genStart, i * every),
      amount,
      concept: `Cuota de la app (${i + 1}/${n})`,
      status: 'PENDING',
    }));
    setRows((prev) =>
      [...prev, ...generated].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    );
    setDirty(true);
    toast(`${n} cuotas generadas. Recuerda guardar los cambios.`, 'success');
  }

  function updateRow(id: string, patch: Partial<PlanInstallment>) {
    setRows((prev) => prev.map((r) => (r.installmentId === id ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.installmentId !== id));
    setDirty(true);
  }

  async function save() {
    if (!session || !tenantId) return;
    if (!name.trim()) {
      toast('Escribe el nombre del plan.', 'error');
      return;
    }
    if (payMode === 'INSTALLMENTS' && rows.length === 0) {
      toast('Agrega al menos una cuota de la app o genera un cronograma.', 'error');
      return;
    }
    if (payMode === 'FULL' && (!Number(appTotal) || Number(appTotal) <= 0)) {
      toast('Escribe el valor total de la app (pago de contado).', 'error');
      return;
    }
    setSaving(true);
    try {
      const tenant = await db.tenants.get(tenantId);
      const existing = planByTenant.get(tenantId);
      const record: ServicePlan = {
        planId: existing?.planId ?? uid(),
        tenantId,
        name: name.trim(),
        cloudServiceIncluded: cloudIncluded,
        appPaymentMode: payMode,
        appTotalAmount:
          payMode === 'FULL'
            ? Math.max(0, Math.round(Number(appTotal) || 0))
            : rows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
        cloudMonthlyFee: Math.max(0, Math.round(Number(cloudFee) || 0)),
        cloudBillingDay: Math.min(28, Math.max(1, Number(cloudBillingDay) || 1)),
        cloudPaidThrough: existing?.cloudPaidThrough,
        notes: notes.trim(),
        services: servicesList,
        installments: [...rows]
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((r) => ({
            ...r,
            amount: Math.max(0, Math.round(Number(r.amount) || 0)),
          })),
        createdAt: existing?.createdAt ?? nowISO(),
        updatedAt: nowISO(),
        syncStatus: 'PENDING',
      };
      await db.plans.put(record);

      // Sincronizar beneficios y límites de administradores en la organización
      if (tenant) {
        const socioActive = servicesList.some((s) => s.id === 'srv_socio' && s.active);
        const auditActive = servicesList.some((s) => s.id === 'srv_audit' && s.active);
        const multiadminActive = servicesList.some((s) => s.id === 'srv_multiadmin' && s.active);
        const portalActive = servicesList.some((s) => s.id === 'srv_portal' && s.active);

        const updatedTenant: Tenant = {
          ...tenant,
          socioModuleEnabled: socioActive,
          auditModuleEnabled: auditActive,
          allowMultipleSessions: multiadminActive,
          maxAdmins: multiadminActive ? Math.max(5, tenant.maxAdmins || 5) : 1,
          clientPortalEnabled: portalActive,
          updatedAt: nowISO(),
          syncStatus: 'PENDING',
        };
        await db.tenants.put(updatedTenant);
      }

      await logAudit({
        tenantId: '',
        action: 'PLAN_UPDATED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: record.planId,
        entityType: 'plans',
        payloadSnapshot: {
          organizacion: tenant?.name ?? tenantId,
          plan: record.name,
          modoPagoApp: record.appPaymentMode === 'FULL' ? 'Contado' : 'Por cuotas',
          valorApp: record.appTotalAmount,
          cobroCloudIncluidoEnFactura: record.cloudServiceIncluded,
          mensualidadCloud: record.cloudMonthlyFee,
          diaCobroCloud: record.cloudBillingDay,
          serviciosActivos: servicesList.filter((s) => s.active).map((s) => s.name),
          pagadaHasta: record.cloudPaidThrough ?? '—',
          cuotasApp: record.installments.length,
        },
      });
      setDirty(false);
      pushToCloud();
      toast('Plan guardado y beneficios sincronizados con la organización.', 'success');
    } finally {
      setSaving(false);
    }
  }

  function handleOpenAbonoModal(r: PlanInstallment) {
    const paid = Number(r.paidAmount) || 0;
    const remaining = Math.max(0, (Number(r.amount) || 0) - paid);
    setAbonoTargetRow(r);
    setAbonoAmount(remaining > 0 ? String(Math.round(remaining / 2)) : '');
    setAbonoGrace15Days(true);
    setAbonoNotes('');
    setAbonoModalOpen(true);
  }

  async function handleConfirmAbono() {
    if (!session || !tenantId || !abonoTargetRow) return;
    const amountVal = Math.round(Number(abonoAmount) || 0);
    if (!amountVal || amountVal <= 0) {
      toast('Ingresa un monto válido para el abono.', 'error');
      return;
    }
    const currentPaid = Number(abonoTargetRow.paidAmount) || 0;
    const currentDue = Number(abonoTargetRow.amount) || 0;
    const newPaidTotal = currentPaid + amountVal;
    const remaining = Math.max(0, currentDue - newPaidTotal);
    const isFullyPaid = remaining === 0 || newPaidTotal >= currentDue;
    const graceUntil = addDaysStr(today, 15);

    setSavingAbono(true);
    try {
      const now = nowISO();
      // Actualizar fila en estado local
      const updatedRows = rows.map((r) =>
        r.installmentId === abonoTargetRow.installmentId
          ? {
              ...r,
              paidAmount: isFullyPaid ? currentDue : newPaidTotal,
              status: (isFullyPaid ? 'PAID' : 'PENDING') as PlanInstallment['status'],
              paidAt: isFullyPaid ? now : r.paidAt,
              lastAbonoAt: now,
              graceUntil: isFullyPaid ? undefined : abonoGrace15Days ? graceUntil : undefined,
            }
          : r,
      );
      setRows(updatedRows);

      // Guardar plan directamente en Dexie y preparar sync
      const plan = existingPlanForOrg || {
        planId: uid(),
        tenantId,
        name: name.trim() || 'Plan de Servicio',
        cloudServiceIncluded: cloudIncluded,
        appPaymentMode: payMode,
        appTotalAmount: Number(appTotal) || 0,
        cloudMonthlyFee: Number(cloudFee) || 0,
        cloudBillingDay: Number(cloudBillingDay) || 1,
        installments: [],
        createdAt: now,
        updatedAt: now,
        syncStatus: 'PENDING' as const,
      };

      const updatedPlan: ServicePlan = {
        ...plan,
        installments: updatedRows.map((r) => ({
          ...r,
          amount: Math.max(0, Math.round(Number(r.amount) || 0)),
        })),
        updatedAt: now,
        syncStatus: 'PENDING',
      };
      await db.plans.put(updatedPlan);

      // Actualizar tenant con el activeAbono y desbloqueo durante la vigencia de 15 días
      const tenant = await db.tenants.get(tenantId);
      if (tenant) {
        if (!isFullyPaid && abonoGrace15Days) {
          await db.tenants.put({
            ...tenant,
            activeAbono: {
              abonoId: uid(),
              installmentId: abonoTargetRow.installmentId,
              concept: abonoTargetRow.concept,
              amountPaid: amountVal,
              remainingAmount: remaining,
              totalDue: currentDue,
              abonoDate: today,
              graceUntil,
              active: true,
              notes: abonoNotes.trim() || undefined,
            },
            unlockedByAdmin: true, // otorga acceso durante los 15 días de vigencia
            updatedAt: now,
            syncStatus: 'PENDING',
          });
        } else if (isFullyPaid) {
          await db.tenants.put({
            ...tenant,
            activeAbono: undefined,
            updatedAt: now,
            syncStatus: 'PENDING',
          });
        }
      }

      await logAudit({
        tenantId,
        action: 'PLAN_INSTALLMENT_ABONO',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: abonoTargetRow.installmentId,
        entityType: 'plans',
        payloadSnapshot: {
          organizacion: tenant?.name ?? tenantId,
          cuota: abonoTargetRow.concept,
          abonoAplicado: amountVal,
          saldoRestante: remaining,
          totalCuota: currentDue,
          vigencia15DiasHasta: abonoGrace15Days ? graceUntil : 'Sin vigencia',
          cuotaPagadaTotal: isFullyPaid,
          notas: abonoNotes.trim() || undefined,
        },
      });

      pushToCloud();
      setAbonoModalOpen(false);
      setAbonoTargetRow(null);
      setDirty(false);
      toast(
        isFullyPaid
          ? `¡Cuota saldada al 100%! (${formatCOP(currentDue)})`
          : `Abono de ${formatCOP(amountVal)} aplicado. Restan ${formatCOP(remaining)} con 15 días de vigencia hasta el ${formatDateShort(graceUntil)}.`,
        'success',
      );
    } catch (err) {
      toast('Error al aplicar el abono: ' + String(err), 'error');
    } finally {
      setSavingAbono(false);
    }
  }

  const summary = useMemo(() => {
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const paid = rows.reduce((s, r) => {
      if (r.status === 'PAID') return s + (Number(r.amount) || 0);
      return s + (Number(r.paidAmount) || 0);
    }, 0);
    const pendingTotal = Math.max(0, total - paid);
    const nextPending = rows.find(
      (r) => r.status === 'PENDING' && (Number(r.amount) || 0) > (Number(r.paidAmount) || 0),
    );
    const appTotalNum = Number(appTotal) || 0;
    const cloudFeeNum = Number(cloudFee) || 0;
    const nextPendingAmount = nextPending
      ? Math.max(0, (Number(nextPending.amount) || 0) - (Number(nextPending.paidAmount) || 0))
      : 0;
    const monthlyInvoiceEst = (cloudIncluded ? cloudFeeNum : 0) + nextPendingAmount;
    return {
      total,
      paid,
      pendingTotal,
      nextPending,
      appTotalNum,
      cloudFeeNum,
      monthlyInvoiceEst,
      nextPendingAmount,
    };
  }, [rows, appTotal, cloudFee, cloudIncluded]);

  return (
    <div>
      <PageHeader
        title="Planes de servicio"
        description="Cobros de las organizaciones a ChrizDev · cuotas personalizables por cliente"
      />

      <div className="flex items-center gap-2 border-b border-slate-200 mt-4 mb-6 overflow-x-auto">
        <NavLink
          to="/super/plans"
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-lg transition-all whitespace-nowrap"
        >
          <Wallet size={16} /> Planes de Servicio
        </NavLink>
        <NavLink
          to="/super-admin?tab=banners"
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition-all whitespace-nowrap"
        >
          <Megaphone size={16} /> Banners, Avisos y Cobros
        </NavLink>
        <NavLink
          to="/super-admin?tab=reports"
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition-all whitespace-nowrap"
        >
          <CreditCard size={16} /> Comprobantes de Pago
          {(pendingReportsCount ?? 0) > 0 && (
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white animate-pulse">
              {pendingReportsCount}
            </span>
          )}
        </NavLink>
        <NavLink
          to="/super-admin"
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition-all whitespace-nowrap"
        >
          <ShieldCheck size={16} /> Organizaciones
        </NavLink>
      </div>

      <Card className="mb-4">
        <CardContent className="py-4">
          <Label>Organización</Label>
          <Select
            value={tenantId}
            onChange={(e) => selectOrg(e.target.value)}
            className="max-w-md"
          >
            <option value="">— Selecciona una organización —</option>
            {(tenants ?? []).map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.name}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      {!tenantId ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-400">
          Selecciona una organización para definir o ajustar su plan de pagos.
        </p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                Pago de la app
              </p>
              <p className="mt-1 font-bold text-slate-800">
                {payMode === 'FULL' ? formatCOP(summary.appTotalNum) : formatCOP(summary.total)}
              </p>
              <p className="mt-0.5 text-[10px] font-medium text-slate-400">
                {payMode === 'FULL' ? 'De contado' : `Por cuotas (${rows.length})`}
              </p>
            </div>
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
              <p className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-sky-600 uppercase">
                <Cloud size={12} /> Mensualidad cloud
              </p>
              <p className="mt-1 font-bold text-sky-700">{formatCOP(summary.cloudFeeNum)}</p>
              <p className="mt-0.5 text-[10px] font-medium text-sky-500">
                {cloudIncluded ? '✓ Incluida en factura' : '✕ No incluida'} · día{' '}
                {Number(cloudBillingDay) || 1}
              </p>
            </div>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
              <p className="text-[11px] font-semibold tracking-wide text-indigo-600 uppercase">
                Factura mensual est.
              </p>
              <p className="mt-1 font-bold text-indigo-700">
                {formatCOP(summary.monthlyInvoiceEst)}
              </p>
              <p className="mt-0.5 text-[10px] font-medium text-indigo-500">
                {cloudIncluded
                  ? `Cloud (${formatCOP(summary.cloudFeeNum)}) + Cuota (${formatCOP(summary.nextPendingAmount)})`
                  : `Solo cuota app (${formatCOP(summary.nextPendingAmount)})`}
              </p>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-[11px] font-semibold tracking-wide text-emerald-600 uppercase">Pagado</p>
              <p className="mt-1 font-bold text-emerald-700">{formatCOP(summary.paid)}</p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-[11px] font-semibold tracking-wide text-amber-600 uppercase">Por cobrar</p>
              <p className="mt-1 font-bold text-amber-700">{formatCOP(summary.pendingTotal)}</p>
            </div>
          </div>

          {/* Accesos directos a Banners y Cuentas para esta organización */}
          <div className="mb-4 rounded-xl border border-sky-200 bg-gradient-to-r from-sky-50 via-white to-indigo-50 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
            <div>
              <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Megaphone size={14} className="text-sky-600" /> Banners, Cuentas Bancarias y Comprobantes
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Configura los avisos en pantalla, el WhatsApp de cobros, las cuentas para depósito directo o revisa comprobantes de esta organización.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <NavLink
                to={`/super-admin?tab=banners&tenantId=${tenantId}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-sky-300 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100/60 shadow-xs transition-colors"
              >
                <Megaphone size={13} /> Gestionar Banners y Cuentas <ArrowUpRight size={13} />
              </NavLink>
              <NavLink
                to="/super-admin?tab=reports"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 shadow-xs transition-colors"
              >
                <CreditCard size={13} /> Ver Comprobantes <ArrowUpRight size={13} />
              </NavLink>
            </div>
          </div>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Detalles del plan</CardTitle>
              <CardDescription>
                El cliente verá un aviso automático cuando una cuota esté próxima o vencida.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label>Nombre del plan</Label>
                  <Input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Ej: App + mensualidad cloud"
                  />
                </div>
                <div>
                  <Label>Notas internas</Label>
                  <Input
                    value={notes}
                    onChange={(e) => {
                      setNotes(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Acuerdos con el cliente…"
                  />
                </div>
              </div>
              <div>
                <Label>Modo de pago de la app</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 sm:max-w-md">
                  <button
                    type="button"
                    onClick={() => {
                      setPayMode('FULL');
                      setDirty(true);
                    }}
                    className={`cursor-pointer rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                      payMode === 'FULL'
                        ? 'bg-white text-emerald-700 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <BadgeCheck size={12} className="mr-1 inline" /> Pagada de contado
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPayMode('INSTALLMENTS');
                      setDirty(true);
                    }}
                    className={`cursor-pointer rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                      payMode === 'INSTALLMENTS'
                        ? 'bg-white text-emerald-700 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <CalendarPlus size={12} className="mr-1 inline" /> Por cuotas
                  </button>
                </div>
              </div>
              {payMode === 'FULL' && (
                <div className="sm:max-w-md">
                  <Label>Valor total de la app (contado)</Label>
                  <Input
                    value={appTotal}
                    onChange={(e) => {
                      setAppTotal(e.target.value.replace(/\D/g, ''));
                      setDirty(true);
                    }}
                    inputMode="numeric"
                    placeholder="Ej: 1500000"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Sin cronograma de cuotas: el cliente paga la licencia completa una sola vez.
                  </p>
                </div>
              )}
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 sm:max-w-md">
                <div className="mb-3 flex items-center justify-between gap-2 border-b border-sky-200 pb-2.5">
                  <div>
                    <span className="flex items-center gap-1.5 text-xs font-bold text-sky-900">
                      <Cloud size={14} className="text-sky-600" /> Cobro Cloud en factura mensual
                    </span>
                    <p className="text-[10px] text-sky-700">
                      Suma la mensualidad al total exigible del mes y a los banners.
                    </p>
                  </div>
                  <Switch
                    checked={cloudIncluded}
                    onChange={() => {
                      setCloudIncluded(!cloudIncluded);
                      setDirty(true);
                    }}
                    label="Cobro Cloud"
                  />
                </div>
                <Label>Valor mensualidad de servicios cloud</Label>
                <Input
                  value={cloudFee}
                  onChange={(e) => {
                    setCloudFee(e.target.value.replace(/\D/g, ''));
                    setDirty(true);
                  }}
                  inputMode="numeric"
                  placeholder="Ej: 30000 (0 = sin cobro mensual)"
                />
                <div className="mt-2 grid grid-cols-2 items-end gap-2">
                  <div>
                    <Label>Día de pago mensual</Label>
                    <Select
                      value={cloudBillingDay}
                      onChange={(e) => {
                        setCloudBillingDay(e.target.value);
                        setDirty(true);
                      }}
                    >
                      {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                        <option key={d} value={d}>
                          Día {d} de cada mes
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => void markCloudPeriodPaid()}
                    disabled={!existingPlanForOrg}
                  >
                    <BadgeCheck size={14} /> Registrar pago del mes
                  </Button>
                </div>
                {nextCloudDue && (
                  <p className="mt-1.5 text-[11px] font-semibold text-sky-800">
                    Próximo vencimiento: {formatDateShort(nextCloudDue)}
                    {paidThroughDate ? ` · pagada hasta ${formatDateShort(paidThroughDate)}` : ''}
                  </p>
                )}
                <p className="mt-1 text-[11px] leading-relaxed text-sky-700">
                  Cobro recurrente mensual por nube, respaldos y soporte. Es{' '}
                  <strong>independiente del pago de la app</strong>: se cobra aparte aunque la app
                  esté pagada de contado o financiada.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Matriz de Servicios del Plan con Precios y Cálculo Dinámico */}
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Wallet size={16} className="text-emerald-600" /> Matriz de Servicios y Módulos Adicionales
                  </CardTitle>
                  <CardDescription>
                    Selecciona los beneficios incluidos en el plan. Se sincronizarán automáticamente con las funciones activas de la organización.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs text-emerald-800 border-emerald-300 hover:bg-emerald-50 cursor-pointer"
                    onClick={() => {
                      setInvoiceInstallmentTarget(null);
                      const total = cloudIncluded ? Number(cloudFee) || totalServicesCost : totalServicesCost;
                      setInvoiceCustomAmount(String(total));
                      setInvoiceModalOpen(true);
                    }}
                  >
                    <FileText size={14} /> Factura Digital
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {servicesList.map((srv, idx) => (
                  <div
                    key={srv.id}
                    onClick={() => {
                      const updated = [...servicesList];
                      updated[idx] = { ...srv, active: !srv.active };
                      setServicesList(updated);
                      setDirty(true);
                    }}
                    className={cn(
                      'flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer select-none gap-2',
                      srv.active
                        ? 'border-emerald-500/60 bg-emerald-50/50 shadow-xs'
                        : 'border-slate-200 bg-white hover:border-slate-300 opacity-75',
                    )}
                  >
                    <div className="flex items-start gap-2.5 min-w-0 flex-1 pr-1">
                      <input
                        type="checkbox"
                        checked={srv.active}
                        onChange={() => {}} // handled by parent div
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer shrink-0"
                      />
                      <div className="min-w-0">
                        <p className={cn('text-xs font-bold leading-tight', srv.active ? 'text-slate-900' : 'text-slate-600')}>
                          {srv.name}
                        </p>
                        {srv.description && (
                          <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                            {srv.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <div
                      className="flex flex-col items-end shrink-0 pl-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-1 bg-white rounded-lg border border-slate-300 px-2 py-1 shadow-2xs focus-within:border-emerald-500 focus-within:ring-1 focus-within:ring-emerald-500">
                        <span className="text-[11px] font-bold text-slate-400">$</span>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={srv.price ?? 0}
                          onChange={(e) => {
                            const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                            const updated = [...servicesList];
                            updated[idx] = { ...srv, price: val };
                            setServicesList(updated);
                            setDirty(true);
                          }}
                          className="w-20 text-right text-xs font-bold text-slate-900 focus:outline-none bg-transparent"
                          title="Precio editable"
                        />
                      </div>

                      {/* Selector de Modalidad: Mensual vs Pago Único */}
                      <div className="flex items-center gap-1 mt-1.5 bg-slate-100 p-0.5 rounded-md border border-slate-200">
                        <button
                          type="button"
                          onClick={() => {
                            const updated = [...servicesList];
                            updated[idx] = { ...srv, billingCycle: 'MONTHLY' };
                            setServicesList(updated);
                            setDirty(true);
                          }}
                          className={cn(
                            'px-1.5 py-0.5 text-[9px] font-bold rounded transition-colors',
                            srv.billingCycle !== 'ONE_TIME'
                              ? 'bg-emerald-600 text-white shadow-2xs'
                              : 'text-slate-500 hover:text-slate-800',
                          )}
                          title="Cobro recurrente mensual"
                        >
                          /mes
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const updated = [...servicesList];
                            updated[idx] = { ...srv, billingCycle: 'ONE_TIME' };
                            setServicesList(updated);
                            setDirty(true);
                          }}
                          className={cn(
                            'px-1.5 py-0.5 text-[9px] font-bold rounded transition-colors',
                            srv.billingCycle === 'ONE_TIME'
                              ? 'bg-indigo-600 text-white shadow-2xs'
                              : 'text-slate-500 hover:text-slate-800',
                          )}
                          title="Pago único (Licencia permanente o setup inicial)"
                        >
                          Único
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Barra de totalización de servicios y aplicación */}
              <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-900 text-white">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Recurrente Mensual:</p>
                    <p className="text-base font-black text-emerald-400">
                      {formatCOP(totalMonthlyServices)} <span className="text-xs text-slate-400 font-normal">COP/mes</span>
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Pago Único / Licencia:</p>
                    <p className="text-base font-black text-indigo-300">
                      {formatCOP(totalOneTimeServices)} <span className="text-xs text-slate-400 font-normal">COP</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs gap-1.5 flex-1 sm:flex-initial cursor-pointer"
                    onClick={applyServicesToCloudFee}
                  >
                    <Sparkles size={14} /> Aplicar a Mensualidad Cloud
                  </Button>
                  {totalOneTimeServices > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="bg-indigo-950/80 border-indigo-400/60 hover:bg-indigo-900 text-indigo-100 font-bold text-xs gap-1.5 flex-1 sm:flex-initial cursor-pointer"
                      onClick={applyServicesToAppTotal}
                    >
                      <Sparkles size={14} /> Aplicar a Licencia Contado
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {payMode === 'FULL' ? (
            <div className="mb-4 space-y-3">
              <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-700">
                <BadgeCheck size={16} className="mr-1 inline" /> App pagada de contado por{' '}
                <strong>{formatCOP(summary.appTotalNum)}</strong>. La mensualidad cloud{' '}
                {summary.cloudFeeNum > 0
                  ? `de ${formatCOP(summary.cloudFeeNum)} se cobra aparte cada mes.`
                  : 'no aplica cobro mensual.'}
              </p>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                  <Save size={14} /> {saving ? 'Guardando…' : dirty ? 'Guardar plan' : 'Sin cambios'}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarPlus size={16} /> Generador de cronograma
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-5">
                    <div>
                      <Label>Cuotas</Label>
                      <Input value={genCount} onChange={(e) => setGenCount(e.target.value)} inputMode="numeric" />
                    </div>
                    <div>
                      <Label>Valor c/u</Label>
                      <Input value={genAmount} onChange={(e) => setGenAmount(e.target.value)} inputMode="numeric" placeholder="150000" />
                    </div>
                    <div>
                      <Label>Desde</Label>
                      <Input type="date" value={genStart} onChange={(e) => setGenStart(e.target.value)} />
                    </div>
                    <div>
                      <Label>Cada (días)</Label>
                      <Select value={genEveryDays} onChange={(e) => setGenEveryDays(e.target.value)}>
                        <option value="7">7 (semanal)</option>
                        <option value="15">15 (quincenal)</option>
                        <option value="30">30 (mensual)</option>
                        <option value="60">60 (bimestral)</option>
                        <option value="90">90 (trimestral)</option>
                      </Select>
                    </div>
                    <Button variant="secondary" onClick={generateSchedule}>
                      Generar cuotas
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-slate-700">Cuotas de la app ({rows.length})</h2>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={addRow}>
                    <Plus size={14} /> Cuota manual
                  </Button>
                  <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                    <Save size={14} /> {saving ? 'Guardando…' : dirty ? 'Guardar plan' : 'Sin cambios'}
                  </Button>
                </div>
              </div>

              {rows.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400">
                  Usa el generador o agrega cuotas manualmente.
                </p>
              ) : (
                <TableWrap>
                  <THead>
                    <TR>
                      <TH>Vence</TH>
                      <TH>Concepto</TH>
                      <TH>Valor Cuota</TH>
                      <TH>Abonado / Saldo</TH>
                      <TH>Estado</TH>
                      <TH className="text-right">Acciones</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((r) => {
                      const paid = Number(r.paidAmount) || 0;
                      const remaining = Math.max(0, (Number(r.amount) || 0) - paid);
                      const isPaid = r.status === 'PAID';
                      return (
                        <TR key={r.installmentId}>
                          <TD>
                            <Input
                              type="date"
                              value={r.dueDate}
                              onChange={(e) => updateRow(r.installmentId, { dueDate: e.target.value })}
                              className="w-36"
                            />
                          </TD>
                          <TD>
                            <Input
                              value={r.concept}
                              onChange={(e) => updateRow(r.installmentId, { concept: e.target.value })}
                              className="min-w-36"
                            />
                          </TD>
                          <TD>
                            <Input
                              value={String(r.amount)}
                              onChange={(e) =>
                                updateRow(r.installmentId, { amount: Number(e.target.value) })
                              }
                              inputMode="numeric"
                              className="w-28"
                            />
                          </TD>
                          <TD>
                            {isPaid ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md">
                                Pagado 100% ({formatCOP(r.amount)})
                              </span>
                            ) : paid > 0 ? (
                              <div className="text-xs space-y-0.5">
                                <span className="font-semibold text-emerald-700 block">
                                  Abonado: {formatCOP(paid)}
                                </span>
                                <span className="font-bold text-amber-800 block">
                                  Falta: {formatCOP(remaining)}
                                </span>
                                {r.graceUntil && (
                                  <span className="text-[10px] text-slate-500 block">
                                    Vigencia 15d: {formatDateShort(r.graceUntil)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">Sin abonos</span>
                            )}
                          </TD>
                          <TD>
                            <Switch
                              checked={r.status === 'PAID'}
                              label="Pagada"
                              onChange={() =>
                                updateRow(r.installmentId, {
                                  status: r.status === 'PAID' ? 'PENDING' : 'PAID',
                                  paidAt: r.status === 'PAID' ? undefined : nowISO(),
                                  paidAmount: r.status === 'PAID' ? 0 : r.amount,
                                })
                              }
                            />
                          </TD>
                          <TD className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setInvoiceInstallmentTarget(r);
                                  const total = Number(r.amount) || 0;
                                  const paid = Number(r.paidAmount) || 0;
                                  const remaining = Math.max(0, total - paid);
                                  setInvoiceCustomAmount(String(remaining > 0 ? remaining : total));
                                  setInvoiceModalOpen(true);
                                }}
                                title="Ver o emitir factura digital de esta cuota"
                                className="text-slate-600 hover:text-slate-900 border-slate-300 hover:bg-slate-50 text-xs px-2 h-8 gap-1 cursor-pointer"
                              >
                                <FileText size={13} /> Factura
                              </Button>
                              {!isPaid && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleOpenAbonoModal(r)}
                                  title="Registrar abono a esta cuota"
                                  className="text-emerald-700 hover:text-emerald-800 border-emerald-300 hover:bg-emerald-50 text-xs px-2.5 h-8 gap-1 cursor-pointer"
                                >
                                  <HandCoins size={13} /> Abonar
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeRow(r.installmentId)}
                                title="Quitar cuota"
                              >
                                <Trash2 size={14} className="text-red-500" />
                              </Button>
                            </div>
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </TableWrap>
              )}
            </>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            {(tenants ?? []).filter((t) => planByTenant.has(t.tenantId)).length > 0 && (
              <>
                <Badge variant="info">
                  <Wallet size={12} /> {planByTenant.size} organización(es) con plan definido
                </Badge>
                <Badge variant="success">
                  <BadgeCheck size={12} /> Los avisos de cobro aparecen solos en su panel
                </Badge>
              </>
            )}
          </div>
        </>
      )}

      {/* Modal para Registrar Abono a Cuota */}
      {abonoModalOpen && abonoTargetRow && (
        <Dialog
          open={abonoModalOpen}
          onClose={() => {
            if (!savingAbono) {
              setAbonoModalOpen(false);
              setAbonoTargetRow(null);
            }
          }}
          title="Registrar Abono a Cuota"
          description={`Abonar a: ${abonoTargetRow.concept}`}
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-500">Valor total cuota:</span>
                <span className="font-bold text-slate-800">{formatCOP(abonoTargetRow.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Ya abonado previamente:</span>
                <span className="font-semibold text-emerald-700">
                  {formatCOP(Number(abonoTargetRow.paidAmount) || 0)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1">
                <span className="font-semibold text-slate-700">Saldo pendiente actual:</span>
                <span className="font-bold text-amber-700">
                  {formatCOP(
                    Math.max(
                      0,
                      (Number(abonoTargetRow.amount) || 0) - (Number(abonoTargetRow.paidAmount) || 0),
                    ),
                  )}
                </span>
              </div>
            </div>

            <div>
              <Label>Monto a abonar ahora (COP)</Label>
              <Input
                type="number"
                min={1}
                value={abonoAmount}
                onChange={(e) => setAbonoAmount(e.target.value)}
                placeholder="Ej: 50000"
                autoFocus
              />
              {/* Botones de atajo rápido */}
              {(() => {
                const pend = Math.max(
                  0,
                  (Number(abonoTargetRow.amount) || 0) - (Number(abonoTargetRow.paidAmount) || 0),
                );
                return (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setAbonoAmount(String(Math.round(pend * 0.25)))}
                      className="cursor-pointer rounded-lg bg-slate-100 hover:bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700"
                    >
                      25% ({formatCOP(pend * 0.25)})
                    </button>
                    <button
                      type="button"
                      onClick={() => setAbonoAmount(String(Math.round(pend * 0.5)))}
                      className="cursor-pointer rounded-lg bg-slate-100 hover:bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700"
                    >
                      50% ({formatCOP(pend * 0.5)})
                    </button>
                    <button
                      type="button"
                      onClick={() => setAbonoAmount(String(pend))}
                      className="cursor-pointer rounded-lg bg-emerald-100 hover:bg-emerald-200 px-2 py-1 text-[11px] font-bold text-emerald-800"
                    >
                      Pagar resto ({formatCOP(pend)})
                    </button>
                  </div>
                );
              })()}
            </div>

            {/* Switch de vigencia de 15 días */}
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
              <Switch
                checked={abonoGrace15Days}
                label="Otorgar aviso y vigencia de 15 días para pagar el saldo restante"
                onChange={() => setAbonoGrace15Days((prev) => !prev)}
              />
              <p className="mt-1 text-[11px] text-amber-800 leading-relaxed">
                Al activar esta opción, en el panel de la organización aparecerá el banner automático
                con el saldo que le falta por pagar y la fecha límite de 15 días. Si no cancela el
                saldo en ese periodo, el sistema advertirá y desactivará la cuenta.
              </p>
            </div>

            <div>
              <Label>Notas o referencia del abono (opcional)</Label>
              <Input
                value={abonoNotes}
                onChange={(e) => setAbonoNotes(e.target.value)}
                placeholder="Ej. Transferencia Nequi ref: 894372"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setAbonoModalOpen(false);
                  setAbonoTargetRow(null);
                }}
                disabled={savingAbono}
              >
                Cancelar
              </Button>
              <Button
                onClick={() => void handleConfirmAbono()}
                disabled={savingAbono}
                className="bg-emerald-600 hover:bg-emerald-500 cursor-pointer"
              >
                <HandCoins size={14} /> {savingAbono ? 'Aplicando…' : 'Aplicar Abono'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Modal de Factura Digital y Envío WhatsApp */}
      <Dialog
        open={invoiceModalOpen}
        onClose={() => setInvoiceModalOpen(false)}
        title="Factura Digital de Cobro"
      >
        {selectedTenant && (() => {
          const invoiceNumber = `FAC-${selectedTenant.tenantId.slice(0, 6).toUpperCase()}-${today.replace(/-/g, '')}`;
          const activeServices = servicesList.filter((s) => s.active);

          const isInstallment = !!invoiceInstallmentTarget;
          const instAmount = isInstallment ? (Number(invoiceInstallmentTarget.amount) || 0) : 0;
          const instPaidAmount = isInstallment ? (Number(invoiceInstallmentTarget.paidAmount) || 0) : 0;
          const instRemainingBalance = Math.max(0, instAmount - instPaidAmount);

          // Monto sugerido por defecto: si es cuota con abono, el saldo restante
          const defaultDue = isInstallment
            ? (instPaidAmount > 0 ? instRemainingBalance : instAmount)
            : (cloudIncluded ? Number(cloudFee) || totalServicesCost : totalServicesCost);

          const totalToPay = invoiceCustomAmount !== ''
            ? Math.max(0, Number(invoiceCustomAmount) || 0)
            : defaultDue;

          // Detalle textual para WhatsApp
          let detalleWhatsApp = '';
          if (isInstallment) {
            detalleWhatsApp = `• Concepto: ${invoiceInstallmentTarget.concept}\n` +
              `• Valor pactado de la cuota: ${formatCOP(instAmount)}\n`;
            if (instPaidAmount > 0) {
              detalleWhatsApp += `• Abono registrado previamente: - ${formatCOP(instPaidAmount)}\n` +
                `• Saldo pendiente antes de este cobro: ${formatCOP(instRemainingBalance)}\n`;
            }
            if (totalToPay !== (instPaidAmount > 0 ? instRemainingBalance : instAmount)) {
              detalleWhatsApp += `• Monto a facturar en esta transacción: ${formatCOP(totalToPay)}\n`;
              if (totalToPay < instRemainingBalance) {
                detalleWhatsApp += `• Saldo restante tras este pago: ${formatCOP(instRemainingBalance - totalToPay)}\n`;
              }
            }
          } else {
            detalleWhatsApp = activeServices.length > 0
              ? activeServices
                  .map(
                    (s) =>
                      `• ${s.name} [${s.billingCycle === 'ONE_TIME' ? 'Pago Único' : 'Mensual'}]: ${formatCOP(s.price || 0)}`,
                  )
                  .join('\n')
              : `• Mensualidad general de servicios Cloud: ${formatCOP(totalToPay)}`;
            if (totalMonthlyServices > 0 && totalOneTimeServices > 0) {
              detalleWhatsApp += `\n  - Subtotal Mensual: ${formatCOP(totalMonthlyServices)}\n  - Subtotal Pago Único: ${formatCOP(totalOneTimeServices)}`;
            }
          }

          const invoiceTextWhatsApp = `📄 *PRESMON - CUENTA DE COBRO*\n` +
            `----------------------------------------\n` +
            `*Factura:* ${invoiceNumber}\n` +
            `*Cliente:* ${selectedTenant.name}\n` +
            `*Fecha de emisión:* ${today}\n` +
            `*Vencimiento:* ${invoiceInstallmentTarget?.dueDate || nextCloudDue || today}\n` +
            `----------------------------------------\n` +
            `*DETALLE DE COBRO:*\n` +
            detalleWhatsApp + `\n` +
            `----------------------------------------\n` +
            `*TOTAL A PAGAR: ${formatCOP(totalToPay)} COP*\n\n` +
            `*MEDIO DE PAGO DISPONIBLE:*\n` +
            `• Nequi: 318 351 7802\n` +
            `• Titular: Christian Romero\n` +
            `----------------------------------------\n` +
            `_Favor enviar el comprobante de pago por este medio o adjuntarlo en la aplicación PresMon._`;

          return (
            <div className="space-y-4">
              {/* Ajuste manual del monto de la factura para transacciones exactas */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-bold text-slate-800">
                    {isInstallment ? 'Monto a cobrar en esta factura:' : 'Monto total a facturar:'}
                  </Label>
                  <span className="text-[11px] text-slate-500 font-medium">Editable para transacciones exactas</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-600">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="1000"
                    value={invoiceCustomAmount !== '' ? invoiceCustomAmount : String(defaultDue)}
                    onChange={(e) => setInvoiceCustomAmount(e.target.value)}
                    className="h-8 text-sm font-bold text-slate-900 bg-white"
                    placeholder="Monto a cobrar"
                  />
                  {isInstallment && instPaidAmount > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-[11px] shrink-0 gap-1 cursor-pointer"
                      onClick={() => setInvoiceCustomAmount(String(instRemainingBalance))}
                    >
                      Saldo Restante ({formatCOP(instRemainingBalance)})
                    </Button>
                  )}
                </div>
              </div>

              {/* Recibo imprimible / exportable */}
              <div id="printable-invoice" className="p-4 bg-white border border-slate-200 rounded-xl space-y-4 text-xs">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="font-black text-base text-slate-900 tracking-wide">PRESMON</h3>
                    <p className="text-[11px] text-slate-600 font-semibold">Christian Romero · Software de Gestión</p>
                    <p className="text-[10px] text-slate-500">Contacto & WhatsApp: +57 318 351 7802</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="success" className="font-mono text-[10px]">
                      {invoiceNumber}
                    </Badge>
                    <p className="text-[11px] text-slate-500 mt-1">Emisión: {today}</p>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex justify-between items-center">
                  <div>
                    <p className="text-[10px] text-slate-400 font-bold uppercase">Facturado a:</p>
                    <p className="font-bold text-slate-900 text-xs">{selectedTenant.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-slate-400 font-bold uppercase">Vencimiento:</p>
                    <p className="font-bold text-slate-900 text-xs">{invoiceInstallmentTarget?.dueDate || nextCloudDue || today}</p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="font-bold text-slate-700 text-[11px] uppercase tracking-wider">Conceptos y Servicios:</p>
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                    {isInstallment ? (
                      <div className="p-3 bg-slate-50/60 space-y-2">
                        <div className="flex justify-between items-center text-slate-800">
                          <span className="font-bold">{invoiceInstallmentTarget.concept}</span>
                          <span className="font-bold">{formatCOP(instAmount)}</span>
                        </div>

                        {instPaidAmount > 0 && (
                          <>
                            <div className="flex justify-between items-center text-emerald-700 text-xs pl-2 border-l-2 border-emerald-500">
                              <span>
                                Abono registrado previamente
                                {invoiceInstallmentTarget.lastAbonoAt ? ` (${formatDateShort(invoiceInstallmentTarget.lastAbonoAt.slice(0, 10))})` : ''}
                              </span>
                              <span className="font-bold">- {formatCOP(instPaidAmount)}</span>
                            </div>
                            <div className="flex justify-between items-center text-slate-700 text-xs font-semibold pt-1 border-t border-slate-200">
                              <span>Saldo pendiente de la cuota:</span>
                              <span>{formatCOP(instRemainingBalance)}</span>
                            </div>
                          </>
                        )}

                        {totalToPay !== (instPaidAmount > 0 ? instRemainingBalance : instAmount) && (
                          <div className="flex justify-between items-center text-indigo-700 text-xs font-semibold pt-1 border-t border-slate-200">
                            <span>Monto liquidado en esta factura:</span>
                            <span>{formatCOP(totalToPay)}</span>
                          </div>
                        )}
                      </div>
                    ) : activeServices.length === 0 ? (
                      <div className="p-2 text-slate-400 text-center">Mensualidad general de servicios</div>
                    ) : (
                      <>
                        {activeServices.map((s) => (
                          <div key={s.id} className="flex justify-between items-center p-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-slate-800 font-medium">{s.name}</span>
                              <Badge
                                variant={s.billingCycle === 'ONE_TIME' ? 'info' : 'success'}
                                className="text-[9px] px-1.5 py-0 font-semibold"
                              >
                                {s.billingCycle === 'ONE_TIME' ? 'Pago Único' : 'Mensual'}
                              </Badge>
                            </div>
                            <span className="font-bold text-slate-900">{formatCOP(s.price || 0)}</span>
                          </div>
                        ))}
                        {totalMonthlyServices > 0 && totalOneTimeServices > 0 && (
                          <div className="p-2 bg-slate-50 space-y-1 text-[11px] text-slate-600 border-t border-slate-200">
                            <div className="flex justify-between">
                              <span>Subtotal mensual recurrente:</span>
                              <span className="font-bold text-slate-800">{formatCOP(totalMonthlyServices)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Subtotal pago único (licencia/setup):</span>
                              <span className="font-bold text-slate-800">{formatCOP(totalOneTimeServices)}</span>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    <div className="flex justify-between items-center p-2.5 bg-slate-100 font-bold text-slate-900 text-sm">
                      <div>
                        <span>Total a Pagar</span>
                        {isInstallment && instPaidAmount > 0 && totalToPay < instRemainingBalance && (
                          <p className="text-[10px] text-slate-500 font-normal">
                            Saldo restante pendiente tras este pago: {formatCOP(instRemainingBalance - totalToPay)}
                          </p>
                        )}
                      </div>
                      <span className="text-emerald-700 font-black text-base">{formatCOP(totalToPay)} COP</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 p-2.5 space-y-1">
                  <p className="font-bold text-emerald-900 text-[11px]">Cuenta Autorizada para Pago:</p>
                  <p className="text-[11px] text-slate-800">
                    Nequi: <strong className="font-mono font-black text-slate-900">318 351 7802</strong>
                  </p>
                  <p className="text-[10px] text-slate-600 font-medium">Titular: Christian Romero</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.print()}
                  className="gap-1.5 text-xs cursor-pointer"
                >
                  <Printer size={14} /> Imprimir / PDF
                </Button>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs cursor-pointer"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(invoiceTextWhatsApp);
                        toast('Factura copiada para WhatsApp', 'success');
                      } catch {
                        toast('No se pudo copiar automáticamente', 'error');
                      }
                    }}
                  >
                    <Copy size={13} /> Copiar para WhatsApp
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
                    onClick={() => openWhatsApp('', invoiceTextWhatsApp)}
                  >
                    <MessageCircle size={14} /> Enviar por WhatsApp
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}
      </Dialog>
    </div>
  );
}
