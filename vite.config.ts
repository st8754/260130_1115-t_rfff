
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true, // 啟動後自動開啟瀏覽器
    strictPort: false, // 設為 false，避免端口占用報錯
    host: true, // 允許透過區域網路 IP 訪問
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  }
});
