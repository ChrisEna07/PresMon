# Guía de Despliegue — PresMon by ChrizDev

Guía completa para dejar PresMon funcionando: modo offline (ya funciona), sincronización en la nube con Firebase, publicación en internet y instalación como app en Android/iPhone.

---

## 1. Comandos básicos del proyecto

```bash
npm install        # instalar dependencias (solo la primera vez)
npm run dev        # desarrollo en http://localhost:5173
npm run build      # compilar para producción → carpeta dist/
npm run preview    # probar el build localmente
```

**Accesos iniciales (cámbialos en Ajustes):**
- Super Admin: `ChrizDev` / `ChrizDev2026*`
- Prestamista demo: `admin` / `admin123`

---

## 2. Firebase — parte ONLINE (sincronización)

La app ya funciona 100% offline sin Firebase. Firebase solo agrega respaldo en la nube y sync multi-dispositivo.

### Paso a paso

1. Ve a https://console.firebase.google.com y crea un proyecto (ej: `presmon-prod`). Puedes desactivar Google Analytics.
2. En la consola: **Build → Firestore Database → Crear base de datos** → modo **producción** → ubicación `us-central1` (o southamerica si aparece).
3. En **Build → Authentication**: NO es obligatorio. La app usa su propio login local.
4. ✅ **YA ESTÁ HECHO**: el proyecto `presmon-d4454` quedó precargado en el archivo `.env` de la app:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=presmon-d4454
...
```

   Con esto la sincronización funciona automáticamente al compilar (`npm run build`), sin que nadie tenga que pegar llaves en la app. El Super Admin puede verlas/sobrescribirlas en Ajustes; los administradores de tenant **no** tienen acceso a ellas.

5. Si cambias de proyecto Firebase, edita el `.env` (o cópialo desde `.env.example`) con los valores de la configuración web del nuevo proyecto.

### Reglas de seguridad de Firestore (pestaña "Reglas")

**Opción A — Para empezar YA (sin Firebase Auth):** PresMon usa login propio, así que para que sincronice sin activar Auth, publica estas reglas:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{col}/{doc} {
      allow read, write: if col in ['tenants','users','borrowers','loans','installments','audit_logs'];
    }
  }
}
```

> ⚠️ Con estas reglas cualquiera con la URL de tu app podría leer la copia en la nube. Suficiente para uso interno/piloto.

**Opción B — Producción seria (recomendada a futuro):** activa **Firebase Authentication** (email/contraseña), inicia sesión también en Firebase desde la app y restringe por `request.auth.uid` + pertenencia al tenant.

### Índices

Firestore creará índices automáticamente; si la consola te muestra un link de error "The query requires an index", ábrelo y dale **Crear índice** (es por las consultas `where tenantId ==`).

### Cómo funciona el sync

- Cada registro local tiene `syncStatus: SYNCED | PENDING | CONFLICT`.
- Al crear/editar algo sin internet queda `PENDING`; al volver la conexión, el Service Worker detecta el evento `online` y sube todo automáticamente (también hay botón manual en la barra superior).
- Conflictos se resuelven **Last-Write-Wins** comparando `updatedAt` (gana el más reciente); si tu cambio local pierde, queda registrado en auditoría como `SYNC_CONFLICT`.

---

## 3. ¿Necesito Vercel? Opciones de publicación

**Sí, necesitas publicarla en un HTTPS público para usarla desde el navegador e instalarla como app.** El service worker y la instalación PWA **exigen HTTPS** (o localhost). Opciones:

| Opción | Costo | Recomendada para |
|---|---|---|
| **Vercel** (recomendada) | Gratis | Desplegar en 2 minutos con dominio `*.vercel.app` |
| Netlify / Cloudflare Pages | Gratis | Igual de válidas |
| Firebase Hosting | Gratis | Si ya usas Firebase |
| Tu propio servidor | Variable | Si tienes hosting con HTTPS y dominio propio |

### Desplegar en Vercel (la más fácil)

1. Sube el proyecto a GitHub (crea repo y haz push).
2. Entra a https://vercel.com → **Add New → Project** → importa el repo.
3. Vercel detecta Vite automáticamente. Configuración:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
4. Click **Deploy**. Listo: tendrás `https://presmon-tuusuario.vercel.app`.

Alternativa sin Git (desde tu PC):
```bash
npm i -g vercel
vercel --prod
```

### Desplegar en Firebase Hosting (alternativa)

```bash
npm i -g firebase-tools
firebase login
firebase init hosting   # selecciona tu proyecto, carpeta pública: dist, SPA: sí
npm run build
firebase deploy
```

---

## 4. ¿Ejecutable para Android e iPhone?

**No hace falta compilar apps nativas.** PresMon es una **PWA instalable**: desde el navegador se instala como si fuera una app nativa, con icono propio, pantalla completa y funcionamiento **sin internet** (todo queda cacheado + datos en IndexedDB del dispositivo).

### Android (Chrome)
1. Abre la URL de la app (ej: `https://presmon.vercel.app`) en Chrome.
2. Te aparecerá el banner **"Instalar aplicación"** o menú ⋮ → **"Instalar aplicación" / "Añadir a pantalla de inicio"**.
3. Se instala como app independiente con su icono. Funciona offline tras el primer uso.

### iPhone/iPad (Safari — importante: debe ser Safari)
1. Abre la URL en **Safari**.
2. Botón **Compartir** (cuadrado con flecha) → **"Añadir a pantalla de inicio"**.
3. Se abre en pantalla completa como app. iOS cachea la app para uso offline.

### Requisitos para que la instalación funcione
- ✅ HTTPS (Vercel lo da gratis)
- ✅ Manifest válido (ya incluido: nombre, iconos 192/512, display standalone)
- ✅ Service worker registrado (ya incluido vía vite-plugin-pwa)

### ¿Y si QUIERO una app en Play Store / App Store?
Se puede envolver la PWA sin reescribir nada:
- **Play Store:** usa [PWABuilder](https://www.pwabuilder.com) (gratis, genera APK/AAB firmado desde tu URL) o Bubblewrap de Google.
- **App Store:** PWABuilder también genera paquete para iOS, o usa Capacitor (`npx cap add ios`) apuntando a tu build. Requiere cuenta Apple Developer ($99/año). Play Store tiene fee único de $25.

Para empezar, **no lo necesitas**: la PWA instalada es indistinguible para el usuario final.

---

## 5. Uso offline (ya funciona así)

1. Primer ingreso: abre la app **con internet** una vez (para cachear todos los archivos).
2. Desde ahí: modo avión / sin señal → la app abre igual desde el icono instalado.
3. Todo se guarda en IndexedDB del dispositivo (prestatarios, préstamos, cuotas, mora, PDFs, auditoría).
4. El motor de mora corre localmente cada día al abrir la app.
5. Los Pagarés PDF se generan en el dispositivo, sin servidores.
6. Cuando vuelva el internet: sincroniza solo (badge "N pendientes" en la barra superior).

> Nota: los datos viven en el navegador/dispositivo. Usa **Ajustes → Exportar todo (JSON)** periódicamente como respaldo adicional, y no borres los datos del sitio en Chrome/Safari.

---

## 6. Checklist final de lanzamiento

- [ ] `npm run build` sin errores
- [ ] Deploy en Vercel funcionando con HTTPS
- [ ] Cambiar contraseñas iniciales (ChrizDev y admin) en Ajustes
- [ ] Configurar Firebase en Ajustes y probar conexión
- [ ] Reglas de Firestore aplicadas
- [ ] Instalar en tu celular y probar modo avión
- [ ] Crear tus organizaciones (tenants) desde Super Admin
- [ ] Portal de clientes (`ENABLE_CLIENT_PORTAL`) apagado por defecto — actívalo solo si lo necesitas
