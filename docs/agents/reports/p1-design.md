# Relatório — Fase 1, agente `design` (tema alinhado à plataforma Agent Hangar)

## O que foi feito

### 1. Tokens (`src/renderer/src/theme/tokens.json` + `src/renderer/src/styles.css`)
- **`theme/tokens.json`**: cópia dos tokens do console (`central/app/static/style.css`, `:root` e bloco
  `prefers-color-scheme: dark`) no formato do contrato (`docs/platform/app-api-phase1.md` §2 e §6):
  `{version, light, dark, fonts:{ui,sign,mono}, radius:{r,r_lg}}`, com a origem em `"$comment"` (JSON não aceita
  comentário). A `version` (`2026-10-23`, data do `style.css` do console) é provisória: troque pela versão que a
  plataforma publicar em `design-tokens.json`, que ainda não existe no repositório da plataforma.
- **`styles.css`** em duas camadas:
  1. **Tokens da plataforma**, cópia literal do JSON, com os mesmos nomes do console (`--tarmac`, `--tarmac-2`,
     `--tarmac-ink`, `--tarmac-mute`, `--panel`, `--panel-2`, `--ink`, `--mute`, `--line`, `--line-2`, `--mark`,
     `--mark-ink`, `--mark-soft`, `--go`/`--go-bg`, `--hold`/`--hold-bg`, `--stop`/`--stop-bg`, `--info`/`--info-bg`,
     `--code`/`--code-ink`, `--r`, `--r-lg`, `--f-ui`, `--f-sign`, `--f-mono`). A única exceção é o `--bg` do console,
     que aqui se chama **`--concrete`**, porque `--bg` é variável do app.
  2. **Variáveis do app**, que só apontam para os tokens. **Mantive todos os nomes antigos** (`--bg`, `--bg-elev`,
     `--bg-sunken`, `--bg-hover`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-text`, `--success`,
     `--warning`, `--danger`, `--diff-add`, `--diff-del`, `--radius`, `--radius-sm`, `--font`, `--mono`,
     `--sidebar-w`, `--topbar-h`) e acrescentei: `--accent-ink` (acento como texto/ícone; o amarelo puro tem só
     1,85:1 no branco), `--accent-hover`, `--accent-soft`, `--link`, `--text-strong`, `--border-soft`,
     `--success-bg`/`--warning-bg`/`--danger-bg`, `--notice` (info), `--on-status` (texto sobre go/stop sólidos),
     `--focus-ring`/`--focus-halo`, `--shadow-sm`/`--shadow-pop`/`--shadow-modal`, `--scrim` e `--font-sign`.
- Mapeamento das superfícies: claro `--bg` = `panel-2`, `--bg-elev` = `panel`, `--bg-sunken` = `concrete`; escuro
  `--bg` = `concrete`, `--bg-elev` = `panel`, `--bg-sunken` = `panel-2` (no escuro as superfícies clareiam conforme
  sobem, como no console). `--radius` = 10px e `--radius-sm` = 6px (raios do console).
- **Fontes empacotadas**: `@import` dos arquivos `latin-*` do `@fontsource` (Plex Sans 400/400 itálico/500/600/700,
  Plex Mono 400/500/600, Barlow Semi Condensed 500/600/700). O subconjunto latin cobre o pt-BR. Saem 11 `.woff2` no
  build e o CSP (`font-src 'self' data:`) já permitia: **não precisei mexer no `index.html`**.
- Primitivos globais: `.btn` (hover com borda tinta, como o `ghost` do console), `.btn-primary` amarelo com texto
  `--mark-ink` (8,8:1) e hover `#FFC61A`, `.input` com foco do console (borda tinta + halo `--mark-soft`), foco
  visível (`outline` 2px) em botões, links, abas, `[tabindex]` e checkboxes, checkbox com `accent-color` tarmac
  (amarelo no escuro), `::selection` amarelada e uma classe nova `.pill` / `.pill-go|hold|stop|info` (sinais do console),
  disponível para os features.
- **`.rail`** (global): a navegação "tarmac". Ela re-aponta as variáveis do app (fundo, texto, bordas, foco amarelo,
  status em versões legíveis no escuro), então qualquer conteúdo de feature dentro dela fica escuro sem saber disso,
  inclusive o indicador da plataforma que o agente client montou no rodapé da sidebar. Os módulos entram com
  `composes: rail from global` (o build gera `"_sidebar_xxx rail"`, conferido). Menus e diálogos vão por portal para
  o `<body>` e continuam com a paleta da página.

### 2. Shell e sidebar
- `shell.module.css`: sidebar = `.rail` tarmac com borda `--tarmac-2`; topbar em `--bg-elev`; título da sessão em
  Barlow 17px; os botões dos painéis viraram as abas do console (texto apagado e sublinhado de 3px `--mark` no aberto);
  o divisor do painel lateral fica amarelado no hover.
- `TopBar.tsx` (só JSX/visual): `☰` e `⚙` trocados por ícones SVG no traço do console (`shell/icons.tsx`: `SidebarIcon`,
  `GearIcon`, `HangarLogo`). Mantive os `title` (o e2e usa `getByTitle('Configurações')`) e acrescentei `aria-label`.
  Sem sessão, o título mostra a marca (logo hangar em `--accent-ink` + "Hangar").
- Lista de sessões (`sessions.module.css`): "Nova sessão" é o botão amarelo do console; busca no `tarmac-2`; títulos de
  seção em Barlow caixa-alta; item ativo com fundo `tarmac-2`, texto branco e **faixa `--mark` de 3px**; badge `wt` em
  mono; toast no padrão do console (cartão tarmac com faixa amarela, ou `--tarmac-stop` em erro); saudação da nova
  sessão em Barlow 30px; títulos de diálogo em Barlow 18px; compositor com foco do console.

### 3. Status, diffs, badges e cartões
- **Status das sessões** (sidebar e cabeçalho): trabalhando = spinner **go**, aguardando você = **hold** com halo, erro =
  **stop** com halo, não lida = **info**.
- **Diffs**: `--diff-add`/`--diff-del` = `go-bg`/`stop-bg` (chat, painel de alterações, harness, Lab).
- **Badges** viraram pills do console (fundo do sinal + texto do sinal, sem borda): Lab (`running` = info, `selecting`
  = hold, `decided` = go, `failed` = stop), Harness (added/helped/high = go, removed/hurt = stop, modified/medium/
  confounded = hold), Configurações e onboarding (pill neutra).
- **Cartões**: pedido de permissão/pergunta e proposta do Harness = cartão "hero" do console (borda `--mark` + faixa
  amarela de 4px à esquerda); erros = `stop-bg` com borda stop; avisos = `go-bg`/`hold-bg`; ferramenta com falha ganha
  faixa stop; mensagem do usuário no chat = `info-bg` (como a conversa de tarefas do console); seleções ativas
  (arquivo no git, item do Harness, artifact, item do Motion, candidato do Lab, opção de pergunta) = `--accent-soft`
  + faixa `--mark`.
- Configurações: lista de seções vira `.rail` (título "Configurações" em Barlow, item ativo com a faixa de 4px do
  console), títulos de página e de cartão em Barlow, segmentado ativo amarelo, switch amarelo com botão tinta.
- Lab: lista de rodadas vira `.rail`, títulos em Barlow, linha vencedora com faixa go. Onboarding: marca e títulos
  em Barlow, passo atual amarelo, passos concluídos em go.

### 4. Varredura dos `*.module.css`
- Todos os módulos (exceto `features/platform/**`, como pedido): **nenhum `color: var(--accent)` restante**; acento
  como texto/ícone virou `--accent-ink`, links viraram `--link`, spinners usam `--accent-ink`, sombras viraram
  `--shadow-*`, fundos de modal viraram `--scrim`, `#fff` sobre status virou `--on-status`.
- Cores fixas que ficaram, de propósito: `#fff` no fundo do `<webview>`/`<iframe>` do navegador e dos artifacts
  (páginas web esperam branco), `#000` no letterbox do player Motion em tela cheia (comentado) e o anel branco
  translúcido do contorno de edição no canvas do Motion (precisa contrastar com qualquer cor do vídeo).
- O laranja `#c96442` não existe mais em CSS. Ele continua em **TS** (fora do meu escopo, veja "Pedidos").

### 5. Contraste (WCAG, calculado)
| Par | Razão |
|---|---|
| `--mark-ink` sobre `--mark` (botão primário) | 8,82 |
| `--mark-ink` sobre `#FFC61A` (hover) | 10,34 |
| `--accent-ink` claro `#8A5A00` sobre branco / `concrete` / `mark-soft` | 5,93 / 5,10 / 5,26 |
| `--mark` (acento-texto no escuro) sobre `panel` / `concrete` | 8,89 / 9,93 |
| `tarmac-ink` sobre `tarmac` / `tarmac-2` | 10,04 / 8,56 |
| `tarmac-mute` do console sobre `tarmac-2` (linha ativa) | **4,22** → troquei por `--tarmac-mute-aa` `#9AA6B3`: 5,33 |
| `--mark` sobre `tarmac` (faixa, foco) | 8,38 |
| `--mute` sobre `panel-2` / `concrete` | 5,88 / 5,42 |
| branco sobre `go` / `stop` (claro); `#10151C` sobre `go` / `stop` (escuro) | 5,02 / 5,73; 8,56 / 6,73 |
| `go` sobre `go-bg` (pill, valor do console) | 4,32 (abaixo de 4,5; igual ao console) |

## Verificação
- `npm run format:check`: meus arquivos passam. Avisos só em `docs/platform/app-api-phase1.md` (do chief) e
  `tests/mock-platform/server.ts` (agente client).
- `npm run lint`: 1 erro e 105 avisos, **todos** em `tests/mock-platform/**`/`features/platform/**` (agente client,
  em andamento). `eslint` nos meus TSX (`shell/*`) passa limpo.
- `npm run typecheck`: sem erros.
- `npm test`: 8 arquivos, 111 testes, todos passando.
- `npm run build`: ok.
- `npm run test:e2e`: **8 passaram, 1 falhou** — `panels.spec.ts › teste de conexão… 401`: `getByTitle('Configurações')`
  agora casa com dois botões, porque o indicador da plataforma (agente client) tem
  `title="Plataforma Agent Hangar — abrir Configurações → Plataforma"`. Não é do tema; correção sugerida em "Pedidos".
- Sincronia tokens ↔ CSS: rodei o script de checagem (o mesmo do teste proposto abaixo): "tokens.json and styles.css
  agree".
- **Capturas** (claro e escuro, 1440×900, Playwright + Electron com o servidor Anthropic falso, perfil isolado), em
  `C:\Users\valteresj\AppData\Local\Temp\claude\C--Users-valteresj-OneDrive-Documentos-Harness-hangar\1fc350b4-0f17-434b-8001-f31cbe9eec84\scratchpad\shots\out\`:
  `{light,dark}-01-onboarding.png`, `-02-nova-sessao.png`, `-03-chat-permissao.png`, `-04-chat-ferramentas.png`,
  `-05-painel-alteracoes.png`, `-06-painel-harness.png`, `-07-motion.png`, `-08-lab.png`, `-09-lab-nova-rodada.png`,
  `-10-configuracoes.png`. O roteiro está em `...\scratchpad\shots\shots.spec.ts`. Electron encerrado ao fim de cada
  tour.

## Como testar
1. `npm run dev`, alternar Configurações → Geral → Tema entre Claro e Escuro.
2. Conferir: sidebar tarmac com "Nova sessão" amarelo e faixa amarela no item ativo; abas da topbar sublinhadas em
   amarelo; status das sessões (spinner verde, âmbar com halo aguardando, vermelho em erro, azul não lida); cartão de
   permissão com faixa amarela; diffs verde/vermelho; Configurações e Lab com lista lateral tarmac.
3. Navegar só com Tab: todo botão mostra contorno (tinta no claro, amarelo dentro do rail).

## Pedidos ao chief
1. **Teste de sincronia dos tokens** (eu não posso criar arquivo em `tests/`). Sugestão, `tests/unit/design-tokens.test.ts`:
   ```ts
   import { readFileSync } from 'node:fs'
   import { describe, expect, it } from 'vitest'

   const root = new URL('../../src/renderer/src/', import.meta.url)
   const tokens = JSON.parse(readFileSync(new URL('theme/tokens.json', root), 'utf8'))
   const css = readFileSync(new URL('styles.css', root), 'utf8')
   const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('\n}', css.indexOf(`${sel} {`)))
   const decls = (t: string) =>
     Object.fromEntries([...t.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]))
   const norm = (v = '') => v.toLowerCase().replace(/'/g, '"').replace(/\s+/g, ' ')
   const light = decls(block(':root'))
   const dark = { ...light, ...decls(block(":root[data-theme='dark']")) }
   const cssName = (k: string) => (k === 'bg' ? '--concrete' : `--${k}`)

   describe('design tokens', () => {
     for (const [theme, vals] of [['light', light], ['dark', dark]] as const)
       it(`styles.css repeats tokens.json (${theme})`, () => {
         for (const [k, v] of Object.entries(tokens[theme] as Record<string, string>))
           expect(norm(vals[cssName(k)]), k).toBe(norm(v))
       })
     it('fonts and radii', () => {
       for (const [k, v] of Object.entries(tokens.fonts as Record<string, string>))
         expect(norm(light[`--f-${k}`]), k).toBe(norm(v))
       expect([light['--r'], light['--r-lg']]).toEqual([tokens.radius.r, tokens.radius.r_lg])
     })
   })
   ```
2. **e2e quebrado pelo indicador da plataforma**: em `tests/e2e/panels.spec.ts:62` usar
   `page.getByTitle('Configurações', { exact: true })`, ou o agente client tirar "Configurações" do `title` do indicador.
3. **Cores em TS** (lógica, fora do meu escopo), para os donos dos features:
   - `features/terminal/theme.ts`: o cursor usa `--accent`, que agora é amarelo e some no fundo claro (1,6:1). Use
     `--accent-ink` para `cursor` (e talvez para `selectionBackground`). O fallback `#c96442` e os fundos de fallback
     podem virar os novos valores. A fonte do xterm agora é IBM Plex Mono (via `--mono`): se o xterm medir antes de a
     fonte carregar, os glifos podem desalinhar; um `await document.fonts.ready` antes do primeiro `fit()` resolve.
   - `motion/runtime.ts` (`PALETTE`), `preview/motion/Editor.tsx` (`fill: '#c96442'`, `#1f1e1d`) e
     `ElementForm.tsx` (cor padrão `#c96442`): paleta padrão dos vídeos novos ainda no laranja antigo. Sugestão:
     `#F4B400`, `#2B5BA8`, `#1E7F46`, `#9A5B00`, `#BD3326`, `#1C2530`, e texto `#17212C`.
   - `git/FilesPanel.tsx`: cores por extensão de arquivo (independem do tema; podem ficar).
4. **Ícones emoji** dentro de features (`🎬` no `MotionCard`, `⚠`/`⛔` no `ProviderErrorCard`, `⌂` no indicador da
   plataforma, ícones das sugestões do chat): o console usa um conjunto SVG único (traço 1,75). Trocar exige mexer em
   TSX dos features; `shell/icons.tsx` pode servir de base.

## O que ficou faltando / riscos conhecidos
- Não abri o console em `http://localhost:8090/ui` no navegador (ele pede login); trabalhei pelo `style.css`,
  `icons.js` e pelo resumo do briefing.
- `go` sobre `go-bg` fica em 4,32:1, valor herdado do console. Se quiser AA estrito nas pills verdes, a plataforma
  precisa escurecer o `--go` claro (por exemplo `#176B3A`, 5,65:1).
- A sidebar escura também vale no tema claro (é o padrão do console). Componentes de outros features montados dentro
  dela herdam a paleta do rail; quem usar cores fixas lá dentro precisa usar as variáveis.
- `styles.css` é importado depois dos módulos (ordem do `main.tsx`), então regras globais de mesma especificidade
  vencem as dos módulos. Evitei regras globais novas que disputem com módulos (o foco visível só pega botões, links,
  abas e afins, não campos de texto).
- O `version` do `tokens.json` é provisório até a plataforma publicar o `design-tokens.json` dela.
