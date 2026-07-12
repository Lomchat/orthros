/**
 * RaceDetector - Memory Race Condition Detection
 *
 * Tracks memory reads/writes and detects potential race conditions.
 * Useful for diagnosing async/callback interaction bugs.
 *
 * Features:
 * - Track all memory writes (address, value, timestamp, source, threadId)
 * - Track all memory reads (address, timestamp, source)
 * - Detect write-after-read races (different source within time window)
 * - Build happens-before chains
 *
 * NOTE: This is DEBUG-ONLY. Disable in production (significant overhead).
 */

import { Logger, LogCategory } from '../logger';

interface MemoryWrite {
  address: number;
  value: number;
  timestamp: number;
  source: string;       // 'ThunkDispatcher', 'ReadFile', 'CallbackManager', etc.
  threadId: number;
  eip: number;
}

interface MemoryRead {
  address: number;
  timestamp: number;
  source: string;
  threadId: number;
  eip: number;
}

interface RaceDetection {
  address: number;
  read: MemoryRead;
  write: MemoryWrite;
  timeDelta: number;    // ms between read and write
}

/**
 * Race detector for memory access patterns.
 * Detects write-after-read races that could indicate async corruption.
 */
export class RaceDetector {
  private enabled = false;
  private maxHistorySize = 10000;  // Keep last N accesses
  private raceWindowMs = 100;       // Detect races within 100ms

  // History of memory accesses
  private writes: MemoryWrite[] = [];
  private reads: MemoryRead[] = [];
  private writeIndex = 0;
  private readIndex = 0;

  // Detected races
  private races: RaceDetection[] = [];

  // Statistics
  private totalWrites = 0;
  private totalReads = 0;
  private totalRaces = 0;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  /**
   * Enable race detection.
   */
  enable(): void {
    this.enabled = true;
    Logger.log(LogCategory.SYSTEM, '[RaceDetector] Enabled');
  }

  /**
   * Disable race detection.
   */
  disable(): void {
    this.enabled = false;
    Logger.log(LogCategory.SYSTEM, '[RaceDetector] Disabled');
  }

  /**
   * Record a memory write.
   */
  recordWrite(
    address: number,
    value: number,
    source: string,
    threadId: number,
    eip: number
  ): void {
    if (!this.enabled) return;

    const write: MemoryWrite = {
      address,
      value,
      timestamp: Date.now(),
      source,
      threadId,
      eip
    };

    // Ring buffer
    if (this.writes.length < this.maxHistorySize) {
      this.writes.push(write);
    } else {
      this.writes[this.writeIndex] = write;
    }
    this.writeIndex = (this.writeIndex + 1) % this.maxHistorySize;
    this.totalWrites++;

    // Check for race conditions
    this.detectRaceForWrite(write);
  }

  /**
   * Record a memory read.
   */
  recordRead(
    address: number,
    source: string,
    threadId: number,
    eip: number
  ): void {
    if (!this.enabled) return;

    const read: MemoryRead = {
      address,
      timestamp: Date.now(),
      source,
      threadId,
      eip
    };

    // Ring buffer
    if (this.reads.length < this.maxHistorySize) {
      this.reads.push(read);
    } else {
      this.reads[this.readIndex] = read;
    }
    this.readIndex = (this.readIndex + 1) % this.maxHistorySize;
    this.totalReads++;
  }

  /**
   * Detect race condition for a write operation.
   * Checks if a different source read this address recently.
   */
  private detectRaceForWrite(write: MemoryWrite): void {
    const now = write.timestamp;

    // Look for recent reads to this address from different sources
    for (const read of this.reads) {
      if (read.address !== write.address) continue;
      if (read.source === write.source) continue;  // Same source is OK

      const timeDelta = now - read.timestamp;
      if (timeDelta < 0 || timeDelta > this.raceWindowMs) continue;

      // Found a race!
      const race: RaceDetection = {
        address: write.address,
        read,
        write,
        timeDelta
      };

      this.races.push(race);
      this.totalRaces++;

      Logger.warn(
        LogCategory.SYSTEM,
        `[RaceDetector] 🏁 RACE DETECTED at 0x${write.address.toString(16)}:\n` +
        `  READ  by ${read.source} (thread ${read.threadId}, EIP=0x${read.eip.toString(16)}) at T+0ms\n` +
        `  WRITE by ${write.source} (thread ${write.threadId}, EIP=0x${write.eip.toString(16)}) at T+${timeDelta}ms\n` +
        `  Value written: 0x${write.value.toString(16)}`
      );

      // Only report first race per write
      break;
    }
  }

  /**
   * Get happens-before chain for an address.
   * Returns chronological sequence of reads/writes.
   */
  getHappensBeforeChain(address: number): Array<MemoryWrite | MemoryRead> {
    const chain: Array<MemoryWrite | MemoryRead> = [];

    // Collect all accesses to this address
    for (const read of this.reads) {
      if (read.address === address) {
        chain.push(read);
      }
    }
    for (const write of this.writes) {
      if (write.address === address) {
        chain.push(write);
      }
    }

    // Sort by timestamp
    chain.sort((a, b) => a.timestamp - b.timestamp);

    return chain;
  }

  /**
   * Dump all detected races.
   */
  dumpRaces(): void {
    console.log('[RaceDetector] === Detected Races ===');
    console.log(`  Total races: ${this.totalRaces}`);

    for (let i = 0; i < Math.min(this.races.length, 20); i++) {
      const race = this.races[i];
      console.log(`\n  Race #${i + 1} at 0x${race.address.toString(16)}:`);
      console.log(`    READ  by ${race.read.source} (thread ${race.read.threadId})`);
      console.log(`    WRITE by ${race.write.source} (thread ${race.write.threadId}) +${race.timeDelta}ms`);
      console.log(`    Value: 0x${race.write.value.toString(16)}`);
    }

    if (this.races.length > 20) {
      console.log(`\n  ... and ${this.races.length - 20} more races`);
    }
  }

  /**
   * Dump happens-before chain for an address.
   */
  dumpHappensBeforeChain(address: number): void {
    const chain = this.getHappensBeforeChain(address);

    console.log(`[RaceDetector] === Happens-Before Chain for 0x${address.toString(16)} ===`);
    console.log(`  Total accesses: ${chain.length}`);

    const startTime = chain[0]?.timestamp ?? 0;
    for (const access of chain) {
      const relTime = access.timestamp - startTime;
      const isWrite = 'value' in access;
      const type = isWrite ? 'WRITE' : 'READ ';
      const value = isWrite ? ` = 0x${(access as MemoryWrite).value.toString(16)}` : '';

      console.log(
        `  [+${relTime.toString().padStart(6, ' ')}ms] ${type} by ${access.source.padEnd(20)} ` +
        `(thread ${access.threadId}, EIP=0x${access.eip.toString(16)})${value}`
      );
    }
  }

  /**
   * Get statistics.
   */
  getStats(): {
    enabled: boolean;
    totalWrites: number;
    totalReads: number;
    totalRaces: number;
    historySize: number;
  } {
    return {
      enabled: this.enabled,
      totalWrites: this.totalWrites,
      totalReads: this.totalReads,
      totalRaces: this.totalRaces,
      historySize: this.writes.length + this.reads.length
    };
  }

  /**
   * Reset race detector.
   */
  reset(): void {
    this.writes = [];
    this.reads = [];
    this.races = [];
    this.writeIndex = 0;
    this.readIndex = 0;
    this.totalWrites = 0;
    this.totalReads = 0;
    this.totalRaces = 0;
  }
}

// Global singleton (disabled by default)
export const raceDetector = new RaceDetector(false);
