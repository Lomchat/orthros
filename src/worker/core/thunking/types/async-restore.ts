export interface AsyncRestoreDeferredWrite {
  address: number;
  value: number;
  size: 1 | 2 | 4 | 8;
}

export interface PendingAsyncRestoreDescriptor {
  threadId: number;
  asyncParkGeneration: number;
  functionId: number;
  returnValue: number;
  cleanupBytes: number;
  completionName: string;
  errorFlag: boolean;
  esp: number;
  returnAddr: number;
  deferredWrites?: AsyncRestoreDeferredWrite[];
  dllInits?: Array<{ baseAddress: number; entryPoint: number; name: string }>;
}
