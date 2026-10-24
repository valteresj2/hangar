// Standalone mock: `node tests/mock-anthropic/cli.ts [port]` (Node 24 runs TypeScript directly).
// Then: ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_AUTH_TOKEN=mock-token claude -p "[[script:text]] oi"
import { startMockAnthropic } from './server.ts'

const port = Number(process.argv[2] ?? 0)
const mock = await startMockAnthropic({ port, log: (line) => console.log(`[mock] ${line}`) })
console.log(`[mock] listening on ${mock.url}`)

const shutdown = async () => {
  if (mock.unknown.length) {
    console.log('[mock] unknown routes the client called:')
    for (const r of mock.unknown) console.log(`  ${r.method} ${r.path}`)
  }
  await mock.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
