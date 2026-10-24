import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, enc, pq } from '@/lib/api';
import type { DispatcherModels, DispatcherSession, Llm, ModelCatalog, Project, ProjectsResponse, Session, Template } from '@/lib/types';
import { DISPATCHER, useUi } from '@/store';

/** Server state lives in TanStack Query; the SSE stream invalidates `projects` when something changes. */

export const useProjectsQuery = () => useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectsResponse>('GET', '/api/projects') });

/** The project on screen. If the remembered one is gone, fall back to the first (or none). */
export function useProject(): Project | undefined {
  const { data } = useProjectsQuery();
  const id = useUi((s) => s.project);
  const setProject = useUi((s) => s.setProject);
  const found = data?.projects.find((p) => p.id === id);
  useEffect(() => {
    if (data && !found && id !== (data.projects[0]?.id ?? '')) setProject(data.projects[0]?.id ?? '');
  }, [data, found, id, setProject]);
  return found;
}

/** Selected member, or undefined for the dispatcher. */
export function useSelectedMember() {
  const project = useProject();
  const sel = useUi((s) => s.sel);
  const member = sel === DISPATCHER ? undefined : project?.instances.find((i) => i.key === sel);
  return { project, sel, member, isDispatcher: sel === DISPATCHER };
}

/** Model lists need a probe process, so they are cached for the page's life and a failed probe is retried later. */
export const useCatalog = (type: string | undefined) =>
  useQuery({
    queryKey: ['models', type],
    queryFn: () => api<ModelCatalog>('GET', `/api/models?type=${enc(type ?? '')}`),
    enabled: Boolean(type),
    staleTime: Infinity,
    retry: 3,
    retryDelay: 30_000,
  });

export const useDispatcherModels = (project: string, enabled = true) =>
  useQuery({ queryKey: ['dispatcher-models', project], queryFn: () => api<DispatcherModels>('GET', `/api/dispatcher/models${pq(project)}`), enabled: enabled && Boolean(project) });

export const useInstanceTypes = () => useQuery({ queryKey: ['instance-types'], queryFn: async () => (await api<{ types: string[] }>('GET', '/api/instances')).types, staleTime: Infinity });

export const useDirs = (project: string, enabled: boolean) =>
  useQuery({ queryKey: ['dirs', project], queryFn: async () => (await api<{ dirs: string[] }>('GET', `/api/projects/${enc(project)}/dirs`)).dirs, enabled, staleTime: 0 });

/** Sessions an executor could resume (agentd asks the CLI; can take a while the first time). */
export const useExecutorSessions = (key: string, enabled = true) =>
  useQuery({ queryKey: ['sessions', key], queryFn: async () => (await api<{ sessions: Session[] }>('GET', `/api/agents/${enc(key)}/sessions`)).sessions, enabled, gcTime: 0 });

export const useDispatcherSessions = (project: string, enabled = true) =>
  useQuery({ queryKey: ['dispatcher-sessions', project], queryFn: async () => (await api<{ sessions: DispatcherSession[] }>('GET', `/api/dispatcher/sessions${pq(project)}`)).sessions, enabled, gcTime: 0 });

/** Sessions of a CLI type in a directory, for the new-executor dialog (does not need the instance to exist). */
export const useProbeSessions = (project: string, type: string, dir: string, enabled: boolean) =>
  useQuery({
    queryKey: ['probe-sessions', project, type, dir],
    queryFn: async () => (await api<{ sessions: Session[] }>('GET', `/api/projects/${enc(project)}/sessions?type=${enc(type)}&dir=${enc(dir)}`)).sessions,
    enabled: enabled && Boolean(type),
    retry: false,
    staleTime: 60_000,
  });

export const useLlms = () => useQuery({ queryKey: ['llms'], queryFn: async () => (await api<{ providers: Llm[] }>('GET', '/api/dispatcher/llms')).providers });

export const useTemplates = (enabled = true) => useQuery({ queryKey: ['templates'], queryFn: async () => (await api<{ templates: Template[] }>('GET', '/api/templates')).templates, enabled });
