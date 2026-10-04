import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

export async function startUi() {
  // The managed backend has a fixed origin; do not inherit a browser override.
  process.env.VITE_BACKEND_URL = 'http://127.0.0.1:8765'
  const server = await createServer({
    root: fileURLToPath(new URL('../../web/', import.meta.url)),
    configFile: fileURLToPath(new URL('../../web/vite.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
  })
  try { await server.listen(); return server }
  catch (error) { await server.close(); throw error }
}
