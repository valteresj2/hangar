# Relatório — preview (browser embutido, dev server e artifacts)

## O que foi feito

### Main (`src/main/features/preview/`)
- `index.ts` — registra os IPCs, escuta `session:file-written` e `store:changed` (sessão excluída → remove artifacts e para servidores), inicia o servidor de artifacts; `dispose()` mata todos os dev servers (síncrono), fecha o servidor de artifacts e grava o `artifacts.json`.
- `browser.ts` — `app.on('web-contents-created')`:
  - webviews: `setWindowOpenHandler` nega a janela e emite `preview:event:popup` (o renderer abre em nova aba interna); `will-navigate`/`will-redirect` só aceitam `http(s)` e `about:blank`.
  - host: `will-attach-webview` remove `preload`, força `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true` e bloqueia `src` fora de http(s).
  - partição `persist:hangar-browser`: handlers de pedido/checagem de permissão com lista de permitidos (`clipboard-sanitized-write`, `fullscreen`, `pointerLock`). Câmera, microfone, geolocalização, notificações etc. ficam negados.
  - downloads: sem `setSavePath`, então o Electron sempre abre o diálogo "Salvar download" (cancelar aborta). Emite `preview:event:download` (iniciado/concluído/cancelado).
- `servers.ts` — lê `.claude/launch.json` (aceita comentários e vírgulas finais), valida, salva (recusa sobrescrever sem `overwrite`), roda o processo (`spawn` com shell no Windows por causa dos shims `.cmd`, cwd = `worktree?.path ?? cwd`, `BROWSER=none`, `PORT` quando há `port`), mantém um log limitado (512 KB) e consulta a porta (127.0.0.1 e ::1) até responder. Aí emite o estado com `ready: true`. Parar usa `taskkill /pid <pid> /T /F` (no POSIX, kill do grupo).
- `artifacts.ts` — registro persistido em `<userData>/hangar-data/preview/artifacts.json` (`.html`, `.htm`, `.svg`, `.md`, `.mermaid`). Caminho relativo é resolvido pela pasta da sessão; o mesmo arquivo só sobe para o topo. A leitura **só vale para arquivos registrados** e é limitada a 5 MB.
- `artifactServer.ts` — servidor HTTP em loopback (veja "Desvio do brief").
- `paths.ts` — `sessionDir()` e a pasta de dados do feature.

### Shared (`src/shared/features/preview.ts`)
Canais `PREVIEW.*`, `BROWSER_PARTITION` e os tipos `LaunchConfiguration`, `LaunchConfigsResult`, `LaunchSaveResult`, `ServerInfo`, `ServerEvent`, `Artifact`, `ArtifactContent`, `ArtifactsEvent`, `PopupEvent`, `DownloadEvent`.

IPC: `preview:launchConfigs` (sessionId), `preview:launchSave` (sessionId, text, overwrite), `preview:start` (sessionId, name), `preview:stop` (serverId), `preview:servers` (sessionId), `preview:logs` (serverId), `preview:artifacts` (sessionId), `preview:artifactRead` (path ou id), `preview:artifactAdd` (sessionId, path? — sem path abre o diálogo), `preview:artifactRemove` / `artifactReveal` / `artifactOpen` (id).
Eventos: `preview:event:server`, `preview:event:artifacts`, `preview:event:popup`, `preview:event:download`.

### Renderer (`src/renderer/src/features/preview/`)
- `BrowserPanel({ session })` — abas por sessão (store zustand em memória, valem enquanto o app estiver aberto), `<webview>` criado de forma imperativa para a partição ser aplicada antes da 1ª navegação, barra de URL (texto vira busca no Google; `localhost:3000` e domínios sem esquema são normalizados), voltar, avançar, recarregar/parar, abrir no navegador do sistema, DevTools do webview, favicon, spinner, tela de erro de carga, página "Nova aba" com os servidores rodando, botão do meio fecha a aba e um aviso de download.
- Menu **Servidores** — lista as configurações com status, Iniciar/Parar/Abrir/Log, log ao vivo sem códigos ANSI e com rolagem automática, editor do `launch.json` (modelo pronto, validação e confirmação antes de sobrescrever).
- Um listener global abre o servidor numa aba da sessão quando a porta responde (e abre o painel Browser se a sessão estiver ativa). Popups viram uma nova aba.
- `ArtifactsPanel({ session })` — lista (mais recente primeiro; o artifact novo é selecionado sozinho) e visualizador: HTML e Mermaid em `<iframe sandbox="allow-scripts">` (sem `allow-same-origin`), SVG como `<img>` (blob URL), Markdown com `react-markdown` + `remark-gfm` (links abrem no navegador externo). Botões: recarregar do disco, abrir no navegador/app padrão, abrir pasta, remover da lista, "Abrir arquivo como artifact…". Também aceita arrastar e soltar arquivos.
- Os exports `BrowserPanel` e `ArtifactsPanel` em `index.tsx` mantêm os mesmos nomes e props.

## Desvio do brief: iframe via servidor em loopback, não `srcdoc`
Testei no Electron 45: iframes `srcdoc`, `data:` e `blob:` **herdam a CSP do app** (`script-src 'self'`), então qualquer `<script>` inline de um artifact HTML seria bloqueado. A solução foi servir o artifact por um servidor HTTP em `127.0.0.1` (e `::1`) numa porta aleatória, com URL `http://localhost:<porta>/a/<token-aleatório>/<id>/<arquivo>`. O `frame-src` atual já permite `http://localhost:*`, então não precisei mudar a CSP. O iframe continua `sandbox="allow-scripts"` sem `allow-same-origin` (origem opaca, sem acesso ao app). Recursos relativos (`style.css`, imagens) são servidos só de dentro da pasta do artifact. Se o servidor não subir, o viewer volta para `srcdoc`: renderiza, mas sem scripts inline.

Mermaid: não há pacote `mermaid` instalado. A página que embrulha o diagrama carrega o Mermaid 11.4.1 do jsDelivr dentro do iframe isolado e, sem rede, mostra o código-fonte.

## Como testar
1. `npm run dev`, abra uma sessão numa pasta e clique em **Browser**. Digite um endereço ou uma busca e teste abas, voltar/avançar, DevTools e ⧉.
2. **Servidores** → "Criar launch.json" (há um modelo) → Salvar → **Iniciar**. O log aparece e, quando a porta responde, o site abre numa aba. **Parar** encerra a árvore de processos.
3. Peça ao agente para escrever um `.html` (ou `.md`/`.svg`/`.mermaid`) e abra **Artifacts**: o arquivo aparece sozinho, renderizado e isolado.

Testes automatizados que rodei (app compilado, `--user-data-dir` isolado, conduzido via CDP): **22/23 passaram**. Cobrem: JSONC do launch.json, recusa de sobrescrita, validação, painel, dev server iniciado → porta detectada → aba com o título certo, partição correta, log capturado e sem ANSI na UI, popup virando aba interna sem janela nova, câmera negada, sem node no webview, normalização da barra de URL, artifacts em ordem, recusa de leitura de caminho não registrado, iframe `sandbox=allow-scripts` de localhost, script inline do artifact rodando com acesso ao `parent` **bloqueado**, Markdown com tabela GFM, SVG renderizado, Parar fechando a porta e o encerramento do app matando o dev server. A única falha foi a geolocalização numa aba em segundo plano: o Chromium adia o pedido enquanto a página está oculta (testei à parte: com a página visível chega ao handler e é negado, código 1; `permissions.query` responde `denied`). Não é concessão.

`npm run typecheck` e `npm run build` passam (o projeto inteiro, no estado atual).

## Pedidos ao chief
- **Opcional:** adicionar a dependência `mermaid`, para renderizar `.mermaid` offline (hoje vem do CDN dentro do iframe isolado).
- **Opcional:** expor `shell.showItemInFolder` no core. Hoje o preview tem o próprio `preview:artifactReveal`, o que basta.
- Nenhuma mudança obrigatória em arquivos do chief.
- **Aviso:** durante os testes, a porta de depuração 9333 já estava em uso pela instância de teste de outro agente (userData em `…/4e0b8d15-…/scratchpad/ud`). Meu primeiro script conectou nela por engano, criou a sessão `e2e1`, abriu o painel Browser e iniciou um servidor. Desfiz tudo logo em seguida (servidor parado, sessão excluída) e passei a usar uma porta livre.

## Riscos conhecidos / pendências
- Artifacts HTML podem carregar recursos relativos da própria pasta e acessar a rede, como uma página web comum, mas sem acesso ao app nem a `file:`. O servidor exige um token aleatório e só responde em loopback.
- Na troca de sessão ou ao fechar o painel lateral, os webviews são recriados: as abas e URLs ficam, o histórico de voltar/avançar se perde.
- `quoteArg` no Windows não cobre todos os metacaracteres do `cmd.exe` em `runtimeArgs` exóticos.
- Imagens com caminho relativo dentro de Markdown não aparecem (a CSP de `img-src` não permite `http://localhost`/`file:`).
- O pedido de confirmação de download depende do diálogo padrão de "salvar como" do Electron (não há confirmação própria antes dele).
