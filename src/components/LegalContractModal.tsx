import { useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, Lock, Scale, ShieldCheck } from 'lucide-react';
import {
  CURRENT_CONTRACT_VERSION,
  CONTRACT_SECTIONS,
  CONTRACT_TITLE,
  getFullContractPlainText,
} from '../lib/legalContract';
import { db, nowISO } from '../db/db';
import { uid } from '../lib/id';
import { isSyncConfigured, runSync } from '../lib/sync/syncEngine';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';
import { deepSanitize } from '../lib/sync/syncEngine';
import type { LegalAcceptance } from '../db/models';

function pushToCloud(): void {
  void runSync().catch(() => {});
}

interface LegalContractModalProps {
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  onAccepted: () => void;
}

export function LegalContractModal({
  tenantId,
  tenantName,
  userId,
  userName,
  userDisplayName,
  onAccepted,
}: LegalContractModalProps) {
  const [hasAgreed, setHasAgreed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    if (!hasAgreed) return;
    setIsSubmitting(true);
    setError(null);

    try {
      let ipAddress = 'Local / Red privada';
      try {
        const res = await fetch('https://api.ipify.org?format=json', {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = (await res.json()) as { ip?: string };
          if (data.ip) ipAddress = data.ip;
        }
      } catch {
        // Fallback seguro si no hay internet o CORS bloqueado
      }

      const now = nowISO();
      const acceptanceRecord: LegalAcceptance = {
        acceptanceId: uid(),
        tenantId,
        tenantName,
        userId,
        userName,
        userDisplayName,
        acceptedAt: now,
        contractVersion: CURRENT_CONTRACT_VERSION,
        ipAddress,
        userAgent: navigator.userAgent,
        contractText: getFullContractPlainText(tenantName, userDisplayName),
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        syncStatus: 'PENDING',
      };

      // Guardar en base local Dexie
      await db.legal_acceptances.put(acceptanceRecord);

      // Si hay sincronización remota configurada, persistir directo en Firestore
      const cfg = loadFirebaseConfig();
      if (cfg && isSyncConfigured() && navigator.onLine) {
        try {
          const { initializeApp, getApps } = await import('firebase/app');
          const { getFirestore, doc, setDoc } = await import('firebase/firestore');
          const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
          await setDoc(
            doc(fs, 'legal_acceptances', acceptanceRecord.acceptanceId),
            deepSanitize(acceptanceRecord),
          );
        } catch {
          // Si falla conexión directa, pushToCloud se encargará en background
        }
      }

      pushToCloud();
      onAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al registrar la aceptación contractual.');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-emerald-500/30 bg-slate-900 p-6 sm:p-8 text-left shadow-2xl my-6 flex flex-col max-h-[92vh]">
        {/* Cabecera del Contrato */}
        <div className="flex items-start gap-4 border-b border-slate-800 pb-4 shrink-0">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-md">
            <Scale size={26} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/30">
                Ley 527 de 1999 (Colombia)
              </span>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-300 border border-slate-700">
                Versión {CURRENT_CONTRACT_VERSION}
              </span>
            </div>
            <h2 className="text-lg font-bold text-white leading-snug">
              {CONTRACT_TITLE}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Aceptación digital con validez y mérito probatorio pleno bajo la legislación colombiana.
            </p>
          </div>
        </div>

        {/* Datos identificadores de la Organización y Usuario */}
        <div className="my-3 rounded-xl bg-slate-950/60 p-3 border border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs shrink-0">
          <div>
            <span className="text-slate-400 block text-[10px] uppercase font-semibold">Organización / Suscriptor:</span>
            <span className="font-bold text-white">{tenantName}</span>
          </div>
          <div>
            <span className="text-slate-400 block text-[10px] uppercase font-semibold">Representante / Usuario:</span>
            <span className="font-bold text-white">{userDisplayName} ({userName})</span>
          </div>
        </div>

        {/* Cuerpo del Contrato Scrollable */}
        <div className="flex-1 overflow-y-auto rounded-xl bg-slate-950/80 p-4 border border-slate-800 space-y-4 text-xs leading-relaxed text-slate-300 select-text my-2 pr-3 scrollbar-thin">
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-2.5 text-amber-200 text-[11px] flex items-start gap-2">
            <AlertCircle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <span>
              <strong>Aviso legal vinculante:</strong> Al ingresar a la plataforma, reconoces expresamente que los costos cloud son indispensables y que la falta de pago faculta a la suspensión total e inmediata del servicio (Art. 1609 C.C.).
            </span>
          </div>

          {CONTRACT_SECTIONS.map((sec) => (
            <div key={sec.number} className="border-b border-slate-800/80 pb-3 last:border-b-0 last:pb-0">
              <h4 className="font-bold text-emerald-400 text-xs uppercase mb-1">
                CLÁUSULA {sec.number} - {sec.title}
              </h4>
              <p className="text-slate-300 leading-normal text-justify">
                {sec.body}
              </p>
            </div>
          ))}
        </div>

        {/* Checkbox de Aceptación y Telemetría */}
        <div className="mt-3 border-t border-slate-800 pt-3 shrink-0 space-y-3">
          <label className="flex items-start gap-3 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={hasAgreed}
              onChange={(e) => setHasAgreed(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-900 cursor-pointer"
            />
            <span className="text-xs text-slate-300 leading-relaxed group-hover:text-white transition-colors">
              Declaro que he leído íntegramente las <strong>7 cláusulas contractuales</strong>, acepto la obligación de pago puntual de la licencia y mensualidad del servicio cloud, y acepto que el impago conlleva a la <strong>suspensión inmediata del sistema sin lugar a indemnizaciones</strong> (Art. 1609 Código Civil y Ley 527 de 1999 de Colombia).
            </span>
          </label>

          {error && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-300 flex items-center gap-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5 self-start sm:self-center">
              <ShieldCheck size={14} className="text-emerald-400" />
              Registro seguro con firma electrónica y marca temporal
            </span>

            <button
              onClick={handleAccept}
              disabled={!hasAgreed || isSubmitting}
              className="w-full sm:w-auto cursor-pointer rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2.5 font-bold text-white shadow-lg shadow-emerald-600/30 transition-all flex items-center justify-center gap-2 text-xs sm:text-sm"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Registrando firma digital…
                </>
              ) : (
                <>
                  <CheckCircle2 size={16} />
                  Firmar y Aceptar Contrato Electrónico
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
