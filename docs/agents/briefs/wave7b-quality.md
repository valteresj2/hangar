# Sétima onda, fase B: quality (ESLint, Prettier e IPC tipado)

Regras de `docs/agents/RULES.md`, com uma **exceção ampla**: nesta missão você é o único agente ativo e pode editar
**qualquer arquivo do repositório** (código de todos os features, core, configs, `.github/workflows/ci.yml`), desde
que o comportamento do app não mude. Sem `npm install` — já estão instalados: `eslint`, `@eslint/js`,
`typescript-eslint`, `eslint-plugin-react-hooks`, `globals`, `prettier`. TypeScript é 6.0.3 (fixado por causa do
typescript-eslint). Scripts existentes: `lint`, `format`, `format:check`, `typecheck`, `typecheck:tests`, `test`,
`test:e2e`.

Faça em **três etapas separadas**, verificando cada uma. **Ao fim de cada etapa, pare e responda só
`ETAPA <n> PRONTA`** — o chief comita a etapa e manda você continuar. Deixe um resumo do que cada etapa tocou no
relatório.

## Etapa 1 — Prettier

- `.prettierrc.json` reproduzindo o estilo atual (sem ponto e vírgula, aspas simples, `printWidth` 120, sem vírgula
  final, `arrowParens: always` se for o que domina — confira no código) e `.prettierignore` (`out`, `release`,
  `node_modules`, `package-lock.json`, `test-results`, `playwright-report`, `docs/agents/**`, `*.md` gerados por
  agentes se o formato quebrar tabelas).
- `npm run format` no repositório inteiro. Nenhuma mudança além de formatação nesta etapa.

## Etapa 2 — ESLint

- `eslint.config.mjs` (flat config): `@eslint/js` recommended, `typescript-eslint` recommended **com type-check** para
  `src/**` (parserOptions `project` com os dois tsconfigs, ou `projectService`), `react-hooks` (rules-of-hooks como
  erro, exhaustive-deps como aviso), `globals` de node para main/preload/tests e de browser para o renderer,
  `eslint-config-prettier` não está instalado — desligue manualmente regras de formatação, se alguma conflitar.
  Regras úteis: `@typescript-eslint/no-floating-promises` (erro no main), `no-misused-promises`, `consistent-type-imports`.
  Em particular, proíba `useEffect` cujo callback devolve algo que não seja função de cleanup (o bug do Chromium 156
  que já derrubou a tela uma vez) — com uma regra existente ou uma regra local simples.
- Corrija todos os erros de verdade. `eslint-disable` só pontual, com motivo no comentário. `any` existentes: troque
  por tipos reais quando simples; o resto vira aviso.

## Etapa 3 — IPC tipado

Hoje cada canal é uma string e os argumentos/retornos não são verificados entre main e renderer.
- Em `src/shared/ipc.ts`, um mapa de contrato tipado (por exemplo, uma interface `IpcContract` que cada feature estende
  por *declaration merging* no seu `src/shared/features/<feature>.ts`, ou um objeto de definição por feature) com
  `channel → (...args) => result` para request/response e um mapa de eventos main→renderer.
- Main: helper `handle(channel, fn)` em `src/main/core/` (compatível com o `ipcGuard`) que só aceita canais do contrato
  com a assinatura certa. Renderer: `invoke(channel, ...args)` e `on(event, listener)` tipados (em `core/api.ts`,
  mantendo `window.hangar` como transporte).
- Migre **todos** os features. O resultado: mudar a assinatura de um handler sem mudar o renderer quebra o typecheck.
- Documente o padrão em `docs/ARCHITECTURE.md` (curto: features, contratos, IPC, eventos do bus, provedores).

## Pronto quando

`npm run format:check`, `npm run lint` (zero erros), `npm run typecheck`, `npm run typecheck:tests`, `npm test` e
`npm run test:e2e` passam; a CI (`.github/workflows/ci.yml`) ganha os passos `format:check` e `lint`.
Relatório em `docs/agents/reports/wave7b-quality.md`; responda só `PRONTO: wave7b-quality`.
