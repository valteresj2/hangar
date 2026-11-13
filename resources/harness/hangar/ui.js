/* Hangar web app: sessions, chat, composer (attachments, recordings), side panels. Vanilla JS, no dependencies.
   The chat is a pure function of a session's event log: the page replays it and then follows it over SSE. */
(() => {
  'use strict';
  const TOKEN = window.HANGAR_TOKEN;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  // replaceChildren(a, cond ? b : null) would print "null": drop empty children (and flatten lists) everywhere.
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) {
    return nativeReplace.apply(this, kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  async function api(path, body, opts = {}) {
    const init = {headers: {'X-Hangar-Token': TOKEN}, ...opts};
    if (body !== undefined) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const r = await fetch(path, init);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  const tok = url => url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  const sapi = (what, q = '') => `/api/sessions/${S.cur.id}/${what}${q}`;

  let toastTimer = 0;
  function toast(msg) { $('toast').textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 4200); }
  const fail = e => toast(e.message || String(e));

  const PERMS = {ask: 'Perguntar', edits: 'Aceitar edições', readonly: 'Planejar', auto: 'Automático'};
  const EFFORTS = {low: 'Baixo', medium: 'Médio', high: 'Alto'};
  const TABS = [['terminal', 'Terminal'], ['changes', 'Alterações'], ['files', 'Arquivos'], ['browser', 'Navegador'],
                ['artifacts', 'Artifacts'], ['harness', 'Harness'], ['flow', 'Grafo']];
  const STAGE = {plan: 'Planejamento', execute: 'Execução', work: 'Execução', review: 'Revisão independente'};
  const WORKFLOWS = {
    chat: ['Conversa', 'Você conversa com o agente em vários turnos e aprova cada ação.'],
    verify: ['Executar e revisar', 'O agente faz a tarefa e um revisor independente, sem o histórico, confere o resultado; se reprovar, o agente corrige (até 3 vezes).'],
    pev: ['Planejar, executar e revisar', 'Um modelo planeja (somente leitura), outro executa o plano e um revisor independente confere. Bom para tarefas grandes com modelo barato na execução.']
  };
  const TOOL_LABEL = {read: 'Ler', write: 'Escrever', edit: 'Editar', shell: 'Bash', glob: 'Buscar arquivos', grep: 'Procurar', web_fetch: 'Abrir página',
                      web_search: 'Pesquisar', task: 'Agente', skill: 'Skill', perceive: 'Perceber', process: 'Processo', note: 'Nota', mcp_call: 'MCP', ask_user: 'Pergunta'};

  const S = {
    state: {sessions: [], cli: [], defaults: {}, hasKey: true}, cur: null, es: null, events: [],
    tab: localStorage.getItem('hangarTab') || 'files', sideOpen: localStorage.getItem('hangarSide') === '1',
    sideW: +localStorage.getItem('hangarSideW') || 560, collapsed: {arch: true, cli: true}, search: '', hits: null,
    atts: [], models: [], rec: null, chat: null, panel: {}, term: {}, busy: false
  };
  window.__hangar = S;                                         // for tests and debugging

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    const t = localStorage.getItem('hangarTheme') || 'system';
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  applyTheme();

  // --------------------------------------------------------------- markdown
  function inline(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function md(text) {
    const out = [], lines = String(text || '').replace(/\r/g, '').split('\n');
    let i = 0, para = [];
    const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```/.test(line);
      if (fence) {
        flush(); const code = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue;
      }
      const hd = /^(#{1,4})\s+(.*)$/.exec(line);
      if (hd) { flush(); const n = Math.min(3, hd[1].length); out.push(`<h${n}>${inline(hd[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
        flush(); const ordered = /^\s*\d/.test(line), items = [];
        while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''));
        out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map(t => '<li>' + inline(t) + '</li>').join('') + `</${ordered ? 'ol' : 'ul'}>`); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flush(); const row = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = row(line); i += 2; const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
        out.push('<table><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr>' +
                 rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</table>'); continue;
      }
      if (/^\s*>\s?/.test(line)) { flush(); out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); i++; continue; }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line); i++;
    }
    flush();
    return out.join('');
  }

  // ---------------------------------------------------------------- helpers
  const short = p => { const s = String(p || '').replace(/\\/g, '/'); return s.length > 60 ? '…' + s.slice(-59) : s; };
  const base = p => String(p || '').replace(/\\/g, '/').split('/').pop();
  const money = v => 'US$ ' + (+v || 0).toFixed(4);
  const kfmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);
  const dur = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms || 0) + ' ms';
  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'agora'; if (s < 3600) return Math.floor(s / 60) + ' min'; if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' d';
  }
  function diffBox(lines) {
    const add = lines.filter(l => l[0] === '+').length, del = lines.filter(l => l[0] === '-').length;
    return h('div', {class: 'diff'}, h('div', {class: 'stat', html: `<b>+${add}</b> <i>−${del}</i>`}),
      h('div', {class: 'lines'}, lines.slice(0, 600).map(l => h('div', {class: 'l ' + (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '')},
        '+-'.includes(l[0] || ' ') && l ? l[0] + ' ' + l.slice(1) : l || ' '))));
  }
  const isMain = ev => !ev.agent || ev.agent === 'work' || ev.agent === 'main';

  // ------------------------------------------------------------------- chat
  class Chat {
    constructor(root, readonly) {
      this.root = root; this.readonly = readonly; this.tools = {}; this.cards = {}; this.stream = null; this.streamThink = null;
      this.todos = null; this.last = {}; this.busy = false; this.files = new Set(); this.workEl = null;
    }
    add(el) { this.stream = null; this.streamThink = null; this.root.append(el); this.scroll(); return el; }
    scroll() { const box = this.root.parentElement; if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 260) box.scrollTop = box.scrollHeight; }
    setBusy(b) {
      this.busy = b;
      if (this.workEl) { this.workEl.remove(); this.workEl = null; }
      if (b) { this.workEl = h('div', {class: 'working', 'data-testid': 'working'}, h('span', {class: 'spinner'}), 'Trabalhando…'); this.root.append(this.workEl); }
    }
    on(ev) {
      const main = this.readonly ? !/^sub\d+$/.test(ev.agent || '') : isMain(ev);
      switch (ev.type) {
        case 'node_start':
          if (this.readonly && S.cur && S.cur.workflow && S.cur.workflow !== 'loop')
            this.add(h('div', {class: 'stage', 'data-testid': 'stage'}, `${STAGE[ev.node] || ev.node}${ev.visit > 1 ? ` · tentativa ${ev.visit}` : ''}`));
          break;
        case 'verdict': {
          const ok = ev.verdict === 'approve';
          this.add(h('div', {class: 'sys ' + (ok ? 'ok' : 'err'), 'data-testid': 'verdict'},
            ok ? 'Revisor: aprovado.' : `Revisor: pediu ajustes — ${ev.feedback || 'sem detalhes'}`));
          break; }
        case 'team':
          if (this.readonly) this.add(h('div', {class: 'sys', 'data-testid': 'team-line'}, 'Equipe: ' + (ev.team || []).filter(m => ['worker', 'planner', 'verifier', 'escalation'].includes(m.role))
            .map(m => `${{worker: 'executor', planner: 'planejador', verifier: 'revisor', escalation: 'reforço'}[m.role]} ${String(m.model).split('/').pop()}`).join(' · ')));
          break;
        case 'subagent': if (ev.level && ev.level !== 'standard') this.add(h('div', {class: 'sys'}, `Sub-agente ${ev.level === 'light' ? 'leve' : 'profundo'}: ${String(ev.model).split('/').pop()}`)); break;
        case 'session_start':
          if (this.readonly && ev.task) this.add(h('div', {class: 'msg-user'}, ev.task));
          if (this.readonly) this.setBusy(true);
          break;
        case 'user': {
          const el = h('div', {class: 'msg-user', 'data-testid': 'user-msg'}, ev.text || '');
          if ((ev.attachments || []).length) el.append(h('div', {class: 'chips'}, ev.attachments.map(a =>
            h('span', {class: 'chip', title: a.path}, h('span', {class: 'k'}, a.kind), h('span', {class: 'n'}, a.name)))));
          this.add(el); this.setBusy(true); break; }
        case 'delta': {
          if (!main) break;
          if (ev.kind === 'reasoning') {
            if (!this.streamThink) { const d = h('details', {class: 'think', open: true}, h('summary', null, 'Pensando…'), h('div', {class: 'body'})); this.add(d); this.streamThink = d; }
            this.streamThink.lastChild.textContent += ev.text || '';
          } else {
            if (!this.stream) { const d = h('div', {class: 'md streaming'}); this.add(d); this.stream = d; this.streamText = ''; }
            this.streamText += ev.text || ''; this.stream.innerHTML = md(this.streamText);
          }
          if (this.workEl) this.root.append(this.workEl);
          this.scroll(); break; }
        case 'thinking': {
          if (!main || !String(ev.text || '').trim()) break;
          const d = this.streamThink || h('details', {class: 'think'}, h('summary', null, ''), h('div', {class: 'body'}));
          d.open = false; d.firstChild.textContent = 'Pensamento'; d.lastChild.textContent = ev.text;
          if (!this.streamThink) this.add(d);
          this.streamThink = null; break; }
        case 'assistant': case 'final': {
          if (!main || !String(ev.text || '').trim()) break;
          this.said = this.said || new Set();
          if (ev.type === 'final' && this.said.has(ev.text)) break;
          this.said.add(ev.text);
          // a reviewer ends with its verdict as JSON: the "Revisor: …" line says it, so the raw JSON is not repeated
          const shown = this.readonly ? String(ev.text).replace(/\s*\{\s*"verdict"[^{}]*\}\s*$/, '') : ev.text;
          if (!shown.trim()) { if (this.stream) { this.stream.remove(); this.stream = null; } break; }
          const d = this.stream || h('div', {class: 'md'});
          d.className = 'md'; d.dataset.testid = 'assistant-msg'; d.innerHTML = md(shown);
          if (!this.stream) this.add(d);
          this.stream = null; if (this.workEl) this.root.append(this.workEl); break; }
        case 'tool_start': if (main) this.toolStart(ev); break;
        case 'tool_end': if (main) this.toolEnd(ev); break;
        case 'permission': this.permission(ev); break;
        case 'permission_result': {
          const c = this.cards['p' + ev.qid]; if (!c) break;
          const ok = String(ev.decision).startsWith('allow');
          c.replaceWith(h('div', {class: 'sys ' + (ok ? 'ok' : 'err'), 'data-testid': 'perm-result'},
            (ok ? (ev.decision === 'allow_always' ? 'Permitido sempre: ' : 'Permitido: ') : 'Negado: ') + (c.dataset.label || '')));
          delete this.cards['p' + ev.qid]; break; }
        case 'question': if (ev.kind !== 'approval' || this.readonly) this.question(ev); break;
        case 'answer': {
          const c = this.cards['q' + ev.qid]; if (!c) break;
          c.replaceWith(h('div', {class: 'sys'}, `Resposta: ${ev.answer ?? ''}`)); delete this.cards['q' + ev.qid]; break; }
        case 'notice':
          if (ev.level === 'error') this.add(h('div', {class: 'errbox'}, ev.text || ''));
          else if (main && ev.level === 'warn') this.add(h('div', {class: 'sys'}, ev.text || ''));
          break;
        case 'error': this.add(h('div', {class: 'errbox', 'data-testid': 'error'}, ev.text || '')); break;
        case 'hook': this.add(h('div', {class: 'sys'}, `Regra do projeto (${ev.event} · ${ev.action}): ${ev.message || ''}`)); break;
        case 'command': this.add(h('div', {class: 'sys'}, `Comando /${ev.name}`)); break;
        case 'attachment': this.add(h('div', {class: 'sys'}, `Anexo ${base(ev.path)}: ${ev.mode === 'native' ? 'enviado ao modelo' : 'descrito por um modelo de percepção'}`)); break;
        case 'compact': if (main && ev.tier === 2) this.add(h('div', {class: 'sys'}, 'Contexto compactado para continuar a conversa.')); break;
        case 'turn_end': case 'session_end': this.turnEnd(ev); break;
      }
    }
    toolStart(ev) {
      const a = ev.args || {}, name = ev.name;
      if (name === 'plan') { this.todos = Array.isArray(a.items) ? a.items : []; renderTodos(); }
      const arg = a.path ? short(a.path) : a.command ?? a.pattern ?? a.url ?? a.query ?? a.prompt ?? a.name ?? a.question ??
        (name === 'plan' ? `${(a.items || []).length} itens` : '');
      const body = h('div', {class: 'tbody'});
      if (name === 'write') body.append(diffBox(String(a.content || '').split('\n').map(l => '+' + l)));
      else if (name === 'edit') body.append(diffBox([...String(a.old || '').split('\n').map(l => '-' + l), ...String(a.new || '').split('\n').map(l => '+' + l)]));
      else if (name === 'shell') body.append(h('pre', null, '$ ' + (a.command || '')));
      else if (name !== 'read' && name !== 'plan') body.append(h('pre', null, JSON.stringify(a, null, 2)));
      const dot = h('span', {class: 'dot run'}), ms = h('span', {class: 'ms'});
      const el = h('details', {class: 'tool', open: name === 'write' || name === 'edit', 'data-testid': 'tool', 'data-tool': name},
        h('summary', null, dot, h('span', {class: 'name'}, TOOL_LABEL[name] || name), h('span', {class: 'arg'}, String(arg ?? '').split('\n')[0]), ms), body);
      this.tools[ev.id] = {el, dot, ms, body, name, args: a};
      this.add(el); if (this.workEl) this.root.append(this.workEl);
    }
    toolEnd(ev) {
      const t = this.tools[ev.id]; if (!t) return;
      t.dot.className = 'dot ' + (ev.ok === false ? 'err' : 'ok'); t.el.dataset.status = ev.ok === false ? 'err' : 'ok';
      if (ev.ms != null) t.ms.textContent = dur(ev.ms);
      const out = String(ev.output || ev.preview || '');
      if (out && (ev.ok === false || !['write', 'edit', 'plan'].includes(t.name))) t.body.append(h('pre', {class: ev.ok === false ? 'err' : ''}, out.slice(0, 20000)));
      if (ev.ok !== false && (t.name === 'write' || t.name === 'edit') && t.args.path) { this.files.add(String(t.args.path)); panelChanged('artifacts'); }
      if (ev.ok === false) t.el.open = true;
    }
    permission(ev) {
      const a = ev.args || {}, label = (TOOL_LABEL[ev.tool] || ev.tool) + (a.path ? ' ' + base(a.path) : '');
      const reason = h('input', {class: 'field', placeholder: 'Motivo (opcional, ao negar)'});
      const send = decision => api(sapi('respond'), {qid: ev.qid, decision, message: reason.value}).catch(fail);
      const card = h('div', {class: 'card', 'data-testid': 'permission', 'data-label': label},
        h('div', {class: 'q'}, ev.title || `Permitir ${label}?`),
        h('div', {class: 'row'},
          h('button', {class: 'btn primary', onclick: () => send('allow')}, 'Permitir'),
          ev.can_always ? h('button', {class: 'btn', onclick: () => send('allow_always')}, 'Permitir sempre nesta sessão') : null,
          h('button', {class: 'btn danger', onclick: () => send('deny')}, 'Negar'), reason));
      this.cards['p' + ev.qid] = card; this.add(card); if (this.workEl) this.root.append(this.workEl);
    }
    question(ev) {
      const input = h('input', {class: 'field', placeholder: 'Sua resposta…'});
      const send = answer => (this.readonly ? api('/api/answer', {session: S.cur.id, qid: ev.qid, answer})
                                            : api(sapi('respond'), {qid: ev.qid, answer})).catch(fail);
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) send(input.value.trim()); });
      const card = h('div', {class: 'card', 'data-testid': 'question'}, h('div', {class: 'q'}, ev.question || ''),
        h('div', {class: 'row'}, (ev.options || []).map(o => h('button', {class: 'btn', onclick: () => send(String(o))}, String(o)))),
        h('div', {class: 'row'}, input, h('button', {class: 'btn primary', onclick: () => input.value.trim() && send(input.value.trim())}, 'Responder')));
      this.cards['q' + ev.qid] = card; this.add(card);
    }
    turnEnd(ev) {
      this.setBusy(false);
      for (const t of Object.values(this.tools)) if (t.dot.className === 'dot run') t.dot.className = 'dot';
      for (const k of Object.keys(this.cards)) { this.cards[k].remove(); delete this.cards[k]; }
      const status = ev.status;
      if (ev.type === 'session_end' && $('clistop')) $('clistop').hidden = true;
      if (status === 'interrupted' || status === 'stopped') this.add(h('div', {class: 'sys'}, 'Interrompido.'));
      else if (status === 'incomplete') this.add(h('div', {class: 'sys err'}, `A tarefa não foi concluída: ${ev.error || 'limite atingido'}.`));
      else if (status === 'error' && ev.error && ev.error !== 'process exited') this.add(h('div', {class: 'errbox', 'data-testid': 'error'}, ev.error));
      if (ev.type === 'turn_end') {
        this.last = ev;
        this.add(h('div', {class: 'turnline', 'data-testid': 'turn-end', 'data-status': status},
          h('span', null, String(ev.model || '').split('/').pop()), h('span', null, dur(ev.duration_ms)), h('span', null, money(ev.cost)),
          h('span', null, `${kfmt(ev.prompt)} ↑ · ${kfmt(ev.completion)} ↓`), h('span', null, `${ev.steps || 0} passos`)));
      }
      renderStatus();
    }
  }

  function renderTodos() {
    const box = $('todos'); if (!box) return;
    const items = (S.chat && S.chat.todos) || [];
    box.hidden = !items.length;
    if (!items.length) return;
    const done = items.filter(i => i && (i.status === 'done' || i.status === 'completed')).length;
    box.replaceChildren(h('summary', null, `Tarefas ${done}/${items.length}`),
      h('ul', null, items.map(i => h('li', {class: i.status === 'completed' ? 'done' : (i.status || 'pending')}, i.step || i.content || String(i)))));
  }

  // --------------------------------------------------------------- sessions
  let pollTimer = 0;
  async function refresh() {
    try {
      S.state = await api('/api/state?active=' + (S.cur && !S.cur.cli ? S.cur.id : ''));
      $('version').textContent = 'v' + S.state.version;
      if (S.cur && !S.cur.cli) {
        const fresh = S.state.sessions.find(s => s.id === S.cur.id);
        if (fresh && S.chat && S.chat.busy && !fresh.busy && fresh.status !== 'working' && fresh.status !== 'waiting' && Date.now() - (S.lastEv || 0) > 3000) S.chat.setBusy(false);
        if (fresh) { const was = S.cur.status + S.cur.title + S.cur.busy; Object.assign(S.cur, fresh); if (was !== fresh.status + fresh.title + fresh.busy) { renderTop(); syncBusy(); } }
      }
      renderSidebar();
    } catch (e) { /* the server is restarting */ }
  }
  function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 1500); }

  function renderSidebar() {
    const sb = $('sidebar'), st = S.state;
    const active = st.sessions.filter(s => !s.archived).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    const arch = st.sessions.filter(s => s.archived);
    const row = s => {
      const cls = s.busy || s.status === 'working' ? 'working' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : s.unread ? 'unread' : '';
      return h('button', {class: 'sess' + (S.cur && S.cur.id === s.id ? ' on' : ''), 'data-testid': 'session-row', 'data-id': s.id, onclick: () => openSession(s),
                          oncontextmenu: e => { e.preventDefault(); sessionMenu(s, e.currentTarget); }},
        cls ? h('span', {class: 'dot ' + cls}) : s.pinned ? h('span', {class: 'pin'}, '◆') : null,
        h('span', {class: 't'}, s.title), h('span', {class: 'm'}, `${base(s.cwd)} · ${ago(s.updatedAt)}`),
        h('span', {class: 'more', role: 'button', tabindex: 0, 'aria-label': 'Ações da sessão', onclick: e => { e.stopPropagation(); sessionMenu(s, e.currentTarget.parentElement); }}, '⋯'));
    };
    const section = (key, label, list, render, empty) => {
      const open = !S.collapsed[key];
      return [h('button', {class: 'sb-head', 'aria-expanded': String(open), onclick: () => { S.collapsed[key] = open; renderSidebar(); }},
                h('span', {class: 'chev'}, '▾'), label, h('span', {class: 'count'}, String(list.length))),
              open ? (list.length ? list.map(render) : h('div', {class: 'sb-empty'}, empty)) : null];
    };
    const input = h('input', {placeholder: 'Buscar sessões', value: S.search, 'aria-label': 'Buscar sessões', 'data-testid': 'search',
      oninput: e => { S.search = e.target.value; clearTimeout(input._t); input._t = setTimeout(doSearch, 220); }});
    const scroll = h('div', {class: 'sb-scroll'});
    if (S.hits) scroll.append(h('div', {class: 'sb-head'}, 'Resultados', h('span', {class: 'count'}, String(S.hits.length))),
      ...(S.hits.length ? S.hits.map(hit => h('button', {class: 'sess', onclick: () => openSession(st.sessions.find(s => s.id === hit.id))},
        h('span', {class: 't'}, hit.title), h('span', {class: 'm'}, hit.snippet))) : [h('div', {class: 'sb-empty'}, 'Nada encontrado.')]));
    else scroll.append(...section('recent', 'Recentes', active, row, 'Nenhuma sessão ainda.').flat().filter(Boolean),
      ...section('arch', 'Arquivadas', arch, row, 'Nenhuma sessão arquivada.').flat().filter(Boolean),
      ...section('cli', 'Tarefas e execuções do CLI', st.cli || [], c => h('button', {class: 'sess' + (S.cur && S.cur.id === c.id ? ' on' : ''), onclick: () => openCli(c)},
        c.status === 'running' ? h('span', {class: 'dot working'}) : null, h('span', {class: 't'}, c.task || c.id),
        h('span', {class: 'm'}, `${String(c.model || '').split('/').pop()} · ${c.workflow || ''} · $${(+c.cost || 0).toFixed(4)}`)), 'Tarefas com revisão e rodadas de `hangar run` aparecem aqui.').flat().filter(Boolean));
    const focused = document.activeElement && document.activeElement.dataset.testid === 'search';
    sb.replaceChildren(
      h('div', {class: 'sb-top'},
        h('button', {class: 'newbtn', 'data-testid': 'new-session', onclick: newSession}, h('span', null, '＋'), 'Nova sessão', h('kbd', null, 'Alt+N')),
        h('label', {class: 'search'}, h('span', null, '⌕'), input)),
      scroll,
      h('div', {class: 'sb-foot'}, h('span', {class: 'keydot' + (st.hasKey ? '' : ' off')}),
        st.hasKey ? 'Chave do provedor encontrada' : 'Sem chave do provedor (.env)'));
    if (focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  async function doSearch() {
    S.hits = S.search.trim().length >= 2 ? await api('/api/search?q=' + encodeURIComponent(S.search)).catch(() => []) : null;
    renderSidebar();
  }

  function menu(anchor, items) {
    closeMenu();
    const m = h('div', {class: 'menu', role: 'menu'}, items.map(it => it === '-' ? h('div', {class: 'sep'}) :
      h('button', {class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => { closeMenu(); it.run(); }}, it.label, it.desc ? h('span', {class: 'd'}, it.desc) : null)));
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = (r.bottom + 4 + m.offsetHeight > innerHeight ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4) + 'px';
    S.menu = m;
    setTimeout(() => document.addEventListener('pointerdown', outside, {once: true}), 0);
    return m;
  }
  const outside = e => { if (S.menu && !S.menu.contains(e.target)) closeMenu(); else if (S.menu) document.addEventListener('pointerdown', outside, {once: true}); };
  function closeMenu() { if (S.menu) { S.menu.remove(); S.menu = null; } }

  function sessionMenu(s, anchor) {
    const up = patch => api(`/api/sessions/${s.id}/update`, patch).then(refresh).catch(fail);
    menu(anchor, [
      {label: 'Renomear', run: () => prompt2('Renomear sessão', s.title, v => up({title: v}))},
      {label: s.pinned ? 'Desafixar' : 'Fixar', run: () => up({pinned: !s.pinned})},
      {label: s.archived ? 'Desarquivar' : 'Arquivar', run: () => up({archived: !s.archived})},
      '-',
      {label: 'Excluir', danger: true, run: () => confirm2(`Excluir "${s.title}"?`, 'A conversa some desta lista. Os arquivos da pasta não são tocados.', async () => {
        await api(`/api/sessions/${s.id}/delete`, {}).catch(fail);
        if (S.cur && S.cur.id === s.id) newSession();
        refresh();
      })}
    ]);
  }

  // ----------------------------------------------------------------- modals
  function modal(title, body, buttons) {
    const close = () => $('overlay').replaceChildren();
    const m = h('div', {class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title}, h('h2', null, title), h('div', {class: 'mbody'}, body),
      h('div', {class: 'mfoot'}, buttons.map(b => h('button', {class: 'btn ' + (b.cls || ''), 'data-testid': b.id, onclick: () => { if (b.run && b.run() === false) return; close(); }}, b.label))));
    $('overlay').replaceChildren(m);
    const f = m.querySelector('input,textarea,select,button.primary'); if (f) f.focus();
    return close;
  }
  function prompt2(title, value, done) {
    const input = h('input', {class: 'field', value});
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = input.value.trim(); if (v) { done(v); $('overlay').replaceChildren(); } } });
    modal(title, input, [{label: 'Cancelar'}, {label: 'Salvar', cls: 'primary', run: () => { const v = input.value.trim(); if (!v) return false; done(v); }}]);
    input.select();
  }
  function confirm2(title, text, done) {
    modal(title, h('div', null, text), [{label: 'Cancelar'}, {label: 'Excluir', cls: 'danger', id: 'confirm', run: () => { done(); }}]);
  }
  async function pickFolder(start, done) {
    let cur = null;
    const list = h('div', {class: 'dirlist'}), pathIn = h('input', {class: 'field mono'});
    const load = async p => {
      try { cur = await api('/api/dirs?path=' + encodeURIComponent(p || '')); } catch (e) { return fail(e); }
      pathIn.value = cur.path;
      list.replaceChildren(
        cur.parent ? h('button', {class: 'rowbtn', onclick: () => load(cur.parent)}, h('span', {class: 'ic'}, '↑'), '..') : null,
        ...cur.dirs.map(d => h('button', {class: 'rowbtn', ondblclick: () => {}, onclick: () => load(cur.path.replace(/[\\/]$/, '') + (cur.path.includes('\\') ? '\\' : '/') + d)},
          h('span', {class: 'ic'}, '▸'), h('span', {class: 'n'}, d))));
    };
    pathIn.addEventListener('keydown', e => { if (e.key === 'Enter') load(pathIn.value); });
    await load(start).catch(() => {});
    if (!cur) await load('');
    if (!cur) return;
    modal('Escolher pasta', [pathIn, h('div', {style: 'display:flex;gap:6px;flex-wrap:wrap'}, h('button', {class: 'btn small', onclick: () => load(cur.home)}, 'Pasta pessoal'),
      ...(cur.roots || []).map(r => h('button', {class: 'btn small', onclick: () => load(r)}, r))), list],
      [{label: 'Cancelar'}, {label: 'Usar esta pasta', cls: 'primary', id: 'use-folder', run: () => { done(pathIn.value); }}]);
  }
  function settings() {
    const theme = h('select', {class: 'field', onchange: e => { localStorage.setItem('hangarTheme', e.target.value); applyTheme(); }},
      [['system', 'Seguir o sistema'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => h('option', {value: v, selected: (localStorage.getItem('hangarTheme') || 'system') === v}, l)));
    modal('Configurações', [
      h('label', null, 'Tema'), theme,
      h('div', {class: 'muted'}, `Hangar Harness v${S.state.version}. Modelo padrão: ${S.state.defaults.model}.`),
      h('div', {class: 'muted'}, S.state.hasKey ? 'A chave do provedor foi encontrada no ambiente ou no .env.'
        : 'Nenhuma chave do provedor: defina OPENROUTER_API_KEY no ambiente ou num arquivo .env (na pasta do projeto ou em ~/.hangar).'),
      h('div', {class: 'muted'}, 'Modelos, provedores, hooks e lições são configurados em ~/.hangar/config.json e em .hangar/ no projeto.')
    ], [{label: 'Fechar', cls: 'primary'}]);
  }

  // ---------------------------------------------------------------- top bar
  function renderTop() {
    const s = S.cur;
    $('topbar').replaceChildren(
      h('button', {class: 'icon-btn', title: 'Alternar barra lateral (Alt+B)', 'aria-label': 'Alternar barra lateral', onclick: toggleSidebar}, '☰'),
      h('div', {class: 'title', 'data-testid': 'title'}, s ? s.title || s.task || s.id : 'Nova sessão'),
      s && !s.cli ? h('button', {class: 'icon-btn', title: 'Ações da sessão', 'aria-label': 'Ações da sessão', onclick: e => sessionMenu(s, e.currentTarget)}, '⋯') : null,
      h('span', {class: 'grow'}),
      s ? h('div', {class: 'tabs', role: 'tablist'}, TABS.filter(([t]) => !s.cli || t === 'flow').map(([t, label]) =>
        h('button', {class: 'tabbtn' + (S.sideOpen && S.tab === t ? ' on' : ''), role: 'tab', 'data-testid': 'tab-' + t,
                     onclick: () => (S.sideOpen && S.tab === t ? closeSide() : openSide(t))}, label))) : null,
      h('button', {class: 'icon-btn', title: 'Configurações', 'aria-label': 'Configurações', onclick: settings}, '⚙'));
  }
  function toggleSidebar() { $('sidebar').classList.toggle('collapsed'); }

  // ------------------------------------------------------------ open / new
  function closeStream() { if (S.es) { S.es.close(); S.es = null; } }
  function newSession() {
    closeStream(); S.cur = null; S.chat = null; S.events = []; S.atts = [];
    renderTop(); renderSidebar(); renderSide(); renderNew();
  }
  function renderNew() {
    const d = S.state.defaults || {};
    const lastCwd = localStorage.getItem('hangarCwd') || d.cwd || '';
    const cwd = h('input', {class: 'field mono', value: lastCwd, 'data-testid': 'new-cwd'});
    const perm = h('select', {class: 'field', 'data-testid': 'new-perm'}, Object.entries(PERMS).map(([v, l]) => h('option', {value: v, selected: v === (localStorage.getItem('hangarPerm') || 'ask')}, l)));
    const effort = h('select', {class: 'field'}, Object.entries(EFFORTS).map(([v, l]) => h('option', {value: v, selected: v === (d.effort || 'low')}, 'Esforço: ' + l)));
    const teamBox = h('details', {class: 'teambox', 'data-testid': 'team-box'}, h('summary', null, 'Modelos: o Hangar escolhe o melhor custo-benefício para cada papel'));
    const loadTeam = () => api('/api/team?cwd=' + encodeURIComponent(cwd.value.trim())).then(r => teamBox.replaceChildren(teamBox.firstChild, teamTable(r))).catch(() => {});
    const text = h('textarea', {class: 'field', placeholder: 'O que você quer fazer? (pode deixar em branco e escrever depois)', 'data-testid': 'new-prompt'});
    const wfHint = h('div', {class: 'hint', 'data-testid': 'wf-hint'});
    const wf = h('select', {class: 'field', 'data-testid': 'new-workflow', onchange: () => syncWf()},
      Object.entries(WORKFLOWS).map(([v, [l]]) => h('option', {value: v, selected: v === (localStorage.getItem('hangarWorkflow') || 'chat')}, l)));
    const syncWf = () => {
      const chat = wf.value === 'chat';
      wfHint.textContent = WORKFLOWS[wf.value][1];
      text.placeholder = chat ? 'O que você quer fazer? (pode deixar em branco e escrever depois)' : 'Descreva a tarefa completa: neste modo ela roda até o fim, sem conversa.';
      createBtn.textContent = chat ? 'Criar sessão' : 'Iniciar tarefa';
    };
    const createBtn = h('button', {class: 'btn primary', 'data-testid': 'create-session', onclick: () => go()}, 'Criar sessão');
    const go = async () => {
      if (wf.value !== 'chat') {
        if (!text.value.trim()) { text.focus(); return toast('Descreva a tarefa: este modo roda do começo ao fim, sem conversa.'); }
        try {
          const r = await api('/api/run', {task: text.value.trim(), cwd: cwd.value.trim(), workflow: wf.value, permission: perm.value, effort: effort.value});
          localStorage.setItem('hangarCwd', cwd.value.trim()); localStorage.setItem('hangarWorkflow', wf.value);
          S.collapsed.cli = false;
          openCli({id: r.session, task: text.value.trim(), model: 'auto', workflow: wf.value, cwd: cwd.value.trim(), status: 'running'});
          openSide('flow');
        } catch (e) { fail(e); }
        return;
      }
      localStorage.setItem('hangarWorkflow', 'chat');
      try {
        const s = await api('/api/sessions', {cwd: cwd.value.trim(), permission: perm.value, effort: effort.value});
        localStorage.setItem('hangarCwd', s.cwd); localStorage.setItem('hangarPerm', s.permission);
        await refresh(); await openSession(s);
        if (text.value.trim()) send(text.value.trim());
      } catch (e) { fail(e); }
    };
    text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
    $('center').replaceChildren(h('div', {class: 'newview'}, h('div', {class: 'newcard'},
      h('h1', null, 'Nova sessão'),
      S.state.hasKey === false ? h('div', {class: 'warn'}, 'Nenhuma chave do provedor foi encontrada. Defina OPENROUTER_API_KEY no ambiente ou num arquivo .env antes de enviar.') : null,
      h('div', null, h('label', null, 'Pasta de trabalho'), h('div', {style: 'display:flex;gap:8px'}, cwd,
        h('button', {class: 'btn', onclick: () => pickFolder(cwd.value, p => { cwd.value = p; loadTeam(); })}, 'Escolher…'))),
      h('div', {class: 'two'}, h('div', null, h('label', null, 'Modo de trabalho'), wf), h('div', null, h('label', null, 'Permissões'), perm), h('div', null, h('label', null, 'Esforço'), effort)),
      wfHint, teamBox,
      h('div', null, h('label', null, 'Tarefa'), text),
      h('div', {style: 'display:flex;gap:10px;align-items:center'}, createBtn,
        h('span', {class: 'hint'}, 'O agente trabalha nessa pasta; cada sessão guarda a própria conversa.')),
      h('datalist', {id: 'models'}, S.models.map(m => h('option', {value: m}))))));
    syncWf(); loadTeam();
    text.focus();
  }

  async function openSession(s) {
    if (!s) return;
    closeStream(); closeMenu();
    S.cur = {...s}; S.events = []; S.atts = []; S.hits = null; S.search = '';
    renderTop(); renderSidebar(); renderChatShell(false);
    follow(tok(`/api/sessions/${s.id}/events`));
    renderSide();
  }
  function openCli(c) {
    closeStream();
    S.cur = {...c, cli: true, title: c.task || c.id}; S.events = [];
    renderTop(); renderSidebar(); renderChatShell(true);
    follow(tok('/api/events?session=' + encodeURIComponent(c.id)));
    renderSide();
  }
  function follow(url) {
    if (window.Flow) Flow.reset();
    const es = S.es = new EventSource(url);
    es.onmessage = m => {
      if (S.es !== es) return;
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      S.events.push(ev); S.lastEv = Date.now();
      S.chat.on(ev);
      if (window.Flow) Flow.on(ev);
      if (ev.type === 'tool_end' && ev.ok !== false) { panelChanged('changes'); panelChanged('files'); }
      if (ev.type === 'turn_end' || ev.type === 'user' || ev.type === 'permission' || ev.type === 'question') { syncBusy(); refresh(); }
    };
  }

  function renderChatShell(readonly) {
    const inner = h('div', {class: 'chat-inner', 'data-testid': 'chat'});
    const todos = h('details', {class: 'todos', id: 'todos', hidden: true, open: true});
    S.chat = new Chat(inner, readonly);
    const center = $('center');
    center.replaceChildren(h('div', {class: 'chat', id: 'chatscroll'}, inner),
      h('div', {class: 'composer-wrap'}, todos, readonly ? cliBar() : composer(), h('div', {class: 'statusline', id: 'statusline'})));
    renderStatus();
  }
  function cliBar() {
    const wfName = S.cur.workflow && S.cur.workflow !== 'loop' && WORKFLOWS[S.cur.workflow] ? WORKFLOWS[S.cur.workflow][0] : '';
    return h('div', {class: 'composer'}, h('div', {class: 'bar'}, h('span', {class: 'muted'},
      wfName ? `${wfName}: a tarefa roda até o fim. As etapas aparecem aqui e no Grafo.` : 'Rodada iniciada pelo CLI: somente leitura.'), h('span', {class: 'grow'}),
      h('button', {class: 'btn stopbtn', id: 'clistop', hidden: S.cur.status && S.cur.status !== 'running', onclick: () => api('/api/stop', {session: S.cur.id}).catch(fail)}, '■ Parar')));
  }
  function renderStatus() {
    const box = $('statusline'); if (!box || !S.cur) return;
    const l = (S.chat && S.chat.last) || {}, s = S.cur;
    const ctx = l.context_window ? Math.round(100 * (l.context_tokens || 0) / l.context_window) : 0;
    box.replaceChildren(h('span', {'data-testid': 'status-model'}, l.model || (s.model && s.model !== 'auto' ? s.model : 'modelos automáticos')), h('span', null, short(s.cwd || '')),
      s.cost ? h('span', null, 'sessão ' + money(s.cost)) : null,
      h('span', {class: 'ctx'}, h('span', {class: 'ctxbar'}, h('i', {style: `width:${Math.min(100, ctx)}%`})), `${ctx}% do contexto`));
  }
  function syncBusy() {
    const busy = !!(S.chat && S.chat.busy);
    const sendBtn = $('sendbtn'), stop = $('stopbtn'), ta = $('prompt');
    if (stop) stop.hidden = !busy;
    if (ta) ta.placeholder = busy ? 'Enviar outra mensagem (fica na fila)…' : 'Responder ao Hangar… (/ comandos, @ arquivos, Ctrl+V cola imagem)';
    if (sendBtn) sendBtn.disabled = false;
  }

  // --------------------------------------------------------------- composer
  function composer() {
    const s = S.cur;
    const ta = h('textarea', {id: 'prompt', rows: 2, 'data-testid': 'prompt', 'aria-label': 'Mensagem'});
    const chips = h('div', {class: 'chips', id: 'atts'});
    const file = h('input', {type: 'file', multiple: true, hidden: true, 'data-testid': 'file-input', onchange: e => { uploadFiles([...e.target.files]); e.target.value = ''; }});
    const up = patch => api(sapi('update'), patch).then(r => { Object.assign(S.cur, r); renderStatus(); }).catch(fail);
    const model = h('button', {class: 'teambtn', title: 'Quem faz o quê nesta sessão', 'data-testid': 'team-btn', onclick: showTeam}, 'Modelos: automático');
    const effort = h('select', {title: 'Esforço', 'aria-label': 'Esforço', onchange: e => up({effort: e.target.value})},
      Object.entries(EFFORTS).map(([v, l]) => h('option', {value: v, selected: v === (s.effort || 'high')}, 'Esforço: ' + l)));
    const perm = h('select', {title: 'Permissões', 'aria-label': 'Permissões', 'data-testid': 'perm', onchange: e => up({permission: e.target.value})},
      Object.entries(PERMS).map(([v, l]) => h('option', {value: v, selected: v === (s.permission || 'ask')}, l)));
    const box = h('div', {class: 'composer', id: 'composer'},
      h('div', {id: 'recbar'}), chips, ta, file,
      h('div', {class: 'bar'},
        h('button', {class: 'icon-btn', title: 'Anexar arquivos', 'aria-label': 'Anexar arquivos', 'data-testid': 'attach', onclick: () => file.click()}, h('span', {html: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3"/></svg>'})),
        h('button', {class: 'icon-btn', title: 'Gravar a tela ou o microfone', 'aria-label': 'Gravar', id: 'recbtn', 'data-testid': 'record', onclick: e => recMenu(e.currentTarget)}, h('span', {html: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="currentColor"/></svg>'})),
        model, effort, perm,
        h('button', {class: 'btn stopbtn', id: 'stopbtn', hidden: true, 'data-testid': 'stop', onclick: () => api(sapi('interrupt'), {}).catch(fail)}, '■ Parar'),
        h('button', {class: 'send', id: 'sendbtn', title: 'Enviar (Enter)', 'aria-label': 'Enviar', 'data-testid': 'send', onclick: () => send()}, '↑')),
      h('datalist', {id: 'models'}, S.models.map(m => h('option', {value: m}))));
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(240, ta.scrollHeight) + 'px'; suggest(ta); });
    ta.addEventListener('keydown', e => {
      if (S.sug && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) { e.preventDefault(); return sugKey(e.key); }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    ta.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); uploadFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `colado-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png')}`, {type: f.type}))); }
    });
    for (const evn of ['dragenter', 'dragover']) box.addEventListener(evn, e => { e.preventDefault(); box.classList.add('drop'); });
    for (const evn of ['dragleave', 'drop']) box.addEventListener(evn, e => { e.preventDefault(); box.classList.remove('drop'); });
    box.addEventListener('drop', e => uploadFiles([...(e.dataTransfer?.files || [])]));
    setTimeout(() => { syncBusy(); renderAtts(); renderRec(); ta.focus(); }, 0);
    return box;
  }
  function teamTable(r) {
    if (!r.team || !r.team.length) return h('div', {class: 'hint'}, r.error || 'A equipe é definida ao iniciar a sessão.');
    return h('table', {class: 'team'}, r.team.map(m => h('tr', null, h('td', {class: 'mono'}, String(m.model).split('/').pop()), h('td', null, m.why))));
  }
  async function showTeam() {
    const s = S.cur; let r = {team: s.team};
    if (!s.team) r = await api('/api/team?cwd=' + encodeURIComponent(s.cwd || '')).catch(e => ({team: [], error: e.message}));
    modal('Equipe de modelos', [h('div', {class: 'muted'}, s.model && s.model !== 'auto' ? `Esta sessão usa o modelo fixo ${s.model}.`
        : 'O Hangar escolhe o modelo de cada papel pelo custo por tarefa resolvida nos nossos benchmarks, e só paga pelo modelo forte quando ele muda o resultado.'),
      teamTable(r), h('div', {class: 'hint'}, 'Para trocar um papel, use a tabela [team] em ~/.hangar/config.toml ou no hangar.toml do projeto.')],
      [{label: 'Fechar', cls: 'primary'}]);
  }
  function renderAtts() {
    const box = $('atts'); if (!box) return;
    box.replaceChildren(...S.atts.map((a, i) => h('span', {class: 'chip' + (a.busy ? ' busy' : ''), title: a.path || a.name, 'data-testid': 'att-chip', 'data-kind': a.kind || ''},
      h('span', {class: 'k'}, a.busy ? `${a.pct || 0}%` : a.kind || ''), h('span', {class: 'n'}, a.name),
      h('button', {'aria-label': 'Remover anexo', onclick: () => { S.atts.splice(i, 1); renderAtts(); }}, '×'))));
  }
  function uploadFiles(files) {
    for (const f of files) {
      const att = {name: f.name, busy: true, pct: 0};
      S.atts.push(att); renderAtts();
      const x = new XMLHttpRequest();
      x.open('POST', sapi('upload', '?name=' + encodeURIComponent(f.name)));
      x.setRequestHeader('X-Hangar-Token', TOKEN);
      x.upload.onprogress = e => { if (e.lengthComputable) { att.pct = Math.round(100 * e.loaded / e.total); renderAtts(); } };
      x.onload = () => {
        let r = {}; try { r = JSON.parse(x.responseText); } catch { /* not json */ }
        if (x.status !== 200) { S.atts.splice(S.atts.indexOf(att), 1); toast(r.error || 'Falha ao enviar o arquivo'); }
        else Object.assign(att, r, {busy: false});
        renderAtts();
      };
      x.onerror = () => { S.atts.splice(S.atts.indexOf(att), 1); renderAtts(); toast('Falha ao enviar o arquivo'); };
      x.send(f);
    }
  }
  async function send(textArg) {
    const ta = $('prompt');
    const text = textArg ?? (ta ? ta.value : '');
    if (S.atts.some(a => a.busy)) return toast('Aguarde o envio dos anexos terminar.');
    const atts = S.atts.map(a => a.path);
    if (!text.trim() && !atts.length) return;
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    S.atts = []; renderAtts(); closeSug();
    try { await api(sapi('send'), {text, attachments: atts}); } catch (e) { fail(e); }
    refresh();
  }

  // slash commands and @file mentions
  let cmdCache = {};
  async function suggest(ta) {
    const upto = ta.value.slice(0, ta.selectionStart);
    const slash = /^\/([\w:.-]*)$/.exec(upto), at = /(^|\s)@([\w./\\-]*)$/.exec(upto);
    if (slash) {
      const id = S.cur.id;
      cmdCache[id] = cmdCache[id] || await api(sapi('commands')).catch(() => []);
      const list = cmdCache[id].filter(c => c.name.startsWith(slash[1]));
      return showSug(ta, list.map(c => ({label: '/' + c.name, desc: c.description || c.hint, pick: () => { ta.value = '/' + c.name + ' '; }})));
    }
    if (at && at[2].length >= 1) {
      const list = await api(sapi('find', '?q=' + encodeURIComponent(at[2]))).catch(() => []);
      return showSug(ta, list.slice(0, 12).map(f => ({label: f.path, pick: () => {
        const start = upto.length - at[2].length - 1;
        ta.value = ta.value.slice(0, start) + f.path + ' ' + ta.value.slice(ta.selectionStart);
      }})));
    }
    closeSug();
  }
  function showSug(ta, items) {
    closeSug(); if (!items.length) return;
    const m = h('div', {class: 'menu', 'data-testid': 'suggest'}, items.map((it, i) => h('button', {class: i === 0 ? 'on' : '', onmousedown: e => { e.preventDefault(); pickSug(i); }},
      h('span', {class: 'mono'}, it.label), it.desc ? h('span', {class: 'd'}, it.desc) : null)));
    $('composer').append(m); m.style.left = '8px'; m.style.bottom = ($('composer').offsetHeight + 4) + 'px';
    S.sug = {m, items, i: 0, ta};
  }
  function closeSug() { if (S.sug) { S.sug.m.remove(); S.sug = null; } }
  function pickSug(i) { const g = S.sug; if (!g) return; g.items[i].pick(); closeSug(); g.ta.focus(); }
  function sugKey(key) {
    const g = S.sug;
    if (key === 'Escape') return closeSug();
    if (key === 'Enter' || key === 'Tab') return pickSug(g.i);
    g.m.children[g.i].classList.remove('on');
    g.i = (g.i + (key === 'ArrowDown' ? 1 : -1) + g.items.length) % g.items.length;
    g.m.children[g.i].classList.add('on'); g.m.children[g.i].scrollIntoView({block: 'nearest'});
  }

  // -------------------------------------------------------------- recording
  function recMenu(anchor) {
    if (S.rec) return;
    menu(anchor, [
      {label: 'Gravar a tela e o microfone', desc: 'vídeo .webm anexado à mensagem', run: () => startRec('screen')},
      {label: 'Gravar só o microfone', desc: 'áudio .webm anexado à mensagem', run: () => startRec('mic')}
    ]);
  }
  async function startRec(mode) {
    if (S.rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Este navegador não grava tela nem microfone.');
    const streams = [];
    const stopAll = () => streams.forEach(st => st.getTracks().forEach(t => t.stop()));
    try {
      let screen = null, mic = null, note = '';
      if (mode === 'screen') { screen = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: 15}, audio: true}); streams.push(screen); }
      try { mic = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: false}); streams.push(mic); }
      catch (e) { if (mode === 'mic') throw e; note = 'O microfone não ligou: a gravação segue só com a tela.'; }
      let stream, ctx = null;
      const audioSources = [screen, mic].filter(st => st && st.getAudioTracks().length);
      if (mode === 'mic') stream = mic;
      else if (audioSources.length) {
        ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        audioSources.forEach(st => ctx.createMediaStreamSource(new MediaStream(st.getAudioTracks())).connect(dest));
        stream = new MediaStream([...screen.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      } else stream = new MediaStream(screen.getVideoTracks());
      const types = mode === 'mic' ? ['audio/webm;codecs=opus', 'audio/webm'] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, {mimeType, ...(mode === 'mic' ? {audioBitsPerSecond: 48000} : {videoBitsPerSecond: 1500000})});
      const R = S.rec = {rec, mode, chunks: [], t0: Date.now(), paused: 0, pausedAt: 0, discard: false, sessionId: S.cur.id, hasMic: !!mic, note};
      rec.ondataavailable = e => { if (e.data && e.data.size) R.chunks.push(e.data); };
      rec.onstop = () => {
        stopAll(); if (ctx) ctx.close(); clearInterval(R.timer); S.rec = null; renderRec();
        if (R.discard) return;
        const blob = new Blob(R.chunks, {type: rec.mimeType || (mode === 'mic' ? 'audio/webm' : 'video/webm')});
        if (!blob.size) return toast('A gravação saiu vazia.');
        if (!S.cur || S.cur.id !== R.sessionId) return toast('A gravação foi descartada: a sessão mudou.');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        uploadFiles([new File([blob], `${mode === 'mic' ? 'audio' : 'gravacao'}-${stamp}.webm`, {type: blob.type})]);
      };
      if (screen) screen.getVideoTracks()[0].addEventListener('ended', () => stopRec());   // "Parar compartilhamento" do navegador
      rec.start(1000);
      R.timer = setInterval(renderRec, 500);
      renderRec();
      if (note) toast(note);
    } catch (e) {
      stopAll(); S.rec = null; renderRec();
      toast(e.name === 'NotAllowedError' ? 'Permissão negada para gravar.' : `Não foi possível gravar: ${e.message}`);
    }
  }
  function stopRec(discard) { const R = S.rec; if (!R) return; R.discard = !!discard; if (R.rec.state !== 'inactive') R.rec.stop(); }
  function pauseRec() {
    const R = S.rec; if (!R) return;
    if (R.rec.state === 'recording') { R.rec.pause(); R.pausedAt = Date.now(); }
    else if (R.rec.state === 'paused') { R.rec.resume(); R.paused += Date.now() - R.pausedAt; R.pausedAt = 0; }
    renderRec();
  }
  function renderRec() {
    const box = $('recbar'), btn = $('recbtn'); if (!box) return;
    const R = S.rec;
    if (btn) btn.style.color = R ? 'var(--stop)' : '';
    if (!R) return box.replaceChildren();
    const el = Math.floor(((R.pausedAt || Date.now()) - R.t0 - R.paused) / 1000);
    const time = String(Math.floor(el / 60)).padStart(2, '0') + ':' + String(el % 60).padStart(2, '0');
    const paused = R.rec.state === 'paused';
    box.replaceChildren(h('div', {class: 'recbar' + (paused ? ' paused' : ''), 'data-testid': 'recbar'}, h('span', {class: 'live'}),
      h('span', null, R.mode === 'mic' ? 'Gravando o microfone' : R.hasMic ? 'Gravando a tela e o microfone' : 'Gravando a tela'),
      h('span', {class: 'time', 'data-testid': 'rec-time'}, time), h('span', {class: 'grow'}),
      h('button', {class: 'btn small', onclick: pauseRec}, paused ? 'Continuar' : 'Pausar'),
      h('button', {class: 'btn small primary', 'data-testid': 'rec-stop', onclick: () => stopRec(false)}, 'Parar e anexar'),
      h('button', {class: 'btn small danger', onclick: () => stopRec(true)}, 'Descartar')));
  }

  // ------------------------------------------------------------ side panels
  function openSide(tab) { S.tab = tab; S.sideOpen = true; localStorage.setItem('hangarTab', tab); localStorage.setItem('hangarSide', '1'); renderTop(); renderSide(); }
  function closeSide() { S.sideOpen = false; localStorage.setItem('hangarSide', '0'); renderTop(); renderSide(); }
  const dirty = {};
  function panelChanged(tab) { dirty[tab] = true; if (S.sideOpen && S.tab === tab) { clearTimeout(panelChanged['t' + tab]); panelChanged['t' + tab] = setTimeout(() => PANELS[tab] && PANELS[tab](true), 350); } }
  function renderSide() {
    const side = $('side');
    if (S.cur && S.cur.cli && S.tab !== 'flow') S.tab = 'flow';
    side.hidden = !S.sideOpen || !S.cur;
    side.style.width = S.sideW + 'px';
    if (side.hidden) return;
    const body = $('sidebody');
    if (S.tab === 'flow') { flowHost.hidden = false; if (!body.contains(flowHost) || body.children.length !== 1) body.replaceChildren(flowHost); Flow.redraw(); return; }
    body.replaceChildren(h('div', {class: 'panel', id: 'panel', 'data-testid': 'panel-' + S.tab}));
    PANELS[S.tab](false);
  }
  const panel = () => $('panel');

  const flowHost = h('div', {id: 'flowhost', 'data-testid': 'panel-flow'});
  const flowInner = h('div', {style: 'flex:1;display:flex;flex-direction:column;min-height:0'});
  const flowDetail = h('div', {class: 'flowdetail', hidden: true});
  flowHost.append(flowInner, flowDetail);
  Flow.mount(flowInner, n => { flowDetail.hidden = false; flowDetail.textContent = (n.title || '') + (n.ms != null ? ` · ${n.ms} ms` : '') + '\n' + (n.tip || ''); });

  const PANELS = {
    async files(soft) {
      const p = panel(); if (!p || S.tab !== 'files') return;
      const st = S.panel.files = S.panel.files && S.panel.files.id === S.cur.id ? S.panel.files : {id: S.cur.id, open: {}, q: '', sel: null};
      if (soft && p.querySelector('.split')) return loadTree();
      const filter = h('input', {class: 'field', placeholder: 'Filtrar arquivos por nome…', value: st.q, 'data-testid': 'files-filter',
        oninput: e => { st.q = e.target.value; clearTimeout(filter._t); filter._t = setTimeout(loadTree, 200); }});
      const tree = h('div', {class: 'top', id: 'ftree'}), view = h('div', {class: 'viewer', id: 'fview'});
      p.replaceChildren(h('div', {class: 'pbar', style: 'flex-wrap:nowrap'}, h('div', {class: 'grow'}, filter), h('button', {class: 'icon-btn', title: 'Atualizar', 'aria-label': 'Atualizar', onclick: () => loadTree()}, '⟳')),
        h('div', {class: 'split'}, tree, view));
      async function loadTree() {
        const box = $('ftree'); if (!box) return;
        try {
          if (st.q.trim()) return box.replaceChildren(...(await api(sapi('find', '?q=' + encodeURIComponent(st.q)))).map(f => fileRow(f, 0)));
          const rows = [];
          const walk = async (path, depth) => {
            for (const f of await api(sapi('tree', '?path=' + encodeURIComponent(path)))) {
              rows.push(fileRow(f, depth));
              if (f.dir && st.open[f.path]) await walk(f.path, depth + 1);
            }
          };
          await walk('', 0);
          box.replaceChildren(...(rows.length ? rows : [h('div', {class: 'pempty'}, 'A pasta está vazia.')]));
        } catch (e) { box.replaceChildren(h('div', {class: 'pempty'}, e.message)); }
      }
      function fileRow(f, depth) {
        return h('button', {class: 'rowbtn' + (st.sel === f.path ? ' on' : ''), style: `padding-left:${10 + depth * 14}px`, 'data-testid': 'file-row', 'data-path': f.path,
          onclick: () => { if (f.dir) { st.open[f.path] = !st.open[f.path]; loadTree(); } else { st.sel = f.path; loadTree(); showFile($('fview'), f.path); } }},
          h('span', {class: 'ic'}, f.dir ? (st.open[f.path] ? '▾' : '▸') : '·'), h('span', {class: 'n'}, st.q ? f.path : f.name));
      }
      await loadTree();
      if (st.sel) showFile(view, st.sel); else view.replaceChildren(h('div', {class: 'pempty'}, 'Escolha um arquivo para ver o conteúdo.'));
    },
    async changes() {
      const p = panel(); if (!p || S.tab !== 'changes') return;
      let g; try { g = await api(sapi('git')); } catch (e) { return p.replaceChildren(h('div', {class: 'pempty'}, e.message)); }
      if (S.tab !== 'changes' || !panel()) return;
      if (!g.repo) return p.replaceChildren(h('div', {class: 'pbar'}, h('strong', null, 'Alterações')),
        h('div', {class: 'pempty'}, 'Esta pasta não é um repositório git. Rode `git init` para acompanhar as alterações aqui.'));
      const st = S.panel.changes = S.panel.changes || {};
      const view = h('div', {class: 'viewer'});
      const show = f => { st.sel = f.path; view.replaceChildren(h('div', {class: 'fhead'}, h('span', {class: 'st ' + (f.status === '?' ? 'q' : f.status)}, f.status), f.path),
        f.diff ? diffBox(f.diff.split('\n').filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l))) : h('div', {class: 'pempty'}, 'Sem diferenças de texto.')); };
      p.replaceChildren(h('div', {class: 'pbar'}, h('strong', null, 'Alterações'), h('span', {class: 'muted mono'}, g.branch), h('span', {class: 'grow'}),
          h('span', {class: 'muted'}, `${g.files.length} arquivo${g.files.length === 1 ? '' : 's'}`), h('button', {class: 'icon-btn', title: 'Atualizar', 'aria-label': 'Atualizar', onclick: () => PANELS.changes()}, '⟳')),
        g.files.length ? h('div', {class: 'split'}, h('div', {class: 'top'}, g.files.map(f => h('button', {class: 'rowbtn' + (st.sel === f.path ? ' on' : ''), 'data-testid': 'change-row', onclick: e => {
            show(f); e.currentTarget.parentElement.querySelectorAll('.on').forEach(x => x.classList.remove('on')); e.currentTarget.classList.add('on'); }},
            h('span', {class: 'st ' + (f.status === '?' ? 'q' : f.status)}, f.status), h('span', {class: 'n'}, f.path)))), view)
          : h('div', {class: 'pempty'}, 'Nenhuma alteração em relação ao último commit.'));
      const first = g.files.find(f => f.path === st.sel) || g.files[0]; if (first) show(first);
    },
    terminal() {
      const p = panel(); if (!p) return;
      const T = S.term[S.cur.id] = S.term[S.cur.id] || {out: [], hist: [], running: null};
      const out = h('div', {class: 'term', 'data-testid': 'term-out'});
      const paint = () => { out.replaceChildren(...T.out.map(o => h('span', {class: o.c || ''}, o.t))); out.scrollTop = out.scrollHeight; };
      const input = h('input', {placeholder: 'comando (roda na pasta da sessão)', 'data-testid': 'term-in', 'aria-label': 'Comando'});
      let hi = -1;
      const run = async cmd => {
        if (!cmd.trim() || T.running) return;
        T.hist.unshift(cmd); hi = -1; T.out.push({t: `$ ${cmd}\n`, c: 'cmd'}); paint();
        T.running = 'x'; kill.hidden = false;
        try {
          const r = await fetch(sapi('terminal'), {method: 'POST', headers: {'X-Hangar-Token': TOKEN, 'Content-Type': 'application/json'}, body: JSON.stringify({command: cmd})});
          const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
          for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            buf += dec.decode(value, {stream: true});
            let i; while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line) continue;
              const m = JSON.parse(line);
              if (m.type === 'start') T.running = m.id;
              else if (m.type === 'out') T.out.push({t: m.text});
              else if (m.type === 'exit') T.out.push({t: `[saiu com código ${m.code}]${m.text ? ' ' + m.text : ''}\n`, c: 'exit' + (m.code ? ' bad' : '')});
              if (T.out.length > 3000) T.out.splice(0, T.out.length - 3000);
              if ($('panel') && $('panel').contains(out)) paint();
            }
          }
        } catch (e) { T.out.push({t: `[erro: ${e.message}]\n`, c: 'exit bad'}); }
        T.running = null; kill.hidden = true; paint(); panelChanged('changes');
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { const v = input.value; input.value = ''; run(v); }
        else if (e.key === 'ArrowUp' && T.hist.length) { hi = Math.min(T.hist.length - 1, hi + 1); input.value = T.hist[hi]; e.preventDefault(); }
        else if (e.key === 'ArrowDown') { hi = Math.max(-1, hi - 1); input.value = hi < 0 ? '' : T.hist[hi]; e.preventDefault(); }
      });
      const kill = h('button', {class: 'btn small danger', hidden: !T.running, onclick: () => T.running && api(sapi('kill'), {id: T.running}).catch(fail)}, '■ Parar');
      p.replaceChildren(h('div', {class: 'pbar'}, h('strong', null, 'Terminal'), h('span', {class: 'muted mono'}, short(S.cur.cwd)), h('span', {class: 'grow'}), kill,
          h('button', {class: 'btn small', onclick: () => { T.out = []; paint(); }}, 'Limpar')),
        out, h('div', {class: 'termin'}, '$', input));
      paint(); input.focus();
    },
    browser() {
      const p = panel(); if (!p) return;
      const st = S.panel.browser = S.panel.browser || {url: ''};
      const frame = h('iframe', {class: 'frame', 'data-testid': 'browser-frame', referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups'});
      const url = h('input', {class: 'field mono', placeholder: 'http://localhost:3000', value: st.url, 'data-testid': 'browser-url', 'aria-label': 'Endereço'});
      const go = () => { let u = url.value.trim(); if (!u) return; if (!/^https?:\/\//.test(u)) u = 'http://' + u; st.url = u; PANELS.browser(); };
      url.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      p.replaceChildren(h('div', {class: 'pbar'}, h('button', {class: 'icon-btn', title: 'Recarregar', 'aria-label': 'Recarregar', onclick: go}, '⟳'), h('div', {class: 'grow'}, url),
          h('button', {class: 'btn small', onclick: () => st.url && window.open(st.url, '_blank', 'noopener')}, 'Abrir fora')),
        st.url ? frame : h('div', {class: 'pempty'}, 'Digite o endereço de um servidor local (por exemplo o `npm run dev` do projeto) para ver a página ao lado da conversa. Sites que proíbem ser embutidos não abrem aqui: use "Abrir fora".'));
      if (st.url) frame.src = st.url;
    },
    artifacts(soft) {
      const p = panel(); if (!p || S.tab !== 'artifacts') return;
      const exts = /\.(html?|svg|md|png|jpe?g|gif|webp|pdf|mp4|webm)$/i;
      const files = [...((S.chat && S.chat.files) || [])].filter(f => exts.test(f)).reverse();
      const st = S.panel.artifacts = S.panel.artifacts && S.panel.artifacts.id === S.cur.id ? S.panel.artifacts : {id: S.cur.id, sel: null};
      if (!files.length) return p.replaceChildren(h('div', {class: 'pbar'}, h('strong', null, 'Artifacts')),
        h('div', {class: 'pempty'}, 'Páginas HTML, SVGs, Markdown, imagens e vídeos que o agente criar nesta sessão aparecem aqui, prontos para ver.'));
      if (!st.sel || !files.includes(st.sel)) st.sel = files[0];
      if (soft && p.dataset.sel === st.sel && p.dataset.n === String(files.length)) { const fr = p.querySelector('iframe'); if (fr) fr.src = fr.src; return; }
      p.dataset.sel = st.sel; p.dataset.n = String(files.length);
      const view = h('div', {class: 'viewer', style: 'display:flex;flex-direction:column'});
      p.replaceChildren(h('div', {class: 'pbar'}, h('strong', null, 'Artifacts'), h('span', {class: 'grow'}),
          h('button', {class: 'btn small', onclick: () => api(sapi('open'), {path: st.sel}).catch(fail)}, 'Abrir no sistema')),
        h('div', {class: 'split'}, h('div', {class: 'top'}, files.map(f => h('button', {class: 'rowbtn' + (f === st.sel ? ' on' : ''), 'data-testid': 'artifact-row', onclick: () => { st.sel = f; p.dataset.sel = ''; PANELS.artifacts(); }},
          h('span', {class: 'ic'}, '◇'), h('span', {class: 'n'}, short(f))))), view));
      showFile(view, st.sel, true);
    },
    async harness() {
      const p = panel(); if (!p || S.tab !== 'harness') return;
      let d; try { d = await api(sapi('harness')); } catch (e) { return p.replaceChildren(h('div', {class: 'pempty'}, e.message)); }
      if (S.tab !== 'harness' || !panel()) return;
      const sec = (title, items, render, empty) => [h('div', {class: 'hsec'}, `${title} (${items.length})`), ...(items.length ? items.map(render) : [h('div', {class: 'hitem muted'}, empty)])];
      const edit = async rel => {
        let text = ''; try { text = (await api(sapi('file', '?path=' + encodeURIComponent(rel)))).text || ''; } catch { /* a new file */ }
        const ta = h('textarea', {class: 'editor', 'data-testid': 'harness-editor', spellcheck: 'false'}); ta.value = text;
        p.replaceChildren(h('div', {class: 'pbar'}, h('button', {class: 'btn small', onclick: () => PANELS.harness()}, '← Voltar'), h('span', {class: 'mono grow'}, rel),
          h('button', {class: 'btn small primary', 'data-testid': 'harness-save', onclick: () => api(sapi('save'), {path: rel, text: ta.value}).then(() => toast('Salvo.')).catch(fail)}, 'Salvar')), ta);
      };
      p.replaceChildren(h('div', {class: 'pbar'}, h('strong', null, 'Harness do projeto'), h('span', {class: 'grow'}),
          h('button', {class: 'btn small', onclick: () => prompt2('Novo arquivo do harness', '.claude/commands/novo.md', edit)}, '＋ Arquivo'),
          !d.files.includes('HANGAR.md') && !d.files.includes('CLAUDE.md') && !d.files.includes('AGENTS.md') ? h('button', {class: 'btn small', onclick: () => edit('HANGAR.md')}, 'Criar HANGAR.md') : null),
        h('div', {class: 'pscroll'},
          ...sec('Arquivos', d.files, f => h('button', {class: 'rowbtn', 'data-testid': 'harness-file', onclick: () => edit(f)}, h('span', {class: 'ic'}, '·'), h('span', {class: 'n'}, f)),
                 'Nenhum arquivo de harness nesta pasta (HANGAR.md, CLAUDE.md, .claude/…).'),
          ...sec('Sub-agentes', d.agents, a => h('div', {class: 'hitem'}, h('b', null, a.name), ' — ', a.description), 'Defina em .claude/agents/<nome>.md.'),
          ...sec('Comandos de barra', d.commands, c => h('div', {class: 'hitem'}, h('b', null, '/' + c.name), ' ', c.hint || '', c.description ? ' — ' + c.description : ''), 'Defina em .claude/commands/<nome>.md.'),
          ...sec('Skills', d.skills, k => h('div', {class: 'hitem'}, h('b', null, k.name), ' — ', k.description), 'Nenhuma skill encontrada.'),
          ...sec('Hooks', Object.entries(d.hooks).filter(([, n]) => n), ([k, n]) => h('div', {class: 'hitem'}, h('b', null, k), ` — ${n} regra${n > 1 ? 's' : ''}`), 'Nenhum hook em .claude/settings.json.'),
          ...sec('Lições aprendidas', d.lessons, l => h('div', {class: 'hitem'}, h('b', null, l.cue || l.task || 'lição'), ' — ', l.lesson), 'As lições de sessões anteriores aparecem aqui.')));
    }
  };

  async function showFile(view, path, artifact) {
    view.replaceChildren(h('div', {class: 'pempty'}, 'Carregando…'));
    let f; try { f = await api(sapi('file', '?path=' + encodeURIComponent(path))); } catch (e) { return view.replaceChildren(h('div', {class: 'pempty'}, e.message)); }
    const raw = tok(sapi('raw', '?path=' + encodeURIComponent(path)));
    const head = h('div', {class: 'fhead'}, h('span', {class: 'grow', 'data-testid': 'file-name'}, f.name), h('span', {class: 'muted'}, kfmt(f.size) + ' B'),
      h('button', {class: 'btn small', onclick: () => navigator.clipboard.writeText(f.path).then(() => toast('Caminho copiado.'), () => toast(f.path))}, 'Copiar caminho'),
      h('button', {class: 'btn small', onclick: () => api(sapi('open'), {path}).catch(fail)}, 'Abrir no editor'));
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    let bodyEl;
    if (f.kind === 'image') bodyEl = h('img', {class: 'media', src: raw, alt: f.name});
    else if (f.kind === 'video') bodyEl = h('video', {class: 'media', src: raw, controls: true});
    else if (f.kind === 'audio') bodyEl = h('audio', {class: 'media', src: raw, controls: true});
    else if (artifact && (ext === 'html' || ext === 'htm' || ext === 'svg' || ext === 'pdf')) bodyEl = h('iframe', {class: 'frame', src: raw, sandbox: 'allow-scripts allow-forms allow-popups', 'data-testid': 'artifact-frame'});
    else if (artifact && ext === 'md' && f.text !== undefined) bodyEl = h('div', {class: 'md', style: 'padding:14px 18px', html: md(f.text)});
    else if (f.text !== undefined) {
      const lines = f.text.split('\n');
      bodyEl = h('div', {class: 'code', 'data-testid': 'file-code'}, h('div', {class: 'ln'}, lines.map((_, i) => i + 1).join('\n')), h('div', {class: 'tx'}, f.text + (f.truncated ? '\n… (arquivo cortado)' : '')));
      bodyEl.firstChild.style.whiteSpace = 'pre';
    } else bodyEl = h('div', {class: 'pempty'}, 'Arquivo binário: use "Abrir no editor".');
    view.replaceChildren(head, bodyEl);
  }

  // ----------------------------------------------------------------- resize
  $('resizer').addEventListener('pointerdown', e => {
    const x0 = e.clientX, w0 = S.sideW;
    const move = ev => { S.sideW = Math.min(Math.max(w0 + (x0 - ev.clientX), 320), innerWidth - 420); $('side').style.width = S.sideW + 'px'; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); localStorage.setItem('hangarSideW', S.sideW); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newSession(); }
    else if (e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSidebar(); }
    else if (e.key === 'Escape') { if ($('overlay').children.length) $('overlay').replaceChildren(); closeMenu(); }
  });
  addEventListener('beforeunload', e => { if (S.rec) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------------- boot
  (async () => {
    renderTop();
    await refresh();
    renderNew();
    startPolling();
    api('/api/models').then(m => { S.models = m; document.querySelectorAll('#models').forEach(d => d.replaceChildren(...m.map(x => h('option', {value: x})))); }).catch(() => {});
    const want = new URLSearchParams(location.search).get('session');
    const s = want && S.state.sessions.find(x => x.id === want);
    if (s) openSession(s);
  })();
})();
