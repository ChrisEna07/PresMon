import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarClock, HandCoins } from 'lucide-react';
import type { Borrower, Installment, Loan } from '../db/models';
import { db } from '../db/db';
import { useAuth } from '../store/auth';
import { addDaysStr, formatCOP, formatDateShort, todayStr } from '../lib/format';
import { PageHeader, EmptyState } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tabs } from '../components/ui/tabs';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { PaymentDialog } from './LoanDetailPage';

export default function CollectionsPage() {
  const { session } = useAuth();
  const tenantId = session?.tenantId ?? '';
  const today = todayStr();
  const [tab, setTab] = useState('today');
  const [payTarget, setPayTarget] = useState<{ loanId: string; installment?: Installment } | null>(
    null,
  );

  const installments = useLiveQuery(
    () =>
      tenantId ? db.installments.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Installment[]),
    [tenantId],
  );
  const loans = useLiveQuery(
    () => (tenantId ? db.loans.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Loan[])),
    [tenantId],
  );
  const borrowers = useLiveQuery(
    () => (tenantId ? db.borrowers.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Borrower[])),
    [tenantId],
  );

  const loanMap = useMemo(() => new Map((loans ?? []).map((l) => [l.loanId, l])), [loans]);
  const borrowerMap = useMemo(() => new Map((borrowers ?? []).map((b) => [b.borrowerId, b])), [borrowers]);

  const in7 = addDaysStr(today, 7);

  const groups = useMemo(() => {
    const unpaid = (installments ?? []).filter((i) => i.status !== 'PAID');
    return {
      today: unpaid.filter((i) => i.dueDate === today),
      overdue: unpaid.filter((i) => i.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      upcoming: unpaid.filter((i) => i.dueDate > today && i.dueDate <= in7).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    };
  }, [installments, today, in7]);

  const rows = tab === 'today' ? groups.today : tab === 'overdue' ? groups.overdue : groups.upcoming;

  return (
    <div>
      <PageHeader title="Cobros" description="Gestión diaria de recaudo y cartera vencida" />

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'today', label: 'Hoy', count: groups.today.length },
          { key: 'overdue', label: 'Vencidas', count: groups.overdue.length },
          { key: 'upcoming', label: 'Próximos 7 días', count: groups.upcoming.length },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nada por aquí"
          description={
            tab === 'overdue'
              ? '¡Excelente! No tienes cuotas vencidas.'
              : 'No hay cuotas en este rango de fechas.'
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Prestatario</TH>
            <TH>Cuota</TH>
            <TH>Vencimiento</TH>
            <TH className="text-right">Base</TH>
            <TH className="text-right">Mora</TH>
            <TH className="text-right">Pendiente</TH>
            <TH></TH>
          </THead>
          <TBody>
            {rows.map((i) => {
              const loan = loanMap.get(i.loanId);
              const borrower = loan ? borrowerMap.get(loan.borrowerId) : undefined;
              const pending = Math.max(0, i.totalAmountWithLateFee - i.amountPaid);
              return (
                <TR key={i.installmentId} className={i.status === 'OVERDUE' ? 'bg-red-50/60' : ''}>
                  <TD>
                    <p className="font-medium text-slate-800">{borrower?.fullName ?? '—'}</p>
                    <p className="text-[11px] text-slate-400">{borrower?.phone}</p>
                  </TD>
                  <TD className="text-slate-600">
                    #{i.installmentNumber}
                    {loan && (
                      <span className="ml-1 text-[10px] text-slate-400">
                        de {loan.totalInstallments}
                      </span>
                    )}
                  </TD>
                  <TD className="text-slate-600">
                    {formatDateShort(i.dueDate)}
                    {i.status === 'OVERDUE' && (
                      <Badge variant="danger" className="ml-1.5">
                        {i.daysOverdue}d
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right text-slate-600">{formatCOP(i.baseAmountDue)}</TD>
                  <TD className="text-right text-red-500">
                    {i.lateFeeCharged > 0 ? `+${formatCOP(i.lateFeeCharged)}` : '—'}
                  </TD>
                  <TD className="text-right font-bold text-slate-800">{formatCOP(pending)}</TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      onClick={() => setPayTarget({ loanId: i.loanId, installment: i })}
                    >
                      <HandCoins size={13} /> Cobrar
                    </Button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </TableWrap>
      )}

      <PaymentDialog
        open={payTarget !== null}
        onClose={() => setPayTarget(null)}
        loan={payTarget ? loanMap.get(payTarget.loanId) : undefined}
        installment={payTarget?.installment}
      />
    </div>
  );
}
