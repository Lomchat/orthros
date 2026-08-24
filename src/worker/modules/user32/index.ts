// Auto-generated index for user32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/user32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createSystemExports as system } from './system';
import { createMenuExports as menu } from './menu';
import { createMessageExports as message, registerFastPathMessageFunctions as registerFastPathmessage } from './message';
import { createClassExports as class_ } from './class';
import { createWindowExports as window } from './window';
import { createDialogExports as dialog } from './dialog';
import { createInputExports as input } from './input';
import { resetUser32SharedState } from './shared-state';

export class User32 implements IModule {
    name = 'user32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // system functions
        Object.assign(this.exports, system());
        // menu functions
        Object.assign(this.exports, menu());
        // message functions
        Object.assign(this.exports, message());
        registerFastPathmessage(process.dispatcher);
        // class functions
        Object.assign(this.exports, class_());
        // window functions
        Object.assign(this.exports, window());
        // dialog functions
        Object.assign(this.exports, dialog());
        // input functions
        Object.assign(this.exports, input());
    }

    reset(): void {
        resetUser32SharedState();
    }
}