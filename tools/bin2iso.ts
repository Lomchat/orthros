// Convert a MODE1/2352 raw CD .bin to a plain 2048-byte/sector .iso.
// Each 2352-byte sector = [12 sync][4 header][2048 user data][4 EDC][8 0][276 ECC].
// Usage: bun tools/bin2iso.ts <in.bin> <out.iso>
const [inPath, outPath] = [process.argv[2], process.argv[3]];
if (!inPath || !outPath) { console.error("usage: bin2iso <in.bin> <out.iso>"); process.exit(1); }
const SECTOR = 2352, DATA = 2048, OFF = 16;
const inFile = Bun.file(inPath);
const total = inFile.size;
const nSectors = Math.floor(total / SECTOR);
console.log(`in=${total} bytes, ${nSectors} sectors (MODE1/2352) -> iso=${nSectors * DATA} bytes`);
const reader = inFile.stream().getReader();
const out = Bun.file(outPath).writer();
const BATCH = 1000; // sectors per flush
let carry = new Uint8Array(0);
let written = 0, doneSectors = 0;
const outBuf = new Uint8Array(BATCH * DATA);
let outFill = 0;
const flush = () => { if (outFill) { out.write(outBuf.subarray(0, outFill)); written += outFill; outFill = 0; } };
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // concat carry + value
  let buf: Uint8Array;
  if (carry.length) { buf = new Uint8Array(carry.length + value.length); buf.set(carry); buf.set(value, carry.length); }
  else buf = value;
  let pos = 0;
  while (pos + SECTOR <= buf.length) {
    outBuf.set(buf.subarray(pos + OFF, pos + OFF + DATA), outFill);
    outFill += DATA; doneSectors++;
    if (outFill === outBuf.length) flush();
    pos += SECTOR;
  }
  carry = buf.subarray(pos); // leftover < 1 sector
}
flush();
await out.end();
console.log(`done: ${doneSectors} sectors, ${written} bytes written to ${outPath}`);
