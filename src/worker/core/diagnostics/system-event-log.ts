import { Logger, LogCategory } from '../logger';

export const enum SystemEventKind {
  ARBITER_SUBMIT = 1,
  ARBITER_DEQUEUE = 2,
  ARBITER_OVERFLOW = 3,
  SCHED_SWITCH = 4,
  SCHED_DEFERRAL = 5,
  CALLBACK_INVOKE = 6,
  CALLBACK_RETURN = 7,
  MEMORY_FAULT = 8,
  FATAL_GUARD = 9,
  APC_ENQUEUE = 10,
  APC_WAKE = 11,
  APC_DISPATCH = 12,
  APC_DROP = 13,
}

export interface SystemEventRecord {
  ts: number;
  kind: number;
  a: number;
  b: number;
  c: number;
}

export class SystemEventLog {
  private readonly capacity: number;
  private readonly kind: Uint16Array;
  private readonly a: Uint32Array;
  private readonly b: Uint32Array;
  private readonly c: Uint32Array;
  private readonly ts: Float64Array;
  private index = 0;
  private length = 0;

  constructor(capacity = 8192) {
    this.capacity = Math.max(256, capacity | 0);
    this.kind = new Uint16Array(this.capacity);
    this.a = new Uint32Array(this.capacity);
    this.b = new Uint32Array(this.capacity);
    this.c = new Uint32Array(this.capacity);
    this.ts = new Float64Array(this.capacity);
  }

  write(kind: number, a = 0, b = 0, c = 0): void {
    const i = this.index;
    this.kind[i] = kind >>> 0;
    this.a[i] = a >>> 0;
    this.b[i] = b >>> 0;
    this.c[i] = c >>> 0;
    this.ts[i] = performance.now();
    this.index = (i + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
  }

  snapshot(limit = 512): SystemEventRecord[] {
    if (this.length === 0) return [];
    const safeLimit = Math.max(1, Math.min(limit | 0, this.length));
    const start = (this.index - safeLimit + this.capacity) % this.capacity;
    const out: SystemEventRecord[] = [];
    for (let i = 0; i < safeLimit; i++) {
      const idx = (start + i) % this.capacity;
      out.push({
        ts: this.ts[idx],
        kind: this.kind[idx] >>> 0,
        a: this.a[idx] >>> 0,
        b: this.b[idx] >>> 0,
        c: this.c[idx] >>> 0,
      });
    }
    return out;
  }

  dumpRecent(limit = 512): void {
    const entries = this.snapshot(limit);
    if (entries.length === 0) {
      Logger.log(LogCategory.SYSTEM, '[SystemEventLog] empty');
      return;
    }
    const lines = [`[SystemEventLog] recent=${entries.length}`];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      lines.push(
        `  [${i}] t=${e.ts.toFixed(1)} kind=${e.kind} ` +
          `a=0x${e.a.toString(16)} b=0x${e.b.toString(16)} c=0x${e.c.toString(16)}`
      );
    }
    Logger.log(LogCategory.SYSTEM, lines.join('\n'));
  }

  clear(): void {
    this.index = 0;
    this.length = 0;
    this.kind.fill(0);
    this.a.fill(0);
    this.b.fill(0);
    this.c.fill(0);
    this.ts.fill(0);
  }
}

export const systemEventLog = new SystemEventLog(8192);
