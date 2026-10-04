import { createServer } from 'node:http'

if (process.env.FIXTURE_EXIT_CODE) process.exit(Number(process.env.FIXTURE_EXIT_CODE))

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/fixture') {
    response.end(JSON.stringify({ cwd: process.cwd(), conversationOverride: process.env.OUTLOUD_CONVERSATIONS_DB ?? null }))
    return
  }
  if (request.headers['x-outloud-desktop-token'] !== process.env.OUTLOUD_DESKTOP_TOKEN) {
    response.writeHead(403).end('{}')
    return
  }
  if (request.url === '/desktop/status') {
    response.end('{"status":"ready"}')
  } else if (request.url === '/desktop/shutdown') {
    setTimeout(() => {
      response.writeHead(202).end('{}')
      setTimeout(() => {
        server.close()
        server.closeAllConnections()
      }, Number(process.env.FIXTURE_DRAIN_MS ?? 0))
    }, Number(process.env.FIXTURE_SHUTDOWN_RESPONSE_MS ?? 0))
  } else {
    response.writeHead(404).end('{}')
  }
})
server.listen(Number(process.env.FIXTURE_PORT), '127.0.0.1')
