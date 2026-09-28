// Frame types of the virtual LAN (src/host/lan.js: the relay; src/win32/winsock.js: the emulated sockets; the page's
// worker: the link). Frame: type u8, source address (4 bytes a.b.c.d), source port (u16 big-endian), destination
// address, destination port, then the payload.
export const LAN = Object.freeze({ UDP: 1, SYN: 2, ACCEPT: 3, RST: 4, DATA: 5, FIN: 6, HEADER: 13 });
