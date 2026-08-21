import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Ban, Eye, HandCoins, X } from 'lucide-react';
import type { Borrower, Installment, Loan, LoanStatus } from '../db/models';
import { db, saveLoan } from '../db/db';
import { useAuth } from '../store/auth';
import { FREQUENCY_LABELS } from '../lib/financialCalculations';
import { logAudit } from '../lib/auditLogger';
import { formatCOP, formatDateShort } from '../lib/format';
import { PageHeader, EmptyState } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs } from '../components/ui/tabs';

const STATUS_LABEL: Record<LoanStatus, string> = {
  ACTIVE: 'Activo',
  PAID: 'Pagado',
  IN_DEFAULT: 'En mora',
  CANCELLED: 'Cancelado',
};
const STATUS_VARIANT: Record<LoanStatus, 'success' | 'muted' | 'danger' | 'outline'> = {
  ACTIVE: 'success',
  PAID: 'muted',
  IN_DEFAULT: 'danger',
  CANCELLED: 'outline',
};

export default function LoansPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const tenantId = session?.tenantId ?? '';
  const [filter, setFilter] = useState('all');

  const loans = useLiveQuery(
    () => (tenantId ? db.loans.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Loan[])),
    [tenantId],
  );
  const borrowers = useLiveQuery(
    () => (tenantId ? db.borrowers.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Borrower[])),
    [tenantId],
  );
  const installments = useLiveQuery(
    () =>
      tenantId ? db.installments.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Installment[]),
    [tenantId],
  );

  const borrowerMap = useMemo(
    () => new Map((borrowers ?? []).map((b) => [b.borrowerId, b])),
    [borrowers],
  );

  const overdueByLoan = useMemo(() => {
    const map = new Map<string, number>();
    (installments ?? [])
      .filter((i) => i.status === 'OVERDUE')
      .forEach((i) => map.set(i.loanId, (map.get(i.loanId) ?? 0) + 1));
    return map;
  }, [installments]);

  const counts = useMemo(() => {
    const c = { all: (loans ?? []).length, active: 0, mora: 0, paid: 0, cancelled: 0 };
    (loans ?? []).forEach((l) => {
      if (l.status === 'ACTIVE') c.active++;
      if (l.status === 'IN_DEFAULT') c.mora++;
      if (l.status === 'PAID') c.paid++;
      if (l.status === 'CANCELLED') c.cancelled++;
    });
    return c;
  }, [loans]);

  const filtered = useMemo(() => {
    return (loans ?? []).filter((l) => {
      if (filter === 'all') return true;
      if (filter === 'active') return l.status === 'ACTIVE';
      if (filter === 'mora') return l.status === 'IN_DEFAULT';
      if (filter === 'paid') return l.status === 'PAID';
      if (filter === 'cancelled') return l.status === 'CANCELLED';
      return true;
    }).sort((a, b) => b.startDate.localeCompare(a.startDate));
  }, [loans, filter]);

  async function cancelLoan(loan: Loan) {
    if (!session) return;
    if (!window.confirm('¿Cancelar este préstamo? Quedará marcado como CANCELADO.')) return;
    await saveLoan({ ...loan, status: 'CANCELLED' });
    await logAudit({
      tenantId,
      action: 'LOAN_CANCELLED',
      actorId: session.userId,
      actorName: session.displayName,
      entityId: loan.loanId,
      entityType: 'loans',
      payloadSnapshot: { saldoAlCancelar: loan.balanceRemaining },
    });
  }

  return (
    <div>
      <PageHeader
        title="Préstamos"
        description="Cartera completa de la organización"
        actions={
          <Link to="/loans/new">
            <Button size="sm">
              <HandCoins size={14} /> Nuevo préstamo
            </Button>
          </Link>
        }
      />

      <Tabs
        className="mb-4"
        value={filter}
        onChange={setFilter}
        items={[
          { key: 'all', label: 'Todos', count: counts.all },
          { key: 'active', label: 'Activos', count: counts.active },
          { key: 'mora', label: 'En mora', count: counts.mora },
          { key: 'paid', label: 'Pagados', count: counts.paid },
          { key: 'cancelled', label: 'Cancelados', count: counts.cancelled },
        ]}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={HandCoins}
          title="No hay préstamos aquí"
          description="Crea un préstamo desde el simulador para generar su plan de pagos y pagaré."
          action={
            <Link to="/loans/new">
              <Button size="sm">
                <HandCoins size={14} /> Crear préstamo
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {filtered.map((loan) => {
            const borrower = borrowerMap.get(loan.borrowerId);
            const overdue = overdueByLoan.get(loan.loanId) ?? 0;
            const progress =
              loan.totalPayableAmount > 0
                ? Math.min(
                    100,
                    Math.round(
                      ((loan.totalPayableAmount - loan.balanceRemaining) /
                        loan.totalPayableAmount) *
                        100,
                    ),
                  )
                : 0;
            return (
              <div
                key={loan.loanId}
                className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                onClick={() => navigate(`/loans/${loan.loanId}`)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-800">
                      {borrower?.fullName ?? 'Cliente eliminado'}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {borrower ? `${borrower.documentType} ${borrower.documentNumber}` : ''} ·{' '}
                      {formatDateShort(loan.startDate)}
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[loan.status]}>{STATUS_LABEL[loan.status]}</Badge>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] tracking-wide text-slate-400 uppercase">Capital</p>
                    <p className="text-sm font-bold text-slate-700">
                      {formatCOP(loan.principalAmount)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] tracking-wide text-slate-400 uppercase">Saldo</p>
                    <p className="text-sm font-bold text-emerald-700">
                      {formatCOP(loan.balanceRemaining)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] tracking-wide text-slate-400 uppercase">Cuotas</p>
                    <p className="text-sm font-bold text-slate-700">
                      {loan.totalInstallments} × {FREQUENCY_LABELS[loan.frequency]}
                    </p>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={
                        loan.status === 'IN_DEFAULT'
                          ? 'h-full rounded-full bg-red-500'
                          : 'h-full rounded-full bg-emerald-500'
                      }
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">{progress}% recaudado</span>
                    <span className="flex items-center gap-2">
                      {overdue > 0 && (
                        <span className="inline-flex items-center gap-1 font-semibold text-red-500">
                          <AlertTriangle size={11} /> {overdue} en mora
                        </span>
                      )}
                      <span className="font-semibold text-slate-500">{loan.interestRatePercent}%</span>
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex justify-end gap-1 border-t border-slate-100 pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/loans/${loan.loanId}`);
                    }}
                  >
                    <Eye size={13} /> Ver detalle
                  </Button>
                  {(loan.status === 'ACTIVE' || loan.status === 'IN_DEFAULT') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:bg-red-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        void cancelLoan(loan);
                      }}
                    >
                      <Ban size={13} /> Cancelar
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
