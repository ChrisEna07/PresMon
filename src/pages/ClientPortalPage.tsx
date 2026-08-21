import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Globe, SearchX } from 'lucide-react';
import { db } from '../db/db';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input, Label, Select } from '../components/ui/input';
import { FREQUENCY_LABELS } from '../lib/financialCalculations';
import { formatCOP, formatDateShort, todayStr } from '../lib/format';

export default function ClientPortalPage() {
  const today = todayStr();
  const tenants = useLiveQuery(
    () => db.tenants.where('status').equals('ACTIVE').toArray(),
    [],
  );
  const portalTenants = useMemo(
    () => (tenants ?? []).filter((t) => t.clientPortalEnabled),
    [tenants],
  );

  const [tenantId, setTenantId] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [phoneLast4, setPhoneLast4] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    borrowerName: string;
    loans: Array<{
      id: string;
      status: string;
      balance: number;
      nextDue: string | null;
      nextAmount: number;
      overdueCount: number;
      frequency: string;
      totalInstallments: number;
    }>;
  } | null>(null);

  async function handleSearch() {
    setError('');
    setResult(null);
    if (!tenantId || !documentNumber.trim()) {
      setError('Selecciona tu prestamista y escribe tu número de documento.');
      return;
    }
    const borrower = await db.borrowers
      .where('[tenantId+documentNumber]')
      .equals([tenantId, documentNumber.trim()])
      .first();
    if (!borrower) {
      setError('No encontramos un cliente con ese documento.');
      return;
    }
    if (borrower.phone.slice(-4) !== phoneLast4.trim()) {
      setError('Los últimos 4 dígitos del teléfono no coinciden.');
      return;
    }
    const loans = await db.loans.where('borrowerId').equals(borrower.borrowerId).toArray();
    const visible = loans.filter((l) => l.status !== 'CANCELLED');
    if (visible.length === 0) {
      setError('No tienes préstamos activos con esta organización.');
      return;
    }
    const detailed = [];
    for (const loan of visible) {
      const insts = (
        await db.installments.where('loanId').equals(loan.loanId).toArray()
      ).sort((a, b) => a.installmentNumber - b.installmentNumber);
      const pending = insts.filter((i) => i.status !== 'PAID');
      const next = pending[0];
      detailed.push({
        id: loan.loanId,
        status: loan.status,
        balance: loan.balanceRemaining,
        nextDue: next ? next.dueDate : null,
        nextAmount: next ? Math.max(0, next.totalAmountWithLateFee - next.amountPaid) : 0,
        overdueCount: insts.filter((i) => i.status === 'OVERDUE').length,
        frequency: FREQUENCY_LABELS[loan.frequency],
        totalInstallments: loan.totalInstallments,
      });
    }
    setResult({ borrowerName: borrower.fullName, loans: detailed });
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500 text-white">
            <Globe size={22} />
          </div>
          <h1 className="text-xl font-bold text-white">Portal del Cliente</h1>
          <p className="text-xs text-slate-400">PresMon by ChrizDev · consulta tu crédito</p>
        </div>

        {portalTenants.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <SearchX size={32} className="text-slate-300" />
              <p className="font-semibold text-slate-700">Portal no disponible</p>
              <p className="max-w-xs text-xs text-slate-500">
                El autoservicio para clientes está deshabilitado. Tu prestamista debe activarlo
                (ENABLE_CLIENT_PORTAL).
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Consulta tu estado de cuenta</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label>Tu prestamista</Label>
                  <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                    <option value="">— Selecciona —</option>
                    {portalTenants.map((t) => (
                      <option key={t.tenantId} value={t.tenantId}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>Número de documento</Label>
                  <Input
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    placeholder="Ej: 1020304050"
                  />
                </div>
                <div>
                  <Label>Últimos 4 dígitos de tu teléfono</Label>
                  <Input
                    value={phoneLast4}
                    onChange={(e) => setPhoneLast4(e.target.value)}
                    maxLength={4}
                    placeholder="1234"
                  />
                </div>
                {error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{error}</p>
                )}
                <Button className="w-full" onClick={() => void handleSearch()}>
                  Consultar
                </Button>
              </CardContent>
            </Card>

            {result && (
              <div className="mt-4 space-y-3">
                <p className="text-center text-sm text-slate-300">
                  Hola, <strong>{result.borrowerName}</strong>. Estos son tus créditos:
                </p>
                {result.loans.map((l) => (
                  <Card key={l.id}>
                    <CardContent className="space-y-2 py-4">
                      <div className="flex items-center justify-between">
                        <Badge variant={l.status === 'PAID' ? 'success' : l.overdueCount > 0 ? 'danger' : 'info'}>
                          {l.status === 'PAID'
                            ? 'Pagado'
                            : l.status === 'IN_DEFAULT'
                              ? 'En mora'
                              : 'Activo'}
                        </Badge>
                        {l.overdueCount > 0 && (
                          <span className="text-xs font-semibold text-red-500">
                            {l.overdueCount} cuota(s) vencida(s)
                          </span>
                        )}
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">Saldo pendiente</span>
                        <strong>{formatCOP(l.balance)}</strong>
                      </div>
                      {l.nextDue && l.status !== 'PAID' && (
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">Próxima cuota</span>
                          <span>
                            {formatDateShort(l.nextDue)} ·{' '}
                            <strong>{formatCOP(l.nextAmount)}</strong>
                          </span>
                        </div>
                      )}
                      <p className="border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                        Plan: {l.totalInstallments} cuotas {l.frequency.toLowerCase()}es · consulta
                        hecha {today}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        <p className="mt-5 text-center text-[11px] text-slate-500">
          ¿Eres el administrador?{' '}
          <a href="/login" className="font-semibold text-emerald-400 hover:underline">
            Inicia sesión aquí
          </a>
        </p>
      </div>
    </div>
  );
}
