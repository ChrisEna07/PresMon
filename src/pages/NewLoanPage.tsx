import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileDown, HandCoins, Save } from 'lucide-react';
import type { Borrower, Frequency, Loan } from '../db/models';
import { db, saveBorrower, saveInstallments, saveLoan } from '../db/db';
import { useAuth } from '../store/auth';
import {
  computeSchedule,
  summarize,
  type LoanInput,
} from '../lib/financialCalculations';
import { logAudit } from '../lib/auditLogger';
import { generateContractPDF } from '../lib/generateContractPDF';
import { downloadBlob } from '../lib/crypto';
import { savePdfBlob } from '../db/db';
import { uid } from '../lib/id';
import { todayStr } from '../lib/format';
import { PageHeader } from '../components/misc';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Label, Select } from '../components/ui/input';
import { AmortizationTable, LivePreview, SimulatorForm } from '../components/LoanSimulator';
import { useToast } from '../components/ui/toast';

export default function NewLoanPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const tenantId = session?.tenantId ?? '';

  const borrowers = useLiveQuery(
    () =>
      tenantId
        ? db.borrowers.where('tenantId').equals(tenantId).toArray()
        : Promise.resolve([] as Borrower[]),
    [tenantId],
  );

  const [borrowerId, setBorrowerId] = useState('');
  const [generatePdf, setGeneratePdf] = useState(true);
  const [saving, setSaving] = useState(false);
  const [input, setInput] = useState<LoanInput>({
    principalAmount: 1000000,
    interestRatePercent: 5,
    frequency: 'WEEKLY' as Frequency,
    totalInstallments: 10,
    startDate: todayStr(),
    dailyLateFeePercent: 0.5,
    fixedLateFeeAmount: 0,
  });

  const lines = useMemo(() => computeSchedule(input), [input]);
  const summary = useMemo(
    () => summarize(input.principalAmount, lines),
    [input.principalAmount, lines],
  );

  const selectedBorrower = (borrowers ?? []).find((b) => b.borrowerId === borrowerId);

  async function handleSave() {
    if (!session) return;
    if (!borrowerId) {
      toast('Selecciona un prestatario.', 'error');
      return;
    }
    if (input.principalAmount <= 0) {
      toast('El monto debe ser mayor a cero.', 'error');
      return;
    }
    if (input.totalInstallments < 1) {
      toast('Debe haber al menos una cuota.', 'error');
      return;
    }
    setSaving(true);
    try {
      const loanId = uid();
      const now = new Date().toISOString();
      const loan: Loan = {
        loanId,
        tenantId,
        borrowerId,
        principalAmount: input.principalAmount,
        interestRatePercent: input.interestRatePercent,
        frequency: input.frequency,
        totalInstallments: input.totalInstallments,
        interestAmount: summary.totalInterest,
        totalPayableAmount: summary.totalPayable,
        balanceRemaining: summary.totalPayable,
        dailyLateFeePercent: input.dailyLateFeePercent,
        fixedLateFeeAmount: input.fixedLateFeeAmount,
        status: 'ACTIVE',
        startDate: input.startDate,
        contractPdfBlobRef: null,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'PENDING',
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
            createdAt: now,
            updatedAt: now,
            syncStatus: 'PENDING' as const,
          })),
        );
        const borrower = await db.borrowers.get(borrowerId);
        if (borrower) {
          borrower.totalLoansCount += 1;
          await saveBorrower(borrower);
        }
      });

      await logAudit({
        tenantId,
        action: 'LOAN_CREATED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: loanId,
        entityType: 'loans',
        payloadSnapshot: {
          prestatario: selectedBorrower?.fullName ?? borrowerId,
          monto: input.principalAmount,
          tasaPeriodo: input.interestRatePercent,
          cuotas: input.totalInstallments,
          frecuencia: input.frequency,
          moraDiaria: input.dailyLateFeePercent,
          recargoFijo: input.fixedLateFeeAmount,
          totalAPagar: summary.totalPayable,
        },
      });

      if (generatePdf && selectedBorrower) {
        try {
          const blob = generateContractPDF({
            tenant: (await db.tenants.get(tenantId))!,
            borrower: selectedBorrower,
            loan,
            schedule: lines,
            generatedBy: session.displayName,
          });
          const blobId = uid();
          await savePdfBlob({
            blobId,
            loanId,
            tenantId,
            data: blob,
            createdAt: new Date().toISOString(),
          });
          loan.contractPdfBlobRef = blobId;
          await saveLoan(loan);
          downloadBlob(blob, `pagare-${selectedBorrower.documentNumber}-${loanId.slice(0, 6)}.pdf`);
          await logAudit({
            tenantId,
            action: 'PDF_GENERATED',
            actorId: session.userId,
            actorName: session.displayName,
            entityId: loanId,
            entityType: 'loans',
            payloadSnapshot: { documento: 'PAGARÉ', prestatario: selectedBorrower.fullName },
          });
        } catch {
          toast('El préstamo se creó, pero falló la generación del PDF.', 'error');
        }
      }

      toast('Préstamo creado con su plan de pagos.', 'success');
      navigate(`/loans/${loanId}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Nuevo préstamo"
        description="Configura las condiciones y revisa la amortización en vivo antes de guardar."
      />

      <Card className="mb-4">
        <CardContent className="py-3">
          <Label>Prestatario *</Label>
          <Select value={borrowerId} onChange={(e) => setBorrowerId(e.target.value)}>
            <option value="">— Selecciona un cliente —</option>
            {(borrowers ?? [])
              .slice()
              .sort((a, b) => a.fullName.localeCompare(b.fullName))
              .map((b) => (
                <option key={b.borrowerId} value={b.borrowerId}>
                  {b.fullName} · {b.documentType} {b.documentNumber} · Riesgo {b.riskBadge}
                </option>
              ))}
          </Select>
          {selectedBorrower && (
            <p className="mt-1.5 text-[11px] text-slate-400">
              Score {selectedBorrower.creditScore}/100 · {selectedBorrower.city} ·{' '}
              {selectedBorrower.phone}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Condiciones del crédito</CardTitle>
          </CardHeader>
          <CardContent>
            <SimulatorForm value={input} onChange={setInput} />
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={generatePdf}
                onChange={(e) => setGeneratePdf(e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-emerald-600"
              />
              <FileDown size={15} className="text-slate-400" />
              Generar Pagaré PDF automáticamente
            </label>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => void handleSave()} disabled={saving} size="lg">
                <Save size={16} />
                {saving ? 'Guardando…' : 'Crear préstamo'}
              </Button>
              <Button variant="outline" size="lg" onClick={() => navigate('/loans')}>
                Cancelar
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <LivePreview
            input={input}
            avgInstallment={summary.avgInstallment}
            totalInterest={summary.totalInterest}
            totalPayable={summary.totalPayable}
            profitMarginPct={summary.profitMarginPct}
          />
          <AmortizationTable lines={lines} />
        </div>
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-[11px] text-slate-400">
        <HandCoins size={12} />
        El plan de cuotas se guarda localmente (IndexedDB) y funciona sin internet.
      </p>
    </div>
  );
}
