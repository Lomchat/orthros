// Winsock (ws2_32 / wsock32) over the virtual LAN (D061): IPv4 UDP and TCP sockets whose packets travel through the
// host's LAN link (host.lan: the page's WebSocket to the server's relay, src/host/lan.js), or stay inside the process
// (loopback, the own address, broadcasts also reach the process's own sockets as on Windows). Blocking and
// non-blocking sockets, select, WSAAsyncSelect (window messages), the name functions for the own host.
// Without a LAN link (tests, the CLI) sockets work inside the process only.
import { LAN } from '../host/lan-proto.js';
import { wmOf } from './user32.js';

const AF_INET = 2, SOCK_STREAM = 1, SOCK_DGRAM = 2;
const E = { WOULDBLOCK: 10035, INPROGRESS: 10036, ALREADY: 10037, NOTSOCK: 10038, MSGSIZE: 10040, INVAL: 10022, AFNOSUPPORT: 10047, ADDRINUSE: 10048, NETDOWN: 10050, CONNRESET: 10054, ISCONN: 10056, NOTCONN: 10057, CONNREFUSED: 10061, HOSTNOTFOUND: 11001, FAULT: 10014, OPNOTSUPP: 10045, SHUTDOWN: 10058, TIMEDOUT: 10060 };
const SOCKET_ERROR = 0xffffffff, INVALID_SOCKET = 0xffffffff;
const FD = { READ: 1, WRITE: 2, OOB: 4, ACCEPT: 8, CONNECT: 16, CLOSE: 32 };
const FIONBIO = 0x8004667e, FIONREAD = 0x4004667f;
const LOOPBACK = 0x0100007f, BROADCAST = 0xffffffff, LAN_BROADCAST = 0xffff4d0a; // 127.0.0.1, 255.255.255.255, 10.77.255.255 (as read from memory)
const MAX_QUEUE = 512;

/** "a.b.c.d" <-> the 32-bit value read from a sockaddr_in (bytes a, b, c, d in memory) */
export const ipNet = (s) => { const p = s.split('.').map(Number); return (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0; };
export const ipStr = (v) => `${v & 255}.${(v >>> 8) & 255}.${(v >>> 16) & 255}.${v >>> 24}`;

/**
 * @param {Record<string, [number, Function]>} WS the function table (ws2_32 and wsock32 share it)
 * @param {import('../core/vm.js').Vm} vm
 */
export function defineWinsock(WS, vm) {
  const mem = vm.mem;
  const net = () => vm.winsock ??= { sockets: new Set(), udp: new Map(), listen: new Map(), conns: new Map(), next: 49152, hostent: 0, ntoa: 0 };
  const lan = () => vm.host?.lan ?? null;
  const myIp = () => (lan()?.ip ? ipNet(lan().ip) : LOOPBACK);
  const err = (c, e) => { c.proc.wsaLastError = e; return SOCKET_ERROR; };
  const sockOf = (c, s) => { const o = c.proc.handles.getAs(s, 'socket'); if (!o) c.proc.wsaLastError = E.NOTSOCK; return o; };
  const readAddr = (p) => ({ ip: mem.read32(p + 4) >>> 0, port: (mem.read8(p + 2) << 8) | mem.read8(p + 3) });
  const writeAddr = (p, lenp, a) => {
    if (!p) return;
    if (lenp && mem.read32(lenp) < 16) return;
    mem.fill(p, 16, 0); mem.write16(p, AF_INET); mem.write8(p + 2, a.port >> 8); mem.write8(p + 3, a.port & 255); mem.write32(p + 4, a.ip >>> 0);
    if (lenp) mem.write32(lenp, 16);
  };
  const isLocal = (ip) => ip === LOOPBACK || ip === myIp() || (ip & 0xff) === 127;
  const ephemeral = (map) => { const n = net(); for (let i = 0; i < 16384; i++) { const p = n.next; n.next = n.next >= 65535 ? 49152 : n.next + 1; if (!map.has(p)) return p; } return 0; };
  const connKey = (lip, lport, rip, rport) => `${lip}:${lport}>${rip}:${rport}`;

  /** a thread waits for `cond` (a blocking socket call), or `ms` (Infinity: no limit); true when it holds */
  const waitFor = (c, cond, ms, reason) => {
    if (c.thread.wakeResult === undefined && cond()) return true;
    return vm.sched.block(c.thread, cond, ms === Infinity ? 0xffffffff : ms, reason);
  };
  /** WSAAsyncSelect: the window message for event `ev` of socket `s` (once per event until the call re-enables it) */
  const notify = (s, ev, error = 0) => {
    if (!s.async || !(s.async.events & ev)) return;
    if (ev === FD.READ || ev === FD.ACCEPT) { if (s.async.sent & ev) return; s.async.sent |= ev; }
    const wm = wmOf(vm), w = wm.windows.get(s.async.hwnd);
    if (w) wm.post(w, s.async.msg, s.handle, ((error & 0xffff) << 16) | ev);
    vm.sched.signal();
  };
  const readable = (s) => (T(s) === SOCK_DGRAM ? s.queue.length > 0 : s.listening ? s.accepts.length > 0 : s.rx.length > 0 || s.peerClosed || s.error !== 0);
  const writable = (s) => (T(s) === SOCK_DGRAM ? true : s.state === 'connected');

  // ---- delivery (from the LAN link, or from a socket of this process)
  const deliverUdp = (src, dst, data) => {
    const n = net(), set = n.udp.get(dst.port); if (!set) return;
    const bcast = dst.ip === BROADCAST || dst.ip === LAN_BROADCAST;
    for (const s of set) {
      if (s.bound.ip && !bcast && s.bound.ip !== dst.ip && !(isLocal(dst.ip) && isLocal(s.bound.ip))) continue;
      if (s.peer && (s.peer.ip !== src.ip || s.peer.port !== src.port)) continue; // (a connected datagram socket: its peer only)
      if (s.queue.length < MAX_QUEUE) s.queue.push({ ip: src.ip, port: src.port, data });
      notify(s, FD.READ);
    }
  };
  // (`type` is the handle table's tag; the socket type is `sockType`)
  const newSocket = (type) => {
    const s = { type: 'socket', sockType: type, handle: 0, nonblocking: false, bound: null, queue: [], rx: new Uint8Array(0), accepts: [], listening: false, state: 'idle', peer: null, local: null, peerClosed: false, shutSend: false, error: 0, opts: new Map(), async: null, reuse: false };
    s.handle = vm.proc.handles.create(s);
    net().sockets.add(s);
    return s;
  };
  const T = (s) => s.sockType;
  const tcpFrame = (type, local, remote, payload = null) => {
    const l = lan();
    if (isLocal(remote.ip) || !l) { deliverTcp(type, local, remote, payload); return; } // (inside the process: at once)
    l.send(type, local, remote, payload);
  };
  /** a TCP frame from `src` to `dst` (the other end's local address is `src`) */
  const deliverTcp = (type, src, dst, payload) => {
    const n = net();
    if (type === LAN.SYN) {
      const ls = n.listen.get(dst.port);
      if (!ls || (ls.bound.ip && ls.bound.ip !== dst.ip && !isLocal(dst.ip))) { tcpFrame(LAN.RST, dst, src); return; }
      const s = newSocket(SOCK_STREAM);
      s.state = 'connected'; s.local = { ...dst }; s.peer = { ...src }; s.bound = { ...dst };
      n.conns.set(connKey(dst.ip, dst.port, src.ip, src.port), s);
      ls.accepts.push(s); tcpFrame(LAN.ACCEPT, dst, src); notify(ls, FD.ACCEPT); vm.sched.signal();
      return;
    }
    const s = n.conns.get(connKey(dst.ip, dst.port, src.ip, src.port)); if (!s) { if (type === LAN.DATA) tcpFrame(LAN.RST, dst, src); return; }
    if (type === LAN.ACCEPT) { if (s.state === 'connecting') { s.state = 'connected'; notify(s, FD.CONNECT); notify(s, FD.WRITE); } }
    else if (type === LAN.RST) { const was = s.state; s.state = 'closed'; s.error = was === 'connecting' ? E.CONNREFUSED : E.CONNRESET; s.peerClosed = true; notify(s, was === 'connecting' ? FD.CONNECT : FD.CLOSE, s.error); }
    else if (type === LAN.DATA) { const a = new Uint8Array(s.rx.length + payload.length); a.set(s.rx); a.set(payload, s.rx.length); s.rx = a; notify(s, FD.READ); }
    else if (type === LAN.FIN) { s.peerClosed = true; notify(s, FD.CLOSE); }
    vm.sched.signal();
  };
  /** frames arriving from the LAN link (called by the host between guest time slices) */
  vm.lanDeliver = (type, src, dst, payload) => { if (type === LAN.UDP) deliverUdp(src, dst, payload); else deliverTcp(type, src, dst, payload); vm.sched.signal(); };

  const bindTo = (c, s, ip, port) => {
    const n = net();
    if (T(s) === SOCK_DGRAM) {
      if (!port) port = ephemeral(n.udp);
      const set = n.udp.get(port) ?? new Set();
      if (set.size && !s.reuse && [...set].every((o) => !o.reuse)) return err(c, E.ADDRINUSE);
      set.add(s); n.udp.set(port, set);
    } else if (!port) port = ephemeral(n.listen);
    s.bound = { ip, port };
    return 0;
  };
  const unbind = (s) => {
    const n = net();
    if (s.bound && T(s) === SOCK_DGRAM) { const set = n.udp.get(s.bound.port); set?.delete(s); if (set && !set.size) n.udp.delete(s.bound.port); }
    if (s.listening && n.listen.get(s.bound?.port) === s) n.listen.delete(s.bound.port);
    if (s.local && s.peer) n.conns.delete(connKey(s.local.ip, s.local.port, s.peer.ip, s.peer.port));
  };

  // ---- the API
  WS.socket = [3, (c) => {
    const af = c.arg(0), type = c.arg(1);
    if (af !== AF_INET) return err(c, E.AFNOSUPPORT);
    if (type !== SOCK_STREAM && type !== SOCK_DGRAM) return err(c, E.INVAL);
    return newSocket(type).handle;
  }];
  WS.WSASocketA = [6, (c) => WS.socket[1](c)]; WS.WSASocketW = WS.WSASocketA;
  WS.closesocket = [1, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    if (T(s) === SOCK_STREAM && s.state === 'connected' && !s.peerClosed) tcpFrame(LAN.FIN, s.local, s.peer);
    for (const a of s.accepts) { tcpFrame(LAN.RST, a.local, a.peer); unbind(a); }
    unbind(s); net().sockets.delete(s); s.state = 'closed';
    c.proc.handles.close(c.arg(0));
    return 0;
  }];
  WS.bind = [3, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    if (s.bound) return err(c, E.INVAL);
    const a = readAddr(c.arg(1));
    return bindTo(c, s, a.ip, a.port);
  }];
  WS.listen = [2, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    if (T(s) !== SOCK_STREAM) return err(c, E.OPNOTSUPP);
    if (!s.bound) bindTo(c, s, 0, 0);
    const n = net(); if (n.listen.has(s.bound.port) && n.listen.get(s.bound.port) !== s) return err(c, E.ADDRINUSE);
    n.listen.set(s.bound.port, s); s.listening = true;
    return 0;
  }];
  WS.accept = [3, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return INVALID_SOCKET;
    if (!s.listening) return err(c, E.INVAL);
    if (!s.accepts.length && s.nonblocking) return err(c, E.WOULDBLOCK);
    if (!waitFor(c, () => s.accepts.length > 0, Infinity, 'accept')) return err(c, E.TIMEDOUT);
    const a = s.accepts.shift(); if (s.async) s.async.sent &= ~FD.ACCEPT;
    writeAddr(c.arg(1), c.arg(2), a.peer);
    if (s.accepts.length) notify(s, FD.ACCEPT);
    return a.handle;
  }];
  WS.connect = [3, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    const a = readAddr(c.arg(1));
    if (T(s) === SOCK_DGRAM) { if (!s.bound) bindTo(c, s, 0, 0); s.peer = a; return 0; } // (a default peer)
    if (c.thread.wakeResult === undefined) { // (a call re-executed after a parked wait goes straight to its outcome)
    if (s.state === 'connected') return err(c, E.ISCONN);
    if (s.state === 'idle') {
      if (!s.bound) bindTo(c, s, 0, 0);
      s.local = { ip: isLocal(a.ip) ? (a.ip === myIp() ? myIp() : LOOPBACK) : myIp(), port: s.bound.port }; s.peer = a;
      s.state = 'connecting'; s.error = 0;
      net().conns.set(connKey(s.local.ip, s.local.port, a.ip, a.port), s);
      tcpFrame(LAN.SYN, s.local, a);
      if (s.nonblocking) return err(c, E.WOULDBLOCK);
    } else if (s.nonblocking) return err(c, s.state === 'connecting' ? E.ALREADY : E.INVAL);
    }
    if (!waitFor(c, () => s.state !== 'connecting', 20000, 'connect')) return err(c, E.TIMEDOUT);
    return s.state === 'connected' ? 0 : err(c, s.error || E.CONNREFUSED);
  }];
  /** data of the guest buffer (a copy: the frame outlives the call) */
  const bytes = (p, n) => mem.bytes(p, n).slice();
  const sendUdp = (c, s, to, data) => {
    if (!s.bound) bindTo(c, s, 0, 0);
    const bcast = to.ip === BROADCAST || to.ip === LAN_BROADCAST;
    const src = { ip: isLocal(to.ip) && !bcast ? (to.ip === myIp() ? myIp() : LOOPBACK) : myIp(), port: s.bound.port };
    if (isLocal(to.ip) || bcast) deliverUdp(src, to, data); // (the own sockets hear their broadcasts too, as on Windows)
    if (!isLocal(to.ip)) lan()?.send(LAN.UDP, src, to, data);
    return data.length;
  };
  WS.sendto = [6, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    const len = c.arg(2);
    if (T(s) === SOCK_STREAM || !c.arg(4)) return WS.send[1](c);
    if (len > 65507) return err(c, E.MSGSIZE);
    return sendUdp(c, s, readAddr(c.arg(4)), bytes(c.arg(1), len));
  }];
  WS.send = [4, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    const len = c.arg(2);
    if (T(s) === SOCK_DGRAM) { if (!s.peer) return err(c, E.NOTCONN); return sendUdp(c, s, s.peer, bytes(c.arg(1), len)); }
    if (s.state !== 'connected') return err(c, s.error || E.NOTCONN);
    if (s.shutSend) return err(c, E.SHUTDOWN);
    for (let o = 0; o < len; o += 60000) tcpFrame(LAN.DATA, s.local, s.peer, bytes(c.arg(1) + o, Math.min(60000, len - o)));
    return len;
  }];
  const recvData = (c, s, buf, len, from, fromlen, peek) => {
    if (T(s) === SOCK_DGRAM) {
      if (!s.queue.length && s.nonblocking) return err(c, E.WOULDBLOCK);
      if (!waitFor(c, () => s.queue.length > 0, s.opts.get(0x1006) || Infinity, 'recvfrom')) return err(c, E.TIMEDOUT);
      const d = peek ? s.queue[0] : s.queue.shift(); if (s.async) { s.async.sent &= ~FD.READ; if (s.queue.length) notify(s, FD.READ); }
      const n = Math.min(len, d.data.length); mem.writeBytes(buf, d.data.subarray(0, n));
      writeAddr(from, fromlen, d);
      return n < d.data.length ? err(c, E.MSGSIZE) : n;
    }
    if (s.state !== 'connected' && !s.rx.length) return err(c, s.error || E.NOTCONN);
    if (!s.rx.length && !s.peerClosed && s.nonblocking) return err(c, E.WOULDBLOCK);
    if (!waitFor(c, () => s.rx.length > 0 || s.peerClosed, s.opts.get(0x1006) || Infinity, 'recv')) return err(c, E.TIMEDOUT);
    if (!s.rx.length) return s.error ? err(c, s.error) : 0; // (closed by the peer)
    const n = Math.min(len, s.rx.length); mem.writeBytes(buf, s.rx.subarray(0, n));
    if (!peek) s.rx = s.rx.slice(n);
    if (s.async) { s.async.sent &= ~FD.READ; if (s.rx.length) notify(s, FD.READ); }
    writeAddr(from, fromlen, s.peer);
    return n;
  };
  WS.recv = [4, (c) => { const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR; return recvData(c, s, c.arg(1), c.arg(2), 0, 0, (c.arg(3) & 2) !== 0); }];
  WS.recvfrom = [6, (c) => { const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR; return recvData(c, s, c.arg(1), c.arg(2), c.arg(4), c.arg(5), (c.arg(3) & 2) !== 0); }];
  WS.shutdown = [2, (c) => { const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR; const how = c.arg(1); if ((how === 1 || how === 2) && T(s) === SOCK_STREAM && s.state === 'connected' && !s.shutSend) { s.shutSend = true; tcpFrame(LAN.FIN, s.local, s.peer); } return 0; }];
  WS.ioctlsocket = [3, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    const cmd = c.arg(1) >>> 0, p = c.arg(2);
    if (cmd === FIONBIO) { s.nonblocking = mem.read32(p) !== 0; return 0; }
    if (cmd === FIONREAD) { mem.write32(p, T(s) === SOCK_DGRAM ? (s.queue[0]?.data.length ?? 0) : s.rx.length); return 0; }
    return err(c, E.INVAL);
  }];
  WS.setsockopt = [5, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    const opt = c.arg(2), v = c.arg(4) >= 4 ? mem.read32(c.arg(3)) : mem.read8(c.arg(3));
    s.opts.set(opt, v); if (opt === 4) s.reuse = v !== 0; // (SO_REUSEADDR)
    return 0;
  }];
  WS.getsockopt = [5, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    const opt = c.arg(2), p = c.arg(3), lp = c.arg(4);
    const v = opt === 0x1007 ? s.error : opt === 0x1008 ? T(s) : opt === 0x1001 || opt === 0x1002 ? 65536 : s.opts.get(opt) ?? 0; // (SO_ERROR, SO_TYPE, SO_SNDBUF/RCVBUF)
    if (opt === 0x1007) s.error = 0;
    mem.write32(p, v); if (lp) mem.write32(lp, 4);
    return 0;
  }];
  WS.getsockname = [3, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    if (!s.bound) return err(c, E.INVAL);
    writeAddr(c.arg(1), c.arg(2), s.local ?? s.bound);
    return 0;
  }];
  WS.getpeername = [3, (c) => { const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR; if (!s.peer || (T(s) === SOCK_STREAM && s.state !== 'connected')) return err(c, E.NOTCONN); writeAddr(c.arg(1), c.arg(2), s.peer); return 0; }];

  // select(nfds, read, write, except, timeout): the ready sockets left in the sets
  const fdList = (p) => { if (!p) return []; const n = Math.min(64, mem.read32(p)); const a = []; for (let i = 0; i < n; i++) a.push(mem.read32(p + 4 + 4 * i)); return a; };
  const fdWrite = (p, list) => { if (!p) return; mem.write32(p, list.length); list.forEach((v, i) => mem.write32(p + 4 + 4 * i, v)); };
  WS.select = [5, (c) => {
    const rl = fdList(c.arg(1)), wl = fdList(c.arg(2)), el = fdList(c.arg(3)), tp = c.arg(4);
    const get = (h2) => c.proc.handles.getAs(h2, 'socket');
    for (const x of [...rl, ...wl, ...el]) if (!get(x)) return err(c, E.NOTSOCK);
    const ready = () => {
      const r = rl.filter((x) => readable(get(x))), w = wl.filter((x) => writable(get(x))), e = el.filter((x) => { const s = get(x); return s.state === 'closed' && s.error === E.CONNREFUSED; });
      return { r, w, e, n: r.length + w.length + e.length };
    };
    const ms = tp ? mem.read32(tp) * 1000 + Math.floor(mem.read32(tp + 4) / 1000) : Infinity;
    let res = ready();
    if (c.thread.wakeResult !== undefined || (!res.n && ms > 0)) { waitFor(c, () => ready().n > 0, ms, 'select'); res = ready(); }
    fdWrite(c.arg(1), res.r); fdWrite(c.arg(2), res.w); fdWrite(c.arg(3), res.e);
    return res.n;
  }];
  WS.__WSAFDIsSet = [2, (c) => (fdList(c.arg(1)).includes(c.arg(0)) ? 1 : 0)];
  WS.WSAAsyncSelect = [4, (c) => {
    const s = sockOf(c, c.arg(0)); if (!s) return SOCKET_ERROR;
    s.nonblocking = true;
    s.async = c.arg(3) ? { hwnd: c.arg(1), msg: c.arg(2), events: c.arg(3), sent: 0 } : null;
    if (s.async) { if (writable(s)) notify(s, FD.WRITE); if (readable(s)) notify(s, s.listening ? FD.ACCEPT : FD.READ); }
    return 0;
  }];

  // ---- names: the own host has the LAN address
  // (short: games take the host name as the default player name, in fields of ~10 characters)
  const hostName = () => { const ip = lan()?.ip; if (!ip) return 'Orthros'; const [, , a, b] = ip.split('.').map(Number); return `Guest${a * 256 + b - 1}`; };
  WS.gethostname = [2, (c) => { const n = hostName(); if (c.arg(1) <= n.length) return err(c, E.FAULT); mem.writeCString(c.arg(0), n, c.arg(1)); return 0; }];
  /** one hostent per process, rewritten by each call (as Windows' per-thread buffer) */
  const hostent = (c, name, ip) => {
    const n = net();
    if (!n.hostent) n.hostent = c.proc.processHeap.alloc(512);
    const p = n.hostent;
    mem.write32(p + 16, 0); // aliases: []
    mem.write32(p + 20, ip >>> 0); // the address
    mem.write32(p + 24, p + 20); mem.write32(p + 28, 0); // addr_list: [&address]
    mem.writeCString(p + 64, name.slice(0, 255), 256);
    mem.write32(p, p + 64); mem.write32(p + 4, p + 16); mem.write16(p + 8, AF_INET); mem.write16(p + 10, 4); mem.write32(p + 12, p + 24);
    return p;
  };
  WS.gethostbyname = [1, (c) => {
    const name = c.arg(0) ? c.str(0) : hostName(), lower = name.toLowerCase();
    if (!name || lower === hostName().toLowerCase()) return hostent(c, hostName(), myIp());
    if (lower === 'localhost') return hostent(c, 'localhost', LOOPBACK);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return hostent(c, name, ipNet(name));
    c.proc.wsaLastError = E.HOSTNOTFOUND; return 0;
  }];
  WS.gethostbyaddr = [3, (c) => { const ip = mem.read32(c.arg(0)) >>> 0; if (ip === myIp()) return hostent(c, hostName(), ip); if (ip === LOOPBACK) return hostent(c, 'localhost', ip); c.proc.wsaLastError = E.HOSTNOTFOUND; return 0; }];
  WS.inet_ntoa = [1, (c) => { const n = net(); if (!n.ntoa) n.ntoa = c.proc.processHeap.alloc(32); mem.writeCString(n.ntoa, ipStr(c.arg(0) >>> 0), 32); return n.ntoa; }];
}
