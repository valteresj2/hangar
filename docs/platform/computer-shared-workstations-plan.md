# Plano — computadores compartilhados: qualquer agente usa a máquina local ou a de um colaborador quando precisa

Status: **aprovado e construído** (2026-11-07), com os padrões recomendados: perguntar a cada empréstimo; liberar os
funcionários que a dona gerencia e/ou os de times dela; computador ocupado = fila. No app, o computador fica em **um**
modo por vez (posto de um funcionário **ou** compartilhado). Verificado ao vivo na plataforma local (2026-11-07): o Cientista de Dados, rodando na plataforma com um modelo de verdade, pediu este computador emprestado, a dona permitiu no aviso do app e ele lançou a fatura 89 no Mini ERP (tarefa #1523, US$ 0,21). Continua o posto no computador
([computer-workstation-plan.md](computer-workstation-plan.md)), que hoje é Windows, macOS e Linux, com **um funcionário
por máquina** e a máquina como **único worker** desse funcionário.

## 1. O que muda

Hoje o computador "vira" um funcionário: ele busca as tarefas dele e as executa. Para qualquer agente usar uma máquina
quando precisa, o computador passa a ser um **recurso registrado na plataforma**, que os funcionários **pegam
emprestado** para os passos de tela de uma tarefa:

```
Funcionário (roda na plataforma, runtime hangar)            Computador da pessoa (Agent Hangar Desktop)
  tarefa precisa do ERP que só existe no PC da Ana
  computer_list() → [PC-ANA (Windows, ERP Legado, online)]
  computer_use(PC-ANA, "ERP Legado", motivo) ─────────────▶  "Engenheiro de Dados quer usar este computador
                                                             para a tarefa #1530 (ERP Legado). Permitir?"
                                                             Ana clica Permitir → empréstimo (lease) ativo
  desktop_click(...) → alçada na plataforma (decide_click) ─▶ fila do computador → executa → captura
                     ◀────────────────────────────────────── resultado + tela (long-poll de saída)
  fim da tarefa / ocioso / Parar → empréstimo termina
```

- O funcionário **continua rodando na plataforma** (instruções, MCPs, memória, alçada); só os passos de tela vão para a
  máquina. Some a limitação de "um worker por funcionário": o mesmo funcionário usa o VS Code de alguém e o computador de
  outra pessoa na mesma tarefa.
- A alçada acontece **na plataforma, antes** de mandar o passo (as mesmas `decide_click/type/key` de hoje); o app
  continua com as checagens dele (apps liberados, janela, teclas, pausa, segredo só em campo de senha).
- O modo atual (a máquina é o worker de um funcionário) continua para quem quer um funcionário "morando" num computador.

## 2. Plataforma

1. **`Workstation`** (tabela nova): dono (a pessoa), nome da máquina, sistema, apps liberados, **quem pode usar**
   (funcionários que a pessoa gerencia, funcionários de times escolhidos, ou funcionários escolhidos um a um), **como
   autoriza** (`ask`: pergunta a cada empréstimo — padrão; `preauthorized`: sem pergunta para os funcionários listados,
   só com o aviso na tela), online (heartbeat), empréstimo atual.
2. **Registro pelo app** (token do app, rota de membro M5): `POST /api/app/workstations` cria a máquina da pessoa e
   devolve um token próprio `wst_…` (um por máquina, não por funcionário); `PATCH` muda apps e permissões; `DELETE`
   desliga. O admin vê todas no console e pode desligar qualquer uma.
3. **Ferramentas do funcionário** (grupo `computer`, só para quem tem o grupo ligado no cargo):
   - `computer_list()` — as máquinas que ele pode usar, online, com os apps;
   - `computer_use(workstation, app, motivo)` — pede o empréstimo; com `ask`, a tarefa espera a resposta da pessoa
     (como uma decisão, com prazo); recusado ou sem resposta volta ao funcionário como recusa;
   - `desktop_*` — os mesmos nomes de hoje; com empréstimo ativo vão para a máquina emprestada (senão, para o desktop
     governado do contêiner, como hoje).
4. **Fila do computador** (`/hooks/workstation/*`, token `wst_`): o app faz long-poll de saída (funciona atrás de NAT,
   como o worker), recebe o próximo passo já liberado pela alçada, devolve o resultado com a captura. Um passo sem
   resposta em 60 s falha e volta ao modelo como erro.
5. **Empréstimo**: um funcionário por vez por máquina (outro pedido entra na fila ou é recusado, a definir); termina no
   fim da tarefa, depois de N minutos sem passos, ou quando a pessoa clica Parar (aí a tarefa recebe "a pessoa parou").
6. **Linha do tempo**: `lease.requested/granted/denied/ended` e cada passo como hoje (`desktop`, com a máquina).

## 3. App (Agent Hangar Desktop)

- **Configurações → Computador**: ligar esta máquina como compartilhada, escolher apps, quem pode usar e como autoriza.
  O modo atual ("Posto no computador" de um funcionário) fica na mesma tela.
- **Pedido de uso**: notificação + janela "Engenheiro de Dados quer usar este computador para a tarefa #1530 — ERP
  Legado. Permitir / Recusar", com o motivo e quem pediu a tarefa.
- **Execução**: o mesmo driver, guarda, pausa e indicador de hoje; o aviso diz quem pegou emprestado e para qual
  tarefa. Parar (botão ou Ctrl+Alt+End) encerra o empréstimo.

## 4. Segurança (o que não muda e o que entra)

- Ninguém usa uma máquina que a pessoa não ligou; nenhum app fora da lista dela; o próprio Hangar, configurações do
  sistema e gerenciadores de senha nunca.
- **Novo**: quem pode usar é escolhido pela pessoa dona da máquina (não pelo gestor do funcionário); o padrão é
  perguntar a cada empréstimo. Um admin da empresa pode proibir `preauthorized` por política.
- Um funcionário nunca aprova o próprio passo: as decisões continuam com o gestor dele; a dona da máquina só autoriza o
  empréstimo e pode parar a qualquer momento.

## 5. Fases

1. Plataforma: `Workstation`, registro M5, fila e empréstimo, ferramentas `computer_*`, roteamento dos `desktop_*`,
   testes.
2. App: registro, pedido de uso, laço da fila reaproveitando driver/guarda/pausa, e2e com a plataforma de mentira.
3. Demonstração com dois "computadores" (o app de verdade e um segundo app de teste) e um funcionário da plataforma.

## 6. Para decidir

1. Autorização padrão: **perguntar a cada empréstimo** (recomendado) ou pré-autorizar os funcionários escolhidos?
2. Quem pode ser liberado: só funcionários que a pessoa gerencia, ou também os de times que ela escolher?
3. Máquina ocupada: o segundo pedido **espera na fila** (recomendado) ou é recusado na hora?
