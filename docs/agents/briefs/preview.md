# Missão: preview (browser embutido, dev server e artifacts)

Leia primeiro `docs/agents/RULES.md`. Seu feature: `preview`.
Suas pastas: `src/main/features/preview/`, `src/renderer/src/features/preview/`, `src/shared/features/preview.ts`.

A janela já tem `webviewTag: true`. A CSP do `index.html` permite `frame-src` para `blob:`, `data:`, `https:` e `localhost`;
se precisar de mais, peça ao chief.

## BrowserPanel({ session })

- Abas de navegação com `<webview>` (partição `persist:hangar-browser`), barra de URL (aceita texto → busca),
  voltar, avançar, recarregar, parar, abrir no navegador do sistema, DevTools do webview.
- Bloqueie popups (abra em nova aba interna) e downloads silenciosos (pergunte antes). No main, use
  `app.on('web-contents-created')` para impor `setWindowOpenHandler` nos webviews e negar permissões sensíveis
  (câmera, microfone, geolocalização) por padrão.
- Abas guardadas por sessão (lembradas enquanto o app estiver aberto).

## Dev server (dentro do BrowserPanel, como um menu "Servidores")

- Leia `.claude/launch.json` na pasta da sessão (formato: `{ version, configurations: [{ name, runtimeExecutable,
  runtimeArgs, port, url? }] }`). Liste as configurações; Iniciar roda o processo (`spawn`, cwd da sessão), captura
  stdout/stderr num log visível, espera a porta responder e abre `url ?? http://localhost:<port>` numa aba.
  Parar mata a árvore de processos (`taskkill /pid <pid> /T /F` no Windows). Mate tudo em `dispose()`.
- Permita criar/editar o `launch.json` pela UI (com confirmação antes de sobrescrever).
- IPC: `preview:launchConfigs`, `preview:start`, `preview:stop`, `preview:logs`; evento `preview:event:server`.

## ArtifactsPanel({ session })

- No main, escute `session:file-written` no bus; se a extensão for `.html`, `.htm`, `.svg`, `.md` ou `.mermaid`,
  registre o arquivo como artifact da sessão (persistido em `<userData>/hangar-data/preview/artifacts.json`).
  Emita `preview:event:artifacts`.
- Painel: lista de artifacts (mais recente primeiro) e visualizador. HTML em `<iframe sandbox="allow-scripts">` via
  `srcdoc` (sem `allow-same-origin`); SVG como imagem; Markdown com `react-markdown` + `remark-gfm`.
  Botões: recarregar do disco, abrir no navegador, abrir pasta, remover da lista; "Abrir arquivo como artifact" manual.
- IPC: `preview:artifacts` (sessionId), `preview:artifactRead` (path), `preview:artifactAdd`, `preview:artifactRemove`.

## Pronto quando

Dá para navegar em sites em abas, subir um dev server de um `launch.json` e vê-lo no painel, e um `.html` escrito pelo
agente aparece sozinho em Artifacts, renderizado e isolado.
