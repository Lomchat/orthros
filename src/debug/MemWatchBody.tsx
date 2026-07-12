import React, { useEffect, useRef, useState } from "react";

type WatchRegion = {
  name: string;
  start: number;
  size: number;
  hasData: boolean;
  nonZeroCount: number;
  nonZeroPercent: number;
  samplePixels: string;
  lastUpdate: number;
};

type ProbeResult = {
  name: string;
  start: number;
  size: number;
  hasData: boolean;
  nonZeroCount: number;
  samplePixels: string;
  timestamp: number;
};

type LargeWriteEvent = {
  source: string;
  address: number;
  size: number;
  timestamp: number;
  intersectsWithSurface: boolean;
  matchedRegionName?: string;
  matchedRegionStart?: number;
};

type MemWatchBodyProps = {
  worker: Worker | null;
};

/** Surface-watch tab of the Memory panel: SYSMEM texture regions, pre-Load probes,
 *  large-write events (memwatch_* worker RPC). Mount-scoped — subscribes while mounted. */
export default function MemWatchBody({ worker }: MemWatchBodyProps) {
  const [regions, setRegions] = useState<Map<number, WatchRegion>>(new Map());
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [largeWrites, setLargeWrites] = useState<LargeWriteEvent[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const maxProbes = 100;

  useEffect(() => {
    if (!worker) return;

    const handler = (event: MessageEvent) => {
      const { type, data } = event.data;

      if (type === "memwatch_region") {
        // New region registered
        setRegions(prev => {
          const next = new Map(prev);
          next.set(data.start, {
            name: data.name,
            start: data.start,
            size: data.size,
            hasData: false,
            nonZeroCount: 0,
            nonZeroPercent: 0,
            samplePixels: "",
            lastUpdate: Date.now(),
          });
          return next;
        });
      } else if (type === "memwatch_update") {
        // Region data changed
        setRegions(prev => {
          const next = new Map(prev);
          const existing = next.get(data.start);
          if (existing) {
            next.set(data.start, {
              ...existing,
              hasData: data.nonZeroCount > 0,
              nonZeroCount: data.nonZeroCount,
              nonZeroPercent: (100 * data.nonZeroCount / existing.size),
              samplePixels: data.samplePixels,
              lastUpdate: Date.now(),
            });
          }
          return next;
        });
      } else if (type === "memwatch_probe") {
        // Probe result
        setProbes(prev => {
          const next = [{
            name: data.name,
            start: data.start,
            size: data.size,
            hasData: data.hasData,
            nonZeroCount: data.nonZeroCount,
            samplePixels: data.samplePixels,
            timestamp: Date.now(),
          }, ...prev];
          return next.slice(0, maxProbes);
        });
      } else if (type === "memwatch_unwatch") {
        setRegions(prev => {
          const next = new Map(prev);
          next.delete(data.start);
          return next;
        });
      } else if (type === "memwatch_largewrite") {
        setLargeWrites(prev => {
          const next = [{
            source: data.source,
            address: data.address,
            size: data.size,
            timestamp: Date.now(),
            intersectsWithSurface: data.intersectsWithSurface,
            matchedRegionName: data.matchedRegionName,
            matchedRegionStart: data.matchedRegionStart,
          }, ...prev];
          return next.slice(0, 50); // Keep last 50
        });
      } else if (type === "memwatch_reset") {
        setRegions(new Map());
        setProbes([]);
        setLargeWrites([]);
      }
    };

    worker.addEventListener("message", handler);
    return () => worker.removeEventListener("message", handler);
  }, [worker]);

  const togglePolling = () => {
    if (!worker) return;
    const newState = !isPolling;
    worker.postMessage({ type: "memwatch_polling", enabled: newState });
    setIsPolling(newState);
  };

  const checkNow = () => {
    if (!worker) return;
    worker.postMessage({ type: "memwatch_check_all" });
  };

  const clearProbes = () => {
    setProbes([]);
  };

  const sortedRegions = Array.from(regions.values()).sort((a, b) => b.lastUpdate - a.lastUpdate);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {/* Action strip */}
      <div style={{
        padding: "8px 15px",
        borderBottom: "1px solid #4a4a6a",
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        backgroundColor: "#252540",
      }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={togglePolling}
            style={{
              padding: "4px 8px",
              backgroundColor: isPolling ? "#4CAF50" : "#555",
              border: "none",
              borderRadius: 4,
              color: "white",
              cursor: "pointer",
            }}
          >
            {isPolling ? "Polling ON" : "Polling OFF"}
          </button>
          <button
            onClick={checkNow}
            style={{
              padding: "4px 8px",
              backgroundColor: "#2196F3",
              border: "none",
              borderRadius: 4,
              color: "white",
              cursor: "pointer",
            }}
          >
            Check Now
          </button>
        </div>
      </div>

      {/* Watched Regions */}
      <div style={{ padding: 10, borderBottom: "1px solid #4a4a6a" }}>
        <div style={{ marginBottom: 8, fontWeight: "bold", color: "#888" }}>
          Watched Regions ({regions.size})
        </div>
        <div style={{ maxHeight: 150, overflowY: "auto" }}>
          {sortedRegions.length === 0 ? (
            <div style={{ color: "#666", fontStyle: "italic" }}>
              No SYSMEM texture surfaces created yet
            </div>
          ) : (
            sortedRegions.map(region => (
              <div
                key={region.start}
                style={{
                  padding: "6px 8px",
                  marginBottom: 4,
                  backgroundColor: region.hasData ? "#1a3a1a" : "#2a2a3a",
                  borderRadius: 4,
                  borderLeft: `3px solid ${region.hasData ? "#4CAF50" : "#f44336"}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#8888ff" }}>{region.name}</span>
                  <span style={{ color: region.hasData ? "#4CAF50" : "#f44336" }}>
                    {region.hasData ? "HAS DATA" : "EMPTY"}
                  </span>
                </div>
                <div style={{ color: "#888", fontSize: 11 }}>
                  0x{region.start.toString(16)} | {region.size}B |{" "}
                  {region.nonZeroPercent.toFixed(1)}% non-zero
                </div>
                {region.samplePixels && (
                  <div style={{ color: "#aaa", fontSize: 11 }}>
                    Pixels: {region.samplePixels}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Probe Results */}
      <div style={{ padding: 10, borderBottom: "1px solid #4a4a6a", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontWeight: "bold", color: "#888" }}>
            Probe Results ({probes.length})
          </span>
          <button
            onClick={clearProbes}
            style={{
              padding: "2px 6px",
              backgroundColor: "#555",
              border: "none",
              borderRadius: 4,
              color: "white",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Clear
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {probes.length === 0 ? (
            <div style={{ color: "#666", fontStyle: "italic" }}>
              No probes yet. Probes are triggered before IDirect3DTexture2_Load.
            </div>
          ) : (
            probes.map((probe, i) => (
              <div
                key={`${probe.timestamp}-${i}`}
                style={{
                  padding: "6px 8px",
                  marginBottom: 4,
                  backgroundColor: probe.hasData ? "#1a3a1a" : "#3a1a1a",
                  borderRadius: 4,
                  borderLeft: `3px solid ${probe.hasData ? "#4CAF50" : "#f44336"}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#ffcc00" }}>{probe.name}</span>
                  <span style={{
                    color: probe.hasData ? "#4CAF50" : "#f44336",
                    fontWeight: "bold"
                  }}>
                    {probe.hasData ? `${probe.nonZeroCount} bytes` : "EMPTY!"}
                  </span>
                </div>
                <div style={{ color: "#888", fontSize: 11 }}>
                  0x{probe.start.toString(16)} | {probe.size}B | Samples: [{probe.samplePixels}]
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Large Write Events */}
      <div style={{ padding: 10, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontWeight: "bold", color: "#888" }}>
            Large Write Events ({largeWrites.length})
          </span>
          <button
            onClick={() => setLargeWrites([])}
            style={{
              padding: "2px 6px",
              backgroundColor: "#555",
              border: "none",
              borderRadius: 4,
              color: "white",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Clear
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {largeWrites.length === 0 ? (
            <div style={{ color: "#666", fontStyle: "italic" }}>
              No large writes yet (&gt;64KB from ReadFile, etc.)
            </div>
          ) : (
            largeWrites.map((event, i) => (
              <div
                key={`${event.timestamp}-${i}`}
                style={{
                  padding: "6px 8px",
                  marginBottom: 4,
                  backgroundColor: event.intersectsWithSurface ? "#1a3a3a" : "#3a2a1a",
                  borderRadius: 4,
                  borderLeft: `3px solid ${event.intersectsWithSurface ? "#4CAF50" : "#ff9800"}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#ffcc00" }}>{event.source}</span>
                  <span style={{
                    color: event.intersectsWithSurface ? "#4CAF50" : "#ff9800",
                    fontWeight: "bold"
                  }}>
                    {event.intersectsWithSurface ? "→ SURFACE" : "→ HEAP"}
                  </span>
                </div>
                <div style={{ color: "#888", fontSize: 11 }}>
                  0x{event.address.toString(16)} | {event.size}B
                  {event.intersectsWithSurface && event.matchedRegionName && (
                    <span style={{ color: "#4CAF50" }}>
                      {" "}| Matches: {event.matchedRegionName} @ 0x{event.matchedRegionStart?.toString(16)}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{
        padding: "8px 15px",
        borderTop: "1px solid #4a4a6a",
        backgroundColor: "#252540",
        fontSize: 11,
        color: "#888",
      }}>
        <span style={{ color: "#4CAF50" }}>GREEN</span> = data present |{" "}
        <span style={{ color: "#f44336" }}>RED</span> = empty (zeros)
      </div>
    </div>
  );
}
