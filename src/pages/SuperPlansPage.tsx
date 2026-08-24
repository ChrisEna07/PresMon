import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BadgeCheck,
  CalendarPlus,
  Cloud,
  Plus,
  Save,
  Trash2,
  Wallet,
} from 'lucide-react';
import type { AppPaymentMode, PlanInstallment, ServicePlan, Tenant } from '../db/models';
import { db, nowISO } from '../db/db';
import { useAuth } from '../store/auth';
import { uid } from '../lib/id';
import { formatCOP, formatDateShort, todayStr, addDaysStr, nextMonthlyDue } from '../lib/format';
import { logAudit } from '../lib/auditLogger';
import { isSyncConfigured, runSync } from '../lib/sync/syncEngine';
import { PageHeader } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Input, Label, Select } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';

function pushToCloud(): void {
  void runSync().catch(() => undefined);
}

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

  const [tenantId, setTenantId] = useState('');
  const [name, setName] = useState('');
  const [payMode, setPayMode] = useState<AppPaymentMode>('INSTALLMENTS');
  const [appTotal, setAppTotal] = useState('');
  const [cloudFee, setCloudFee] = useState('');
  const [cloudBillingDay, setCloudBillingDay] = useState('1');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<PlanInstallment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [genCount, setGenCount] = useState('4');
  const [genAmount, setGenAmount] = useState('');
  const [genStart, setGenStart] = useState(today);
  const [genEveryDays, setGenEveryDays] = useState('30');
  const [saving, setSaving] = useState(false);

  const planByTenant = useMemo(() => {
    const map = new Map<string, ServicePlan>();
    (plans ?? []).forEach((p) => map.set(p.tenantId, p));
    return map;
  }, [plans]);

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
    setNotes(existing?.notes ?? '');
    setRows(
      existing
        ? [...existing.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        : [],
    );
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
        cloudServiceIncluded: true,
        appPaymentMode: payMode,
        appTotalAmount:
          payMode === 'FULL'
            ? Math.max(0, Math.round(Number(appTotal) || 0))
            : rows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
        cloudMonthlyFee: Math.max(0, Math.round(Number(cloudFee) || 0)),
        cloudBillingDay: Math.min(28, Math.max(1, Number(cloudBillingDay) || 1)),
        cloudPaidThrough: existing?.cloudPaidThrough,
        notes: notes.trim(),
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
      // Modo online: la sincronización ya no depende de este interruptor;
      // «Incluye servicios de nube» queda como concepto de facturación.
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
          mensualidadCloud: record.cloudMonthlyFee,
          diaCobroCloud: record.cloudBillingDay,
          pagadaHasta: record.cloudPaidThrough ?? '—',
          cuotasApp: record.installments.length,
        },
      });
      setDirty(false);
      pushToCloud();
      toast('Plan guardado y sincronizando a la nube.', 'success');
    } finally {
      setSaving(false);
    }
  }

  const summary = useMemo(() => {
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const paid = rows.filter((r) => r.status === 'PAID').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const pendingTotal = total - paid;
    const nextPending = rows.find((r) => r.status === 'PENDING');
    const appTotalNum = Number(appTotal) || 0;
    const cloudFeeNum = Number(cloudFee) || 0;
    return { total, paid, pendingTotal, nextPending, appTotalNum, cloudFeeNum };
  }, [rows, appTotal, cloudFee]);

  return (
    <div>
      <PageHeader
        title="Planes de servicio"
        description="Cobros de las organizaciones a ChrizDev · cuotas personalizables por cliente"
      />

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
                {summary.cloudFeeNum > 0
                  ? `Vence día ${Number(cloudBillingDay) || 1} · ${formatCOP(summary.cloudFeeNum * 12)} al año`
                  : 'Sin cobro mensual'}
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
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Próxima cuota</p>
              <p className="mt-1 font-bold text-slate-800">
                {summary.nextPending
                  ? `${formatDateShort(summary.nextPending.dueDate)} · ${formatCOP(summary.nextPending.amount)}`
                  : payMode === 'FULL'
                    ? 'Contado'
                    : '—'}
              </p>
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
                <Label className="flex items-center gap-1.5">
                  <Cloud size={14} className="text-sky-600" /> Mensualidad de servicios cloud
                </Label>
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
                  <TH>Valor</TH>
                  <TH>Estado</TH>
                  <TH className="text-right">Acciones</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.installmentId}>
                    <TD>
                      <Input
                        type="date"
                        value={r.dueDate}
                        onChange={(e) => updateRow(r.installmentId, { dueDate: e.target.value })}
                        className="w-40"
                      />
                    </TD>
                    <TD>
                      <Input
                        value={r.concept}
                        onChange={(e) => updateRow(r.installmentId, { concept: e.target.value })}
                        className="min-w-40"
                      />
                    </TD>
                    <TD>
                      <Input
                        value={String(r.amount)}
                        onChange={(e) => updateRow(r.installmentId, { amount: Number(e.target.value) })}
                        inputMode="numeric"
                        className="w-28"
                      />
                    </TD>
                    <TD>
                      <Switch
                        checked={r.status === 'PAID'}
                        label="Pagada"
                        onChange={() =>
                          updateRow(r.installmentId, {
                            status: r.status === 'PAID' ? 'PENDING' : 'PAID',
                            paidAt: r.status === 'PAID' ? undefined : nowISO(),
                          })
                        }
                      />
                    </TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => removeRow(r.installmentId)} title="Quitar cuota">
                        <Trash2 size={14} className="text-red-500" />
                      </Button>
                    </TD>
                  </TR>
                ))}
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
    </div>
  );
}
