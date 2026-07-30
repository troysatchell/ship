import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

export interface SprintOwner {
  id: string;
  name: string;
  email: string;
}

export interface Sprint {
  id: string;
  name: string;
  sprint_number: number;
  status: 'planning' | 'active' | 'completed';
  owner: SprintOwner | null;
  issue_count: number;
  completed_count: number;
  started_count: number;
  total_estimate_hours?: number;
  has_plan?: boolean;
  has_retro?: boolean;
  plan_created_at?: string | null;
  retro_created_at?: string | null;
  // Completeness flags
  is_complete?: boolean | null;
  missing_fields?: string[];
}

export interface SprintsResponse {
  workspace_sprint_start_date: string;
  weeks: Sprint[];
}

// Query keys
export const sprintKeys = {
  all: ['sprints'] as const,
  lists: () => [...sprintKeys.all, 'list'] as const,
  list: (programId: string) => [...sprintKeys.lists(), programId] as const,
  projectLists: () => [...sprintKeys.all, 'projectList'] as const,
  projectList: (projectId: string) => [...sprintKeys.projectLists(), projectId] as const,
  active: () => [...sprintKeys.all, 'active'] as const,
  details: () => [...sprintKeys.all, 'detail'] as const,
  detail: (id: string) => [...sprintKeys.details(), id] as const,
};

// Extended Sprint type for active sprints endpoint
export interface ActiveWeek extends Sprint {
  program_id: string;
  program_name: string;
  program_prefix?: string;
  days_remaining: number;
  status: 'active';
}

export interface ActiveWeeksResponse {
  weeks: ActiveWeek[];
  current_sprint_number: number;
  days_remaining: number;
  sprint_start_date: string;
  sprint_end_date: string;
}

// Fetch all active sprints across workspace
async function fetchActiveWeeks(): Promise<ActiveWeeksResponse> {
  const res = await apiGet('/api/weeks');
  if (!res.ok) {
    const error = new Error('Failed to fetch active sprints') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Hook to get all active sprints across the workspace
export function useActiveWeeksQuery() {
  return useQuery({
    queryKey: sprintKeys.active(),
    queryFn: fetchActiveWeeks,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// A standup as returned by the batched /api/weeks/standups endpoint.
export interface RecentStandup {
  id: string;
  sprint_id: string;
  title: string;
  content: unknown;
  author_id: string;
  author_name: string | null;
  author_email: string | null;
  created_at: string;
  updated_at: string;
}

// Fetch the 10 most recent standups across a set of active weeks in a single
// batched request. Replaces the former one-request-per-week fan-out
// (audit findings DB-4 / API-5, tickets TRO-181 / TRO-176).
async function fetchRecentStandups(weekIds: string[]): Promise<RecentStandup[]> {
  const params = new URLSearchParams({ week_ids: weekIds.join(',') });
  const res = await apiGet(`/api/weeks/standups?${params.toString()}`);
  if (!res.ok) {
    const error = new Error('Failed to fetch recent standups') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Hook to get the most recent standups across a set of active weeks in one
// request. Pass the active weeks' ids (e.g. from useActiveWeeksQuery); the
// query is disabled when there are none.
export function useRecentStandupsQuery(weekIds: string[]) {
  const sortedIds = [...weekIds].sort();
  return useQuery({
    queryKey: [...sprintKeys.all, 'recentStandups', sortedIds],
    queryFn: () => fetchRecentStandups(sortedIds),
    enabled: sortedIds.length > 0,
    staleTime: 1000 * 60, // 1 minute - standups change more often than sprint metadata
  });
}

// Fetch sprints for a program
async function fetchSprints(programId: string): Promise<SprintsResponse> {
  const res = await apiGet(`/api/programs/${programId}/sprints`);
  if (!res.ok) {
    const error = new Error('Failed to fetch sprints') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Week creation API (unused - weeks are derived from workspace start date)
interface CreateSprintData {
  program_id: string;
  title: string;
  sprint_number: number;
  owner_id: string;
}

async function createSprintApi(data: CreateSprintData): Promise<Sprint> {
  const res = await apiPost('/api/weeks', data);
  if (!res.ok) {
    const error = new Error('Failed to create sprint') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Update sprint
async function updateSprintApi(id: string, updates: Partial<Sprint> & { owner_id?: string }): Promise<Sprint> {
  const res = await apiPatch(`/api/weeks/${id}`, updates);
  if (!res.ok) {
    const error = new Error('Failed to update sprint') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Delete sprint
async function deleteSprintApi(id: string): Promise<void> {
  const res = await apiDelete(`/api/weeks/${id}`);
  if (!res.ok) {
    const error = new Error('Failed to delete sprint') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
}

// Hook to get sprints for a program
export function useSprintsQuery(programId: string | undefined) {
  return useQuery({
    queryKey: programId ? sprintKeys.list(programId) : sprintKeys.lists(),
    queryFn: () => {
      if (!programId) {
        return { workspace_sprint_start_date: new Date().toISOString(), weeks: [] };
      }
      return fetchSprints(programId);
    },
    enabled: !!programId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Hook to create sprint with optimistic update
export function useCreateSprint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateSprintData) => createSprintApi(data),
    onMutate: async (newSprint) => {
      const programId = newSprint.program_id;
      await queryClient.cancelQueries({ queryKey: sprintKeys.list(programId) });
      const previousData = queryClient.getQueryData<SprintsResponse>(sprintKeys.list(programId));

      const optimisticSprint: Sprint = {
        id: `temp-${crypto.randomUUID()}`,
        name: newSprint.title,
        sprint_number: newSprint.sprint_number,
        status: 'planning',
        owner: null,
        issue_count: 0,
        completed_count: 0,
        started_count: 0,
        total_estimate_hours: 0,
      };

      queryClient.setQueryData<SprintsResponse>(
        sprintKeys.list(programId),
        (old) => old ? {
          ...old,
          weeks: [...old.weeks, optimisticSprint].sort((a, b) => a.sprint_number - b.sprint_number),
        } : {
          workspace_sprint_start_date: new Date().toISOString(),
          weeks: [optimisticSprint],
        }
      );

      return { previousData, optimisticId: optimisticSprint.id, programId };
    },
    onError: (_err, newSprint, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(sprintKeys.list(newSprint.program_id), context.previousData);
      }
    },
    onSuccess: (data, _variables, context) => {
      if (context?.optimisticId && context?.programId) {
        queryClient.setQueryData<SprintsResponse>(
          sprintKeys.list(context.programId),
          (old) => old ? {
            ...old,
            weeks: old.weeks.map(s => s.id === context.optimisticId ? data : s),
          } : { workspace_sprint_start_date: new Date().toISOString(), weeks: [data] }
        );
      }
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: sprintKeys.list(variables.program_id) });
    },
  });
}

// Hook to update sprint with optimistic update
export function useUpdateSprint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<Sprint> & { owner_id?: string } }) =>
      updateSprintApi(id, updates),
    onMutate: async ({ id, updates }) => {
      // Find which program's cache this sprint is in
      const allProgramCaches = queryClient.getQueriesData<SprintsResponse>({
        queryKey: sprintKeys.lists(),
      });

      let programId: string | undefined;
      let previousData: SprintsResponse | undefined;

      for (const [queryKey, data] of allProgramCaches) {
        if (data?.weeks.some(s => s.id === id)) {
          programId = queryKey[2] as string;
          previousData = data;
          break;
        }
      }

      if (!programId || !previousData) {
        return { previousData: undefined, programId: undefined };
      }

      await queryClient.cancelQueries({ queryKey: sprintKeys.list(programId) });

      queryClient.setQueryData<SprintsResponse>(
        sprintKeys.list(programId),
        (old) => old ? {
          ...old,
          weeks: old.weeks.map(s => s.id === id ? { ...s, ...updates } : s),
        } : old
      );

      return { previousData, programId };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData && context?.programId) {
        queryClient.setQueryData(sprintKeys.list(context.programId), context.previousData);
      }
    },
    onSuccess: (data, { id }, context) => {
      if (context?.programId) {
        queryClient.setQueryData<SprintsResponse>(
          sprintKeys.list(context.programId),
          (old) => old ? {
            ...old,
            weeks: old.weeks.map(s => s.id === id ? data : s),
          } : old
        );
      }
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.programId) {
        queryClient.invalidateQueries({ queryKey: sprintKeys.list(context.programId) });
      }
    },
  });
}

// Hook to delete sprint with optimistic update
export function useDeleteSprint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteSprintApi(id),
    onMutate: async (id) => {
      // Find which program's cache this sprint is in
      const allProgramCaches = queryClient.getQueriesData<SprintsResponse>({
        queryKey: sprintKeys.lists(),
      });

      let programId: string | undefined;
      let previousData: SprintsResponse | undefined;

      for (const [queryKey, data] of allProgramCaches) {
        if (data?.weeks.some(s => s.id === id)) {
          programId = queryKey[2] as string;
          previousData = data;
          break;
        }
      }

      if (!programId || !previousData) {
        return { previousData: undefined, programId: undefined };
      }

      await queryClient.cancelQueries({ queryKey: sprintKeys.list(programId) });

      queryClient.setQueryData<SprintsResponse>(
        sprintKeys.list(programId),
        (old) => old ? {
          ...old,
          weeks: old.weeks.filter(s => s.id !== id),
        } : old
      );

      return { previousData, programId };
    },
    onError: (_err, _id, context) => {
      if (context?.previousData && context?.programId) {
        queryClient.setQueryData(sprintKeys.list(context.programId), context.previousData);
      }
    },
    onSettled: (_data, _error, _id, context) => {
      if (context?.programId) {
        queryClient.invalidateQueries({ queryKey: sprintKeys.list(context.programId) });
      }
    },
  });
}

// Compatibility hook that provides sprints data with the workspace start date
export function useSprints(programId: string | undefined) {
  const { data, isLoading: loading, refetch } = useSprintsQuery(programId);
  const createMutation = useCreateSprint();
  const updateMutation = useUpdateSprint();
  const deleteMutation = useDeleteSprint();

  const sprints = data?.weeks ?? [];
  const workspaceSprintStartDate = data?.workspace_sprint_start_date
    ? new Date(data.workspace_sprint_start_date)
    : new Date();

  const createSprint = async (
    sprintNumber: number,
    ownerId: string,
    title?: string
  ): Promise<Sprint | null> => {
    if (!programId) return null;

    try {
      return await createMutation.mutateAsync({
        program_id: programId,
        title: title || `Week ${sprintNumber}`,
        sprint_number: sprintNumber,
        owner_id: ownerId,
      });
    } catch {
      return null;
    }
  };

  const updateSprint = async (
    id: string,
    updates: Partial<Sprint> & { owner_id?: string }
  ): Promise<Sprint | null> => {
    try {
      return await updateMutation.mutateAsync({ id, updates });
    } catch {
      return null;
    }
  };

  const deleteSprint = async (id: string): Promise<boolean> => {
    try {
      await deleteMutation.mutateAsync(id);
      return true;
    } catch {
      return false;
    }
  };

  const refreshSprints = async (): Promise<void> => {
    await refetch();
  };

  return {
    sprints,
    loading,
    workspaceSprintStartDate,
    createSprint,
    updateSprint,
    deleteSprint,
    refreshSprints,
  };
}

// Extended sprint type for project sprints (includes program info)
export interface ProjectSprint extends Sprint {
  program_id?: string;
  program_name?: string;
  program_prefix?: string;
  project_id?: string;
  project_name?: string;
  workspace_sprint_start_date: string;
}

// Fetch sprints for a project
async function fetchProjectSprints(projectId: string): Promise<ProjectSprint[]> {
  const res = await apiGet(`/api/projects/${projectId}/sprints`);
  if (!res.ok) {
    const error = new Error('Failed to fetch project sprints') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Hook to get sprints for a project
export function useProjectSprintsQuery(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? sprintKeys.projectList(projectId) : sprintKeys.projectLists(),
    queryFn: () => {
      if (!projectId) {
        return [];
      }
      return fetchProjectSprints(projectId);
    },
    enabled: !!projectId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Compatibility hook for project sprints that matches useSprints interface
export function useProjectSprints(projectId: string | undefined) {
  const { data, isLoading: loading, refetch } = useProjectSprintsQuery(projectId);

  const sprints: Sprint[] = data ?? [];
  // Get workspace sprint start date from first sprint or default to now
  const workspaceSprintStartDate = data?.[0]?.workspace_sprint_start_date
    ? new Date(data[0].workspace_sprint_start_date)
    : new Date();

  const refreshSprints = async (): Promise<void> => {
    await refetch();
  };

  return {
    sprints,
    loading,
    workspaceSprintStartDate,
    refreshSprints,
  };
}
