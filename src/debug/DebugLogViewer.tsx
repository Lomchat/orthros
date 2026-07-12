import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLogClient, sendLogToServer, flushLogClient } from "../utils/log-client";

type LogLevel = 0 | 1 | 2 | 3 | 4;

type LogEntry = {
  timestamp: number;
  category: string;
  level: LogLevel;
  message: string;
};

type DebugLogViewerProps = {
  isOpen: boolean;
  onClose: () => void;
  worker: Worker | null;
};

const LOG_CATEGORIES = [
  "THUNK",
  "USER32",
  "GDI32",
  "KERNEL32",
  "D3D9",
  "DDRAW",
  "SYSTEM",
  "THREAD",
  "CALLBACK",
  "COM",
  "RESOURCE",
];

// Virtualization constants
const ITEM_HEIGHT = 24; // approximate height of one log entry in pixels
const OVERSCAN = 50; // render +50 elements above/below for smooth scrolling
const MAX_LOGS = 50000; // maximum logs in memory (circular buffer)
const BATCH_SIZE = 100; // flush batch when this many entries accumulated
const BATCH_TIMEOUT_MS = 50; // flush batch after this timeout
const FILTER_CHUNK_SIZE = 1000; // process filters in chunks of this size

export default function DebugLogViewer({ isOpen, onClose, worker }: DebugLogViewerProps) {
  // Data storage (refs - don't trigger re-renders)
  const logsRef = useRef<LogEntry[]>([]);
  const filteredLogsRef = useRef<LogEntry[]>([]);

  // Update triggers (minimal state)
  const [logsVersion, setLogsVersion] = useState(0);
  const [filtering, setFiltering] = useState(false);

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);

  // Filters
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(() => {
    // Load from localStorage
    try {
      const saved = localStorage.getItem("debug-log-viewer-categories");
      if (saved) {
        const parsed = JSON.parse(saved);
        return new Set(parsed);
      }
    } catch {}
    return new Set(LOG_CATEGORIES); // All categories by default
  });

  const [selectedLevels, setSelectedLevels] = useState<Set<LogLevel>>(() => {
    // Load from localStorage
    try {
      const saved = localStorage.getItem("debug-log-viewer-levels");
      if (saved) {
        const parsed = JSON.parse(saved);
        return new Set(parsed);
      }
    } catch {}
    return new Set([0, 1, 2, 3, 4]);
  });

  const [searchText, setSearchText] = useState(() => {
    try {
      return localStorage.getItem("debug-log-viewer-search") || "";
    } catch {
      return "";
    }
  });
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);

  // Virtualization state
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Refs for batching
  const pendingUpdatesRef = useRef<LogEntry[]>([]);
  const batchTimeoutRef = useRef<number | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  // Save filters to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("debug-log-viewer-categories", JSON.stringify(Array.from(selectedCategories)));
    } catch {}
  }, [selectedCategories]);

  useEffect(() => {
    try {
      localStorage.setItem("debug-log-viewer-levels", JSON.stringify(Array.from(selectedLevels)));
    } catch {}
  }, [selectedLevels]);

  useEffect(() => {
    try {
      localStorage.setItem("debug-log-viewer-search", searchText);
    } catch {}
  }, [searchText]);

  // Debounce search text
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchText]);

  // Batch log entries to avoid excessive re-renders
  const flushPendingLogs = useCallback(() => {
    if (batchTimeoutRef.current !== null) {
      clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = null;
    }

    if (pendingUpdatesRef.current.length === 0) return;

    const newEntries = pendingUpdatesRef.current;
    pendingUpdatesRef.current = [];

    logsRef.current.push(...newEntries);

    // Limit size (circular buffer)
    if (logsRef.current.length > MAX_LOGS) {
      logsRef.current = logsRef.current.slice(-MAX_LOGS);
    }

    // Trigger update (without passing data, only version)
    setLogsVersion((v) => v + 1);
  }, []);

  const addLogEntry = useCallback(
    (entry: LogEntry) => {
      pendingUpdatesRef.current.push(entry);

      // Send to log server immediately (if enabled)
      sendLogToServer(entry);

      // Immediate flush if accumulated many
      if (pendingUpdatesRef.current.length >= BATCH_SIZE) {
        flushPendingLogs();
        return;
      }

      // Or via timeout
      if (batchTimeoutRef.current === null) {
        batchTimeoutRef.current = window.setTimeout(flushPendingLogs, BATCH_TIMEOUT_MS);
      }
    },
    [flushPendingLogs]
  );

  // Filter version to trigger re-render after filtering completes
  const [filterVersion, setFilterVersion] = useState(0);

  // Lazy filtering with chunking
  const applyFilters = useCallback(
    async (
      logs: LogEntry[],
      categories: Set<string>,
      levels: Set<LogLevel>,
      searchText: string,
      caseSensitive: boolean
    ) => {
      setFiltering(true);

      // Fast pre-filtering by index
      let filtered = logs;

      if (categories.size < LOG_CATEGORIES.length) {
        filtered = filtered.filter((e) => categories.has(e.category));
      }

      if (levels.size < 4) {
        filtered = filtered.filter((e) => levels.has(e.level));
      }

      // Text search - most expensive, do in chunks
      if (searchText) {
        let searchRegex: RegExp;
        try {
          searchRegex = new RegExp(searchText, caseSensitive ? "" : "i");
        } catch {
          // Invalid regex, fallback to simple string search
          const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          searchRegex = new RegExp(escaped, caseSensitive ? "" : "i");
        }

        const chunks: LogEntry[][] = [];

        for (let i = 0; i < filtered.length; i += FILTER_CHUNK_SIZE) {
          const chunk = filtered.slice(i, i + FILTER_CHUNK_SIZE);
          chunks.push(
            chunk.filter((e) => searchRegex.test(e.message) || searchRegex.test(e.category))
          );

          // Yield to UI every 10 chunks
          if (i % (FILTER_CHUNK_SIZE * 10) === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }

        filtered = chunks.flat();
      }

      filteredLogsRef.current = filtered;
      setFiltering(false);
      // Trigger re-render with separate filter version
      setFilterVersion((v) => v + 1);
    },
    []
  );

  // Apply filters when dependencies change
  useEffect(() => {
    if (logsRef.current.length === 0) {
      filteredLogsRef.current = [];
      setFiltering(false);
      setFilterVersion((v) => v + 1);
      return;
    }

    applyFilters(
      logsRef.current,
      selectedCategories,
      selectedLevels,
      debouncedSearchText,
      caseSensitive
    );
  }, [logsVersion, selectedCategories, selectedLevels, debouncedSearchText, caseSensitive, applyFilters]);

  // Enable/disable log server client
  useEffect(() => {
    if (isOpen) {
      // Enable log client when viewer is open
      getLogClient().enable();
    }
    return () => {
      // Disable when viewer closes (but keep connection for other uses)
      // Actually, let's keep it enabled as long as component is mounted
    };
  }, [isOpen]);

  // Handle log streaming from worker
  useEffect(() => {
    if (!worker || !isOpen) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "log_stream_entry") {
        // Legacy single-entry format (backward compatibility)
        const entry = event.data.entry as LogEntry;
        addLogEntry(entry); // batching instead of direct setState
      } else if (event.data?.type === "log_stream_batch") {
        // New batch format - process all entries efficiently
        const entries = event.data.entries as LogEntry[];
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            addLogEntry(entry); // Uses internal batching mechanism
          }
        }
      }
      if (event.data?.type === "log_get_recent") {
        if (event.data.ok && Array.isArray(event.data.entries)) {
          logsRef.current = event.data.entries;
          setLogsVersion((v) => v + 1);
        }
      }
    };

    worker.addEventListener("message", handleMessage);
    return () => {
      worker.removeEventListener("message", handleMessage);
      // Flush any pending logs on unmount
      flushPendingLogs();
    };
  }, [worker, isOpen, addLogEntry, flushPendingLogs]);

  // Update streaming when categories change
  useEffect(() => {
    if (!worker || !isStreaming) return;

    // Debounce to avoid spamming worker on fast toggling
    const timeoutId = setTimeout(() => {
      worker.postMessage({
        type: "log_stream_enable",
        enabled: true,
        categories: Array.from(selectedCategories),
      });
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [selectedCategories, isStreaming, worker]);

  // Calculate visible range for virtualization
  const visibleRange = useMemo(() => {
    if (!containerHeight || filteredLogsRef.current.length === 0) {
      return { start: 0, end: 0 };
    }

    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
    const end = Math.min(
      filteredLogsRef.current.length - 1,
      Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN
    );

    return { start, end };
  }, [scrollTop, containerHeight, filterVersion]);

  const visibleLogs = useMemo(() => {
    return filteredLogsRef.current.slice(visibleRange.start, visibleRange.end + 1);
  }, [visibleRange, filterVersion]);

  // Measure container height
  useEffect(() => {
    if (!logContainerRef.current) return;

    const updateHeight = () => {
      if (logContainerRef.current) {
        setContainerHeight(logContainerRef.current.clientHeight);
      }
    };

    updateHeight();
    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(logContainerRef.current);

    return () => resizeObserver.disconnect();
  }, [isOpen]);

  // Smart auto-scroll: only if user is at bottom
  useEffect(() => {
    if (!autoScroll || !logContainerRef.current) return;
    if (filterVersion === 0) return;

    const container = logContainerRef.current;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 50;

    if (isNearBottom && !userScrolledUp) {
      container.scrollTop = container.scrollHeight;
    }
  }, [filterVersion, autoScroll, userScrolledUp]);

  // Track user scroll to detect if they scrolled up
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const currentScrollTop = target.scrollTop;

    // Detect if user manually scrolled up
    if (lastScrollTopRef.current > currentScrollTop) {
      const isAtBottom =
        target.scrollHeight - currentScrollTop - target.clientHeight < 50;
      if (!isAtBottom) {
        setUserScrolledUp(true);
      } else {
        setUserScrolledUp(false);
      }
    } else if (
      target.scrollHeight - currentScrollTop - target.clientHeight < 50
    ) {
      setUserScrolledUp(false);
    }

    setScrollTop(currentScrollTop);
    lastScrollTopRef.current = currentScrollTop;
  }, []);

  // Jump to bottom
  const jumpToBottom = useCallback(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setUserScrolledUp(false);
    }
  }, []);

  const toggleStreaming = useCallback(() => {
    if (!worker) return;

    const newState = !isStreaming;
    setIsStreaming(newState);

    if (newState) {
      // Enable streaming with selected categories
      worker.postMessage({
        type: "log_stream_enable",
        enabled: true,
        categories: Array.from(selectedCategories),
      });
    } else {
      // Disable streaming and flush remaining logs to server
      worker.postMessage({
        type: "log_stream_enable",
        enabled: false,
      });
      flushLogClient();
    }
  }, [worker, isStreaming, selectedCategories]);

  const loadRecent = useCallback(() => {
    if (!worker) return;
    worker.postMessage({ type: "log_get_recent", count: 2000 });
  }, [worker]);

  const clearLogs = useCallback(() => {
    logsRef.current = [];
    filteredLogsRef.current = [];
    setLogsVersion((v) => v + 1);
    flushPendingLogs();
  }, [flushPendingLogs]);

  const copyToClipboard = useCallback(() => {
    const text = filteredLogsRef.current
      .map((entry) => {
        const relTime = (entry.timestamp / 1000).toFixed(3);
        return `[${relTime}s] [${entry.category}] ${entry.message}`;
      })
      .join("\n");
    navigator.clipboard.writeText(text).then(
      () => alert("Logs copied to clipboard"),
      (err) => alert("Failed to copy: " + err)
    );
  }, []);

  const toggleCategory = useCallback((category: string) => {
    setSelectedCategories((prev) => {
      const updated = new Set(prev);
      if (updated.has(category)) {
        updated.delete(category);
      } else {
        updated.add(category);
      }
      return updated;
    });
  }, []);

  const toggleLevel = useCallback((level: LogLevel) => {
    setSelectedLevels((prev) => {
      const updated = new Set(prev);
      if (updated.has(level)) {
        updated.delete(level);
      } else {
        updated.add(level);
      }
      return updated;
    });
  }, []);

  // Preset filters
  const applyPresetFilter = useCallback((preset: string) => {
    switch (preset) {
      case "d3d9-only":
        setSelectedCategories(new Set(["D3D9"]));
        setSelectedLevels(new Set([0, 1, 2, 3]));
        setSearchText("");
        break;
      case "errors-only":
        setSelectedCategories(new Set(LOG_CATEGORIES));
        setSelectedLevels(new Set([1])); // ERROR only
        setSearchText("");
        break;
      case "texture-calls":
        setSelectedCategories(new Set(LOG_CATEGORIES));
        setSelectedLevels(new Set([0, 1, 2, 3]));
        setSearchText("SetTexture|DrawPrimitive|DrawIndexedPrimitive");
        break;
      case "settexture-only":
        setSelectedCategories(new Set(LOG_CATEGORIES));
        setSelectedLevels(new Set([0, 1, 2, 3]));
        setSearchText("SetTexture");
        break;
      case "senior-debug":
        // Senior developer preset: errors + important graphics events, no thunk spam
        setSelectedCategories(new Set(["SYSTEM", "D3D9", "DDRAW", "COM", "RESOURCE"]));
        setSelectedLevels(new Set([1, 2, 3])); // ERROR, WARN, NORMAL
        setSearchText("");
        break;
      case "all":
        setSelectedCategories(new Set(LOG_CATEGORIES));
        setSelectedLevels(new Set([0, 1, 2, 3, 4]));
        setSearchText("");
        break;
    }
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedCategories(new Set(LOG_CATEGORIES));
    setSelectedLevels(new Set([0, 1, 2, 3, 4]));
    setSearchText("");
    setCaseSensitive(false);
  }, []);

  const getLevelName = (level: LogLevel): string => {
    switch (level) {
      case 0:
        return "SILENT";
      case 1:
        return "ERROR";
      case 2:
        return "WARN";
      case 3:
        return "NORMAL";
      case 4:
        return "VERBOSE";
      default:
        return "UNKNOWN";
    }
  };

  const getLevelColor = (level: LogLevel): string => {
    switch (level) {
      case 1:
        return "#ff6b6b"; // ERROR - red
      case 2:
        return "#ffa726"; // WARN - orange
      case 3:
        return "#4ecdc4"; // NORMAL - teal
      case 4:
        return "#95e1d3"; // VERBOSE - light teal
      default:
        return "#aaa";
    }
  };

  // Highlight search text in message
  const highlightText = (text: string, search: string): React.ReactNode => {
    if (!search) return text;

    let regex: RegExp;
    try {
      regex = new RegExp(search, caseSensitive ? "g" : "gi");
    } catch {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, caseSensitive ? "g" : "gi");
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      // Add highlighted match
      parts.push(
        <span key={match.index} style={{ backgroundColor: "#ffd700", color: "#000" }}>
          {match[0]}
        </span>
      );
      lastIndex = regex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  // Log entry component (memoized for performance)
  const LogEntryComponent = React.memo(
    ({ entry, index }: { entry: LogEntry; index: number }) => {
      const relTime = (entry.timestamp / 1000).toFixed(3);
      const levelName = getLevelName(entry.level);
      const levelColor = getLevelColor(entry.level);

      return (
        <div style={{ marginBottom: "4px", height: ITEM_HEIGHT, lineHeight: `${ITEM_HEIGHT}px` }}>
          <span style={{ color: "#888" }}>[{relTime}s]</span>{" "}
          <span
            style={{
              color: levelColor,
              fontWeight: "bold",
            }}
          >
            [{levelName}]
          </span>{" "}
          <span
            style={{
              color: "#4ecdc4",
              fontWeight: "bold",
            }}
          >
            [{entry.category}]
          </span>{" "}
          <span style={{ color: "#fff" }}>{highlightText(entry.message, debouncedSearchText)}</span>
        </div>
      );
    }
  );
  LogEntryComponent.displayName = "LogEntryComponent";

  if (!isOpen) return null;

  const totalLogs = logsRef.current.length;
  const filteredCount = filteredLogsRef.current.length;
  const showingCount = visibleLogs.length;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#1a1a1a",
          borderRadius: "8px",
          padding: "20px",
          width: "90%",
          maxWidth: "1200px",
          height: "80vh",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          border: "1px solid #333",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 style={{ margin: 0, color: "#fff", fontSize: "18px" }}>
            Debug Log Viewer
          </h2>
          <button
            onClick={onClose}
            style={{
              padding: "6px 12px",
              backgroundColor: "#333",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        {/* Search bar */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search logs..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{
              flex: 1,
              padding: "6px 12px",
              backgroundColor: "#0a0a0a",
              color: "#fff",
              border: "1px solid #333",
              borderRadius: "4px",
              fontSize: "12px",
            }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#fff", fontSize: "12px" }}>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            Case
          </label>
        </div>

        {/* Preset filters */}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <span style={{ color: "#fff", fontSize: "12px", alignSelf: "center" }}>
            Presets:
          </span>
          <button
            onClick={() => applyPresetFilter("all")}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
            }}
          >
            All
          </button>
          <button
            onClick={() => applyPresetFilter("d3d9-only")}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
            }}
          >
            D3D9 Only
          </button>
          <button
            onClick={() => applyPresetFilter("errors-only")}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
            }}
          >
            Errors Only
          </button>
          <button
            onClick={() => applyPresetFilter("texture-calls")}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
            }}
          >
            Texture Calls
          </button>
          <button
            onClick={() => applyPresetFilter("settexture-only")}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#4a90e2",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            Only SetTexture
          </button>
          <button
            onClick={() => applyPresetFilter("senior-debug")}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#e74c3c",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            Senior Debug
          </button>
          <button
            onClick={clearFilters}
            style={{
              padding: "4px 8px",
              fontSize: "11px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
            }}
          >
            Clear Filters
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button
            onClick={toggleStreaming}
            style={{
              padding: "6px 12px",
              backgroundColor: isStreaming ? "#ff6b6b" : "#4ecdc4",
              color: "#000",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            {isStreaming ? "Stop Stream" : "Start Stream"}
          </button>
          <button
            onClick={loadRecent}
            style={{
              padding: "6px 12px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Load Recent
          </button>
          <button
            onClick={clearLogs}
            style={{
              padding: "6px 12px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
          <button
            onClick={copyToClipboard}
            style={{
              padding: "6px 12px",
              backgroundColor: "#666",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Copy to Clipboard
          </button>
          {userScrolledUp && (
            <button
              onClick={jumpToBottom}
              style={{
                padding: "6px 12px",
                backgroundColor: "#4ecdc4",
                color: "#000",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              Jump to Bottom
            </button>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#fff" }}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          {filtering && (
            <span style={{ color: "#4ecdc4", fontSize: "12px" }}>Filtering...</span>
          )}
          <span style={{ color: "#aaa", marginLeft: "auto", fontSize: "12px" }}>
            Showing {showingCount} of {filteredCount} logs
            {totalLogs !== filteredCount && ` (${totalLogs} total)`}
          </span>
        </div>

        {/* Level filters */}
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "#fff", fontSize: "12px" }}>Levels:</span>
          {([0, 1, 2, 3] as LogLevel[]).map((level) => (
            <label
              key={level}
              style={{ display: "flex", alignItems: "center", gap: "4px", color: "#fff", fontSize: "11px" }}
            >
              <input
                type="checkbox"
                checked={selectedLevels.has(level)}
                onChange={() => toggleLevel(level)}
              />
              {getLevelName(level)}
            </label>
          ))}
        </div>

        {/* Category filters */}
        <div
          style={{
            display: "flex",
            gap: "6px",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#fff", fontSize: "12px", alignSelf: "center" }}>
            Categories:
          </span>
          {LOG_CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => toggleCategory(cat)}
              style={{
                padding: "4px 8px",
                fontSize: "11px",
                backgroundColor: selectedCategories.has(cat) ? "#4ecdc4" : "#333",
                color: selectedCategories.has(cat) ? "#000" : "#aaa",
                border: "none",
                borderRadius: "3px",
                cursor: "pointer",
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Virtualized log container */}
        <div
          ref={logContainerRef}
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: "auto",
            backgroundColor: "#0a0a0a",
            border: "1px solid #333",
            borderRadius: "4px",
            padding: "12px",
            fontFamily: "monospace",
            fontSize: "12px",
            lineHeight: "1.5",
            position: "relative",
          }}
        >
          {filteredLogsRef.current.length === 0 ? (
            <div style={{ color: "#666", textAlign: "center", paddingTop: "40px" }}>
              No logs yet. Click "Start Stream" or "Load Recent" to begin.
            </div>
          ) : (
            <>
              {/* Spacer for elements above visible range */}
              <div style={{ height: visibleRange.start * ITEM_HEIGHT }} />

              {/* Visible log entries */}
              {visibleLogs.map((entry, idx) => {
                const actualIdx = visibleRange.start + idx;
                return (
                  <LogEntryComponent
                    key={`${entry.timestamp}-${actualIdx}`}
                    entry={entry}
                    index={actualIdx}
                  />
                );
              })}

              {/* Spacer for elements below visible range */}
              <div
                style={{
                  height: Math.max(0, (filteredLogsRef.current.length - visibleRange.end - 1) * ITEM_HEIGHT),
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
