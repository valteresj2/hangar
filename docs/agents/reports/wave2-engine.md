# Relatório — engine, segunda onda (colar imagem, @menção, rewind/fork)

## O que foi feito

### 1. Colar imagem
- **Composer**: Ctrl+V com imagem anexa a imagem. Texto colado continua normal: só impedimos o paste padrão quando a
  área de transferência não tem texto. Arrastar e soltar uma imagem sem caminho (ex.: vinda do navegador) também anexa;
  arquivos com caminho continuam indo como anexo, como antes. As miniaturas ficam acima do textarea, removíveis (×).
- `pasted.ts`: imagens acima de 5 MB, ou em formato fora de png/jpeg/gif/webp, são redimensionadas e recomprimidas no
  canvas para JPEG (lado máximo de 2048 px, reduzindo até caber). Testado: um PNG de 34,5 MB virou um JPEG de 2,2 MB.
- **Envio**: as imagens vão como blocos `image` (base64 + `media_type`) no `message.content` do `SDKUserMessage`, pelo
  modo de streaming.
- **Main** (`images.ts`): grava cada imagem em `<userData>/hangar-data/engine/images/<sessionId>/<uuid>.<ext>`. A
  extensão segue o tipo real (png/jpg/gif/webp) em vez de sempre `.png`, para o arquivo não mentir sobre o formato.
  A entrada `user` da transcrição guarda os caminhos (`images`). O balão mostra as miniaturas (IPC `engine:readImage`,
  que só lê dentro da pasta de imagens), e clicar abre a imagem ampliada.

### 2. @menção de arquivo
- IPC `engine:listFiles(sessionId, query)` → até 50 caminhos relativos (`files.ts`).
  - Em repositório git (`isGitRepo` de `git/api.ts`): `git ls-files --cached --others --exclude-standard`.
  - Fora de git: varredura de até 5.000 arquivos, ignorando `node_modules`, `.git`, `dist` e `out`.
  - Cache por sessão (60 s), invalidado em `session:file-written` e quando a sessão é excluída.
  - Busca fuzzy por subsequência, priorizando trechos contínuos, início de palavra e nome do arquivo.
- No composer, `@` abre o autocomplete na posição do cursor. Setas navegam, Enter/Tab inserem `@caminho/relativo`
  (com aspas se o caminho tiver espaço) e Esc fecha. O texto enviado mantém o `@caminho`, que o Claude Code expande
  sozinho: no teste ele leu o arquivo sem chamar ferramenta nenhuma. No balão, a menção aparece destacada.

### 3. Rewind e fork
Ao passar o mouse sobre uma mensagem do usuário aparecem **"✎ Editar e reenviar daqui"** e **"⑂ Bifurcar daqui"**.
As duas ficam desabilitadas enquanto o Claude trabalha.

- **Âncora**: cada prompt agora sai com um `uuid` nosso no `SDKUserMessage`, gravado na transcrição (`sdkUuid`). Testei
  que esse UUID vira o id da mensagem na cadeia da sessão do CLI. Transcrições antigas, sem `sdkUuid`, caem num
  casamento por posição com `getSessionMessages`.
- **Rewind** (`branch.ts`):
  - Antes de confirmar, um painel mostra quantos arquivos seriam restaurados: `rewindFiles(uuid, { dryRun: true })`,
    usando os checkpoints do SDK.
  - Na confirmação, restaura os arquivos se a opção estiver marcada (`rewindFiles`), trunca o JSONL do Hangar no ponto,
    fecha o runner e grava o "ponto de rewind" (a entrada anterior da cadeia) em `engine/rewind-points.json`.
  - A próxima query sobe com `resume` + `resumeSessionAt`. Quando o replay confirma que a nova mensagem entrou nesse
    ramo, o ponto é apagado e os resumes seguintes voltam ao normal. O ponto sobrevive a reinícios do app.
  - O texto, os anexos e as imagens da mensagem removida voltam para o composer.
  - Se o ponto é a primeira mensagem, a conversa simplesmente recomeça do zero (`sdkSessionId` limpo).
- **Checkpoints**: toda query agora roda com `enableFileCheckpointing: true` e `extraArgs: { 'replay-user-messages': null }`.
  Sessões criadas antes desta onda não têm checkpoints; nelas o painel avisa que os arquivos não podem ser desfeitos.
  O painel também avisa que comandos Bash/PowerShell e edições de subagentes nunca são desfeitos (limitação documentada
  do SDK).
- **Fork**:
  - `forkSession(sdkSessionId, { upToMessageId })` copia a sessão do CLI até a última entrada da rodada daquela mensagem
    (a mensagem e a resposta dela entram na bifurcação).
  - Cria a nova sessão em `db('sessions')`: mesmo cwd/worktree, modelo, esforço e modo; título "<título> (bifurcação)".
  - Copia a transcrição até esse ponto, remapeando os `sdkUuid` para os UUIDs novos que o `forkSession` gera, e emite
    `engine:event:select`, que o ChatView trata com `useUi().selectSession`. A original fica intacta.
- Novos IPC/eventos: `engine:rewindPreview`, `engine:rewind`, `engine:fork`, `engine:event:reset` (o renderer recarrega
  a transcrição) e `engine:event:select`.

Nada de API inventada: `uuid` em `SDKUserMessage`, `resumeSessionAt`, `forkSession()`, `getSessionMessages()`,
`enableFileCheckpointing`, `rewindFiles()` e `replay-user-messages` estão no `sdk.d.ts` 0.3.310 e nas páginas
"Sessions" e "File checkpointing" da documentação. Antes da UI, validei cada um num script Node contra o
`claude.exe` 2.1.307.

## Como foi testado (app real)
Build numa cópia isolada no scratchpad, com `--user-data-dir` próprio e porta de depuração 19841, dirigido por CDP.
Sessão Haiku numa pasta temporária fora do repo:
1. `@mat` → o autocomplete listou `src/lib/matematica.ts` (sem `node_modules`). Tab inseriu a menção. Colei uma imagem
   (evento paste com PNG vermelho "HANGAR"). O Claude descreveu a função lida via menção e a imagem ("fundo vermelho,
   texto HANGAR em branco"). A miniatura apareceu no balão, carregada do arquivo salvo.
2. Pedi um Edit que adicionou `subtracao()` e depois "lembre LARANJA". Em "Editar e reenviar" na mensagem do Edit, o
   painel mostrou "1 arquivo (+0 −4)". Confirmei: o arquivo voltou ao original, a transcrição ficou só com a 1ª rodada,
   o texto voltou ao composer e apareceu o aviso "Arquivos restaurados". Reenviei editado: o Claude listou só a 1ª
   mensagem e disse que eu não pedi para lembrar palavra nenhuma. `rewind-points.json` ficou vazio depois do replay.
3. "Bifurcar daqui" na 1ª mensagem: a nova sessão "(bifurcação)" foi criada e selecionada sozinha, com a 1ª rodada. Lá,
   o Claude conhecia só a 1ª mensagem e a imagem. A original seguiu com as 2 mensagens. O preview de rewind dentro da
   bifurcação também funciona (os UUIDs foram remapeados).
4. Pasta com `git init` e `.gitignore` contendo `docs/`: `listFiles` veio pelo git e omitiu `docs/`.
5. Soltei um PNG de 34,5 MB sem caminho: virou uma miniatura JPEG de cerca de 2,2 MB.

`npm run typecheck` e `npm run build` passam na árvore real. Durante o trabalho, o build compartilhado chegou a quebrar
por um arquivo ainda inexistente no feature settings (`./quickEntry`); por isso testei na cópia isolada, com o settings
do último commit. No fim, o settings concluiu e o build real passou.

## O que ficou faltando / limitações
- Restaurar arquivos só funciona para edições feitas com Write/Edit/NotebookEdit na conversa principal, em sessões
  iniciadas a partir desta versão. Bash/PowerShell e subagentes não são desfeitos (limite do SDK; o painel avisa).
- A bifurcação começa sem histórico de desfazer: o `forkSession` não copia os snapshots de arquivos, então um rewind
  dentro dela para um ponto anterior à bifurcação volta a conversa, mas não restaura arquivos.
- Fork e rewind ficam desabilitados enquanto há geração em andamento: é preciso parar antes.
- Imagens e transcrições de sessões excluídas continuam em disco (como na onda 1); a bifurcação referencia as imagens
  da sessão de origem.
- Em repositório git, arquivos não rastreados e não ignorados (ex.: um `node_modules` sem `.gitignore`) aparecem na
  @menção, porque é isso que o `git ls-files --others --exclude-standard` retorna.

## Pedidos ao chief
1. `src/main/core/bus.ts`: nenhum evento novo de bus. Os novos são só IPC do engine (`engine:event:reset`,
   `engine:event:select`), declarados em `src/shared/features/engine.ts`.
2. Nenhuma dependência nova.
3. A bifurcação herda o `worktree` da sessão de origem. Se o "Excluir" do sessions remover o worktree de uma das duas,
   a outra fica sem pasta. Sugestão: o sessions só oferecer remover o worktree quando nenhuma outra sessão o usar.

## Riscos conhecidos
- O casamento por posição (transcrições antigas sem `sdkUuid`) pode errar se o histórico do CLI tiver prompts que o
  Hangar não registrou. Nesse caso o rewind/fork acaba recusado ou ancorado na mensagem errada; com `sdkUuid`
  (todas as mensagens novas) é exato.
- Até o primeiro reenvio depois de um rewind, a sessão do CLI ainda tem o ramo antigo no arquivo; o Hangar retoma pelo
  ponto salvo. Se alguém retomar essa sessão por fora (no `claude` CLI) antes disso, vai ver o ramo antigo.
- Testes: as sessões de teste criadas em `~/.claude/projects` e a cópia isolada no scratchpad foram removidas; nenhum
  arquivo fora das minhas pastas foi alterado.
