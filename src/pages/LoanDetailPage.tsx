import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  FileDown,
  HandCoins,
  Mail,
  MessageCircle,
} from 'lucide-react';
import type { Borrower, Installment, Loan } from '../db/models';
import { db, savePdfBlob } from '../db/db';
import { useAuth } from '../store/auth';
import { applyPaymentToLoan } from '../lib/payments';
import { generateContractPDF } from '../lib/generateContractPDF';
import { downloadBlob } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { DOCUMENT_TYPE_LABELS, FREQUENCY_LABELS, computeSchedule } from '../lib/financialCalculations';
import { formatCOP, formatDateShort } from '../lib/format';
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
      downloadBlob(blob, pdfFileName);
      const text = buildShareText();
      const file = new File([blob], pdfFileName, { type: 'application/pdf' });
      const canShareFiles =
        typeof navigator !== 'undefined' &&
        'canShare' in navigator &&
        navigator.canShare?.({ files: [file] });
      if (canShareFiles) {
        await navigator.share({
          files: [file],
          title: 'Pagaré PresMon',
          text,
        });
        return;
      }
      if (channel === 'whatsapp') {
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      } else {
        const subject = encodeURIComponent('Pagaré — ' + (borrower?.fullName ?? '') + ' (PresMon)');
        window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(text)}`;
      }
      toast(
        channel === 'whatsapp'
          ? 'PDF descargado. Se abrió WhatsApp para que lo envíes adjunto.'
          : 'PDF descargado. Adjúntalo desde tu correo al enviar el mensaje.',
        'info',
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast(err instanceof Error ? err.message : 'Error compartiendo el pagaré', 'error');
    }
  };

  const handleCancel = async () => {
    if (!session) return;
    if (!window.confirm('¿Cancelar este préstamo?')) return;
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
        description={`${borrower?.documentType ?? ''} ${borrower?.documentNumber ?? ''} · ${FREQUENCY_LABELS[loan.frequency]} · ${loan.interestRatePercent}% por periodo · inicio ${formatDateShort(loan.startDate)}`}
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
                <Button variant="ghost" size="sm" className="text-red-500 hover:bg-red-50" onClick={() => void handleCancel()}>
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

      <h2 className="mt-6 mb-2 font-semibold text-slate-700">Plan de pagos</h2>
      <TableWrap>
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
              <TD>
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
              </TD>
            </TR>
          ))}
        </TBody>
      </TableWrap>

      <PaymentDialog open={payOpen} onClose={() => setPayOpen(false)} loan={loan} />
    </div>
  );
}
