import {
  CANVAS_MCP_TOOL_DEFINITIONS,
  CanvasMcpRequestSchema,
  CanvasWorkflowSnapshotSchema,
  applyProjectTransaction,
  createCanvasModuleNode,
  getCanvasModuleDefinition,
  listCanvasModuleDefinitions,
  parseCanvasProject,
  redactMcpValue,
  validateCanvasModuleGraph,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
  type CanvasModuleNode,
  type CanvasProject,
  type CanvasWorkflowMutation,
  type ProjectTransaction,
} from '@agent-canvas/domain';

import {
  createMcpConfirmationStore,
  hashMcpValue,
  type McpConfirmationGrant,
  type McpConfirmationStore,
  type PaidJobConfirmationSubject,
} from './mcp-confirmation-store';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';

export interface McpWorkspaceJobSummary {
  readonly id: string;
  readonly nodeId?: string;
  readonly status: string;
  readonly progress?: number;
}

export interface McpWorkspaceSource {
  getProject(): CanvasProject;
  getRevision(): number;
  getSelection(): { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  getJobs(): readonly McpWorkspaceJobSummary[];
  commitProjectTransaction(transaction: ProjectTransaction): Promise<boolean>;
  runNode(nodeId: string): Promise<boolean>;
  cancelJob(jobId: string): Promise<void>;
  requestMediaImport(kind: 'image' | 'video', position: { readonly x: number; readonly y: number }): Promise<void>;
}

export interface McpWorkspaceAdapter {
  handle(request: CanvasMcpRequest): Promise<CanvasMcpResponse>;
  confirmPlan(planId: string): McpConfirmationGrant;
  rejectPlan(planId: string): void;
  confirmPaidJob(requestId: string): McpConfirmationGrant;
  rejectPaidJob(requestId: string): void;
  invalidateProject(projectId: string): void;
}

type PendingPlan = {
  readonly planId: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly intent: string;
  readonly mutations: readonly CanvasWorkflowMutation[];
  readonly mutationHash: string;
  readonly nextProject: CanvasProject;
  readonly confirmationGrant?: McpConfirmationGrant;
};

type PendingPaidJob = PaidJobConfirmationSubject & { readonly requestId: string; readonly confirmationGrant?: McpConfirmationGrant };

let adapterSequence = 0;

export function createMcpWorkspaceAdapter(
  source: McpWorkspaceSource,
  confirmations: McpConfirmationStore = createMcpConfirmationStore(),
): McpWorkspaceAdapter {
  const pendingPlans = new Map<string, PendingPlan>();
  const pendingPaidJobs = new Map<string, PendingPaidJob>();

  async function handle(input: CanvasMcpRequest): Promise<CanvasMcpResponse> {
    const parsed = CanvasMcpRequestSchema.safeParse(input);
    if (!parsed.success) return error('MCP_INVALID_REQUEST', 'Request does not match the CanvasForge MCP contract.');
    const request = parsed.data;
    try {
      switch (request.tool) {
        case 'canvas_describe_nodes':
          return success({
            toolCount: CANVAS_MCP_TOOL_DEFINITIONS.length,
            modules: listCanvasModuleDefinitions().map((definition) => ({
              type: definition.type,
              primaryName: definition.primaryName,
              secondaryName: definition.secondaryName,
              category: definition.category,
              executionMode: definition.executionMode,
              capabilities: [...definition.capabilities],
              ports: definition.ports.map((port) => ({
                id: port.id,
                label: port.primaryLabel,
                direction: port.direction,
                dataType: port.dataType,
                cardinality: port.cardinality,
                required: port.required,
              })),
            })),
          });
        case 'canvas_read_workflow':
          return success(createPublicSnapshot(source));
        case 'canvas_get_selection': {
          const selection = source.getSelection();
          return success({ nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] });
        }
        case 'canvas_get_job_status': {
          const job = source.getJobs().find((candidate) => candidate.id === request.jobId);
          return job ? success(publicJob(job)) : error('JOB_NOT_FOUND', 'Managed CanvasForge job was not found.');
        }
        case 'canvas_plan_workflow':
          return planWorkflow(request.expectedRevision, request.workflowIntent, request.mutations);
        case 'canvas_apply_workflow':
          return applyWorkflow(request.expectedRevision, request.planId, request.confirmationToken);
        case 'canvas_create_node':
          return commitMutations(request.expectedRevision, [{
            kind: 'create_node',
            nodeId: createId(`mcp-${request.moduleType}`),
            moduleType: request.moduleType,
            position: request.position,
            ...(request.config === undefined ? {} : { config: request.config }),
          }], 'Create MCP canvas node');
        case 'canvas_update_node':
          return commitMutations(request.expectedRevision, [{ kind: 'update_node', nodeId: request.nodeId, config: request.config }], 'Update MCP canvas node');
        case 'canvas_connect_nodes':
          return commitMutations(request.expectedRevision, [{
            kind: 'connect_nodes',
            edgeId: createId('mcp-edge'),
            sourceNodeId: request.sourceNodeId,
            sourcePortId: request.sourcePortId,
            targetNodeId: request.targetNodeId,
            targetPortId: request.targetPortId,
          }], 'Connect MCP canvas nodes');
        case 'canvas_move_nodes':
          return commitMutations(request.expectedRevision, [{ kind: 'move_nodes', positions: request.positions }], 'Move MCP canvas nodes');
        case 'canvas_delete_selection':
          return error('CONFIRMATION_REQUIRED', 'Delete selection must be included in a confirmed workflow plan.');
        case 'canvas_run_node':
          return runNode(request.expectedRevision, request.nodeId, request.confirmationToken);
        case 'canvas_cancel_job': {
          const job = source.getJobs().find((candidate) => candidate.id === request.jobId);
          if (!job) return error('JOB_NOT_FOUND', 'Managed CanvasForge job was not found.');
          await source.cancelJob(request.jobId);
          return success({ cancelled: true, jobId: request.jobId });
        }
        case 'canvas_import_media':
          if (request.expectedRevision !== source.getRevision()) return revisionConflict(source.getRevision());
          await source.requestMediaImport(request.mediaKind, request.position);
          return error('FILE_SELECTION_REQUIRED', 'Choose the image or video inside CanvasForge.', { mediaKind: request.mediaKind });
      }
    } catch (cause) {
      return error('MCP_WORKSPACE_ERROR', stableMessage(cause));
    }
  }

function planWorkflow(
    expectedRevision: number,
    intent: string,
    mutations: readonly CanvasWorkflowMutation[],
  ): CanvasMcpResponse {
    const currentRevision = source.getRevision();
    if (expectedRevision !== currentRevision) return revisionConflict(currentRevision);
    const project = source.getProject();
    const mutationHash = hashMcpValue(mutations);
    const existing = [...pendingPlans.values()].find((plan) => (
      plan.projectId === project.id
      && plan.expectedRevision === expectedRevision
      && plan.intent === intent
      && plan.mutationHash === mutationHash
    ));
    if (existing) return workflowPlanResponse(existing);

    let nextProject: CanvasProject;
    try {
      nextProject = applyMcpMutations(project, mutations);
    } catch (cause) {
      return error('INVALID_WORKFLOW', stableMessage(cause));
    }
    const planId = createId('mcp-plan');
    const plan: PendingPlan = {
      planId,
      projectId: project.id,
      expectedRevision,
      intent,
      mutations: cloneJson(mutations),
      mutationHash,
      nextProject,
    };
    pendingPlans.set(planId, plan);
    const paidJobs = findPaidJobs(nextProject, mutations);
    mcpUiConfirmationStore.publish({
      id: planId,
      kind: 'workflow',
      title: intent,
      projectId: project.id,
      expectedRevision,
      mutations: cloneJson(mutations),
      paidJobs,
      limitations: [],
    }, {
      confirm: () => confirmPlan(planId),
      reject: () => rejectPlan(planId),
    });
    return workflowPlanResponse(plan);
  }

  function workflowPlanResponse(plan: PendingPlan): CanvasMcpResponse {
    return success({
      protocol: 'canvasforge.mcp.plan.v1',
      planId: plan.planId,
      projectId: plan.projectId,
      expectedRevision: plan.expectedRevision,
      summary: plan.intent,
      limitations: [],
      mutations: cloneJson(plan.mutations),
      paidJobs: findPaidJobs(plan.nextProject, plan.mutations),
      confirmationRequired: plan.confirmationGrant === undefined,
      ...(plan.confirmationGrant === undefined ? {} : {
        approvalCode: plan.confirmationGrant.token,
        confirmationExpiresAt: plan.confirmationGrant.expiresAt,
      }),
    });
  }
  async function applyWorkflow(expectedRevision: number, planId: string, confirmationToken: string): Promise<CanvasMcpResponse> {
    const currentRevision = source.getRevision();
    if (expectedRevision !== currentRevision) return revisionConflict(currentRevision);
    const plan = pendingPlans.get(planId);
    if (!plan || plan.projectId !== source.getProject().id) return error('PLAN_NOT_FOUND', 'Pending workflow plan was not found.');
    const consumed = confirmations.consumeWorkflow({
      token: confirmationToken,
      planId: plan.planId,
      projectId: plan.projectId,
      expectedRevision: plan.expectedRevision,
      mutationHash: plan.mutationHash,
    });
    if (!consumed.ok) return error('CONFIRMATION_REQUIRED', 'Confirm this exact workflow plan inside CanvasForge.', { reason: consumed.code });
    const committed = await commitReplacement(source, plan.nextProject, `Apply MCP workflow: ${plan.intent}`);
    if (!committed) return error('DURABLE_WRITE_FAILED', 'CanvasForge could not persist the confirmed workflow.');
    pendingPlans.delete(planId);
    mcpUiConfirmationStore.dismiss(planId);
    return success({ applied: true, planId, revision: source.getRevision() });
  }

  async function commitMutations(
    expectedRevision: number,
    mutations: readonly CanvasWorkflowMutation[],
    label: string,
  ): Promise<CanvasMcpResponse> {
    const currentRevision = source.getRevision();
    if (expectedRevision !== currentRevision) return revisionConflict(currentRevision);
    let nextProject: CanvasProject;
    try {
      nextProject = applyMcpMutations(source.getProject(), mutations);
    } catch (cause) {
      return error('INVALID_WORKFLOW', stableMessage(cause));
    }
    if (!await commitReplacement(source, nextProject, label)) return error('DURABLE_WRITE_FAILED', 'CanvasForge could not persist the canvas change.');
    return success({ applied: true, revision: source.getRevision() });
  }

  async function runNode(expectedRevision: number, nodeId: string, token: string | undefined): Promise<CanvasMcpResponse> {
    const currentRevision = source.getRevision();
    if (expectedRevision !== currentRevision) return revisionConflict(currentRevision);
    const node = source.getProject().nodes.find((candidate): candidate is CanvasModuleNode => candidate.id === nodeId && candidate.type === 'module');
    if (!node) return error('NODE_NOT_FOUND', 'Canvas module node was not found.');
    const jobKind = paidJobKind(node.data.moduleType);
    if (!jobKind) return error('NODE_NOT_EXECUTABLE', 'This canvas node has no paid execution route.');
    const modelRoute = typeof node.data.config.modelRoute === 'string' ? node.data.config.modelRoute : `${jobKind}-default`;
    const requestHash = hashMcpValue({ nodeId, jobKind, modelRoute, config: publicConfig(node.data.config) });
    let pending = [...pendingPaidJobs.values()].find((candidate) => candidate.nodeId === nodeId && candidate.expectedRevision === expectedRevision && candidate.requestHash === requestHash);
    if (!token) {
      if (!pending) {
        const requestId = createId('mcp-paid');
        pending = { requestId, nodeId, projectId: source.getProject().id, expectedRevision, jobKind, modelRoute, requestHash };
        pendingPaidJobs.set(requestId, pending);
        mcpUiConfirmationStore.publish({
          id: requestId,
          kind: 'paid_job',
          title: `Run ${jobKind} generation`,
          projectId: pending.projectId,
          expectedRevision,
          nodeId,
          jobKind,
          modelRoute,
        }, {
          confirm: () => confirmPaidJob(requestId),
          reject: () => rejectPaidJob(requestId),
        });
      }
      return error('PAID_CONFIRMATION_REQUIRED', 'Confirm the paid model job inside CanvasForge.', {
        requestId: pending.requestId,
        nodeId,
        jobKind,
        modelRoute,
        confirmationRequired: pending.confirmationGrant === undefined,
        ...(pending.confirmationGrant === undefined ? {} : {
          approvalCode: pending.confirmationGrant.token,
          confirmationExpiresAt: pending.confirmationGrant.expiresAt,
        }),
      });
    }
    if (!pending) return error('PAID_CONFIRMATION_REQUIRED', 'No matching paid confirmation request is pending.');
    const consumed = confirmations.consumePaidJob({ token, nodeId, projectId: pending.projectId, expectedRevision, jobKind, modelRoute, requestHash });
    if (!consumed.ok) return error('PAID_CONFIRMATION_REQUIRED', 'Confirm this exact paid model job inside CanvasForge.', { reason: consumed.code });
    const started = await source.runNode(nodeId);
    if (!started) return error('JOB_START_FAILED', 'CanvasForge could not start the managed model job.');
    pendingPaidJobs.delete(pending.requestId);
    mcpUiConfirmationStore.dismiss(pending.requestId);
    return success({ started: true, nodeId, jobKind });
  }

function confirmPlan(planId: string): McpConfirmationGrant {
    const plan = pendingPlans.get(planId);
    if (!plan) throw new Error('PLAN_NOT_FOUND');
    if (plan.confirmationGrant) return plan.confirmationGrant;
    const confirmationGrant = confirmations.issueWorkflow({
      planId: plan.planId,
      projectId: plan.projectId,
      expectedRevision: plan.expectedRevision,
      mutationHash: plan.mutationHash,
    });
    pendingPlans.set(planId, { ...plan, confirmationGrant });
    mcpUiConfirmationStore.dismiss(planId);
    return confirmationGrant;
  }

  function rejectPlan(planId: string): void {
    pendingPlans.delete(planId);
    mcpUiConfirmationStore.dismiss(planId);
  }

  function confirmPaidJob(requestId: string): McpConfirmationGrant {
    const pending = pendingPaidJobs.get(requestId);
    if (!pending) throw new Error('PAID_JOB_REQUEST_NOT_FOUND');
    if (pending.confirmationGrant) return pending.confirmationGrant;
    const { requestId: _requestId, confirmationGrant: _confirmationGrant, ...subject } = pending;
    const confirmationGrant = confirmations.issuePaidJob(subject);
    pendingPaidJobs.set(requestId, { ...pending, confirmationGrant });
    mcpUiConfirmationStore.dismiss(requestId);
    return confirmationGrant;
  }

  function rejectPaidJob(requestId: string): void {
    pendingPaidJobs.delete(requestId);
    mcpUiConfirmationStore.dismiss(requestId);
  }

  return {
    handle,
    confirmPlan,
    rejectPlan,
    confirmPaidJob,
    rejectPaidJob,
    invalidateProject(projectId) {
      confirmations.invalidateProject(projectId);
      for (const [planId, plan] of pendingPlans) {
        if (plan.projectId !== projectId) continue;
        pendingPlans.delete(planId);
        mcpUiConfirmationStore.dismiss(planId);
      }
      for (const [requestId, pending] of pendingPaidJobs) {
        if (pending.projectId !== projectId) continue;
        pendingPaidJobs.delete(requestId);
        mcpUiConfirmationStore.dismiss(requestId);
      }
    },
  };
}

function createPublicSnapshot(source: McpWorkspaceSource) {
  const project = source.getProject();
  const selection = source.getSelection();
  const selectedNodes = new Set(selection.nodeIds);
  const selectedEdges = new Set(selection.edgeIds);
  return CanvasWorkflowSnapshotSchema.parse({
    protocol: 'canvasforge.mcp.snapshot.v1',
    projectId: project.id,
    revision: source.getRevision(),
    nodes: project.nodes.flatMap((node) => node.type === 'module' ? [{
      id: node.id,
      moduleType: node.data.moduleType,
      position: node.position,
      selected: selectedNodes.has(node.id),
      config: publicConfig(node.data.config),
      executionState: node.data.execution.state,
      managedResultIds: managedResultIds(node),
      ports: getCanvasModuleDefinition(node.data.moduleType).ports.map((port) => ({
        id: port.id,
        direction: port.direction,
        dataType: port.dataType,
        cardinality: port.cardinality,
        required: port.required,
      })),
    }] : []),
    edges: project.edges.flatMap((edge) => edge.sourcePortId && edge.targetPortId ? [{
      id: edge.id,
      sourceNodeId: edge.source,
      sourcePortId: edge.sourcePortId,
      targetNodeId: edge.target,
      targetPortId: edge.targetPortId,
      selected: selectedEdges.has(edge.id),
    }] : []),
    selection: { nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] },
  });
}

function publicConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).flatMap(([key, value]) => {
    try {
      redactMcpValue({ [key]: value });
      return [[key, cloneJson(value)]];
    } catch {
      return [];
    }
  }));
}

function managedResultIds(node: CanvasModuleNode): string[] {
  const values = [node.data.result?.id, node.data.result?.assetId, ...(node.data.result?.assetIds ?? [])];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 20);
}

function publicJob(job: McpWorkspaceJobSummary): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    ...(job.nodeId === undefined ? {} : { nodeId: job.nodeId }),
    ...(job.progress === undefined ? {} : { progress: job.progress }),
  };
}

function applyMcpMutations(project: CanvasProject, mutations: readonly CanvasWorkflowMutation[]): CanvasProject {
  let nodes = project.nodes.map((node) => cloneJson(node));
  let edges = project.edges.map((edge) => cloneJson(edge));
  for (const mutation of mutations) {
    if (mutation.kind === 'create_node') {
      if (nodes.some((node) => node.id === mutation.nodeId)) throw new Error(`Node already exists: ${mutation.nodeId}`);
      const node = createCanvasModuleNode(mutation.nodeId, mutation.moduleType, mutation.position);
      if (mutation.config) node.data.config = { ...node.data.config, ...cloneJson(mutation.config) };
      nodes.push(node);
      continue;
    }
    if (mutation.kind === 'update_node') {
      const index = nodes.findIndex((node) => node.id === mutation.nodeId);
      const node = nodes[index];
      if (!node || node.type !== 'module') throw new Error(`Unknown module node: ${mutation.nodeId}`);
      nodes[index] = { ...node, data: { ...node.data, config: { ...node.data.config, ...cloneJson(mutation.config) } } };
      continue;
    }
    if (mutation.kind === 'connect_nodes') {
      if (edges.some((edge) => edge.id === mutation.edgeId)) throw new Error(`Edge already exists: ${mutation.edgeId}`);
      const order = edges.filter((edge) => edge.target === mutation.targetNodeId && edge.targetPortId === mutation.targetPortId).length;
      edges.push({
        id: mutation.edgeId,
        source: mutation.sourceNodeId,
        sourcePortId: mutation.sourcePortId,
        target: mutation.targetNodeId,
        targetPortId: mutation.targetPortId,
        order,
      });
      continue;
    }
    if (mutation.kind === 'move_nodes') {
      const positions = new Map(mutation.positions.map((entry) => [entry.nodeId, { x: entry.x, y: entry.y }]));
      for (const nodeId of positions.keys()) {
        if (!nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown node: ${nodeId}`);
      }
      nodes = nodes.map((node) => positions.has(node.id) && node.locked !== true ? { ...node, position: positions.get(node.id)! } : node);
      continue;
    }
    const ids = new Set(mutation.nodeIds);
    for (const nodeId of ids) if (!nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    nodes = nodes.filter((node) => !ids.has(node.id));
    edges = edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
  }
  const nextProject = parseCanvasProject({ ...project, nodes, edges });
  const graphIssues = validateCanvasModuleGraph(nextProject);
  if (graphIssues.length > 0) throw new Error(graphIssues.map((issue) => issue.message).join('; '));
  return nextProject;
}

async function commitReplacement(source: McpWorkspaceSource, nextProject: CanvasProject, label: string): Promise<boolean> {
  const transaction: ProjectTransaction = {
    id: createId('mcp-transaction'),
    label,
    operations: [{ kind: 'replace_canvas_state', nodes: nextProject.nodes, edges: nextProject.edges }],
  };
  // Verify the exact durable transaction against the current project before handing it to the store.
  applyProjectTransaction(source.getProject(), transaction);
  return source.commitProjectTransaction(transaction);
}

function findPaidJobs(project: CanvasProject, mutations: readonly CanvasWorkflowMutation[]) {
  const createdIds = new Set(mutations.flatMap((mutation) => mutation.kind === 'create_node' ? [mutation.nodeId] : []));
  return project.nodes.flatMap((node) => node.type === 'module' && createdIds.has(node.id) && paidJobKind(node.data.moduleType)
    ? [{ nodeId: node.id, jobKind: paidJobKind(node.data.moduleType)!, modelRoute: typeof node.data.config.modelRoute === 'string' ? node.data.config.modelRoute : `${paidJobKind(node.data.moduleType)}-default` }]
    : []);
}

function paidJobKind(moduleType: string): 'image' | 'video' | 'reverse' | null {
  if (moduleType === 'image_generation' || moduleType === 'image_editor' || moduleType === 'local_redraw' || moduleType === 'comfy_workflow') return 'image';
  if (moduleType === 'video_generation') return 'video';
  if (moduleType === 'reverse_agent' || moduleType === 'skill_agent' || moduleType === 'detail_page_agent' || moduleType === 'line_art_material') return 'reverse';
  return null;
}

function revisionConflict(currentRevision: number): CanvasMcpResponse {
  return error('PROJECT_REVISION_CONFLICT', 'Canvas changed; read the workflow again before writing.', { currentRevision });
}

function success(result: unknown): CanvasMcpResponse {
  redactMcpValue(result);
  return { ok: true, result };
}

function error(code: string, message: string, details?: unknown): CanvasMcpResponse {
  if (details !== undefined) redactMcpValue(details);
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${adapterSequence++}`;
}

function stableMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'CanvasForge rejected the workspace operation.';
  try {
    redactMcpValue(message);
    return message.slice(0, 500);
  } catch {
    return 'CanvasForge rejected the workspace operation.';
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
