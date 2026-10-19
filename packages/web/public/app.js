// Dashboard. Plain ES modules, no build step. Every request goes to /api (the backend).
// All text from agents is inserted with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const state = { agent: null, session: null, lastSeq: 0, dStreaming: null };

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = ok ? 'ok' : '';
  t.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = 'none'), 4000);
}

const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message);
  }
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// -- instances ------------------------------------------------------------

async function loadAgents() {
  const { instances, types } = await api('GET', '/api/instances');
  $('types').replaceChildren(...types.map((t) => Object.assign(el('option', null, t), { value: t })));
  const ul = $('agents');
  ul.replaceChildren();
  for (const i of instances) {
    const li = el('li', i.id === state.agent ? 'sel' : '');
    const left = el('div');
    left.append(
      el('span', 'dot' + (i.busy ? ' busy' : i.alive ? ' on' : '')),
      i.id,
      el('small', null, `${i.type}${i.custom ? ' · 自建' : ''} · ${i.cwd ?? '(基准目录)'}`),
    );
    li.append(left);
    if (i.custom) {
      const rm = el('button', null, '删');
      rm.onclick = guard(async (ev) => {
        ev.stopPropagation();
        await api('DELETE', `/api/instances/${encodeURIComponent(i.id)}`);
        if (state.agent === i.id) await selectAgent(null);
        await loadAgents();
      });
      li.append(rm);
    }
    li.onclick = guard(() => selectAgent(i.id));
    ul.append(li);
  }
}

$('form-instance').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', '/api/instances', f);
  e.target.reset();
  toast('已创建', true);
  await loadAgents();
});

// -- sessions and transcript ----------------------------------------------

async function selectAgent(id) {
  state.agent = id;
  state.session = null;
  $('session-title').textContent = id ?? '选择一个实例';
  $('transcript').replaceChildren();
  $('sessions').replaceChildren();
  await loadAgents();
  if (!id) return;
  const { sessions } = await api('GET', `/api/agents/${encodeURIComponent(id)}/sessions`);
  const ul = $('sessions');
  for (const s of sessions) {
    const li = el('li', null);
    const d = el('div', null, s.label || s.title || s.sessionId.slice(0, 8));
    d.append(el('small', null, `${s.updatedAt ?? ''}${s.active ? ' · 活跃' : ''}`));
    li.append(d);
    li.onclick = guard(() => selectSession(s.sessionId));
    ul.append(li);
  }
  const active = sessions.find((s) => s.active) ?? sessions[0];
  if (active) await selectSession(active.sessionId);
}

async function selectSession(sid) {
  state.session = sid;
  state.lastSeq = 0;
  $('transcript').replaceChildren();
  await pullTranscript();
}

function addMessage(box, role, text, meta) {
  const m = el('div', `msg ${role}`);
  m.append(el('small', null, meta ?? role), document.createTextNode(text));
  box.append(m);
  box.scrollTop = box.scrollHeight;
  return m;
}

async function pullTranscript() {
  if (!state.agent || !state.session) return;
  const q = state.lastSeq ? `?afterSeq=${state.lastSeq}` : '';
  const base = `/api/agents/${encodeURIComponent(state.agent)}/sessions/${encodeURIComponent(state.session)}`;
  const r = await api('GET', `${base}/transcript${q}`);
  if (!r.recorded && !state.lastSeq) {
    addMessage($('transcript'), 'tool', '这个会话没有经过 agentd，没有对话记录。', '提示');
    return;
  }
  for (const e of r.entries) {
    addMessage($('transcript'), e.role, e.text ?? '', `${e.role} · #${e.seq}${e.stopReason ? ' · ' + e.stopReason : ''}`);
    state.lastSeq = Math.max(state.lastSeq, e.seq);
  }
}

$('form-run').onsubmit = guard(async (e) => {
  e.preventDefault();
  if (!state.agent) throw new Error('先选一个实例');
  const prompt = e.target.prompt.value.trim();
  if (!prompt) return;
  e.target.prompt.value = '';
  await api('POST', `/api/agents/${encodeURIComponent(state.agent)}/run`, {
    prompt,
    sessionId: state.session || undefined,
  });
});

// -- dispatcher -------------------------------------------------------------

async function loadDispatcher() {
  const m = await api('GET', '/api/dispatcher/models');
  $('dmodels').replaceChildren(
    ...m.models.map((x) => Object.assign(el('option', null, x.value), { value: x.value, selected: x.value === m.current })),
  );
  await refreshDState();
  const msgs = await api('GET', '/api/dispatcher/messages');
  $('dlog').replaceChildren();
  for (const msg of msgs.messages) renderPiMessage(msg);
  await loadLlms();
}

async function refreshDState() {
  const s = await api('GET', '/api/dispatcher');
  $('dstate').textContent = s.alive ? `pid ${s.pid} · ${s.messageCount} 条消息 · ${s.thinkingLevel ?? ''}` : '未启动';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `→ ${c.name}(${JSON.stringify(c.arguments ?? {}).slice(0, 300)})` : ''))
    .filter(Boolean)
    .join('\n');
}

function renderPiMessage(msg) {
  const box = $('dlog');
  if (msg.role === 'user') addMessage(box, 'user', textOf(msg.content), '你');
  else if (msg.role === 'assistant') {
    const t = textOf(msg.content);
    if (t) addMessage(box, 'assistant', t, `调度器${msg.model ? ' · ' + msg.model : ''}`);
  } else if (msg.role === 'toolResult') {
    addMessage(box, 'tool', textOf(msg.content).slice(0, 800), `工具结果 · ${msg.toolName ?? ''}`);
  }
}

$('dmodels').onchange = guard(async (e) => {
  await api('POST', '/api/dispatcher/model', { value: e.target.value });
  toast('已切换', true);
  await refreshDState();
});

$('dnew').onclick = guard(async () => {
  await api('POST', '/api/dispatcher/new');
  $('dlog').replaceChildren();
  await refreshDState();
});

$('dabort').onclick = guard(() => api('POST', '/api/dispatcher/abort'));

$('form-dispatch').onsubmit = guard(async (e) => {
  e.preventDefault();
  const message = e.target.message.value.trim();
  if (!message) return;
  e.target.message.value = '';
  addMessage($('dlog'), 'user', message, '你');
  state.dStreaming = null;
  await api('POST', '/api/dispatcher/prompt', { message });
});

async function loadLlms() {
  const l = await api('GET', '/api/dispatcher/llms');
  $('llms').textContent = l.providers.length
    ? l.providers.map((p) => `${p.provider}  ${p.baseUrl}  key:${p.apiKey}\n  ${p.models.map((m) => m.id).join(', ')}`).join('\n')
    : '（models.json 里还没有自定义 LLM）';
}

$('form-llm').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await api('POST', '/api/dispatcher/llms', {
      provider: f.provider,
      baseUrl: f.baseUrl,
      apiKey: f.apiKey,
      models: [{ id: f.model }],
    });
    e.target.reset();
    toast('已添加，调度器已重启', true);
    await loadDispatcher();
  } finally {
    btn.disabled = false;
  }
});

// -- live events ------------------------------------------------------------

function onDispatcherEvent(d) {
  const box = $('dlog');
  if (d.type === 'message_update' && d.kind === 'text_delta') {
    if (!state.dStreaming) state.dStreaming = addMessage(box, 'assistant', '', '调度器');
    state.dStreaming.append(document.createTextNode(d.delta));
    box.scrollTop = box.scrollHeight;
  } else if (d.type === 'tool_execution_start') {
    state.dStreaming = null;
    addMessage(box, 'tool', `${d.toolName}(${JSON.stringify(d.args ?? {}).slice(0, 300)})`, '调用工具');
  } else if (d.type === 'agent_settled') {
    state.dStreaming = null;
    refreshDState().catch(() => {});
    loadAgents().catch(() => {});
    pullTranscript().catch(() => {});
  } else if (d.type === 'dispatcher_exit') {
    toast(`调度器进程退出（code ${d.code}）`);
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    $('conn').textContent = '已连接';
  };
  es.onerror = () => {
    $('conn').textContent = '重连中…';
  };
  es.addEventListener('dispatcher.event', (m) => onDispatcherEvent(JSON.parse(m.data).data ?? {}));
  for (const name of ['job.started', 'job.done', 'agent.exit']) {
    es.addEventListener(name, (m) => {
      const ev = JSON.parse(m.data);
      loadAgents().catch(() => {});
      if (name === 'job.done' && ev.agent === state.agent) pullTranscript().catch(() => {});
    });
  }
}

guard(async () => {
  await loadAgents();
  connectEvents();
  await loadDispatcher();
})();
