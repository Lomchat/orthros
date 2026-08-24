/** Opaque UDP-over-WebSocket virtual LAN used by the browser Winsock provider. */

export interface BfmeRelayPeer {
    room: string;
    client: string;
    ip: string;
    ipBytes: [number, number, number, number];
    connectedAt: number;
}

type RelaySocket = {
    data: BfmeRelayPeer;
    send(data: string | ArrayBuffer | Uint8Array): number;
    close(code?: number, reason?: string): void;
};

const rooms = new Map<string, Set<RelaySocket>>();
const metrics = {
    acceptedConnections: 0,
    rejectedConnections: 0,
    datagramsReceived: 0,
    datagramsForwarded: 0,
    bytesReceived: 0,
    bytesForwarded: 0,
};
const MAX_ROOM_PEERS = 8;

function parseVirtualIp(raw: string | null): [number, number, number, number] | null {
    const parts = (raw || "").split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    if (parts[0] !== 10 || parts[1] !== 42 || parts[3] < 2 || parts[3] === 255) return null;
    return parts as [number, number, number, number];
}

function sameIp(a: Uint8Array, offset: number, b: readonly number[]): boolean {
    return a[offset] === b[0] && a[offset + 1] === b[1] && a[offset + 2] === b[2] && a[offset + 3] === b[3];
}

function discoveryDestination(bytes: Uint8Array, peer: BfmeRelayPeer): boolean {
    return sameIp(bytes, 7, peer.ipBytes) ||
        sameIp(bytes, 7, [127, 0, 0, 1]) ||
        sameIp(bytes, 7, [255, 255, 255, 255]) ||
        sameIp(bytes, 7, [0, 0, 0, 0]);
}

function normaliseBinary(message: unknown): Uint8Array | null {
    if (message instanceof ArrayBuffer) return new Uint8Array(message);
    if (ArrayBuffer.isView(message)) {
        const view = message as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    return null;
}

export const bfmeRelayWebSocket = {
    open(ws: RelaySocket): void {
        let room = rooms.get(ws.data.room);
        if (!room) rooms.set(ws.data.room, room = new Set());

        // A reconnect with the same browser identity replaces its stale transport.
        for (const existing of room) {
            if (existing.data.client === ws.data.client) {
                room.delete(existing);
                try { existing.close(4001, "reconnected"); } catch { /* already gone */ }
            } else if (existing.data.ip === ws.data.ip) {
                metrics.rejectedConnections++;
                ws.close(4002, "virtual IP collision");
                return;
            }
        }
        if (room.size >= MAX_ROOM_PEERS) {
            metrics.rejectedConnections++;
            ws.close(4003, "room full");
            return;
        }
        room.add(ws);
        metrics.acceptedConnections++;
        ws.send(JSON.stringify({
            type: "welcome",
            room: ws.data.room,
            ip: ws.data.ip,
            peers: Math.max(0, room.size - 1),
        }));
    },

    message(ws: RelaySocket, message: unknown): void {
        if (typeof message === "string") return; // hello/control packet
        const input = normaliseBinary(message);
        if (!input || input.byteLength < 13 || input.byteLength > 65520 || input[0] !== 1) return;
        metrics.datagramsReceived++;
        metrics.bytesReceived += input.byteLength;

        // Copy because Bun may reuse the inbound message buffer; also make the
        // source address authoritative rather than trusting browser bytes.
        const packet = new Uint8Array(input);
        packet.set(ws.data.ipBytes, 1);
        const room = rooms.get(ws.data.room);
        if (!room) return;

        const broadcast = discoveryDestination(packet, ws.data);
        for (const target of room) {
            if (target === ws) continue;
            if (!broadcast && !sameIp(packet, 7, target.data.ipBytes)) continue;
            // BFME discovers same-machine instances by scanning its own address on
            // ports 8086..8093. Across browsers that self-address is different, so
            // virtual-LAN broadcast must retarget the IP as well as fan the packet
            // out; otherwise the recipient's address-bound UDP socket drops it.
            const outbound = broadcast ? new Uint8Array(packet) : packet;
            if (broadcast) outbound.set(target.data.ipBytes, 7);
            try {
                target.send(outbound);
                metrics.datagramsForwarded++;
                metrics.bytesForwarded += outbound.byteLength;
            } catch { /* close event cleans membership */ }
        }
    },

    close(ws: RelaySocket): void {
        const room = rooms.get(ws.data.room);
        if (!room) return;
        room.delete(ws);
        if (room.size === 0) rooms.delete(ws.data.room);
    },
};

export function upgradeBfmeRelay(req: Request, server: { upgrade(req: Request, options: { data: BfmeRelayPeer }): boolean }): boolean {
    const url = new URL(req.url);
    if (url.pathname !== "/bfme-net") return false;
    const room = (url.searchParams.get("room") || "public").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64) || "public";
    const client = (url.searchParams.get("client") || "").slice(0, 96);
    const ipBytes = parseVirtualIp(url.searchParams.get("ip"));
    if (!client || !ipBytes) return false;
    const ip = ipBytes.join(".");
    return server.upgrade(req, {
        data: { room, client, ip, ipBytes, connectedAt: Date.now() },
    });
}

export function bfmeRelayStats(): { rooms: number; peers: number } & typeof metrics {
    let peers = 0;
    for (const room of rooms.values()) peers += room.size;
    return { rooms: rooms.size, peers, ...metrics };
}
