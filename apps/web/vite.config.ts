import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.GQLCOV_ADMIN_URL ?? 'http://localhost:4001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['source'] },
  server: { port: 5173, proxy: { '/api': api, '/docs': api, '/metrics': api } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
});
