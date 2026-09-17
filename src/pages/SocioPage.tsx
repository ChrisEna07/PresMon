import { useState, useMemo, useEffect, type FormEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CalendarClock,
  CheckCircle2,
  HandCoins,
  MapPin,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCheck,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { Borrower, Installment, Loan, SingleUseSocioToken, Tenant } from '../db/models';
import { db, nowISO, stamp } from '../db/db';
import { useAuth, getOrCreateDeviceId } from '../store/auth';
import { applyPaymentToLoan } from '../lib/payments';
import { isSyncConfigured, runSync, deepSanitize, fetchRemoteTenant } from '../lib/sync/syncEngine';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';
import { formatCOP, formatDateShort, todayStr, cn } from '../lib/format';
import { uid } from '../lib/id';
import { useToast } from '../components/ui/toast';
import { Dialog } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Input, Label, Select } from '../components/ui/input';

const SOCIO_SESSION_STORAGE = 'presmon_socio_active_session_v1';

interface SocioStoredSession {
  tenantId: string;
  tenantName: string;
  socioName: string;
  tokenId: string;
  deviceId: string;
}

export default function SocioPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { session, logout } = useAuth();

  const urlTenantId = searchParams.get('t') || '';
  const urlToken = searchParams.get('token') || '';

  const [activeSession, setActiveSession] = useState<SocioStoredSession | null>(() => {
    try {
      const raw = localStorage.getItem(SOCIO_SESSION_STORAGE);
      if (raw) return JSON.parse(raw) as SocioStoredSession;
    } catch {
      /* noop */
    }
    return null;
  });

  const [tokenStatus, setTokenStatus] = useState<'validating' | 'ready' | 'error' | 'unlinked'>(
    urlToken ? 'validating' : activeSession ? 'ready' : 'unlinked',
  );
  const [errorMessage, setErrorMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<'route' | 'borrowers' | 'new-borrower'>('route');
  const [searchQuery, setSearchQuery] = useState('');

  // Estados de cobro
  const [collectModalOpen, setCollectModalOpen] = useState(false);
  const [targetLoan, setTargetLoan] = useState<Loan | null>(null);
  const [targetBorrower, setTargetBorrower] = useState<Borrower | null>(null);
  const [targetInst, setTargetInst] = useState<Installment | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'EFECTIVO' | 'TRANSFERENCIA'>('EFECTIVO');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [processingPayment, setProcessingPayment] = useState(false);

  // Recibo emitido
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<{
    receiptId: string;
    borrowerName: string;
    borrowerPhone: string;
    amount: number;
    method: string;
    date: string;
    remaining: number;
  } | null>(null);

  // Formulario nuevo cliente
  const [newFullName, setNewFullName] = useState('');
  const [newDocType, setNewDocType] = useState<Borrower['documentType']>('CC');
  const [newDocNumber, setNewDocNumber] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newCity, setNewCity] = useState('');
  const [creatingBorrower, setCreatingBorrower] = useState(false);

  const effectiveTenantId = activeSession?.tenantId || (session?.role === 'SOCIO' || session?.role === 'TENANT_ADMIN' ? session.tenantId : '');

  // Carga de datos locales de la organización
  const tenant = useLiveQuery(
    async (): Promise<Tenant | undefined> => {
      if (!effectiveTenantId) return undefined;
      return await db.tenants.get(effectiveTenantId);
    },
    [effectiveTenantId],
  );

  const borrowers = useLiveQuery(
    async (): Promise<Borrower[]> => {
      if (!effectiveTenantId) return [];
      return await db.borrowers.where('tenantId').equals(effectiveTenantId).toArray();
    },
    [effectiveTenantId],
  );

  const loans = useLiveQuery(
    async (): Promise<Loan[]> => {
      if (!effectiveTenantId) return [];
      return await db.loans.where('tenantId').equals(effectiveTenantId).toArray();
    },
    [effectiveTenantId],
  );

  const installments = useLiveQuery(
    async (): Promise<Installment[]> => {
      if (!effectiveTenantId) return [];
      return await db.installments.where('tenantId').equals(effectiveTenantId).toArray();
    },
    [effectiveTenantId],
  );

  const borrowerMap = useMemo(() => {
    const map = new Map<string, Borrower>();
    (borrowers ?? []).forEach((b) => map.set(b.borrowerId, b));
    return map;
  }, [borrowers]);

  const loanMap = useMemo(() => {
    const map = new Map<string, Loan>();
    (loans ?? []).forEach((l) => map.set(l.loanId, l));
    return map;
  }, [loans]);

  // Canje del enlace de único uso (Single-Use Token)
  useEffect(() => {
    if (!urlToken || !urlTenantId) return;

    let cancelled = false;
    async function redeemToken() {
      setTokenStatus('validating');
      const deviceId = getOrCreateDeviceId();
      const now = nowISO();

      try {
        // 1. Verificar contra la nube o local
        let tenantData: Tenant | null = null;
        if (isSyncConfigured()) {
          const remote = await fetchRemoteTenant(urlTenantId);
          if (remote?.found && remote.data) {
            tenantData = remote.data as unknown as Tenant;
          }
        }
        if (!tenantData) {
          tenantData = (await db.tenants.get(urlTenantId)) ?? null;
        }

        if (!tenantData) {
          if (!cancelled) {
            setTokenStatus('error');
            setErrorMessage('Organización no encontrada. Verifica el enlace con tu administrador.');
          }
          return;
        }

        if (tenantData.status !== 'ACTIVE') {
          if (!cancelled) {
            setTokenStatus('error');
            setErrorMessage('Esta organización se encuentra suspendida.');
          }
          return;
        }

        if (tenantData.socioModuleEnabled === false) {
          if (!cancelled) {
            setTokenStatus('error');
            setErrorMessage('El módulo de Socio no está habilitado para esta organización.');
          }
          return;
        }

        // Buscar el token en la lista del tenant
        const tokens: SingleUseSocioToken[] = tenantData.singleUseSocioTokens ?? [];
        const found = tokens.find((t) => t.token === urlToken.trim());

        if (!found) {
          if (!cancelled) {
            setTokenStatus('error');
            setErrorMessage('El enlace de socio no es válido o fue revocado por el administrador.');
          }
          return;
        }

        // Validación de único uso estricta:
        if (found.used) {
          // Si ya fue usado pero en este mismo dispositivo, se permite continuar
          if (found.usedByDevice === deviceId) {
            const sess: SocioStoredSession = {
              tenantId: tenantData.tenantId,
              tenantName: tenantData.name,
              socioName: found.socioName || 'Cobrador de Campo',
              tokenId: found.id,
              deviceId,
            };
            localStorage.setItem(SOCIO_SESSION_STORAGE, JSON.stringify(sess));
            if (!cancelled) {
              setActiveSession(sess);
              setTokenStatus('ready');
              window.history.replaceState({}, '', window.location.pathname);
            }
            return;
          }

          if (!cancelled) {
            setTokenStatus('error');
            setErrorMessage(
              '⚠️ Este enlace de socio ya fue utilizado en otro dispositivo y ha caducado. Por seguridad es de único uso y no se puede replicar ni compartir. Solicita un nuevo enlace a tu administrador.',
            );
          }
          return;
        }

        if (!found.active) {
          if (!cancelled) {
            setTokenStatus('error');
            setErrorMessage('Este enlace de socio fue desactivado.');
          }
          return;
        }

        // Marcar el token como quemado/usado por este dispositivo de forma autoritativa
        const updatedTokens = tokens.map((t) =>
          t.id === found.id
            ? { ...t, used: true, usedAt: now, usedByDevice: deviceId }
            : t,
        );

        const tenantUpdate: Partial<Tenant> = {
          singleUseSocioTokens: updatedTokens,
          lastSeenOnlineAt: now,
          updatedAt: now,
        };

        await db.tenants.update(tenantData.tenantId, tenantUpdate);

        // Subir a Firestore
        const cfg = loadFirebaseConfig();
        if (cfg && navigator.onLine) {
          const { initializeApp, getApps } = await import('firebase/app');
          const { getFirestore, doc, setDoc } = await import('firebase/firestore');
          const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
          await setDoc(doc(fs, 'tenants', tenantData.tenantId), deepSanitize(tenantUpdate), { merge: true });
        }

        const sess: SocioStoredSession = {
          tenantId: tenantData.tenantId,
          tenantName: tenantData.name,
          socioName: found.socioName || 'Cobrador de Campo',
          tokenId: found.id,
          deviceId,
        };

        localStorage.setItem(SOCIO_SESSION_STORAGE, JSON.stringify(sess));

        if (!cancelled) {
          setActiveSession(sess);
          setTokenStatus('ready');
          toast(`¡Enlace vinculado con éxito! Bienvenido(a), ${sess.socioName}.`, 'success');
          // Limpiar el token de la barra de direcciones para que no quede expuesto
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch (err) {
        if (!cancelled) {
          setTokenStatus('error');
          setErrorMessage(err instanceof Error ? err.message : 'Error al validar el enlace.');
        }
      }
    }

    void redeemToken();
    return () => {
      cancelled = true;
    };
  }, [urlToken, urlTenantId]);

  // Si no hay token de enlace pero el usuario está logueado como SOCIO en auth
  useEffect(() => {
    if (!activeSession && session?.role === 'SOCIO' && session.tenantId) {
      setActiveSession({
        tenantId: session.tenantId,
        tenantName: session.tenantName,
        socioName: session.displayName,
        tokenId: 'auth-user',
        deviceId: getOrCreateDeviceId(),
      });
      setTokenStatus('ready');
    }
  }, [session, activeSession]);

  async function handleManualSync() {
    if (syncing || !isSyncConfigured()) return;
    setSyncing(true);
    try {
      const res = await runSync(effectiveTenantId);
      toast(`Sincronización completada (${res.pulled} descargados, ${res.pushed} subidos).`, 'success');
    } catch {
      toast('Sin conexión: los cobros están seguros en este equipo y se subirán solos.', 'info');
    } finally {
      setSyncing(false);
    }
  }

  function handleUnlinkDevice() {
    if (!window.confirm('¿Deseas cerrar la sesión de Socio en este dispositivo?')) return;
    localStorage.removeItem(SOCIO_SESSION_STORAGE);
    setActiveSession(null);
    setTokenStatus('unlinked');
    if (session?.role === 'SOCIO') {
      logout();
      navigate('/login');
    }
    toast('Sesión de socio cerrada en este equipo.', 'info');
  }

  // Filtrado de cuotas pendientes para la ruta del cobrador
  const pendingRouteInstallments = useMemo(() => {
    const list = (installments ?? []).filter((i) => i.status !== 'PAID');
    list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase().trim();

    return list.filter((inst) => {
      const loan = loanMap.get(inst.loanId);
      const borrower = loan ? borrowerMap.get(loan.borrowerId) : undefined;
      return (
        (borrower?.fullName.toLowerCase().includes(q) ?? false) ||
        (borrower?.phone.toLowerCase().includes(q) ?? false) ||
        (borrower?.documentNumber.toLowerCase().includes(q) ?? false) ||
        (borrower?.address.toLowerCase().includes(q) ?? false) ||
        (loan?.loanId.toLowerCase().includes(q) ?? false)
      );
    });
  }, [installments, borrowerMap, loanMap, searchQuery]);

  // Cuotas de hoy o vencidas
  const today = todayStr();
  const routeStats = useMemo(() => {
    let dueTodayOrOverdueCount = 0;
    let dueTodayOrOverdueAmount = 0;
    let totalCollectedToday = 0;

    (installments ?? []).forEach((inst) => {
      if (inst.paidAt && inst.paidAt.slice(0, 10) === today) {
        totalCollectedToday += inst.amountPaid;
      }
      if (inst.status !== 'PAID') {
        const remaining = Math.max(0, inst.baseAmountDue + inst.lateFeeCharged - inst.amountPaid);
        if (inst.dueDate <= today) {
          dueTodayOrOverdueCount++;
          dueTodayOrOverdueAmount += remaining;
        }
      }
    });

    return { dueTodayOrOverdueCount, dueTodayOrOverdueAmount, totalCollectedToday };
  }, [installments, today]);

  function openCollectModal(inst: Installment) {
    const loan = loanMap.get(inst.loanId);
    const borrower = loan ? borrowerMap.get(loan.borrowerId) : undefined;
    if (!loan || !borrower) {
      toast('No se encontró el préstamo o cliente asociado.', 'error');
      return;
    }
    setTargetInst(inst);
    setTargetLoan(loan);
    setTargetBorrower(borrower);
    const remaining = Math.max(0, inst.baseAmountDue + inst.lateFeeCharged - inst.amountPaid);
    setPaymentAmount(String(remaining));
    setPaymentMethod('EFECTIVO');
    setPaymentNotes('');
    setCollectModalOpen(true);
  }

  async function handleConfirmCollect(e: FormEvent) {
    e.preventDefault();
    if (!targetLoan || !targetBorrower || !targetInst) return;
    const amountVal = Number(paymentAmount);
    if (isNaN(amountVal) || amountVal <= 0) {
      toast('Ingresa un monto válido mayor a 0.', 'error');
      return;
    }

    setProcessingPayment(true);
    try {
      const socioActor = {
        id: activeSession?.tokenId || session?.userId || 'socio-device',
        name: activeSession?.socioName || session?.displayName || 'Socio Cobrador',
      };

      const result = await applyPaymentToLoan(
        targetLoan.loanId,
        amountVal,
        socioActor,
        'SOCIO_PAYMENT_APPLIED',
        {
          metodoPago: paymentMethod,
          notas: paymentNotes.trim(),
          recaudadoPor: socioActor.name,
        },
      );

      const remainingAfter = Math.max(0, (targetLoan.balanceRemaining ?? 0) - result.applied);

      setCollectModalOpen(false);

      const receipt = {
        receiptId: 'REC-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        borrowerName: targetBorrower.fullName,
        borrowerPhone: targetBorrower.phone,
        amount: result.applied,
        method: paymentMethod,
        date: formatDateShort(today),
        remaining: remainingAfter,
      };

      setLastReceipt(receipt);
      setReceiptModalOpen(true);

      toast(`¡Recaudo de ${formatCOP(result.applied)} aplicado con éxito!`, 'success');

      // Intentar sincronización en background
      if (isSyncConfigured() && navigator.onLine) {
        void runSync(effectiveTenantId).catch(() => undefined);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error al aplicar el recaudo.', 'error');
    } finally {
      setProcessingPayment(false);
    }
  }

  function shareReceiptWhatsApp() {
    if (!lastReceipt) return;
    const phone = lastReceipt.borrowerPhone.replace(/\D/g, '');
    const cleanPhone = phone.startsWith('57') ? phone : `57${phone}`;
    const text = encodeURIComponent(
      `🧾 *COMPROBANTE DE PAGO PRESMON*\n` +
        `Empresa: *${activeSession?.tenantName ?? 'PresMon'}*\n` +
        `Recibo: #${lastReceipt.receiptId}\n` +
        `Cliente: *${lastReceipt.borrowerName}*\n` +
        `Fecha: ${lastReceipt.date}\n` +
        `Monto Recaudado: *${formatCOP(lastReceipt.amount)}* (${lastReceipt.method})\n` +
        `Saldo Restante: *${formatCOP(lastReceipt.remaining)}*\n` +
        `Cobrador: ${activeSession?.socioName ?? 'Cobranzas'}\n\n` +
        `¡Gracias por tu pago puntual! Conserva este mensaje como tu comprobante oficial.`,
    );
    window.open(`https://wa.me/${cleanPhone}?text=${text}`, '_blank');
  }

  async function handleCreateBorrower(e: FormEvent) {
    e.preventDefault();
    if (!effectiveTenantId) return;
    if (!newFullName.trim() || !newPhone.trim() || !newDocNumber.trim()) {
      toast('Completa nombre, documento y teléfono del cliente.', 'error');
      return;
    }

    setCreatingBorrower(true);
    try {
      const newBorrower: Borrower = stamp({
        borrowerId: uid(),
        tenantId: effectiveTenantId,
        fullName: newFullName.trim(),
        documentType: newDocType,
        documentNumber: newDocNumber.trim(),
        phone: newPhone.trim(),
        address: newAddress.trim(),
        city: newCity.trim(),
        creditScore: 70,
        riskBadge: 'B',
        totalLoansCount: 0,
        defaultCount: 0,
        notes: `Cliente creado en ruta por Socio: ${activeSession?.socioName ?? 'Cobrador'}`,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        syncStatus: 'PENDING',
      });

      await db.borrowers.put(newBorrower);

      toast(`Cliente ${newBorrower.fullName} registrado con éxito.`, 'success');
      setNewFullName('');
      setNewDocNumber('');
      setNewPhone('');
      setNewAddress('');
      setNewCity('');
      setActiveTab('borrowers');

      if (isSyncConfigured() && navigator.onLine) {
        void runSync(effectiveTenantId).catch(() => undefined);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error al registrar cliente.', 'error');
    } finally {
      setCreatingBorrower(false);
    }
  }

  // Render según estado del token o sesión
  if (tokenStatus === 'validating') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-4 text-center">
        <div className="max-w-sm rounded-2xl bg-slate-800 p-6 border border-slate-700 shadow-2xl space-y-4">
          <RefreshCw size={36} className="animate-spin text-emerald-400 mx-auto" />
          <h2 className="text-lg font-bold text-white">Validando enlace de Socio…</h2>
          <p className="text-xs text-slate-400">Verificando autenticidad y vinculando este dispositivo.</p>
        </div>
      </div>
    );
  }

  if (tokenStatus === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-4 text-center">
        <div className="max-w-md rounded-2xl bg-slate-800 p-6 border border-red-500/30 shadow-2xl space-y-4">
          <div className="h-12 w-12 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center mx-auto">
            <ShieldAlert size={28} />
          </div>
          <h2 className="text-lg font-bold text-white">Acceso Denegado</h2>
          <p className="text-xs leading-relaxed text-slate-300 bg-red-950/40 p-3 rounded-xl border border-red-800/40 text-left">
            {errorMessage}
          </p>
          <div className="pt-2">
            <Button
              variant="outline"
              className="w-full text-xs"
              onClick={() => {
                window.history.replaceState({}, '', '/login');
                navigate('/login');
              }}
            >
              Ir a Iniciar Sesión Normal
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (tokenStatus === 'unlinked' || !activeSession) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-4 text-center">
        <div className="max-w-sm rounded-2xl bg-slate-800 p-6 border border-slate-700 shadow-2xl space-y-4">
          <div className="h-12 w-12 rounded-2xl bg-emerald-500 text-slate-950 font-black text-xl flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/20">
            PM
          </div>
          <h2 className="text-lg font-bold text-white">Módulo Socio · PresMon</h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Para acceder al módulo de cobrador de campo necesitas un <strong>enlace de único uso</strong> generado por el administrador de tu organización.
          </p>
          <div className="rounded-xl bg-white/5 p-3 border border-white/10 text-[11px] text-slate-400 text-left">
            💡 <strong>Seguridad PresMon:</strong> Cada enlace de socio es de uso exclusivo e intransferible. Al abrirse por primera vez, queda vinculado únicamente a ese teléfono.
          </div>
          <Button
            className="w-full text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white"
            onClick={() => navigate('/login')}
          >
            Volver al Inicio de Sesión
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Cabecera Móvil del Socio */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-slate-900/95 px-4 py-3 backdrop-blur shadow-md">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500 font-black text-slate-950 text-sm shadow-sm">
            PM
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-white leading-tight">
              {activeSession.tenantName}
            </p>
            <p className="truncate text-[10px] text-emerald-400 font-medium">
              Socio: {activeSession.socioName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleManualSync()}
            disabled={syncing}
            title="Sincronizar recaudos"
            className="rounded-xl border border-slate-700 bg-slate-800 p-2 text-slate-300 hover:bg-slate-700 hover:text-white cursor-pointer disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={15} className={cn(syncing && 'animate-spin text-emerald-400')} />
          </button>
          <button
            onClick={handleUnlinkDevice}
            title="Cerrar sesión de socio"
            className="rounded-xl border border-red-900/40 bg-red-950/30 px-2.5 py-1.5 text-[11px] font-semibold text-red-400 hover:bg-red-900/50 cursor-pointer transition-colors"
          >
            Salir
          </button>
        </div>
      </header>

      {/* Métricas rápidas de ruta del cobrador (sin exponer balances de capital general) */}
      <div className="bg-slate-900/40 border-b border-slate-800/80 px-4 py-2.5">
        <div className="grid grid-cols-2 gap-2 max-w-lg mx-auto">
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-2.5">
            <p className="text-[10px] text-slate-400 font-medium">Cobros Pendientes Hoy</p>
            <p className="text-base font-bold text-amber-400 mt-0.5">
              {routeStats.dueTodayOrOverdueCount} <span className="text-[11px] font-normal text-slate-400">cuotas</span>
            </p>
          </div>
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-2.5">
            <p className="text-[10px] text-slate-400 font-medium">Recaudado Hoy</p>
            <p className="text-base font-bold text-emerald-400 mt-0.5">
              {formatCOP(routeStats.totalCollectedToday)}
            </p>
          </div>
        </div>
      </div>

      {/* Pestañas de navegación del socio */}
      <div className="flex border-b border-slate-800 bg-slate-900/80 px-4 pt-1 max-w-lg mx-auto w-full">
        <button
          onClick={() => setActiveTab('route')}
          className={cn(
            'flex-1 py-2 text-xs font-bold border-b-2 flex items-center justify-center gap-1.5 transition-colors cursor-pointer',
            activeTab === 'route'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          )}
        >
          <CalendarClock size={15} /> Ruta de Cobro
        </button>
        <button
          onClick={() => setActiveTab('borrowers')}
          className={cn(
            'flex-1 py-2 text-xs font-bold border-b-2 flex items-center justify-center gap-1.5 transition-colors cursor-pointer',
            activeTab === 'borrowers'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          )}
        >
          <Users size={15} /> Clientes ({borrowers?.length ?? 0})
        </button>
        <button
          onClick={() => setActiveTab('new-borrower')}
          className={cn(
            'flex-1 py-2 text-xs font-bold border-b-2 flex items-center justify-center gap-1.5 transition-colors cursor-pointer',
            activeTab === 'new-borrower'
              ? 'border-emerald-500 text-emerald-400'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          )}
        >
          <UserPlus size={15} /> Nuevo Cliente
        </button>
      </div>

      {/* Contenido según pestaña activa */}
      <main className="flex-1 p-4 max-w-lg mx-auto w-full pb-20">
        {/* PESTAÑA 1: RUTA DE COBRO */}
        {activeTab === 'route' && (
          <div className="space-y-3">
            {/* Buscador de ruta */}
            <div className="relative">
              <Search size={16} className="absolute left-3 top-3 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar cliente, teléfono o dirección…"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 pl-9 pr-3 py-2.5 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {pendingRouteInstallments.length === 0 ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-400 space-y-2">
                <CheckCircle2 size={36} className="text-emerald-500 mx-auto" />
                <p className="font-bold text-sm text-white">¡Ruta al día!</p>
                <p className="text-xs">No hay cuotas pendientes registradas con los filtros actuales.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {pendingRouteInstallments.map((inst) => {
                  const loan = loanMap.get(inst.loanId);
                  const borrower = loan ? borrowerMap.get(loan.borrowerId) : undefined;
                  const remaining = Math.max(0, inst.baseAmountDue + inst.lateFeeCharged - inst.amountPaid);
                  const isOverdue = inst.dueDate < today;
                  const isToday = inst.dueDate === today;

                  return (
                    <div
                      key={inst.installmentId}
                      className={cn(
                        'rounded-2xl border p-3.5 transition-all shadow-sm',
                        isOverdue
                          ? 'border-red-500/30 bg-red-950/10'
                          : isToday
                            ? 'border-amber-500/30 bg-amber-950/10'
                            : 'border-slate-800 bg-slate-900',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold text-sm text-white truncate">
                            {borrower?.fullName ?? 'Cliente Desconocido'}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
                            <span>Cuota {inst.installmentNumber}</span>
                            <span>•</span>
                            <span
                              className={cn(
                                'font-semibold',
                                isOverdue ? 'text-red-400' : isToday ? 'text-amber-400' : 'text-slate-400',
                              )}
                            >
                              Vence: {formatDateShort(inst.dueDate)} {isOverdue && '(Vencida)'} {isToday && '(Hoy)'}
                            </span>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <p className="text-sm font-black text-emerald-400">
                            {formatCOP(remaining)}
                          </p>
                          {inst.amountPaid > 0 && (
                            <p className="text-[10px] text-slate-400">
                              Abonado: {formatCOP(inst.amountPaid)}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Dirección y teléfono de contacto */}
                      {borrower && (
                        <div className="mt-2.5 flex items-center justify-between gap-2 pt-2 border-t border-slate-800/60 text-xs">
                          <div className="flex items-center gap-1.5 text-slate-400 truncate min-w-0">
                            <MapPin size={13} className="shrink-0 text-slate-500" />
                            <span className="truncate text-[11px]">
                              {borrower.address ? `${borrower.address} (${borrower.city || 'Local'})` : 'Sin dirección'}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {borrower.phone && (
                              <>
                                <a
                                  href={`tel:${borrower.phone}`}
                                  className="rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:text-white"
                                  title="Llamar"
                                >
                                  <Phone size={14} />
                                </a>
                                <a
                                  href={`https://wa.me/57${borrower.phone.replace(/\D/g, '')}?text=${encodeURIComponent(
                                    `Hola ${borrower.fullName}, te saluda ${activeSession.socioName} de ${activeSession.tenantName}. Te escribo para acordar la cuota de tu crédito de ${formatCOP(remaining)}.`,
                                  )}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded-lg bg-emerald-950/60 text-emerald-400 p-1.5 hover:bg-emerald-900/60"
                                  title="WhatsApp"
                                >
                                  <MessageCircle size={14} />
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Botón de cobro */}
                      <button
                        onClick={() => openCollectModal(inst)}
                        className="mt-3 w-full cursor-pointer rounded-xl bg-emerald-500 hover:bg-emerald-400 py-2 text-center text-xs font-bold text-slate-950 shadow-md shadow-emerald-500/20 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <HandCoins size={14} /> Registrar Cobro / Abono
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* PESTAÑA 2: CLIENTES */}
        {activeTab === 'borrowers' && (
          <div className="space-y-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-3 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por nombre, documento o teléfono…"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 pl-9 pr-3 py-2.5 text-xs text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              {(borrowers ?? [])
                .filter((b) => {
                  if (!searchQuery.trim()) return true;
                  const q = searchQuery.toLowerCase().trim();
                  return (
                    b.fullName.toLowerCase().includes(q) ||
                    b.documentNumber.includes(q) ||
                    b.phone.includes(q)
                  );
                })
                .map((b) => (
                  <div
                    key={b.borrowerId}
                    className="rounded-xl border border-slate-800 bg-slate-900 p-3 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-xs text-white truncate">{b.fullName}</p>
                      <p className="text-[10px] text-slate-400">
                        {b.documentType} {b.documentNumber} • {b.phone}
                      </p>
                      {b.address && (
                        <p className="text-[10px] text-slate-500 truncate mt-0.5">
                          📍 {b.address}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {b.phone && (
                        <>
                          <a
                            href={`tel:${b.phone}`}
                            className="rounded-lg bg-slate-800 p-2 text-slate-300 hover:text-white"
                          >
                            <Phone size={13} />
                          </a>
                          <a
                            href={`https://wa.me/57${b.phone.replace(/\D/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-lg bg-emerald-950/60 text-emerald-400 p-2 hover:bg-emerald-900/60"
                          >
                            <MessageCircle size={13} />
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* PESTAÑA 3: NUEVO CLIENTE */}
        {activeTab === 'new-borrower' && (
          <form onSubmit={handleCreateBorrower} className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3.5">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <UserPlus size={16} className="text-emerald-400" /> Registrar Nuevo Prestatario en Ruta
            </h3>
            <div>
              <Label className="text-xs text-slate-300">Nombre Completo *</Label>
              <Input
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
                required
                className="mt-1 bg-slate-800 border-slate-700 text-white text-xs"
                placeholder="Ej. Carlos Mendoza"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-xs text-slate-300">Tipo Doc.</Label>
                <Select
                  value={newDocType}
                  onChange={(e) => setNewDocType(e.target.value as any)}
                  className="mt-1 bg-slate-800 border-slate-700 text-white text-xs"
                >
                  <option value="CC">CC</option>
                  <option value="CE">CE</option>
                  <option value="TI">TI</option>
                  <option value="NIT">NIT</option>
                  <option value="PAS">PAS</option>
                </Select>
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-slate-300">Número de Documento *</Label>
                <Input
                  value={newDocNumber}
                  onChange={(e) => setNewDocNumber(e.target.value)}
                  required
                  className="mt-1 bg-slate-800 border-slate-700 text-white text-xs"
                  placeholder="Ej. 1020304050"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs text-slate-300">Teléfono / WhatsApp *</Label>
              <Input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                required
                type="tel"
                className="mt-1 bg-slate-800 border-slate-700 text-white text-xs"
                placeholder="Ej. 3101234567"
              />
            </div>

            <div>
              <Label className="text-xs text-slate-300">Dirección</Label>
              <Input
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                className="mt-1 bg-slate-800 border-slate-700 text-white text-xs"
                placeholder="Ej. Calle 10 # 5-20"
              />
            </div>

            <div>
              <Label className="text-xs text-slate-300">Ciudad / Municipio</Label>
              <Input
                value={newCity}
                onChange={(e) => setNewCity(e.target.value)}
                className="mt-1 bg-slate-800 border-slate-700 text-white text-xs"
                placeholder="Ej. Bogotá"
              />
            </div>

            <Button
              type="submit"
              disabled={creatingBorrower}
              className="w-full mt-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold py-2.5"
            >
              {creatingBorrower ? 'Guardando…' : 'Guardar Cliente'}
            </Button>
          </form>
        )}
      </main>

      {/* DIÁLOGO: REGISTRAR COBRO */}
      <Dialog
        open={collectModalOpen}
        onClose={() => setCollectModalOpen(false)}
        title="Registrar Cobro en Ruta"
      >
        {targetBorrower && targetInst && (
          <form onSubmit={handleConfirmCollect} className="space-y-3.5 text-xs">
            <div className="rounded-xl bg-slate-100 p-3 border border-slate-200">
              <p className="font-bold text-slate-800 text-sm">{targetBorrower.fullName}</p>
              <p className="text-[11px] text-slate-500">
                Cuota {targetInst.installmentNumber} • Vence {formatDateShort(targetInst.dueDate)}
              </p>
            </div>

            <div>
              <Label className="text-xs font-bold text-slate-700">Monto Recibido ($) *</Label>
              <Input
                type="number"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                required
                className="mt-1 font-bold text-sm"
              />
            </div>

            <div>
              <Label className="text-xs font-bold text-slate-700">Método de Pago</Label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => setPaymentMethod('EFECTIVO')}
                  className={cn(
                    'cursor-pointer rounded-xl border p-2 text-xs font-semibold text-center',
                    paymentMethod === 'EFECTIVO'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 bg-white text-slate-600',
                  )}
                >
                  💵 Efectivo
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('TRANSFERENCIA')}
                  className={cn(
                    'cursor-pointer rounded-xl border p-2 text-xs font-semibold text-center',
                    paymentMethod === 'TRANSFERENCIA'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 bg-white text-slate-600',
                  )}
                >
                  📱 Transferencia
                </button>
              </div>
            </div>

            <div>
              <Label className="text-xs font-bold text-slate-700">Notas / Observación</Label>
              <Input
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                placeholder="Ej. Pago entregado en su negocio"
                className="mt-1"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCollectModalOpen(false)}
                className="flex-1"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={processingPayment}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
              >
                {processingPayment ? 'Aplicando…' : 'Confirmar Recaudo'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* DIÁLOGO: RECIBO EMITIDO & WHATSAPP */}
      <Dialog
        open={receiptModalOpen}
        onClose={() => setReceiptModalOpen(false)}
        title="Recibo de Pago Confirmado"
      >
        {lastReceipt && (
          <div className="space-y-4 text-center">
            <div className="h-12 w-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
              <CheckCircle2 size={28} />
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-left space-y-2 text-xs">
              <div className="flex justify-between border-b pb-1 text-slate-500 text-[11px]">
                <span>Recibo #{lastReceipt.receiptId}</span>
                <span>{lastReceipt.date}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Cliente:</span>
                <span className="font-bold text-slate-900">{lastReceipt.borrowerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Monto Recaudado:</span>
                <span className="font-extrabold text-emerald-600 text-sm">
                  {formatCOP(lastReceipt.amount)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Método:</span>
                <span className="font-semibold text-slate-700">{lastReceipt.method}</span>
              </div>
              <div className="flex justify-between border-t pt-1">
                <span className="text-slate-600">Saldo Restante Préstamo:</span>
                <span className="font-bold text-slate-800">{formatCOP(lastReceipt.remaining)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Button
                onClick={shareReceiptWhatsApp}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 py-2.5"
              >
                <MessageCircle size={16} /> Enviar Comprobante por WhatsApp
              </Button>
              <Button
                variant="outline"
                onClick={() => setReceiptModalOpen(false)}
                className="w-full text-xs"
              >
                Cerrar
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
