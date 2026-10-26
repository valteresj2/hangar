# Release do Hangar (Windows, Linux e macOS)

Como gerar, publicar e abrir o Hangar nos três sistemas, e como o app se atualiza. **Nenhum certificado de assinatura
é necessário**: os builds saem sem assinatura (Windows, Linux) ou com assinatura _ad hoc_ (macOS). Assinar continua
possível e é ligado só quando os segredos existem (veja [Assinatura de código (opcional)](#assinatura)).

## Artefatos por sistema

`<v>` é a versão do `package.json` (ex.: `0.2.0`).

| Sistema             | Arquivo                             | O que é                                           | Atualiza sozinho?                  |
| ------------------- | ----------------------------------- | ------------------------------------------------- | ---------------------------------- |
| Windows x64         | `Hangar-Setup-<v>.exe`              | instalador NSIS (por usuário ou para todos)       | **sim** (`latest.yml`)             |
| Windows x64         | `Hangar-<v>-portable-x64.exe`       | executável portátil, roda sem instalar            | não (baixar a versão nova)         |
| Windows arm64       | `Hangar-<v>-portable-arm64.exe`     | executável portátil nativo para ARM               | não                                |
| Linux x64           | `Hangar-<v>-linux-x86_64.AppImage`  | AppImage (um arquivo, qualquer distribuição)      | **sim** (`latest-linux.yml`)       |
| Linux x64           | `hangar_<v>_amd64.deb`              | pacote Debian/Ubuntu                              | não (instalar o `.deb` novo)       |
| Linux arm64         | `Hangar-<v>-linux-arm64.AppImage`   | AppImage para ARM                                 | **sim** (`latest-linux-arm64.yml`) |
| Linux arm64         | `hangar_<v>_arm64.deb`              | pacote Debian/Ubuntu para ARM                     | não                                |
| macOS Apple Silicon | `Hangar-<v>-mac-arm64.dmg` / `.zip` | imagem de disco (arrastar para Aplicativos) / zip | não — avisa e abre o download      |
| macOS Intel         | `Hangar-<v>-mac-x64.dmg` / `.zip`   | idem, para Macs Intel                             | não — avisa e abre o download      |

Junto vão os arquivos de atualização: `latest.yml` (+ `.blockmap` do instalador), `latest-linux.yml`,
`latest-linux-arm64.yml` e `latest-mac.yml` (o macOS lê esse arquivo só para saber que há versão nova).

Todos os pacotes declaram o protocolo **`hangar://`** (links `hangar://open/<rota>`, tratados pelo feature
`workspace`): no Windows o instalador grava o registro (`build/installer.nsh`), no Linux o `.desktop` tem
`MimeType=x-scheme-handler/hangar;` e no macOS o `Info.plist` tem `CFBundleURLTypes`.

Não há instalador NSIS arm64: o `latest.yml` do Windows é um só para todas as arquiteturas (o electron-updater não
separa por CPU no Windows), então um segundo instalador sobrescreveria o do x64. Quem usa Windows on ARM pode usar o
portátil arm64 ou o instalador x64 (roda emulado).

## Como abrir um app sem assinatura (para os usuários)

### Windows

- **SmartScreen** (“O Windows protegeu o computador”): clique em **Mais informações → Executar assim mesmo**. Aparece
  no instalador e no portátil, porque o arquivo não tem assinatura nem reputação de downloads.
- **Arquivo bloqueado por ter vindo da internet**: botão direito no `.exe` → **Propriedades** → marque
  **Desbloquear** → OK (ou, no PowerShell, `Unblock-File .\Hangar-Setup-<v>.exe`).
- **Controle Inteligente de Aplicativos** (Smart App Control, Windows 11): quando está **ativado** (modo de
  imposição), ele **bloqueia** executáveis sem assinatura confiável e **não tem botão de liberar**. Opções:
  1. Usar outra máquina/usuário onde ele esteja em _Avaliação_ ou _Desativado_.
  2. Desativá-lo em **Segurança do Windows → Controle de aplicativos e do navegador → Configurações do Controle
     Inteligente de Aplicativos → Desativado**. Atenção: em várias versões do Windows 11, **desligar não tem volta** sem
     reinstalar/redefinir o Windows — é uma decisão do usuário, não um passo de instalação.
  3. A solução de verdade é assinar o app (veja [Assinatura](#assinatura)); com assinatura confiável o Smart App
     Control libera.
- **Antivírus corporativo / AppLocker / WDAC**: políticas da empresa podem barrar apps sem assinatura; nesse caso é
  com o administrador.

### macOS

O app tem assinatura _ad hoc_ (exigida para rodar em Apple Silicon), mas **não** tem Developer ID nem notarização, então
o Gatekeeper avisa na primeira abertura (“não é possível verificar o desenvolvedor” / “Apple não pôde verificar…”).

1. Abra o `.dmg` e arraste o **Hangar** para **Aplicativos**.
2. Em **Aplicativos**, clique com o **botão direito (ou Control+clique) no Hangar → Abrir → Abrir**.
3. Se não aparecer o botão _Abrir_ (macOS 15 Sequoia ou mais novo): tente abrir uma vez, depois vá em **Ajustes do
   Sistema → Privacidade e Segurança**, role até a mensagem sobre o Hangar e clique em **Abrir assim mesmo**;
   confirme com a senha/Touch ID. Só é preciso fazer isso uma vez.
4. Alternativa pelo Terminal (remove a marca de “baixado da internet”):

   ```sh
   xattr -dr com.apple.quarantine /Applications/Hangar.app
   ```

Se aparecer “o Hangar está danificado e não pode ser aberto”, é a quarentena num app sem notarização: use o comando
do passo 4. Baixe a versão certa: **arm64** para Apple Silicon (M1/M2/M3/M4…), **x64** para Macs Intel.

### Linux

- **AppImage**: dê permissão de execução e rode:

  ```sh
  chmod +x Hangar-<v>-linux-x86_64.AppImage
  ./Hangar-<v>-linux-x86_64.AppImage
  ```

  Precisa de FUSE 2 (`sudo apt install libfuse2` no Ubuntu 22.04; `libfuse2t64` no 24.04). No Ubuntu 24.04+ o
  AppArmor bloqueia o sandbox do Chromium para AppImages; se o app fechar logo ao abrir, rode com `--no-sandbox` ou
  prefira o `.deb` (que instala o perfil do AppArmor). Para o `hangar://` funcionar com AppImage, integre o app ao
  menu (ex.: AppImageLauncher, ou o próprio app registra o protocolo quando roda).

- **.deb** (Debian, Ubuntu, Mint…):

  ```sh
  sudo apt install ./hangar_<v>_amd64.deb
  ```

  Instala em `/opt/Hangar`, cria o atalho no menu (categoria Desenvolvimento) e registra o `hangar://`. Para
  atualizar, instale o `.deb` da versão nova do mesmo jeito. Remover: `sudo apt remove hangar`.

## Visão geral (para quem publica)

| Peça                                                                         | Onde                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Configuração dos pacotes (alvos por SO, protocolo, fuses, publish)           | `electron-builder.yml`                                                                    |
| Registro do `hangar://` no instalador Windows                                | `build/installer.nsh`                                                                     |
| Config efetiva de CI (alvo de publicação + assinatura a partir de variáveis) | `build/ci-config.cjs` → `release/electron-builder.ci.json`                                |
| Conferência dos binários nativos do pacote                                   | `build/check-package.cjs` (`npm run check:package`)                                       |
| Junta os artefatos dos jobs e mescla os arquivos de atualização              | `build/collect-release.cjs`                                                               |
| Entitlements do macOS (só com Developer ID)                                  | `build/entitlements.mac.plist`                                                            |
| Pipeline                                                                     | `.github/workflows/release.yml` (tag `v*` ou execução manual)                             |
| Atualização automática no app                                                | `src/main/features/updater/` (electron-updater) + `UpdaterPanel` em Configurações → Sobre |

### Comandos locais

Cada sistema precisa ser gerado **nele mesmo**: os módulos nativos (node-pty e o binário `claude` do Agent SDK) vêm
do `npm ci` da máquina que compila.

```powershell
npm run pack           # pasta desempacotada do SO atual (Windows: release/win-unpacked)
npm run check:package  # confere os binários nativos da pasta acima (SO/arquitetura atuais)
npm run dist           # Windows: release/Hangar-Setup-<v>.exe + .blockmap + latest.yml + Hangar-<v>-portable-x64.exe
npm run dist:linux     # Linux: AppImage + .deb da arquitetura atual
npm run dist:mac       # macOS: .dmg + .zip da arquitetura atual, assinatura ad hoc
```

`npm run check:package -- --os mac --arch arm64 --dir release/mac-arm64` confere outra pasta.

### Binários nativos por plataforma

| Peça                 | Windows                                                        | macOS                                        | Linux                                                                    |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| node-pty             | `prebuilds/win32-<arch>` + `third_party/conpty/*/win10-<arch>` | `prebuilds/darwin-<arch>` (+ `spawn-helper`) | **sem prebuild**: o `npm ci` compila `build/Release/pty.node` (node-gyp) |
| Agent SDK (`claude`) | `@anthropic-ai/claude-agent-sdk-win32-<arch>`                  | `…-darwin-<arch>`                            | `…-linux-<arch>` (a variante `-musl` fica de fora)                       |

- Tudo isso fica **fora do asar** (`asarUnpack` genérico: `node-pty/**` e `claude-agent-sdk-*/**`). O app procura o
  binário do SDK da plataforma atual em `app.asar.unpacked` (`src/main/features/engine/sdk.ts`).
- O `package-lock.json` traz os pacotes opcionais do SDK de **todas** as plataformas (com `os`/`cpu`/`libc`), e o
  `npm ci` de cada runner instala só o da sua. Por isso cada SO/arquitetura compila no seu runner.
- As seções `win.files`, `linux.files` e `mac.files` do `electron-builder.yml` tiram binários de outras plataformas e
  da outra arquitetura (`${arch}` é a arquitetura **alvo**). O `build/check-package.cjs` lê o cabeçalho PE/ELF/Mach-O
  de cada binário e falha se a CPU não for a do alvo ou se sobrar pacote de outra plataforma.
- `npmRebuild: false`: o node-pty usa N-API (ABI estável entre Node e Electron), não precisa recompilar para o
  Electron.

## Publicar uma versão

1. Atualize `version` no `package.json` (ex.: `0.2.0`) e faça commit.
2. Crie e envie a tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. O workflow **Release** roda:
   - `prepare` (Ubuntu): confere tag × versão (falha se forem diferentes), typecheck e monta a matriz;
   - `build`, um job por SO/arquitetura, **sem segredos obrigatórios**:

     | Job             | Runner             | Gera                     |
     | --------------- | ------------------ | ------------------------ |
     | `windows-x64`   | `windows-latest`   | NSIS + portátil          |
     | `windows-arm64` | `windows-11-arm`   | portátil                 |
     | `linux-x64`     | `ubuntu-latest`    | AppImage + `.deb`        |
     | `linux-arm64`   | `ubuntu-24.04-arm` | AppImage + `.deb`        |
     | `mac-arm64`     | `macos-latest`     | `.dmg` + `.zip` (ad hoc) |
     | `mac-x64`       | `macos-15-intel`   | `.dmg` + `.zip` (ad hoc) |

     Cada job faz `npm ci`, `electron-vite build`, `build/ci-config.cjs`, `electron-builder --publish never`,
     `build/check-package.cjs` e uma conferência por SO (assinatura no Windows; `codesign --verify` e
     `CFBundleURLTypes` no macOS; `.desktop` com `x-scheme-handler/hangar` no `.deb`). Os arquivos vão como artefato
     `hangar-<job>`.

   - `release` (Ubuntu): baixa os artefatos, mescla os dois `latest-mac.yml` (um por arquitetura) com
     `build/collect-release.cjs`, guarda tudo no artefato `hangar-release-v<v>` e publica no feed: cria a release como
     **rascunho**, envia todos os arquivos e só então publica (apps instalados nunca veem um `latest*.yml` antes do
     instalador). Se a release `v<v>` já estiver publicada, o job falha em vez de sobrescrever.
4. Apps instalados encontram a versão nova na próxima verificação (ao abrir, ~15 s depois, e a cada 6 h) ou em
   **Configurações → Sobre → Verificar agora**.

**Execução manual** (_Actions → Release → Run workflow_): `publish` desmarcado só gera os artefatos (ensaio);
`arm64` desmarcado pula os jobs arm64 de Windows e Linux (o macOS arm64 sempre roda). Para pular o arm64 também nas
tags, crie a variável de repositório `RELEASE_ARM64=false`.

Os runners arm64 (`windows-11-arm`, `ubuntu-24.04-arm`) e o Intel (`macos-15-intel`) são runners padrão do GitHub,
disponíveis também para repositórios privados. Em repositório privado eles consomem os minutos do plano, e o
minuto de macOS custa bem mais que o de Linux/Windows (veja a tabela de preços do GitHub Actions).

## Feed de atualização (onde as versões são publicadas)

O app lê o feed de `resources/app-update.yml`, gerado a partir de `publish`. **O app não pode levar token**, então o
feed precisa ser público.

### Padrão: as Releases do próprio repositório

O repositório do código (`valteresj2/hangar`) é público, e as Releases dele são o feed (padrão do
`electron-builder.yml` e do `build/ci-config.cjs`). O job `release` publica com o `GITHUB_TOKEN` do workflow
(`contents: write`): não há token para criar nem segredo para guardar.

### Outro repositório de releases

Para publicar em outro repositório **público** (ex.: se o código voltar a ser privado):

1. Crie o repositório com pelo menos um commit (um README; a tag da release é criada sobre ele).
2. Crie um _fine-grained personal access token_ com acesso **apenas** a esse repositório e permissão
   **Contents: Read and write**.
3. Em `valteresj2/hangar` → _Settings → Secrets and variables → Actions_:
   - secret `RELEASES_TOKEN` = o token acima;
   - variables `UPDATE_GITHUB_OWNER` / `UPDATE_GITHUB_REPO` com o nome dele.

Trocar o feed só vale para os apps instalados a partir daí: os anteriores continuam lendo o feed antigo.

### Alternativa: servidor genérico (HTTPS estático, S3, Azure Blob, R2…)

- Variables: `UPDATE_PROVIDER=generic` e `UPDATE_GENERIC_URL=https://seu-host/hangar/` (pasta que conterá os
  `latest*.yml` e os pacotes).
- O workflow gera tudo no artefato `hangar-release-v<v>`; copie o conteúdo dele para essa URL (ou acrescente um passo
  de upload para o seu storage). O app lê `<url>/latest.yml` (Windows), `<url>/latest-linux.yml` (Linux) etc.

Canais (`beta` etc.): defina `UPDATE_CHANNEL`; o app mostra o canal no painel. Versões com sufixo (`0.3.0-beta.1`)
saem como _pre-release_ no GitHub.

> Trocar o feed só vale para instalações **novas** (o endereço fica gravado em cada instalação). Escolha o feed
> definitivo antes da primeira versão pública.

<a id="assinatura"></a>

## Assinatura de código (opcional)

Nada aqui é necessário para gerar ou usar o Hangar. Sem nenhum segredo configurado:

| Sistema | Sem segredos                                                 | Efeito para o usuário                                                   |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Windows | sem assinatura                                               | SmartScreen avisa; Smart App Control ativado bloqueia (veja acima)      |
| macOS   | assinatura **ad hoc** (`mac.identity: "-"`), sem notarização | Gatekeeper pede “Abrir assim mesmo” uma vez; sem atualização automática |
| Linux   | não se aplica (AppImage/`.deb` não são assinados)            | nenhum                                                                  |

O build escolhe a assinatura pelo ambiente (`build/ci-config.cjs`):

| Ambiente (no job do SO)                                                                                                             | Efeito                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Windows: `AZURE_SIGNING_*` + `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`                                                              | Azure Artifact Signing (`win.azureSignOptions`)                  |
| Windows: `CSC_LINK` + `CSC_KEY_PASSWORD` (ou `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`)                                                 | certificado `.pfx`                                               |
| macOS: `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD` (secrets → `CSC_LINK` no job)                                                        | Developer ID + hardened runtime (`build/entitlements.mac.plist`) |
| macOS: + `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (ou `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) | + notarização                                                    |
| nada                                                                                                                                | Windows sem assinatura; macOS ad hoc                             |

### Por que o macOS usa assinatura ad hoc

Em Macs Apple Silicon o sistema **não executa** código sem nenhuma assinatura (o processo é morto ao abrir). A
assinatura _ad hoc_ (sem certificado) resolve isso. O electron-builder **não** faz ad hoc sozinho quando não acha um
certificado (ele só pula a assinatura), por isso o `electron-builder.yml` define `mac.identity: "-"`. Com ad hoc, o
_hardened runtime_ quebraria a validação de bibliotecas dos frameworks do Electron (assinados com outro Team ID),
então `hardenedRuntime: false`. `notarize: false` porque a notarização exige conta Apple Developer. O
`electron-osx-sign` assina todos os binários do bundle, inclusive o `claude`, o `pty.node` e o `spawn-helper` em
`app.asar.unpacked`; o job confere com `codesign --verify --deep --strict`.

### Windows (opcional)

#### Opção A — Azure Artifact Signing (antigo Trusted Signing)

Serviço gerenciado da Microsoft: certificados de curta duração, chave nunca sai do Azure, cobrança mensal (planos
_Basic_ e _Premium_; veja os preços atuais no portal). No electron-builder a configuração ainda se chama
`win.azureSignOptions` e usa o módulo PowerShell `TrustedSigning` (o electron-builder o instala sozinho).

> **Elegibilidade (doc da Microsoft, maio/2026):** certificados _Public Trust_ (os que contam para SmartScreen e
> Smart App Control) só são emitidos para **organizações** nos EUA, Canadá, União Europeia, Reino Unido, Austrália,
> Nova Zelândia, Japão, Coreia do Sul, Singapura, Suíça, Noruega e Israel, e para **pessoas físicas** só nos **EUA
> e Canadá**. **Brasil não está na lista**: um desenvolvedor individual no Brasil não consegue usar esta opção hoje;
> use a opção B (certificado de uma CA) ou uma empresa sediada num país elegível. Confira a lista atual em
> <https://learn.microsoft.com/azure/artifact-signing/quickstart>.

Passo a passo (portal do Azure):

1. **Assinatura do Azure** e tenant do Microsoft Entra ID (<https://portal.azure.com>). Para validação de pessoa
   física, a _billing account_ da assinatura precisa ser do tipo _Individual_, com nome legal e endereço iguais aos
   do documento.
2. **Registre o provedor**: _Subscriptions → (assinatura) → Resource providers_ → `Microsoft.CodeSigning` → _Register_.
3. **Crie a conta**: procure **Artifact Signing Accounts** → _Create_ → grupo de recursos, nome (3–24 caracteres,
   único globalmente, ex.: `hangarsigning`), **região** e plano. Anote o **endpoint** da região, por exemplo:
   East US `https://eus.codesigning.azure.net`, West US 2 `https://wus2.codesigning.azure.net`,
   North Europe `https://neu.codesigning.azure.net`, West Europe `https://weu.codesigning.azure.net`,
   Brazil South `https://brs.codesigning.azure.net` (a região do recurso pode ser o Brasil; a restrição acima é sobre
   quem é validado).
4. **Seu papel**: na conta → _Access control (IAM)_ → atribua a si mesmo **Artifact Signing Identity Verifier**
   (sem ele o botão _New identity_ fica desabilitado).
5. **Validação de identidade**: na conta → _Identity validations_ → _Organization_ ou _Individual_ → _New identity_
   → **Public**. Preencha (organização: razão social, site, e-mails no domínio da empresa, identificador; pessoa
   física: dados vêm da billing account e a verificação é feita por documento + Microsoft Authenticator). Leva de
   **1 a 20 dias úteis**.
6. **Perfil de certificado**: _Certificate profiles_ → _Create_ → **Public Trust** → escolha a validação concluída.
   Anote o nome do perfil (5–100 caracteres, ex.: `hangarpublic`).
7. **Identidade para o CI**: Microsoft Entra ID → _App registrations_ → _New registration_ (ex.: `hangar-ci-signing`).
   Anote _Application (client) ID_ e _Directory (tenant) ID_; em _Certificates & secrets_ crie um **client secret**.
8. **Papel do CI**: na conta (ou no perfil) → _Access control (IAM)_ → atribua ao app registrado
   **Artifact Signing Certificate Profile Signer**.
9. **Cadastre no GitHub** (`valteresj2/hangar` → _Settings → Secrets and variables → Actions_):

   | Tipo     | Nome                      | Valor                                                 |
   | -------- | ------------------------- | ----------------------------------------------------- |
   | secret   | `AZURE_TENANT_ID`         | Directory (tenant) ID                                 |
   | secret   | `AZURE_CLIENT_ID`         | Application (client) ID                               |
   | secret   | `AZURE_CLIENT_SECRET`     | valor do client secret                                |
   | variable | `AZURE_SIGNING_ENDPOINT`  | endpoint da região (passo 3)                          |
   | variable | `AZURE_SIGNING_ACCOUNT`   | nome da conta (passo 3)                               |
   | variable | `AZURE_SIGNING_PROFILE`   | nome do perfil (passo 6)                              |
   | variable | `AZURE_SIGNING_PUBLISHER` | nome exatamente como no certificado (CN da validação) |

O `build/ci-config.cjs` só adiciona `win.azureSignOptions` quando as quatro variáveis existem (e falha se faltar uma
delas ou um dos três secrets). O client secret expira: renove antes do vencimento (o build passa a falhar com erro
de autenticação do Entra ID).

#### Opção B — certificado `.pfx` (OV/EV de uma autoridade certificadora)

1. Compre um certificado de _code signing_ (OV ou EV) de uma CA (DigiCert, Sectigo, SSL.com, GlobalSign…). Desde
   2023 as CAs guardam a chave em token/HSM, então em geral **não** há `.pfx` exportável: para HSM em nuvem
   (DigiCert KeyLocker, SSL.com eSigner, Azure Key Vault) use a ferramenta da CA via `win.signtoolOptions.sign`
   (script de assinatura personalizado). O caminho `.pfx` abaixo vale quando você tem o arquivo.
2. Converta o `.pfx` para base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('hangar.pfx')) | Set-Clipboard`.
3. Secrets no GitHub: `CSC_LINK` = base64, `CSC_KEY_PASSWORD` = senha do `.pfx`.

Para assinar localmente com `.pfx`: `$env:CSC_LINK='C:\caminho\hangar.pfx'; $env:CSC_KEY_PASSWORD='…'; npm run dist`.

### macOS com Apple Developer ID (opcional)

Requer inscrição no Apple Developer Program (pago, anual). Com ela o Gatekeeper abre o app sem avisos e a
atualização automática passa a funcionar no macOS (o Squirrel.Mac exige app assinado com Developer ID).

1. Em <https://developer.apple.com/account/resources/certificates> crie um certificado **Developer ID
   Application**, instale no Keychain e exporte como `.p12` com senha.
2. Secrets no GitHub: `MAC_CSC_LINK` = base64 do `.p12` (`base64 -i cert.p12 | pbcopy`), `MAC_CSC_KEY_PASSWORD` =
   senha. O workflow os passa como `CSC_LINK`/`CSC_KEY_PASSWORD` só nos jobs de macOS (no Windows esses nomes são
   do `.pfx`). O `build/ci-config.cjs` tira o `identity: "-"`, liga o hardened runtime e usa
   `build/entitlements.mac.plist`.
3. Notarização (recomendada junto): uma chave da App Store Connect API (_Users and Access → Integrations → App Store
   Connect API_) com secrets `APPLE_API_KEY_P8` (conteúdo do `.p8`), `APPLE_API_KEY_ID` e `APPLE_API_ISSUER`; ou
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (senha de app em <https://account.apple.com>) e `APPLE_TEAM_ID`.
4. Nada a mudar no app: o updater vê a assinatura Developer ID (`codesign`) e volta a instalar sozinho no macOS.

## Fuses do Electron

Gravadas no executável pelo electron-builder (`electronFuses`), antes da assinatura, nos três sistemas:

| Fuse                                                             | Valor | Por quê                                                                      |
| ---------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| `runAsNode`                                                      | false | `ELECTRON_RUN_AS_NODE` não transforma o app num Node genérico                |
| `enableNodeOptionsEnvironmentVariable`                           | false | `NODE_OPTIONS` não injeta código no app                                      |
| `enableNodeCliInspectArguments`                                  | false | `--inspect` não abre depurador no app instalado                              |
| `onlyLoadAppFromAsar`                                            | true  | só carrega o código de `app.asar` (não de uma pasta `app/` plantada ao lado) |
| `enableEmbeddedAsarIntegrityValidation`                          | true  | o hash do `app.asar` fica embutido no executável e é validado ao abrir       |
| `grantFileProtocolExtraPrivileges`                               | true  | padrão do Electron; o renderer é carregado de `file://`                      |
| `enableCookieEncryption`, `loadBrowserProcessSpecificV8Snapshot` | false | padrão                                                                       |

`runAsNode` pôde ser desligado porque o terminal cria os PTYs com `useConptyDll: true` no Windows
(`src/main/features/terminal/manager.ts`): nesse modo o node-pty fecha o PTY sem `child_process.fork()` (com a fuse
desligada, um `fork` abriria outro `Hangar.exe`). No macOS/Linux o node-pty usa `spawn-helper`/`forkpty`, sem
`fork` de Node.

Os binários desempacotados (`node-pty`, `claude`) continuam em `app.asar.unpacked` e funcionam com essas fuses
(o `onlyLoadAppFromAsar` se refere ao código do app; módulos nativos desempacotados são permitidos).

Conferir no Windows: `node node_modules/@electron/fuses/dist/bin.js read --app release/win-unpacked/Hangar.exe`.

## Atualização automática (como funciona no app)

| Pacote                    | Modo       | Comportamento                                                      |
| ------------------------- | ---------- | ------------------------------------------------------------------ |
| Windows NSIS              | automático | electron-updater baixa e instala (funciona sem assinatura)         |
| Linux AppImage            | automático | electron-updater troca o AppImage (funciona sem assinatura)        |
| macOS Developer ID        | automático | Squirrel.Mac instala (só com a assinatura opcional)                |
| Windows portátil          | manual     | avisa “Nova versão disponível — baixar” e abre a página da release |
| Linux `.deb`              | manual     | idem; o usuário instala o `.deb` novo com `apt`                    |
| macOS ad hoc              | manual     | idem (o Squirrel.Mac recusa updates de app sem Developer ID)       |
| Linux sem AppImage/`.deb` | desativado | pasta desempacotada: o painel explica que não se atualiza pelo app |

O modo é decidido ao abrir (`src/main/features/updater/install-mode.ts`): macOS roda
`codesign -dv --verbose=2 <Hangar.app>` (`Signature=adhoc`, `TeamIdentifier=not set`, sem assinatura ou qualquer coisa
que não seja _Developer ID Application_ ⇒ manual); Windows portátil é reconhecido por `PORTABLE_EXECUTABLE_FILE`
(variável que o portátil do electron-builder define); o `.deb` pelo arquivo `resources/package-type` (`deb`). No modo
manual o app só **verifica** o feed (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`), nunca baixa nem instala; o
botão abre `https://github.com/<owner>/<repo>/releases/tag/v<versão>` (provider github) ou a URL do feed genérico, e
**só https** (o canal `updater:openDownload` confere de novo antes do `shell.openExternal`). O painel mostra o motivo e
esconde a opção de download automático.

Comportamento geral (modo automático):

- Só roda no app instalado (no dev, só com `HANGAR_UPDATE_URL`; veja abaixo). Verifica ~15 s depois de abrir e a cada
  6 h. Não verifica enquanto há um download em andamento ou uma atualização pronta.
- Por padrão **pergunta** antes de baixar (botão _Baixar atualização_). A opção _Baixar atualizações automaticamente_
  (guardada em `hangar-data/updater/prefs.json` dentro da pasta de dados do app) baixa em segundo plano.
- _Reiniciar e atualizar_ fecha o app (mesmo com “minimizar para a bandeja”), roda o instalador e reabre. Se o
  usuário só sair do app, a atualização baixada é instalada na saída (`autoInstallOnAppQuit`).
- Log: `logs/updater.log` na pasta de dados (Windows: `%APPDATA%\Hangar\logs\updater.log`; rotaciona em 1 MB).
- Download diferencial: usa o `.blockmap` da versão instalada quando existir no feed; senão baixa o pacote inteiro.
- Sem assinatura, o electron-updater não confere quem publicou a atualização (só o SHA-512 do `latest*.yml`): a
  segurança do update depende de o feed (as Releases do repositório e quem pode publicá-las) não ser adulterado.

### Testar o fluxo sem publicar nada

1. Gere um feed falso numa pasta: um arquivo qualquer como `Hangar-Setup-9.9.9.exe` e um `latest.yml` com
   `version: 9.9.9`, `path`, `sha512` (base64 do SHA-512 do arquivo) e `size`.
2. Sirva a pasta por HTTP (ex.: `npx http-server <pasta> -p 18765`, ou qualquer servidor estático).
3. Rode o app em dev apontando para ele: `$env:HANGAR_UPDATE_URL='http://127.0.0.1:18765/'; npm run dev`
   (ou `node_modules\electron\dist\electron.exe release\win-unpacked\resources\app.asar` para testar o pacote).
4. _Configurações → Sobre → Verificar agora_ → “Nova versão disponível: 9.9.9” → _Baixar atualização_ → progresso →
   “pronta para instalar”. **Não** clique em _Reiniciar e atualizar_ com um instalador falso.
5. Apague o cache: `%LOCALAPPDATA%\hangar-updater-dev`.
6. Modo manual: rode com `$env:HANGAR_UPDATE_INSTALL_MODE='manual'` também (só vale fora do app instalado). O painel
   mostra o motivo e o botão _Nova versão disponível — baixar_; com o feed local o link é o próprio
   `http://127.0.0.1:…` (em dev o loopback é aceito; no app instalado, só https).

## Checklist de release

- [ ] `version` atualizada e tag `v<versão>` igual.
- [ ] Repositório público (feed nas próprias Releases) ou, para outro feed, `RELEASES_TOKEN` válido / feed genérico
      configurado.
- [ ] Todos os jobs `build` verdes (o passo _Native modules in the package_ confere node-pty e `claude` por SO/CPU).
- [ ] Release publicada no feed com: `Hangar-Setup-<v>.exe` + `.blockmap` + `latest.yml`, portáteis x64/arm64,
      AppImages + `latest-linux.yml`/`latest-linux-arm64.yml`, `.deb`, `.dmg`/`.zip` arm64 e x64 + `latest-mac.yml`
      com os dois zips.
- [ ] Instalar numa máquina limpa de cada SO, abrir pelo caminho “sem assinatura” acima e conferir _Configurações →
      Sobre_ e um link `hangar://open/workspace/home`.
- [ ] (Opcional) Assinatura configurada — o passo _Signature status_ do Windows mostra `Valid`; no macOS o
      `codesign -dv` mostra a `TeamIdentifier`.
