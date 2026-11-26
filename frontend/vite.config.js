import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em produção o site é servido pelo próprio backend Go (mesmo endereço da API).
// Em desenvolvimento (npm run dev, porta 5173), o Vite repassa /api para o backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist',
    // O Gemeo3D (three.js) fica num arquivo separado de ~590 kB, baixado só quando o painel abre
    chunkSizeWarningLimit: 700,
  },
});
