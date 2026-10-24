# Relatório — wave2-release (instalador Windows)

## Resumo

`npm run dist` gera `release/Hangar-Setup-0.1.0.exe` (NSIS, x64, **228 MB** / 228.447.609 bytes, mais o `.blockmap` e o
`latest.yml`). `npm run pack` gera `release/win-unpacked/` (663 MB descompactado). O app empacotado abre, o terminal
integrado funciona e uma mensagem para o Claude (Haiku) responde. O instalador **não** foi executado, como pedido.

Há **um problema que só o chief resolve** (em `src/`): o fallback para o `claude.exe` embutido no Agent SDK não funciona
no app empacotado. O caminho normal (CLI `claude` do usuário) funciona. Detalhes e patch em "Pedidos ao chief".

## O que foi feito

- `npm install -D electron-builder` → `electron-builder@26.18.0` (único pacote instalado; `package-lock.json` atualizado).
- `package.json`: scripts `pack` (`electron-vite build && electron-builder --dir`) e `dist`
  (`electron-vite build && electron-builder --win nsis --x64`). Nada mais mudou nele.
- `electron-builder.yml`:
  - `appId: dev.hangar.app` (igual ao `app.setAppUserModelId`), `productName: Hangar`, saída em `release/`
    (já no `.gitignore`), recursos em `build/`.
  - `files`: `out/**` + `package.json`; os `node_modules` de produção entram automaticamente. Excluídos: `*.map`, `*.pdb`,
    pacotes que só o renderer usa e que o Vite já empacotou (`react`, `react-dom`, `scheduler`, `react-markdown`,
    `remark-gfm`, `shiki`, `@shikijs`, `@xterm`, `diff`, `zustand`), `node-addon-api` e as partes do node-pty que não
    são de runtime (fontes, `deps/`, scripts, binários de macOS/arm64).
  - `asarUnpack`: `node_modules/node-pty/**`, `node_modules/@anthropic-ai/claude-agent-sdk/**` e
    `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**`.
  - `npmRebuild: false`.
  - NSIS: `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`, atalho na área de trabalho
    (`always`) e no Menu Iniciar ("Hangar"), desinstalador com ícone, `deleteAppDataOnUninstall: false` (o desinstalador
    não apaga sessões/configurações), `runAfterFinish: true`. Nome: `Hangar-Setup-${version}.exe`.
- `build/icon.png` (512 px) e `build/icon.ico` (256/128/64/48/32/16, entradas PNG) gerados por `build/make-icons.cjs`:
  um SVG inline (hangar em arco `#c96442`, base `#a9502f`, portas listradas, sobre fundo claro `#faf9f5` arredondado) é
  rasterizado num canvas do Electron e o ICO é montado em Node. Nada baixado da internet. Para regerar:
  `npx electron build/make-icons.cjs`.

## O que foi desempacotado (`resources/app.asar.unpacked`)

| Pacote | Tamanho | Conteúdo relevante |
|---|---|---|
| `node-pty` | 3,9 MB | `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node`, `winpty.dll`, `winpty-agent.exe`, `conpty/{conpty.dll,OpenConsole.exe}`, `third_party/conpty/*/win10-x64`, `lib/` (inclui o helper forkado `conpty_console_list_agent.js`) |
| `@anthropic-ai/claude-agent-sdk` | 4,0 MB | `sdk.mjs` e afins |
| `@anthropic-ai/claude-agent-sdk-win32-x64` | 284 MB | `claude.exe` nativo que o SDK usa quando não recebe `pathToClaudeCodeExecutable` |

`app.asar` ficou com 16 MB (`out/` + dependências de runtime do main: `node-cron`, `nanoid` e o que o coletor do
electron-builder puxou da árvore do `react-markdown`).

As peer deps do SDK (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`) **não** entram no pacote, e está tudo
bem assim: só o `core.mjs` do SDK as importa, e o Hangar só importa `sdk.mjs`, que não depende delas (conferido nos
imports e na prática: o chat funcionou empacotado).

## Verificação

1. `npm run pack` e depois `release/win-unpacked/Hangar.exe --user-data-dir=<pasta temporária> --remote-debugging-port=9445`
   (pelo DevTools Protocol):
   - Terminal: `terminal:create` com PowerShell numa pasta temporária → saída `PTY-OK <pasta>`; pela UI, abrir a sessão
     e clicar em **Terminal** mostra o PowerShell no cwd da sessão. Prova que o node-pty desempacotado carrega.
   - Claude: sessão com `model: 'haiku'` numa pasta temporária, `engine:send` "Responda apenas com a palavra PONG" →
     transcript `user → assistant: PONG → result: success` (4 s, US$ 0,0026). Aqui o engine usou o `claude.exe` do usuário
     (`~/.local/bin`), que é o caminho preferido do `resolveClaudeExecutable()`.
   - Fallback sem CLI (porta 9446, `PATH` sem `claude`, `USERPROFILE` falso, `CLAUDE_CONFIG_DIR` apontando para as
     credenciais reais): **falha** — `Claude Code native binary at …\resources\app.asar\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe exists but failed to launch`.
     Com `claudeExecutablePath` apontando para o mesmo arquivo em `app.asar.unpacked`, a mensagem respondeu `PONG`
     normalmente: o binário desempacotado funciona, só falta o engine passar o caminho certo.
   - Todos os processos de teste foram encerrados (inclusive filhos `claude.exe`).
2. `npm run dist` → `release/Hangar-Setup-0.1.0.exe` (228 MB). Não executado.

## Pedidos ao chief

1. **(Importante) Fallback do binário embutido do SDK no app empacotado** — `src/main/features/engine/sdk.ts`,
   em `resolveClaudeExecutable()`, antes do `return existsSync(native) ? native : undefined`. O SDK resolve o binário
   com `createRequire(import.meta.url)`, que dentro do Electron empacotado devolve um caminho em `app.asar\…`, e
   `child_process.spawn` não executa nada de dentro do asar. Sugestão:

   ```ts
   import { createRequire } from 'node:module'
   import { sep } from 'node:path'
   // …
   const native = join(homedir(), '.local', 'bin', name)
   if (existsSync(native)) return native
   // Packaged app: the SDK would resolve its bundled binary inside app.asar, which cannot be spawned.
   try {
     const bundled = createRequire(__filename)
       .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${name}`)
       .replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
     if (existsSync(bundled)) return bundled
   } catch {
     // Platform package not installed: let the SDK report it.
   }
   return undefined
   ```
   (O main é CJS, então `__filename` existe; `@anthropic-ai/claude-agent-sdk-win32-x64` precisa continuar externo no
   electron-vite, o que já é o padrão para dependências.) Sem isso, quem não tem o Claude Code CLI no PATH nem em
   `~/.local/bin` não consegue conversar no app instalado (a menos que configure o caminho manualmente nas Configurações).
2. **Decisão de tamanho:** o `claude.exe` embutido (284 MB) é a maior parte do instalador de 228 MB. Se o produto exigir
   o CLI instalado (o engine já prefere o do usuário, por causa do login da assinatura), dá para tirar
   `@anthropic-ai/claude-agent-sdk-win32-x64` do pacote com `'!node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**'`
   em `files` (e remover a linha correspondente de `asarUnpack`); o instalador cai para algo na casa de dezenas de MB.
   Mantive incluído porque o brief pede o que o SDK precisa.
3. O electron-builder avisa que `@electron/rebuild` em `devDependencies` é redundante (ele já traz o seu). Remover com
   `npm uninstall -D @electron/rebuild` (não fiz: fora da exceção desta missão).

## Avisos e riscos

- **Sem assinatura de código**: o Windows SmartScreen vai mostrar "O Windows protegeu o computador" no primeiro uso do
  instalador (o usuário precisa clicar em "Mais informações → Executar assim mesmo"). Antivírus podem ser mais
  desconfiados de `claude.exe`/`OpenConsole.exe` não assinados pelo nosso publisher (eles já vêm assinados pelos
  fornecedores originais; o electron-builder só pula a nossa assinatura).
- `perMachine: false`: instala em `%LOCALAPPDATA%\Programs\Hangar` sem pedir admin (o usuário pode trocar a pasta;
  `allowElevation` permite elevar se escolher uma pasta protegida).
- Os dados do app (`%APPDATA%\Hangar\hangar-data`) são preservados na desinstalação.
- Sem auto-update configurado (o `latest.yml` gerado é inofensivo; só seria usado com `electron-updater` + `publish`).
- O build baixa (na primeira vez) o zip do Electron, NSIS e 7zip para o cache do electron-builder; em máquina sem
  internet o primeiro `dist` falha.
- O coletor de dependências do electron-builder ainda inclui no `app.asar` a árvore transitiva do `react-markdown`
  (alguns MB, inofensivo); se quiser enxugar mais, mover pacotes só do renderer para `devDependencies` resolve de vez.
