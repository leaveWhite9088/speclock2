// Dashboard. Plain ES modules, no build step; everything goes through /api (the backend).
// Text from agents is always inserted with textContent, never as HTML.
//
// Shape of the page: a project owns one dispatcher and some executors (CLI instances).
// The sidebar lists them, the middle is the conversation with whoever is selected, and
// everything about a member that is not the conversation (model, sessions, role) lives
// in its settings drawer.

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
import { renderMarkdown } from './md.mjs';

const DISPATCHER = '@dispatcher';

const state = {
  project: localStorage.getItem('project') ?? '',
  projects: [],
  sel: DISPATCHER, // DISPATCHER or an instance key
  catalog: {}, // type -> { models: [{value,name}], default }
  dispatcher: { model: null, models: [], state: null },
  lastSeq: 0,
  sessionId: null,
  streaming: null, // assistant block being filled by the dispatcher
  drawer: false,
};

// -- helpers ------------------------------------------------------------------

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
const pq = () => `?project=${enc(state.project)}`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function opt(label, value, selected) {
  const o = el('option', null, label);
  o.value = value;
  if (selected) o.selected = true;
  return o;
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

const project = () => state.projects.find((p) => p.id === state.project);
const members = () => project()?.instances ?? [];
const member = (key) => members().find((i) => i.key === key);
const isDispatcher = () => state.sel === DISPATCHER;

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// -- harness × LLM tag --------------------------------------------------------

function modelName(type, value) {
  if (!value) return null;
  const hit = state.catalog[type]?.models.find((m) => m.value === value);
  return hit?.name ?? value.split(':')[2] ?? value;
}

function tag(type, llm, faint) {
  const t = el('span', 'tag');
  t.append(el('span', `h ${['mcode', 'dsh', 'pi'].includes(type) ? type : ''}`, type));
  t.append(el('span', `m${faint ? ' faint' : ''}`, llm || '默认模型'));
  return t;
}

function instanceLlm(i) {
  const value = i.model ?? i.preferModel ?? state.catalog[i.type]?.default ?? null;
  return { text: modelName(i.type, value), faint: !i.model };
}

function dispatcherLlm() {
  const m = state.dispatcher.model;
  if (!m) return { text: null, faint: true };
  const hit = state.dispatcher.models.find((x) => x.value === m);
  return { text: hit?.name ?? m, faint: false };
}

/** Model lists are per CLI type and need a probe process, so fetch them quietly and re-render. */
const catalogFailed = {};
async function ensureCatalog(type, retry = false) {
  if (state.catalog[type]?.models.length || ensureCatalog.pending?.has(type)) return;
  // A failed probe is not remembered as "no models": try again later (at once when asked).
  if (!retry && Date.now() - (catalogFailed[type] ?? 0) < 30_000) return;
  (ensureCatalog.pending ??= new Set()).add(type);
  try {
    state.catalog[type] = await api('GET', `/api/models?type=${enc(type)}`);
    renderMembers();
    renderHead();
  } catch {
    catalogFailed[type] = Date.now();
  } finally {
    ensureCatalog.pending.delete(type);
  }
}

// -- projects -----------------------------------------------------------------

async function loadProjects() {
  const r = await api('GET', '/api/projects');
  state.projects = r.projects;
  if (!r.projects.some((p) => p.id === state.project)) state.project = r.projects[0]?.id ?? '';
  localStorage.setItem('project', state.project);
  $('project').replaceChildren(...r.projects.map((p) => opt(p.name, p.id, p.id === state.project)));
  const g = r.limits.global ? `，其中项目外 ${r.limits.global}` : '';
  $('limits').textContent = `进程 ${r.limits.alive}/${r.limits.maxProcesses}${g}，空闲 ${r.limits.idleMinutes} 分钟回收`;
  if (state.sel !== DISPATCHER && !member(state.sel)) state.sel = DISPATCHER;
  for (const i of members()) ensureCatalog(i.type);
  renderMembers();
  renderHead();
}

$('project').onchange = guard(async (e) => {
  state.project = e.target.value;
  localStorage.setItem('project', state.project);
  await openMember(DISPATCHER);
});

const closePops = () => {
  $('projmenu').hidden = true;
  $('form-project').hidden = true;
};
$('btn-newproj').onclick = () => {
  const open = $('form-project').hidden;
  closePops();
  $('form-project').hidden = !open;
  if (open) $('form-project').elements.id.focus();
};
$('cancel-project').onclick = closePops;
$('btn-projmenu').onclick = () => {
  const open = $('projmenu').hidden;
  closePops();
  $('projmenu').hidden = !open || !state.project;
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePops();
    if (state.drawer) toggleDrawer(false);
  }
});

$('form-project').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', '/api/projects', { id: f.id, name: f.name || f.id, root: f.root });
  e.target.reset();
  closePops();
  state.project = f.id;
  toast('项目已创建', true);
  await loadProjects();
  await openMember(DISPATCHER);
});

/** Try without force; if something is still running, name it and ask again. */
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
  closePops();
  if (!confirm(`关闭项目「${project()?.name}」？\n\n会停掉调度器和所有执行者的进程。配置和会话保留，下次用到时自动重新启动。`)) return;
  await confirmedAction('关闭项目', (force) => api('POST', `/api/projects/${enc(state.project)}/stop`, { force }));
  toast('项目已关闭', true);
  await loadProjects();
});

$('btn-delete').onclick = guard(async () => {
  closePops();
  if (!confirm(`删除项目「${project()?.name}」的配置？\n\n会停掉它的进程并移除执行者清单。项目目录里的文件不会被动。`)) return;
  const done = await confirmedAction('删除项目', (force) =>
    api('DELETE', `/api/projects/${enc(state.project)}${force ? '?force=1' : ''}`),
  );
  if (!done) return;
  state.project = '';
  toast('项目已删除', true);
  await loadProjects();
  await openMember(DISPATCHER);
});

// -- sidebar ------------------------------------------------------------------

function memberRow(key, name, role, type, llm, status) {
  const b = el('button', 'member');
  b.type = 'button';
  b.setAttribute('aria-current', String(state.sel === key));
  const n = el('span', 'name');
  n.append(el('span', `dot${status === 'busy' ? ' busy' : status === 'on' ? ' on' : ''}`), el('span', null, name));
  b.append(n);
  if (role) b.append(el('span', 'role', role));
  b.append(tag(type, llm.text, llm.faint));
  b.onclick = guard(() => openMember(key));
  return b;
}

function renderMembers() {
  const box = $('members');
  box.replaceChildren();
  if (!state.project) {
    const e = el('div', 'dim');
    e.style.padding = '12px';
    e.textContent = '还没有项目。点右上的 ＋ 新建一个，项目是调度器和执行者的归属。';
    box.append(e);
    return;
  }
  const p = project();
  const d = state.dispatcher.state;
  box.append(
    memberRow(DISPATCHER, '调度器', '听你的需求，决定让谁去做', 'pi', dispatcherLlm(), p?.dispatcher?.busy ? 'busy' : p?.dispatcher?.alive ? 'on' : ''),
  );
  if (members().length) box.append(el('div', 'sep'));
  for (const i of members()) {
    const llm = instanceLlm(i);
    box.append(memberRow(i.key, i.id, i.role, i.type, llm, i.busy ? 'busy' : i.alive ? 'on' : ''));
  }
  void d;
}

// -- header and settings ------------------------------------------------------

function renderHead() {
  const none = !state.project;
  $('btn-settings').hidden = none;
  $('composer').hidden = none;
  $('btn-newmember').disabled = none;
  $('btn-projmenu').disabled = none;
  if (none) {
    $('head-title').textContent = 'agentd';
    $('head-tag').replaceChildren();
    $('head-state').textContent = '';
    return;
  }
  const dsp = isDispatcher();
  const m = dsp ? null : member(state.sel);
  $('head-title').textContent = dsp ? '调度器' : (m?.id ?? '');
  const llm = dsp ? dispatcherLlm() : m ? instanceLlm(m) : { text: null, faint: true };
  $('head-tag').replaceChildren(tag(dsp ? 'pi' : (m?.type ?? ''), llm.text, llm.faint));
  const busy = dsp ? project()?.dispatcher?.busy : m?.busy;
  const alive = dsp ? project()?.dispatcher?.alive : m?.alive;
  $('head-state').textContent = busy ? '工作中' : alive ? '待命' : m?.lastError ? `启动失败：${m.lastError.slice(0, 80)}` : '未启动，发消息时才会启动';
  $('btn-retry').hidden = !(m && !alive && m.lastError);
  $('input').placeholder = dsp ? '告诉调度器要做什么（Enter 发送，Shift+Enter 换行）' : `直接对 ${m?.id ?? ''} 说话（Enter 发送，Shift+Enter 换行）`;
  $('btn-abort').hidden = !busy;
}

async function retryStart() {
  const m = member(state.sel);
  if (!m) return;
  const btn = $('btn-retry');
  btn.disabled = true;
  $('head-state').textContent = '正在启动…';
  try {
    await api('POST', `/api/agents/${enc(m.key)}/start`);
  } catch (e) {
    toast(e.message);
  }
  btn.disabled = false;
  await loadProjects();
}

function toggleDrawer(open) {
  state.drawer = open;
  $('drawer').hidden = !open;
  if (open) renderDrawer().catch((e) => toast(e.message));
}
$('btn-settings').onclick = () => toggleDrawer(!state.drawer);
$('btn-retry').onclick = retryStart;

const field = (label, control, hint) => {
  const l = el('label');
  l.append(el('span', null, label), control);
  if (hint) l.append(el('small', 'dim', hint));
  return l;
};
const textInput = (value, placeholder) => {
  const i = el('input');
  i.value = value ?? '';
  if (placeholder) i.placeholder = placeholder;
  i.autocomplete = 'off';
  return i;
};
const heading = (text, ...actions) => {
  const h = el('div', 'dr-h');
  h.append(el('span', null, text), ...actions);
  return h;
};
const linkBtn = (text, fn, cls = '') => {
  const b = el('button', `link ${cls}`, text);
  b.type = 'button';
  b.onclick = guard(fn);
  return b;
};

/** One session line: click to switch, pencil to rename in place. */
function sessionRow(title, sub, current, onUse, onRename) {
  const row = el('div', `sess-row${current ? ' cur' : ''}`);
  const main = el('button', 'sess');
  main.type = 'button';
  main.disabled = current;
  main.append(el('span', 't', title || '（无标题）'), el('small', null, current ? `${sub} · 当前` : sub));
  if (!current) main.onclick = guard(onUse);
  const pen = el('button', 'icon sm', '✎');
  pen.type = 'button';
  pen.title = '重命名';
  pen.setAttribute('aria-label', '重命名');
  pen.onclick = () => {
    const input = textInput(title ?? '');
    input.className = 'sess-edit';
    let done = false;
    const finish = guard(async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() !== (title ?? '')) {
        await onRename(input.value.trim());
        toast('已重命名', true);
      }
      await renderDrawer();
    });
    input.onkeydown = (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    input.onblur = () => finish(true);
    row.replaceChildren(input);
    input.focus();
    input.select();
  };
  row.append(main, pen);
  return row;
}

async function renderDrawer() {
  const dr = $('drawer');
  const head = el('div', 'dr-head');
  const x = el('button', 'icon', '✕');
  x.setAttribute('aria-label', '关闭设置');
  x.onclick = () => toggleDrawer(false);
  head.append(el('h2', null, isDispatcher() ? '调度器设置' : `${member(state.sel)?.id ?? ''} 设置`), x);
  const body = el('div', 'dr-body');
  body.append(isDispatcher() ? await dispatcherSettings() : await executorSettings());
  dr.replaceChildren(head, body);
}

function sessionsBlock(newFn, load) {
  const list = el('div', 'sess-list');
  list.append(el('div', 'dim', '读取中…'));
  load(list).catch((e) => list.replaceChildren(el('div', 'dim', e.message)));
  const f = document.createDocumentFragment();
  f.append(heading('会话', linkBtn('＋ 新建', newFn)), list);
  return f;
}

async function executorSettings() {
  const m = member(state.sel);
  const wrap = document.createDocumentFragment();
  if (!m) return wrap;
  await ensureCatalog(m.type, true);
  const cat = state.catalog[m.type] ?? { models: [], default: null };

  // Every field saves as soon as it changes.
  const save = async (patch, undo) => {
    if (patch.dir !== undefined && !confirm('换目录会重启它的进程，并且不再沿用原来的会话（会话属于创建时的目录）。继续吗？')) return undo();
    try {
      const r = await api('PATCH', `/api/projects/${enc(state.project)}/instances/${enc(m.id)}`, patch);
      if (r.key !== m.key) state.sel = r.key;
      toast('已保存', true);
      await loadProjects();
      if (patch.name !== undefined || patch.dir !== undefined) await loadConversation();
      await renderDrawer();
    } catch (e) {
      undo();
      toast(e.message);
    }
  };
  const bind = (input, key, current) => {
    input.onchange = () => {
      const v = input.value.trim();
      if (key === 'name' && !v) return (input.value = current);
      if (v !== current) save({ [key]: v }, () => (input.value = current));
    };
    return input;
  };

  const name = bind(textInput(m.id), 'name', m.id);
  const role = bind(textInput(m.role, '调度器据此挑人'), 'role', m.role ?? '');
  const dir = bind(textInput(m.dir, '相对项目根目录'), 'dir', m.dir);
  const sel = el('select');
  let cur = m.model ?? m.preferModel ?? '';
  if (cur === cat.default) cur = '';
  sel.append(opt(cat.default ? `默认（${modelName(m.type, cat.default)}）` : '默认', ''));
  for (const mo of cat.models) sel.append(opt(mo.name || mo.value, mo.value));
  // The saved choice must show even when the model list could not be read.
  if (cur && ![...sel.options].some((o) => o.value === cur)) sel.append(opt(modelName(m.type, cur) ?? cur, cur));
  sel.value = cur;
  sel.onchange = () => save({ model: sel.value || null }, () => (sel.value = cur));

  const form = el('div', 'form inline');
  form.append(field('名称', name), field('用途', role), field('目录', dir), field('模型', sel));
  wrap.append(form);

  const base = `/api/agents/${enc(m.key)}`;
  wrap.append(
    sessionsBlock(
      async () => {
        await api('POST', `${base}/sessions`, {});
        toast('已新建会话', true);
        await afterSessionChange();
      },
      async (list) => {
        const r = await api('GET', `${base}/sessions`);
        list.replaceChildren();
        const active = activeSessionId(m, r.sessions);
        if (!r.sessions.length) list.append(el('div', 'dim', '还没有会话，第一次发消息时会自动创建。'));
        for (const x of r.sessions) {
          const shown = x.label || x.title || '';
          list.append(
            sessionRow(
              shown || x.sessionId.slice(0, 8),
              when(x.updatedAt),
              x.sessionId === active,
              async () => {
                await api('POST', `${base}/use`, { sessionId: x.sessionId });
                await afterSessionChange();
              },
              (label) => api('POST', `${base}/rename`, { sessionId: x.sessionId, label }),
            ),
          );
        }
      },
    ),
  );

  const foot = el('div', 'dr-foot');
  foot.append(
    linkBtn(
      '删除这个执行者',
      async () => {
        if (!confirm(`删除执行者「${m.id}」？\n\n只移除配置和进程，它的会话记录保留在磁盘上。`)) return;
        const done = await confirmedAction(`删除执行者 ${m.id}`, (force) =>
          api('DELETE', `/api/projects/${enc(state.project)}/instances/${enc(m.id)}${force ? '?force=1' : ''}`),
        );
        if (!done) return;
        toggleDrawer(false);
        await loadProjects();
        await openMember(DISPATCHER);
      },
      'danger',
    ),
  );
  wrap.append(foot);
  return wrap;
}

async function dispatcherSettings() {
  const wrap = document.createDocumentFragment();
  const m = await api('GET', `/api/dispatcher/models${pq()}`);
  state.dispatcher.models = m.models;
  state.dispatcher.model = m.current;

  const sel = el('select');
  for (const x of m.models) sel.append(opt(x.name || x.value, x.value, x.value === m.current));
  sel.onchange = guard(async () => {
    await api('POST', `/api/dispatcher/model${pq()}`, { value: sel.value });
    state.dispatcher.model = sel.value;
    renderMembers();
    renderHead();
    toast('调度器模型已切换', true);
  });
  const form = el('div', 'form');
  form.append(field('模型', sel, m.hiddenWithoutCredentials ? `另有 ${m.hiddenWithoutCredentials} 个模型没有配置凭据，没有列出。` : '选择后立即生效。'));
  wrap.append(form);

  wrap.append(
    sessionsBlock(
      async () => {
        await api('POST', `/api/dispatcher/new${pq()}`);
        toast('已新建会话', true);
        await afterSessionChange();
      },
      async (list) => {
        const r = await api('GET', `/api/dispatcher/sessions${pq()}`);
        list.replaceChildren();
        if (!r.sessions.length) list.append(el('div', 'dim', '还没有会话。'));
        for (const x of r.sessions) {
          list.append(
            sessionRow(
              x.label || x.title || (x.sessionId ?? '').slice(0, 8),
              when(x.updatedAt),
              x.active,
              async () => {
                await api('POST', `/api/dispatcher/use${pq()}`, { sessionFile: x.file });
                await afterSessionChange();
              },
              (label) => api('POST', `/api/dispatcher/rename${pq()}`, { sessionFile: x.file, label }),
            ),
          );
        }
      },
    ),
  );

  // LLMs are shared by every project's dispatcher.
  const lf = el('form', 'form');
  for (const [n, ph] of [
    ['provider', '名称，例如 my-llm'],
    ['baseUrl', '接口地址，例如 https://api.x.com/v1'],
    ['apiKey', 'API key：写 $环境变量名 或直接填值'],
    ['model', '模型 id'],
  ]) {
    const i = textInput('', ph);
    i.name = n;
    i.required = true;
    lf.append(i);
  }
  const add = el('button', 'ghost', '添加并重启调度器');
  lf.append(add);
  lf.onsubmit = guard(async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(lf));
    add.disabled = true;
    try {
      await api('POST', '/api/dispatcher/llms', { provider: v.provider, baseUrl: v.baseUrl, apiKey: v.apiKey, models: [{ id: v.model }] });
      toast('已添加，运行中的调度器已重启', true);
      await renderDrawer();
    } finally {
      add.disabled = false;
    }
  });
  const llms = el('pre', 'plain', '读取中…');
  api('GET', '/api/dispatcher/llms').then((l) => {
    llms.textContent = l.providers.length
      ? l.providers.map((p) => `${p.provider}  ${p.baseUrl}\n  ${p.models.map((x) => x.id).join(', ')}`).join('\n')
      : '还没有自定义 LLM。';
  });
  const det = el('details', 'dr-more');
  det.append(el('summary', null, '添加 LLM（所有项目的调度器共用）'), llms, lf);
  wrap.append(det);
  return wrap;
}

async function afterSessionChange() {
  await loadProjects();
  await loadConversation();
  if (state.drawer) await renderDrawer();
}

// -- conversation -------------------------------------------------------------

// While a conversation is being rebuilt it is drawn into `building` and swapped in at once, so the
// scroll position never collapses to the top in between.
let building = null;

function lane() {
  if (building) return building;
  let l = $('stream').querySelector('.lane');
  if (!l) {
    $('stream').replaceChildren();
    l = el('div', 'lane');
    $('stream').append(l);
  }
  return l;
}

const nearBottom = () => {
  const s = $('stream');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
};

/** Follow the conversation only if the reader is already at the bottom (or asked for it). */
function scrollDown(force = false) {
  if (building) return;
  const s = $('stream');
  if (force || s.dataset.stick !== '0') s.scrollTop = s.scrollHeight;
}
$('stream').addEventListener('scroll', () => {
  $('stream').dataset.stick = nearBottom() ? '1' : '0';
});

/** Draw a whole conversation off-screen, then replace the old one without moving the reader. */
function rebuild(draw, { keepPlace = true } = {}) {
  const s = $('stream');
  const stick = !keepPlace || nearBottom();
  const top = s.scrollTop;
  building = el('div', 'lane');
  try {
    draw();
    s.replaceChildren(building);
  } finally {
    building = null;
  }
  s.scrollTop = stick ? s.scrollHeight : top;
  s.dataset.stick = stick ? '1' : '0';
}

function setBody(body, text) {
  body._raw = text;
  if (body._frame) return;
  body._frame = requestAnimationFrame(() => {
    body._frame = 0;
    body.replaceChildren(renderMarkdown(body._raw));
    scrollDown();
  });
}

function addMessage(role, text, who) {
  const m = el('div', `msg ${role}`);
  if (role !== 'user' && who) m.append(el('div', 'who', who));
  const body = el('div', 'body');
  if (role === 'assistant') {
    body._raw = text;
    body.append(renderMarkdown(text));
  } else body.textContent = text;
  m.append(body);
  lane().append(m);
  scrollDown(role === 'user');
  return body;
}

const oneLine = (t, n) => {
  const x = String(t).replace(/s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n)}…` : x;
};

/** Tool calls and their results are one plain list; each line opens to show the full text. */
function addCall(name, detail, result) {
  const l = lane();
  let ul = l.lastElementChild;
  if (!ul?.classList.contains('tools')) {
    ul = el('ul', 'tools');
    l.append(ul);
  }
  const li = el('li', result ? 'res' : '');
  const d = el('details');
  const sum = el('summary');
  sum.append(el('b', null, result ? `↳ ${name}` : name), el('span', 'arg', oneLine(result ? detail : detail.replace(/[{}"]/g, ''), 100)));
  d.append(sum, el('pre', null, detail));
  li.append(d);
  ul.append(li);
  scrollDown();
}

function emptyState() {
  const e = el('div', 'empty');
  if (!state.project) {
    e.append(el('h2', null, '先建一个项目'), el('div', null, '项目是调度器和执行者的归属：一个根目录、一个调度器、若干执行者。点左上角的 ＋ 开始。'));
  } else if (isDispatcher()) {
    e.append(el('h2', null, '和调度器说你要做什么'), el('div', null, members().length ? '它会看每个执行者的用途，把活派下去，再把结果汇总给你。' : '这个项目还没有执行者。先在左下角新建一个，调度器才有人可派。'));
  } else {
    e.append(el('h2', null, '还没有对话'), el('div', null, '在下面直接给这个执行者发消息。它的模型和会话在右上的设置里改。'));
  }
  $('stream').replaceChildren(e);
}

const textOf = (c) =>
  typeof c === 'string'
    ? c
    : (c ?? []).map((x) => (x.type === 'text' ? x.text : '')).filter(Boolean).join('\n');

function renderPiMessage(msg) {
  if (msg.role === 'user') addMessage('user', textOf(msg.content));
  else if (msg.role === 'assistant') {
    for (const c of msg.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) addMessage('assistant', c.text, '调度器');
      else if (c.type === 'toolCall') addCall(c.name, JSON.stringify(c.arguments ?? {}, null, 2));
    }
  } else if (msg.role === 'toolResult') addCall(msg.toolName ?? 'tool', textOf(msg.content).slice(0, 1500), true);
}

function activeSessionId(m, sessions) {
  return sessions.find((s) => s.active)?.sessionId ?? m.preferSession ?? sessions[0]?.sessionId ?? null;
}

let convSeq = 0;
async function loadConversation() {
  const seq = ++convSeq;
  state.streaming = null;
  state.lastSeq = 0;
  state.sessionId = null;
  if (!state.project) return emptyState();
  if (isDispatcher()) {
    const r = await api('GET', `/api/dispatcher/messages${pq()}`);
    if (seq !== convSeq) return;
    if (!r.messages.length) return emptyState();
    rebuild(() => r.messages.forEach(renderPiMessage));
    return;
  }
  const m = member(state.sel);
  if (!m) return emptyState();
  // The transcript is on disk, so showing it must not start the process: use the remembered session.
  state.sessionId = m.preferSession;
  if (!state.sessionId && m.alive) {
    const { sessions } = await api('GET', `/api/agents/${enc(m.key)}/sessions`);
    if (seq !== convSeq) return;
    state.sessionId = activeSessionId(m, sessions);
  }
  if (!state.sessionId) return emptyState();
  await pullTranscript(seq);
}

async function pullTranscript(seq = convSeq) {
  const m = member(state.sel);
  if (isDispatcher() || !m || !state.sessionId) return;
  const q = state.lastSeq ? `?afterSeq=${state.lastSeq}` : '';
  const r = await api('GET', `/api/agents/${enc(m.key)}/sessions/${enc(state.sessionId)}/transcript${q}`);
  if (seq !== convSeq) return;
  if (!r.entries.length && !state.lastSeq) return emptyState();
  const draw = () => {
    for (const e of r.entries) {
      if (e.seq <= state.lastSeq) continue; // an overlapping pull already drew it
      if (e.role === 'error') addMessage('error', e.error || e.text || '出错了', '出错');
      else addMessage(e.role, e.text ?? '', m.id);
      state.lastSeq = e.seq;
    }
  };
  if (state.lastSeq) draw();
  else rebuild(draw, { keepPlace: false });
}

async function openMember(key) {
  state.sel = key;
  renderMembers();
  renderHead();
  if (state.project && key === DISPATCHER) await refreshDispatcher();
  await loadConversation();
  if (state.drawer) await renderDrawer();
}

async function refreshDispatcher() {
  const [m, s] = await Promise.all([
    api('GET', `/api/dispatcher/models${pq()}`),
    api('GET', `/api/dispatcher${pq()}`).catch(() => null),
  ]);
  state.dispatcher = { model: s?.model?.value ?? m.current, models: m.models, state: s };
  renderMembers();
  renderHead();
}

// -- composer -----------------------------------------------------------------

const input = $('input');
const grow = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
};
input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').onsubmit = guard(async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !state.project) return;
  input.value = '';
  grow();
  if (isDispatcher()) {
    if (!$('stream').querySelector('.lane')) lane();
    addMessage('user', text);
    state.streaming = null;
    await api('POST', `/api/dispatcher/prompt${pq()}`, { message: text });
  } else {
    const m = member(state.sel);
    if (!$('stream').querySelector('.lane')) lane();
    addMessage('user', text);
    await api('POST', `/api/agents/${enc(m.key)}/run`, { prompt: text, sessionId: state.sessionId || undefined });
  }
  await loadProjects();
});

$('btn-abort').onclick = guard(async () => {
  if (isDispatcher()) await api('POST', `/api/dispatcher/abort${pq()}`);
  else await api('POST', `/api/agents/${enc(state.sel)}/cancel`);
});

// -- new executor dialog ------------------------------------------------------

let pickerSeq = 0;
async function refreshPickers() {
  const seq = ++pickerSeq;
  const type = $('m-type').value;
  if (!type || !state.project) return;
  $('m-model').replaceChildren(opt('读取中…', ''));
  $('m-session').replaceChildren(opt('读取中…', 'new'));
  const dir = $('m-dir').value.trim() || '.';
  const [models, sessions] = await Promise.all([
    api('GET', `/api/models?type=${enc(type)}`).catch(() => ({ models: [] })),
    api('GET', `/api/projects/${enc(state.project)}/sessions?type=${enc(type)}&dir=${enc(dir)}`).catch(() => ({ sessions: [] })),
  ]);
  if (seq !== pickerSeq) return;
  if (models.models?.length) state.catalog[type] ??= models;
  $('m-model').replaceChildren(
    opt(models.default ? `默认（${modelName(type, models.default)}）` : '默认', ''),
    ...models.models.map((m) => opt(m.name || m.value, m.value)),
  );
  $('m-session').replaceChildren(
    opt('新建会话', 'new'),
    ...sessions.sessions.map((s) => opt(`${s.title || s.sessionId.slice(0, 8)}，${when(s.updatedAt)}`, s.sessionId)),
  );
}

$('btn-newmember').onclick = guard(async () => {
  if (!$('m-type').options.length) {
    const { types } = await api('GET', '/api/instances');
    $('m-type').replaceChildren(...types.map((t) => opt(t, t)));
  }
  $('dlg-member').showModal();
  refreshPickers().catch((e) => toast(e.message));
});
$('cancel-member').onclick = () => $('dlg-member').close();
$('m-type').onchange = guard(refreshPickers);
$('m-dir').onchange = guard(refreshPickers);

$('form-member').onsubmit = guard(async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', `/api/projects/${enc(state.project)}/instances`, {
    id: f.id,
    type: f.type,
    dir: f.dir,
    role: f.role || undefined,
    model: f.model || undefined,
    sessionId: f.sessionId || 'new',
  });
  $('dlg-member').close();
  e.target.reset();
  toast('已创建，第一次用到时才会启动', true);
  await loadProjects();
  await openMember(`${state.project}~${f.id}`);
});

// -- live events --------------------------------------------------------------

function onDispatcherEvent(d) {
  if (!isDispatcher()) return;
  if (d.type === 'message_update' && d.kind === 'text_delta') {
    if (!state.streaming) state.streaming = addMessage('assistant', '', '调度器');
    setBody(state.streaming, (state.streaming._raw ?? '') + d.delta);
  } else if (d.type === 'tool_execution_start') {
    state.streaming = null;
    addCall(d.toolName, JSON.stringify(d.args ?? {}, null, 2));
  } else if (d.type === 'tool_execution_end' && d.result) {
    addCall(d.toolName ?? 'tool', textOf(d.result.content ?? d.result).slice(0, 1500), true);
  } else if (d.type === 'agent_settled') {
    state.streaming = null;
    loadProjects().catch(() => {});
    loadConversation().catch(() => {}); // settle on the canonical history
  } else if (d.type === 'dispatcher_exit') {
    toast(`调度器进程退出（code ${d.code}）`);
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => ($('conn').textContent = '已连接');
  es.onerror = () => ($('conn').textContent = '重连中…');
  es.addEventListener('dispatcher.event', (m) => {
    const ev = JSON.parse(m.data);
    if (ev.project && ev.project === state.project) onDispatcherEvent(ev.data ?? {});
    else loadProjects().catch(() => {});
  });
  for (const name of ['job.started', 'job.done', 'agent.exit']) {
    es.addEventListener(name, (m) => {
      const ev = JSON.parse(m.data);
      loadProjects().catch(() => {});
      if (name === 'job.done' && ev.agent === state.sel) pullTranscript().catch(() => {});
    });
  }
}

// -- start --------------------------------------------------------------------

guard(async () => {
  await loadProjects();
  connectEvents();
  await openMember(DISPATCHER);
})();
