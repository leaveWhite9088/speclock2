import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dashboard is same-origin with the backend: /api is proxied (SSE included), so the backend needs no CORS.
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8787';
const port = Number(process.env.WEB_PORT) || 5234;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: backend, changeOrigin: true } } },
  preview: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: backend, changeOrigin: true } } },
});
