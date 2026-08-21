import type { Installment, Loan } from '../db/models';
import { db, stamp, nowISO } from '../db/db';
import { logAudit } from './auditLogger';
import { riskBadgeFromScore, round2 } from './financialCalculations';

export interface PaymentResult {
  applied: number;
  loanFullyPaid: boolean;
}

export async function adjustCreditScore(
  borrowerId: string,
  delta: number,
  countDefault = false,
): Promise<void> {
  if (!borrowerId) return;
  const borrower = await db.borrowers.get(borrowerId);
  if (!borrower) return;
  borrower.creditScore = Math.max(0, Math.min(100, borrower.creditScore + delta));
  borrower.riskBadge = riskBadgeFromScore(borrower.creditScore);
  if (countDefault) borrower.defaultCount += 1;
  await db.borrowers.put(stamp(borrower));
}

export async function applyPaymentToLoan(
  loanId: string,
  amount: number,
  actor: { id: string; name: string },
): Promise<PaymentResult> {
  const value = round2(Math.max(0, amount));
  if (value <= 0) throw new Error('El valor del abono debe ser mayor a cero.');

  let applied = 0;
  let loanFullyPaid = false;
  let tenantIdOfLoan = '';
  let borrowerIdOfLoan = '';

  await db.transaction('rw', [db.loans, db.installments], async () => {
    const loan = await db.loans.get(loanId);
    if (!loan) throw new Error('Préstamo no encontrado.');
    const insts = await db.installments.where('loanId').equals(loanId).toArray();
    insts.sort((a, b) => a.installmentNumber - b.installmentNumber);

    let remaining = value;
    const updated: Installment[] = [];

    for (const inst of insts) {
      if (remaining <= 0) break;
      if (inst.status === 'PAID') continue;
      const dueNow = round2(inst.baseAmountDue + inst.lateFeeCharged);
      const pendingOfInst = round2(dueNow - inst.amountPaid);
      if (pendingOfInst <= 0) continue;
      const pay = Math.min(remaining, pendingOfInst);
      inst.amountPaid = round2(inst.amountPaid + pay);
      remaining = round2(remaining - pay);
      if (inst.amountPaid >= dueNow - 0.01) {
        inst.status = 'PAID';
        inst.paidAt = nowISO();
      } else {
        inst.status = 'PARTIAL';
        inst.paidAt = null;
      }
      updated.push(inst);
    }

    if (updated.length > 0) await db.installments.bulkPut(updated.map((i) => stamp(i)));
    applied = round2(value - remaining);

    const fresh = await db.installments.where('loanId').equals(loanId).toArray();
    const totalDue = round2(fresh.reduce((s, i) => s + i.baseAmountDue + i.lateFeeCharged, 0));
    const totalPaid = round2(fresh.reduce((s, i) => s + i.amountPaid, 0));
    const balance = Math.max(0, round2(totalDue - totalPaid));
    const allPaid = fresh.every((i) => i.status === 'PAID');
    const anyOverdue = fresh.some((i) => i.status === 'OVERDUE');

    const nextStatus: Loan['status'] = allPaid ? 'PAID' : anyOverdue ? 'IN_DEFAULT' : 'ACTIVE';
    loan.balanceRemaining = balance;
    loan.status = nextStatus;
    await db.loans.put(stamp(loan));

    tenantIdOfLoan = loan.tenantId;
    borrowerIdOfLoan = loan.borrowerId;
    loanFullyPaid = allPaid;
  });

  if (applied > 0) {
    await logAudit({
      tenantId: tenantIdOfLoan,
      action: 'PAYMENT_APPLIED',
      actorId: actor.id,
      actorName: actor.name,
      entityId: loanId,
      entityType: 'loans',
      payloadSnapshot: {
        montoAplicado: applied,
        prestamoPagadoCompleto: loanFullyPaid,
      },
    });
  }

  if (loanFullyPaid) {
    await adjustCreditScore(borrowerIdOfLoan, 5);
  }

  return { applied, loanFullyPaid };
}


