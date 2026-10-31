// JSPI cost probe: a hot call at a chosen stack depth, on the page's stack (plain export) or a JSPI stack (promising)
extern double now(void) __attribute__((import_module("env"), import_name("now")));
extern int imp(int) __attribute__((import_module("env"), import_name("imp")));
volatile int sink;
__attribute__((noinline)) int leaf(int x) { char buf[64]; buf[x & 63] = (char)x; sink += buf[(x * 7) & 63]; return x + 1; }
__attribute__((noinline)) int mid(int x) { char buf[256]; buf[x & 255] = (char)x; int r = leaf(x) + leaf(x + 1); sink += buf[(x * 3) & 255]; return r; }
__attribute__((noinline)) int down(int d, int n, int mode) {
  if (d > 0) { int r = down(d - 1, n, mode); sink += r; return r; }
  int s = 0;
  if (mode == 0) for (int i = 0; i < n; i++) s += mid(i);
  else for (int i = 0; i < n; i++) s += imp(i);
  return s;
}
__attribute__((export_name("run"))) int run(int d, int n, int mode) { return down(d, n, mode); }
__attribute__((export_name("run2"))) int run2(int d, int n, int mode) { return down(d, n, mode); }
