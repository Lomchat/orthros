// Logger control handlers (verbose IndexedDB capture, global kill switch, live
// log streaming to the host DebugLogViewer).
import { Logger, LogCategory } from "../core/logger";

/** Handles log_* / logging_* host messages. Returns true if the message was consumed. */
export function handleLoggingMessage(message: any): boolean {
  if (message?.type === "log_verbose_enable") {
    const enabled = Boolean(message.enabled);
    Logger.enableVerboseIndexedDb({
      enabled,
      dbName: message.dbName,
      storeName: message.storeName
    });
    if (enabled) {
      // Use senior developer preset for efficient debugging without log explosion
      Logger.applySeniorDebugPreset();
    }
    self.postMessage({ type: "log_verbose_enable", ok: true, enabled });
    return true;
  }

  if (message?.type === "log_verbose_export") {
    Logger.exportVerboseIndexedDb()
      .then((text) => {
        self.postMessage({ type: "log_verbose_export", ok: true, text });
      })
      .catch((error) => {
        self.postMessage({ type: "log_verbose_export", ok: false, error: String(error) });
      });
    return true;
  }

  if (message?.type === "log_verbose_clear") {
    Logger.clearVerboseIndexedDb()
      .then(() => {
        self.postMessage({ type: "log_verbose_clear", ok: true });
      })
      .catch((error) => {
        self.postMessage({ type: "log_verbose_clear", ok: false, error: String(error) });
      });
    return true;
  }

  // Global logging kill switch - suppresses all console output when disabled
  if (message?.type === "logging_global_enable") {
    const enabled = Boolean(message.enabled);
    Logger.setGlobalEnabled(enabled);
    return true;
  }

  if (message?.type === "log_stream_enable") {
    const enabled = Boolean(message.enabled);
    const categories = message.categories as string[] | undefined;

    if (enabled) {
      // Convert string categories to enum values
      const categoryEnums = categories?.map((cat) => {
        const key = cat.toUpperCase() as keyof typeof LogCategory;
        return LogCategory[key];
      }).filter(Boolean);

      Logger.setStreamCallback((batch) => {
        // Send batch as single message to reduce postMessage overhead
        self.postMessage({
          type: "log_stream_batch",
          entries: batch.map((entry) => ({
            timestamp: entry.timestamp,
            category: entry.category,
            level: entry.level,
            message: entry.message
          }))
        });
      }, categoryEnums);
    } else {
      Logger.setStreamCallback(null);
    }
    self.postMessage({ type: "log_stream_enable", ok: true, enabled });
    return true;
  }

  if (message?.type === "log_get_recent") {
    const count = typeof message.count === "number" ? message.count : undefined;
    const entries = Logger.getRecentEntries(count);
    self.postMessage({
      type: "log_get_recent",
      ok: true,
      entries: entries.map((entry) => ({
        timestamp: entry.timestamp,
        category: entry.category,
        level: entry.level,
        message: entry.message
      }))
    });
    return true;
  }

  return false;
}
