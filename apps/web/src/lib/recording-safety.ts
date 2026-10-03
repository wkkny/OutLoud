import { snapshotSchema } from '@/lib/protocol'

export async function confirmRecordingStopped(backendUrl: string, oldSessionId: string): Promise<boolean> {
  // Another tab may remain connected and recording. Confirm THIS client's capture,
  // not global ui_connected/recording. A closed socket alone is not confirmation.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`${backendUrl}/state`, {
        headers: { 'X-Session-ID': oldSessionId }, signal: AbortSignal.timeout(1000), cache: 'no-store',
      })
      if (response.ok) {
        const parsed = snapshotSchema.safeParse(await response.json())
        if (parsed.success && !parsed.data.client_connected && !parsed.data.capture_owned) return true
      }
    } catch { /* Bounded safety check; never claim a stop on network failure. */ }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
