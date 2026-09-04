import type { PlanInstallment, ServicePlan } from '../db/models';
import { addDaysStr, diffDays, nextMonthlyDue, todayStr } from './format';

export interface MonthlyInvoiceResult {
  /** Indica si el cobro de cloud está configurado e incluido en la factura mensual. */
  cloudIncluded: boolean;
  /** Tarifa mensual de cloud configurada. */
  cloudFee: number;
  /** Fecha del próximo vencimiento mensual de cloud (YYYY-MM-DD). */
  nextCloudDue: string;
  /** Indica si la mensualidad de cloud está vencida o por cobrar en el ciclo. */
  cloudIsDue: boolean;
  /** Días de vencimiento de cloud (< 0 vencida, 0 hoy, > 0 faltan días). */
  cloudDaysRemaining: number;
  /** Días de mora acumulados en cloud (0 si no está vencida). */
  cloudDaysOverdue: number;

  /** Cuotas de la app pendientes que se suman a la factura (vencidas o por vencer pronto). */
  pendingInstallments: PlanInstallment[];
  /** Suma total de las cuotas de app pendientes. */
  installmentsAmount: number;

  /** Monto TOTAL consolidado de la factura mensual exigible. */
  totalInvoiceAmount: number;

  /** Monto vencido exigible a la fecha de hoy (mora estricta). */
  totalOverdueAmount: number;

  /** Número máximo de días de mora entre cualquier concepto pendiente. */
  maxDaysOverdue: number;

  /** Supera los 5 días de vencimiento (gatillo para bloqueo automático). */
  isOverdueMoreThan5Days: boolean;

  /** Resumen de conceptos que componen la factura para mostrar en banners. */
  summaryText: string;
}

/**
 * Calcula la factura mensual de una organización:
 * 1. Evalúa el switch `cloudServiceIncluded`. Si está activo y la mensualidad cloud
 *    no está pagada (`cloudPaidThrough < nextCloudDue`), suma la mensualidad cloud.
 * 2. Revisa las cuotas pendientes del plan de la app (`status === 'PENDING'`).
 *    Suma todas las cuotas vencidas y las que vencen en el ciclo actual (hasta 7 días adelante).
 * 3. Calcula los días de mora acumulados y si se superan los 5 días de vencimiento.
 */
export function computeMonthlyInvoice(
  plan: ServicePlan | null | undefined,
  today: string = todayStr(),
): MonthlyInvoiceResult {
  const result: MonthlyInvoiceResult = {
    cloudIncluded: false,
    cloudFee: 0,
    nextCloudDue: '',
    cloudIsDue: false,
    cloudDaysRemaining: 0,
    cloudDaysOverdue: 0,
    pendingInstallments: [],
    installmentsAmount: 0,
    totalInvoiceAmount: 0,
    totalOverdueAmount: 0,
    maxDaysOverdue: 0,
    isOverdueMoreThan5Days: false,
    summaryText: 'Sin cobros pendientes',
  };

  if (!plan) return result;

  const cloudFee = Math.max(0, Number(plan.cloudMonthlyFee) || 0);
  const cloudIncluded = plan.cloudServiceIncluded === true && cloudFee > 0;
  const billingDay = Math.min(28, Math.max(1, Number(plan.cloudBillingDay) || 1));
  const paidThrough = String(plan.cloudPaidThrough ?? '');
  const nextDue = nextMonthlyDue(billingDay, paidThrough);
  const cloudDiff = diffDays(today, nextDue); // negativo si nextDue < today (vencida)
  const cloudIsDue = cloudIncluded && (!paidThrough || nextDue > paidThrough) && cloudDiff <= 7;
  const cloudDaysOverdue = cloudIncluded && cloudDiff < 0 ? Math.abs(cloudDiff) : 0;

  result.cloudIncluded = cloudIncluded;
  result.cloudFee = cloudFee;
  result.nextCloudDue = nextDue;
  result.cloudIsDue = cloudIsDue;
  result.cloudDaysRemaining = cloudDiff;
  result.cloudDaysOverdue = cloudDaysOverdue;

  // Cuotas de la app:
  // Consideramos pendientes aquellas cuotas que ya vencieron (dueDate < today)
  // o que vencen dentro del horizonte del mes/ciclo (dueDate <= today + 7 días).
  const horizon = addDaysStr(today, 7);
  const allInstallments = plan.installments ?? [];
  const relevantPendings = allInstallments
    .filter((inst) => inst.status === 'PENDING' && inst.dueDate <= horizon)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  result.pendingInstallments = relevantPendings;
  result.installmentsAmount = relevantPendings.reduce(
    (sum, inst) => sum + (Number(inst.amount) || 0),
    0,
  );

  // Componente Cloud exigible en la factura mensual:
  const cloudCharge = cloudIsDue ? cloudFee : 0;
  result.totalInvoiceAmount = result.installmentsAmount + cloudCharge;

  // Cálculo de mora estricta (solo lo que ya venció antes o en el día de hoy):
  let maxOverdueDays = 0;
  let overdueAmount = 0;

  if (cloudDaysOverdue > 0) {
    overdueAmount += cloudFee;
    if (cloudDaysOverdue > maxOverdueDays) maxOverdueDays = cloudDaysOverdue;
  }

  for (const inst of relevantPendings) {
    if (inst.dueDate < today) {
      overdueAmount += Number(inst.amount) || 0;
      const instOverdueDays = Math.max(0, diffDays(inst.dueDate, today));
      if (instOverdueDays > maxOverdueDays) maxOverdueDays = instOverdueDays;
    }
  }

  result.totalOverdueAmount = overdueAmount;
  result.maxDaysOverdue = maxOverdueDays;
  result.isOverdueMoreThan5Days = maxOverdueDays > 5;

  // Resumen textual para banners y diálogos
  const parts: string[] = [];
  if (relevantPendings.length > 0) {
    parts.push(
      `${relevantPendings.length} cuota(s) app ($${result.installmentsAmount.toLocaleString('es-CO')})`,
    );
  }
  if (cloudCharge > 0) {
    parts.push(`Servicio Cloud ($${cloudCharge.toLocaleString('es-CO')})`);
  }
  result.summaryText = parts.length > 0 ? parts.join(' + ') : 'Sin cobros pendientes';

  return result;
}
