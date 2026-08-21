import { useMemo } from 'react';
import type { Borrower, Installment, Loan } from '../db/models';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Calculator,
  HandCoins,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { db } from '../db/db';
import { useAuth } from '../store/auth';
import { StatCard, PageHeader, EmptyState } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { addDaysStr, formatCOP, formatDateShort, todayStr } from '../lib/format';

export default function DashboardPage() {
  const { session } = useAuth();
  const tenantId = session?.tenantId ?? '';
  const today = todayStr();
  const in7Days = addDaysStr(today, 7);

  const loans = useLiveQuery(
    () => (tenantId ? db.loans.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Loan[])),
    [tenantId],
  );
  const installments = useLiveQuery(
    () =>
      tenantId ? db.installments.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Installment[]),
    [tenantId],
  );
  const borrowers = useLiveQuery(
    () =>
      tenantId ? db.borrowers.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Borrower[]),
    [tenantId],
  );

  const stats = useMemo(() => {
    const activeLoans = (loans ?? []).filter(
      (l) => l.status === 'ACTIVE' || l.status === 'IN_DEFAULT',
    );
    const carteraActiva = activeLoans.reduce((s, l) => s + l.balanceRemaining, 0);
    const dueToday = (installments ?? []).filter(
      (i) => i.dueDate === today && i.status !== 'PAID',
    );
    const porCobrarHoy = dueToday.reduce(
      (s, i) => s + Math.max(0, i.totalAmountWithLateFee - i.amountPaid),
      0,
    );
    const overdue = (installments ?? []).filter((i) => i.status === 'OVERDUE');
    const moraTotal = overdue.reduce(
      (s, i) => s + Math.max(0, i.totalAmountWithLateFee - i.amountPaid),
      0,
    );
    return {
      carteraActiva,
      cobrosHoy: dueToday.length,
      porCobrarHoy,
      enMora: overdue.length,
      moraTotal,
      prestatarios: (borrowers ?? []).length,
      prestamosActivos: activeLoans.length,
    };
  }, [loans, installments, borrowers, today]);

  const upcoming = useMemo(() => {
    return (installments ?? [])
      .filter((i) => i.dueDate > today && i.dueDate <= in7Days && i.status !== 'PAID')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 6);
  }, [installments, today, in7Days]);

  const borrowerName = (borrowerId: string) =>
    (borrowers ?? []).find((b) => b.borrowerId === borrowerId)?.fullName ?? '—';

  const loanBorrowerName = (loanId: string) => {
    const loan = (loans ?? []).find((l) => l.loanId === loanId);
    return loan ? borrowerName(loan.borrowerId) : '—';
  };

  return (
    <div>
      <PageHeader
        title={`Hola, ${session?.displayName ?? ''}`}
        description={`Panel de ${session?.tenantName} · ${today}`}
        actions={
          <>
            <Link to="/loans/new">
              <Button size="sm">
                <HandCoins size={14} /> Nuevo préstamo
              </Button>
            </Link>
            <Link to="/borrowers">
              <Button size="sm" variant="outline">
                <UserPlus size={14} /> Prestatario
              </Button>
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Cartera activa"
          value={formatCOP(stats.carteraActiva)}
          hint={`${stats.prestamosActivos} préstamos activos`}
          icon={Wallet}
          tone="emerald"
        />
        <StatCard
          label="Por cobrar hoy"
          value={formatCOP(stats.porCobrarHoy)}
          hint={`${stats.cobrosHoy} cuotas vencen hoy`}
          icon={CalendarClock}
          tone="sky"
        />
        <StatCard
          label="En mora"
          value={formatCOP(stats.moraTotal)}
          hint={`${stats.enMora} cuotas vencidas`}
          icon={AlertTriangle}
          tone="red"
        />
        <StatCard
          label="Prestatarios"
          value={String(stats.prestatarios)}
          hint="Clientes registrados"
          icon={Users}
          tone="slate"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Próximos cobros (7 días)</CardTitle>
            <Link
              to="/collections"
              className="flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
            >
              Ver todos <ArrowRight size={12} />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcoming.length === 0 && (
              <EmptyState icon={CalendarClock} title="Sin cobros próximos" description="No hay cuotas que venzan en los próximos 7 días." />
            )}
            {upcoming.map((i) => (
              <div
                key={i.installmentId}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-700">
                    {loanBorrowerName(i.loanId)}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Cuota {i.installmentNumber} · vence {formatDateShort(i.dueDate)}
                  </p>
                </div>
                <span className="text-sm font-bold whitespace-nowrap text-slate-800">
                  {formatCOP(Math.max(0, i.totalAmountWithLateFee - i.amountPaid))}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Cartera en mora</CardTitle>
            <Badge variant="danger">{stats.enMora} cuotas</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {(installments ?? []).filter((i) => i.status === 'OVERDUE').length === 0 && (
              <EmptyState icon={AlertTriangle} title="¡Sin mora!" description="Ninguna cuota está vencida. La cartera está al día." />
            )}
            {(installments ?? [])
              .filter((i) => i.status === 'OVERDUE')
              .sort((a, b) => b.daysOverdue - a.daysOverdue)
              .slice(0, 6)
              .map((i) => (
                <div
                  key={i.installmentId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-red-100 bg-red-50/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-700">
                      {loanBorrowerName(i.loanId)}
                    </p>
                    <p className="text-[11px] text-red-500">
                      {i.daysOverdue} días de mora · venció {formatDateShort(i.dueDate)}
                    </p>
                  </div>
                  <span className="text-sm font-bold whitespace-nowrap text-red-600">
                    {formatCOP(Math.max(0, i.totalAmountWithLateFee - i.amountPaid))}
                  </span>
                </div>
              ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4 border-emerald-200 bg-gradient-to-r from-emerald-50 to-white">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-emerald-600 p-2.5 text-white">
              <Calculator size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-800">Simulador con tabla de amortización</p>
              <p className="text-xs text-slate-500">
                Calcula interés total, ganancia y el pagaré PDF antes de prestar un peso.
              </p>
            </div>
          </div>
          <Link to="/simulator">
            <Button variant="secondary" size="sm">
              Abrir simulador <ArrowRight size={14} />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
