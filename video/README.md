# Vídeo do produto — Agent Hangar Desktop

Vídeo de 60 a 80 s, em pt-BR e 1920×1080, que apresenta o app: instalação, sessão com ferramentas e permissão,
painéis, qualquer modelo (com a medição da camada de compatibilidade), criação de agente pela plataforma, "Meus
agentes", uso de qualquer lugar, recursos corporativos e encerramento com a marca. As cores e os traços seguem a
identidade Agent Hangar (azul-marinho e amarelo `#F4B400`).

## Como é feito

| Arquivo                    | O que é                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `script.json`              | Cenas, na ordem, com a narração de cada uma (voz, modelo e instruções de locução no topo)  |
| `index.html` + `scenes.js` | As cenas como página. `renderAt(t)` desenha qualquer instante sempre igual                 |
| `shots.spec.ts`            | Captura as telas reais do app contra os servidores falsos dos testes (nada real é chamado) |
| `tts.py` / `tts.mjs`       | Geram a narração pelo OpenRouter (`google/gemini-3.8-flash-lite-tts`, voz Orus)            |
| `narration/`               | As falas geradas, uma por cena (`<cena>.wav`)                                              |
| `render.cjs`               | Grava os quadros pelo Electron, codifica com ffmpeg e mistura narração e trilha            |
| `assets/`                  | Artes da marca usadas em algumas cenas                                                     |
| `shots/`                   | Telas do app, geradas por `shots.spec.ts`                                                  |

A duração de cada cena acompanha a narração: é o maior valor entre `minDuration` e a fala mais 1,1 s. Assim a voz
nunca é cortada, e para mudar o texto basta editar `script.json` e gerar de novo.

## Passo a passo (na pasta `hangar`)

1. Telas do app, só quando a interface mudar. Gere o build do app antes:

   ```bash
   npx electron-vite build
   ```

   Depois capture as telas:

   ```bash
   npx playwright test -c video
   ```

2. Narração, só quando o texto do `script.json` mudar. O script pede a chave do OpenRouter com entrada oculta (ou a
   lê de `OPENROUTER_API_KEY`); ela vai apenas para o openrouter.ai e não é gravada em lugar nenhum:

   ```bash
   python video/tts.py
   ```

   Para refazer só algumas falas: `python video/tts.py --only logo,close`. A versão em Node (`node video/tts.mjs`) faz
   o mesmo, mas lê a chave só do ambiente.

3. Vídeo. O resultado sai em `video/out/agent-hangar-desktop.mp4`:

   ```bash
   npx electron video/render.cjs
   ```

   Para conferir só alguns instantes, gere quadros soltos em `video/out/stills/`:

   ```bash
   npx electron video/render.cjs --stills 3,12,40
   ```

Requer ffmpeg e ffprobe no PATH.

## Fatos usados no vídeo

- **0% → 98,7%:** bancada interna (`docs/COMPAT.md`), com 5 modelos × 8 tarefas de código via LiteLLM → OpenRouter.
  Sem a camada foram 0 de 75 tarefas; com ela, 74 de 75.
- **Criação de agente:** as ferramentas mostradas (`plan_agent`, `compose_agent`, `schedule_agent`) são as do MCP
  da plataforma Agent Hangar. A conversa da cena é uma recriação no estilo do app.
- **"Meus agentes":** tela real do app, conectada à plataforma falsa dos testes (dados de exemplo da Acme).
