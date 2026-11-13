import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'C:/Users/vilni/Desktop/test/discord-clone/client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5177,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3111',
      '/uploads': 'http://127.0.0.1:3111',
      '/socket.io': { target: 'http://127.0.0.1:3111', ws: true }
    }
  }
});
