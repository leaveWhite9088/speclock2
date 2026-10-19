// Dashboard. Plain ES modules, no build step. Every request goes to /api (the backend).
// All text from agents is inserted with textContent, never as HTML.
//
// Model: a project owns a dispatcher and its instances. Switching project only changes
// what this page shows; the other projects keep running in the background.

const $ = (id) => document.getElementById(id);
const state = {
  project: localStorage.getItem('project') ?? '', // '' = the global (no project) view
  projects: [],
  agent: null, // pool key of the selected instance
  session: null,
  lastSeq: 0,
  dStreaming: null,
};

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

/** Query string that picks this project's dispatcher. */
const pq = () => (state.project ? `?project=${encodeURIComponent(state.project)}` : '');
const enc = encodeURIComponent;

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

// -- projects ---------------------------------------------------------------

async function loadProjects() {
  const r = await api('GET', '/api/projects');
  state.projects = r.projects;
  if (state.project && !r.projects.some((p) => p.id === state.project)) state.project = '';
  const sel = $('project');
  sel.replaceChildren(
    Object.assign(el('option', null, '（全局，无项目）'), { value: '' }),
    ...r.projects.map((p) => Object.assign(el('option', null, `${p.name}${p.busy ? ' · 运行中' : ''}`), { value: p.id })),
  );
  sel.value = state.project;
  $('limits').textContent = `进程 ${r.limits.alive}/${r.limits.maxProcesses} · 空闲 ${r.limits.idleMinutes} 分钟回收`;
  const has = Boolean(state.project);
  $('btn-stop').style.display = has ? '' : 'none';
  $('btn-delete').style.display = has ? '' : 'none';
  $('dir-input').placeholder = has ? '相对项目根目录，例如 ./server' : '目录（绝对路径）';
  $('dispatcher-title').textContent = has ? `调度器（pi）· ${state.project}` : '调度器（pi）· 全局';
  $('agents-title').textContent = has ? `实例 · ${r.projects.find((p) => p.id === state.project)?.root ?? ''}` : '实例（全局）';
}

$('project').onchange = guard(async (e) => {
  // Switching is only a change of view: nothing is stopped, so no confirmation is needed.
  state.project = e.target.value;
  localStorage.setItem('project', state.project);
  await switchView();
});

$('form-project').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', '/api/projects', { id: f.id, name: f.name || f.id, root: f.root });
  e.target.reset();
  $('new-project').open = false;
  state.project = f.id;
  localStorage.setItem('project', f.id);
  toast('项目已创建', true);
  await switchView();
});

/** Ask first; when something is still running, say what and ask again with force. */
async function confirmedAction(label, run) {
  try {
    await run(false);
  } catch (err) {
    if (!/running/.test(err.message)) throw err;
    if (!confirm(`${label}\n\n还有任务在运行：${err.message}\n\n继续会中断它们。确定吗？`)) return false;
    await run(true);
  }
  return true;
}

$('btn-stop').onclick = guard(async () => {
  if (!confirm(`关闭项目「${state.project}」？\n\n会停掉它的调度器和所有实例进程。配置和会话都保留，下次用到时自动重新拉起。`)) return;
  await confirmedAction('关闭项目', (force) => api('POST', `/api/projects/${enc(state.project)}/stop`, { force }));
  toast('已关闭', true);
  await refreshAll();
});

$('btn-delete').onclick = guard(async () => {
  if (!confirm(`删除项目「${state.project}」的配置？\n\n会停掉它的所有进程并移除实例清单。项目目录里的文件不会被动。`)) return;
  const done = await confirmedAction('删除项目', (force) =>
    api('DELETE', `/api/projects/${enc(state.project)}${force ? '?force=1' : ''}`),
  );
  if (!done) return;
  state.project = '';
  localStorage.setItem('project', '');
  toast('已删除', true);
  await switchView();
});

// -- instances --------------------------------------------------------------

async function currentInstances() {
  if (state.project) return state.projects.find((p) => p.id === state.project)?.instances ?? [];
  const { instances } = await api('GET', '/api/instances');
  return instances.filter((i) => !i.project).map((i) => ({ ...i, key: i.id }));
}

async function loadAgents() {
  await loadProjects();
  const { types } = await api('GET', '/api/instances');
  $('types').replaceChildren(...types.map((t) => Object.assign(el('option', null, t), { value: t })));
  const ul = $('agents');
  ul.replaceChildren();
  for (const i of await currentInstances()) {
    const li = el('li', i.key === state.agent ? 'sel' : '');
    const left = el('div');
    left.append(
      el('span', 'dot' + (i.busy ? ' busy' : i.alive ? ' on' : '')),
      i.id,
      el('small', null, `${i.type}${i.custom && !state.project ? ' · 自建' : ''} · ${state.project ? i.dir : (i.cwd ?? '(基准目录)')}`),
    );
    if (i.role) left.append(el('div', 'role', i.role));
    li.append(left);
    if (i.custom || state.project) {
      const rm = el('button', null, '删');
      rm.onclick = guard(async (ev) => {
        ev.stopPropagation();
        if (state.project) {
          await confirmedAction(`删除实例 ${i.id}`, (force) =>
            api('DELETE', `/api/projects/${enc(state.project)}/instances/${enc(i.id)}${force ? '?force=1' : ''}`),
          );
        } else {
          await api('DELETE', `/api/instances/${enc(i.id)}`);
        }
        if (state.agent === i.key) await selectAgent(null);
        await loadAgents();
      });
      li.append(rm);
    }
    li.onclick = guard(() => selectAgent(i.key));
    ul.append(li);
  }
}

$('form-instance').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (state.project) {
    await api('POST', `/api/projects/${enc(state.project)}/instances`, { id: f.id, type: f.type, dir: f.dir, role: f.role || undefined });
  } else {
    await api('POST', '/api/instances', { id: f.id, type: f.type, cwd: f.dir });
  }
  e.target.reset();
  toast('已创建（首次使用时才会拉起进程）', true);
  await loadAgents();
});

// -- sessions and transcript ----------------------------------------------

async function selectAgent(key) {
  state.agent = key;
  state.session = null;
  $('session-title').textContent = key ? key.split('~').pop() : '选择一个实例';
  $('transcript').replaceChildren();
  $('sessions').replaceChildren();
  await loadAgents();
  if (!key) return;
  const { sessions } = await api('GET', `/api/agents/${enc(key)}/sessions`);
  if (state.agent !== key) return; // the user clicked elsewhere meanwhile
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
  const base = `/api/agents/${enc(state.agent)}/sessions/${enc(state.session)}`;
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
  await api('POST', `/api/agents/${enc(state.agent)}/run`, { prompt, sessionId: state.session || undefined });
});

// -- dispatcher -------------------------------------------------------------

async function loadDispatcher() {
  const m = await api('GET', `/api/dispatcher/models${pq()}`);
  $('dmodels').replaceChildren(
    ...m.models.map((x) => Object.assign(el('option', null, x.value), { value: x.value, selected: x.value === m.current })),
  );
  $('dmodels').title = m.hiddenWithoutCredentials ? `另有 ${m.hiddenWithoutCredentials} 个模型因没有凭据被隐藏` : '';
  await refreshDState(m.hiddenWithoutCredentials);
  const msgs = await api('GET', `/api/dispatcher/messages${pq()}`);
  $('dlog').replaceChildren();
  for (const msg of msgs.messages) renderPiMessage(msg);
  await loadLlms();
}

async function refreshDState(hidden) {
  const s = await api('GET', `/api/dispatcher${pq()}`);
  const extra = hidden ? ` · ${hidden} 个无凭据模型已隐藏` : '';
  $('dstate').textContent = s.alive ? `pid ${s.pid} · ${s.messageCount} 条消息 · ${s.thinkingLevel ?? ''}${extra}` : '未启动';
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
  await api('POST', `/api/dispatcher/model${pq()}`, { value: e.target.value });
  toast('已切换', true);
  await refreshDState();
});

$('dnew').onclick = guard(async () => {
  await api('POST', `/api/dispatcher/new${pq()}`);
  $('dlog').replaceChildren();
  await refreshDState();
});

$('dabort').onclick = guard(() => api('POST', `/api/dispatcher/abort${pq()}`));

$('form-dispatch').onsubmit = guard(async (e) => {
  e.preventDefault();
  const message = e.target.message.value.trim();
  if (!message) return;
  e.target.message.value = '';
  addMessage($('dlog'), 'user', message, '你');
  state.dStreaming = null;
  await api('POST', `/api/dispatcher/prompt${pq()}`, { message });
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
    toast('已添加，正在运行的调度器已重启', true);
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
  es.addEventListener('dispatcher.event', (m) => {
    const ev = JSON.parse(m.data);
    // Other projects' dispatchers keep running; only show the one on screen.
    if ((ev.project ?? '') === state.project) onDispatcherEvent(ev.data ?? {});
    else loadProjects().catch(() => {});
  });
  for (const name of ['job.started', 'job.done', 'agent.exit']) {
    es.addEventListener(name, (m) => {
      const ev = JSON.parse(m.data);
      loadAgents().catch(() => {});
      if (name === 'job.done' && ev.agent === state.agent) pullTranscript().catch(() => {});
    });
  }
}

// -- start ------------------------------------------------------------------

async function switchView() {
  state.agent = null;
  state.session = null;
  $('session-title').textContent = '选择一个实例';
  $('transcript').replaceChildren();
  $('sessions').replaceChildren();
  await loadAgents();
  await loadDispatcher();
}

async function refreshAll() {
  await loadAgents();
  await refreshDState().catch(() => {});
}

guard(async () => {
  await loadAgents();
  connectEvents();
  await loadDispatcher();
})();
