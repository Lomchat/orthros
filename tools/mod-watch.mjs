// Watches the mods of Orthros' games: new releases of a mod (its version endpoint) and new ModDB items about it
// (sub-mods, add-ons, translations, news — RSS feeds, which ModDB serves without its Cloudflare check), from
// tools/mod-watch.json. Each run reports what it had not seen; the first run only records what exists.
// Usage: node tools/mod-watch.mjs [--state <file>] [--notify] [--dry-run]
//        node tools/mod-watch.mjs setup   (systemd service + daily timer, /etc/systemd/system/orthros-mod-watch.*)
//   --state: what was seen (default /var/lib/orthros2/mod-watch/state.json)
//   --notify: also sent on WhatsApp through the Lomchat bot (POST /api/send) when the env file
//             /var/lib/private/orthros2/mod-watch/whatsapp.env gives WHATSAPP_SEND_URL, WHATSAPP_SEND_KEY, WHATSAPP_CHAT_ID
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const UA = 'orthros-mod-watch/1.0';
const ENV_FILE = '/var/lib/private/orthros2/mod-watch/whatsapp.env';

if (args[0] === 'setup') {
  const node = process.execPath, script = fileURLToPath(import.meta.url);
  fs.writeFileSync('/etc/systemd/system/orthros-mod-watch.service', `# Written by ${script} setup
[Unit]
Description=Orthros: new releases and sub-mods of its games' mods (tools/mod-watch.json)
After=network-online.target

[Service]
Type=oneshot
ExecStart=${node} ${script} --notify
Nice=10
`);
  fs.writeFileSync('/etc/systemd/system/orthros-mod-watch.timer', `# Written by ${script} setup
[Unit]
Description=Orthros mod watch, daily

[Timer]
OnCalendar=*-*-* 10:15:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
`);
  console.log('written: /etc/systemd/system/orthros-mod-watch.{service,timer} — systemctl daemon-reload && systemctl enable --now orthros-mod-watch.timer');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(path.join(here, 'mod-watch.json'), 'utf8'));
const stateFile = opt('--state', '/var/lib/orthros2/mod-watch/state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { seen: {}, versions: {} };
const first = !fs.existsSync(stateFile);

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml, t) => decode((xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) ?? [])[1] ?? '');

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const report = [];
const errors = [];
for (const g of config.games) {
  const lines = [];
  if (g.version) {
    try {
      const v = JSON.parse(await get(g.version.url))[g.version.field];
      const before = state.versions[g.game];
      if (v && before && v !== before) lines.push(`⬆️ *${g.name} ${v}* est sorti (version précédente : ${before})`);
      if (v) state.versions[g.game] = v;
    } catch (e) { errors.push(e.message); }
  }
  const items = new Map();
  for (const feed of g.feeds) {
    try {
      for (const raw of (await get(feed)).match(/<item>[\s\S]*?<\/item>/g) ?? []) {
        const link = tag(raw, 'link'), title = tag(raw, 'title');
        const text = `${title} ${link} ${tag(raw, 'description')}`.toLowerCase();
        if (!link || !g.match.some((k) => text.includes(k))) continue;
        items.set(link, { title, link, date: new Date(tag(raw, 'pubDate')), star: g.highlight.some((k) => text.includes(k)) });
      }
    } catch (e) { errors.push(e.message); }
  }
  const seen = new Set(state.seen[g.game] ?? []);
  const fresh = [...items.values()].filter((i) => !seen.has(i.link)).sort((a, b) => b.date - a.date);
  for (const i of fresh) lines.push(`${i.star ? '⭐' : '•'} ${i.title} (${i.date.toLocaleDateString('fr-FR')})\n${i.link}`);
  state.seen[g.game] = [...new Set([...seen, ...items.keys()])].slice(-2000);
  if (lines.length && !first) report.push(`*${g.name}* :\n${lines.join('\n')}`);
  if (first) console.log(`${g.name}: ${items.size} items recorded (first run: nothing reported)`);
}

const text = report.length ? `🧩 *Orthros — mods*\n${report.join('\n\n')}` : '';
console.log(text || 'nothing new');
if (errors.length) console.log(`errors: ${errors.join('; ')}`);
if (!args.includes('--dry-run')) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile + '.new', JSON.stringify(state, null, 1));
  fs.renameSync(stateFile + '.new', stateFile);
}
if (text && args.includes('--notify') && !args.includes('--dry-run') && fs.existsSync(ENV_FILE)) {
  const env = Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const res = await fetch(env.WHATSAPP_SEND_URL, { method: 'POST', headers: { authorization: `Bearer ${env.WHATSAPP_SEND_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ chatId: env.WHATSAPP_CHAT_ID, text }) });
  console.log(`whatsapp: HTTP ${res.status}`);
}
