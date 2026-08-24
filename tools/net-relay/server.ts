import { bfmeRelayStats, bfmeRelayWebSocket, upgradeBfmeRelay } from "../../deploy/bfme-net-relay";

const port = Number(process.env.BFME_RELAY_PORT || 3002);

const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch(req, bunServer) {
        const url = new URL(req.url);
        if (url.pathname === "/bfme-net/health") {
            return Response.json({ ok: true, ...bfmeRelayStats() });
        }
        if (upgradeBfmeRelay(req, bunServer as any)) return undefined;
        return new Response("BFME virtual-LAN relay", { status: 200 });
    },
    websocket: bfmeRelayWebSocket as any,
});

console.log(`BFME virtual-LAN relay listening on ws://0.0.0.0:${server.port}/bfme-net`);
