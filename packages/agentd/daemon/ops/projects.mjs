/**
 * Operations on projects, the executors configured in them, and the executor templates.
 */

import { join } from 'node:path';
import { MAX_PROCESSES, aliveCount, pool } from '../../core/agent-pool.mjs';
import { DATA_DIR } from '../../core/data-dir.mjs';
import { savedContext } from '../../core/dispatcher.mjs';
import * as projects from '../../core/projects.mjs';
import { listTemplates, removeTemplate, saveTemplate } from '../../core/templates.mjs';
import { dispatchers, wireAgent } from '../dispatchers.mjs';
import { withInterrupted } from '../startup.mjs';

/** Refuse while something of the project runs (unless forced), then stop its dispatcher. */
async function stopProjectProcesses(project, force) {
  const d = dispatchers.get(project);
  const busy = [
    ...projects.instancesOf(project).filter((a) => a.busy).map((a) => a.shortId),
    ...(d?.busy ? ['(dispatcher)'] : []),
  ];
  if (busy.length && !force) throw new Error(`still running: ${busy.join(', ')}`);
  if (d?.busy) await d.abort().catch(() => {});
  await d?.shutdown();
}

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number }} ctx */
export function projectOps(ctx) {
  return {
    'project.dirs': ({ project }) => projects.listDirs(project),

    projects: () => ({
      projects: projects.listProjects().map((p) => ({
        ...p,
        instances: withInterrupted(p.instances, (i) => i.key),
        dispatcher: { alive: Boolean(dispatchers.get(p.id)?.child), busy: Boolean(dispatchers.get(p.id)?.busy), compactAt: projects.dispatcherCompactAt(p.id), compactions: dispatchers.get(p.id)?.compactions() ?? 0, queued: (dispatchers.get(p.id)?.queue ?? []).map((m) => m.slice(0, 300)), context: (dispatchers.get(p.id)?.child ? dispatchers.get(p.id)?.context : null) ?? savedContext(join(DATA_DIR, 'dispatcher-sessions', p.id)) },
      })),
      limits: { maxProcesses: MAX_PROCESSES, alive: aliveCount(), global: aliveCount((a) => !a.project), idleMinutes: ctx.idleInstanceMs / 60_000 },
    }),

    /** The size at which the project's dispatcher compacts its conversation (null: never). */
    'project.updateDispatcher': ({ project, compactAt }) => {
      const value = projects.setDispatcherCompactAt(project, compactAt);
      const d = dispatchers.get(project);
      if (d) d.compactAt = value;
      return { project, compactAt: value };
    },

    'project.create': (args) => {
      const p = projects.createProject(args);
      for (const a of projects.instancesOf(p.id)) wireAgent(a);
      return p;
    },

    'project.addInstance': ({ project, id, type, dir, role, model, sessionId, compactAt, template }) => {
      const r = projects.addInstance(project, { id, type, dir, role, model, sessionId, compactAt, template });
      wireAgent(pool.get(r.key));
      return r;
    },

    /** Models a CLI type offers (cached per type). */
    'project.models': ({ type, refresh }) => projects.probeModels(type, { refresh: refresh === true }),

    /** Existing sessions of a CLI type in a project directory, to pick from when creating an instance. */
    'project.sessions': ({ project, type, dir }) => projects.probeSessions(project, type, dir),

    /** Edit an instance: role and preferred model. A running instance with a session switches model now. */
    'project.updateInstance': async ({ project, id, role, model, name, dir, compactAt, template }) => {
      const r = await projects.updateInstance(project, id, { role, model, name, dir, compactAt, template });
      const agent = pool.get(r.key);
      wireAgent(agent);
      if (model && agent.child && agent.sessionId && !agent.busy) {
        await agent.setConfigOption('model', model, agent.sessionId).catch(() => {});
      }
      return r;
    },

    'template.list': () => ({ templates: listTemplates().map((t) => ({ ...t, usedBy: projects.templateUsers(t.id) })) }),

    'template.save': (args) => {
      const t = saveTemplate(args);
      return { ...t, usedBy: projects.templateUsers(t.id) };
    },

    'template.remove': ({ id }) => {
      const users = projects.templateUsers(id);
      return { ...removeTemplate(id), usedBy: users };
    },

    'project.removeInstance': ({ project, id, force }) => projects.removeInstance(project, id, { force }),

    /** Close a project: stop its processes. Configuration and sessions stay. */
    'project.stop': async ({ project, force }) => {
      await stopProjectProcesses(project, force);
      return projects.stopInstances(project, { force: true });
    },

    'project.remove': async ({ project, force }) => {
      await stopProjectProcesses(project, force);
      dispatchers.delete(project);
      return projects.removeProject(project, { force: true });
    },
  };
}
