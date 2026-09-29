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
    port: 3000,
    proxy: {
      // 开发期把 /api 转给后端，前后端同源，不需要额外配置 CORS
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyRes', (upstream, _request, response) => {
            // 后端中途断开时结束代理连接，让 EventSource 能发现断线并重连。
            upstream.on('close', () => {
              if (!upstream.complete) response.destroy();
            });
          });
        },
      },
    },
  },
  plugins: [react()],
});
