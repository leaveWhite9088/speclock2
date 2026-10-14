import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发期代理：/api → 后端（DEV-PLAN.md §2 通用约定：后端 127.0.0.1:8000）
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
