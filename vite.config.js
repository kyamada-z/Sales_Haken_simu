import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vercel serves this app at the domain root; Pages uses the repository path.
  base: process.env.VERCEL === '1' ? '/' : '/Sales_Haken_simu/',
})

