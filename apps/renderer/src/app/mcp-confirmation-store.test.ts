import { describe, expect, it } from 'vitest';

import { createMcpConfirmationStore } from './mcp-confirmation-store';

describe('MCP confirmation store', () => {
  it('issues a workflow token bound to the exact plan, revision, project, and mutation hash', () => {
    const store = createMcpConfirmationStore({ now: () => 1_000, createToken: () => 'workflow-grant-1' });
    const grant = store.issueWorkflow({ planId: 'plan-1', projectId: 'project-1', expectedRevision: 4, mutationHash: 'hash-1' });

    expect(grant).toMatchObject({ token: 'workflow-grant-1', expiresAt: 301_000 });
    expect(store.consumeWorkflow({ token: grant.token, planId: 'plan-1', projectId: 'project-1', expectedRevision: 4, mutationHash: 'hash-1' })).toEqual({ ok: true });
    expect(store.consumeWorkflow({ token: grant.token, planId: 'plan-1', projectId: 'project-1', expectedRevision: 4, mutationHash: 'hash-1' })).toEqual({ ok: false, code: 'CONFIRMATION_REPLAYED' });
  });

  it('rejects expired or altered workflow grants', () => {
    let now = 1_000;
    const store = createMcpConfirmationStore({ now: () => now, createToken: () => 'workflow-grant-2' });
    const grant = store.issueWorkflow({ planId: 'plan-2', projectId: 'project-1', expectedRevision: 4, mutationHash: 'hash-2' });

    expect(store.consumeWorkflow({ token: grant.token, planId: 'plan-2', projectId: 'project-1', expectedRevision: 5, mutationHash: 'hash-2' })).toEqual({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    now = 301_001;
    expect(store.consumeWorkflow({ token: grant.token, planId: 'plan-2', projectId: 'project-1', expectedRevision: 4, mutationHash: 'hash-2' })).toEqual({ ok: false, code: 'CONFIRMATION_EXPIRED' });
  });

  it('uses a separate two-minute one-time grant for paid jobs', () => {
    const store = createMcpConfirmationStore({ now: () => 5_000, createToken: () => 'paid-grant-1' });
    const grant = store.issuePaidJob({ nodeId: 'image-1', projectId: 'project-1', expectedRevision: 8, jobKind: 'image', modelRoute: 'image-default', requestHash: 'request-hash' });

    expect(grant.expiresAt).toBe(125_000);
    expect(store.consumePaidJob({ token: grant.token, nodeId: 'image-1', projectId: 'project-1', expectedRevision: 8, jobKind: 'image', modelRoute: 'image-default', requestHash: 'request-hash' })).toEqual({ ok: true });
    expect(store.consumePaidJob({ token: grant.token, nodeId: 'image-1', projectId: 'project-1', expectedRevision: 8, jobKind: 'image', modelRoute: 'image-default', requestHash: 'request-hash' })).toEqual({ ok: false, code: 'CONFIRMATION_REPLAYED' });
  });

  it('invalidates every pending grant when the project changes', () => {
    const store = createMcpConfirmationStore({ now: () => 5_000, createToken: () => 'grant-project-change' });
    const grant = store.issueWorkflow({ planId: 'plan-3', projectId: 'project-1', expectedRevision: 1, mutationHash: 'hash-3' });
    store.invalidateProject('project-1');
    expect(store.consumeWorkflow({ token: grant.token, planId: 'plan-3', projectId: 'project-1', expectedRevision: 1, mutationHash: 'hash-3' })).toEqual({ ok: false, code: 'CONFIRMATION_UNKNOWN' });
  });
});