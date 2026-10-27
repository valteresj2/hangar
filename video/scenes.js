// The scenes of the product video. Each scene builds its DOM once and positions it from its local time `u` (seconds)
// in update(u, d), so window.renderAt(t) draws any instant the same way every time (render.cjs captures each frame).
// Scene lengths come from the narration (render.cjs → window.setDurations); defaults below are for previewing.
/* global document, window, requestAnimationFrame, location */
;(() => {
  const W = 1920
  const H = 1080
  const MARK = 'M232 760 V462 L512 300 L792 462 V760 H694 V530 H330 V760 Z'
  const FADE = 0.35 // half of the crossfade between scenes

  // ---- helpers ----
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
  const ease = {
    linear: (t) => t,
    out: (t) => 1 - Math.pow(1 - t, 3),
    in: (t) => t * t * t,
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    back: (t) => {
      const c1 = 1.5
      const c3 = c1 + 1
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
    }
  }
  const p = (u, t0, t1, e = ease.out) => e(clamp((u - t0) / (t1 - t0)))
  const lerp = (a, b, k) => a + (b - a) * k

  function add(parent, html, cls = '') {
    const e = document.createElement('div')
    e.className = `abs ${cls}`
    e.innerHTML = html
    parent.appendChild(e)
    return e
  }
  /** Places an element by its centre (anchor 'c') or top-left corner ('tl'). */
  function put(e, { x = 0, y = 0, s = 1, r = 0, o = 1, a = 'c' }) {
    const shift = a === 'c' ? 'translate(-50%, -50%) ' : ''
    e.style.transform = `translate(${x}px, ${y}px) ${shift}scale(${s}) rotate(${r}deg)`
    e.style.opacity = String(clamp(o))
  }
  /** Standard entrance: fades in while rising `dy` px, from t0 over `dur` seconds. */
  const rise = (u, t0, dur = 0.7, dy = 40) => {
    const k = p(u, t0, t0 + dur)
    return { o: k, dy: (1 - k) * dy }
  }
  const markSvg = (size, stroke = 46, extra = '') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" ${extra}><path d="${MARK}" pathLength="1"
      fill="none" stroke="#F4B400" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"
      stroke-dasharray="1" stroke-dashoffset="0"/></svg>`
  const titleHtml = (t) => `<div class="title">${t}</div>`
  /** A crop of an image, `box` = [x, y, w, h] in image pixels, shown at width `w` (height follows the box ratio). */
  function cropped(parent, src, box, w) {
    const k = w / box[2]
    const e = add(
      parent,
      `<img src="${src}" style="width:${1536 * k}px;left:${-box[0] * k}px;top:${-box[1] * k}px">`,
      'crop'
    )
    e.style.width = `${w}px`
    e.style.height = `${box[3] * k}px`
    return e
  }

  // ---- scenes ----
  const scenes = []
  const scene = (id, build, update) => scenes.push({ id, build, update })

  scene(
    'scatter',
    (root) => {
      const kinds = [
        ['chat', '#8b7cf6'],
        ['terminal', '#3fc7a8'],
        ['IDE', '#4f8ff7'],
        ['planilha', '#3fbf6f'],
        ['e-mail', '#f07178'],
        ['slack', '#e0a23a'],
        ['notebook', '#c792ea'],
        ['browser', '#5ccfe6'],
        ['api', '#9aa5b5']
      ]
      const cards = kinds.map(([label, color], i) => {
        const angle = (i / kinds.length) * Math.PI * 2 + 0.4
        const radius = i % 2 ? 660 : 520
        const c = add(
          root,
          `<div class="card"><div class="dot" style="background:${color}"></div><div class="label">${label}</div>
           <div class="bar" style="width:70%"></div><div class="bar" style="width:46%;background:${color}55"></div></div>`
        )
        return {
          c,
          x: W / 2 + Math.cos(angle) * radius * 1.25,
          y: H / 2 + Math.sin(angle) * radius * 0.62,
          r: (i % 3) * 7 - 7,
          phase: i
        }
      })
      const title = add(root, titleHtml('Seus agentes estão <em>em todo lugar</em>.'))
      return { cards, title }
    },
    (u, d, { cards, title }) => {
      const gather = p(u, d - 1.3, d + 0.3, ease.in)
      for (const k of cards) {
        const appear = p(u, 0.1 + k.phase * 0.08, 0.9 + k.phase * 0.08, ease.back)
        const fx = Math.sin(u * 0.9 + k.phase) * 14
        const fy = Math.cos(u * 0.7 + k.phase * 1.3) * 12
        put(k.c, {
          x: lerp(k.x + fx, W / 2, gather),
          y: lerp(k.y + fy, H / 2 + 80, gather),
          s: lerp(0.6 + 0.4 * appear, 0.15, gather),
          r: lerp(k.r + Math.sin(u + k.phase) * 2, 0, gather),
          o: Math.min(appear, 1 - gather)
        })
      }
      const t = rise(u, 0.5)
      put(title, { x: W / 2, y: H / 2 + t.dy, o: t.o * (1 - p(u, d - 0.9, d - 0.3)) })
    }
  )

  scene(
    'home',
    (root) => {
      // The brand art without its headline (the narration says it), slowly flying in through the door.
      const hero = cropped(root, 'assets/hero.webp', [100, 260, 1360, 764], W)
      hero.style.transformOrigin = '79% 39%'
      const shade = add(root, '', '')
      shade.style.cssText += `;width:${W}px;height:${H}px;background:linear-gradient(90deg, rgba(10,16,27,.85) 0%, rgba(10,16,27,.35) 45%, rgba(10,16,27,0) 70%)`
      const title = add(root, titleHtml('Agora, eles têm<br><em>uma casa</em>.'))
      return { hero, shade, title }
    },
    (u, d, { hero, shade, title }) => {
      put(hero, { x: 0, y: 0, a: 'tl', s: 1 + 0.12 * p(u, 0, d + 0.5, ease.inOut) })
      put(shade, { x: 0, y: 0, a: 'tl' })
      const t = rise(u, 0.4)
      put(title, { x: 150, y: 330 + t.dy, a: 'tl', o: t.o })
    }
  )

  scene(
    'logo',
    (root) => {
      const halo = add(root, '')
      halo.style.cssText +=
        ';width:900px;height:900px;border-radius:50%;background:radial-gradient(circle, rgba(244,180,0,.22) 0%, rgba(244,180,0,0) 60%)'
      const mark = add(root, markSvg(460), 'glow')
      const word = add(root, '<div class="wordmark"><b>Agent Hangar</b><span>DESKTOP</span></div>')
      const tag = add(root, '<div class="sub">Uma casa para cada agente de IA</div>')
      return { halo, mark, path: mark.querySelector('path'), word, tag }
    },
    (u, d, { halo, mark, path, word, tag }) => {
      const draw = p(u, 0.15, 1.5, ease.inOut)
      path.setAttribute('stroke-dashoffset', String(1 - draw))
      put(halo, { x: W / 2, y: 400, s: 0.6 + 0.4 * p(u, 1.1, 2.2), o: p(u, 1.1, 2.0) })
      put(mark, { x: W / 2, y: 400, s: 1 + 0.03 * Math.sin(Math.max(0, u - 1.5) * 2) })
      const w = rise(u, 1.3, 0.8, 50)
      put(word, { x: W / 2, y: 740 + w.dy, o: w.o })
      const t = rise(u, 1.9, 0.8, 30)
      put(tag, { x: W / 2, y: 850 + t.dy, o: t.o })
    }
  )

  scene(
    'install',
    (root) => {
      const title = add(root, titleHtml('Instale em <em>segundos</em>.'))
      const files = [
        'resources/app.asar',
        'Hangar.exe',
        'claude.exe',
        'resources/icon.png',
        'locales/pt-BR.pak',
        'Concluído'
      ]
      const win = add(
        root,
        `<div class="installer"><div class="bar-title">${markSvg(30, 104).replace('stroke="#F4B400"', 'stroke="#c48f00"')}
         <span>Instalação do Agent Hangar Desktop</span></div><div class="body">
         <div class="side" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:linear-gradient(#232e3b,#151c25);border-top:6px solid #F4B400">
           ${markSvg(150, 60)}<div class="wordmark" style="flex-direction:column;align-items:center;gap:6px"><b style="font-size:44px;color:#fff">Agent Hangar</b><span style="font-size:22px">DESKTOP</span></div></div>
         <div class="main"><h3>Instalando…</h3><p>Aguarde enquanto o Agent Hangar Desktop é instalado.</p>
         <div class="track"><div class="fill"></div></div><div class="file mono"></div></div></div></div>`
      )
      const os = ['Windows', 'macOS', 'Linux'].map((name) => add(root, `<div class="chip"><i></i>${name}</div>`))
      const sso = add(
        root,
        '<div class="chip" style="background:#F4B400;color:#111a2b;border-color:#F4B400">Entrar com a conta da empresa</div>'
      )
      return { title, win, fill: win.querySelector('.fill'), file: win.querySelector('.file'), files, os, sso }
    },
    (u, d, { title, win, fill, file, files, os, sso }) => {
      const t = rise(u, 0.2)
      put(title, { x: W / 2, y: 120 + t.dy, o: t.o })
      const w = rise(u, 0.3, 0.8, 60)
      put(win, { x: W / 2, y: 520 + w.dy, s: 0.9 + 0.1 * w.o, o: w.o })
      const prog = p(u, 0.9, d * 0.55, ease.inOut)
      fill.style.width = `${prog * 100}%`
      file.textContent = files[Math.min(files.length - 1, Math.floor(prog * (files.length - 1) + (prog >= 1 ? 1 : 0)))]
      os.forEach((c, i) => {
        const r = rise(u, d * 0.45 + i * 0.18, 0.6, 30)
        put(c, { x: W / 2 - 330 + i * 330, y: 920 + r.dy, o: r.o })
      })
      const s = p(u, d * 0.66, d * 0.66 + 0.6, ease.back)
      put(sso, { x: W / 2, y: 1010, s: 0.8 + 0.2 * s, o: s })
    }
  )

  /** A screenshot (1600×1000) in a window frame; children can be placed in screenshot pixels. */
  function frame(root, src) {
    const f = add(root, `<div class="window" style="width:1600px;height:1000px"><img src="${src}"></div>`)
    f.style.transformOrigin = '0 0'
    return f
  }

  scene(
    'ask',
    (root) => {
      const title = add(root, titleHtml('Peça. O agente <em>faz</em>.'))
      const chips = ['Planeja', 'Usa ferramentas', 'Edita arquivos', 'Pede permissão'].map((t) =>
        add(root, `<div class="chip"><i></i>${t}</div>`)
      )
      const holder = add(root, '')
      holder.style.transformOrigin = '0 0'
      const a = frame(holder, 'shots/02-permission.png')
      const b = frame(holder, 'shots/02-session.png')
      const ring = add(holder, '', 'ring')
      ring.style.cssText += ';width:116px;height:58px'
      const cursor = add(
        root,
        `<svg width="54" height="54" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111a2b" stroke-width="1.5" stroke-linejoin="round"/></svg>`
      )
      return { title, chips, holder, a, b, ring, cursor }
    },
    (u, d, { title, chips, holder, a, b, ring, cursor }) => {
      const t = rise(u, 0.1)
      put(title, { x: 120, y: 90 + t.dy, a: 'tl', o: t.o })
      chips.forEach((c, i) => {
        const r = rise(u, 0.6 + i * 0.35, 0.6, 30)
        put(c, { x: 300, y: 400 + i * 120 + r.dy, o: r.o })
      })
      // Frame at the right, then a slow push towards the tool card once the permission is granted.
      const k = 0.7375
      const zoom = 1 + 0.22 * p(u, d * 0.6, d + 0.4, ease.inOut)
      const fx = 560
      const fy = 232
      const focusX = 934
      const focusY = 277
      put(holder, { x: fx - focusX * k * (zoom - 1), y: fy - focusY * k * (zoom - 1), s: k * zoom, a: 'tl' })
      const swap = p(u, d * 0.5, d * 0.5 + 0.35, ease.linear)
      put(a, { x: 0, y: 0, a: 'tl', o: 1 - swap })
      put(b, { x: 0, y: 0, a: 'tl', o: swap })
      // The click on "Permitir" (screenshot pixels 603,566).
      const move = p(u, 1.2, d * 0.42, ease.inOut)
      const click = p(u, d * 0.42, d * 0.42 + 0.35)
      const sx = lerp(1780, fx + 603 * k, move)
      const sy = lerp(1000, fy + 566 * k, move)
      put(cursor, {
        x: sx + 18,
        y: sy + 22,
        s: 1 - 0.15 * Math.sin(click * Math.PI),
        o: 1 - p(u, d * 0.5, d * 0.5 + 0.3)
      })
      put(ring, { x: 603, y: 566, s: 0.8 + 0.6 * click, o: (click > 0 ? 1 - click : 0) * 1 })
    }
  )

  scene(
    'panels',
    (root) => {
      const title = add(root, titleHtml('Tudo <em>lado a lado</em>.'))
      const holder = add(root, '')
      holder.style.transformOrigin = '0 0'
      const a = frame(holder, 'shots/03-session-panel.png')
      const b = frame(holder, 'shots/04-session-terminal.png')
      const ring = add(holder, '', 'ring')
      ring.style.cssText += ';width:500px;height:62px'
      return { title, holder, a, b, ring }
    },
    (u, d, { title, holder, a, b, ring }) => {
      const t = rise(u, 0.1)
      put(title, { x: 120, y: 70 + t.dy, a: 'tl', o: t.o })
      const k = 0.85
      const zoom = 1 + 0.18 * p(u, 0.3, d + 0.4, ease.inOut)
      const focusX = 1320
      const focusY = 300
      const fx = 280
      const fy = 210
      put(holder, { x: fx - focusX * k * (zoom - 1), y: fy - focusY * k * (zoom - 1), s: k * zoom, a: 'tl' })
      const swap = p(u, d * 0.52, d * 0.52 + 0.35, ease.linear)
      put(a, { x: 0, y: 0, a: 'tl', o: 1 - swap })
      put(b, { x: 0, y: 0, a: 'tl', o: swap })
      const r = p(u, 0.9, 1.5)
      put(ring, { x: 1318, y: 57, s: 0.9 + 0.1 * r, o: r * (1 - p(u, d - 0.8, d - 0.3)) })
    }
  )

  scene(
    'models',
    (root) => {
      const title = add(root, titleHtml('Qualquer modelo. <em>Ótimo desempenho.</em>'))
      const names = ['Claude', 'GPT-4.1', 'Qwen3 Coder', 'DeepSeek', 'Gemini', 'gpt-oss']
      const colors = ['#d97757', '#10a37f', '#7c5cff', '#4d6bfe', '#4f8ff7', '#9aa5b5']
      const chips = names.map((n, i) =>
        add(
          root,
          `<div class="chip" style="font-size:30px;padding:12px 24px;border-color:${colors[i]}"><i style="background:${colors[i]}"></i>${n}</div>`
        )
      )
      const ys = names.map((_, i) => 330 + i * 105)
      const target = { x: 930, y: 590 }
      const paths = ys
        .map(
          (y) =>
            `<path d="M 520 ${y} C 700 ${y}, 720 ${target.y}, ${target.x - 120} ${target.y}" pathLength="1" fill="none"
              stroke="#F4B400" stroke-width="4" stroke-dasharray="1" stroke-dashoffset="1" opacity=".85"/>`
        )
        .join('')
      const lines = add(root, `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${paths}</svg>`, 'glow')
      const mark = add(root, markSvg(260, 60), 'glow')
      const bars = add(
        root,
        `<div style="width:640px">
          <div class="sub" style="color:#c9d1db;margin-bottom:10px">Antes</div>
          <div style="height:54px;border-radius:12px;background:#26313e;overflow:hidden"><div class="b0" style="height:100%;width:0;background:#8f9bab"></div></div>
          <div class="title" style="font-size:64px;margin:8px 0 34px"><span class="c0">0</span>%</div>
          <div class="sub" style="color:#c9d1db;margin-bottom:10px">Com o Hangar</div>
          <div style="height:54px;border-radius:12px;background:#26313e;overflow:hidden"><div class="b1" style="height:100%;width:0;background:#F4B400;box-shadow:0 0 30px rgba(244,180,0,.6)"></div></div>
          <div class="title" style="font-size:96px;margin-top:8px;color:#F4B400"><span class="c1">0</span>%</div>
          <div class="sub" style="font-size:26px">das tarefas de código entregues</div>
        </div>`
      )
      const note = add(
        root,
        '<div class="footnote">Bancada interna: 5 modelos × 8 tarefas de código via LiteLLM → OpenRouter (0/75 antes, 74/75 com o Hangar).</div>'
      )
      return {
        title,
        chips,
        ys,
        lines,
        pathEls: [...lines.querySelectorAll('path')],
        mark,
        target,
        bars,
        b0: bars.querySelector('.b0'),
        b1: bars.querySelector('.b1'),
        c1: bars.querySelector('.c1'),
        note
      }
    },
    (u, d, s) => {
      const t = rise(u, 0.1)
      put(s.title, { x: W / 2, y: 120 + t.dy, o: t.o })
      s.chips.forEach((c, i) => {
        const r = rise(u, 0.4 + i * 0.15, 0.5, 0)
        put(c, { x: 380, y: s.ys[i], o: r.o, s: 0.9 + 0.1 * r.o })
      })
      s.pathEls.forEach((pe, i) =>
        pe.setAttribute('stroke-dashoffset', String(1 - p(u, 0.9 + i * 0.12, 1.9 + i * 0.12, ease.inOut)))
      )
      put(s.lines, { x: 0, y: 0, a: 'tl' })
      const m = p(u, 1.6, 2.3, ease.back)
      put(s.mark, { x: s.target.x, y: s.target.y, s: 0.6 + 0.4 * m, o: m })
      const b = rise(u, 2.2, 0.6, 30)
      put(s.bars, { x: 1500, y: 600 + b.dy, o: b.o })
      s.b0.style.width = '1.2%'
      const grow = p(u, 2.8, 4.6, ease.out)
      s.b1.style.width = `${98.7 * grow}%`
      s.c1.textContent = (98.7 * grow).toFixed(1).replace('.', ',')
      const n = rise(u, 4.4, 0.6, 0)
      put(s.note, { x: W / 2, y: 1035, o: n.o })
    }
  )

  scene(
    'create',
    (root) => {
      const title = add(root, titleHtml('Da conversa ao <em>agente</em>.'))
      const text = 'Crie um agente que resuma os tickets do suporte toda manhã e me envie às 8h.'
      const steps = [
        ['plan_agent', 'planejou a missão, as ferramentas e o modelo'],
        ['compose_agent', 'montou o agente com as skills do time'],
        ['schedule_agent', 'agendou: segunda a sexta, 08:00']
      ]
      const chat = add(
        root,
        `<div class="chat"><div class="bubble"><span class="typed"></span><span class="caret">|</span></div>
          ${steps
            .map(
              ([name, what]) =>
                `<div class="tool"><div class="ok">✓</div><span class="name">agent-hangar · ${name}</span><span class="what">${what}</span></div>`
            )
            .join('')}</div>`
      )
      const card = add(
        root,
        `<div class="agent-card"><div class="head"><div class="avatar">RS</div>Resumo do suporte
          <span class="mono" style="font-size:20px;color:#56616e;letter-spacing:.1em">AGENTE</span></div>
          <div class="tags"><span class="live">● Agendado</span><span>seg–sex · 08:00</span><span>tickets do suporte</span><span>Agent Hangar</span></div></div>`
      )
      return {
        title,
        text,
        chat,
        typed: chat.querySelector('.typed'),
        caret: chat.querySelector('.caret'),
        tools: [...chat.querySelectorAll('.tool')],
        card
      }
    },
    (u, d, s) => {
      const t = rise(u, 0.1)
      put(s.title, { x: 120, y: 80 + t.dy, a: 'tl', o: t.o })
      const c = rise(u, 0.3, 0.7, 40)
      put(s.chat, { x: 720, y: 580 + c.dy, o: c.o })
      const typed = p(u, 0.7, 0.7 + d * 0.3, ease.linear)
      s.typed.textContent = s.text.slice(0, Math.round(typed * s.text.length))
      s.caret.style.opacity = typed < 1 && Math.floor(u * 2.5) % 2 === 0 ? '1' : '0'
      s.tools.forEach((tool, i) => {
        const r = p(u, d * 0.4 + i * d * 0.1, d * 0.4 + i * d * 0.1 + 0.5, ease.back)
        tool.style.opacity = String(clamp(r))
        tool.style.transform = `translateY(${(1 - r) * 20}px)`
        tool.querySelector('.ok').style.transform = `scale(${r})`
      })
      const k = p(u, d * 0.74, d * 0.74 + 0.7, ease.back)
      put(s.card, { x: 1450, y: 860, s: 0.7 + 0.3 * k, r: -2 * k, o: clamp(k) })
    }
  )

  scene(
    'agents',
    (root) => {
      const title = add(root, titleHtml('Seus agentes, <em>ao vivo</em>.'))
      const holder = add(root, '')
      holder.style.transformOrigin = '0 0'
      frame(holder, 'shots/07-workspace-agents.png')
      // Screenshot pixels: "Ao vivo", the costs and the pending decision.
      const rings = [
        [1012, 156, 110, 44],
        [950, 340, 132, 40],
        [846, 340, 96, 40]
      ].map(([x, y, w, h]) => {
        const r = add(holder, '', 'ring')
        r.style.cssText += `;width:${w}px;height:${h}px`
        return { r, x, y }
      })
      return { title, holder, rings }
    },
    (u, d, { title, holder, rings }) => {
      const t = rise(u, 0.1)
      put(title, { x: 120, y: 70 + t.dy, a: 'tl', o: t.o })
      const k = 0.85
      const zoom = 1 + 0.12 * p(u, 0.4, d * 0.7, ease.inOut)
      const focusX = 930
      const focusY = 330
      const fx = 280
      const fy = 205
      put(holder, { x: fx - focusX * k * (zoom - 1), y: fy - focusY * k * (zoom - 1), s: k * zoom, a: 'tl' })
      rings.forEach((g, i) => {
        const r = p(u, d * 0.35 + i * 0.5, d * 0.35 + i * 0.5 + 0.4, ease.back)
        put(g.r, { x: g.x, y: g.y, s: 0.8 + 0.2 * r, o: clamp(r) })
      })
    }
  )

  scene(
    'anywhere',
    (root) => {
      const bg = cropped(root, 'assets/any-platform.webp', [0, 200, 1536, 824], 1560)
      bg.style.transformOrigin = '50% 40%'
      const title = add(root, titleHtml('Use de <em>qualquer lugar</em>.'))
      const shade = add(root, '')
      shade.style.cssText += `;width:${W}px;height:${H}px;background:#0b1220`
      const strip = cropped(root, 'assets/enterprise.webp', [40, 360, 1456, 330], 1640)
      const title2 = add(root, titleHtml('Pronto para <em>empresas</em>.'))
      return { bg, title, shade, strip, title2 }
    },
    (u, d, s) => {
      put(s.bg, { x: W / 2, y: 640, s: 1 + 0.06 * p(u, 0, d, ease.inOut) })
      const t = rise(u, 0.2)
      const half = d * 0.5
      put(s.title, { x: W / 2, y: 95 + t.dy, o: t.o * (1 - p(u, half - 0.2, half + 0.2)) })
      put(s.shade, { x: 0, y: 0, a: 'tl', o: 0.82 * p(u, half - 0.2, half + 0.4, ease.linear) })
      const e = rise(u, half + 0.2, 0.8, 40)
      put(s.strip, { x: W / 2, y: 610 + e.dy, o: e.o })
      const t2 = rise(u, half, 0.7)
      put(s.title2, { x: W / 2, y: 300 + t2.dy, o: t2.o })
    }
  )

  scene(
    'close',
    (root) => {
      const halo = add(root, '')
      halo.style.cssText +=
        ';width:1000px;height:1000px;border-radius:50%;background:radial-gradient(circle, rgba(244,180,0,.2) 0%, rgba(244,180,0,0) 60%)'
      const mark = add(root, markSvg(380), 'glow')
      const word = add(root, '<div class="wordmark"><b>Agent Hangar</b><span>DESKTOP</span></div>')
      const tag = add(
        root,
        '<div class="title" style="font-size:56px;font-weight:600">Uma casa para cada <em>agente de IA</em>.</div>'
      )
      const os = add(root, '<div class="sub" style="font-size:28px">Windows · macOS · Linux</div>')
      return { halo, mark, path: mark.querySelector('path'), word, tag, os }
    },
    (u, d, s) => {
      s.path.setAttribute('stroke-dashoffset', String(1 - p(u, 0.1, 1.3, ease.inOut)))
      put(s.halo, { x: W / 2, y: 360, s: 0.7 + 0.3 * p(u, 0.8, 2), o: p(u, 0.8, 1.8) })
      put(s.mark, { x: W / 2, y: 360 })
      const w = rise(u, 0.9, 0.8, 40)
      put(s.word, { x: W / 2, y: 640 + w.dy, o: w.o })
      const t = rise(u, 1.5, 0.8, 30)
      put(s.tag, { x: W / 2, y: 780 + t.dy, o: t.o })
      const o = rise(u, 2.1, 0.8, 0)
      put(s.os, { x: W / 2, y: 880, o: o.o })
    }
  )

  // ---- timeline ----
  const stage = document.getElementById('stage')
  const grid = document.getElementById('grid')
  const durations = {
    scatter: 6,
    home: 3.5,
    logo: 4,
    install: 7,
    ask: 7.5,
    panels: 6.5,
    models: 10.5,
    create: 10,
    agents: 6.5,
    anywhere: 8.5,
    close: 5.5
  }
  for (const s of scenes) {
    s.root = document.createElement('div')
    s.root.className = 'scene'
    stage.appendChild(s.root)
    s.state = s.build(s.root)
  }
  let starts = []
  function layout() {
    let t = 0
    starts = scenes.map((s) => {
      const at = t
      t += durations[s.id]
      return at
    })
    return t
  }
  let total = layout()

  window.setDurations = (map) => {
    Object.assign(durations, map)
    total = layout()
    return { total, starts: Object.fromEntries(scenes.map((s, i) => [s.id, starts[i]])) }
  }
  window.totalDuration = () => total
  window.renderAt = (t) => {
    put(grid, { x: -((t * 6) % 64), y: -((t * 3) % 64), a: 'tl' })
    scenes.forEach((s, i) => {
      const d = durations[s.id]
      const u = t - starts[i]
      const first = i === 0
      const last = i === scenes.length - 1
      const fadeIn = first ? 1 : p(u, -FADE, FADE, ease.linear)
      const fadeOut = last ? 1 - p(u, d - 0.6, d, ease.linear) : 1 - p(u, d - FADE, d + FADE, ease.linear)
      const o = Math.min(fadeIn, fadeOut)
      s.root.style.opacity = String(o)
      s.root.style.display = o <= 0 ? 'none' : 'block'
      if (o > 0) s.update(u, d, s.state)
    })
  }
  // Fonts and images load only once something uses them: lay every scene out once (invisible) and wait, so no
  // scene's first frame shows a fallback font or a missing image.
  window.ready = (async () => {
    scenes.forEach((s, i) => {
      s.root.style.display = 'block'
      s.root.style.opacity = '0'
      s.update(durations[s.id] * 0.6, durations[s.id], s.state)
      void i
    })
    await Promise.all([
      document.fonts.load('700 120px "Barlow Semi Condensed"'),
      document.fonts.load('600 44px "Barlow Semi Condensed"'),
      document.fonts.load('500 20px "IBM Plex Mono"'),
      document.fonts.load('400 30px "IBM Plex Sans"'),
      document.fonts.load('600 30px "IBM Plex Sans"')
    ])
    await document.fonts.ready
    await Promise.all(
      [...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r))))
    )
    await new Promise((r) => setTimeout(r, 500))
    window.renderAt(0)
  })()

  if (location.search.includes('play')) {
    const t0 = performance.now()
    const tick = () => {
      window.renderAt(((performance.now() - t0) / 1000) % total)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
})()
