# Sétima onda: security (endurecimento do Electron e das execuções)

Regras de `docs/agents/RULES.md`, com **exceções desta missão**: você pode editar `src/main/index.ts`,
`src/main/core/window.ts`, criar `src/main/core/ipcGuard.ts`, `src/preload/**`, `src/main/features/engine/runner.ts` e
`registry.ts`, `src/main/features/lab/**` e `src/renderer/src/features/lab/**` (só o fluxo de adoção) e
`src/main/features/settings/providers.ts` (só a migração do `safeStorage`). Outros três agentes trabalham em paralelo
(qa, release, onboarding) — não toque em `tests/`, `electron-builder.yml`, `package.json`, nem nas pastas `onboarding`
e `updater`. Sem `npm install`.

## Itens

1. **Sandbox do renderer**: `sandbox: true` em `rendererWebPreferences` (janela principal e Quick Entry). O preload
   precisa continuar funcionando sandboxado (só `contextBridge`, `ipcRenderer`, `webUtils`; confira `process.platform`).
2. **Guarda de IPC** (`core/ipcGuard.ts`, instalada antes de qualquer feature registrar handlers): todo `ipcMain.handle`/
   `on` só aceita chamadas de um frame principal de uma janela do Hangar cuja URL seja a do nosso renderer (arquivo do
   build ou `ELECTRON_RENDERER_URL` em dev). Webviews, iframes de artifacts e páginas externas são recusados e logados.
   Faça sem precisar mexer em cada feature (por exemplo, envolvendo `ipcMain.handle`/`ipcMain.on` uma única vez).
3. **Navegação e webviews**: impedir a janela principal de navegar para fora do app (`will-navigate`,
   `setWindowOpenHandler` já existe); `will-attach-webview` força `nodeIntegration: false`, sem preload, partição
   `persist:hangar-browser`; handler de permissões padrão-negar na sessão principal; confira todos os
   `shell.openExternal` do código (só http/https; `mailto:` só com confirmação).
4. **`allowDangerouslySkipPermissions`**: hoje vai em toda query. Passe-o só quando a sessão estiver em
   `bypassPermissions`; ao trocar para esse modo no meio da sessão, reinicie o runner com resume.
5. **Adoção no Lab**: se o harness vencedor muda `.claude/settings.json` (hooks), `.claude/scripts/**` ou scripts de
   skills, a adoção exige uma confirmação explícita que lista os comandos/arquivos executáveis alterados (o main
   recusa aplicar sem um parâmetro de confirmação). O mesmo aviso nas variantes antes de rodar uma rodada manual com
   esses arquivos alterados.
6. **`safeStorage`**: migrar para as APIs assíncronas (`isAsyncEncryptionAvailable`, `encryptStringAsync`,
   `decryptStringAsync`) mantendo `resolveProviderLaunch` síncrono (cache em memória carregado de forma assíncrona na
   inicialização, antes de qualquer sessão abrir).
7. Escreva `docs/SECURITY.md`: modelo de ameaças curto (conteúdo do agente, artifacts, webviews, hooks do Lab,
   segredos de provedor) e o que cada camada faz. Liste as **fuses** do Electron que o agente release deve ligar.

## Pronto quando

Typecheck e build passam; o app funciona com sandbox (chat, terminal, artifacts, browser, Motion, Lab, provedores —
teste com a assinatura usando um perfil já existente ou um gateway falso; nunca chaves reais); uma chamada de IPC
feita de dentro de um webview é recusada (prove com um teste manual via CDP); adotar uma variante com hook exige a
confirmação. `--user-data-dir` isolado e porta livre (não use 9333 nem 19888-19896). Relatório em
`docs/agents/reports/wave7-security.md`; responda só `PRONTO: wave7-security`.
