# Segunda onda: release (instalador do Windows com electron-builder)

As regras de `docs/agents/RULES.md` continuam valendo, com **exceções de propriedade só para esta missão**:
você pode editar `package.json` (scripts, `build`/metadados), criar `electron-builder.yml`, criar a pasta `build/`
(ícones e recursos do instalador) e rodar `npm install -D electron-builder` (só esse pacote). Não toque em `src/`.

## Objetivo

`npm run dist` gera em `release/` um instalador NSIS para Windows x64 (`Hangar-Setup-<versão>.exe`) que instala,
cria atalho no Menu Iniciar e na área de trabalho, e abre o app funcionando.

## Requisitos

- `appId: dev.hangar.app` (igual ao `app.setAppUserModelId` do main, para as notificações funcionarem), `productName: Hangar`.
- `files`: só `out/**` e o necessário; `asarUnpack` para `node_modules/node-pty/**` (binários `.node`, `conpty.dll`,
  `OpenConsole.exe`, helper) e para o que o Agent SDK precisar fora do asar (confira se ele empacota um executável/cli
  próprio que precisa ser executável — `node_modules/@anthropic-ai/claude-agent-sdk/**`).
- `npmRebuild: false` (o node-pty usa prebuilds N-API; o rebuild quebra nesta máquina — veja `docs/agents/reports/terminal.md`).
- NSIS: `oneClick: false`, permitir escolher a pasta, `perMachine: false`, atalhos, desinstalador, ícone.
- Ícone: gere `build/icon.ico` (256/128/64/48/32/16) e `build/icon.png` 512px a partir de um desenho simples
  da marca Hangar (um hangar/arco estilizado em `#c96442` sobre fundo claro). Gere programaticamente
  (ex.: script Node que desenha o PNG com canvas do Electron, ou SVG convertido) — sem baixar imagens da internet.
- Scripts: `"dist": "electron-vite build && electron-builder --win nsis --x64"`, `"pack": "electron-vite build && electron-builder --dir"`.
- `release/` já está no `.gitignore`.
- Sem assinatura de código (registre no relatório que o SmartScreen vai avisar).

## Verificação

1. `npm run pack` e rode `release/win-unpacked/Hangar.exe` com `--user-data-dir` isolado e uma porta de depuração livre
   (não use 9333 nem 19888): o app abre, o terminal integrado funciona (prova que o node-pty desempacotado carrega) e uma
   mensagem curta para o Claude (modelo haiku, numa pasta temporária) responde (prova que o SDK funciona empacotado).
   Encerre o processo depois.
2. `npm run dist` gera o instalador. **Não execute o instalador** (ele mexe no sistema do usuário); só confira tamanho e
   que o arquivo existe.

Relatório em `docs/agents/reports/wave2-release.md` (tamanho do instalador, o que foi desempacotado, avisos);
responda só `PRONTO: wave2-release`.
