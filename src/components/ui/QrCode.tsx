import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  size?: number;
  className?: string;
}

export function QrCode({ value, size = 180, className = '' }: QrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    if (!value) return;
    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then(setDataUrl)
      .catch((err) => console.error('Error generating QR code:', err));
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex items-center justify-center rounded-xl bg-slate-100 text-slate-400 text-xs ${className}`}
      >
        Generando QR...
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt="Código QR"
      width={size}
      height={size}
      className={`rounded-xl border border-slate-200 shadow-sm bg-white p-2 ${className}`}
    />
  );
}
