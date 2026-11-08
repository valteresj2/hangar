# Plano — gravar a tarefa e transformar em agente ("mostre uma vez, ele faz sempre")

Status: **aprovado e construído** (padrões: funcionário novo por gravação; transcrição pela conexão de LLM da
plataforma; dentro do expediente, com aviso quando o computador está bloqueado). Windows primeiro. Veja "O que foi
construído" no fim.

A pessoa grava a tela e o microfone enquanto faz e explica uma tarefa do dia a dia ("toda segunda eu abro o ERP, puxo
as faturas vencidas e mando a lista para o financeiro"). A gravação vira um Digital employee (ou uma skill de um que já
existe) que executa essa tarefa sozinho, na frequência que ela disse, no computador dela, com as mesmas regras do posto
no computador (apps liberados, aviso na tela, Parar, pausa quando ela usa o computador, alçada da plataforma).

## 1. O fluxo

```
App (Agent Hangar Desktop)                                    Plataforma
 1. Gravar: tela dos apps escolhidos + microfone
    + registro do que foi feito (janela, elemento, texto)
 2. Ao parar: a pessoa revê e escolhe o que enviar
 3. Transcrever a fala ───────────────────────────────────────▶ conexão de LLM com modelo de fala (STT)
 4. Enviar o pacote (transcrição, registro, imagens) ─────────▶ /api/app/recordings
                                                                 5. modelo com visão monta o rascunho:
                                                                    procedimento, variáveis, pontos que
                                                                    confirmam algo, apps, agenda, contratação
 6. Revisão no app: a pessoa corrige o rascunho ◀──────────────
 7. Contratar em modo sombra + experiência ──────────────────▶ hire_employee (shadow) + start_probation
 8. Ensaios no computador da pessoa (compartilhado, perguntando) — ela revisa
 9. Ativo: a rotina cria a tarefa no horário; o funcionário pega o computador emprestado e faz
```

O que já existe e é reaproveitado: o **computador compartilhado** e o **posto** (execução na tela, com segurança), a
**contratação** (`plan_employee` / `hire_employee`, com perguntas quando falta algo), o **modo sombra**, o **período de
experiência**, as **rotinas** (cron, uma execução por vez) e o catálogo de modelos da plataforma (que já reconhece
modelos de fala, `stt`).

## 2. Gravar (app)

- **O que é gravado**
  - **Vídeo** só das janelas dos apps que a pessoa escolhe antes de começar (mesma lista e mesmas regras do posto: o
    próprio Hangar, gerenciadores de senha e configurações do sistema nunca entram). Electron `desktopCapturer` por
    janela + `MediaRecorder` (WebM). Outras janelas não aparecem no vídeo.
  - **Microfone** (a narração), na mesma gravação.
  - **Registro estruturado**, que é o que permite reproduzir com precisão (o vídeo sozinho é frágil):
    - cada clique: hora, janela, posição e o **elemento** sob o ponteiro pela UI Automation (tipo, nome, ex.:
      botão "Lançar"), mais uma captura da janela naquele momento;
    - cada texto digitado: lido do **valor do campo** quando ele perde o foco (UI Automation), **não** das teclas — nada
      de registrar tecla por tecla; campo de senha (`IsPassword`) é registrado só como "[senha digitada]", sem valor;
    - atalhos com Ctrl/Alt/Cmd e Enter/Tab (não letras soltas); troca de janela; rolagem.
  - O ajudante do Windows ganha um modo "observar" (gancho só de mouse para os cliques + leitura da UI Automation no
    foco). macOS e Linux depois, pelo mesmo caminho dos drivers.
- **Durante a gravação:** aviso vermelho sempre visível com Pausar e Parar; limite de 30 min por gravação; tudo fica
  local (pasta do app, cifrada) até a pessoa decidir.
- **Ao parar:** tela de revisão com o vídeo, a linha do tempo das ações e a transcrição. A pessoa pode cortar trechos,
  apagar ações e só então enviar. "Descartar" apaga tudo.

## 3. Transcrever e montar o rascunho

- **Transcrição:** pela conexão de LLM da plataforma que tenha um modelo de fala (`stt`, ex.: Whisper pelo LiteLLM). O
  áudio vai uma vez e não fica guardado na plataforma. Sem modelo de fala configurado, o app avisa e a pessoa pode
  escrever a explicação em texto.
- **Pacote enviado** (`POST /api/app/recordings`, rota nova do app): a transcrição com tempos, o registro de ações e
  as capturas das janelas nos momentos das ações (não o vídeo inteiro: custo e privacidade). O vídeo só vai se a pessoa
  anexar.
- **Rascunho** (serviço novo `services/recordings.py`): um modelo com visão, escolhido pela empresa, recebe o pacote e
  devolve, em formato fixo:
  - **procedimento** passo a passo (com o elemento e a janela de cada passo, como o registro mostrou);
  - **variáveis**: o que muda a cada vez (data, número da fatura, "as vencidas desta semana") e de onde vem;
  - **pontos que confirmam algo** (salvar, enviar, pagar) — viram regras de alçada que pedem aprovação no começo;
  - **apps** usados, e o computador onde a tarefa roda (o da gravação);
  - **agenda**: a frequência que a pessoa disse, em cron e por extenso ("toda segunda às 9h"), **sempre para
    confirmar**; se ela não disse, a pergunta fica no rascunho;
  - **perguntas** sobre o que a gravação não mostrou ("e se não houver fatura vencida?", "para quem vai o e-mail?");
  - o **pedido de contratação** (`plan_employee`): título, missão, responsabilidades, sistemas, instruções (o
    procedimento), alçada, rotina e **tarefas de experiência** geradas a partir da própria gravação (refazer o que foi
    gravado, com o resultado esperado que a gravação mostrou).

## 4. Revisar, ensaiar e ligar

- **Revisão no app** (tela nova "Gravar uma tarefa"): o rascunho aparece editável — passos, variáveis, pontos de
  aprovação, agenda e as respostas às perguntas. A pessoa escolhe: **funcionário novo** ou **skill de um funcionário
  que ela já gerencia**.
- **Contratação segura:** o funcionário nasce em **modo sombra** e em **período de experiência**, com `autonomy_level`
  `intern`; os pontos que confirmam algo pedem aprovação. A contratação passa pelo mesmo `hire_employee` (o que faltar,
  a plataforma pergunta como sempre).
- **Ensaios:** as tarefas de experiência rodam no computador da pessoa, que precisa estar **compartilhado** (o app
  oferece ligar, com os apps da gravação liberados e "perguntar a cada uso"). Ela vê o funcionário refazer a tarefa e
  avalia no modo sombra (as confirmações são simuladas).
- **Ativo:** aprovada a experiência, a rotina passa a criar a tarefa no horário; o funcionário pede o computador
  emprestado e faz. O primeiro mês com aprovação nos pontos que confirmam algo; depois, a alçada normal do cargo.

## 5. Rodar sem a pessoa por perto (limite importante)

O posto opera a sessão do Windows **desbloqueada**; com a tela bloqueada ele pausa (e o Windows não aceita entrada
injetada na tela de bloqueio). Na versão 1:

- o horário da rotina é escolhido dentro do expediente da pessoa (o app sugere), e se o computador estiver bloqueado ou
  desligado, a tarefa espera e avisa ("o computador de Ana está bloqueado: a tarefa espera até 2 h");
- para rodar de madrugada, a recomendação é um **computador dedicado** (ou uma máquina virtual) com a sessão aberta,
  compartilhado com os apps da tarefa — documentado, não automatizado nesta versão.

## 6. Segurança e privacidade

- Gravação só com a pessoa iniciando, só das janelas escolhidas, com o aviso vermelho visível o tempo todo.
- Senhas nunca são gravadas (campo de senha vira "[senha digitada]"); no rascunho, o funcionário recebe
  `secret://nome` e a pessoa cadastra a senha no cofre da plataforma.
- Nada sai do computador antes da revisão; o vídeo fica local (a pessoa escolhe anexar); o áudio vai só para a
  transcrição; prazo de retenção local configurável (padrão 30 dias), e "Apagar" de verdade.
- O rascunho nunca contrata sozinho: a pessoa revisa, e o funcionário começa em sombra e experiência.
- Tudo na linha do tempo e na auditoria (gravação enviada, rascunho, contratação, ensaios).

## 7. Testes

- **Unidade:** o registro de ações (cliques, valores de campos, senha omitida), a montagem do pacote, a leitura do
  rascunho e o mapeamento para `plan_employee`.
- **Plataforma (pytest):** `/api/app/recordings` com um modelo de mentira (rascunho em formato fixo, agenda em cron,
  perguntas), contratação em sombra a partir do rascunho.
- **e2e (plataforma de mentira):** gravar no computador de mentira, revisar, contratar, ensaio no compartilhado.
- **Real:** gravar o Mini ERP lançando uma fatura e narrando "faça isso toda segunda"; ver o funcionário nascer,
  ensaiar e rodar pela rotina.

## 8. Fases

1. **Gravar e revisar** (app): vídeo das janelas + microfone + registro estruturado, tela de revisão, descartar.
2. **Rascunho** (plataforma + app): transcrição, pacote, `services/recordings.py`, tela do rascunho editável.
3. **Contratar e ensaiar:** do rascunho para `hire_employee` em sombra/experiência, ligar o compartilhado, ensaios.
4. **Rotina e execução:** rotina ativa, espera quando o computador está bloqueado, avisos.

## 9. Para decidir

1. O resultado padrão: **funcionário novo** (recomendado — cada tarefa gravada com a sua alçada e histórico) ou skill de
   um funcionário existente?
2. Transcrição: **pela conexão de LLM da plataforma** (recomendado, já existe o tipo `stt`) ou no próprio computador
   (sem enviar áudio, mas o app fica bem maior)?
3. A primeira versão já trata rodar sem a pessoa (computador dedicado) ou só **dentro do expediente**, com o aviso
   quando o computador estiver bloqueado (recomendado)?

Decidido: funcionário novo; transcrição pela plataforma; dentro do expediente com o aviso.

## 10. O que foi construído

- **Ajudante do Windows** (`driver/helper/HangarDesktopHelper.cs`): `watch_start` / `watch_poll` / `watch_stop`.
  Gancho de mouse (WH_MOUSE_LL) para os cliques e de teclado (WH_KEYBOARD_LL) só para atalhos e para contar teclas;
  uma linha de trabalho resolve o elemento (UI Automation), captura a janela (outros apps em preto) e segue o foco
  (300 ms) para registrar o valor final de cada campo. Senha: o valor nunca é lido. Entrada injetada (SendInput) é
  ignorada, então o próprio posto não se grava.
- **Desvio do plano:** em vez de vídeo das janelas pelo `desktopCapturer`, o app guarda **a captura da janela em cada
  clique**, feita pelo ajudante. Motivo: as caixas de diálogo são janelas à parte (o vídeo de uma janela as perde) e a
  captura do ajudante já pinta os outros apps de preto; o rascunho só precisa das capturas dos passos. O vídeo
  contínuo pode voltar depois, se fizer falta na revisão.
- **App** (`computer/recorder.ts`, `recording.ts`, `RecordSection.tsx`): gravar/pausar/parar (aviso vermelho, limite
  de 30 min), microfone pela janela (`MediaRecorder`, só áudio), loja cifrada com retenção de 30 dias, revisão (apagar
  passos e a narração, transcrever, notas), envio, edição do rascunho e contratação (liga o compartilhamento com os
  apps da gravação, perguntando a cada uso).
- **Plataforma** (`services/recordings.py`, `/api/app/recordings*`, migração `0057_recordings`): transcrição pelo
  modelo `stt` do catálogo (o áudio não fica), rascunho pelo modelo de chat padrão da empresa (com as capturas se ele tem visão; só os passos se não;
  ou pelas regras, sem LLM — agenda lida da fala, senhas como `secret://`, "Lançar/Salvar/Enviar…" como pontos que
  confirmam, três ensaios), contratação em sombra + estagiário + rotina + experiência iniciada.
- **Computador bloqueado** (`services/workstations.py`): o heartbeat diz `locked`; bloqueado ou desligado há pouco, o
  empréstimo espera (`workstation_wait`, até 2 h, avisando a dona) e segue sozinho quando o computador volta.
- **macOS e Linux**: ainda não gravam (o painel diz isso); o caminho é o mesmo dos drivers.

### Verificação ao vivo (2026-11-07)

Gravação real no Mini ERP (fatura 4321, 1250,00, Lançar, Sim) → rascunho pelo modelo padrão da empresa (DeepSeek), com
agenda `0 9 * * 1`, variáveis, Lançar/Sim pedindo aprovação e 7 perguntas → contratado em modo sombra → os ensaios
pegaram o computador emprestado (a dona permitiu no app), preencheram os campos e o "Lançar" foi simulado pela alçada;
diante de uma tela diferente da gravação, o funcionário perguntou em vez de adivinhar. Corrigido depois: os ensaios
levam os valores da gravação; o clique que fecha um diálogo ("Sim") é resolvido pelos elementos guardados quando o
diálogo apareceu; cliques nas janelas do próprio Agent Hangar não entram. Para demonstrações conduzidas por uma
ferramenta, `HANGAR_RECORD_INJECTED=1` grava também entrada sintética — só no app de desenvolvimento, nunca no instalado.
