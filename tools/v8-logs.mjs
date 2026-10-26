// V8's own log files (isolate-<address>-<pid>-v8.log: one per page, worker and process) are written when a --js-flags
// switch turns a V8 log on (--log, --log-*, --prof, …), into the browser's working directory — the tools', the
// repository's root — unless V8's --logfile names another path. Every --js-flags switch the tools pass goes through
// v8LogArgs: --logfile=<V8_LOG_DIR>/v8.log added (V8 still writes one file per isolate, its isolate- prefix put before
// the file's name), a --logfile already given kept. The directory is made first: V8 writes its log to the standard
// output when it cannot open the file.

import { mkdirSync } from 'node:fs';

export const V8_LOG_DIR = '/tmp/orthros-scratch/v8-logs';

/** Chromium's switches, each --js-flags given a --logfile under `dir` unless it names one. */
export function v8LogArgs(args, dir = V8_LOG_DIR) {
  return args.map((a) => {
    if (!a.startsWith('--js-flags=') || /(?:^|\s)--logfile(?:[=\s]|$)/.test(a.slice('--js-flags='.length))) return a;
    mkdirSync(dir, { recursive: true });
    return `${a} --logfile=${dir}/v8.log`;
  });
}
