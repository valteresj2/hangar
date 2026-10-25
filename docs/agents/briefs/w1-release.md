# Builds para Windows, Linux e macOS sem certificado (sem licença de assinatura)

Regras de `docs/agents/RULES.md`. **Seu escopo**: `electron-builder.yml`, a seção `build` do `package.json` (sem mexer
em scripts de outros nem em dependências — se faltar uma dependência, peça ao chief), `.github/workflows/release.yml`
(e `ci.yml` só se precisar de um job de build por SO), `build/**` e `docs/RELEASE.md`. Não toque em `src/` (o agente
**workspace** está mexendo lá; ele implementa o protocolo `hangar://` em tempo de execução — você declara o protocolo
no instalador). Sem `npm install` (peça ao chief se precisar de pacote).

## Decisão do dono do produto

Os executáveis de **Windows, Linux e macOS** devem funcionar **sem certificado de assinatura** (nenhuma licença paga).
A assinatura (Azure Trusted Signing / `.pfx` / Apple Developer ID) continua **opcional**, ligada só se os segredos
existirem — não é requisito.

## Entregas

1. **Windows**: NSIS (como hoje) + **portable** (`.exe` que roda sem instalar), x64 (e arm64 se o Electron/SDK
   suportarem sem complicação). Sem assinatura por padrão.
2. **Linux**: **AppImage** e **.deb** (x64; arm64 se possível), com o ícone, categoria e o protocolo `hangar://`
   no `.desktop`.
3. **macOS**: **.dmg** e **.zip**, x64 e arm64 (ou universal). Sem Developer ID: use **assinatura ad hoc** (o arm64
   não abre sem pelo menos ad hoc — confira na documentação atual do electron-builder qual configuração faz isso) e
   **sem notarização**. Protocolo `hangar://` no `Info.plist`.
4. **Binários nativos por plataforma**: o `node-pty` (prebuilds) e o binário do Claude Code do Agent SDK
   (`@anthropic-ai/claude-agent-sdk-<plataforma>-<arquitetura>`) precisam existir e ficar fora do asar em cada SO
   (`asarUnpack` genérico por plataforma; o resolvedor do app já procura o pacote da plataforma atual). Confira que o
   `package-lock.json` traz os pacotes opcionais de todas as plataformas ou que a CI os instala no runner certo.
5. **Atualização**: Windows e Linux (AppImage) com `electron-updater` funcionam sem assinatura; **macOS não
   atualiza sozinho sem assinatura** (Squirrel.Mac exige) — o app deve detectar isso e mostrar "nova versão
   disponível — baixar" em vez de tentar instalar (peça ao chief a mudança no `UpdaterPanel` se for em `src/`).
6. **CI** (`.github/workflows/release.yml`): matriz `windows-latest`, `ubuntu-latest`, `macos-latest` (e
   `macos-13` para x64 se necessário), build sem segredos, artefatos publicados no destino de release configurado;
   assinatura só quando os segredos existirem.
7. **`docs/RELEASE.md`**: tabela de artefatos por SO e, para os usuários, como abrir um app sem assinatura:
   Windows (SmartScreen: "Mais informações → Executar assim mesmo"; Controle Inteligente de Aplicativos pode
   bloquear — como lidar), macOS (botão direito → Abrir, ou Ajustes do Sistema → Privacidade e Segurança → "Abrir
   assim mesmo"; `xattr -dr com.apple.quarantine` como alternativa), Linux (AppImage: `chmod +x`; `.deb`: `apt
   install ./arquivo.deb`).

## Verificação

- Local (Windows): `npm run dist` (NSIS + portable) e `npm run pack`; confira o conteúdo do pacote rodando o
  `app.asar` com o Electron de dev (o `Hangar.exe` sem assinatura é bloqueado nesta máquina — não tente contornar).
- Linux/macOS não dá para gerar aqui com binários nativos corretos: valide a configuração com
  `electron-builder --linux --dir`/`--mac --dir` **se** rodar sem erro no Windows (senão, documente), e revise o
  YAML da CI com cuidado (sintaxe validada com `js-yaml`).

Relatório em `docs/agents/reports/w1-release.md`; responda só `PRONTO: w1-release`.
