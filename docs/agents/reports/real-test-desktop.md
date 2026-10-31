# Teste real pelo app desktop — 31/10/2026

O app (build local, conectado a `https://agent-hangar.tunneled.to`, plataforma 0.53.0) foi usado como uma pessoa usaria:
clicando e digitando na interface, sem chamar a plataforma por fora. As sessões rodaram no Opus pela assinatura, e
cada permissão de ferramenta foi aprovada no cartão do app. A interface foi conduzida pelo DevTools do próprio app
(Playwright conectado por CDP).

## Roteiro e resultado

| # | O que a pessoa fez no app | Resultado |
|---|---|---|
| 1 | Nova sessão com nome, perguntou que ferramentas do Agent Hangar tem | 87 ferramentas `mcp__agent-hangar__*` (depois da correção 1) |
| 2 | Pediu um agente simples ("Teste Desktop Resumidor") | Planejado, testado em stage (10/10) e em produção em 71 s |
| 3 | Pediu o papel do agente e um resumo | O agente se apresentou e resumiu em 3 tópicos |
| 4 | Em outra sessão, pediu um multiagente ("Equipe de Conteúdo": pontos-chave, redator, revisor) | 4 agentes testados em stage e em produção em 4,6 min |
| 5 | Em outra sessão, contratou um Digital employee ("Assistente de Atas") e passou uma tarefa | Ata correta só depois de trocar o LLM (correção 3); decisão de admissão #560 apareceu em Início |
| 6 | Meus agentes → **Conversar** no multiagente; mandou um tema | Post de ~105 palavras, as 3 etapas na ordem |
| 7 | Meus agentes → **Conversar** no employee | Papel, status, tarefas e a decisão aberta |
| 8 | Pediu para pausar o employee e parar os agentes de teste | Employee pausado; 5 agentes parados em stage e prod; nada apagado; #560 aberta |

## O que foi encontrado e corrigido

1. **App — as sessões não tinham as ferramentas do Agent Hangar.** O app pedia o escopo `app mcp` no login, mas nunca
   entregava o MCP da plataforma às sessões; o Claude respondia que não encontrava como criar agentes (a sessão
   "Teste" do usuário, de 28/10, mostra isso). Agora `platform/mcpBridge.ts` expõe uma ponte em `127.0.0.1` que
   encaminha para `<plataforma>/mcp` com o token do login (renovado no processo principal; o token não vai para o
   Claude Code), e toda sessão iniciada com o app conectado recebe o servidor `agent-hangar`.
2. **App — não havia como conversar com um agente pelo desktop.** Meus agentes só abria o portal. Agora cada agente e
   Digital employee tem **Conversar**: abre a tela de nova sessão com nome e primeira mensagem preenchidos (o papel
   do agente primeiro, depois o que a pessoa escrever), editáveis.
3. **Plataforma — agente montado sem modelo rodava no mock.** `hire_employee`, `compose_agent` e
   `build_multi_agent` deixavam `llm` vazio quando quem pede não escolhe modelo; o employee respondeu as 3 tarefas
   de experiência só ecoando o texto. Agora usam a conexão de chat da empresa (0.54.0).
4. **Plataforma — "Último uso: —" sempre.** Os agentes de Meus agentes não traziam `last_used_at` (0.54.0).
5. **Plataforma — agente parado continuava "stage".** Parar prod e depois stage deixava o status em `stage` (0.54.0).

## Observações sem correção

- O custo aparece como US$ 0,00 nas chamadas do DeepSeek V4.1 Flash pela conexão `litellm`: falta o preço desse
  modelo no catálogo da instalação (dado, não código). Vale cadastrar o preço em Catálogo → Conexões de LLM.
- Decisões e Caixa de entrada ainda abrem o portal; pelo app, a pessoa decide pedindo na sessão (`decide`).
- O employee ofereceu uma ferramenta que não tem (`record_minutes`); é texto do modelo.

## Itens de teste deixados na plataforma

Parados ou pausados, nada apagado: `teste-desktop-resumidor`, `teste-desktop-equipe-de-conteudo`,
`teste-desktop-pontos-chave`, `teste-desktop-redator-linkedin`, `teste-desktop-revisor-de-post` e o employee
`teste-desktop-assistente-de-atas` (decisão de admissão #560 aberta; o agente dele ainda tem a v3 no ar em stage). As sessões de teste estão na pasta
`Documentos\Hangar-teste`.
