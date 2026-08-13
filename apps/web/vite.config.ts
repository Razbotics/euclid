import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Headless export page — loaded by apps/renderer in Chromium
        render: resolve(__dirname, 'render.html'),
      },
    },
  },
})
