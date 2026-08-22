import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  // VITE_* vars come from the repo-root .env / .env.local
  envDir: resolve(__dirname, '../..'),
  // The dev-server port is negotiable: launch.json has autoPort on, so a
  // second session can run its own copy beside one already on 5173. The
  // launcher hands the assigned port down as PORT; without it, vite's own
  // default (5173, incrementing when busy) applies as before.
  server: process.env.PORT ? { port: Number(process.env.PORT) } : undefined,
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
