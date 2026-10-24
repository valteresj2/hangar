# Regras de engajamento (todos os agentes)

Você é um dos seis agentes que constroem o **Hangar** em paralelo, na mesma pasta:
`C:\Users\valteresj\OneDrive\Documentos\Harness\hangar`. O chief (agente coordenador) integra o trabalho.

Leia antes de começar: `docs/FEATURES.md` (o que construir), `src/shared/contracts.ts`, `src/shared/ipc.ts`,
`src/main/core/*`, `src/renderer/src/core/*`, `src/renderer/src/App.tsx` e `src/renderer/src/shell/*`.

## Stack

Electron 45 + electron-vite 6 + Vite 8 + React 19 + TypeScript (strict) + zustand. Windows 11, PowerShell.
Pacotes já instalados (use estes): `@anthropic-ai/claude-agent-sdk`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`,
`@xterm/addon-web-links`, `react-markdown`, `remark-gfm`, `diff`, `node-cron`, `shiki`, `nanoid`, `zustand`.

## Propriedade de arquivos (inegociável)

- Você só cria/edita arquivos dentro das pastas do seu feature:
  `src/main/features/<feature>/**`, `src/renderer/src/features/<feature>/**`, `src/shared/features/<feature>.ts`
  e `docs/agents/reports/<feature>.md`.
- **Não edite** arquivos do chief: `src/shared/contracts.ts`, `src/shared/ipc.ts`, `src/main/core/**`,
  `src/main/index.ts`, `src/main/features/index.ts`, `src/preload/**`, `src/renderer/src/{App.tsx,main.tsx,styles.css,core/**,shell/**}`,
  `package.json`, configs. Se precisar mudar algo neles, descreva a mudança exata no seu relatório (seção "Pedidos ao chief")
  e contorne localmente enquanto isso.
- Não edite pastas de outros features. Para falar com outro feature use só os canais/APIs listados em "Contratos entre features".
- Mantenha os exports que App/TopBar/SidePanel já importam do seu `src/renderer/src/features/<feature>/index.tsx`
  (mesmos nomes e props). Você pode criar quantos arquivos quiser atrás deles.

## Proibido

- `npm install`/`uninstall` (exceto o agente **terminal**, só para o pacote de PTY). Precisa de outra dependência? Liste em
  "Pedidos ao chief" e siga com o que existe.
- `git commit`, `git checkout`, `git stash`, `git reset` ou qualquer comando que mude o estado do repositório. O chief comita.
- Rodar `npm run dev` deixando processos órfãos. Pode rodar o app para testar, mas encerre-o depois.

## Convenções

- IPC: request/response `<feature>:<acao>` via `ipcMain.handle`; eventos main→renderer `<feature>:event:<nome>` via
  `broadcast()` de `src/main/core/broadcast.ts`. Declare canais e tipos em `src/shared/features/<feature>.ts`.
- Renderer chama `window.hangar.invoke(canal, ...args)` e `window.hangar.on(canal, cb)` (ou `bridge` de `core/api.ts`).
- Persistência central: `db('sessions'|'projects'|'groups')` e `settings()` de `src/main/core/store.ts`.
  Dados próprios do feature: arquivos em `join(app.getPath('userData'), 'hangar-data', '<feature>')`.
- Eventos entre features no main: `bus` de `src/main/core/bus.ts` (veja a lista de eventos no topo do arquivo).
- Estilo: variáveis CSS de `styles.css` (`--bg`, `--text`, `--accent`, `--border`, …) e classes `.btn`, `.btn-primary`,
  `.icon-btn`, `.input`, `.muted`. CSS do feature em `*.module.css`. Precisa funcionar em tema claro e escuro.
- Textos da interface em **português do Brasil**. Código e comentários em inglês, densidade de comentários parecida com a do core.
- Sem `any` desnecessário; o typecheck é `strict`.

## Contratos entre features (fixados pelo chief)

Main-side (importe direto, só estes símbolos):
- `src/main/features/engine/api.ts` (engine implementa):
  - `sendPrompt(sessionId: string, text: string, opts?: { attachments?: string[] }): Promise<void>`
  - `interrupt(sessionId: string): Promise<void>`
  - `readTranscript(sessionId: string): Promise<TranscriptEntry[]>` (tipo exportado de `src/shared/features/engine.ts`)
  - `searchTranscripts(query: string): Promise<{ sessionId: string; snippet: string }[]>`
- `src/main/features/git/api.ts` (git implementa):
  - `createWorktree(cwd: string, branch?: string): Promise<Worktree>`
  - `removeWorktree(wt: Worktree): Promise<void>`
  - `isGitRepo(cwd: string): Promise<boolean>`

IPC (renderer pode chamar os de outros features):
- `engine:send` (sessionId, text, opts?) → void · `engine:interrupt` (sessionId) · `engine:history` (sessionId) → TranscriptEntry[] · `engine:search` (query)
- `git:worktreeCreate` (cwd, branch?) → Worktree · `git:isRepo` (cwd) → boolean

Eventos do `bus` (engine emite; outros escutam):
- `session:status` `{ sessionId, status }` · `session:turn-ended` `{ sessionId, result: 'success' | 'error' }`
- `session:needs-input` `{ sessionId, reason: 'permission' | 'question' }` · `session:file-written` `{ sessionId, path }`

Diretório de trabalho de uma sessão: `session.worktree?.path ?? session.cwd`.

## Verificação antes de terminar

1. `npm run typecheck` sem erros nos **seus** arquivos (erros em pastas alheias: ignore e mencione).
2. `npm run build` passa.
3. Se der, rode o app (`npm run dev`), exercite seu feature e encerre o processo.

## Relatório final

Escreva `docs/agents/reports/<feature>.md` com: o que foi feito, o que ficou faltando, como testar, "Pedidos ao chief"
(mudanças em arquivos do chief ou dependências) e riscos conhecidos. Depois responda no terminal só: `PRONTO: <feature>`.
Se travar por algo que só o chief resolve, escreva o relatório com o bloqueio e responda `BLOQUEADO: <motivo>`.
