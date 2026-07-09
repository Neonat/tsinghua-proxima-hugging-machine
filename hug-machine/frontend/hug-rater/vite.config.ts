import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// publicDir points at hug-machine/data so the app can fetch
// /mannequin_zones.json exactly as the backend reads it.
export default defineConfig({
  plugins: [react()],
  publicDir: '../../data',
})
