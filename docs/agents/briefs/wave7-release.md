# Sétima onda: release (assinatura de código e atualização automática)

Regras de `docs/agents/RULES.md`. **Seu feature: `updater`** (`src/main/features/updater/**`,
`src/renderer/src/features/updater/**`, `src/shared/features/updater.ts`), mais `electron-builder.yml`,
`build/**`, `.github/workflows/release.yml`, `docs/RELEASE.md` e o relatório. Pode editar só a seção `build`/`publish`
do `package.json` se precisar (não scripts nem dependências; `electron-updater` já está instalado). Outros três agentes
trabalham em paralelo (qa, security, onboarding). Sem `npm install`.

## 1. Assinatura de código (opcional por ambiente)

- O build local continua funcionando sem certificado. Com segredos presentes (CI), assina.
- Suporte a **Azure Trusted Signing** (`win.azureSignOptions` do electron-builder) e a certificado `.pfx`
  (`CSC_LINK`/`CSC_KEY_PASSWORD`). Confirme a sintaxe atual na documentação do electron-builder (WebFetch).
- `docs/RELEASE.md`: como obter o certificado (passo a passo do Azure Trusted Signing), quais segredos cadastrar no
  GitHub, e o efeito no SmartScreen / Controle Inteligente de Aplicativos (que bloqueou o `Hangar.exe` nesta máquina).
- **Fuses do Electron** via `electronFuses` no electron-builder: `runAsNode: false`,
  `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`,
  `onlyLoadAppFromAsar: true`, `enableEmbeddedAsarIntegrityValidation: true` (confira os nomes na doc). Garanta que o
  app empacotado continua rodando (node-pty e o claude.exe desempacotados).

## 2. Atualização automática (`electron-updater`)

- Main: verificar ao iniciar (só no app empacotado) e a cada 6 h; baixar em segundo plano quando o usuário aceitar (ou
  automático, conforme uma opção); "Reiniciar e atualizar". Eventos para o renderer; logs em arquivo.
- Publicação: GitHub Releases. **O repositório `valteresj2/hangar` é privado**: atualizar a partir de repo privado
  exige token no app, o que não é aceitável. Configure o `publish` para um alvo configurável e recomende em
  `docs/RELEASE.md` um repositório público só de releases (ex.: `valteresj2/hangar-releases`) ou um servidor genérico;
  não crie repositórios.
- `UpdaterPanel` (será montado pelo chief em Configurações → Sobre): versão atual, canal, "Verificar agora", progresso
  do download, "Reiniciar e atualizar", erro legível.
- `.github/workflows/release.yml`: em tag `v*`, build no Windows, assina se houver segredos, publica o instalador e o
  `latest.yml` no alvo configurado.

## Verificação

- `npm run pack` gera o app com as fuses; confira as fuses com `npx @electron/fuses read --app <exe>` se disponível sem
  instalar nada (senão, documente). **Não execute o `Hangar.exe` empacotado** (o Controle de Aplicativos desta máquina
  bloqueia binários novos sem assinatura); valide o conteúdo do pacote rodando o `app.asar` com o Electron de dev
  (`node_modules/electron/dist/electron.exe release/win-unpacked/resources/app.asar --user-data-dir=…`).
- Atualização: teste o fluxo de "update disponível → download" em modo dev com `forceDevUpdateConfig` e um servidor
  HTTP local servindo um `latest.yml` de versão maior (provedor `generic`). Não instale nada.
- Relatório em `docs/agents/reports/wave7-release.md`; responda só `PRONTO: wave7-release`.
