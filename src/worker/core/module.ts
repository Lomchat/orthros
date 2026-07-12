
import { ThunkImplementation } from './thunking/thunk-dispatcher';
import { Process } from './process';

export interface IModule {
    name: string;
    exports: Record<string, ThunkImplementation>;
    initialize(process: Process): void;
    reset?(): void;
    recreateVTables?(): void;
    reregisterExports?(process: Process): void;
}
