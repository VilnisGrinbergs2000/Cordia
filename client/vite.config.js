import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function manualChunks(id) {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('lucide-react')) return 'icons';
  if (id.includes('socket.io') || id.includes('engine.io')) return 'realtime';
  if (id.includes('react-router') || id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
    return 'react';
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true }
    }
  }
});
