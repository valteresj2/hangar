# Segunda onda: engine (colar imagem, @menção, rewind/fork)

As regras de `docs/agents/RULES.md` continuam valendo. Suas pastas são as mesmas da primeira onda.
O core mudou um pouco (veja `git log -1 -p -- src/main/core src/shared/contracts.ts`), sem impacto direto em você.

## 1. Colar imagem no composer

- Ctrl+V com imagem na área de transferência (e arrastar-soltar de imagem sem caminho) anexa a imagem.
  Mostre miniaturas removíveis acima do textarea.
- Envie ao Claude como bloco de imagem (base64 + media type) na mensagem do usuário pelo modo de streaming do SDK.
  Confira no `.d.ts` o formato de `SDKUserMessage`. Limite de 5 MB por imagem; redimensione/recomprima no renderer
  (canvas) se passar disso.
- Persista na transcrição uma referência (arquivo salvo em `<userData>/hangar-data/engine/images/<sessionId>/<id>.png`)
  e renderize a miniatura no balão do usuário.

## 2. @menção de arquivo

- Ao digitar `@` no composer, abra um autocomplete de arquivos do diretório de trabalho da sessão
  (`session.worktree?.path ?? session.cwd`): busca fuzzy, setas, Enter/Tab insere `@caminho/relativo`.
- Liste os arquivos no main com `git ls-files --cached --others --exclude-standard` quando for repo
  (use `isGitRepo` de `src/main/features/git/api.ts`); fora de repo, varra até 5.000 arquivos ignorando
  `node_modules`, `.git`, `dist`, `out`. Cache por sessão com invalidação em `session:file-written`.
  IPC novo: `engine:listFiles` (sessionId, query) → até 50 resultados.
- Mantenha o `@caminho` no texto enviado (o Claude Code entende menções) e mostre-o destacado no balão.

## 3. Rewind e fork

- Em cada mensagem do usuário na transcrição, ao passar o mouse, mostre ações:
  - **Editar e reenviar a partir daqui (rewind)**: descarta tudo depois dessa mensagem e recomeça a conversa nesse ponto.
  - **Bifurcar daqui (fork)**: cria uma nova sessão com o histórico até essa mensagem, deixando a original intacta.
- Implemente com o que o SDK oferece para retomar num ponto e bifurcar (procure no `.d.ts` e na documentação:
  opções como `resumeSessionAt`, `forkSession` e o UUID das mensagens). Não invente API: se algo não existir,
  diga isso no relatório e use a melhor alternativa documentada.
- Rewind: trunque a transcrição JSONL do Hangar no ponto escolhido, reinicie o runner da sessão no ponto do SDK
  e coloque o texto da mensagem no composer para editar.
  Se o SDK permitir, ofereça também desfazer as mudanças em arquivos feitas depois do ponto (checkpoints); se não, avise.
- Fork: crie a nova sessão em `db('sessions')` (mesmo cwd/modelo/modo, título "<título> (bifurcação)"), copie a
  transcrição até o ponto, configure o resume bifurcado e selecione a nova sessão (evento `engine:event:select`, que o
  renderer trata chamando `useUi().selectSession`).

## Pronto quando

Os três funcionam no app real (teste com Haiku num diretório temporário fora do repo, `--user-data-dir` isolado e uma
porta de depuração livre, diferente de 9333 e 19888). Relatório em `docs/agents/reports/wave2-engine.md`;
responda só `PRONTO: wave2-engine`.
