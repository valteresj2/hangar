# Motor Hangar (Hangar Harness dentro do app)

O app tem dois motores de sessão. O perfil de provedor escolhe qual:

| Motor                     | O que é                                                                                                                           | Quando usar                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Claude Code** (padrão)  | O CLI `claude` pelo Agent SDK. Modelos que não são Claude passam pela camada de adaptação ([COMPAT.md](COMPAT.md)).               | Assinatura do Claude, API da Anthropic, Bedrock, Vertex, Foundry, e gateways com Claude.      |
| **Hangar Harness** (novo) | O [Hangar Harness](https://github.com/valteresj2/HangarHarness), em Python, falando a API de chat da OpenAI direto com o gateway. | Modelos abertos e de outros provedores num gateway (OpenRouter, LiteLLM, gateway da empresa). |

Em **Configurações → Provedores**, num perfil de gateway, o campo **Motor** troca entre os dois. Sessões novas e a
próxima mensagem de sessões existentes passam a usar o motor do perfil.

## Requisitos

- **Python 3.11 ou mais novo** no computador (o app não embute um interpretador). O app procura `python`, `py -3` e
  `python3` no PATH; para apontar outro, use `settings.hangarPythonPath` ou a variável `HANGAR_PYTHON`.
- O harness em si vai dentro do app, em `resources/harness` (Python puro, sem dependências).
- O gateway precisa servir a API de chat da OpenAI em `<URL base>/v1/chat/completions`. A URL base do perfil continua
  sem `/v1` (a mesma que o Claude Code usa): `https://openrouter.ai/api`, `http://localhost:4000`.
- O perfil precisa de um **modelo padrão** com o id que o gateway usa (`openai/gpt-4o`, `qwen/qwen3-coder`…). Os
  apelidos `opus`, `sonnet` e `haiku` valem se o perfil os mapear.

## O que funciona igual nos dois motores

| Recurso do app                                    | No motor Hangar                                                                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat em streaming e raciocínio                    | Sim.                                                                                                                                                                                                                                    |
| Cartões de ferramenta, com diff nas edições       | Sim: as ferramentas do harness aparecem com os nomes do Claude Code (`Write`, `Edit`, `Bash`, `Read`…).                                                                                                                                 |
| Lista de tarefas fixada                           | Sim (a ferramenta `plan` do harness vira `TodoWrite`).                                                                                                                                                                                  |
| Cartões de permissão                              | Sim: Permitir, Permitir sempre nesta sessão, Negar com motivo.                                                                                                                                                                          |
| Modos de permissão                                | Perguntar → pergunta antes de escrever e de rodar comandos; Aceitar edições → só comandos perguntam; Planejar → somente leitura; Auto e Ignorar permissões → sem perguntas (os bloqueios de comandos destrutivos do harness continuam). |
| Perguntas do agente                               | Sim (cartão de pergunta).                                                                                                                                                                                                               |
| Modelo e esforço por sessão                       | Sim; a troca de modelo vale na rodada seguinte.                                                                                                                                                                                         |
| Custo, tokens e uso do contexto por rodada        | Sim, com o custo que o gateway informa.                                                                                                                                                                                                 |
| Interromper                                       | Sim: cancela o stream do modelo e o comando em execução.                                                                                                                                                                                |
| Retomar depois de fechar o app                    | Sim (`session.hangarSessionId`; a conversa fica em `hangar-data/harness/sessions`).                                                                                                                                                     |
| Anexos e imagens coladas                          | Sim; imagem só vai ao modelo se ele aceitar imagem.                                                                                                                                                                                     |
| Instruções do projeto e lições do Harness         | Sim: entram no prompt de sistema do harness.                                                                                                                                                                                            |
| Ferramentas do Agent Hangar (plataforma)          | Sim: o MCP da plataforma é passado ao harness, e as chamadas pedem permissão.                                                                                                                                                           |
| `.mcp.json` do projeto, `AGENTS.md`/`CLAUDE.md`   | Sim, lidos pelo próprio harness.                                                                                                                                                                                                        |
| Artifacts, Alterações (git), notificações         | Sim: os mesmos eventos de arquivo escrito, fim de rodada e pedido de entrada.                                                                                                                                                           |
| Vídeos Hangar Motion                              | Sim (o guia vai junto da mensagem, e o cartão aparece ao escrever o `*.motion.json`).                                                                                                                                                   |
| Tarefas agendadas, Quick Entry, acompanhar tarefa | Sim: usam o mesmo `sendPrompt`.                                                                                                                                                                                                         |
| Harness do projeto (`.claude/`)                   | Sim: `.claude/CLAUDE.md`, subagentes de `.claude/agents`, slash commands de `.claude/commands` (o menu `/` lista e o harness expande) e os hooks `PreToolUse`/`PostToolUse`/`Stop` de `.claude/settings.json`.                          |
| Lab                                               | Sim: as variantes rodam como sessões neste motor, com o harness de cada uma; o proponente, o seletor às cegas e o refletor de lições usam o motor do perfil padrão.                                                                     |
| Bancada de modelos                                | Sim: a variante `harness` roda as mesmas tarefas neste motor, ao lado de `hangar` e `baseline` (Claude Code).                                                                                                                           |

## Grafo ao vivo

Sessões do motor Hangar ganham a aba **Grafo** no painel lateral: o trabalho do agente desenhado enquanto acontece.
Cada agente tem a sua raia (o principal e cada sub-agente), cada rodada do modelo é uma linha, e as ferramentas
chamadas na mesma rodada ficam lado a lado. Aparecem também a sua mensagem, aprovações, perguntas, regras do projeto
que bloquearam algo e o resultado de cada rodada. Clicar num nó mostra os argumentos (e o erro, se houve).

- `src/shared/flow.ts` — o modelo do grafo (porte do `flow.js` do painel do harness), puro e testado.
- `src/main/features/engine/hangar/flow.ts` — grava os eventos resumidos e sem segredos em
  `hangar-data/flow/<sessão>.jsonl` (o grafo volta depois de reabrir o app) e os envia ao renderer.
- `src/renderer/src/features/engine/FlowPanel.tsx` — a aba.

## O que fica só no Claude Code

- **Voltar e bifurcar** a conversa (dependem do arquivo de sessão e dos checkpoints do Claude Code).
- **Slash commands embutidos do Claude Code** (`/compact`, `/review`…): no motor Hangar valem os do projeto.
- **Modo Rápido**.
- **Diagnóstico do onboarding**: continua chamando o Claude Code diretamente.
- **Servidores MCP cadastrados pelo `claude mcp`** (o harness lê `.mcp.json` do projeto e `mcp.json` próprio).

## Como funciona

```
renderer ── IPC (engine:*) ──▶ registry.runnerFor(sessão)
                                   ├─ Runner        (Claude Code, Agent SDK)
                                   └─ HangarRunner  ──▶ HangarBridge ── stdin/stdout JSON ──▶ python -m hangar bridge
```

- `src/main/features/engine/hangar/runner.ts` — `HangarRunner`, com a mesma superfície do `Runner`. Traduz cada evento
  do harness na entrada de transcrição que a interface já desenha e emite os mesmos eventos no `bus`.
- `hangar/bridge.ts` — um processo por sessão. A chave do perfil vai na variável `HANGAR_BRIDGE_KEY`, nunca numa
  mensagem; a saída de erro é mascarada antes de aparecer.
- `hangar/map.ts` — traduções puras (ferramentas, modos, URL, tokens), cobertas por testes.
- `hangar/locate.ts` — acha o Python e a pasta do harness.
- `hangar/headless.ts` — `hangarQuery`: uma consulta avulsa, sem sessão nem transcrição (o equivalente de chamar o
  `query()` do Agent SDK). É o que a bancada, o proponente e o seletor do Lab e o refletor usam.
- `hangar/commands.ts` — os slash commands do projeto, lidos dos arquivos (para o menu `/` antes de o processo existir).
- O protocolo está descrito em `resources/harness/hangar/bridge.py`.

## Lab e bancada neste motor

- **Variantes do Lab**: cada variante é uma sessão num worktree com o harness dela escrito em `.claude/`. No motor
  Hangar a sessão começa com `trust_project`, então instruções, subagentes, comandos e hooks da variante valem como
  valeriam no Claude Code.
- **Proponente**: roda com `allowed_tools` de arquivo apenas (`read`, `glob`, `grep`, `write`, `edit`), `confine` (as
  ferramentas não saem da pasta de evidências) e modo `ask`; cada escrita passa pela mesma regra do Claude Code
  (`stageToolRule`): só arquivos da superfície do harness, dentro de `harness/`.
- **Seletor às cegas e refletor**: `allowed_tools: []`, uma única resposta de texto, numa pasta vazia.
- **Bancada**: a variante `harness` usa a mesma pasta temporária, o mesmo prompt, a mesma verificação e a mesma
  estimativa de custo das outras; "turnos" são os passos do harness. Só existe em perfis de gateway.

O motor do Lab e do refletor é o do **perfil padrão**; o da bancada é escolhido pela variante.

## Atualizar o harness embutido

```bash
npm run harness:sync -- --tag v0.4.2            # de uma versão publicada
npm run harness:sync -- ../HangarHarness        # de um checkout local
```

O script copia o pacote `hangar` para `resources/harness` e grava `resources/harness/VERSION`.

## Testes

- `tests/unit/hangar-engine.test.ts` — mapeamentos, e um `HangarRunner` de verdade com o bridge em Python contra um
  servidor OpenAI falso (`tests/mock-openai`): permissão, modos, interrupção, retomada, slash commands, consulta
  avulsa, a bancada na variante `harness`, e o proponente, o seletor e o refletor do Lab.
- `tests/e2e/hangar-engine.spec.ts` — o app aberto, com o mesmo servidor falso (sessão, bancada e comandos).
- `tests/e2e/hangar-engine-real.spec.ts` — opcional, contra um modelo real pelo OpenRouter
  (`HANGAR_REAL_OPENROUTER_KEY`).

Os dois primeiros rodam na CI e são pulados onde não há Python 3.11+.
