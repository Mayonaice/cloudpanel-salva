export const uploadStates = ["initiated", "uploading", "completing", "completed", "aborted", "failed"] as const;
export type UploadState = (typeof uploadStates)[number];

const transitions: Record<UploadState, readonly UploadState[]> = {
  initiated: ["uploading", "aborted", "failed"],
  uploading: ["uploading", "completing", "aborted", "failed"],
  completing: ["completed", "uploading", "failed"],
  completed: [],
  aborted: [],
  failed: ["uploading", "aborted"]
};

export function canTransition(from: UploadState, to: UploadState): boolean {
  return isUploadState(from) && isUploadState(to) && (from === to || transitions[from].includes(to));
}

export function isUploadState(value: string): value is UploadState {
  return (uploadStates as readonly string[]).includes(value);
}

export function transition(from: UploadState, to: UploadState): UploadState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid upload transition: ${from} -> ${to}`);
  }
  return to;
}

export function isTerminalUploadState(state: UploadState): boolean {
  return state === "completed" || state === "aborted";
}

export function isSafeObjectKey(key: string): boolean {
  // Keys are generated server-side and are deliberately root-scoped. Do not
  // accept user-controlled paths here: the DB key is the only provider handle.
  return /^[a-f0-9]{64}$/u.test(key);
}

export const fileStates = ["uploading", "ready", "trashed", "purge_pending", "purged"] as const;
export type FileState = (typeof fileStates)[number];

const fileTransitions: Record<FileState, readonly FileState[]> = {
  uploading: ["ready", "purged"],
  ready: ["trashed"],
  trashed: ["ready", "purge_pending"],
  purge_pending: ["purged"],
  purged: []
};

export function isFileState(value: string): value is FileState {
  return (fileStates as readonly string[]).includes(value);
}

export function canTransitionFile(from: string, to: string): boolean {
  return isFileState(from) && isFileState(to) && (from === to || fileTransitions[from].includes(to));
}

export const shareStates = ["active", "revoked", "expired"] as const;
export type ShareState = (typeof shareStates)[number];

const shareTransitions: Record<ShareState, readonly ShareState[]> = {
  active: ["revoked", "expired"],
  revoked: [],
  expired: []
};

export function canTransitionShare(from: string, to: string): boolean {
  return (shareStates as readonly string[]).includes(from)
    && (shareStates as readonly string[]).includes(to)
    && (from === to || shareTransitions[from as ShareState].includes(to as ShareState));
}

export const jobStates = ["queued", "leased", "completed", "failed", "dead"] as const;
export type JobState = (typeof jobStates)[number];

const jobTransitions: Record<JobState, readonly JobState[]> = {
  queued: ["leased"],
  leased: ["completed", "failed", "queued"],
  completed: [],
  failed: ["queued", "dead"],
  dead: []
};

export function canTransitionJob(from: string, to: string): boolean {
  return (jobStates as readonly string[]).includes(from)
    && (jobStates as readonly string[]).includes(to)
    && (from === to || jobTransitions[from as JobState].includes(to as JobState));
}
