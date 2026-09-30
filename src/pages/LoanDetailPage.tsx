import { useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Clock,
  FileDown,
  HandCoins,
  Mail,
  MessageCircle,
  Package,
  Receipt,
  UserCheck,
} from 'lucide-react';
import type { AuditLog, Borrower, Installment, Loan, LoanRequest } from '../db/models';
import { db, savePdfBlob } from '../db/db';
import { useAuth } from '../store/auth';
import { applyPaymentToLoan } from '../lib/payments';
import { generateContractPDF } from '../lib/generateContractPDF';
import { downloadBlob } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { DOCUMENT_TYPE_LABELS, FREQUENCY_LABELS, computeSchedule } from '../lib/financialCalculations';
import { cn, formatCOP, formatDateShort, formatDateTime } from '../lib/format';
import { openWhatsApp } from '../lib/share';
import { PageHeader, StatCard } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';

export function PaymentDialog({
  open,
  onClose,
  loan,
  installment,
}: {
  open: boolean;
  onClose: () => void;
  loan: Loan | undefined;
  installment?: Installment;
}) {
  const { session } = useAuth();
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  if (!loan) return null;

  const targetDue = installment
    ? Math.max(0, installment.totalAmountWithLateFee - installment.amountPaid)
    : Math.max(0, loan.balanceRemaining);

  async function confirm() {
    if (!session) return;
    const value = Number(amount);
    if (!value || value <= 0) {
      toast('Ingresa un valor válido.', 'error');
      return;
    }
    setSaving(true);
    try {
      const result = await applyPaymentToLoan(loan!.loanId, value, {
        id: session.userId,
        name: session.displayName,
      });
      toast(
        result.loanFullyPaid
          ? '¡Préstamo pagado en su totalidad!'
          : `Abono aplicado: ${formatCOP(result.applied)}`,
        'success',
      );
      setAmount('');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error al aplicar el pago', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Registrar abono"
      description={
        installment
          ? `Cuota ${installment.installmentNumber} · pendiente ${formatCOP(targetDue)}`
          : `Saldo total pendiente ${formatCOP(loan.balanceRemaining)}`
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Valor recibido (COP)</Label>
          <Input
            type="number"
            min={0}
            step={1000}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Ej: 150000"
            autoFocus
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAmount(String(Math.round(targetDue)))}
          >
            Cuota pendiente · {formatCOP(targetDue)}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAmount(String(Math.round(targetDue / 2)))}
          >
            Medio abono · {formatCOP(targetDue / 2)}
          </Button>
        </div>
        <p className="text-[11px] text-slate-400">
          El excedente se aplica automáticamente a las siguientes cuotas (FIFO).
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void confirm()} disabled={saving}>
            <HandCoins size={15} /> Aplicar pago
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export default function LoanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const { toast } = useToast();
  const [payOpen, setPayOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const loan = useLiveQuery<Loan | undefined>(
    () => (id ? db.loans.get(id) : Promise.resolve(undefined)),
    [id],
  );
  const borrower = useLiveQuery<Borrower | undefined>(
    () => (loan ? db.borrowers.get(loan.borrowerId) : Promise.resolve(undefined)),
    [loan?.borrowerId],
  );
  const installments = useLiveQuery(
    () =>
      id
        ? db.installments.where('loanId').equals(id).toArray()
        : Promise.resolve([] as Installment[]),
    [id],
  );
  const guaranteeRequest = useLiveQuery<LoanRequest | undefined>(
    () =>
      loan?.guaranteeRequestId
        ? db.loan_requests.get(loan.guaranteeRequestId)
        : Promise.resolve(undefined),
    [loan?.guaranteeRequestId],
  );

  const loanAudits = useLiveQuery<AuditLog[]>(
    () =>
      id
        ? db.audit_logs
            .where('entityId')
            .equals(id)
            .toArray()
        : Promise.resolve([]),
    [id],
  );

  const paymentHistory = useMemo(() => {
    const list: Array<{
      id: string;
      timestamp: string;
      collectorName: string;
      isSocio: boolean;
      amount: number;
      method: string;
      notes: string;
    }> = [];

    (loanAudits ?? []).forEach((log) => {
      if (log.action !== 'PAYMENT_APPLIED' && log.action !== 'SOCIO_PAYMENT_APPLIED') return;
      let payload: Record<string, unknown> = {};
      try {
        payload = typeof log.payloadSnapshot === 'string' ? JSON.parse(log.payloadSnapshot) : (log.payloadSnapshot || {});
      } catch {
        payload = {};
      }
      const isSocio = log.action === 'SOCIO_PAYMENT_APPLIED' || Boolean(payload.recaudadoPor);
      const collectorName = String(payload.recaudadoPor || log.actorName || (isSocio ? 'Socio Cobrador' : 'Oficina / Admin'));
      list.push({
        id: log.logId,
        timestamp: log.timestamp || log.createdAt,
        collectorName,
        isSocio,
        amount: Number(payload.montoAplicado) || 0,
        method: String(payload.metodoPago || 'Efectivo'),
        notes: String(payload.notas || ''),
      });
    });

    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [loanAudits]);

  const getInstallmentPaymentDetails = (inst: Installment) => {
    if (inst.paidCollectorName) {
      return {
        collectorName: inst.paidCollectorName,
        date: inst.paidAt || inst.lastPaymentAt,
        isSocio: inst.paidCollectorRole === 'SOCIO',
      };
    }
    // Fallback retroactivo si tiene pagos pero no tenía el campo grabado
    if (inst.amountPaid > 0 && paymentHistory.length > 0) {
      const log = paymentHistory[paymentHistory.length - 1];
      if (log) {
        return {
          collectorName: log.collectorName,
          date: inst.paidAt || log.timestamp,
          isSocio: log.isSocio,
        };
      }
    }
    return null;
  };

  if (!loan) {
    return (
      <div className="py-16 text-center text-sm text-slate-400">Cargando préstamo…</div>
    );
  }
  const currentLoan: Loan = loan;

  const sorted = (installments ?? []).sort((a, b) => a.installmentNumber - b.installmentNumber);
  const overdueTotal = sorted.reduce(
    (s, i) => s + (i.status === 'OVERDUE' ? Math.max(0, i.totalAmountWithLateFee - i.amountPaid) : 0),
    0,
  );
  const paidCount = sorted.filter((i) => i.status === 'PAID').length;

  const buildContractPdf = async (): Promise<Blob | null> => {
    if (!session || !borrower) return null;
    const tenant = await db.tenants.get(currentLoan.tenantId);
    if (!tenant) throw new Error('Organización no encontrada');
    const schedule = computeSchedule({
      principalAmount: currentLoan.principalAmount,
      interestRatePercent: currentLoan.interestRatePercent,
      frequency: currentLoan.frequency,
      totalInstallments: currentLoan.totalInstallments,
      startDate: currentLoan.startDate,
      dailyLateFeePercent: currentLoan.dailyLateFeePercent,
      fixedLateFeeAmount: currentLoan.fixedLateFeeAmount,
    });
    const blob = generateContractPDF({
      tenant,
      borrower,
      loan: currentLoan,
      schedule,
      generatedBy: session.displayName,
    });
    const blobId = 'pdf-' + Date.now().toString(36);
    await savePdfBlob({
      blobId,
      loanId: currentLoan.loanId,
      tenantId: currentLoan.tenantId,
      data: blob,
      createdAt: new Date().toISOString(),
    });
    if (currentLoan.contractPdfBlobRef !== blobId) {
      currentLoan.contractPdfBlobRef = blobId;
      await db.loans.put({
        ...currentLoan,
        syncStatus: 'PENDING',
        updatedAt: new Date().toISOString(),
      });
    }
    await logAudit({
      tenantId: currentLoan.tenantId,
      action: 'PDF_GENERATED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: currentLoan.loanId,
      entityType: 'loans',
      payloadSnapshot: {
        documento: 'PAGARÉ CON CARTA DE INSTRUCCIONES',
        prestatario: borrower.fullName,
      },
    });
    return blob;
  };

  const pdfFileName = borrower
    ? `pagare-${borrower.documentNumber}-${currentLoan.loanId.slice(0, 6)}.pdf`
    : `pagare-${currentLoan.loanId.slice(0, 6)}.pdf`;

  const handleDownloadPDF = async () => {
    try {
      const blob = await buildContractPdf();
      if (!blob) return;
      downloadBlob(blob, pdfFileName);
      toast('Pagaré generado y descargado.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error generando PDF', 'error');
    }
  };

  const buildShareText = () => {
    const lines = [
      'DOCUMENTO: PAGARÉ CON CARTA DE INSTRUCCIONES',
      `Deudor: ${borrower ? `${borrower.fullName} (${DOCUMENT_TYPE_LABELS[borrower.documentType]} ${borrower.documentNumber})` : ''}`,
      `Capital prestado: ${formatCOP(currentLoan.principalAmount)}`,
      `Total de la obligación: ${formatCOP(currentLoan.totalPayableAmount)}`,
      `Saldo pendiente: ${formatCOP(currentLoan.balanceRemaining)}`,
      `Plan: ${currentLoan.totalInstallments} cuotas ${FREQUENCY_LABELS[currentLoan.frequency].toLowerCase()}es (${currentLoan.interestRatePercent}% por periodo)`,
      '',
      'El PDF del pagaré se adjunta o fue descargado a tu dispositivo.',
      'Generado por PresMon by ChrizDev.',
    ];
    return lines.join('\n');
  };

  const handleShare = async (channel: 'whatsapp' | 'email') => {
    try {
      const blob = await buildContractPdf();
      if (!blob) return;
      const text = buildShareText();
      const file = new File([blob], pdfFileName, { type: 'application/pdf' });
      const canShareFiles =
        typeof navigator !== 'undefined' &&
        'canShare' in navigator &&
        navigator.canShare?.({ files: [file] });
      if (channel === 'whatsapp') {
        if (canShareFiles && navigator.share) {
          try {
            await navigator.share({ files: [file], title: 'Pagaré PresMon', text });
            return;
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
          }
        }
        openWhatsApp(text, borrower?.phone);
        downloadBlob(blob, pdfFileName);
        toast(
          'Se abrió WhatsApp con el mensaje listo. El PDF quedó descargado para adjuntarlo.',
          'info',
        );
        return;
      }
      downloadBlob(blob, pdfFileName);
      const subject = encodeURIComponent('Pagaré — ' + (borrower?.fullName ?? '') + ' (PresMon)');
      window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(text)}`;
      toast('PDF descargado. Adjúntalo desde tu correo al enviar el mensaje.', 'info');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast(err instanceof Error ? err.message : 'Error compartiendo el pagaré', 'error');
    }
  };

  const handleCancel = async () => {
    if (!session) return;
    await db.loans.put({
      ...currentLoan,
      status: 'CANCELLED',
      updatedAt: new Date().toISOString(),
      syncStatus: 'PENDING',
    });
    await logAudit({
      tenantId: currentLoan.tenantId,
      action: 'LOAN_CANCELLED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: currentLoan.loanId,
      entityType: 'loans',
      payloadSnapshot: { saldoAlCancelar: currentLoan.balanceRemaining },
    });
    toast('Préstamo cancelado.', 'success');
  };
  const statusVariant =
    loan.status === 'ACTIVE'
      ? 'success'
      : loan.status === 'PAID'
        ? 'muted'
        : loan.status === 'IN_DEFAULT'
          ? 'danger'
          : 'outline';
  const statusLabel =
    loan.status === 'ACTIVE'
      ? 'Activo'
      : loan.status === 'PAID'
        ? 'Pagado'
        : loan.status === 'IN_DEFAULT'
          ? 'En mora'
          : 'Cancelado';

  return (
    <div>
      <PageHeader
        title={borrower?.fullName ?? 'Préstamo'}
        description={`${borrower?.documentType ?? ''} ${borrower?.documentNumber ?? ''}${loan.referenceCode ? ` · Ref ${loan.referenceCode}` : ''} · ${FREQUENCY_LABELS[loan.frequency]} · ${loan.interestRatePercent}% por periodo · inicio ${formatDateShort(loan.startDate)}`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/loans')}>
              <ArrowLeft size={14} /> Volver
            </Button>
            {(loan.status === 'ACTIVE' || loan.status === 'IN_DEFAULT') && (
              <>
                <Button variant="outline" size="sm" onClick={() => setPayOpen(true)}>
                  <HandCoins size={14} /> Registrar abono
                </Button>
                <Button variant="ghost" size="sm" className="text-red-500 hover:bg-red-50" onClick={() => setCancelOpen(true)}>
                  <Ban size={14} /> Cancelar préstamo
                </Button>
              </>
            )}
            <Button size="sm" onClick={() => void handleDownloadPDF()}>
              <FileDown size={14} /> Descargar Pagaré
            </Button>
            <Button
              size="sm"
              className="bg-[#25D366] text-white hover:bg-[#1eb857]"
              onClick={() => void handleShare('whatsapp')}
            >
              <MessageCircle size={14} /> WhatsApp
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleShare('email')}>
              <Mail size={14} /> Correo
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Capital prestado" value={formatCOP(loan.principalAmount)} icon={HandCoins} />
        <StatCard label="Saldo pendiente" value={formatCOP(loan.balanceRemaining)} icon={HandCoins} tone="emerald" />
        <StatCard label="Mora acumulada" value={formatCOP(overdueTotal)} icon={AlertTriangle} tone="red" />
        <StatCard
          label="Estado"
          value={statusLabel}
          hint={`${paidCount}/${loan.totalInstallments} cuotas pagadas`}
          icon={AlertTriangle}
          tone={loan.status === 'IN_DEFAULT' ? 'red' : 'sky'}
        />
      </div>

      {guaranteeRequest && (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="flex items-center gap-1.5 text-sm font-bold text-amber-800">
            <Package size={15} /> Garantía del crédito
          </p>
          <p className="mt-1 text-sm text-amber-900">
            {guaranteeRequest.guaranteeDescription || 'Sin descripción.'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {guaranteeRequest.supportDataUrl && (
              <a href={guaranteeRequest.supportDataUrl} target="_blank" rel="noreferrer">
                <img
                  src={guaranteeRequest.supportDataUrl}
                  alt="Foto de la garantía"
                  className="h-24 w-32 rounded-lg border border-amber-300 object-cover"
                />
              </a>
            )}
            <Badge variant={loan.guaranteeReceivedAt ? 'success' : 'warning'}>
              {loan.guaranteeReceivedAt
                ? `Entregada · ${formatDateShort(loan.guaranteeReceivedAt.slice(0, 10))}`
                : 'Pendiente de entrega física'}
            </Badge>
          </div>
        </div>
      )}

      <h2 className="mt-6 mb-2 font-semibold text-slate-700">Plan de pagos</h2>      <TableWrap>
        <THead>
          <TH>#</TH>
          <TH>Vencimiento</TH>
          <TH className="text-right">Capital</TH>
          <TH className="text-right">Interés</TH>
          <TH className="text-right">Base</TH>
          <TH className="text-right">Mora</TH>
          <TH className="text-right">Total con mora</TH>
          <TH className="text-right">Pagado</TH>
          <TH>Estado</TH>
        </THead>
        <TBody>
          {sorted.map((i) => (
            <TR key={i.installmentId} className={i.status === 'OVERDUE' ? 'bg-red-50/70' : ''}>
              <TD className="font-medium text-slate-500">{i.installmentNumber}</TD>
              <TD className="text-slate-600">{formatDateShort(i.dueDate)}</TD>
              <TD className="text-right text-slate-600">{formatCOP(i.principalAmount)}</TD>
              <TD className="text-right text-slate-600">{formatCOP(i.interestAmount)}</TD>
              <TD className="text-right text-slate-600">{formatCOP(i.baseAmountDue)}</TD>
              <TD className="text-right">
                {i.lateFeeCharged > 0 ? (
                  <span className="font-semibold text-red-600">
                    +{formatCOP(i.lateFeeCharged)}
                    <span className="block text-[10px] font-normal text-red-400">
                      {i.daysOverdue} días
                    </span>
                  </span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </TD>
              <TD className="text-right font-semibold text-slate-800">
                {formatCOP(i.totalAmountWithLateFee)}
              </TD>
              <TD className="text-right text-emerald-700">{formatCOP(i.amountPaid)}</TD>
              <TD className="align-top">
                <div className="flex flex-col gap-1 items-start">
                  <Badge
                    variant={
                      i.status === 'PAID'
                        ? 'success'
                        : i.status === 'OVERDUE'
                          ? 'danger'
                          : i.status === 'PARTIAL'
                            ? 'warning'
                            : 'outline'
                    }
                  >
                    {i.status === 'PAID'
                      ? 'Pagada'
                      : i.status === 'OVERDUE'
                        ? 'Vencida'
                        : i.status === 'PARTIAL'
                          ? 'Parcial'
                          : 'Pendiente'}
                  </Badge>
                  {(() => {
                    const info = getInstallmentPaymentDetails(i);
                    if (!info && i.status !== 'PAID' && i.amountPaid <= 0) return null;
                    return (
                      <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-slate-500 bg-slate-50 p-1.5 rounded-md border border-slate-100 max-w-[170px]">
                        {info?.date && (
                          <span className="font-semibold text-slate-700 flex items-center gap-1">
                            <Clock size={10} className="text-slate-400 shrink-0" />
                            {formatDateTime(info.date)}
                          </span>
                        )}
                        <span
                          className="font-bold text-emerald-800 flex items-center gap-1 truncate"
                          title={info?.collectorName ? `Recaudado por: ${info.collectorName}` : 'Recaudado'}
                        >
                          <UserCheck size={11} className={cn('shrink-0', info?.isSocio ? 'text-sky-600' : 'text-emerald-600')} />
                          {info?.collectorName ? (
                            <span>{info.isSocio ? `Socio: ${info.collectorName}` : info.collectorName}</span>
                          ) : (
                            <span>Recaudado</span>
                          )}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </TableWrap>

      {/* Historial de Recaudos y Abonos Registrados */}
      <div className="mt-8 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Receipt size={17} className="text-emerald-600" />
            <h2 className="font-bold text-slate-800 text-sm">
              Historial de Recaudos y Abonos Recibidos
            </h2>
          </div>
          <Badge variant="muted" className="text-[10px] font-bold">
            {paymentHistory.length} transacciones registradas
          </Badge>
        </div>

        {paymentHistory.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-xs text-slate-400">
            Aún no se han registrado abonos o pagos en este préstamo.
          </div>
        ) : (
          <TableWrap>
            <THead>
              <TH>Fecha y Hora</TH>
              <TH className="text-right">Monto Recaudado</TH>
              <TH>Recaudado Por</TH>
              <TH>Método</TH>
              <TH>Notas / Concepto</TH>
            </THead>
            <TBody>
              {paymentHistory.map((p) => (
                <TR key={p.id}>
                  <TD className="text-xs font-mono text-slate-600">
                    {formatDateTime(p.timestamp)}
                  </TD>
                  <TD className="text-right font-black text-emerald-700 text-xs">
                    {formatCOP(p.amount)}
                  </TD>
                  <TD>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <UserCheck size={13} className={p.isSocio ? 'text-sky-600' : 'text-emerald-600'} />
                      <span className="text-xs font-bold text-slate-800">{p.collectorName}</span>
                      <Badge variant={p.isSocio ? 'info' : 'success'} className="text-[9px] py-0 px-1 font-bold">
                        {p.isSocio ? 'Socio' : 'Oficina'}
                      </Badge>
                    </div>
                  </TD>
                  <TD className="text-xs text-slate-600">
                    <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                      {p.method}
                    </span>
                  </TD>
                  <TD className="text-xs text-slate-500">
                    {p.notes || '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </TableWrap>
        )}
      </div>

      <PaymentDialog open={payOpen} onClose={() => setPayOpen(false)} loan={loan} />

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancelar préstamo"
        description="Esta acción queda registrada en la auditoría."
      >
        <div className="space-y-3">
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
            El préstamo quedará marcado como <strong>CANCELADO</strong> y dejará de generar mora.
            Las cuotas ya pagadas se conservan como historial. Esta acción no se puede deshacer.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Volver
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setCancelOpen(false);
                void handleCancel();
              }}
            >
              Sí, cancelar préstamo
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
