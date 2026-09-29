// A helper worker of the parallel DXT encoder (see dxt-pool.js): its first message carries the shared buffers, then it
// sleeps between jobs in Atomics.wait.
import { helperLoop } from './dxt-pool.js';
self.onmessage = (e) => helperLoop(e.data);
