import { defineConfig } from 'vite';

// Minimal vanilla-TS SPA config (PF-802, PLUGFORGE.MD §4: "@ship/sdk is the
// only runtime dependency" — no framework). `VITE_SHIP_*` env vars are read
// by src/main.ts via import.meta.env at build/serve time; see README.md for
// what each one means and how e2e/browser-demo-pkce.spec.ts supplies them.
export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
  },
});
