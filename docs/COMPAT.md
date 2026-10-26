# Modelos que não são Claude (camada de compatibilidade)

O Hangar roda o Claude Code, que fala a API de Mensagens da Anthropic e é ajustado para o Claude. Por um gateway
compatível (LiteLLM, OpenRouter, a plataforma Agent Hangar) dá para usar GPT, Qwen, DeepSeek, Llama e outros, mas o
Claude Code trata **qualquer URL própria como se fosse a API da Anthropic**. Isso quer dizer que ele envia, para todo
modelo:

- `output_config.effort`, `context_management`, pensamento adaptativo (`thinking: {type: "adaptive"}`) e betas
  `anthropic-beta`;
- `max_tokens` de 32 000, acima do limite de muitos modelos (por exemplo, 16 384 no GPT-4o);
- mensagens com papel `system` no meio da conversa;
- cerca de 14 ferramentas (≈ 40 mil caracteres de definições), algumas delas adiadas via ToolSearch, que só a API da
  Anthropic resolve;
- chamadas de segundo plano (títulos, checagem de comandos) para o modelo "haiku", que vira um id Claude que o
  gateway não serve.

Não há variável de ambiente que desligue `effort` nesse caso: a checagem do CLI só aceita sobrescrever capacidades
para provedores de terceiros. Por isso o Hangar adapta as requisições no caminho.

## Como funciona

```
Claude Code ──► http://127.0.0.1:<porta>/r/<rota>/v1/messages ──► gateway do perfil
                 (proxy de compatibilidade, processo principal)
```

- **Proxy local** (`src/main/features/engine/compat/proxy.ts`): todo perfil do tipo gateway passa por ele. Cada
  rota tem um id impossível de adivinhar e aponta para a URL do perfil, nunca para uma URL vinda da requisição.
  As credenciais seguem como o Claude Code as envia, e o proxy não registra cabeçalhos nem corpos.
- **Decisão por requisição**: pelo `model` do corpo (`src/shared/compat.ts`). Modelos Claude passam intactos; os
  demais (ou todos, no modo "Todos os modelos") são adaptados por `adaptRequest`:
  - retira `output_config`, `context_management`, `top_k`, ferramentas de servidor e campos de ferramenta exclusivos
    da Anthropic (`defer_loading` e afins);
  - limita `max_tokens` ao modelo;
  - transforma o pensamento num orçamento de tokens nos modelos que raciocinam, ou o retira nos demais;
  - converte as mensagens `system` em `<system-reminder>` dentro do turno do usuário, junta turnos seguidos do mesmo
    papel (resultados de ferramenta primeiro) e remove blocos de pensamento do histórico;
  - não repassa o cabeçalho `anthropic-beta`.

  Se o gateway responder 400 recusando um campo, a requisição é reenviada uma vez em modo estrito: sem `metadata`,
  sem `cache_control` e sem `tool_choice: auto`.

- **Reparo das chamadas de ferramenta** (JSON e SSE): mapeia nomes de outros harnesses (`read_file`, `bash`,
  `str_replace`…) e argumentos (`path` → `file_path`, `old_str` → `old_string`, `filePath`…). Também lê argumentos
  enviados como texto (com cerca de código, codificados duas vezes ou com vírgula sobrando), converte tipos
  (`"10"` → `10`, `"false"` → `false`) e descarta `null` em campos opcionais. No streaming, os deltas de argumento
  são segurados até o fim do bloco e enviados de uma vez já corrigidos, porque o Claude Code só lê os argumentos no
  fim do bloco.
- **Opções no lançamento** (`compatSession`, em `engine/compat/index.ts`), para o modelo da sessão:
  - variáveis de ambiente:
    - `ENABLE_TOOL_SEARCH=false` e `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`;
    - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` e `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, com a janela real;
    - `CLAUDE_CODE_MAX_OUTPUT_TOKENS`;
    - `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` e, nos modelos que não raciocinam, `CLAUDE_CODE_DISABLE_THINKING`;
    - "haiku", o modelo rápido e o dos subagentes apontando para o modelo da sessão, quando o perfil não os mapeia;
  - sem `effort`;
  - ferramentas essenciais (`CORE_TOOLS`): arquivos, shell, busca, tarefas, WebFetch e perguntas;
  - instruções curtas de uso de ferramentas acrescentadas ao prompt de sistema (`compatInstructions`).

  Trocar a sessão entre um modelo Claude e um não-Claude reinicia o processo, que retoma a conversa.

### Configuração por perfil

Em Configurações → Provedores → (gateway) → "Modelos que não são Claude":

- **Adaptação**: automática (padrão), todos os modelos ou desligada;
- **Ferramentas**: essenciais ou todas;
- **Raciocínio**: pela tabela, sim ou não;
- **Janela de contexto** e **limite de saída**, para modelos que a tabela não conhece. Sem esses valores, valem
  128 000 e 8 192.

As variáveis extras do perfil prevalecem sobre as da camada.

## Bancada de modelos

O feature `bench` (`src/main/features/bench/`) roda oito tarefas de código determinísticas, cada uma com
verificação automática pelos arquivos entregues, nunca pelo que o modelo diz:

| Tarefa           | O que testa                                                         |
| ---------------- | ------------------------------------------------------------------- |
| write-exact      | Write com aspas, barras invertidas e acentos nos argumentos         |
| edit-config      | Read antes de Edit, `old_string` exato, preservar o resto do JSON   |
| fix-bug          | rodar os testes, ler a falha, corrigir dois bugs sem tocar no teste |
| find-symbol      | Grep/Glob em 12 arquivos, distinguir definição de uso               |
| run-script       | executar no shell e gravar a saída real, sem inventar               |
| count-log        | contagem exata em 2 000 linhas (E42 ≠ E420)                         |
| rename-symbol    | edições coordenadas em três arquivos e verificação final            |
| implement-module | implementar a partir de especificação, com casos de borda           |

Cada tarefa roda em duas variantes:

- **hangar**: a camada de compatibilidade, como as sessões rodam;
- **baseline**: como o Hangar fazia antes, com conexão direta ao gateway, pensamento adaptativo, `effort` e todas as
  ferramentas.

A bancada mede:

- sucesso;
- turnos e chamadas de ferramenta;
- erros de ferramenta e chamadas recusadas por argumentos inválidos;
- erros de API;
- tempo;
- tokens e custo estimado (tabela de preços em `bench/run.ts`; modelos desconhecidos usam um preço alto para o
  limite de orçamento errar para o lado seguro);
- contadores do proxy: requisições adaptadas, reenvios e reparos.

As execuções ficam em `<userData>/hangar-data/bench/`.

- **Offline**: `tests/e2e/bench.spec.ts` usa o modelo `mock-gpt` do servidor falso, que recusa os campos exclusivos
  da Anthropic e chama ferramentas como outros harnesses. A baseline falha com 400 e a variante hangar entrega.
- **Modelos reais**: `tests/e2e/bench-real.spec.ts` é opcional e custa dinheiro. Ele parte de uma cópia dos perfis
  do seu Hangar, e as chaves continuam cifradas e só são decifradas pelo app.

  ```bash
  HANGAR_BENCH_PROFILE="LiteLLM (avaliação)" HANGAR_BENCH_MODELS="gpt-4.1-mini,qwen3-coder" HANGAR_BENCH_BUDGET=2 npx playwright test tests/e2e/bench-real.spec.ts
  ```

  Os relatórios (JSON e Markdown) ficam em `bench-results/`.

## Resultados

### Medições (26/10/2026)

Ambiente: LiteLLM local (v1.89) → OpenRouter, Windows 11, Claude Code embutido no Agent SDK 0.3.310, shell
PowerShell. Cinco modelos, todos `openrouter/…` na mesma chave virtual de teste:

- `openai/gpt-4.1-mini`;
- `openai/gpt-oss-120b`, com raciocínio;
- `qwen/qwen3-coder`;
- `deepseek/deepseek-v4.1-flash`;
- `anthropic/claude-haiku-5.5`, o controle Claude.

**Rodada completa:** 8 tarefas × 5 modelos × 2 variantes × 2 repetições, interrompida em 149 de 160 execuções.

| Modelo              | baseline (antes) | hangar (camada de compatibilidade) |
| ------------------- | ---------------- | ---------------------------------- |
| gpt-4.1-mini        | 0/15             | 15/15                              |
| gpt-oss-120b        | 0/15             | 15/15                              |
| qwen3-coder         | 0/15             | 14/15                              |
| deepseek-v4.1-flash | 0/15             | 15/15                              |
| claude-haiku-5.5    | 0/15             | 15/15                              |
| **Total**           | **0/75 (0%)**    | **74/75 (98,7%)**                  |

Por que a baseline falha:

- Nos modelos não-Claude, o LiteLLM transforma o `effort` do Claude Code em `reasoning_effort`, e a rota do
  OpenRouter recusa com `400 UnsupportedParamsError`.
- No Claude via OpenRouter, a recusa é do `thinking`.
- Nenhuma tarefa passa do primeiro turno.

O Haiku só passa na variante hangar por causa da **adaptação aprendida**. Na primeira recusa de campo para um modelo
que o modo automático não adaptava, o proxy refaz a requisição adaptada e passa a adaptar esse modelo na rota (o
limite de saída do próprio modelo é mantido).

**Ajuste guiado pelas falhas.** As amostras de erro (`toolErrorSamples`) mostraram que os erros de ferramenta
restantes eram dos modelos e foram recuperados:

- `old_string` não encontrado;
- Edit em arquivo ainda inexistente;
- testes falhando no meio da correção.

Nenhuma chamada foi recusada por argumento inválido. As falhas de entrega vinham de verificação: o gpt-4.1-mini
parou depois de corrigir só um dos dois bugs, e o qwen errou uma contagem. As instruções passaram a pedir:

- números tirados da saída das ferramentas;
- rodar os testes de novo depois de cada correção até passarem;
- Write para arquivo novo;
- regex sem look-around no Grep (ripgrep).

| Tarefas fix-bug, count-log, edit-config, implement-module (hangar) | Antes         | Depois       |
| ------------------------------------------------------------------ | ------------- | ------------ |
| Entregas corretas                                                  | 58/60 (96,7%) | 40/40 (100%) |

Tarefa a tarefa, na variante hangar e somando todas as rodadas:

- count-log continua a mais difícil, com 32/35. O gpt-4.1-mini e o qwen3-coder às vezes contam errado, sem erro de
  ferramenta associado.
- As outras sete tarefas tiveram uma única falha (o fix-bug do gpt-4.1-mini, antes do ajuste).

Custo estimado das rodadas, pela tabela de preços da bancada: cerca de US$ 1,50. O LiteLLM registra gasto zero,
porque não tem preço configurado para essas rotas; o valor real está no painel do OpenRouter.

Os relatórios de cada rodada ficam em `bench-results/` (fora do git).
