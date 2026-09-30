import { useState } from 'react';
import { Copy, Check, MessageCircle, Mail, Send, QrCode as QrIcon, Download, Share2 } from 'lucide-react';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { QrCode } from './ui/QrCode';
import { useToast } from './ui/toast';

interface PortalShareModalProps {
  open: boolean;
  onClose: () => void;
  portalUrl: string;
  orgName: string;
}

export function PortalShareModal({ open, onClose, portalUrl, orgName }: PortalShareModalProps) {
  const { toast } = useToast();
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedInstructions, setCopiedInstructions] = useState(false);

  const instructionsText = `¡Hola! 👋 Te invitamos a acceder a nuestro Portal de Clientes oficial (${orgName}):

🔗 Enlace de acceso directo:
${portalUrl}

📲 ¿Cómo ingresar?
1. Abre el enlace en tu celular o computador (no necesitas instalar nada).
2. Ingresa tu número de documento de identidad.
3. Ingresa los últimos 4 dígitos de tu número de teléfono registrado.

✨ ¿Qué puedes hacer en el portal?
• Consultar tu saldo pendiente y fechas de tus próximas cuotas.
• Ver tu historial de pagos al día.
• Solicitar nuevos créditos o préstamos directamente en línea.

Atentamente,
${orgName}`;

  async function handleCopyUrl() {
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2500);
      toast('Enlace copiado al portapapeles', 'success');
    } catch {
      toast(`Copia manual: ${portalUrl}`, 'info');
    }
  }

  async function handleCopyInstructions() {
    try {
      await navigator.clipboard.writeText(instructionsText);
      setCopiedInstructions(true);
      setTimeout(() => setCopiedInstructions(false), 2500);
      toast('Enlace e instrucciones copiadas listas para enviar', 'success');
    } catch {
      toast('No se pudo copiar el texto automáticamente', 'error');
    }
  }

  function handleShareWhatsApp() {
    const encoded = encodeURIComponent(instructionsText);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
  }

  function handleShareEmail() {
    const subject = encodeURIComponent(`Portal de Clientes y Consulta de Créditos - ${orgName}`);
    const body = encodeURIComponent(instructionsText);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  }

  function handleShareTelegram() {
    const text = encodeURIComponent(`Accede al Portal de Clientes de ${orgName} para consultar créditos y solicitar desembolsos.`);
    window.open(`https://t.me/share/url?url=${encodeURIComponent(portalUrl)}&text=${text}`, '_blank');
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Portal de Clientes · ${orgName}`}
      description="Comparte el enlace o código QR para que los clientes consulten sus préstamos o soliciten crédito sin llamar a la oficina."
    >
      <div className="space-y-4">
        {/* Contenedor del Código QR */}
        <div className="flex flex-col items-center justify-center p-4 bg-gradient-to-b from-slate-50 to-white rounded-2xl border border-slate-200 shadow-inner">
          <div className="p-3 bg-white rounded-2xl shadow-md border border-slate-100 flex flex-col items-center">
            <QrCode value={portalUrl} size={175} />
            <span className="mt-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <QrIcon size={12} className="text-emerald-600" /> Escanear para acceder
            </span>
          </div>
          <p className="text-xs text-slate-500 text-center mt-2 max-w-xs">
            Apunta la cámara del celular al código QR para ingresar directamente al portal de <strong>{orgName}</strong>.
          </p>
        </div>

        {/* Input con URL y botones de copiado */}
        <div>
          <div className="flex items-center gap-2">
            <Input value={portalUrl} readOnly className="font-mono text-xs bg-slate-50 border-slate-300" />
            <Button size="sm" variant="outline" onClick={handleCopyUrl} className="shrink-0 gap-1 text-xs">
              {copiedUrl ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
              {copiedUrl ? '¡Copiado!' : 'Copiar URL'}
            </Button>
          </div>
          <div className="mt-2 flex">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleCopyInstructions}
              className="w-full gap-1.5 text-xs font-medium"
            >
              {copiedInstructions ? <Check size={14} className="text-emerald-600" /> : <Share2 size={14} />}
              {copiedInstructions ? '¡Instrucciones Copiadas!' : 'Copiar Enlace con Instrucciones Completas'}
            </Button>
          </div>
        </div>

        {/* Canales Digitales de Compartir */}
        <div>
          <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
            Enviar por medio digital:
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleShareWhatsApp}
              className="border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 text-xs gap-1.5 justify-center font-medium"
            >
              <MessageCircle size={14} className="text-emerald-600" /> WhatsApp
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleShareEmail}
              className="border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100 text-xs gap-1.5 justify-center font-medium"
            >
              <Mail size={14} className="text-blue-600" /> Correo / Gmail
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleShareTelegram}
              className="border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100 text-xs gap-1.5 justify-center font-medium"
            >
              <Send size={14} className="text-sky-600" /> Telegram
            </Button>
          </div>
        </div>

        {/* Guía de instrucciones */}
        <div className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-700 border border-slate-200">
          <p className="font-semibold text-slate-900 mb-1">Paso a paso para el cliente:</p>
          <ol className="list-inside list-decimal space-y-0.5 text-slate-600">
            <li>Abre el enlace o escanea el QR desde cualquier navegador.</li>
            <li>Digita su número de cédula o documento registrado.</li>
            <li>Digita los 4 últimos dígitos de su teléfono celular.</li>
          </ol>
          <p className="text-[11px] text-slate-400 mt-2">
            Este enlace es exclusivo y seguro: el cliente únicamente verá la información de <strong>{orgName}</strong> y no podrá alterar saldos ni registros.
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
