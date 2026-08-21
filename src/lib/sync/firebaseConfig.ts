export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

const KEY = 'presmon_firebase_config_v1';

const REQUIRED_FIELDS: Array<keyof FirebaseConfig> = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

function envConfig(): FirebaseConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const cfg: Partial<FirebaseConfig> = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
  const complete = REQUIRED_FIELDS.every((f) => typeof cfg[f] === 'string' && cfg[f]);
  return complete ? (cfg as FirebaseConfig) : null;
}

export function isEnvConfigured(): boolean {
  return envConfig() !== null;
}

export function loadFirebaseConfig(): FirebaseConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as Partial<FirebaseConfig>;
      const complete = REQUIRED_FIELDS.every((f) => typeof cfg[f] === 'string' && cfg[f]);
      if (complete) return cfg as FirebaseConfig;
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return envConfig();
}

export function saveFirebaseConfig(cfg: FirebaseConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearFirebaseConfig(): void {
  localStorage.removeItem(KEY);
}
