export function openWhatsApp(text: string): void {
  const encoded = encodeURIComponent(text);
  const appUrl = `whatsapp://send?text=${encoded}`;
  const webUrl = `https://api.whatsapp.com/send?text=${encoded}`;
  let handled = false;
  const onVisible = () => {
    if (document.hidden) handled = true;
  };
  document.addEventListener('visibilitychange', onVisible);
  window.location.href = appUrl;
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', onVisible);
    if (!handled && !document.hidden) {
      window.open(webUrl, '_blank', 'noopener');
    }
  }, 1500);
}
