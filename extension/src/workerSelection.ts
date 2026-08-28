export type WorkerRuntime = 'modern' | 'net48';
export type WorkerArchitecture = 'x64' | 'arm64' | 'x86';
export type ProjectArchitecture = 'anycpu' | 'x64' | 'arm64' | 'x86';
export type WorkspaceTrust = 'untrusted' | 'trusted';
export type DesignTimeTrust = 'parseOnly' | 'sourceFirst' | 'hostedDesignTime';
export type MutationAuthority = 'none' | 'sourceFirst' | 'hostedDesignTime';

export type WorkerRefusalCode =
  | 'X86_WORKER_UNAVAILABLE'
  | 'COM_ACTIVE_X_UNSUPPORTED'
  | 'HOST_ARCHITECTURE_UNSUPPORTED'
  | 'PROJECT_ARCHITECTURE_UNSUPPORTED';

export interface WorkerPayloadIdentity {
  sessionId: string;
  documentId: string;
  documentRevision: string;
  sourceFingerprint: string;
  resourceFingerprint?: string;
  payloadHash: string;
}

export interface WorkerSelectionInput {
  runtime: WorkerRuntime;
  hostArchitecture: WorkerArchitecture;
  projectArchitecture: ProjectArchitecture;
  workspaceTrust: WorkspaceTrust;
  designTimeTrust: DesignTimeTrust;
  payload: WorkerPayloadIdentity;
  containsComActiveX?: boolean;
  requiresX86?: boolean;
}

export interface WorkerKey {
  runtime: WorkerRuntime;
  workerArchitecture: Exclude<WorkerArchitecture, 'x86'>;
  compatibility: 'native' | 'x64-compat';
}

export interface WorkerCapabilities {
  parseOnly: boolean;
  sourceFirst: boolean;
  hostedDesignTime: boolean;
  canLoadProjectCode: boolean;
  canMutateWorkspace: boolean;
  supportsComActiveX: false;
  supportsX86: false;
}

export interface SelectedWorker {
  key: WorkerKey;
  payload: WorkerPayloadIdentity;
  mutationAuthority: MutationAuthority;
  trust: {
    workspace: WorkspaceTrust;
    designTime: DesignTimeTrust;
  };
  capabilities: WorkerCapabilities;
}

export interface WorkerSelectionRefusal {
  reasonCode: WorkerRefusalCode;
  message: string;
  payload: WorkerPayloadIdentity;
  mutationAuthority: 'none';
  canMutateWorkspace: false;
}

export type WorkerSelectionResult =
  | { ok: true; worker: SelectedWorker }
  | { ok: false; refusal: WorkerSelectionRefusal };

export function selectWorker(input: WorkerSelectionInput): WorkerSelectionResult {
  if (input.containsComActiveX) {
    return refuse(
      'COM_ACTIVE_X_UNSUPPORTED',
      'COM/ActiveX requires a separate Phase 0 x86/COM route and is not available to the managed v2 worker.',
      input.payload,
    );
  }

  if (input.requiresX86 || input.projectArchitecture === 'x86') {
    return refuse(
      'X86_WORKER_UNAVAILABLE',
      'The v2 managed worker matrix has no x86 worker; refusing before any mutation authority is granted.',
      input.payload,
    );
  }

  const key = selectManagedWorkerKey(input.runtime, input.hostArchitecture, input.projectArchitecture);
  if (!key) {
    return refuse(
      input.hostArchitecture === 'x86' ? 'HOST_ARCHITECTURE_UNSUPPORTED' : 'PROJECT_ARCHITECTURE_UNSUPPORTED',
      'No deterministic managed worker exists for the requested host/project architecture combination.',
      input.payload,
    );
  }

  const mutationAuthority = selectMutationAuthority(input.workspaceTrust, input.designTimeTrust);
  return {
    ok: true,
    worker: {
      key,
      payload: input.payload,
      mutationAuthority,
      trust: {
        workspace: input.workspaceTrust,
        designTime: input.designTimeTrust,
      },
      capabilities: capabilitiesFor(mutationAuthority),
    },
  };
}

function selectManagedWorkerKey(
  runtime: WorkerRuntime,
  hostArchitecture: WorkerArchitecture,
  projectArchitecture: ProjectArchitecture,
): WorkerKey | null {
  if (hostArchitecture === 'x86') return null;
  if (projectArchitecture === 'arm64' && hostArchitecture !== 'arm64') return null;

  if (runtime === 'modern') {
    return {
      runtime,
      workerArchitecture: hostArchitecture,
      compatibility: 'native',
    };
  }

  if (projectArchitecture === 'arm64') return null;
  return {
    runtime,
    workerArchitecture: 'x64',
    compatibility: hostArchitecture === 'arm64' ? 'x64-compat' : 'native',
  };
}

function selectMutationAuthority(workspaceTrust: WorkspaceTrust, designTimeTrust: DesignTimeTrust): MutationAuthority {
  if (workspaceTrust !== 'trusted' || designTimeTrust === 'parseOnly') return 'none';
  if (designTimeTrust === 'hostedDesignTime') return 'hostedDesignTime';
  return 'sourceFirst';
}

function capabilitiesFor(mutationAuthority: MutationAuthority): WorkerCapabilities {
  return {
    parseOnly: true,
    sourceFirst: mutationAuthority === 'sourceFirst' || mutationAuthority === 'hostedDesignTime',
    hostedDesignTime: mutationAuthority === 'hostedDesignTime',
    canLoadProjectCode: mutationAuthority === 'hostedDesignTime',
    canMutateWorkspace: mutationAuthority !== 'none',
    supportsComActiveX: false,
    supportsX86: false,
  };
}

function refuse(
  reasonCode: WorkerRefusalCode,
  message: string,
  payload: WorkerPayloadIdentity,
): WorkerSelectionResult {
  return {
    ok: false,
    refusal: {
      reasonCode,
      message,
      payload,
      mutationAuthority: 'none',
      canMutateWorkspace: false,
    },
  };
}

export function workerKeyId(key: WorkerKey): string {
  return `${key.runtime}:${key.workerArchitecture}:${key.compatibility}`;
}
