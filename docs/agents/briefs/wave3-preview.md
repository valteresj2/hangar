# Terceira onda: preview (Hangar Motion — player, editor e exportação MP4)

As regras de `docs/agents/RULES.md` continuam valendo. Suas pastas são as mesmas da primeira onda.

## Contexto

Hangar Motion é a nossa versão do Claude Motion: animações curtas descritas em `*.motion.json`, desenhadas por código.
O chief já entregou a base (commit mais recente; leia com `git log -1 -p`):
- `src/shared/motion/spec.ts` — formato, `parseMotion`, `totalDuration`, `sceneAt`, `sceneStart`, `MOTION_EXTENSION`,
  `OPEN_ARTIFACT_EVENT`.
- `src/renderer/src/motion/runtime.ts` — `drawFrame(ctx, spec, time, assets)` determinístico, `elementState`,
  `imageSources`, `loadMotionAssets(spec, resolve)`. **Não reimplemente o desenho**: use o runtime. Se achar bug no
  runtime ou precisar de algo nele, descreva em "Pedidos ao chief" (pode contornar localmente).
- `src/shared/motion/guide.ts` — o guia que o Claude recebe (para você entender o formato).
- `docs/motion/example.motion.json` — exemplo de 12 s com todos os tipos de elemento.
- Dependência instalada para você: `mediabunny` (muxer MP4; leia os tipos em `node_modules/mediabunny`).

## O que construir

1. **Detecção**: `*.motion.json` escrito pelo agente (`session:file-written`) vira artifact do tipo `motion`
   (antes da regra genérica de `.json`, se houver). "Abrir arquivo como artifact" também aceita `.motion.json`.
   Escute o evento DOM `OPEN_ARTIFACT_EVENT` no `ArtifactsPanel` e selecione o artifact do `detail.path`
   (adicionando-o se ainda não estiver na lista).
2. **Player** (visualizador do artifact motion): canvas responsivo com a proporção do spec; play/pause (Espaço), loop,
   barra de tempo com arraste, marcadores de cena clicáveis, tempo atual/total, velocidade (0,5×/1×/2×), tela cheia.
   Use `requestAnimationFrame` e `drawFrame`. Recarregue sozinho quando o arquivo mudar no disco (o agente pode editá-lo);
   mantenha o tempo atual. Se `parseMotion` falhar, mostre os erros em vez do canvas.
3. **Imagens**: resolva `src` relativo à pasta do `.motion.json` (absoluto e `data:` também), carregando pelo servidor
   de artifacts que você já tem, ou por IPC como data URL. Passe o resolvedor para `loadMotionAssets`.
4. **Editor embutido** (alternância "Editar" no player): lista de cenas (renomear, duração, fundo, transição, reordenar,
   duplicar, excluir), lista de elementos da cena e formulário do elemento selecionado (texto, números, cores com
   seletor, fonte, tamanho, x/y, start/end, enter/exit com tipo/duração/easing; para gráficos, edição de rótulos e
   valores em tabela; contador: de/até/prefixo/sufixo). Clique no canvas seleciona o elemento sob o cursor (use
   `elementState` e o tamanho aproximado) e permite arrastar para mover x/y. A pré-visualização atualiza ao vivo.
   Salvar grava o JSON (2 espaços) por IPC, **preservando os `id`s**; desfazer/refazer em memória (Ctrl+Z/Ctrl+Y).
   Se o arquivo mudar no disco com edições não salvas, pergunte se recarrega.
5. **Exportar MP4**: botão "Exportar MP4" → diálogo de salvar (`.mp4`, nome a partir do título) → renderiza quadro a
   quadro num `OffscreenCanvas` do tamanho do spec com `drawFrame` (tempo = i / fps), codifica com `VideoEncoder`
   (H.264/AVC, ex.: `avc1.640028`; confira `VideoEncoder.isConfigSupported`, com bitrate proporcional à resolução)
   e multiplexa em MP4 com `mediabunny`. Barra de progresso com cancelar; no fim, "Mostrar na pasta". Se H.264 não for
   suportado, diga claramente (não grave outro formato com extensão .mp4). Sem áudio.
   IPC no main para gravar o arquivo (receba os bytes em partes ou um `Uint8Array` final).
6. **Novo Motion**: botão no `ArtifactsPanel` que abre um pequeno formulário (descrição, público, duração aproximada,
   proporção 16:9/9:16/1:1) e envia para a sessão atual com `engine:send(session.id, texto, { output: 'motion' })`
   (o engine trata `output: 'motion'` nesta onda).

## Pronto quando

O `docs/motion/example.motion.json` (copie para uma pasta temporária) toca no player, o editor muda um texto e um valor
do gráfico e salva, e o MP4 exportado existe e abre (confira a duração e as dimensões lendo o arquivo com `mediabunny`
ou `ffprobe`, se houver). Teste com `--user-data-dir` isolado e uma porta de depuração livre (não use 9333, 19888-19892).
Relatório em `docs/agents/reports/wave3-preview.md`; responda só `PRONTO: wave3-preview`.
