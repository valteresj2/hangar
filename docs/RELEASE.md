# Release do Hangar (Windows)

Como gerar, assinar e publicar o instalador, e como o app se atualiza sozinho.

## Visão geral

| Peça                                                                         | Onde                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Configuração do instalador (NSIS, fuses, publish)                            | `electron-builder.yml`                                                                    |
| Config efetiva de CI (alvo de publicação + assinatura a partir de variáveis) | `build/ci-config.cjs` → `release/electron-builder.ci.json`                                |
| Pipeline                                                                     | `.github/workflows/release.yml` (tag `v*` ou execução manual)                             |
| Atualização automática no app                                                | `src/main/features/updater/` (electron-updater) + `UpdaterPanel` em Configurações → Sobre |

Comandos locais:

```powershell
npm run pack   # release/win-unpacked (sem instalador)
npm run dist   # release/Hangar-Setup-<versão>.exe + .blockmap + latest.yml (sem assinatura, sem publicar)
```

## Publicar uma versão

1. Atualize `version` no `package.json` (ex.: `0.2.0`) e faça commit.
2. Crie e envie a tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. O workflow **Release** compila no `windows-latest`, assina se houver segredos, publica `Hangar-Setup-0.2.0.exe`,
   o `.blockmap` e o `latest.yml` no feed e guarda os mesmos arquivos como artefato da execução.
4. Apps instalados encontram a versão nova na próxima verificação (ao abrir, ~15 s depois, e a cada 6 h) ou em
   **Configurações → Sobre → Verificar agora**.

O workflow falha se a tag não bater com a versão do `package.json`.

## Feed de atualização (onde as versões são publicadas)

O app lê o feed de `resources/app-update.yml`, gerado a partir de `publish`. **O app não pode levar token**, então o
feed precisa ser público. O repositório do código (`valteresj2/hangar`) é privado e **não serve** como feed
(o `build/ci-config.cjs` recusa essa combinação).

### Opção recomendada: repositório público só de releases

1. Crie no GitHub um repositório **público** vazio, ex.: `valteresj2/hangar-releases` (só com um README; o código
   continua privado). Esse é o padrão do `electron-builder.yml`.
2. Crie um _fine-grained personal access token_ com acesso **apenas** a esse repositório e permissão
   **Contents: Read and write**.
3. No repositório privado `valteresj2/hangar` → _Settings → Secrets and variables → Actions_:
   - secret `RELEASES_TOKEN` = o token acima;
   - (opcional) variables `UPDATE_GITHUB_OWNER` / `UPDATE_GITHUB_REPO` se usar outro nome.

### Alternativa: servidor genérico (HTTPS estático, S3, Azure Blob, R2…)

- Variables: `UPDATE_PROVIDER=generic` e `UPDATE_GENERIC_URL=https://seu-host/hangar/` (pasta que conterá
  `latest.yml` e o instalador).
- O workflow gera os arquivos e os anexa como artefato; copie `latest.yml`, `Hangar-Setup-<v>.exe` e o `.blockmap`
  para essa URL (ou acrescente um passo de upload para o seu storage). O app lê `<url>/latest.yml`.

Canais (`beta` etc.): defina `UPDATE_CHANNEL`; o app mostra o canal no painel.

> Trocar o feed só vale para instalações **novas** (o endereço fica gravado em cada instalação). Escolha o feed
> definitivo antes da primeira versão pública.

## Assinatura de código

Sem assinatura o build funciona, mas:

- o **SmartScreen** mostra “O Windows protegeu o computador” no instalador (é preciso clicar em _Mais informações →
  Executar assim mesmo_);
- o **Controle Inteligente de Aplicativos** (Smart App Control) do Windows 11, quando ativo no modo de imposição,
  **bloqueia** executáveis novos sem assinatura confiável, sem opção de liberar — foi o que aconteceu com o
  `Hangar.exe` nesta máquina;
- o electron-updater só verifica a assinatura das atualizações quando o app foi assinado (ele grava o
  `publisherName` no `app-update.yml`); depois que você assinar, atualizações precisam vir assinadas pelo mesmo
  publisher, o que impede um feed adulterado de instalar um executável qualquer.

Com uma assinatura válida, de uma autoridade confiável e com carimbo de tempo, o Smart App Control passa a permitir o
app e o SmartScreen deixa de avisar (certificados novos, sobretudo OV, podem precisar acumular reputação de downloads
antes de o aviso do SmartScreen sumir).

O build escolhe a assinatura pelo ambiente; sem nada configurado, não assina:

| Ambiente                                                                   | Efeito                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| `AZURE_SIGNING_*` + `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`              | Azure Artifact Signing (`win.azureSignOptions`) |
| `CSC_LINK` + `CSC_KEY_PASSWORD` (ou `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`) | certificado `.pfx`                              |
| nada                                                                       | sem assinatura (aviso no log)                   |

### Opção A — Azure Artifact Signing (antigo Trusted Signing)

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

### Opção B — certificado `.pfx` (OV/EV de uma autoridade certificadora)

1. Compre um certificado de _code signing_ (OV ou EV) de uma CA (DigiCert, Sectigo, SSL.com, GlobalSign…). Desde
   2023 as CAs guardam a chave em token/HSM, então em geral **não** há `.pfx` exportável: para HSM em nuvem
   (DigiCert KeyLocker, SSL.com eSigner, Azure Key Vault) use a ferramenta da CA via `win.signtoolOptions.sign`
   (script de assinatura personalizado). O caminho `.pfx` abaixo vale quando você tem o arquivo.
2. Converta o `.pfx` para base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('hangar.pfx')) | Set-Clipboard`.
3. Secrets no GitHub: `CSC_LINK` = base64, `CSC_KEY_PASSWORD` = senha do `.pfx`.

Para assinar localmente com `.pfx`: `$env:CSC_LINK='C:\caminho\hangar.pfx'; $env:CSC_KEY_PASSWORD='…'; npm run dist`.

## Fuses do Electron

Gravadas no `Hangar.exe` pelo electron-builder (`electronFuses`), antes da assinatura:

| Fuse                                                             | Valor                 | Por quê                                                                      |
| ---------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `runAsNode`                                                      | **true (temporário)** | ver abaixo                                                                   |
| `enableNodeOptionsEnvironmentVariable`                           | false                 | `NODE_OPTIONS` não injeta código no app                                      |
| `enableNodeCliInspectArguments`                                  | false                 | `--inspect` não abre depurador no app instalado                              |
| `onlyLoadAppFromAsar`                                            | true                  | só carrega o código de `app.asar` (não de uma pasta `app/` plantada ao lado) |
| `enableEmbeddedAsarIntegrityValidation`                          | true                  | o hash do `app.asar` fica embutido no exe e é validado ao abrir              |
| `grantFileProtocolExtraPrivileges`                               | true                  | padrão do Electron; o renderer é carregado de `file://`                      |
| `enableCookieEncryption`, `loadBrowserProcessSpecificV8Snapshot` | false                 | padrão                                                                       |

Os binários desempacotados (`node-pty`, `claude.exe`) continuam em `app.asar.unpacked` e funcionam com essas fuses
(o `onlyLoadAppFromAsar` se refere ao código do app; módulos nativos desempacotados são permitidos).

Conferir: `node node_modules/@electron/fuses/dist/bin.js read --app release/win-unpacked/Hangar.exe`
(a linha `undefined is Enabled` é uma fuse nova do Electron 45 que o `@electron/fuses` 1.8 ainda não nomeia).

<a id="fuses"></a>

### Por que `runAsNode` ainda está ligado

A documentação do electron-builder avisa: desligar `runAsNode` “também quebra `process.fork()` no processo
principal”. O node-pty, ao fechar um terminal no Windows, faz `child_process.fork()` de um script auxiliar
(`conpty_console_list_agent.js`). Com a fuse desligada, esse fork abriria **outro `Hangar.exe`** em vez do auxiliar:
ao fechar uma aba ele bateria na trava de instância única e traria a janela para frente; ao **sair do app** com
terminais abertos poderia **reabrir o Hangar** logo depois de fechar.

Correção (no feature terminal): criar os PTYs com `useConptyDll: true` no Windows. Nesse modo o node-pty usa o
`conpty.dll`/`OpenConsole.exe` que ele já traz e mata o processo sem `fork` (verificado: sem fork, e os processos
filhos do shell morrem). Depois dessa mudança, troque `runAsNode` para `false` no `electron-builder.yml`.

## Atualização automática (como funciona no app)

- Só roda no app instalado (no dev, só com `HANGAR_UPDATE_URL`; veja abaixo). Verifica ~15 s depois de abrir e a cada
  6 h. Não verifica enquanto há um download em andamento ou uma atualização pronta.
- Por padrão **pergunta** antes de baixar (botão _Baixar atualização_). A opção _Baixar atualizações automaticamente_
  (guardada em `%APPDATA%\Hangar\hangar-data\updater\prefs.json`) baixa em segundo plano.
- _Reiniciar e atualizar_ fecha o app (mesmo com “minimizar para a bandeja”), roda o instalador e reabre. Se o
  usuário só sair do app, a atualização baixada é instalada na saída (`autoInstallOnAppQuit`).
- Log: `%APPDATA%\Hangar\logs\updater.log` (rotaciona em 1 MB; o painel tem um link para ele quando há erro).
- Download diferencial: usa o `.blockmap` da versão instalada quando existir no feed; senão baixa o instalador inteiro.

### Testar o fluxo sem publicar nada

1. Gere um feed falso numa pasta: um arquivo qualquer como `Hangar-Setup-9.9.9.exe` e um `latest.yml` com
   `version: 9.9.9`, `path`, `sha512` (base64 do SHA-512 do arquivo) e `size`.
2. Sirva a pasta por HTTP (ex.: `npx http-server <pasta> -p 18765`, ou qualquer servidor estático).
3. Rode o app em dev apontando para ele: `$env:HANGAR_UPDATE_URL='http://127.0.0.1:18765/'; npm run dev`
   (ou `node_modules\electron\dist\electron.exe release\win-unpacked\resources\app.asar` para testar o pacote).
4. _Configurações → Sobre → Verificar agora_ → “Nova versão disponível: 9.9.9” → _Baixar atualização_ → progresso →
   “pronta para instalar”. **Não** clique em _Reiniciar e atualizar_ com um instalador falso.
5. Apague o cache: `%LOCALAPPDATA%\hangar-updater-dev`.

## Checklist de release

- [ ] `version` atualizada e tag `v<versão>` igual.
- [ ] `RELEASES_TOKEN` válido (ou feed genérico configurado).
- [ ] Assinatura configurada (Azure ou `.pfx`) — o passo _Signature status_ do workflow deve mostrar `Valid`.
- [ ] Release publicada no feed contém `Hangar-Setup-<v>.exe`, `.blockmap` e `latest.yml`.
- [ ] Instalar numa máquina limpa e conferir _Configurações → Sobre_.
