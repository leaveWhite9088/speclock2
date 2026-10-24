/**
 * Operations on the dispatchers (the pi of each project: its conversation, sessions and models), on the LLMs pi can
 * use, and on handoffs (the dispatcher may only propose one; a person generates, reviews and applies it).
 */

import { addProvider, agentDir, listProviders, removeProvider } from '../../core/pi-models.mjs';
import { anyDispatcherBusy, getDispatcher, handoffs, restartRunningDispatchers } from '../dispatchers.mjs';

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number }} ctx */
export function dispatcherOps(ctx) {
  return {
    /** The dispatcher may only propose; a person generates, reviews and applies. */
    'handoff.propose': (a) => handoffs.propose(a),

    'handoff.list': (a) => handoffs.list(a),

    'handoff.generate': (a) => handoffs.generate(a),

    'handoff.apply': (a) => handoffs.apply(a),

    'handoff.cancel': (a) => handoffs.cancel(a),

    'dispatcher.state': ({ project } = {}) => getDispatcher(project).state(),

    'dispatcher.models': ({ project } = {}) => getDispatcher(project).models(),

    'dispatcher.setModel': ({ project, value }) => getDispatcher(project).setModel(value),

    'dispatcher.setThinking': ({ project, level }) => getDispatcher(project).setThinking(level),

    'dispatcher.prompt': ({ project, message }) => getDispatcher(project).prompt(message),

    'dispatcher.abort': ({ project } = {}) => getDispatcher(project).abort(),

    'dispatcher.dequeue': ({ project, index }) => getDispatcher(project).dequeue(index),

    'dispatcher.new': ({ project } = {}) => getDispatcher(project).newSession(),

    'dispatcher.sessions': ({ project } = {}) => getDispatcher(project).sessions(),

    'dispatcher.deleteSession': ({ project, sessionFile }) => getDispatcher(project).deleteSession(sessionFile),

    'dispatcher.renameSession': ({ project, sessionFile, label }) => getDispatcher(project).renameSession(sessionFile, label),

    'dispatcher.use': ({ project, sessionFile }) => getDispatcher(project).switchSession(sessionFile),

    'dispatcher.messages': ({ project } = {}) => getDispatcher(project).messages(),

    'dispatcher.restart': ({ project } = {}) => getDispatcher(project).restart(),

    'dispatcher.customModels': () => ({ agentDir: agentDir(), ...listProviders() }),

    /**
     * Add an LLM: write it to models.json, then restart every dispatcher that is
     * running so pi reads the new file. Refused while any of them is working.
     */

    'dispatcher.addModel': async (spec) => {
      if (anyDispatcherBusy()) throw new Error('a dispatcher is working on a prompt; abort it first');
      const written = addProvider(spec);
      return { ...written, dispatchers: await restartRunningDispatchers() };
    },

    'dispatcher.removeModel': async ({ provider, modelIds }) => {
      if (anyDispatcherBusy()) throw new Error('a dispatcher is working on a prompt; abort it first');
      const removed = removeProvider(provider, modelIds);
      return { ...removed, dispatchers: await restartRunningDispatchers() };
    },
  };
}
