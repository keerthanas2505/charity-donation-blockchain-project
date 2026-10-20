import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Raise the warning threshold — React.lazy + code-split chunks will be
    // well below this limit.  The underlying rolldown bundler already handles
    // vendor splitting via dynamic import() in App.tsx.
    chunkSizeWarningLimit: 600,
  },
})
