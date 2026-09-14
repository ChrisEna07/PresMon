/**
 * Número telefónico oficial de soporte y administración general (ChrizDev).
 * Código de país Colombia: +57.
 * Número nacional: 318 351 7802 -> 573183517802 para WhatsApp.
 */
export const CHRIZDEV_WHATSAPP_PHONE = '573183517802';
export const CHRIZDEV_WHATSAPP_DISPLAY = '+57 318 351 7802';
export const CHRIZDEV_WHATSAPP_RAW = '3183517802';

/**
 * Normaliza cualquier número de teléfono para el formato internacional requerido por WhatsApp.
 * Si es un número celular colombiano de 10 dígitos que inicia con '3', antepone '57'.
 */
export function normalizeWhatsAppPhone(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) {
    return `57${digits}`;
  }
  return digits;
}

/**
 * Abre una conversación de WhatsApp con el texto y destinatario especificados.
 * Utiliza el enlace canónico https://wa.me/ para compatibilidad universal tanto
 * en navegadores de escritorio (WhatsApp Web) como en móviles (Android / iOS).
 */
export function openWhatsApp(text: string, phone?: string): void {
  const targetPhone = phone ? normalizeWhatsAppPhone(phone) : '';
  const encoded = encodeURIComponent(text);
  const targetUrl = targetPhone
    ? `https://wa.me/${targetPhone}?text=${encoded}`
    : `https://wa.me/?text=${encoded}`;

  window.open(targetUrl, '_blank', 'noopener');
}

/**
 * Abre directamente un chat de WhatsApp con el Desarrollador (ChrizDev al 318 351 7802).
 */
export function openWhatsAppDev(text: string): void {
  openWhatsApp(text, CHRIZDEV_WHATSAPP_PHONE);
}

