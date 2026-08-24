import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BadgeCheck,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FileImage,
  HandCoins,
  Loader2,
  Package,
  RefreshCw,
  ShieldAlert,
  UserPlus,
  XCircle,
} from 'lucide-react';
import type { DocumentType, Frequency, LoanRequest } from '../db/models';
import type { Borrower } from '../db/models';
import { db, saveBorrower, saveInstallments, saveLoan } from '../db/db';
import { isSyncConfigured, runSync } from '../lib/sync/syncEngine';
import { useAuth } from '../store/auth';
import { uid } from '../lib/id';
import { computeSchedule, summarize, FREQUENCY_LABELS, type LoanInput } from '../lib/financialCalculations';
import { logAudit } from '../lib/auditLogger';
import { formatCOP, formatDateTime, todayStr } from '../lib/format';
import { PageHeader, StatCard } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, Select } from '../components/ui/input';
import { useToast } from '../components/ui/toast';

type Filter = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';

function statusVariant(status: LoanRequest['status']) {
  return status === 'APPROVED' ? 'success' : status === 'REJECTED' ? 'danger' : 'info';
}
function statusLabel(status: LoanRequest['status']) {
  return status === 'APPROVED' ? 'Aprobada' : status === 'REJECTED' ? 'Rechazada' : 'Pendiente';
}

export default function RequestsPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const tenantId = session?.tenantId ?? '';

  const requests = useLiveQuery(
    () =>
      tenantId
        ? db.loan_requests.where('tenantId').equals(tenantId).toArray()
        : Promise.resolve([] as LoanRequest[]),
    [tenantId],
  );

  const [filter, setFilter] = useState<Filter>('PENDING');
  const [detailTarget, setDetailTarget] = useState<LoanRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Configuración de desembolso al aprobar
  const [rate, setRate] = useState('5');
  const [frequency, setFrequency] = useState<Frequency>('WEEKLY');
  const [cuotas, setCuotas] = useState('10');
  const [startDate, setStartDate] = useState(todayStr());
  const [moraDiaria, setMoraDiaria] = useState('0.5');
  const [recargoFijo, setRecargoFijo] = useState('0');
  const [guaranteeConfirmed, setGuaranteeConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cloudRows, setCloudRows] = useState<LoanRequest[]>([]);

  async function fetchNewRequests() {
    if (!isSyncConfigured()) {
      toast('Esta organización no tiene nube activa: revisa las solicitudes locales.', 'info');
      return;
    }
    setRefreshing(true);
    try {
      const r = await runSync(tenantId || undefined);
      await loadCloudRequests();
      if (r.errors.length > 0) {
        toast(`Sincronización con errores: ${r.errors[0]}`, 'error');
      } else if (r.pulled === 0 && r.pushed === 0) {
        toast('Sin solicitudes nuevas por ahora.', 'info');
      } else {
        toast(`Sincronizado: ${r.pulled} descargado(s), ${r.pushed} enviado(s).`, 'success');
      }
    } catch {
      toast('No se pudo conectar con la nube.', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Lectura DIRECTA de la nube: garantiza que las solicitudes enviadas desde
   * el portal aparezcan aunque la réplica local de esta organización esté
   * desactualizada. La nube es la fuente autoritativa.
   */
  const loadCloudRequests = useCallback(async () => {
    if (!tenantId || !isSyncConfigured()) return;
    try {
      const { loadFirebaseConfig } = await import('../lib/sync/firebaseConfig');
      const cfg = loadFirebaseConfig();
      if (!cfg) return;
      const { initializeApp, getApps } = await import('firebase/app');
      const { getFirestore, collection, getDocsFromServer, query, where } = await import(
        'firebase/firestore'
      );
      const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
      const snap = await getDocsFromServer(
        query(collection(fs, 'loan_requests'), where('tenantId', '==', tenantId)),
      );
      const rows = snap.docs.map((d) => d.data() as unknown as LoanRequest).filter((r) => r.requestId);
      setCloudRows(rows);
    } catch {
      /* sin conexión: se muestran solo las locales */
    }
  }, [tenantId]);

  useEffect(() => {
    void loadCloudRequests();
  }, [loadCloudRequests]);

  /** Fusión nube + local: gana la versión de la nube; se completan faltantes. */
  const list = useMemo(() => {
    const byId = new Map<string, LoanRequest>();
    for (const r of requests ?? []) byId.set(r.requestId, r);
    for (const r of cloudRows) byId.set(r.requestId, { ...byId.get(r.requestId), ...r });
    return [...byId.values()];
  }, [requests, cloudRows]);

  const pendingCount = list.filter((r) => r.status === 'PENDING').length;

  const filtered = useMemo(() => {
    const rows =
      filter === 'ALL' ? [...list] : list.filter((r) => r.status === filter);
    const order: Record<LoanRequest['status'], number> = { PENDING: 0, APPROVED: 1, REJECTED: 2 };
    return rows.sort(
      (a, b) => order[a.status] - order[b.status] || b.createdAt.localeCompare(a.createdAt),
    );
  }, [list, filter]);

  const detailInput: LoanInput = useMemo(() => {
    const amount = detailTarget?.amountRequested ?? 0;
    return {
      principalAmount: amount,
      interestRatePercent: Number(rate) || 0,
      frequency,
      totalInstallments: Math.max(1, Number(cuotas) || 1),
      startDate,
      dailyLateFeePercent: Number(moraDiaria) || 0,
      fixedLateFeeAmount: Number(recargoFijo) || 0,
    };
  }, [detailTarget, rate, frequency, cuotas, startDate, moraDiaria, recargoFijo]);

  const lines = useMemo(() => computeSchedule(detailInput), [detailInput]);
  const summary = useMemo(
    () => summarize(detailInput.principalAmount, lines),
    [detailInput.principalAmount, lines],
  );

  /**
   * Sube la decisión (aprobada/rechazada) a la nube de inmediato para que el
   * cliente la vea al instante al consultar por referencia, sin esperar el
   * ciclo general de sincronización.
   */
  async function pushRequestToCloud(requestId: string): Promise<void> {
    try {
      const { loadFirebaseConfig } = await import('../lib/sync/firebaseConfig');
      const cfg = loadFirebaseConfig();
      if (!cfg) return;
      const { initializeApp, getApps } = await import('firebase/app');
      const { getFirestore, doc, setDoc } = await import('firebase/firestore');
      const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
      const fresh = await db.loan_requests.get(requestId);
      if (fresh) await setDoc(doc(fs, 'loan_requests', requestId), { ...fresh, syncStatus: 'SYNCED' });
    } catch {
      /* el ciclo normal de sincronización lo subirá más tarde */
    }
  }

  async function reject(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !detailTarget) return;
    if (!rejectReason.trim()) {
      toast('Escribe el motivo del rechazo.', 'error');
      return;
    }
    setWorking(true);
    try {
      await db.loan_requests.put({
        ...detailTarget,
        status: 'REJECTED',
        rejectReason: rejectReason.trim(),
        decidedByUid: session.userId,
        decidedByName: session.displayName,
        decidedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        syncStatus: 'PENDING',
      });
      void pushRequestToCloud(detailTarget.requestId);
      await logAudit({
        tenantId,
        action: 'LOAN_REQUEST_REJECTED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: detailTarget.requestId,
        entityType: 'loan_requests',
        payloadSnapshot: {
          solicitante: detailTarget.fullName,
          documento: detailTarget.documentNumber,
          monto: detailTarget.amountRequested,
          motivo: rejectReason.trim(),
        },
      });
      toast(`Solicitud de ${detailTarget.fullName} rechazada.`, 'info');
      setDetailTarget(null);
      setRejectReason('');
    } finally {
      setWorking(false);
    }
  }

  async function approveAndDisburse() {
    if (!session || !detailTarget) return;
    if (!Number(rate) || Number(rate) <= 0) {
      toast('Define la tasa por período.', 'error');
      return;
    }
    setWorking(true);
    try {
      let borrower: Borrower | undefined = detailTarget.borrowerId
        ? await db.borrowers.get(detailTarget.borrowerId)
        : undefined;
      if (!borrower) {
        borrower = await db.borrowers
          .where('[tenantId+documentNumber]')
          .equals([tenantId, detailTarget.documentNumber])
          .first();
      }
      if (!borrower) {
        borrower = {
          borrowerId: uid(),
          tenantId,
          fullName: detailTarget.fullName,
          documentType: detailTarget.documentType,
          documentNumber: detailTarget.documentNumber,
          phone: detailTarget.phone,
          address: detailTarget.address || '',
          city: '',
          creditScore: 50,
          riskBadge: 'C',
          totalLoansCount: 0,
          defaultCount: 0,
          notes: 'Registrado desde el Portal del Cliente.',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          syncStatus: 'PENDING',
        };
      }

      const nowIso = new Date().toISOString();
      const loanId = uid();
      const loan = {
        loanId,
        tenantId,
        borrowerId: borrower.borrowerId,
        principalAmount: detailInput.principalAmount,
        interestRatePercent: detailInput.interestRatePercent,
        frequency: detailInput.frequency,
        totalInstallments: detailInput.totalInstallments,
        interestAmount: summary.totalInterest,
        totalPayableAmount: summary.totalPayable,
        balanceRemaining: summary.totalPayable,
        dailyLateFeePercent: detailInput.dailyLateFeePercent,
        fixedLateFeeAmount: detailInput.fixedLateFeeAmount,
        status: 'ACTIVE' as const,
        startDate: detailInput.startDate,
        contractPdfBlobRef: null,
        guaranteeRequestId: detailTarget.requestId,
        guaranteeReceivedAt: guaranteeConfirmed ? nowIso : null,
        referenceCode: detailTarget.referenceCode,
        createdAt: nowIso,
        updatedAt: nowIso,
        syncStatus: 'PENDING' as const,
      };

      await db.transaction('rw', [db.loans, db.installments, db.borrowers], async () => {
        await saveLoan(loan);
        await saveInstallments(
          lines.map((line) => ({
            installmentId: uid(),
            loanId,
            tenantId,
            installmentNumber: line.installmentNumber,
            dueDate: line.dueDate,
            principalAmount: line.principalAmount,
            interestAmount: line.interestAmount,
            baseAmountDue: line.baseAmountDue,
            daysOverdue: 0,
            lateFeeCharged: 0,
            totalAmountWithLateFee: line.baseAmountDue,
            amountPaid: 0,
            status: 'PENDING' as const,
            paidAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
            syncStatus: 'PENDING' as const,
          })),
        );
        const fresh = (await db.borrowers.get(borrower!.borrowerId)) ?? borrower!;
        await saveBorrower({ ...fresh, totalLoansCount: (fresh.totalLoansCount ?? 0) + 1 });
      });

      const requestFresh = await db.loan_requests.get(detailTarget.requestId);
      if (requestFresh) {
        await db.loan_requests.put({
          ...requestFresh,
          status: 'APPROVED',
          borrowerId: borrower.borrowerId,
          createdLoanId: loanId,
          decidedByUid: session.userId,
          decidedByName: session.displayName,
          decidedAt: nowIso,
          updatedAt: nowIso,
          syncStatus: 'PENDING',
        });
        void pushRequestToCloud(detailTarget.requestId);
      }

      await logAudit({
        tenantId,
        action: 'LOAN_REQUEST_APPROVED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: detailTarget.requestId,
        entityType: 'loan_requests',
        payloadSnapshot: JSON.stringify({
          solicitante: detailTarget.fullName,
          documento: detailTarget.documentNumber,
          referencia: detailTarget.referenceCode,
          montoAprobado: detailInput.principalAmount,
          tasaPeriodo: detailInput.interestRatePercent,
          cuotas: detailInput.totalInstallments,
          frecuencia: detailInput.frequency,
          prestamoCreado: loanId,
          terminosAceptadosEn: detailTarget.termsAcceptedAt,
          garantiaEntregada: guaranteeConfirmed,
        }),
      });

      toast(`Crédito creado y solicitud aprobada para ${borrower.fullName}.`, 'success');
      setDetailTarget(null);
      navigate(`/loans/${loanId}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Solicitudes de crédito"
        description="Clientes que solicitaron un préstamo desde el portal · verifica el soporte y aprueba el desembolso"
        actions={
          <Button variant="outline" size="sm" onClick={() => void fetchNewRequests()} disabled={refreshing}>
            {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Buscar solicitudes nuevas
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Nuevas" value={String(pendingCount)} icon={ClipboardList} tone={pendingCount > 0 ? 'amber' : 'sky'} />
        <StatCard label="Aprobadas" value={String(list.filter((r) => r.status === 'APPROVED').length)} icon={BadgeCheck} tone="emerald" />
        <StatCard label="Rechazadas" value={String(list.filter((r) => r.status === 'REJECTED').length)} icon={XCircle} />
        <StatCard label="Total recibidas" value={String(list.length)} icon={FileImage} tone="sky" />
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`cursor-pointer rounded-full px-4 py-1.5 text-xs font-bold transition-colors ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
            }`}
          >
            {f === 'PENDING' ? 'Pendientes' : f === 'APPROVED' ? 'Aprobadas' : f === 'REJECTED' ? 'Rechazadas' : 'Todas'}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-400">
          {filter === 'PENDING'
            ? 'Sin solicitudes pendientes. Cuando un cliente envíe una desde el portal, aparecerá aquí.'
            : 'No hay solicitudes en esta categoría.'}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {filtered.map((r) => (
            <button
              key={r.requestId}
              onClick={() => {
                setDetailTarget(r);
                setRejectReason('');
                setGuaranteeConfirmed(false);
              }}
              className="cursor-pointer text-left"
            >
              <Card
                className={
                  r.status === 'PENDING'
                    ? 'transition-shadow hover:border-emerald-400 hover:shadow-md'
                    : 'opacity-90'
                }
              >
                <CardContent className="flex gap-3 py-4">
                  {r.supportDataUrl ? (
                    <img
                      src={r.supportDataUrl}
                      alt={`Soporte de ${r.fullName}`}
                      className="h-20 w-16 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                      <UserPlus size={22} className="text-slate-300" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-bold text-slate-800">{r.fullName}</p>
                      <Badge variant={statusVariant(r.status)}>
                        {r.status === 'APPROVED' ? (
                          <BadgeCheck size={11} />
                        ) : r.status === 'REJECTED' ? (
                          <XCircle size={11} />
                        ) : (
                          <Clock3 size={11} />
                        )}
                        {statusLabel(r.status)}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500">
                      {r.documentType} {r.documentNumber} · {r.phone}
                      {r.referenceCode && (
                        <span className="ml-1.5 font-mono text-[10px] font-bold text-emerald-600">
                          Ref {r.referenceCode}
                        </span>
                      )}
                    </p>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="font-bold text-emerald-700">{formatCOP(r.amountRequested)}</span>
                      <span className="text-[10px] text-slate-400">{formatDateTime(r.createdAt)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}

      <Dialog
        open={detailTarget !== null}
        onClose={() => setDetailTarget(null)}
        title={`Solicitud · ${detailTarget?.fullName ?? ''}`}
        description="Verifica la garantía y el soporte antes de aprobar el desembolso."
      >
        {detailTarget && (
          <form onSubmit={reject} className="space-y-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <span className="text-slate-500">Referencia</span>
              <strong className="font-mono tracking-wider text-emerald-700">
                {detailTarget.referenceCode ?? '—'}
              </strong>
              <span className="text-slate-500">Documento</span>
              <strong>
                {detailTarget.documentType} {detailTarget.documentNumber}
              </strong>
              <span className="text-slate-500">Teléfono</span>
              <strong>{detailTarget.phone}</strong>
              <span className="text-slate-500">Dirección</span>
              <span>{detailTarget.address || '—'}</span>
              <span className="text-slate-500">Destino del crédito</span>
              <span>{detailTarget.note || '—'}</span>
              <span className="text-slate-500">Monto solicitado</span>
              <strong className="text-emerald-700">{formatCOP(detailTarget.amountRequested)}</strong>
              <span className="col-span-2 mt-1 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                <ShieldAlert size={13} /> Términos aceptados legalmente:{' '}
                {formatDateTime(detailTarget.termsAcceptedAt)} ({detailTarget.termsVersion})
              </span>
              {detailTarget.status !== 'PENDING' && (
                <span className="col-span-2 mt-1 rounded-lg bg-slate-100 px-3 py-2 text-xs">
                  Estado: <strong>{statusLabel(detailTarget.status)}</strong>
                  {detailTarget.decidedByName ? ` · decidida por ${detailTarget.decidedByName}` : ''}
                  {detailTarget.rejectReason ? ` · Motivo: ${detailTarget.rejectReason}` : ''}
                </span>
              )}
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
                <Package size={14} /> Garantía declarada por el cliente
              </p>
              <p className="mt-1 text-sm font-semibold text-amber-900">
                {detailTarget.guaranteeDescription || 'No describió la garantía.'}
              </p>
              <p className="mt-0.5 text-[11px] text-amber-700">
                La foto de abajo debe mostrar al cliente junto a este bien. Verifícalo físicamente
                antes de entregar el dinero.
              </p>
            </div>

            {detailTarget.supportDataUrl && (
              <>
                <p className="text-xs font-bold text-slate-600">Foto de la garantía (cliente + bien)</p>
                <a href={detailTarget.supportDataUrl} target="_blank" rel="noreferrer">
                  <img
                    src={detailTarget.supportDataUrl}
                    alt="Garantía del cliente"
                    className="max-h-72 w-full rounded-lg border border-slate-200 object-contain"
                  />
                  <p className="mt-1 text-center text-[10px] text-sky-600 underline">
                    Toca para ver en tamaño completo
                  </p>
                </a>
              </>
            )}

            {detailTarget.status === 'PENDING' && (
              <>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-900">
                  <input
                    type="checkbox"
                    checked={guaranteeConfirmed}
                    onChange={(e) => setGuaranteeConfirmed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
                  />
                  <span>
                    <strong>Confirmo que el cliente presentó físicamente la garantía</strong>{' '}
                    mostrada en esta foto. Solo marca esto al momento de entregar el desembolso.
                  </span>
                </label>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                    <HandCoins size={14} /> Condiciones de desembolso
                  </p>
                  <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-3">
                    <div>
                      <Label>Tasa %</Label>
                      <Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" />
                    </div>
                    <div>
                      <Label>Frecuencia</Label>
                      <Select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                        {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
                          <option key={f} value={f}>
                            {FREQUENCY_LABELS[f]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>Cuotas</Label>
                      <Input value={cuotas} onChange={(e) => setCuotas(e.target.value)} inputMode="numeric" />
                    </div>
                    <div>
                      <Label>Inicio</Label>
                      <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    </div>
                    <div>
                      <Label>Mora %/día</Label>
                      <Input value={moraDiaria} onChange={(e) => setMoraDiaria(e.target.value)} inputMode="decimal" />
                    </div>
                    <div>
                      <Label>Recargo fijo</Label>
                      <Input value={recargoFijo} onChange={(e) => setRecargoFijo(e.target.value)} inputMode="numeric" />
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 text-xs font-semibold text-emerald-800">
                    <span>Total a pagar: {formatCOP(summary.totalPayable)}</span>
                    <span>Cuota aprox.: {formatCOP(lines[0]?.baseAmountDue ?? 0)}</span>
                  </div>
                </div>

                <div>
                  <Label>Motivo si vas a rechazar</Label>
                  <Input
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Ej: soporte ilegible, no cumple requisitos…"
                  />
                </div>

                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="submit" variant="outline" className="text-red-600" disabled={working}>
                    <XCircle size={14} /> Rechazar
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void approveAndDisburse()}
                    disabled={working || !guaranteeConfirmed}
                    title={
                      guaranteeConfirmed
                        ? 'Crear préstamo y registrar entrega de garantía'
                        : 'Confirma primero la entrega física de la garantía'
                    }
                  >
                    <CheckCircle2 size={14} /> {working ? 'Procesando…' : 'Aprobar y desembolsar'}
                  </Button>
                </div>
              </>
            )}
          </form>
        )}
      </Dialog>
    </div>
  );
}
