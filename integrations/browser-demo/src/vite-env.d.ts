/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHIP_API_BASE_URL: string;
  readonly VITE_SHIP_CLIENT_ID: string;
  readonly VITE_SHIP_REDIRECT_URI?: string;
  readonly VITE_SHIP_SCOPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
