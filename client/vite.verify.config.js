import base from './vite.config.js';

export default {
  ...base,
  server: {
    ...base.server,
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:3105',
      '/uploads': 'http://127.0.0.1:3105',
      '/socket.io': { target: 'http://127.0.0.1:3105', ws: true }
    }
  }
};
