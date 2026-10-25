// Loopback HTTP server that serves artifacts to the sandboxed <iframe> in the ArtifactsPanel.
//
// Why not `srcdoc`: srcdoc/blob:/data: frames inherit the app's CSP (`script-src 'self'`), so any
// inline <script> in an artifact would be blocked. A document loaded from http://localhost gets its
// own (empty) policy, and the frame stays isolated through `sandbox="allow-scripts"` (opaque origin).
//
// URLs look like http://localhost:<port>/a/<token>/<artifactId>/<file name>. The random token keeps
// other local processes out; relative assets resolve inside the artifact's own folder only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import type { Artifact } from '../../../shared/features/preview'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mermaid': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

const token = randomBytes(18).toString('hex')
const servers: Server[] = []
let port: number | undefined
let lookup: (id: string) => Artifact | undefined = () => undefined

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Wrapper page that renders a Mermaid diagram (Mermaid is loaded from a CDN; the source shows if offline). */
function mermaidPage(source: string, dark: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;background:${dark ? '#1a1a19' : '#ffffff'};color:${dark ? '#ecebe6' : '#1f1e1d'};font-family:'Segoe UI',system-ui,sans-serif}
  .wrap{padding:16px;display:flex;justify-content:center}
  pre.mermaid{white-space:pre-wrap;font-family:'Cascadia Code',Consolas,monospace;font-size:13px}
  .err{color:#c0392b;font-size:12px;padding:0 16px}
</style></head>
<body><div class="wrap"><pre class="mermaid">${escapeHtml(source)}</pre></div><div class="err" id="err"></div>
<script type="module">
  try {
    const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')
    mermaid.initialize({ startOnLoad: false, theme: ${dark ? "'dark'" : "'default'"}, securityLevel: 'strict' })
    await mermaid.run({ querySelector: 'pre.mermaid' })
  } catch (e) {
    document.getElementById('err').textContent = 'Não foi possível renderizar o diagrama (' + (e && e.message ? e.message : e) + '). Mostrando o código-fonte.'
  }
</script></body></html>`
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  })
  res.end(body)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed')
  const url = new URL(req.url ?? '/', 'http://localhost')
  let parts: string[]
  try {
    parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p))
  } catch {
    return send(res, 400, 'Bad request')
  }
  if (parts[0] !== 'a' || parts[1] !== token || !parts[2]) return send(res, 404, 'Not found')
  const artifact = lookup(parts[2])
  if (!artifact) return send(res, 404, 'Not found')

  const root = resolve(dirname(artifact.path))
  const rel = parts.slice(3).join('/') || basename(artifact.path)
  const file = resolve(root, rel)
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) return send(res, 403, 'Forbidden')

  try {
    const data = await readFile(file)
    if (file === resolve(artifact.path) && artifact.kind === 'mermaid') {
      return send(res, 200, mermaidPage(data.toString('utf8'), url.searchParams.get('theme') === 'dark'), MIME['.html'])
    }
    send(res, 200, data, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
  } catch {
    send(res, 404, 'Not found')
  }
}

function listen(server: Server, host: string, wanted: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(wanted, host, () => {
      server.removeListener('error', reject)
      const addr = server.address()
      resolvePort(typeof addr === 'object' && addr ? addr.port : wanted)
    })
  })
}

/** Starts the server on 127.0.0.1 (and ::1 on the same port, when available). */
export async function startArtifactServer(find: (id: string) => Artifact | undefined): Promise<void> {
  lookup = find
  const v4 = createServer((req, res) => void handle(req, res))
  port = await listen(v4, '127.0.0.1', 0)
  servers.push(v4)
  // Chromium may resolve "localhost" to ::1 first; serve there too so the frame never stalls.
  const v6 = createServer((req, res) => void handle(req, res))
  try {
    await listen(v6, '::1', port)
    servers.push(v6)
  } catch {
    v6.close()
  }
}

/** Isolated URL for an artifact, or undefined if the server is not running. */
export function artifactUrl(artifact: Artifact): string | undefined {
  if (!port) return undefined
  return `http://localhost:${port}/a/${token}/${encodeURIComponent(artifact.id)}/${encodeURIComponent(basename(artifact.path))}`
}

export function stopArtifactServer(): void {
  for (const s of servers) s.close()
  servers.length = 0
  port = undefined
}
