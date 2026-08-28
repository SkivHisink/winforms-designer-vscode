import { describe, expect, it } from 'vitest';
import { selectWorker, WorkerPayloadIdentity } from './workerSelection';

const payload: WorkerPayloadIdentity = {
  sessionId: 'session-a',
  documentId: 'Form1.cs',
  documentRevision: 'rev-1',
  sourceFingerprint: 'src-1',
  resourceFingerprint: 'res-1',
  payloadHash: 'payload-1',
};

describe('selectWorker', () => {
  it('selects deterministic managed workers for modern x64 and ARM64', () => {
    expect(selectWorker({
      runtime: 'modern',
      hostArchitecture: 'x64',
      projectArchitecture: 'anycpu',
      workspaceTrust: 'trusted',
      designTimeTrust: 'sourceFirst',
      payload,
    })).toMatchObject({
      ok: true,
      worker: {
        key: { runtime: 'modern', workerArchitecture: 'x64', compatibility: 'native' },
        mutationAuthority: 'sourceFirst',
      },
    });

    expect(selectWorker({
      runtime: 'modern',
      hostArchitecture: 'arm64',
      projectArchitecture: 'arm64',
      workspaceTrust: 'trusted',
      designTimeTrust: 'hostedDesignTime',
      payload,
    })).toMatchObject({
      ok: true,
      worker: {
        key: { runtime: 'modern', workerArchitecture: 'arm64', compatibility: 'native' },
        mutationAuthority: 'hostedDesignTime',
      },
    });
  });

  it('selects net48 x64 natively on x64 and x64-compat on ARM64', () => {
    expect(selectWorker({
      runtime: 'net48',
      hostArchitecture: 'x64',
      projectArchitecture: 'anycpu',
      workspaceTrust: 'trusted',
      designTimeTrust: 'sourceFirst',
      payload,
    })).toMatchObject({
      ok: true,
      worker: {
        key: { runtime: 'net48', workerArchitecture: 'x64', compatibility: 'native' },
      },
    });

    expect(selectWorker({
      runtime: 'net48',
      hostArchitecture: 'arm64',
      projectArchitecture: 'x64',
      workspaceTrust: 'trusted',
      designTimeTrust: 'sourceFirst',
      payload,
    })).toMatchObject({
      ok: true,
      worker: {
        key: { runtime: 'net48', workerArchitecture: 'x64', compatibility: 'x64-compat' },
      },
    });
  });

  it('refuses x86 and COM/ActiveX without mutation authority', () => {
    expect(selectWorker({
      runtime: 'net48',
      hostArchitecture: 'x64',
      projectArchitecture: 'x86',
      workspaceTrust: 'trusted',
      designTimeTrust: 'hostedDesignTime',
      payload,
    })).toMatchObject({
      ok: false,
      refusal: {
        reasonCode: 'X86_WORKER_UNAVAILABLE',
        mutationAuthority: 'none',
        canMutateWorkspace: false,
      },
    });

    expect(selectWorker({
      runtime: 'modern',
      hostArchitecture: 'x64',
      projectArchitecture: 'anycpu',
      workspaceTrust: 'trusted',
      designTimeTrust: 'hostedDesignTime',
      containsComActiveX: true,
      payload,
    })).toMatchObject({
      ok: false,
      refusal: {
        reasonCode: 'COM_ACTIVE_X_UNSUPPORTED',
        mutationAuthority: 'none',
        canMutateWorkspace: false,
      },
    });
  });

  it('keeps untrusted workspaces parse-only with no mutation authority', () => {
    expect(selectWorker({
      runtime: 'modern',
      hostArchitecture: 'x64',
      projectArchitecture: 'anycpu',
      workspaceTrust: 'untrusted',
      designTimeTrust: 'hostedDesignTime',
      payload,
    })).toMatchObject({
      ok: true,
      worker: {
        mutationAuthority: 'none',
        capabilities: {
          parseOnly: true,
          sourceFirst: false,
          hostedDesignTime: false,
          canLoadProjectCode: false,
          canMutateWorkspace: false,
        },
      },
    });
  });
});
