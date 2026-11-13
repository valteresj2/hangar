/* Live workflow graph: built node by node from the same event stream as the timeline.
   One lane per agent (workflow stage or sub-agent); one row per model turn, so time flows downward
   and tool calls made in the same turn sit side by side. Pure SVG, no dependencies.
   The canvas is free: drag to move it, wheel to zoom at the pointer, double click to fit. */
(() => {
  const NW = 172, NH = 38, GX = 12, GY = 24, PAD = 20, LANE_GAP = 44;
  const KMIN = 0.2, KMAX = 3;
  let S = null, raf = 0, follow = true, onPick = null, host = null, W = 300, H = 0;
  const view = {k: 1, x: 0, y: 0};                      // screen = graph * k + (x, y)

  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const tail = (s, n) => { s = String(s ?? ''); return s.length > n ? '…' + s.slice(-(n - 1)) : s; };

  function reset() {
    S = {lanes: [], laneBy: {}, nodes: [], edges: [], row: 0, byTool: {}, models: {}, pendingStage: null, stageTouched: true,
         curStage: null, stageLast: [], lastRoute: '', pendingTask: [], lastLane: null, questions: {}, status: 'running', model: '', lastText: ''};
    view.k = 1; view.x = 0; view.y = 0;
    schedule();
  }

  function addNode(L, n, ownRow) {
    if (ownRow || L.newRow) { S.row++; L.prev = L.last; L.last = []; L.rowN = 0; L.newRow = false; }
    Object.assign(n, {id: S.nodes.length, lane: L, row: S.row, col: L.rowN++});
    L.cols = Math.max(L.cols, L.rowN);
    L.rows[n.row] = L.rowN;
    const prev = L.prev || [];
    if (prev.length === 1 || n.col > 0) { if (prev.length) S.edges.push({a: prev[Math.floor(prev.length / 2)], b: n}); }
    else prev.forEach(p => S.edges.push({a: p, b: n}));          // fan-in after parallel calls
    S.nodes.push(n); L.last.push(n); S.lastLane = L;
    if (ownRow) L.newRow = true;
    return n;
  }

  function lane(agent) {
    let L = S.laneBy[agent];
    if (L) return L;
    L = S.laneBy[agent] = {key: agent, cols: 1, rows: {}, last: [], prev: [], newRow: true, rowN: 0};
    S.lanes.push(L);
    const isSub = /^sub\d+$/.test(agent), st = S.pendingStage;
    const isMain = agent === 'work' || agent === 'main';
    const title = isSub ? 'sub-agente ' + agent.slice(3) : st ? st.node + (st.visit > 1 ? ' #' + st.visit : '') : isMain ? 'agente principal' : agent;
    const head = addNode(L, {kind: 'head', title, sub: isSub ? ((S.subs || {})[agent] || 'contexto próprio') : (S.models[st && st.node] || (isMain && S.model) || '').split('/').pop()}, true);
    if (isSub) {
      const parent = S.pendingTask.shift();
      if (parent) S.edges.push({a: parent, b: head, cross: true, label: 'delega'});
    } else if (st) {
      S.stageLast.forEach(p => S.edges.push({a: p, b: head, cross: true, label: S.lastRoute}));
      S.curStage = L; S.stageTouched = true;
    }
    return L;
  }

  const summary = a => {
    if (!a || typeof a !== 'object') return '';
    if (a.path) return tail(String(a.path).replace(/\\/g, '/'), 25);
    if (Array.isArray(a.items)) return a.items.length + ' itens · ' + a.items.filter(i => i && i.status === 'done').length + ' feitos';
    if (a.action) return clip(a.action + (a.id ? ' ' + a.id : ''), 25);
    return clip(a.command ?? a.pattern ?? a.url ?? a.query ?? a.question ?? a.prompt ?? a.name ?? Object.values(a)[0] ?? '', 25);
  };

  function on(ev) {
    if (!S) reset();
    const a = ev.agent || 'main';
    switch (ev.type) {
      case 'session_start': S.model = ev.model || S.model; return;
      case 'subagent': S.subs = S.subs || {}; S.subs[ev.agent] = (ev.level && ev.level !== 'standard' ? (ev.level === 'light' ? 'leve · ' : 'profundo · ') : '') + String(ev.model || '').split('/').pop(); return;
      case 'user': {                                    // a chat turn (the web app's own marker)
        if (ev.model) S.model = ev.model;
        S.status = 'running'; S.lastText = '';
        addNode(lane('work'), {kind: 'user', title: 'você', sub: clip(ev.text, 25), tip: ev.text || 'você'}, true); break; }
      case 'assistant': if (a === 'work' || a === 'main') S.lastText = ev.text || S.lastText; return;
      case 'turn_end': {
        S.status = 'done';
        S.nodes.forEach(n => { if (n.status === 'run') n.status = 'stop'; });
        const ok = ev.status === 'success', text = (ok && S.lastText) || ev.error || '';
        addNode(lane('work'), {kind: 'final', title: ok ? 'resultado' : ev.status === 'interrupted' ? 'interrompido' : ev.status === 'incomplete' ? 'incompleto' : 'erro',
                               sub: clip(text, 25), status: ok ? 'ok' : ev.status === 'interrupted' ? 'stop' : 'err', tip: text || ev.status}, true); break; }
      case 'permission': S.questions['p:' + ev.qid] = addNode(S.laneBy[a] || S.lastLane || lane('work'),
        {kind: 'ask', title: 'aprovação', sub: clip(ev.title, 25), status: 'run', tip: ev.title || 'aprovação'}, true); break;
      case 'permission_result': { const n = S.questions['p:' + ev.qid]; if (!n) return;
        const yes = String(ev.decision).startsWith('allow');
        n.status = yes ? 'ok' : 'err'; n.sub = yes ? (ev.decision === 'allow_always' ? '→ permitido sempre' : '→ permitido') : '→ negado'; n.tip += ' ' + n.sub; break; }
      case 'graph': ev.nodes.forEach(n => { S.models[n.id] = n.model; }); break;
      case 'node_start': {
        S.pendingStage = {node: ev.node, visit: ev.visit}; S.stageTouched = false;
        const L = S.laneBy[ev.node];
        if (L) {                                        // loop back into a stage that already ran (e.g. after "revise")
          const m = addNode(L, {kind: 'mark', title: 'retomada', sub: 'visita ' + ev.visit}, true);
          S.stageLast.forEach(p => S.edges.push({a: p, b: m, cross: true, label: S.lastRoute}));
          S.curStage = L; S.stageTouched = true;
        }
        break; }
      case 'node_end': {
        if (!S.stageTouched) lane(ev.node);
        if (S.curStage) S.stageLast = S.curStage.last.slice();
        S.lastRoute = ev.route || '';
        break; }
      case 'llm_start': if (S.laneBy[a]) S.laneBy[a].newRow = true; break;
      case 'tool_start': {
        const n = addNode(lane(a), {kind: 'tool', title: ev.name, sub: summary(ev.args), status: 'run', tid: ev.id,
                                     tip: ev.name + ' ' + JSON.stringify(ev.args || {})});
        S.byTool[ev.id] = n;
        if (ev.name === 'task') S.pendingTask.push(n);
        break; }
      case 'tool_end': { const n = S.byTool[ev.id]; if (n) { n.status = ev.ok ? 'ok' : 'err'; n.ms = ev.ms; if (!ev.ok) n.tip += '\n' + ev.preview; } break; }
      case 'question': { if (ev.kind === 'approval' && S.questions['p:' + ev.qid]) return; const L = S.lastLane || lane(a);
        S.questions[ev.qid] = addNode(L, {kind: 'ask', title: ev.kind === 'approval' ? 'aprovação' : 'pergunta', sub: clip(ev.question, 25), status: 'run', tip: ev.question}, true); break; }
      case 'answer': { const n = S.questions[ev.qid]; if (n) { n.status = 'ok'; n.sub = clip('→ ' + (ev.answer ?? 'sem resposta'), 25); n.tip += '\n→ ' + ev.answer; } break; }
      case 'verdict': if (!S.stageTouched && ev.node) lane(ev.node);       // a reviewer that called no tool still gets its lane
        addNode(S.curStage || S.lastLane || lane(a), {kind: 'verdict', title: 'revisor: ' + (ev.verdict === 'approve' ? 'aprova' : 'rejeita'),
                               sub: clip(ev.feedback || '', 25), status: ev.verdict === 'approve' ? 'ok' : 'err', tip: ev.feedback || ''}, true); break;
      case 'notice': {
        const t = ev.text || '';
        if (t.startsWith('escalated')) addNode(lane(a), {kind: 'esc', title: 'escalonamento', sub: clip((t.split('->')[1] || '').split(':')[0].trim().split('/').pop(), 25), tip: t}, true);
        else if (ev.level === 'warn' && !/retrying|fallback/.test(t) && S.laneBy[a]) addNode(S.laneBy[a], {kind: 'warn', title: 'aviso', sub: clip(t, 25), tip: t}, true);
        break; }
      case 'compact': if (ev.tier === 2 && S.laneBy[a]) addNode(S.laneBy[a], {kind: 'mark', title: 'compactação', sub: 'contexto resumido', tip: 'sumarização do histórico'}, true); break;
      case 'hook': if (ev.action === 'deny' || ev.action === 'push') addNode(S.laneBy[a] || S.curStage || S.lastLane || lane('work'),
                     {kind: 'warn', title: ev.event === 'pre_finish' ? 'regra: ainda não' : 'regra: bloqueado', sub: clip(ev.message || '', 25), tip: ev.message || ''}, true); break;
      case 'final': addNode(S.curStage || S.lastLane || lane('work'), {kind: 'final', title: 'resultado', sub: clip(ev.text, 25), status: 'ok', tip: ev.text}, true); break;
      case 'session_end': S.status = ev.status; S.nodes.forEach(n => { if (n.status === 'run') n.status = 'stop'; }); break;
      default: return;
    }
    schedule();
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(render); }

  function render() {
    raf = 0;
    if (!host || !S) return;
    const svg = host.querySelector('svg'), info = host.querySelector('.flowinfo');
    let x = PAD;
    S.lanes.forEach(L => { L.x = x; L.w = L.cols * (NW + GX) - GX; x += L.w + LANE_GAP; });
    W = Math.max(x - LANE_GAP + PAD, 300); H = PAD * 2 + Math.max(S.row, 1) * (NH + GY);
    S.nodes.forEach(n => {
      const rowW = n.lane.rows[n.row] * (NW + GX) - GX;
      n.x = n.lane.x + (n.lane.w - rowW) / 2 + n.col * (NW + GX);
      n.y = PAD + (n.row - 1) * (NH + GY);
    });
    let out = '<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="arrhead"/></marker></defs>';
    S.lanes.forEach(L => { out += `<rect class="lanebg" x="${L.x - 8}" y="6" width="${L.w + 16}" height="${H - 12}" rx="10"/>`; });
    for (const e of S.edges) {
      const sx = e.a.x + NW / 2, sy = e.a.y + NH, tx = e.b.x + NW / 2, ty = e.b.y - 1;
      let d;
      if (ty > sy) { const my = (sy + ty) / 2; d = Math.abs(sx - tx) < 1 ? `M${sx} ${sy}L${tx} ${ty}` : `M${sx} ${sy}C${sx} ${my},${tx} ${my},${tx} ${ty}`; }
      else { const ox = Math.max(e.a.x, e.b.x) + NW + 26; d = `M${e.a.x + NW} ${e.a.y + NH / 2}C${ox} ${e.a.y + NH / 2},${ox} ${e.b.y + NH / 2},${e.b.x + NW + 1} ${e.b.y + NH / 2}`; }
      out += `<path class="edge${e.cross ? ' cross' : ''}" d="${d}" marker-end="url(#arr)"/>`;
      if (e.label) out += `<text class="elabel" x="${(sx + tx) / 2}" y="${(sy + ty) / 2 - 3}" text-anchor="middle">${esc(e.label)}</text>`;
    }
    for (const n of S.nodes) {
      out += `<g class="fnode k-${n.kind} s-${n.status || 'none'}" data-id="${n.id}" transform="translate(${n.x},${n.y})">` +
             `<title>${esc(n.tip || n.title)}${n.ms != null ? '\n' + n.ms + ' ms' : ''}</title>` +
             `<rect class="box" width="${NW}" height="${NH}" rx="7"/><rect class="stripe" width="4" height="${NH - 10}" x="5" y="5" rx="2"/>` +
             `<text class="t1" x="15" y="15">${esc(clip(n.title, 22))}</text><text class="t2" x="15" y="29">${esc(n.sub || '')}</text>` +
             (n.ms != null ? `<text class="t3" x="${NW - 7}" y="15" text-anchor="end">${n.ms >= 1000 ? (n.ms / 1000).toFixed(1) + 's' : n.ms + 'ms'}</text>` : '') + '</g>';
    }
    const defs = out.slice(0, out.indexOf('</defs>') + 7);
    svg.innerHTML = defs + '<g class="vp">' + out.slice(defs.length) + '</g>';
    const tools = S.nodes.filter(n => n.kind === 'tool').length;
    info.textContent = S.nodes.length ? `${S.lanes.length} agente${S.lanes.length > 1 ? 's' : ''} · ${tools} chamada${tools !== 1 ? 's' : ''} de tool · ${S.row} passos`
                                      : 'O grafo aparece aqui conforme o agente trabalha.';
    const last = S.nodes[S.nodes.length - 1], box = host.querySelector('.flowscroll');
    if (follow && last && S.status === 'running' && box.clientHeight) {
      view.y = Math.min(0, box.clientHeight - 60 - (last.y + NH) * view.k);
      const left = view.x + last.x * view.k, right = left + NW * view.k;   // pan sideways only when the new node is off screen
      if (left < 0 || right > box.clientWidth) view.x = Math.min(0, 40 - last.x * view.k);
    }
    applyView();
  }

  function applyView() {
    const g = host && host.querySelector('g.vp');
    if (g) g.setAttribute('transform', `translate(${Math.round(view.x * 10) / 10},${Math.round(view.y * 10) / 10}) scale(${Math.round(view.k * 1000) / 1000})`);
    const b = host && host.querySelector('button[data-z="0"]');
    if (b) b.textContent = Math.round(view.k * 100) + '%';
  }

  function manual() {                                    // the user took the camera: stop following the newest node
    if (!follow) return;
    follow = false;
    const c = host.querySelector('#flowFollow'); if (c) c.checked = false;
  }

  function zoomAt(px, py, k) {                           // keep the graph point under (px, py) where it is
    k = Math.min(KMAX, Math.max(KMIN, k));
    view.x = px - (px - view.x) * k / view.k; view.y = py - (py - view.y) * k / view.k; view.k = k;
    applyView();
  }

  function fit() {
    const box = host.querySelector('.flowscroll');
    if (!box.clientWidth) return;
    view.k = Math.min(1, Math.max(KMIN, Math.min((box.clientWidth - 16) / W, (box.clientHeight - 16) / H)));
    view.x = (box.clientWidth - W * view.k) / 2; view.y = Math.max(8, (box.clientHeight - H * view.k) / 2);
    applyView();
  }

  function mount(el, pick) {
    host = el; onPick = pick;
    host.innerHTML = '<div class="flowbar"><span class="flowinfo"></span><span class="sp"></span>' +
      '<label><input type="checkbox" id="flowFollow" checked> seguir</label>' +
      '<button data-z="fit" title="Encaixar o grafo inteiro na tela (ou duplo clique no fundo)">ajustar</button>' +
      '<button data-z="-1" title="Diminuir">−</button><button data-z="0" title="Tamanho real">100%</button><button data-z="1" title="Aumentar">+</button></div>' +
      '<div class="flowscroll" title="Arraste para mover · roda do mouse para zoom · duplo clique para ajustar"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>';
    const box = host.querySelector('.flowscroll');
    host.querySelector('#flowFollow').onchange = e => { follow = e.target.checked; if (follow) schedule(); };
    host.querySelectorAll('button[data-z]').forEach(b => b.onclick = () => {
      manual();
      if (b.dataset.z === 'fit') return fit();
      const z = +b.dataset.z;
      zoomAt(box.clientWidth / 2, box.clientHeight / 2, z === 0 ? 1 : view.k * (z > 0 ? 1.2 : 1 / 1.2));
    });

    const at = e => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    box.addEventListener('wheel', e => {                 // wheel (and trackpad pinch) zooms at the pointer
      e.preventDefault();
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      manual(); zoomAt(...at(e), view.k * Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015)));
    }, {passive: false});

    let drag = null, dragged = false;
    box.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      drag = {x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId, moved: false};
      dragged = false;
      if (e.button === 1) e.preventDefault();
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;     // a click on a node stays a click
        drag.moved = dragged = true; manual(); box.classList.add('panning');
        try { box.setPointerCapture(drag.id); } catch { /* synthetic pointer */ }
      }
      view.x = drag.vx + dx; view.y = drag.vy + dy; applyView();
    });
    const end = () => { if (drag) { try { box.releasePointerCapture(drag.id); } catch { /* not captured */ } } drag = null; box.classList.remove('panning');
                        setTimeout(() => { dragged = false; }, 0); };      // only the click that ends this drag is swallowed
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('dblclick', e => { if (!e.target.closest('.fnode')) { manual(); fit(); } });

    box.addEventListener('click', e => {
      if (dragged) { dragged = false; return; }          // the end of a drag is not a pick
      const g = e.target.closest('.fnode'); if (!g || !S) return;
      const n = S.nodes[+g.dataset.id]; if (n && onPick) onPick(n);
    });
  }

  window.Flow = {reset, on, mount, redraw: schedule};
})();
