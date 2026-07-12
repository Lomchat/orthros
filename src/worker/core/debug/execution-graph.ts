/**
 * ExecutionGraph - Execution Timeline Visualization
 *
 * Records execution events and generates visualization.
 * Useful for understanding async/callback/thread interactions.
 *
 * Features:
 * - Record thunk calls, callbacks, thread switches, async operations
 * - Export Mermaid Gantt chart for timeline visualization
 * - Thread interleaving visualization
 */

import { Logger, LogCategory } from '../logger';

type EventType = 'thunk' | 'callback' | 'thread_switch' | 'async_start' | 'async_complete' | 'state_transition';

interface ExecutionEvent {
  type: EventType;
  timestamp: number;
  name: string;
  threadId: number;
  duration?: number;      // For events with start/end
  metadata?: any;
}

/**
 * Execution graph for timeline visualization.
 */
export class ExecutionGraph {
  private enabled = false;
  private events: ExecutionEvent[] = [];
  private maxEvents = 10000;

  // Active events (for duration tracking)
  private activeEvents = new Map<string, ExecutionEvent>();

  // Statistics
  private totalEvents = 0;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  /**
   * Enable execution graph recording.
   */
  enable(): void {
    this.enabled = true;
    Logger.log(LogCategory.SYSTEM, '[ExecutionGraph] Enabled');
  }

  /**
   * Disable execution graph recording.
   */
  disable(): void {
    this.enabled = false;
    Logger.log(LogCategory.SYSTEM, '[ExecutionGraph] Disabled');
  }

  /**
   * Record an execution event.
   */
  recordEvent(
    type: EventType,
    name: string,
    threadId: number,
    metadata?: any
  ): void {
    if (!this.enabled) return;

    const event: ExecutionEvent = {
      type,
      timestamp: Date.now(),
      name,
      threadId,
      metadata
    };

    if (this.events.length >= this.maxEvents) {
      // Drop oldest events
      this.events.shift();
    }

    this.events.push(event);
    this.totalEvents++;
  }

  /**
   * Start a timed event (thunk, async operation).
   * Call endEvent() with the same ID to record duration.
   */
  startEvent(
    type: EventType,
    name: string,
    threadId: number,
    id: string,
    metadata?: any
  ): void {
    if (!this.enabled) return;

    const event: ExecutionEvent = {
      type,
      timestamp: Date.now(),
      name,
      threadId,
      metadata
    };

    this.activeEvents.set(id, event);
  }

  /**
   * End a timed event.
   */
  endEvent(id: string): void {
    if (!this.enabled) return;

    const event = this.activeEvents.get(id);
    if (!event) return;

    event.duration = Date.now() - event.timestamp;
    this.activeEvents.delete(id);

    if (this.events.length >= this.maxEvents) {
      this.events.shift();
    }

    this.events.push(event);
    this.totalEvents++;
  }

  /**
   * Export timeline as Mermaid Gantt chart.
   */
  exportMermaidGantt(): string {
    if (this.events.length === 0) {
      return '```mermaid\ngantt\n  title Execution Timeline (no events)\n```';
    }

    const startTime = this.events[0].timestamp;
    let mermaid = '```mermaid\ngantt\n';
    mermaid += '  title Execution Timeline\n';
    mermaid += '  dateFormat x\n';
    mermaid += '  axisFormat %L ms\n\n';

    // Group events by thread
    const threadEvents = new Map<number, ExecutionEvent[]>();
    for (const event of this.events) {
      if (!threadEvents.has(event.threadId)) {
        threadEvents.set(event.threadId, []);
      }
      threadEvents.get(event.threadId)!.push(event);
    }

    // Generate sections for each thread
    for (const [threadId, events] of threadEvents.entries()) {
      mermaid += `  section Thread ${threadId}\n`;

      for (const event of events) {
        const start = event.timestamp - startTime;
        const end = event.duration ? start + event.duration : start + 1;
        const taskName = `${event.type}: ${event.name}`.replace(/:/g, '-');

        mermaid += `    ${taskName} : ${start}, ${end}\n`;
      }

      mermaid += '\n';
    }

    mermaid += '```';
    return mermaid;
  }

  /**
   * Export thread interleaving visualization.
   * Shows which thread was running at each point in time.
   */
  exportThreadInterleaving(): string {
    if (this.events.length === 0) {
      return 'Thread Interleaving (no events)';
    }

    const startTime = this.events[0].timestamp;
    let output = 'Thread Interleaving:\n';
    output += '=' .repeat(80) + '\n';

    let lastThreadId = -1;
    for (const event of this.events) {
      const relTime = event.timestamp - startTime;

      if (event.threadId !== lastThreadId) {
        output += `\n[+${relTime.toString().padStart(6, ' ')}ms] Thread ${event.threadId}\n`;
        lastThreadId = event.threadId;
      }

      const duration = event.duration ? ` (${event.duration}ms)` : '';
      output += `  ${event.type.padEnd(16)} ${event.name}${duration}\n`;
    }

    return output;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    enabled: boolean;
    totalEvents: number;
    eventsInMemory: number;
    activeEvents: number;
  } {
    return {
      enabled: this.enabled,
      totalEvents: this.totalEvents,
      eventsInMemory: this.events.length,
      activeEvents: this.activeEvents.size
    };
  }

  /**
   * Dump execution graph to console.
   */
  dump(): void {
    console.log('[ExecutionGraph] === Execution Timeline ===');
    console.log(`  Total events: ${this.totalEvents}`);
    console.log(`  Events in memory: ${this.events.length}`);
    console.log(`  Active events: ${this.activeEvents.size}`);

    if (this.events.length > 0) {
      console.log('\n' + this.exportThreadInterleaving());
    }
  }

  /**
   * Reset execution graph.
   */
  reset(): void {
    this.events = [];
    this.activeEvents.clear();
    this.totalEvents = 0;
  }
}

// Global singleton (disabled by default)
export const executionGraph = new ExecutionGraph(false);
