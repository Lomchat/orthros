// Auto-generated index for kernel32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/kernel32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { exports as atom } from './atom';
import { exports as command } from './command/command';
import { exports as environment } from './environment';
import { exports as error } from './error';
import { exports as exception } from './exception';
import { exports as file_io } from './file-io';
import { exports as fls } from './fls';
import { exports as locale } from './locale';
import { exports as memory } from './memory';
import { exports as module } from './module/module';
import { exports as process_ } from './process/process';
import { exports as profile } from './profile';
import { exports as resource } from './resource';
import { exports as sync } from './sync';
import { exports as time } from './time/time';
import { exports as tls } from './tls';
import { exports as util } from './util';
import { exports as vista_runtime } from './vista-runtime';

export class Kernel32 implements IModule {
    name = 'kernel32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // atom functions
        Object.assign(this.exports, atom);
        // command functions
        Object.assign(this.exports, command);
        // environment functions
        Object.assign(this.exports, environment);
        // error functions
        Object.assign(this.exports, error);
        // exception functions
        Object.assign(this.exports, exception);
        // file-io functions
        Object.assign(this.exports, file_io);
        // fls functions
        Object.assign(this.exports, fls);
        // locale functions
        Object.assign(this.exports, locale);
        // memory functions
        Object.assign(this.exports, memory);
        // module functions
        Object.assign(this.exports, module);
        // process functions
        Object.assign(this.exports, process_);
        // profile functions
        Object.assign(this.exports, profile);
        // resource functions
        Object.assign(this.exports, resource);
        // sync functions
        Object.assign(this.exports, sync);
        // time functions
        Object.assign(this.exports, time);
        // tls functions
        Object.assign(this.exports, tls);
        // util functions
        Object.assign(this.exports, util);
        // vista-runtime functions
        Object.assign(this.exports, vista_runtime);
    }
}