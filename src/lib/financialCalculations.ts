import type { DocumentType, Frequency, Installment, Loan, RiskBadge } from '../db/models';
import { addDaysStr, addMonthsStr, diffDays } from './format';

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  DAILY: 'Diario',
  WEEKLY: 'Semanal',
  BIWEEKLY: 'Quincenal',
  MONTHLY: 'Mensual',
};

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  CC: 'Cédula de Ciudadanía',
  CE: 'Cédula de Extranjería',
  TI: 'Tarjeta de Identidad',
  NIT: 'NIT',
  PAS: 'Pasaporte',
};

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface LoanInput {
  principalAmount: number;
  interestRatePercent: number;
  frequency: Frequency;
  totalInstallments: number;
  startDate: string;
  dailyLateFeePercent: number;
  fixedLateFeeAmount: number;
}

export interface ScheduleLine {
  installmentNumber: number;
  dueDate: string;
  principalAmount: number;
  interestAmount: number;
  baseAmountDue: number;
}

export interface LoanSummary {
  totalInterest: number;
  totalPayable: number;
  avgInstallment: number;
  profitMarginPct: number;
}

export function addPeriod(iso: string, freq: Frequency, times: number): string {
  if (freq === 'MONTHLY') return addMonthsStr(iso, times);
  const step = freq === 'DAILY' ? 1 : freq === 'WEEKLY' ? 7 : 14;
  return addDaysStr(iso, step * times);
}

export function computeSchedule(input: LoanInput): ScheduleLine[] {
  const n = Math.max(1, Math.floor(input.totalInstallments));
  const principal = Math.max(0, input.principalAmount);
  const interestPer = round2((principal * (input.interestRatePercent || 0)) / 100);
  const principalPer = round2(principal / n);
  const lines: ScheduleLine[] = [];
  for (let i = 1; i <= n; i++) {
    const p = i === n ? round2(principal - principalPer * (n - 1)) : principalPer;
    lines.push({
      installmentNumber: i,
      dueDate: addPeriod(input.startDate, input.frequency, i),
      principalAmount: p,
      interestAmount: interestPer,
      baseAmountDue: round2(p + interestPer),
    });
  }
  return lines;
}

export function summarize(principal: number, lines: ScheduleLine[]): LoanSummary {
  const totalInterest = round2(lines.reduce((s, l) => s + l.interestAmount, 0));
  const totalPayable = round2(lines.reduce((s, l) => s + l.baseAmountDue, 0));
  return {
    totalInterest,
    totalPayable,
    avgInstallment: lines.length ? round2(totalPayable / lines.length) : 0,
    profitMarginPct: principal > 0 ? round2((totalInterest / principal) * 100) : 0,
  };
}

export function daysOverdue(dueDateISO: string, todayISO: string): number {
  return Math.max(0, diffDays(dueDateISO, todayISO));
}

export function computeLateFee(
  baseAmountDue: number,
  dailyPercent: number,
  fixedPerDay: number,
  days: number,
): number {
  if (days <= 0) return 0;
  return round2(((baseAmountDue * (dailyPercent || 0)) / 100) * days + (fixedPerDay || 0) * days);
}

export interface RecomputedState {
  daysOverdue: number;
  lateFeeCharged: number;
  totalAmountWithLateFee: number;
  status: Installment['status'];
}

export function recomputeInstallmentState(
  inst: Pick<
    Installment,
    'baseAmountDue' | 'amountPaid' | 'status' | 'dueDate' | 'lateFeeCharged'
  >,
  loan: Pick<Loan, 'dailyLateFeePercent' | 'fixedLateFeeAmount'>,
  todayISO: string,
): RecomputedState {
  const fullyPaid = inst.amountPaid >= inst.baseAmountDue - 0.01;
  if (fullyPaid || inst.status === 'PAID') {
    return {
      daysOverdue: 0,
      lateFeeCharged: inst.lateFeeCharged,
      totalAmountWithLateFee: inst.baseAmountDue,
      status: 'PAID',
    };
  }
  const days = daysOverdue(inst.dueDate, todayISO);
  const fee = days > 0 ? computeLateFee(inst.baseAmountDue, loan.dailyLateFeePercent, loan.fixedLateFeeAmount, days) : 0;
  let status: Installment['status'] = 'PENDING';
  if (days > 0) status = 'OVERDUE';
  else if (inst.amountPaid > 0) status = 'PARTIAL';
  return {
    daysOverdue: days,
    lateFeeCharged: fee,
    totalAmountWithLateFee: round2(inst.baseAmountDue + fee),
    status,
  };
}

export function riskBadgeFromScore(score: number): RiskBadge {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}
