import type { Installment, Loan } from '../db/models';
import { db, stamp } from '../db/db';
import { logAudit } from './auditLogger';
import { recomputeInstallmentState, round2 } from './financialCalculations';
import { adjustCreditScore } from './payments';
import { todayStr } from './format';

let running = false;
let lastRunDay = '';

export async function runMoraEvaluation(
  tenantId: string,
  actor: { id: string; name: string },
): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const today = todayStr();
    lastRunDay = today;
    const loans = await db.loans.where('tenantId').equals(tenantId).toArray();
    const evaluable = loans.filter((l) => l.status === 'ACTIVE' || l.status === 'IN_DEFAULT');
    let touchedInstallments = 0;

    for (const loan of evaluable) {
      const insts = await db.installments.where('loanId').equals(loan.loanId).toArray();
      insts.sort((a, b) => a.installmentNumber - b.installmentNumber);
      const changed: Installment[] = [];
      let becameOverdue = false;
      let feeDelta = 0;

      for (const inst of insts) {
        if (inst.status === 'PAID') continue;
        const st = recomputeInstallmentState(inst, loan, today);
        if (
          st.daysOverdue !== inst.daysOverdue ||
          st.lateFeeCharged !== inst.lateFeeCharged ||
          st.status !== inst.status
        ) {
          if (st.status === 'OVERDUE' && inst.status !== 'OVERDUE') becameOverdue = true;
          if (st.lateFeeCharged > inst.lateFeeCharged)
            feeDelta += round2(st.lateFeeCharged - inst.lateFeeCharged);
          inst.daysOverdue = st.daysOverdue;
          inst.lateFeeCharged = st.lateFeeCharged;
          inst.totalAmountWithLateFee = st.totalAmountWithLateFee;
          inst.status = st.status;
          changed.push(inst);
        }
      }

      if (changed.length > 0) {
        await db.installments.bulkPut(changed.map((i) => stamp(i)));
        touchedInstallments += changed.length;
      }

      const anyOverdue = insts.some((i) => i.status === 'OVERDUE');
      const allPaid = insts.every((i) => i.status === 'PAID');
      const nextStatus: Loan['status'] = allPaid ? 'PAID' : anyOverdue ? 'IN_DEFAULT' : 'ACTIVE';
      const previousStatus = loan.status;
      if (nextStatus !== loan.status) {
        loan.status = nextStatus;
        await db.loans.put(stamp(loan));
      }
      if (previousStatus !== 'IN_DEFAULT' && nextStatus === 'IN_DEFAULT') {
        await adjustCreditScore(loan.borrowerId, -10, true);
      }

      if (becameOverdue || feeDelta > 0) {
        const overdueCount = insts.filter((i) => i.status === 'OVERDUE').length;
        const totalFees = round2(insts.reduce((s, i) => s + i.lateFeeCharged, 0));
        await logAudit({
          tenantId,
          action: 'LATE_FEE_TRIGGERED',
          actorId: actor.id,
          actorName: actor.name,
          entityId: loan.loanId,
          entityType: 'loans',
          payloadSnapshot: {
            cuotasVencidas: overdueCount,
            recargoCausadoEnEstaEvaluacion: feeDelta,
            recargoAcumulado: totalFees,
            fechaEvaluacion: today,
          },
        });
      }
    }
    return touchedInstallments;
  } finally {
    running = false;
  }
}

export function startDayWatch(
  tenantId: string,
  actor: { id: string; name: string },
): () => void {
  const tick = () => {
    if (todayStr() !== lastRunDay) {
      void runMoraEvaluation(tenantId, actor);
    }
  };
  const interval = window.setInterval(tick, 60 * 1000);
  const onFocus = () => {
    void runMoraEvaluation(tenantId, actor);
  };
  window.addEventListener('focus', onFocus);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener('focus', onFocus);
  };
}
