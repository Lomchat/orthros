/** EAGL inner-loop HLE — side-effect registration (imported by emulator.worker.ts). */
import { libRegistry } from '../../lib-registry';
import { eaglDescriptor } from './descriptor';

libRegistry.register(eaglDescriptor);
