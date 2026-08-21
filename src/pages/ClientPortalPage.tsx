import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudCheck, Globe, HardDrive, Loader2, SearchX } from 'lucide-react';
import type { Tenant } from '../db/models';
import { db } from '../db/db';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input, Label, Select } from '../components/ui/input';
import { FREQUENCY_LABELS } from '../lib/financialCalculations';
import { formatCOP, formatDateShort, todayStr } from '../lib/format';

interface LoanDetail {
  id: string;
  status: string;
  balance: number;
  nextDue: string | null;
  nextAmount: number;
  overdueCount: number;
  frequencyLabel: string;
  totalInstallments: number;
}

interface LookupOutcome {
  borrowerName: string;
  loans: LoanDetail[];
}

interface LoanRow {
  loanId: string;
  status: string;
  balanceRemaining: number;
  frequency: string;
  totalInstallments: number;
}

interface InstRow {
  status: string;
  dueDate: string;
  totalAmountWithLateFee: number;
  amountPaid: number;
  installmentNumber: number;
}

async function getFs() {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  const { initializeApp, getApps } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  return getFirestore(getApps()[0] ?? initializeApp(cfg));
}

function detailFrom(
  loan: { loanId: string; status: string; balanceRemaining: number; frequency: string; totalInstallments: number },
  insts: Array<{ status: string; dueDate: string; totalAmountWithLateFee: number; amountPaid: number; installmentNumber: number }>,
): LoanDetail {
  const sorted = [...insts].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const pending = sorted.filter((i) => i.status !== 'PAID');
  const next = pending[0];
  return {
    id: loan.loanId,
    status: String(loan.status),
    balance: Number(loan.balanceRemaining ?? 0),
    nextDue: next ? next.dueDate : null,
    nextAmount: next ? Math.max(0, Number(next.totalAmountWithLateFee) - Number(next.amountPaid)) : 0,
    overdueCount: sorted.filter((i) => i.status === 'OVERDUE').length,
    frequencyLabel: FREQUENCY_LABELS[loan.frequency as keyof typeof FREQUENCY_LABELS] ?? '',
    totalInstallments: loan.totalInstallments,
  };
}

export default function ClientPortalPage() {
  const today = todayStr();
  const cloudMode = loadFirebaseConfig() !== null;

  const localTenants = useLiveQuery(
    () => db.tenants.where('status').equals('ACTIVE').toArray() as Promise<Tenant[]>,
    [],
  );

  const [portalTenants, setPortalTenants] = useState<Tenant[]>([]);
  const [sourceNote, setSourceNote] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [phoneLast4, setPhoneLast4] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupOutcome | null>(null);

  useEffect(() => {
    void (async () => {
      if (cloudMode) {
        try {
          const fs = await getFs();
          if (fs) {
            const { collection, getDocs, query, where } = await import('firebase/firestore');
            const snap = await getDocs(query(collection(fs, 'tenants'), where('status', '==', 'ACTIVE')));
            const rows = snap.docs
              .map((d) => d.data() as unknown as Tenant)
              .filter((t) => t.tenantId && t.clientPortalEnabled);
            setPortalTenants(rows);
            setSourceNote('Consultando en tiempo real desde la nube');
            return;
          }
        } catch {
          /* sin conexión: se usa la copia local */
        }
      }
      setPortalTenants((localTenants ?? []).filter((t) => t.clientPortalEnabled));
      setSourceNote(cloudMode ? 'Sin conexión: usando datos sincronizados locales' : 'Datos locales del dispositivo');
    })();
  }, [cloudMode, localTenants]);

  const lookupLocal = useCallback(async (tid: string, doc: string): Promise<LookupOutcome | null> => {
    const borrower = await db.borrowers.where('[tenantId+documentNumber]').equals([tid, doc]).first();
    if (!borrower || borrower.phone.slice(-4) !== phoneLast4.trim()) return null;
    const loans = (await db.loans.where('borrowerId').equals(borrower.borrowerId).toArray()).filter(
      (l) => l.status !== 'CANCELLED',
    );
    if (loans.length === 0) return { borrowerName: borrower.fullName, loans: [] };
    const detailed: LoanDetail[] = [];
    for (const loan of loans) {
      const insts = await db.installments.where('loanId').equals(loan.loanId).toArray();
      detailed.push(detailFrom(loan, insts));
    }
    return { borrowerName: borrower.fullName, loans: detailed };
  }, [phoneLast4]);

  const lookupCloud = useCallback(async (tid: string, doc: string): Promise<LookupOutcome | 'unavailable' | null> => {
    const fs = await getFs();
    if (!fs) return 'unavailable';
    const { collection, getDocs, query, where } = await import('firebase/firestore');
    const bSnap = await getDocs(query(collection(fs, 'borrowers'), where('tenantId', '==', tid)));
    const match = bSnap.docs.map((d) => d.data() as Record<string, unknown>).find(
      (b) => String(b.documentNumber) === doc,
    );
    if (!match) return null;
    if (String(match.phone ?? '').slice(-4) !== phoneLast4.trim()) return null;
    const lSnap = await getDocs(query(collection(fs, 'loans'), where('borrowerId', '==', match.borrowerId)));
    const loanRows = lSnap.docs
      .map((d) => d.data() as unknown as LoanRow)
      .filter((l) => l.status !== 'CANCELLED');
    if (loanRows.length === 0) return { borrowerName: String(match.fullName), loans: [] };
    const detailed: LoanDetail[] = [];
    for (const loan of loanRows) {
      const iSnap = await getDocs(query(collection(fs, 'installments'), where('loanId', '==', loan.loanId)));
      detailed.push(detailFrom(loan, iSnap.docs.map((d) => d.data() as unknown as InstRow)));
    }
    return { borrowerName: String(match.fullName), loans: detailed };
  }, [phoneLast4]);

  async function handleSearch() {
    setError('');
    setResult(null);
    if (!tenantId || !documentNumber.trim()) {
      setError('Selecciona tu prestamista y escribe tu número de documento.');
      return;
    }
    if (phoneLast4.trim().length !== 4) {
      setError('Escribe los últimos 4 dígitos de tu teléfono.');
      return;
    }
    setLoading(true);
    try {
      let outcome: LookupOutcome | null | 'unavailable' = 'unavailable';
      if (cloudMode) {
        try {
          outcome = await lookupCloud(tenantId, documentNumber.trim());
        } catch {
          outcome = 'unavailable';
        }
      }
      if (outcome === 'unavailable') outcome = await lookupLocal(tenantId, documentNumber.trim());
      if (!outcome) {
        setError('No encontramos un cliente con esos datos. Verifica documento y teléfono.');
        return;
      }
      if (outcome.loans.length === 0) {
        setError('No tienes préstamos activos con esta organización.');
        return;
      }
      setResult(outcome);
    } finally {
      setLoading(false);
    }
  }

  const sourceIcon = useMemo(() => (sourceNote.startsWith('Consultando') ? CloudCheck : HardDrive), [sourceNote]);

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
                <Button className="w-full" onClick={() => void handleSearch()} disabled={loading}>
                  {loading ? <Loader2 size={15} className="animate-spin" /> : null}
                  {loading ? 'Consultando…' : 'Consultar'}
                </Button>
                <p className="flex items-center justify-center gap-1.5 text-[10px] text-slate-400">
                  {(() => {
                    const Icon = sourceIcon;
                    return <Icon size={11} />;
                  })()}
                  {sourceNote}
                </p>
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
                        Plan: {l.totalInstallments} cuotas {l.frequencyLabel.toLowerCase()}es · consulta
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
