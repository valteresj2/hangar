# Relatório — wave7-release (assinatura de código e atualização automática)

## Resumo

- **Atualização automática** implementada (feature `updater`, com electron-updater): verifica ao abrir (~15 s) e a cada
  6 h, só no app instalado. Baixa quando o usuário aceita ou automaticamente (opção). "Reiniciar e atualizar",
  eventos para o renderer, log em arquivo. Painel `UpdaterPanel` pronto para Configurações → Sobre.
- **Fluxo testado de ponta a ponta** com servidor HTTP local e feed `generic` (versão 9.9.9): verificar → disponível
  (com notas) → download com progresso 0→25→50→76→100% → "pronta para instalar". Nada foi instalado.
- **Assinatura opcional por ambiente**: sem segredos o build continua sem assinatura. Com `CSC_LINK`/`CSC_KEY_PASSWORD`
  assina com `.pfx`. Com as variáveis do Azure, assina via Artifact Signing (o antigo Trusted Signing, configurado em
  `win.azureSignOptions`). O `build/ci-config.cjs` monta a config efetiva.
- **Fuses do Electron** gravadas e conferidas no `Hangar.exe`. Exceção: **`runAsNode` ficou `true`** de propósito
  (quebraria o node-pty, ver abaixo).
- **Publicação**: GitHub Releases num repositório **público só de releases** (`valteresj2/hangar-releases`, padrão),
  ou feed genérico, configurável por variáveis do repositório. Nenhum repositório foi criado.
- `.github/workflows/release.yml` (tag `v*`) e `docs/RELEASE.md` (passo a passo de certificado, segredos, SmartScreen/
  Controle Inteligente de Aplicativos, fuses, feed, como testar).
- `npm run dist` → `release/Hangar-Setup-0.1.0.exe` (**230 MB**, 230.320.182 bytes) + `.blockmap` + `latest.yml`;
  `resources/app-update.yml` aponta para `valteresj2/hangar-releases`.

## Arquivos

| Arquivo | O quê |
|---|---|
| `src/shared/features/updater.ts` | canais `updater:state/check/download/install/setAutoDownload`, evento `updater:event:state`, tipos `UpdaterState`/`UpdaterStatus`/`UpdaterProgress` |
| `src/main/features/updater/index.ts` | registra os handlers e inicia o controlador |
| `src/main/features/updater/controller.ts` | electron-updater: carga sob demanda, timers (15 s + 6 h), estados, download, `quitAndInstall` (chama `markQuitting()` para não ser barrado pelo "minimizar para a bandeja"), preferência `autoDownload` em `hangar-data/updater/prefs.json`, feed de teste por `HANGAR_UPDATE_URL` (só em dev) |
| `src/main/features/updater/log.ts` | logger em `%APPDATA%\Hangar\logs\updater.log` (rotaciona em 1 MB) |
| `src/main/features/updater/errors.ts` | mensagens legíveis (sem internet, 404/nenhuma versão, repo privado/401/403, assinatura inválida, checksum, disco cheio, build sem config) |
| `src/renderer/src/features/updater/{index.tsx,UpdaterPanel.tsx,updater.module.css}` | `UpdaterPanel`: versão atual, canal, "Verificar agora", "Baixar atualização", barra de progresso (%, MB, MB/s), "Reiniciar e atualizar", notas da versão, opção de download automático, erro legível + link para o log, aviso quando desativado |
| `electron-builder.yml` | `electronFuses`, `publish` (GitHub público), comentários sobre assinatura |
| `build/ci-config.cjs` | gera `release/electron-builder.ci.json` com o alvo de publicação (`UPDATE_*`) e o Azure (`AZURE_SIGNING_*`); valida combinações (recusa `valteresj2/hangar`, Azure incompleto) |
| `.github/workflows/release.yml` | tag `v*` / manual: confere tag × versão, `npm ci`, typecheck, build, config efetiva, `electron-builder --publish always|never`, status da assinatura, artefatos |
| `docs/RELEASE.md` | guia completo |

`package.json` não foi alterado (não precisou).

## Assinatura

- Sintaxe conferida na doc do electron-builder (code-signing e adding-electron-fuses) e no schema instalado
  (26.18.0): `win.azureSignOptions` (`endpoint`, `codeSigningAccountName`, `certificateProfileName`, `publisherName`)
  com `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`. O electron-builder instala sozinho o módulo PowerShell
  `TrustedSigning` (`Invoke-TrustedSigning`). O `.pfx` usa `CSC_LINK`/`CSC_KEY_PASSWORD` (ou `WIN_CSC_*`).
- O `azureSignOptions` **não** está no yml: a simples presença dele força a assinatura e quebraria o build local. O
  `ci-config.cjs` só o adiciona quando as quatro variáveis existem.
- Passo a passo do Azure conferido na doc da Microsoft (o serviço foi renomeado para **Artifact Signing**): provedor
  `Microsoft.CodeSigning`, papéis **Artifact Signing Identity Verifier** e **Artifact Signing Certificate Profile
  Signer**, endpoints por região, validação de 1 a 20 dias úteis.
- ⚠️ **Elegibilidade:** certificados *Public Trust* só saem para organizações em EUA, Canadá, UE, Reino Unido,
  Austrália, NZ, Japão, Coreia do Sul, Singapura, Suíça, Noruega e Israel, e para **pessoas físicas só nos EUA e no
  Canadá**. O Brasil não está na lista: para um desenvolvedor individual no Brasil, a saída hoje é um certificado
  OV/EV de uma autoridade certificadora (opção B do guia, em geral com HSM na nuvem e `signtoolOptions.sign`).
- Efeito documentado: sem assinatura, o SmartScreen avisa e o **Controle Inteligente de Aplicativos bloqueia** (foi o
  caso do `Hangar.exe` nesta máquina). Com assinatura, o electron-updater grava o `publisherName` e passa a exigir que
  as atualizações venham assinadas pelo mesmo publisher.

## Fuses

`npx @electron/fuses read` (via `node node_modules/@electron/fuses/dist/bin.js read --app release/win-unpacked/Hangar.exe`,
sem instalar nada), no exe final do `dist`:

```
RunAsNode is Enabled                          ← mantido de propósito (ver abaixo)
EnableCookieEncryption is Disabled
EnableNodeOptionsEnvironmentVariable is Disabled
EnableNodeCliInspectArguments is Disabled
EnableEmbeddedAsarIntegrityValidation is Enabled
OnlyLoadAppFromAsar is Enabled
LoadBrowserProcessSpecificV8Snapshot is Disabled
GrantFileProtocolExtraPrivileges is Enabled   ← padrão; o renderer é carregado de file://
undefined is Enabled                          ← fuse nova do Electron 45 que o @electron/fuses 1.8 não nomeia
```

**Por que `runAsNode: true`:** a doc do electron-builder avisa que desligar essa fuse "também quebra `process.fork()` no
processo principal". O node-pty, ao matar um PTY no Windows, faz `child_process.fork()` do
`conpty_console_list_agent.js`. Com a fuse desligada, esse fork abriria **outro `Hangar.exe`**. Ao fechar uma aba, ele
bateria na trava de instância única e traria a janela para a frente. Ao **sair** com terminais abertos, o
`dispose()` dispararia esses forks e o app poderia **reabrir sozinho** logo depois de fechar. Testei a alternativa:
com `useConptyDll: true` o node-pty mata o PTY **sem fork** (0 forks) e os processos filhos morrem do mesmo jeito
(um `ping` longo morreu). Ver "Pedidos ao chief".

Os módulos desempacotados continuam funcionando com `onlyLoadAppFromAsar` + integridade do asar: o terminal abriu
rodando o `app.asar` gerado.

## Verificação

1. `npm run typecheck`: sem erros. ESLint/Prettier: o repositório ainda não tem `eslint.config.*` nem config do
   Prettier (o agente qa está montando); os arquivos seguem o estilo do código existente (sem ponto e vírgula, aspas
   simples).
2. `npm run pack`: fuses aplicadas ("executing @electron/fuses"). **Não executei o `Hangar.exe` empacotado.**
3. O `app.asar` empacotado rodou com o Electron de dev
   (`node_modules/electron/dist/electron.exe release/win-unpacked/resources/app.asar --user-data-dir=<temp>
   --remote-debugging-port=9447`, com `HANGAR_UPDATE_URL=http://127.0.0.1:18765/`):
   - **Updater**: estado inicial `idle` → `updater:check` → `available` 9.9.9 (com data e notas) →
     `updater:download` → eventos `downloading 0/25/50/76/100%` → `downloaded`. O download diferencial caiu para
     download completo (o feed de teste não tinha blockmap), como esperado. Cache de teste apagado
     (`%LOCALAPPDATA%\hangar-updater-dev`).
   - **Terminal**: `PTY-OK` (node-pty de `app.asar.unpacked`).
   - **Claude**: a mensagem para o Haiku **falhou com `server_error` da API** (10 tentativas). O mesmo acontece no
     build **não empacotado** (`electron .` com perfil limpo), então não é empacotamento. O `claude.exe` sobe e chega
     à API. O `claude -p … --model haiku` direto no terminal respondeu `PONG` pelo gateway local
     (`ANTHROPIC_BASE_URL=http://localhost:8787/t/claude-code` no `~/.claude/settings.json`), então a diferença está
     no caminho engine/gateway/perfis de provedor. Ver "Pedidos ao chief".
4. Primeira tentativa de download no dev falhou com `dev-app-update.yml not found` (o electron-updater lê
   `updaterCacheDirName` de um arquivo de config mesmo com `setFeedURL`). Corrigido: em dev o controlador gera
   `hangar-data/updater/dev-app-update.yml` e usa `updateConfigPath`. No app instalado vale o `resources/app-update.yml`.
5. `UpdaterPanel` renderizado isolado (bridge simulado) nos estados *baixando*, *pronto*, *erro* e *desativado*, em
   tema claro e escuro: layout ok.
6. `npm run dist`: instalador de 230 MB, `latest.yml` e `app-update.yml` corretos. **Instalador não executado.**
7. `build/ci-config.cjs` exercitado: padrão (GitHub `hangar-releases`, sem assinatura), `generic` + Azure completo
   (gera `azureSignOptions`), Azure sem credenciais (erro), repo privado (erro). A config `generic` gerada foi aceita
   pelo electron-builder (`--dir`).
8. Todos os processos de teste (apps nas portas 9447/9448, servidor do feed, servidor Vite do harness) foram
   encerrados.

## Pedidos ao chief

1. **Montar o `UpdaterPanel`** em Configurações → Sobre: `import { UpdaterPanel } from '../updater'` (sem props).
2. **Terminal → depois desligar `runAsNode`.** Em `src/main/features/terminal/manager.ts`, no `pty.spawn(...)`,
   acrescentar `...(process.platform === 'win32' ? { useConptyDll: true } : {})` (o tipo `IWindowsPtyForkOptions` do
   node-pty 1.1 aceita `useConptyDll`). Depois, em `electron-builder.yml`, trocar `runAsNode: true` para `false` e
   apagar o comentário. Com `useConptyDll` o node-pty usa o `conpty.dll`/`OpenConsole.exe` que ele já traz
   (já desempacotados).
3. **Engine × gateway**: investigar por que `engine:send` toma `server_error` em todas as tentativas enquanto o CLI
   funciona pelo gateway `localhost:8787` (env passado ao `claude.exe` pelo engine/perfis de provedor, ou cabeçalho que
   o gateway rejeita). Afeta dev e empacotado igualmente. Talvez tenha relação com a correção de gateway do
   onboarding.
4. Antes da primeira release pública: criar o repositório **público** `valteresj2/hangar-releases` (ou definir
   `UPDATE_PROVIDER=generic` + `UPDATE_GENERIC_URL`) e o secret `RELEASES_TOKEN`. Trocar o feed depois só vale para
   instalações novas.
5. Opcional (segurança): o feed de teste por variável de ambiente (`HANGAR_UPDATE_URL`) só é aceito com
   `!app.isPackaged`; no app instalado ele é ignorado.

## Riscos e avisos

- **Sem assinatura** os instaladores atuais continuam bloqueados pelo Controle Inteligente de Aplicativos e com aviso
  no SmartScreen. Atualizações automáticas de builds sem assinatura não têm verificação de publisher (só o SHA-512 do
  `latest.yml`, que vem do mesmo feed). Assinar fecha isso.
- Se um dia o app passar a ser assinado, versões antigas não assinadas aceitam a atualização normalmente. A partir da
  primeira versão assinada, o publisher fica fixo (mudar o nome do publisher exige atualizar `publisherName`).
- `autoInstallOnAppQuit: true`: uma atualização já baixada é instalada quando o usuário sai do app.
- A instalação é por usuário (`perMachine: false`), então atualizar não pede permissão de administrador.
- O workflow não foi executado (não há remoto/segredos nesta máquina); a sintaxe segue a das actions oficiais
  (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`).
