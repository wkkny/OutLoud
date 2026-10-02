import { snapshotSchema } from '@/lib/protocol'

export async function confirmRecordingStopped(backendUrl: string): Promise<boolean> {
  // Closing the owner socket invalidates its token and queues a stop on the backend.
  // Do not assume HTTP 202 or a locally closed socket means audio is already finalized.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`${backendUrl}/state`, { signal: AbortSignal.timeout(1000), cache: 'no-store' })
      if (response.ok) {
        const parsed = snapshotSchema.safeParse(await response.json())
        if (parsed.success && !parsed.data.ui_connected && !parsed.data.recording && parsed.data.pending_commands === 0 && parsed.data.workers.recording.status !== 'failed') {
          return true
        }
      }
    } catch {
      // Keep retries bounded. If the backend cannot confirm, the UI must say so.
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
