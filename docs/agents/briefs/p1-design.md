# Fase 1 (app): design alinhado à plataforma Agent Hangar

Regras de `docs/agents/RULES.md`. **Exceção desta missão:** você pode editar `src/renderer/src/styles.css`,
`src/renderer/src/shell/**`, `src/renderer/index.html` (CSP de fontes, se precisar) e **qualquer `*.module.css`** dos
features — só aparência (cores, tipografia, espaçamento, raios, ícones), sem mudar comportamento. Não toque em
`src/renderer/src/features/platform/**` (o agente **client** está criando esse feature em paralelo) nem em TS/TSX de
lógica; JSX só onde for preciso para aplicar uma classe. Fontes já instaladas: `@fontsource/ibm-plex-sans`,
`@fontsource/ibm-plex-mono`, `@fontsource/barlow-semi-condensed` (empacotadas — nada de Google Fonts). Sem `npm install`.

## Referência

O console da plataforma: `C:\Users\valteresj\OneDrive\Documentos\central_agents\central\app\static\style.css`
(tokens em `:root` e no bloco `prefers-color-scheme: dark`), `index.html`, `icons.js` e as telas em `member.js`/
`app.js`. Abra o console de verdade para ver os padrões (**só leitura**, não altere nada lá):
`http://localhost:8090/ui` no navegador embutido do seu ambiente, se disponível, ou leia o CSS/JS.
Resumo: navegação "tarmac" escura (`#1C2530`/`#26313E`, texto `#C9D1DB`, apagado `#8793A1`), destaque "mark"
`#F4B400` com texto `#17212C` (suave `#FDF1CC`), status go/hold/stop/info com fundos próprios, superfícies
`#ECEEF1`/`#FFFFFF`/`#F6F7F9`, linhas `#D5DAE0`/`#E6E9ED`, tinta `#17212C`/`#56616E`, escuro com os valores do bloco
dark; IBM Plex Sans (UI), IBM Plex Mono (código), Barlow Semi Condensed (títulos tipo placa); raios 6px/10px.

## Entregas

1. `src/renderer/src/theme/tokens.json` — cópia dos tokens da plataforma (claro/escuro, fontes, raios) com um
   comentário de origem; `styles.css` passa a derivar as variáveis do app (`--bg`, `--text`, `--accent`, …) desses
   tokens. Mantenha os **nomes** das variáveis atuais (os features dependem deles) e acrescente as novas
   (`--tarmac`, `--mark`, `--go`, `--hold`, `--stop`, `--info` e fundos).
2. Shell e sidebar no estilo do console: barra lateral tarmac, item ativo marcado com `--mark`, títulos em Barlow,
   botão primário amarelo com texto escuro (contraste AA), foco visível.
3. Status das sessões com as cores go/hold/stop; diffs com os fundos go/stop; badges e cartões no padrão do console.
4. Varra todos os `*.module.css` trocando cores fixas (ex.: o laranja `#c96442`) por variáveis.
5. Claro e escuro corretos; confira contraste dos textos sobre amarelo e sobre tarmac.
6. Verificação: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`; e
   capturas de tela (claro e escuro) das telas principais (onboarding, chat com ferramentas, painel lateral,
   configurações, Lab, Motion) salvas no scratchpad, citadas no relatório.

Relatório em `docs/agents/reports/p1-design.md`; responda só `PRONTO: p1-design`.
