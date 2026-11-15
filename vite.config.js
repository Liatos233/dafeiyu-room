import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 前端源码在 public/room，构建产物输出到 dist/room。
// base=/room/ 让 dev 与 prod 的 URL 都带 /room/ 前缀，与 bridge/nginx 的路径一致。
export default defineConfig({
  root: resolve(__dirname, 'public/room'),
  base: '/room/',
  publicDir: false,           // 资产（webm/glb）不走 Vite copy，仍由 bridge/nginx 提供
  build: {
    outDir: resolve(__dirname, 'dist/room'),
    emptyOutDir: true,
    assetsDir: '_vite',        // 避免与 /room/assets/（webm）冲突
    rollupOptions: {
      input: resolve(__dirname, 'public/room/index.html')
    }
  },
  server: {
    port: 5173,
    proxy: {
      // dev 时 API 与静态资产仍回源到本地 bridge（:3101）
      '/api': 'http://127.0.0.1:3101',
      '/room/assets': 'http://127.0.0.1:3101',
      '/room/vendor': 'http://127.0.0.1:3101'
    }
  }
});
