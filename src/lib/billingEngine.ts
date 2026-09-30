import type { PlanInstallment, ServicePlan } from '../db/models';
import { addDaysStr, addMonthsStr, diffDays, nextMonthlyDue, todayStr } from './format';

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
  /** Cantidad de ciclos mensuales de cloud exigibles en esta factura. */
  cloudCyclesCount: number;
  /** Cantidad de ciclos mensuales de cloud en mora estricta. */
  overdueCloudCyclesCount: number;

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
 * Obtiene la fecha del primer vencimiento pendiente de cloud para un plan.
 * Si nunca se ha registrado un pago (`cloudPaidThrough` vacío), se evalúa la fecha
 * de suscripción / inicio del servicio cloud (por defecto la fecha de creación de la cuenta u organización).
 * El día de cobro mensual se rige por dicho aniversario día a día (ej. 26 de agosto -> 26 de cada mes).
 */
export function getFirstUnpaidCloudDue(
  plan: ServicePlan,
  today: string = todayStr(),
): string {
  // Fecha base de inicio de la relación comercial o del servicio cloud
  const startDate = (plan.cloudStartDate && plan.cloudStartDate.length >= 10)
    ? plan.cloudStartDate.slice(0, 10)
    : (plan.createdAt && plan.createdAt.length >= 10 ? plan.createdAt.slice(0, 10) : today);

  const regDay = Math.min(28, Math.max(1, parseInt(startDate.slice(8, 10), 10) || 1));
  const billingDay = plan.cloudBillingDay ? Math.min(28, Math.max(1, Number(plan.cloudBillingDay))) : regDay;
  const dayStr = String(billingDay).padStart(2, '0');
  const paidThrough = String(plan.cloudPaidThrough ?? '').trim();

  if (paidThrough && paidThrough.length >= 10) {
    const baseDate = `${paidThrough.slice(0, 8)}${dayStr}`;
    const nextDate = addMonthsStr(baseDate, 1);
    return `${nextDate.slice(0, 8)}${dayStr}`;
  }

  // Si nunca se ha pagado, el cobro inicial exigible parte del mes de registro con su día aniversario
  const startMonthStr = startDate.slice(0, 7);
  return `${startMonthStr}-${dayStr}`;
}

/**
 * Calcula la factura mensual de una organización:
 * 1. Evalúa el switch `cloudServiceIncluded`. Si está activo y la mensualidad cloud
 *    no está pagada, acumula TODOS los ciclos mensuales vencidos y no pagados
 *    (ej. 2 meses vencidos a $30.000 = $60.000).
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
    cloudCyclesCount: 0,
    overdueCloudCyclesCount: 0,
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
  const dayStr = String(billingDay).padStart(2, '0');
  const horizon = addDaysStr(today, 7);

  const overdueCycles: string[] = [];
  const upcomingCycles: string[] = [];
  let firstUnpaidDue = '';

  if (cloudIncluded) {
    firstUnpaidDue = getFirstUnpaidCloudDue(plan, today);
    let currDue = firstUnpaidDue;
    let iterations = 0;

    while (currDue <= horizon && iterations < 60) {
      iterations++;
      if (currDue <= today) {
        overdueCycles.push(currDue);
      } else {
        upcomingCycles.push(currDue);
        break; // Solo el ciclo inmediato futuro entra en el horizonte de cobro
      }
      const nextMonth = addMonthsStr(currDue, 1);
      currDue = `${nextMonth.slice(0, 8)}${dayStr}`;
    }
  }

  // Cuotas de la app:
  // Consideramos pendientes aquellas cuotas que ya vencieron (dueDate < today)
  // o que vencen dentro del horizonte del mes/ciclo (dueDate <= today + 7 días)
  // y que aún tengan saldo pendiente por pagar (amount - paidAmount > 0).
  const allInstallments = plan.installments ?? [];
  const relevantPendings = allInstallments
    .filter((inst) => {
      if (inst.status !== 'PENDING') return false;
      const remaining = Math.max(0, (Number(inst.amount) || 0) - (Number(inst.paidAmount) || 0));
      return remaining > 0 && inst.dueDate <= horizon;
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  result.pendingInstallments = relevantPendings;
  result.installmentsAmount = relevantPendings.reduce((sum, inst) => {
    const remaining = Math.max(0, (Number(inst.amount) || 0) - (Number(inst.paidAmount) || 0));
    return sum + remaining;
  }, 0);

  // Componente Cloud:
  // Si hay mensualidades vencidas, se cobran TODAS las mensualidades vencidas acumuladas.
  // Si no hay vencidas pero hay una próxima dentro del horizonte (7 días), se cobra 1 ciclo.
  let cloudCharge = 0;
  let cloudIsDue = false;
  let totalCloudCycles = 0;

  if (overdueCycles.length > 0) {
    totalCloudCycles = overdueCycles.length;
    cloudCharge = totalCloudCycles * cloudFee;
    cloudIsDue = true;
  } else if (upcomingCycles.length > 0) {
    totalCloudCycles = 1;
    cloudCharge = cloudFee;
    cloudIsDue = true;
  }

  const nextCloudDue = overdueCycles.length > 0
    ? overdueCycles[0]
    : (upcomingCycles[0] || firstUnpaidDue);

  let cloudDaysOverdue = 0;
  let cloudDaysRemaining = 0;
  if (nextCloudDue) {
    const diff = diffDays(today, nextCloudDue);
    cloudDaysRemaining = diff;
    if (diff < 0) {
      cloudDaysOverdue = Math.abs(diff);
    }
  }

  result.cloudIncluded = cloudIncluded;
  result.cloudFee = cloudFee;
  result.nextCloudDue = nextCloudDue;
  result.cloudIsDue = cloudIsDue;
  result.cloudDaysRemaining = cloudDaysRemaining;
  result.cloudDaysOverdue = cloudDaysOverdue;
  result.cloudCyclesCount = totalCloudCycles;
  result.overdueCloudCyclesCount = overdueCycles.length;

  result.totalInvoiceAmount = result.installmentsAmount + cloudCharge;

  // Cálculo de mora estricta (solo lo que ya venció antes o en el día de hoy):
  let maxOverdueDays = 0;
  let overdueAmount = 0;

  if (overdueCycles.length > 0) {
    overdueAmount += overdueCycles.length * cloudFee;
    if (cloudDaysOverdue > maxOverdueDays) maxOverdueDays = cloudDaysOverdue;
  }

  for (const inst of relevantPendings) {
    if (inst.dueDate < today) {
      const remaining = Math.max(0, (Number(inst.amount) || 0) - (Number(inst.paidAmount) || 0));
      overdueAmount += remaining;
      const instOverdueDays = Math.max(0, diffDays(inst.dueDate, today));
      if (instOverdueDays > maxOverdueDays) maxOverdueDays = instOverdueDays;
    }
  }

  result.totalOverdueAmount = overdueAmount;
  result.maxDaysOverdue = maxOverdueDays;
  result.isOverdueMoreThan5Days = maxOverdueDays > 5;

  // Resumen textual para banners, modal y comprobantes
  const parts: string[] = [];
  if (relevantPendings.length > 0) {
    const hasAbonos = relevantPendings.some((inst) => (Number(inst.paidAmount) || 0) > 0);
    if (hasAbonos) {
      const totalPaid = relevantPendings.reduce(
        (sum, inst) => sum + (Number(inst.paidAmount) || 0),
        0,
      );
      parts.push(
        `${relevantPendings.length} cuota(s) app (Saldo por pagar $${result.installmentsAmount.toLocaleString('es-CO')} · Abonado $${totalPaid.toLocaleString('es-CO')})`,
      );
    } else {
      parts.push(
        `${relevantPendings.length} cuota(s) app ($${result.installmentsAmount.toLocaleString('es-CO')})`,
      );
    }
  }
  if (cloudCharge > 0) {
    if (totalCloudCycles > 1) {
      parts.push(`Servicio Cloud (${totalCloudCycles} mensualidades: $${cloudCharge.toLocaleString('es-CO')})`);
    } else {
      parts.push(`Servicio Cloud ($${cloudCharge.toLocaleString('es-CO')})`);
    }
  }
  result.summaryText = parts.length > 0 ? parts.join(' + ') : 'Sin cobros pendientes';

  return result;
}
