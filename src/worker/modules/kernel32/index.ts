// Auto-generated index for kernel32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/kernel32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { exports as tls } from './tls';
import { exports as error } from './error';
import { exports as command } from './command/command';
import { exports as profile } from './profile';
import { exports as vista_runtime } from './vista-runtime';
import { exports as fls } from './fls';
import { exports as memory } from './memory';
import { exports as module } from './module/module';
import { exports as time } from './time/time';
import { exports as util } from './util';
import { exports as atom } from './atom';
import { exports as sync } from './sync';
import { exports as file_io } from './file-io';
import { exports as locale } from './locale';
import { exports as process_ } from './process/process';
import { exports as environment } from './environment';
import { exports as resource } from './resource';
import { exports as exception } from './exception';

export class Kernel32 implements IModule {
    name = 'kernel32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // tls functions
        Object.assign(this.exports, tls);
        // error functions
        Object.assign(this.exports, error);
        // command functions
        Object.assign(this.exports, command);
        // profile functions
        Object.assign(this.exports, profile);
        // vista-runtime functions
        Object.assign(this.exports, vista_runtime);
        // fls functions
        Object.assign(this.exports, fls);
        // memory functions
        Object.assign(this.exports, memory);
        // module functions
        Object.assign(this.exports, module);
        // time functions
        Object.assign(this.exports, time);
        // util functions
        Object.assign(this.exports, util);
        // atom functions
        Object.assign(this.exports, atom);
        // sync functions
        Object.assign(this.exports, sync);
        // file-io functions
        Object.assign(this.exports, file_io);
        // locale functions
        Object.assign(this.exports, locale);
        // process functions
        Object.assign(this.exports, process_);
        // environment functions
        Object.assign(this.exports, environment);
        // resource functions
        Object.assign(this.exports, resource);
        // exception functions
        Object.assign(this.exports, exception);
    }
}