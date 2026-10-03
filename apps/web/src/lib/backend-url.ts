// Override for a second local backend/worktree without changing the default service.
export const HTTP_URL = (import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8765').replace(/\/$/, '')
const eventsUrl = new URL(`${HTTP_URL}/events`)
eventsUrl.protocol = eventsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
export const WS_URL = eventsUrl.toString()
