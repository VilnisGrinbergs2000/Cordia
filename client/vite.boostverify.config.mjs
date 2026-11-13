import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: 5176,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3108',
      '/uploads': 'http://127.0.0.1:3108',
      '/socket.io': { target: 'http://127.0.0.1:3108', ws: true }
    }
  }
});
