import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSearchParams } from 'react-router-dom';
import {
  BadgeCheck,
  CheckCircle2,
  Clock3,
  CloudCheck,
  FileImage,
  Globe,
  HardDrive,
  Loader2,
  Package,
  SearchX,
  ShieldAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import type { DocumentType, LoanRequest, Tenant } from '../db/models';
import { db } from '../db/db';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';
import { uid } from '../lib/id';
import { compressImageFile } from '../lib/imageSupport';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input, Label, Select } from '../components/ui/input';
import { FREQUENCY_LABELS } from '../lib/financialCalculations';
import { formatCOP, formatDateShort, formatDateTime, todayStr } from '../lib/format';

const TERMS_VERSION = 'v2026-08-2';

const TERMINOS_Y_CLAUSULAS = `TÉRMINOS Y CLÁUSULAS DE LA SOLICITUD DE PRÉSTAMO

1. VERACIDAD DE LA INFORMACIÓN. Declaro que los datos personales y la documentación aportada son reales, completos y me pertenecen. Sabermente falsear información puede acarrear el rechazo definitivo de la solicitud y acciones legales.

2. AUTORIZACIÓN DE TRATAMIENTO DE DATOS (Ley 1581 de 2012). Autorizo al prestamista y a la plataforma PresMon by ChrizDev a recopilar, almacenar y usar mis datos personales únicamente para el estudio, otorgamiento, administración y cobro del crédito.

3. GARANTÍA. La fotografía aportada muestra el bien que entrego en garantía junto con mi persona. Declaro que el bien es de mi propiedad, se encuentra descrito fielmente y está libre de pleitos. LA ENTREGA FÍSICA DE ESTE BIEN ES CONDICIÓN DEL DESEMBOLSO: si al momento del desembolso no presento el bien fotografiado, el prestamista podrá negar la entrega del dinero sin responsabilidad alguna.

4. NATURALEZA DE LA SOLICITUD. Enviar esta solicitud NO genera obligación de desembolso. La aprobación depende de la verificación del soporte fotográfico y del análisis del prestamista, quien puede aprobar, ajustar o rechazar sin necesidad de justificación ante mí.

5. OBLIGACIÓN DE PAGO. Si mi solicitud es aprobada, me obligo a pagar el capital más los intereses según el plan de cuotas acordado, en las fechas pactadas.

6. MORA. Acepto que el incumplimiento genera los intereses de mora o recargos pactados por el prestamista sobre cada cuota vencida, desde el día siguiente al vencimiento.

7. COMUNICACIONES. Autorizo el contacto por llamada, SMS o WhatsApp a los números suministrados para recordatorios de pago y gestión de cobro.

8. ACEPTACIÓN ELECTRÓNICA. Al marcar la casilla de aceptación y enviar la solicitud, manifiesto haber leído y aceptado íntegramente estos términos, con plena validez jurídica equivalente a mi firma manuscrita, quedando registrados fecha y hora de la aceptación.`;

interface FieldErrors {
  fullName?: string;
  documentNumber?: string;
  phone?: string;
  address?: string;
  amountRequested?: string;
  guaranteeDescription?: string;
}

interface LoanDetail {
  id: string;
  status: string;
  balance: number;
  nextDue: string | null;
  nextAmount: number;
  overdueCount: number;
  frequencyLabel: string;
  totalInstallments: number;
  principalAmount?: number;
  totalPayable?: number;
  paidCount?: number;
}

interface RequestSummary {
  requestId: string;
  amountRequested: number;
  status: LoanRequest['status'];
  createdAt: string;
  rejectReason?: string;
  referenceCode?: string;
}

interface LookupOutcome {
  borrowerName: string;
  loans: LoanDetail[];
  requests: RequestSummary[];
}

interface LoanRow {
  loanId: string;
  status: string;
  balanceRemaining: number;
  frequency: string;
  totalInstallments: number;
  principalAmount?: number;
  totalPayableAmount?: number;
}

interface InstRow {
  status: string;
  dueDate: string;
  totalAmountWithLateFee: number;
  amountPaid: number;
  installmentNumber: number;
}

/**
 * Referencia corta de consulta (sin caracteres ambiguos 0/O/1/I/L).
 * El cliente la usa para verificar el estado de su solicitud y crédito
 * sin necesidad de documento ni teléfono.
 */
function generateReference(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const rnd = new Uint8Array(6);
  crypto.getRandomValues(rnd);
  let out = '';
  for (const b of rnd) out += alphabet[b % alphabet.length];
  return out;
}

function normalizeRef(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function getFs() {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  const { initializeApp, getApps } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  return getFirestore(getApps()[0] ?? initializeApp(cfg));
}

function detailFrom(
  loan: {
    loanId: string;
    status: string;
    balanceRemaining: number;
    frequency: string;
    totalInstallments: number;
    principalAmount?: number;
    totalPayableAmount?: number;
  },
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
    principalAmount: loan.principalAmount != null ? Number(loan.principalAmount) : undefined,
    totalPayable: loan.totalPayableAmount != null ? Number(loan.totalPayableAmount) : undefined,
    paidCount: sorted.filter((i) => i.status === 'PAID').length,
  };
}

function requestBadgeVariant(status: LoanRequest['status']) {
  return status === 'APPROVED' ? 'success' : status === 'REJECTED' ? 'danger' : 'info';
}
function requestStatusLabel(status: LoanRequest['status']) {
  return status === 'APPROVED' ? 'Aprobada' : status === 'REJECTED' ? 'Rechazada' : 'En revisión';
}

export default function ClientPortalPage() {
  const today = todayStr();
  const cloudMode = loadFirebaseConfig() !== null;
  const [searchParams] = useSearchParams();
  /** Enlace generado para UNA entidad específica: /portal?t=<tenantId> */
  const linkedTenantId = searchParams.get('t') ?? '';

  const localTenants = useLiveQuery(
    () => db.tenants.where('status').equals('ACTIVE').toArray() as Promise<Tenant[]>,
    [],
  );

  const [tab, setTab] = useState<'lookup' | 'request'>('lookup');

  const [portalTenants, setPortalTenants] = useState<Tenant[]>([]);
  const [sourceNote, setSourceNote] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [phoneLast4, setPhoneLast4] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupOutcome | null>(null);
  const [lookupMode, setLookupMode] = useState<'doc' | 'ref'>('doc');
  const [refCode, setRefCode] = useState('');

  useEffect(() => {
    void (async () => {
      if (cloudMode) {
        try {
          const fs = await getFs();
          if (fs) {
            const { doc, getDoc } = await import('firebase/firestore');
            if (linkedTenantId) {
              // El enlace apunta a UNA entidad: lectura directa de su documento.
              const snap = await getDoc(doc(fs, 'tenants', linkedTenantId));
              const data = snap.exists() ? (snap.data() as unknown as Tenant) : null;
              const rows =
                data && data.tenantId && data.clientPortalEnabled && data.status === 'ACTIVE'
                  ? [data]
                  : [];
              setPortalTenants(rows);
              if (rows[0]) setTenantId(rows[0].tenantId);
              setSourceNote('Consultando en tiempo real desde la nube');
              return;
            }
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
      const localActive = (localTenants ?? []).filter((t) => t.clientPortalEnabled);
      const rows = linkedTenantId
        ? localActive.filter((t) => t.tenantId === linkedTenantId)
        : localActive;
      setPortalTenants(rows);
      if (rows[0]) setTenantId(rows[0].tenantId);
      setSourceNote(cloudMode ? 'Sin conexión: usando datos sincronizados locales' : 'Datos locales del dispositivo');
    })();
  }, [cloudMode, localTenants, linkedTenantId]);

  const lockedTenant = portalTenants.find((t) => t.tenantId === linkedTenantId);

  // ---------- Solicitud de crédito ----------
  const [reqFullName, setReqFullName] = useState('');
  const [reqDocType, setReqDocType] = useState<DocumentType>('CC');
  const [reqDocumentNumber, setReqDocumentNumber] = useState('');
  const [reqPhone, setReqPhone] = useState('');
  const [reqAddress, setReqAddress] = useState('');
  const [reqAmount, setReqAmount] = useState('');
  const [reqNote, setReqNote] = useState('');
  const [guaranteeDescription, setGuaranteeDescription] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [supportPreview, setSupportPreview] = useState<string | null>(null);
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [sentFolio, setSentFolio] = useState<string | null>(null);
  const [copiedRef, setCopiedRef] = useState(false);
  const [sendWarning, setSendWarning] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function validateRequestForm(): FieldErrors {
    const errs: FieldErrors = {};
    const name = reqFullName.trim();
    if (name.length < 5 || name.split(/\s+/).filter(Boolean).length < 2 || !/^[A-Za-zÁÉÍÓÚáéíóúÑñüÜ' .-]+$/.test(name)) {
      errs.fullName = 'Escribe tu nombre y apellido completos (solo letras).';
    }
    if (!/^\d{5,15}$/.test(reqDocumentNumber.trim())) {
      errs.documentNumber = 'Solo números, entre 5 y 15 dígitos.';
    }
    if (!/^\d{7,15}$/.test(reqPhone.trim())) {
      errs.phone = 'Solo números, entre 7 y 15 dígitos (ej: 3101234567).';
    }
    if (reqAddress.trim().length < 8) {
      errs.address = 'Escribe una dirección válida (mínimo 8 caracteres).';
    }
    const amountNum = Number(reqAmount);
    if (!Number.isFinite(amountNum) || amountNum < 50000 || amountNum > 20000000) {
      errs.amountRequested = 'Monto entre $50.000 y $20.000.000.';
    }
    if (guaranteeDescription.trim().length < 5) {
      errs.guaranteeDescription = 'Describe el objeto que dejas en garantía (mínimo 5 caracteres).';
    }
    return errs;
  }

  async function handleSupportChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError('');
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const compressed = await compressImageFile(f);
      setSupportPreview(compressed.dataUrl);
      setSupportFile(f);
    } catch (err) {
      setSupportPreview(null);
      setSupportFile(null);
      setError(err instanceof Error ? err.message : 'No se pudo procesar la imagen.');
    }
  }

  async function handleSendRequest() {
    setError('');
    setSentFolio(null);
    setSendWarning('');
    if (!tenantId) {
      setError('Abre el enlace de tu prestamista para identificar tu organización.');
      return;
    }
    const errs = validateRequestForm();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setError('Revisa los campos marcados en rojo.');
      return;
    }
    if (!supportFile || !supportPreview) {
      setError('Tómate la foto junto al objeto que dejas como garantía: es obligatoria.');
      return;
    }
    if (!termsAccepted) {
      setError('Debes leer y aceptar los términos y cláusulas del préstamo.');
      return;
    }

    setSending(true);
    try {
      const nowIso = new Date().toISOString();
      const requestId = uid();
      let borrowerId: string | null = null;
      try {
        const localBorrower = await db.borrowers
          .where('[tenantId+documentNumber]')
          .equals([tenantId, reqDocumentNumber.trim()])
          .first();
        borrowerId = localBorrower?.borrowerId ?? null;
      } catch {
        /* best effort */
      }

      const record: LoanRequest = {
        requestId,
        tenantId,
        borrowerId,
        fullName: reqFullName.trim(),
        documentType: reqDocType,
        documentNumber: reqDocumentNumber.trim(),
        phone: reqPhone.trim(),
        address: reqAddress.trim(),
        note: reqNote.trim(),
        amountRequested: Math.round(Number(reqAmount)),
        guaranteeDescription: guaranteeDescription.trim(),
        termsAcceptedAt: nowIso,
        termsVersion: TERMS_VERSION,
        supportDataUrl: supportPreview,
        supportFileName: supportFile.name,
        referenceCode: generateReference(),
        status: 'PENDING',
        createdAt: nowIso,
        updatedAt: nowIso,
        syncStatus: 'PENDING',
      };

      let deliveredToCloud = false;
      if (cloudMode) {
        try {
          const fs = await getFs();
          if (fs) {
            const { doc, setDoc } = await import('firebase/firestore');
            await setDoc(doc(fs, 'loan_requests', requestId), { ...record, syncStatus: 'SYNCED' });
            deliveredToCloud = true;
          }
        } catch {
          deliveredToCloud = false;
        }
      }
      record.syncStatus = deliveredToCloud ? 'SYNCED' : 'PENDING';
      await db.loan_requests.put(record);

      setSentFolio(record.referenceCode ?? '');
      if (!deliveredToCloud) {
        setSendWarning(
          'Tu solicitud quedó guardada, pero este dispositivo no pudo contactar la nube. Notifica a tu prestamista por WhatsApp para garantizar su revisión.',
        );
      }
      // limpiar formulario
      setReqFullName('');
      setReqDocumentNumber('');
      setReqPhone('');
      setReqAddress('');
      setReqAmount('');
      setReqNote('');
      setSupportFile(null);
      setSupportPreview(null);
      setTermsAccepted(false);
      setFieldErrors({});
      setGuaranteeDescription('');
    } finally {
      setSending(false);
    }
  }

  // ---------- Consulta ----------
  const fetchRequestsLocal = useCallback(async (tid: string, doc: string): Promise<RequestSummary[]> => {
    const rows = (
      await db.loan_requests.where('[tenantId+documentNumber]').equals([tid, doc]).toArray()
    ).filter((r) => r.phone.slice(-4) === phoneLast4.trim());
    return rows.map((r) => ({
      requestId: r.requestId,
      amountRequested: r.amountRequested,
      status: r.status,
      createdAt: r.createdAt,
      rejectReason: r.rejectReason,
      referenceCode: r.referenceCode,
    }));
  }, [phoneLast4]);

  const fetchRequestsCloud = useCallback(async (tid: string, doc: string): Promise<RequestSummary[]> => {
    const fs = await getFs();
    if (!fs) return [];
    const { collection, getDocs, query, where } = await import('firebase/firestore');
    const snap = await getDocs(
      query(collection(fs, 'loan_requests'), where('tenantId', '==', tid), where('documentNumber', '==', doc)),
    );
    return snap.docs
      .map((d) => d.data() as unknown as LoanRequest)
      .filter((r) => String(r.phone ?? '').slice(-4) === phoneLast4.trim())
      .map((r) => ({
        requestId: r.requestId,
        amountRequested: Number(r.amountRequested),
        status: r.status,
        createdAt: String(r.createdAt),
        rejectReason: r.rejectReason,
        referenceCode: r.referenceCode,
      }));
  }, [phoneLast4]);

  /** Consulta por referencia (copia local del dispositivo). */
  const lookupByRefLocal = useCallback(
    async (code: string): Promise<LookupOutcome | null> => {
      const allowed = new Set(portalTenants.map((t) => t.tenantId));
      const rows = (await db.loan_requests.toArray())
        .filter((r) => normalizeRef(r.referenceCode ?? '') === code && allowed.has(r.tenantId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const req = rows[0];
      if (!req) return null;
      const loans: LoanDetail[] = [];
      if (req.status === 'APPROVED' && req.createdLoanId) {
        const loan = await db.loans.get(req.createdLoanId);
        if (loan && loan.status !== 'CANCELLED') {
          const insts = await db.installments.where('loanId').equals(loan.loanId).toArray();
          loans.push(detailFrom(loan, insts));
        }
      }
      return {
        borrowerName: req.fullName,
        loans,
        requests: [
          {
            requestId: req.requestId,
            amountRequested: req.amountRequested,
            status: req.status,
            createdAt: req.createdAt,
            rejectReason: req.rejectReason,
            referenceCode: req.referenceCode,
          },
        ],
      };
    },
    [portalTenants],
  );

  /** Consulta por referencia en tiempo real contra la nube. */
  const lookupByRefCloud = useCallback(
    async (code: string): Promise<LookupOutcome | 'unavailable' | null> => {
      const fs = await getFs();
      if (!fs) return 'unavailable';
      const { collection, doc, getDoc, getDocs, query, where } = await import('firebase/firestore');
      const snap = await getDocs(query(collection(fs, 'loan_requests'), where('referenceCode', '==', code)));
      const allowed = new Set(portalTenants.map((t) => t.tenantId));
      const rows = snap.docs
        .map((d) => d.data() as unknown as LoanRequest)
        .filter((r) => r.referenceCode && allowed.has(r.tenantId))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const req = rows[0];
      if (!req) return null;
      const loans: LoanDetail[] = [];
      if (req.status === 'APPROVED' && req.createdLoanId) {
        const lSnap = await getDoc(doc(fs, 'loans', req.createdLoanId));
        if (lSnap.exists()) {
          const loan = lSnap.data() as unknown as LoanRow;
          if (String(loan.status) !== 'CANCELLED') {
            const iSnap = await getDocs(
              query(collection(fs, 'installments'), where('loanId', '==', req.createdLoanId)),
            );
            loans.push(detailFrom(loan, iSnap.docs.map((d) => d.data() as unknown as InstRow)));
          }
        }
      }
      return {
        borrowerName: String(req.fullName),
        loans,
        requests: [
          {
            requestId: req.requestId,
            amountRequested: Number(req.amountRequested),
            status: req.status,
            createdAt: String(req.createdAt),
            rejectReason: req.rejectReason,
            referenceCode: req.referenceCode,
          },
        ],
      };
    },
    [portalTenants],
  );

  const lookupLocal = useCallback(async (tid: string, doc: string): Promise<LookupOutcome | null> => {
    const borrower = await db.borrowers.where('[tenantId+documentNumber]').equals([tid, doc]).first();
    if (!borrower || borrower.phone.slice(-4) !== phoneLast4.trim()) return null;
    const loans = (await db.loans.where('borrowerId').equals(borrower.borrowerId).toArray()).filter(
      (l) => l.status !== 'CANCELLED',
    );
    const detailed: LoanDetail[] = [];
    for (const loan of loans) {
      const insts = await db.installments.where('loanId').equals(loan.loanId).toArray();
      detailed.push(detailFrom(loan, insts));
    }
    const requests = await fetchRequestsLocal(tid, doc);
    return { borrowerName: borrower.fullName, loans: detailed, requests };
  }, [phoneLast4, fetchRequestsLocal]);

  const lookupCloud = useCallback(async (tid: string, doc: string): Promise<LookupOutcome | 'unavailable' | null> => {
    const fs = await getFs();
    if (!fs) return 'unavailable';
    const { collection, getDocs, query, where } = await import('firebase/firestore');
    const bSnap = await getDocs(query(collection(fs, 'borrowers'), where('tenantId', '==', tid)));
    const match = bSnap.docs.map((d) => d.data() as Record<string, unknown>).find(
      (b) => String(b.documentNumber) === doc,
    );
    const detailed: LoanDetail[] = [];
    let borrowerName = '';
    if (match && String(match.phone ?? '').slice(-4) === phoneLast4.trim()) {
      borrowerName = String(match.fullName);
      const lSnap = await getDocs(query(collection(fs, 'loans'), where('borrowerId', '==', match.borrowerId)));
      const loanRows = lSnap.docs
        .map((d) => d.data() as unknown as LoanRow)
        .filter((l) => l.status !== 'CANCELLED');
      for (const loan of loanRows) {
        const iSnap = await getDocs(query(collection(fs, 'installments'), where('loanId', '==', loan.loanId)));
        detailed.push(detailFrom(loan, iSnap.docs.map((d) => d.data() as unknown as InstRow)));
      }
    }
    const requests = await fetchRequestsCloud(tid, doc);
    if (!match && requests.length === 0) return null;
    return { borrowerName, loans: detailed, requests };
  }, [phoneLast4, fetchRequestsCloud]);

  async function handleSearch() {
    setError('');
    setResult(null);

    if (lookupMode === 'ref') {
      const code = normalizeRef(refCode);
      if (code.length < 6) {
        setError('Escribe la referencia completa de 6 caracteres (ej: K7M2QA).');
        return;
      }
      setLoading(true);
      try {
        let outcome: LookupOutcome | null | 'unavailable' = 'unavailable';
        if (cloudMode) {
          try {
            outcome = await lookupByRefCloud(code);
          } catch {
            outcome = 'unavailable';
          }
        }
        if (outcome === 'unavailable') outcome = await lookupByRefLocal(code);
        if (!outcome) {
          setError('No encontramos solicitudes con esa referencia. Verifícala con tu prestamista.');
          return;
        }
        setResult(outcome);
      } finally {
        setLoading(false);
      }
      return;
    }

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
        setError('No encontramos registros con esos datos. Verifica documento y teléfono.');
        return;
      }
      if (outcome.loans.length === 0 && outcome.requests.length === 0) {
        setError('No tienes créditos ni solicitudes registradas con esta organización.');
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
          <p className="text-xs text-slate-400">PresMon by ChrizDev · consulta y solicita tu crédito</p>
        </div>

        {portalTenants.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-2">
            <button
              onClick={() => setTab('lookup')}
              className={`cursor-pointer rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                tab === 'lookup' ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              Consultar mi crédito
            </button>
            <button
              onClick={() => setTab('request')}
              className={`cursor-pointer rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                tab === 'request' ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              Solicitar préstamo
            </button>
          </div>
        )}

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
        ) : tab === 'lookup' ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Consulta tu estado de cuenta</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setLookupMode('doc');
                      setError('');
                    }}
                    className={`cursor-pointer rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                      lookupMode === 'doc' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    Por documento
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLookupMode('ref');
                      setError('');
                    }}
                    className={`cursor-pointer rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                      lookupMode === 'ref' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    Por referencia
                  </button>
                </div>

                {lookupMode === 'doc' ? (
                  <>
                    {lockedTenant ? (
                      <div className="rounded-lg bg-emerald-50 px-3 py-2 text-center">
                        <p className="text-[10px] font-semibold tracking-wide text-emerald-600 uppercase">
                          Consultas de
                        </p>
                        <p className="font-bold text-emerald-800">{lockedTenant.name}</p>
                      </div>
                    ) : (
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
                    )}
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
                  </>
                ) : (
                  <>
                    <div>
                      <Label>Referencia de tu solicitud</Label>
                      <Input
                        value={refCode}
                        onChange={(e) => setRefCode(e.target.value.toUpperCase())}
                        maxLength={6}
                        placeholder="Ej: K7M2QA"
                        className="text-center font-mono text-lg tracking-[0.3em]"
                      />
                    </div>
                    <p className="rounded-lg bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-700">
                      Es el código que recibiste al enviar tu solicitud. Con él ves el estado, el
                      desembolso, tu saldo y la próxima cuota.
                    </p>
                  </>
                )}
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
                {result.borrowerName && (
                  <p className="text-center text-sm text-slate-300">
                    Hola, <strong>{result.borrowerName}</strong>. Estos son tus créditos:
                  </p>
                )}
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
                        <span className="text-slate-500">Desembolso</span>
                        <strong>{formatCOP(l.principalAmount ?? 0)}</strong>
                      </div>
                      {l.totalPayable != null && (
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">Total a pagar</span>
                          <strong>{formatCOP(l.totalPayable)}</strong>
                        </div>
                      )}
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
                        Cuotas pagadas: {l.paidCount ?? 0} de {l.totalInstallments} · plan{' '}
                        {l.frequencyLabel.toLowerCase()} · consulta hecha {today}
                      </p>
                    </CardContent>
                  </Card>
                ))}

                {result.requests.length > 0 && (
                  <>
                    <p className="pt-2 text-center text-sm text-slate-300">Tus solicitudes:</p>
                    {[...result.requests]
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                      .map((r) => (
                        <Card key={r.requestId}>
                          <CardContent className="space-y-2 py-4">
                            <div className="flex items-center justify-between">
                              <Badge variant={requestBadgeVariant(r.status)}>
                                {r.status === 'APPROVED' ? (
                                  <BadgeCheck size={11} />
                                ) : r.status === 'REJECTED' ? (
                                  <XCircle size={11} />
                                ) : (
                                  <Clock3 size={11} />
                                )}
                                {requestStatusLabel(r.status)}
                              </Badge>
                              <span className="font-mono text-[10px] font-bold tracking-wider text-slate-400">
                                Ref {r.referenceCode ?? r.requestId.slice(0, 6).toUpperCase()}
                              </span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-slate-500">Monto solicitado</span>
                              <strong>{formatCOP(r.amountRequested)}</strong>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-slate-500">Enviada</span>
                              <span className="text-xs">{formatDateTime(r.createdAt)}</span>
                            </div>
                            {r.status === 'APPROVED' && (
                              <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                <CheckCircle2 size={12} /> ¡Crédito aprobado! Tu prestamista coordinará
                                el desembolso contigo.
                              </p>
                            )}
                            {r.status === 'REJECTED' && (
                              <p className="flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-600">
                                <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                                {r.rejectReason
                                  ? `Motivo: ${r.rejectReason}`
                                  : 'Tu solicitud no fue aprobada. Contacta a tu prestamista.'}
                              </p>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Solicitud de préstamo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sentFolio && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
                  <p className="flex items-center justify-center gap-1.5 text-sm font-bold text-emerald-800">
                    <CheckCircle2 size={16} /> ¡Solicitud enviada con éxito!
                  </p>
                  <p className="mt-2 text-[10px] font-semibold tracking-wider text-emerald-600 uppercase">
                    Tu referencia de consulta
                  </p>
                  <div className="mt-0.5 flex items-center justify-center gap-2">
                    <span className="font-mono text-3xl font-bold tracking-[0.25em] text-emerald-900">
                      {sentFolio}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(sentFolio)
                          .then(() => {
                            setCopiedRef(true);
                            window.setTimeout(() => setCopiedRef(false), 2000);
                          })
                          .catch(() => undefined);
                      }}
                      className="cursor-pointer rounded-md bg-white px-2 py-1 text-[10px] font-bold text-emerald-700 shadow-sm hover:bg-emerald-100"
                    >
                      {copiedRef ? '✓ Copiada' : 'Copiar'}
                    </button>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-emerald-800">
                    <strong>Guarda o fotografía este código.</strong> Con él puedes consultar aquí
                    mismo el estado de tu solicitud, tu desembolso, saldo total y próxima cuota
                    (pestaña «Consultar mi crédito» → «Por referencia»).
                  </p>
                </div>
              )}

              {lockedTenant ? (
                <div className="rounded-lg bg-emerald-50 px-3 py-2 text-center">
                  <p className="text-[10px] font-semibold tracking-wide text-emerald-600 uppercase">
                    Estás solicitando con
                  </p>
                  <p className="font-bold text-emerald-800">{lockedTenant.name}</p>
                </div>
              ) : (
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
              )}
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-1">
                  <Label>Tipo</Label>
                  <Select value={reqDocType} onChange={(e) => setReqDocType(e.target.value as DocumentType)}>
                    <option value="CC">CC</option>
                    <option value="CE">CE</option>
                    <option value="TI">TI</option>
                    <option value="NIT">NIT</option>
                    <option value="PAS">Pasaporte</option>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>Número de documento *</Label>
                  <Input
                    value={reqDocumentNumber}
                    onChange={(e) => {
                      setReqDocumentNumber(e.target.value.replace(/\D/g, ''));
                      setFieldErrors((p) => ({ ...p, documentNumber: undefined }));
                    }}
                    inputMode="numeric"
                    placeholder="1020304050"
                    className={fieldErrors.documentNumber ? 'border-red-400' : undefined}
                  />
                  {fieldErrors.documentNumber && (
                    <p className="mt-1 text-[11px] font-medium text-red-600">{fieldErrors.documentNumber}</p>
                  )}
                </div>
              </div>
              <div>
                <Label>Nombre completo *</Label>
                <Input
                  value={reqFullName}
                  onChange={(e) => {
                    setReqFullName(e.target.value);
                    setFieldErrors((p) => ({ ...p, fullName: undefined }));
                  }}
                  placeholder="Como aparece en tu documento"
                  className={fieldErrors.fullName ? 'border-red-400' : undefined}
                />
                {fieldErrors.fullName && (
                  <p className="mt-1 text-[11px] font-medium text-red-600">{fieldErrors.fullName}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Teléfono (WhatsApp) *</Label>
                  <Input
                    value={reqPhone}
                    onChange={(e) => {
                      setReqPhone(e.target.value.replace(/\D/g, ''));
                      setFieldErrors((p) => ({ ...p, phone: undefined }));
                    }}
                    inputMode="tel"
                    placeholder="3101234567"
                    className={fieldErrors.phone ? 'border-red-400' : undefined}
                  />
                  {fieldErrors.phone && (
                    <p className="mt-1 text-[11px] font-medium text-red-600">{fieldErrors.phone}</p>
                  )}
                </div>
                <div>
                  <Label>Monto solicitado *</Label>
                  <Input
                    value={reqAmount}
                    onChange={(e) => {
                      setReqAmount(e.target.value.replace(/\D/g, ''));
                      setFieldErrors((p) => ({ ...p, amountRequested: undefined }));
                    }}
                    inputMode="numeric"
                    placeholder="500000"
                    className={fieldErrors.amountRequested ? 'border-red-400' : undefined}
                  />
                  {fieldErrors.amountRequested && (
                    <p className="mt-1 text-[11px] font-medium text-red-600">{fieldErrors.amountRequested}</p>
                  )}
                </div>
              </div>
              <div>
                <Label>Dirección *</Label>
                <Input
                  value={reqAddress}
                  onChange={(e) => {
                    setReqAddress(e.target.value);
                    setFieldErrors((p) => ({ ...p, address: undefined }));
                  }}
                  placeholder="Calle 45 # 12-30"
                  className={fieldErrors.address ? 'border-red-400' : undefined}
                />
                {fieldErrors.address && (
                  <p className="mt-1 text-[11px] font-medium text-red-600">{fieldErrors.address}</p>
                )}
              </div>
              <div>
                <Label>¿Para qué necesitas el crédito?</Label>
                <Input
                  value={reqNote}
                  onChange={(e) => setReqNote(e.target.value)}
                  placeholder="Ej: capital de trabajo para mi tienda"
                />
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
                  <Package size={14} /> Garantía del crédito *
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-700">
                  Escribe qué objeto dejas como garantía y fótografate junto a él. Al momento del
                  desembolso <strong>debes entregar ese mismo bien</strong>, tal como aparece en la
                  foto.
                </p>
                <Input
                  value={guaranteeDescription}
                  onChange={(e) => {
                    setGuaranteeDescription(e.target.value);
                    setFieldErrors((p) => ({ ...p, guaranteeDescription: undefined }));
                  }}
                  placeholder="Ej: Moto Boxer 2020 roja, a mi nombre"
                  className={`mt-2 ${fieldErrors.guaranteeDescription ? 'border-red-400' : undefined}`}
                />
                {fieldErrors.guaranteeDescription && (
                  <p className="mt-1 text-[11px] font-medium text-red-600">{fieldErrors.guaranteeDescription}</p>
                )}
              </div>

              <div>
                <Label>Foto con tu garantía * (selfie + objeto)</Label>
                <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-slate-300 px-3 py-4 text-center transition-colors hover:border-emerald-400 hover:bg-emerald-50/40">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => void handleSupportChange(e)}
                  />
                  {supportPreview ? (
                    <>
                      <img src={supportPreview} alt="Garantía adjunta" className="max-h-36 rounded-lg" />
                      <span className="text-[11px] font-medium text-emerald-600">
                        Toca para cambiar la foto
                      </span>
                    </>
                  ) : (
                    <>
                      <FileImage size={22} className="text-slate-400" />
                      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <Upload size={12} /> Tómate la foto junto al objeto
                      </span>
                      <span className="text-[10px] text-slate-400">
                        Se comprime automáticamente · debe salerte a ti con el bien
                      </span>
                    </>
                  )}
                </label>
              </div>

              <div className="rounded-xl bg-slate-50 p-3">
                <button
                  type="button"
                  onClick={() => setShowTerms((v) => !v)}
                  className="w-full cursor-pointer text-left text-xs font-bold text-sky-700 underline-offset-2 hover:underline"
                >
                  {showTerms ? '▲ Ocultar' : '▼ Leer'} Términos y Cláusulas del Préstamo ({TERMS_VERSION})
                </button>
                {showTerms && (
                  <pre className="mt-2 max-h-56 overflow-y-auto rounded-lg bg-white p-3 text-[10px] leading-relaxed whitespace-pre-wrap text-slate-600">
                    {TERMINOS_Y_CLAUSULAS}
                  </pre>
                )}
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
                  />
                  <span>
                    He leído y <strong>ACEPTO los términos y cláusulas</strong> del préstamo. Mi
                    aceptación quedará registrada con fecha y hora.
                  </span>
                </label>
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{error}</p>
              )}
              <Button className="w-full" onClick={() => void handleSendRequest()} disabled={sending}>
                {sending ? <Loader2 size={15} className="animate-spin" /> : null}
                {sending ? 'Enviando…' : 'Enviar solicitud'}
              </Button>
              {sendWarning && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                  {sendWarning}
                </p>
              )}
              {!cloudMode && (
                <p className="text-center text-[10px] text-slate-400">
                  Esta organización opera sin nube activa: la solicitud solo será visible en este
                  dispositivo.
                </p>
              )}
            </CardContent>
          </Card>
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
