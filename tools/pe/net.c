// Test program: Winsock over Orthros' virtual LAN. Inside the process: UDP to 127.0.0.1 and to the broadcast address
// (the own sockets hear it), a non-blocking receive on an empty socket, TCP on the loopback (listen, connect, accept,
// data both ways, select, the peer's close), a refused connection. Over the LAN (when the host name resolves to a
// 10.77.x.y address): a broadcast answered by another machine, then a TCP exchange with it.
#include "win.h"
typedef unsigned int SOCKET;
typedef struct { short family; unsigned short port; unsigned long addr; char zero[8]; } SA;
typedef struct { char* name; char** aliases; short type; short len; char** addrs; } HOSTENT;
typedef struct { unsigned count; SOCKET fds[64]; } FDSET;
typedef struct { long sec, usec; } TV;
DLLIMPORT int WINAPI WSAStartup(WORD, void*); DLLIMPORT int WINAPI WSAGetLastError(void);
DLLIMPORT SOCKET WINAPI socket(int, int, int); DLLIMPORT int WINAPI closesocket(SOCKET);
DLLIMPORT int WINAPI bind(SOCKET, const SA*, int); DLLIMPORT int WINAPI listen(SOCKET, int); DLLIMPORT SOCKET WINAPI accept(SOCKET, SA*, int*);
DLLIMPORT int WINAPI connect(SOCKET, const SA*, int); DLLIMPORT int WINAPI send(SOCKET, const char*, int, int); DLLIMPORT int WINAPI recv(SOCKET, char*, int, int);
DLLIMPORT int WINAPI sendto(SOCKET, const char*, int, int, const SA*, int); DLLIMPORT int WINAPI recvfrom(SOCKET, char*, int, int, SA*, int*);
DLLIMPORT int WINAPI select(int, FDSET*, FDSET*, FDSET*, const TV*); DLLIMPORT int WINAPI ioctlsocket(SOCKET, long, unsigned long*);
DLLIMPORT int WINAPI setsockopt(SOCKET, int, int, const char*, int); DLLIMPORT int WINAPI getsockname(SOCKET, SA*, int*);
DLLIMPORT int WINAPI gethostname(char*, int); DLLIMPORT HOSTENT* WINAPI gethostbyname(const char*);
DLLIMPORT unsigned long WINAPI inet_addr(const char*); DLLIMPORT char* WINAPI inet_ntoa(unsigned long); DLLIMPORT unsigned short WINAPI htons(unsigned short);

static int slen(const char* s) { int n = 0; while (s[n]) n++; return n; }
static HANDLE out;
static void put(const char* s) { DWORD w; WriteFile(out, s, slen(s), &w, 0); }
static void putnum(int v) { char b[12]; int i = 11; b[i] = 0; unsigned u = v < 0 ? -v : v; if (!u) b[--i] = '0'; while (u) { b[--i] = '0' + u % 10; u /= 10; } if (v < 0) b[--i] = '-'; put(b + i); }
static void kv(const char* k, int v) { put(k); put("="); putnum(v); put("\n"); }
static void ks(const char* k, const char* v) { put(k); put("="); put(v); put("\n"); }
static int same(const char* a, const char* b, int n) { for (int i = 0; i < n; i++) if (a[i] != b[i]) return 0; return 1; }
static SA addr(unsigned long ip, int port) { SA a; char* p = (char*)&a; for (int i = 0; i < 16; i++) p[i] = 0; a.family = 2; a.port = htons(port); a.addr = ip; return a; }
static int readable(SOCKET s, int ms) { FDSET f; f.count = 1; f.fds[0] = s; TV t; t.sec = ms / 1000; t.usec = (ms % 1000) * 1000; return select(0, &f, 0, 0, &t); }

void __stdcall start(void) {
  out = GetStdHandle((DWORD)-11);
  char wsa[400]; kv("startup", WSAStartup(0x202, wsa));
  char host[64]; gethostname(host, 64); HOSTENT* he = gethostbyname(host);
  unsigned long me = he ? *(unsigned long*)he->addrs[0] : 0; ks("me", inet_ntoa(me));
  unsigned long lo = inet_addr("127.0.0.1");
  // ---- UDP inside the process
  SOCKET u1 = socket(2, 2, 0), u2 = socket(2, 2, 0); int one = 1;
  setsockopt(u1, 0xffff, 0x20, (char*)&one, 4); setsockopt(u2, 0xffff, 0x20, (char*)&one, 4); // SO_BROADCAST
  SA a1 = addr(0, 9000), a2 = addr(0, 9001); kv("bind1", bind(u1, &a1, 16)); kv("bind2", bind(u2, &a2, 16));
  SA dup = addr(0, 9000); SOCKET u3 = socket(2, 2, 0); kv("bind_inuse", bind(u3, &dup, 16) ? WSAGetLastError() : 0); closesocket(u3);
  SA to = addr(lo, 9000); kv("sendto", sendto(u2, "ping", 4, 0, &to, 16));
  char buf[256]; SA from; int fl = 16;
  kv("recvfrom", recvfrom(u1, buf, 256, 0, &from, &fl)); kv("from_port", htons(from.port)); kv("data_ping", same(buf, "ping", 4));
  unsigned long nb = 1; ioctlsocket(u1, 0x8004667e, &nb);
  kv("wouldblock", recvfrom(u1, buf, 256, 0, &from, &fl) < 0 ? WSAGetLastError() : 0);
  SA bc = addr(0xffffffff, 9000); sendto(u2, "bcast", 5, 0, &bc, 16);
  kv("bcast_own", recvfrom(u1, buf, 256, 0, &from, &fl));
  // ---- TCP on the loopback
  SOCKET l = socket(2, 1, 0); SA la = addr(0, 9100); bind(l, &la, 16); kv("listen", listen(l, 4));
  SOCKET c = socket(2, 1, 0); SA ca = addr(lo, 9100); kv("connect", connect(c, &ca, 16));
  kv("accept_ready", readable(l, 1000));
  SA pa; int pl = 16; SOCKET a = accept(l, &pa, &pl); kv("accepted", a != 0xffffffff);
  kv("send", send(c, "hello", 5, 0)); kv("recv", recv(a, buf, 256, 0)); kv("data_hello", same(buf, "hello", 5));
  send(a, "world!", 6, 0); kv("readable", readable(c, 1000)); kv("recv2", recv(c, buf, 3, 0)); kv("recv3", recv(c, buf + 3, 256, 0)); kv("data_world", same(buf, "world!", 6));
  closesocket(c); kv("peer_closed", recv(a, buf, 256, 0));
  SOCKET r = socket(2, 1, 0); SA ra = addr(lo, 9200); kv("refused", connect(r, &ra, 16) ? WSAGetLastError() : 0);
  // ---- over the LAN: another machine answers a broadcast, then a TCP exchange with it
  if ((me & 0xffff) == 0x4d0a) {
    SOCKET b = socket(2, 2, 0); setsockopt(b, 0xffff, 0x20, (char*)&one, 4); SA ba = addr(0, 8087); bind(b, &ba, 16);
    SA lan = addr(0xffffffff, 8086); sendto(b, "hi", 2, 0, &lan, 16);
    kv("lan_reply", readable(b, 3000) > 0 ? recvfrom(b, buf, 256, 0, &from, &fl) : -1);
    ks("lan_from", inet_ntoa(from.addr)); kv("lan_data", same(buf, "hello", 5));
    SOCKET t = socket(2, 1, 0); SA ta = addr(from.addr, 8100); kv("lan_connect", connect(t, &ta, 16));
    send(t, "data", 4, 0); kv("lan_recv", readable(t, 3000) > 0 ? recv(t, buf, 256, 0) : -1); kv("lan_ok", same(buf, "ok", 2));
    closesocket(t);
  }
  ExitProcess(0);
}
