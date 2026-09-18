import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 3200,
    proxy: {
      // 开发期把 /api 转给后端，前后端同源，不需要额外配置 CORS
      '/api': {
        target: 'http://localhost:3201',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
});
