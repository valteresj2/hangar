# Relatório — w1-release (builds para Windows, Linux e macOS sem certificado)

## Resumo

- **Windows**: NSIS (auto-update, como antes) + **portátil** x64; **portátil arm64** na CI (`windows-11-arm`). Sem
  assinatura por padrão. O instalador registra o **`hangar://`** (`build/installer.nsh`, HKCU ou HKLM conforme o
  escopo escolhido; removido na desinstalação, preservado em updates).
- **Linux**: **AppImage** + **.deb**, x64 (`ubuntu-latest`) e arm64 (`ubuntu-24.04-arm`), categoria Development,
  `.desktop` `hangar.desktop` com `MimeType=x-scheme-handler/hangar;` (`desktopName` + `syncDesktopName`, que também é
  o nome que o Electron usa no `setAsDefaultProtocolClient` do Linux).
- **macOS**: **.dmg** + **.zip**, arm64 (`macos-latest`) e x64 (`macos-15-intel`), com **assinatura ad hoc**
  (`mac.identity: "-"`; conferido no código do electron-builder 26.18: sem `identity` ele **não** cai para ad hoc,
  só pula a assinatura), `hardenedRuntime: false` (ad hoc + hardened runtime quebra a validação de bibliotecas dos
  frameworks do Electron, como avisa a própria doc do `identity`), `notarize: false`. `hangar://` no `Info.plist`
  (`protocols` → `CFBundleURLTypes`).
- **Assinatura opcional** por SO, só quando os segredos existem: Windows (Azure / `.pfx`, como antes); macOS
  Developer ID (`MAC_CSC_LINK`) liga hardened runtime + `build/entitlements.mac.plist` e, com credenciais Apple,
  notarização (`build/ci-config.cjs`).
- **Binários nativos por plataforma**: `asarUnpack` genérico (`node-pty/**`, `claude-agent-sdk-*/**`); filtros
  `win.files`/`linux.files`/`mac.files` com `${arch}` (arquitetura **alvo**; `${platform}` seria o host) tiram os
  binários de outras plataformas/arquiteturas. No Linux o node-pty não tem prebuilds: o `npm ci` compila
  `build/Release/pty.node`, que agora é mantido (antes `build/` inteiro era excluído). O `package-lock.json` já traz os
  8 pacotes opcionais do SDK (`win32/darwin/linux × x64/arm64` + `-musl`), cada runner instala o seu.
- **`build/check-package.cjs`** (`npm run check:package`): confere no pacote desempacotado o `claude` do SDK e o
  node-pty da plataforma, **lendo o cabeçalho PE/ELF/Mach-O** para garantir a CPU certa, falha se sobrar pacote de
  outra plataforma, e confere `app-update.yml` e o `package.json` empacotado.
- **CI** (`.github/workflows/release.yml`): `prepare` (tag × versão, typecheck, matriz) → `build` (6 jobs, sem
  segredos obrigatórios, `--publish never`, check de nativos + conferência por SO) → `release` (junta os artefatos,
  **mescla os dois `latest-mac.yml`** com `build/collect-release.cjs`, publica como rascunho → envia tudo → publica;
  recusa sobrescrever release já publicada). Entrada manual `arm64` e variável `RELEASE_ARM64=false` para pular os
  jobs arm64 de Windows/Linux.
- **`docs/RELEASE.md`** reescrito: tabela de artefatos por SO, “como abrir um app sem assinatura” (SmartScreen,
  Desbloquear, Smart App Control, Gatekeeper/“Abrir assim mesmo”/`xattr`, AppImage `chmod +x`/libfuse2/AppArmor,
  `apt install ./…deb`), binários nativos, pipeline, feed, assinatura opcional por SO, fuses (corrigido: `runAsNode`
  já está `false`), atualização por pacote, checklist.

## Arquivos

| Arquivo                         | O quê                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron-builder.yml`          | alvos por SO, `protocols`, `extraMetadata` (`desktopName`, `homepage` exigido pelo `.deb`), `files`/`asarUnpack` por plataforma e arquitetura, `portable`, `nsis.include`, `linux`/`deb`, `mac` ad hoc, `dmg`                                               |
| `build/installer.nsh`           | `customInstall`/`customUnInstall`: registra/remove `hangar://` (`SHELL_CONTEXT`), não apaga em updates (`isUpdated`) e limpa o registro por usuário feito pelo app se apontar para esta instalação                                                            |
| `build/ci-config.cjs`           | + ramo macOS: Developer ID (`CSC_LINK`/`CSC_NAME`) tira `identity`, liga hardened runtime/entitlements, notarização se houver credenciais Apple; mensagens por SO                                                                                            |
| `build/entitlements.mac.plist`  | allow-jit, allow-unsigned-executable-memory, disable-library-validation (só com Developer ID)                                                                                                                                                               |
| `build/check-package.cjs`       | verificação dos binários nativos do pacote (novo)                                                                                                                                                                                                          |
| `build/collect-release.cjs`     | junta artefatos dos jobs e mescla `latest*.yml` (novo)                                                                                                                                                                                                     |
| `.github/workflows/release.yml` | matriz multi-SO (reescrito)                                                                                                                                                                                                                                 |
| `package.json`                  | só scripts de empacotamento: `dist` → `--win nsis portable --x64`; novos `dist:linux`, `dist:mac`, `check:package`. Dependências intactas; sem seção `build` (a config fica no `electron-builder.yml`)                                                       |
| `docs/RELEASE.md`               | guia multi-SO                                                                                                                                                                                                                                              |

`ci.yml` não foi alterado (o Release com `publish` desmarcado serve de ensaio de empacotamento nos três SOs).

## Verificação

- `npm run pack` → `release/win-unpacked`; `npm run check:package` → **ok** (claude.exe x64 283 MB; pty/conpty/
  conpty_console_list/winpty x64; `third_party/conpty/1.23.251008001/win10-x64` só; sem prebuilds/SDK de outras
  plataformas — os filtros com extglob `win32-!(${arch})` funcionaram).
- `npm run dist` → `release/Hangar-Setup-0.1.0.exe` (237.008.564 bytes) + `.blockmap` + `latest.yml` +
  **`Hangar-0.1.0-portable-x64.exe`** (215.508.872 bytes); NSIS compilou com o `installer.nsh`;
  `check:package -- --release` ok (`app-update.yml` → `valteresj2/hangar-releases`).
- **Pacote rodado com o Electron de dev** (Playwright `_electron`, `--user-data-dir` temporário, sem tocar no
  `Hangar.exe`): janela “Hangar” abriu; `terminal:create` abriu um PowerShell pelo node-pty de `app.asar.unpacked`
  (`useConptyDll`) e o eco `HANGAR-PTY-OK` voltou; `claude.exe --version` do pacote → `2.1.310 (Claude Code)`.
  Nenhum processo ficou aberto.
- `electron-builder --linux --dir --x64` **roda no Windows**: config válida, fuses aplicadas, `linux.files` tirou
  prebuilds/`third_party`/SDK do Windows. O `check-package` acusa só o esperado (sem `claude-agent-sdk-linux-x64` e
  sem `build/Release/pty.node`, que vêm do `npm ci` num Linux). Pasta apagada depois.
- `electron-builder --mac --dir` **não roda no Windows** (“Build for macOS is supported only on macOS”) — validado
  só pela revisão da config contra o código-fonte do electron-builder 26.18 (`MacTargetHelper`, `macOptions.d.ts`,
  `PublishManager`) e pelos passos de conferência da CI (`codesign --verify --deep --strict`, `plutil`
  `CFBundleURLTypes`).
- YAMLs (`release.yml`, `ci.yml`, `electron-builder.yml`) carregados com `js-yaml`; script da matriz simulado
  (com e sem arm64). `collect-release.cjs` testado com artefatos sintéticos: mescla 2×`latest-mac.yml` (4 arquivos),
  falha com versões diferentes e com arquivo listado ausente.
- `npm run typecheck` ok; `eslint build/` ok; Prettier ok nos arquivos do escopo.
- Runners conferidos na doc do GitHub (out/2026): `windows-11-arm`, `ubuntu-24.04-arm`, `macos-15-intel` e
  `macos-latest` existem também para repositórios privados (`macos-13` não existe mais).

## O que ficou faltando

- **Nenhum build de Linux/macOS foi executado de verdade** (só dá na CI). A primeira execução do Release (manual, sem
  publicar) é o teste real: node-gyp do node-pty no arm64, permissões do `spawn-helper`, assinatura ad hoc do
  binário `claude` (Bun) e o AppImage/`.deb`.
- **Instalador NSIS arm64**: não feito de propósito — o `latest.yml` do Windows é único para todas as CPUs
  (`Provider.getChannelFilePrefix` do electron-updater não tem sufixo de arquitetura no Windows), então um segundo
  instalador quebraria o update do x64. Windows on ARM usa o portátil arm64 ou o instalador x64 emulado.
- **Comportamento do updater no macOS/portátil/.deb** (entrega 5): depende de `src/` → pedido abaixo.
- Ícone do macOS: `build/icon.png` tem 512 px (o electron-builder aceita; 1024 px fica mais nítido em Retina).

## Pedidos ao chief

1. **Updater em modo “baixar manualmente”** (`src/main/features/updater/controller.ts`, `src/shared/features/updater.ts`,
   `UpdaterPanel.tsx`). Quando a instalação **não pode se atualizar sozinha**:
   - **macOS sem Developer ID** (o Squirrel.Mac recusa): detectar uma vez, de forma assíncrona, com
     `execFile('/usr/bin/codesign', ['-dv', '--verbose=2', <bundle .app>])` — no stderr, `Signature=adhoc` ou
     `TeamIdentifier=not set` ⇒ manual (bundle = `dirname(dirname(dirname(process.execPath)))`);
   - **Windows portátil**: `process.env.PORTABLE_EXECUTABLE_FILE` definido (o portátil x64 sai da mesma
     `win-unpacked` e leva o `app-update.yml`, então hoje baixaria e rodaria o instalador NSIS);
   - **Linux `.deb`**: `readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim() === 'deb'` (o
     electron-builder grava esse arquivo); a instalação do `.deb` é com `apt`.

   Nesse modo: `autoUpdater.autoDownload = false`, não chamar `downloadUpdate`/`quitAndInstall`; a verificação continua
   (lê `latest-mac.yml`/`latest.yml`/`latest-linux.yml`) e o estado `available` ganha, por exemplo,
   `installMode: 'auto' | 'manual'` e `downloadUrl` (provider github: `https://github.com/<owner>/<repo>/releases/tag/v<versão>`,
   com owner/repo do `app-update.yml`; generic: a URL do feed). Canal novo `updater:openDownload` →
   `shell.openExternal(downloadUrl)` (só https). Painel: “Nova versão disponível — baixar” no lugar de _Baixar
   atualização_/_Reiniciar e atualizar_, e a opção de download automático escondida. Teste: unitário da detecção
   (stderr do codesign ad hoc vs. Developer ID; env do portátil; `package-type`).
2. **Registro do `hangar://` em tempo de execução** (`src/main/features/workspace/api.ts`, agente workspace):
   - portátil Windows: `process.execPath` é a pasta temporária onde o portátil se extrai (some ao fechar); usar
     `app.setAsDefaultProtocolClient('hangar', process.env.PORTABLE_EXECUTABLE_FILE)` quando definido;
   - instalado via NSIS o instalador já grava o registro (mesmas chaves do Electron); chamar de novo não atrapalha.
   - AppImage: o caminho estável é `process.env.APPIMAGE`; o registro no Linux depende de existir
     `hangar.desktop` em `~/.local/share/applications` (o `.deb` instala em `/usr/share/applications`); para AppImage
     sem integração, só documentado.
3. **devDependencies** explícitas para os scripts de build (hoje vêm transitivas do electron-builder): `js-yaml`
   (`ci-config.cjs`, `collect-release.cjs`) e `@electron/asar` (`check-package.cjs`). Sem `npm install` daqui.
4. **Dono do produto**: o `.deb` exige mantenedor com e-mail; usei `Valter Eduardo <valteresj2@gmail.com>`
   (`linux.maintainer`), que fica **público** nos pacotes. Trocar por um endereço de projeto, se preferir.
5. **Design**: `build/make-icons.cjs` ainda desenha o ícone com o acento antigo (`#c96442`); se a marca mudou para o
   amarelo da plataforma, regenerar `build/icon.png` (de preferência em 1024 px) e `icon.ico`.
6. **Repositório público de releases**: criar `valteresj2/hangar-releases` com um commit (README) antes da primeira
   tag; o texto da release aponta para o README (“como abrir um app sem assinatura” — copiar a seção do
   `docs/RELEASE.md`).

## Riscos conhecidos

- Primeira execução multi-SO ainda não testada (veja “O que ficou faltando”).
- macOS sem notarização: no Sequoia (15+) não há mais o atalho do botão direito em todos os casos — o caminho é
  _Ajustes → Privacidade e Segurança → Abrir assim mesmo_ ou `xattr` (documentado). Usuários podem ver “danificado”.
- AppImage no Ubuntu 24.04+: AppArmor bloqueia o sandbox do Chromium (precisa `--no-sandbox` ou usar o `.deb`, que
  instala o perfil); FUSE 2 necessário (runtime legado do electron-builder).
- Smart App Control ativado continua bloqueando o Windows sem assinatura, sem como liberar (documentado).
- Sem assinatura, o update só confere o SHA-512 do `latest*.yml`: a integridade depende do repositório de releases e
  do `RELEASES_TOKEN`.
- Runners macOS em repositório privado consomem bem mais minutos; os arm64 de Windows/Linux podem ser desligados
  (`RELEASE_ARM64=false`).
- Tamanho: cada pacote leva o `claude` da plataforma (~280 MB descompactado; instalador Windows ~226 MB).

## Complemento (w1-release-2)

Exceção desta etapa: feature `updater` (`src/main/features/updater/**`, `src/shared/features/updater.ts`,
`src/renderer/src/features/updater/**`). Os pedidos 1, 3 (o chief instalou `js-yaml` e `@electron/asar` como
devDependencies) e 5 acima estão atendidos.

### 1. Modo “baixar manualmente” no atualizador

- **`src/main/features/updater/install-mode.ts`** (novo, sem `electron`, testável):
  - `parseCodesignOutput` classifica o stderr de `codesign -dv --verbose=2`: `adhoc` (`Signature=adhoc` ou
    `TeamIdentifier=not set`), `unsigned` (“not signed at all”), `developer-id` (Team ID de 10 caracteres **e**
    `Authority=Developer ID Application:`), senão `unknown`;
  - `detectInstallMode` → `manual` para macOS sem Developer ID (inclusive `unknown`/codesign que falhou), Windows com
    `PORTABLE_EXECUTABLE_FILE` (conferido no `portable.nsi` do electron-builder) e Linux com `package-type` = `deb`
    (conferido no `FpmTarget`); `auto` no resto; com o motivo em pt-BR;
  - `parseUpdateConfig` lê o `app-update.yml` (plano) sem dependência nova;
  - `downloadUrlFor` → `https://github.com/<owner>/<repo>/releases/tag/v<versão>` (owner/repo validados; versão
    estranha cai na lista de releases) ou a URL do feed genérico; **só https**, sem usuário/senha na URL; loopback
    `http://127.0.0.1|localhost` só com `allowLoopback` (usado apenas fora do app instalado, para o feed de teste);
  - `probeMacSignature` (`execFile('/usr/bin/codesign', …)` no `.app`, timeout 10 s) e `probeInstallFacts`.
- **Contrato** (`src/shared/features/updater.ts`): `InstallMode = 'auto' | 'manual'`; `UpdaterState.installMode`,
  `manualReason?`, `downloadUrl?`; canal tipado **`updater:openDownload: () => boolean`**.
- **Controller**: decide o modo ao iniciar (antes de carregar o electron-updater). Manual ⇒ `autoDownload = false`,
  `autoInstallOnAppQuit = false`, `download()`/`install()` viram no-op, `setAutoDownload` só grava a preferência; o
  `update-available` vira sempre `available` com `downloadUrl`. `openDownload()` revalida a URL (https; loopback só em
  dev) antes do `shell.openExternal`. A trava antiga “só Windows” saiu: Linux AppImage passa a se atualizar sozinho,
  `.deb` fica manual, e uma pasta Linux sem AppImage/`.deb` fica desativada com explicação. Em dev,
  `HANGAR_UPDATE_INSTALL_MODE=manual` simula o modo (ignorado no app instalado). O log registra o modo e a assinatura
  do macOS.
- **Painel**: no modo manual, “Nova versão disponível: X — baixe e instale a versão nova.”, botão primário **“Nova
  versão disponível — baixar”** (`updater:openDownload`, `title` com a URL), motivo em nota discreta, sem _Baixar
  atualização_/_Reiniciar e atualizar_ nem a opção de download automático. Sem URL (provider sem link), o texto
  manda para a página de downloads.
- **Testes**: `tests/unit/updater.test.ts`, 16 casos (saídas reais de `codesign` ad hoc / Developer ID / sem
  assinatura / Apple Development; modo por SO, portátil, `.deb`, AppImage, `rpm`; `app-update.yml`; URLs github,
  genérica https/http/file/javascript/credenciais, loopback com e sem permissão, providers sem link).
- **Ponta a ponta (dev)**: feed falso local com 9.9.9 + `HANGAR_UPDATE_INSTALL_MODE=manual`, Playwright `_electron`,
  `shell.openExternal` interceptado: `updater:check` → `available`/`manual`/9.9.9 com `downloadUrl`; `updater:download`
  ignorado; em Configurações → Sobre aparece o botão, a opção automática some, o clique abre exatamente a URL do feed.
- `docs/RELEASE.md`: tabela de modos por pacote e como testar o modo manual.

### 2. Ícone com a marca da plataforma

- `build/make-icons.cjs` reescrito: hangar em arco com porta aberta e pista em **amarelo `#F4B400`** sobre azulejo
  **tarmac `#1C2530`** (degradê leve até `#232E3B`, borda `#26313E`), desenhado numa grade de 1024.
- Gera `build/icon.png` (**1024 px**, Linux), `build/icon.ico` (256/128/64/48/32/16, Windows/NSIS) e **`build/icon.icns`**
  (16…1024 px, 11 entradas PNG, na grade do macOS: azulejo de 824 px com margem, como os ícones do sistema).
  `mac.icon` agora aponta para o `.icns` (o `.png` sem margem ficaria grande demais no Dock). Conferidos
  visualmente o 1024, o `.icns` 1024 e o `.ico` 32 px; estrutura validada (cabeçalhos PNG/ICO/ICNS).

### Verificação (Complemento)

| Comando                     | Resultado                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run format:check`      | ok                                                                                              |
| `npm run lint`              | 0 erros (110 avisos, todos em arquivos de outros features; os do updater/testes/build sem avisos) |
| `npm run typecheck`         | ok (e `typecheck:tests` ok)                                                                     |
| `npm test`                  | 13 arquivos, **194 testes** passando                                                            |
| `npm run dist`              | `Hangar-Setup-0.1.0.exe` (237.163.760 bytes) + `.blockmap` + `latest.yml` + `Hangar-0.1.0-portable-x64.exe` (215.605.829 bytes), com o ícone novo |
| `npm run check:package -- --release` | ok (claude.exe x64, node-pty/conpty x64, `app-update.yml`, `desktopName`)              |

### Pendências que continuam

- Pedido 2 (registro do `hangar://` no portátil via `PORTABLE_EXECUTABLE_FILE` e AppImage via `APPIMAGE`) é do
  feature workspace. Os pedidos 4 (e-mail do mantenedor do `.deb`) e 6 (criar o repositório público de releases)
  ficam com o dono do produto.
- A detecção do macOS e do `.deb` só foi testada por unidade (saídas reais do `codesign`); o primeiro build de macOS
  na CI é a prova real.
