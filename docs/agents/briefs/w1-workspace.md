# M1 (Desktop): feature `workspace` — Início, Meus agentes, eventos e deep links

Regras de `docs/agents/RULES.md`. **Seu feature novo: `workspace`** (`src/main/features/workspace/**`,
`src/renderer/src/features/workspace/**`, `src/shared/features/workspace.ts`). Especificação:
`docs/platform/m1-contract.md` (a seção 4, com o formato das respostas da plataforma, é preenchida em paralelo pelo
agente `platform` — leia o código da plataforma em `C:\Users\valteresj\OneDrive\Documentos\central_agents` se ainda
estiver vazia: `central/app/routers/access.py` (`/me/workspace`), `employees.py` (`/decisions`), `work.py`
(`/org-chart`, `/inbox`), e o Início do portal em `central/app/static/member.js` → `memberHome`).

**Exceções desta missão**: registrar o feature em `src/main/features/index.ts`; montar a seção na sidebar
(`src/renderer/src/features/sessions/Sidebar.tsx`, só a montagem do seu componente); deep links no main
(`src/main/index.ts`: `setAsDefaultProtocolClient('hangar')`, `second-instance`, `open-url`) e um campo de UI em
`src/renderer/src/core/ui.ts` para a tela ativa do workspace (`workspaceView?: 'home' | 'agents'` ou parecido).
Use o cliente HTTP do feature `platform` (`src/main/features/platform/`) — se precisar expor algo dele, faça pelo
`api.ts` do feature. O agente **release** mexe em `electron-builder.yml`, `package.json` (build), workflows e
`docs/RELEASE.md` — não toque neles. IPC sempre tipado. Sem `npm install`.

## Entregas

1. Cliente das rotas do membro e do SSE (`/api/app/events`) com reconexão (`Last-Event-ID`), backoff e fallback de
   polling de 60 s; tipos validados; cache de leitura em memória/disco.
2. **Seção Agent Hangar** na sidebar (Início, Meus agentes; Decisões e Caixa de entrada com badge ao vivo, abrindo o
   portal no navegador até a M2); recolhível; "Conecte à plataforma" quando desconectado.
3. **Início** e **Meus agentes** nativos no tema da plataforma (equivalentes ao portal; links de detalhe abrem o
   portal), estados de carregamento, vazio e erro.
4. **Deep links `hangar://open/<rota>`** com validação estrita da rota (lista fechada; nada de URLs arbitrárias),
   foco na janela e navegação para a tela; rotas ainda não migradas abrem o portal no navegador.
5. Testes: unitários (parse das respostas, eventos, roteamento de deep link e recusa de rotas inválidas) e e2e com a
   plataforma falsa (`tests/mock-platform/`: acrescente `/api/me/workspace`, `/api/decisions`, `/api/org-chart`,
   `/api/inbox` e `/api/app/events`): conectar → Início com dados → evento `decision.created` aumenta o badge →
   deep link abre Meus agentes. E2E opt-in contra a instância 8091 quando o agente `platform` deixá-la pronta
   (`docs/agents/reports/w1-platform.md`). Nunca use `http://localhost:8090`.

Verificação: `format:check`, `lint` (0 erros), `typecheck`, `typecheck:tests`, `npm test`, `npm run test:e2e`.
Relatório em `docs/agents/reports/w1-workspace.md`; responda só `PRONTO: w1-workspace`.
