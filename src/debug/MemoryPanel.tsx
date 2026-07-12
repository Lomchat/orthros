import React, { useState } from "react";
import MemoryMonitorBody from "./MemoryMonitorBody";
import MemWatchBody from "./MemWatchBody";

type MemoryPanelProps = {
    isOpen: boolean;
    onClose: () => void;
    worker: Worker | null;
};

type MemoryTab = "monitor" | "watch";

/**
 * Memory debug panel with two tabs over disjoint worker RPC namespaces:
 *   Monitor       — allocator/heap/GC accounting (memory_*)
 *   Surface Watch — SYSMEM texture-data presence / probes / large writes (memwatch_*)
 * Both bodies stay mounted while the panel is open (hidden tab via display:none) so
 * watch state and heap history survive tab switches.
 */
export default function MemoryPanel({ isOpen, onClose, worker }: MemoryPanelProps) {
    const [tab, setTab] = useState<MemoryTab>("monitor");

    if (!isOpen) return null;

    const tabBtn = (id: MemoryTab, label: string) => (
        <button
            onClick={() => setTab(id)}
            style={{
                padding: "6px 12px",
                backgroundColor: tab === id ? "#333355" : "transparent",
                border: "none",
                borderBottom: tab === id ? "2px solid #6666ff" : "2px solid transparent",
                color: tab === id ? "#fff" : "#888",
                cursor: "pointer",
                fontSize: 12,
            }}
        >
            {label}
        </button>
    );

    return (
        <div style={{
            position: "fixed",
            top: 10,
            right: 10,
            width: 650,
            maxHeight: "90vh",
            backgroundColor: "#1a1a2e",
            border: "1px solid #4a4a6a",
            borderRadius: 8,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            zIndex: 10001,
            fontFamily: "monospace",
            fontSize: 12,
            color: "#e0e0e0",
            display: "flex",
            flexDirection: "column",
        }}>
            <div style={{
                padding: "8px 15px",
                borderBottom: "1px solid #4a4a6a",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                backgroundColor: "#252540",
            }}>
                <span style={{ fontWeight: "bold", fontSize: 14 }}>Memory</span>
                <div style={{ display: "flex", gap: 4 }}>
                    {tabBtn("monitor", "Monitor")}
                    {tabBtn("watch", "Surface Watch")}
                </div>
                <button
                    onClick={onClose}
                    style={{
                        padding: "4px 8px",
                        backgroundColor: "#333",
                        border: "none",
                        borderRadius: 4,
                        color: "white",
                        cursor: "pointer",
                    }}
                >
                    Close
                </button>
            </div>

            <div style={{ display: tab === "monitor" ? "flex" : "none", flexDirection: "column", minHeight: 0, flex: 1 }}>
                <MemoryMonitorBody worker={worker} />
            </div>
            <div style={{ display: tab === "watch" ? "flex" : "none", flexDirection: "column", minHeight: 0, flex: 1 }}>
                <MemWatchBody worker={worker} />
            </div>
        </div>
    );
}
