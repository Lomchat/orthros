// OpenMW browser ports. Third-party code stays in data/engines; HTTP and WebSocket traffic
// stays on the Orthros origin, beneath the selected installation's URL.
import http from 'node:http';
import fs from 'node:fs';
import { engineFile, clientAddress } from './goldsrc.js';
import { resolveGameFile } from './game-files.js';

/** The multiplayer gateways' state (worlds, accounts, operator credential), one folder per manifest: beside the other
 * services' state, never under build/ (make clean). A scratch gateway passes its own --state-dir. */
export const OPENMW_STATE_DIR = '/var/lib/orthros-openmw';
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const MOD_ID = /^[a-z0-9][a-z0-9-]{0,54}$/;
const safePath = (s) => typeof s === 'string' && s.length > 0 && !s.includes('\\') && s.split('/').every((p) => p && p !== '.' && p !== '..');
// OpenMW's settings file names (settings-default.cfg: sections and keys of letters, digits and spaces) and the values a
// version may give them (booleans, numbers, words, lists, colours, paths): never a line, a section or a comment of their
// own, nor markup in the page script that carries them (withSettingsDefaults).
const SETTING_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ]{0,62}[A-Za-z0-9])?$/;
const SETTING_TEXT = /^(?:[A-Za-z0-9.,_/-](?:[A-Za-z0-9 .,_/-]{0,198}[A-Za-z0-9.,_/-])?)?$/;
const settingText = (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : typeof v === 'string' ? v : null;
const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const settingsValid = (s) => plainObject(s) && Object.keys(s).length <= 64 && Object.entries(s).every(([section, kv]) => SETTING_NAME.test(section)
  && plainObject(kv) && Object.keys(kv).length <= 256 && Object.entries(kv).every(([k, v]) => SETTING_NAME.test(k) && SETTING_TEXT.test(settingText(v) ?? '\n')));
export function openmwProblem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !ID.test(o.engine ?? '')) return 'openmw.engine doit nommer une release';
  if (o.example !== undefined && typeof o.example !== 'boolean') return 'openmw.example doit être un booléen';
  if (o.startCell !== undefined && (typeof o.startCell !== 'string' || !o.startCell.length || o.startCell.length > 128 || /[\r\n\0]/.test(o.startCell))) return 'openmw.startCell invalide';
  if (!Array.isArray(o.files) || !o.files.every(safePath) || (!o.example && !o.files.length)) return 'openmw.files doit lister les fichiers nécessaires';
  if (o.example && (o.files.length || o.multiplayer)) return 'openmw.example est le monde de démonstration solo du moteur';
  if (o.mods !== undefined && (!Array.isArray(o.mods) || !o.mods.every((m) => m && MOD_ID.test(m.id ?? '') && typeof m.name === 'string' && typeof m.installed === 'boolean') || new Set(o.mods.map((m) => m.id)).size !== o.mods.length)) return 'openmw.mods doit lister les mods et leur état, avec des ids distincts';
  if ((o.mods ?? []).some((m) => m.parts !== undefined && (!Array.isArray(m.parts) || !m.parts.every((p, i) => p && p.dir === `mods/${m.id}-${i}` && safePath(p.sentinel) && Array.isArray(p.plugins) && p.plugins.every(safePath) && Array.isArray(p.archives) && p.archives.every(safePath))))) return 'openmw.mods.parts invalide';
  if (o.languageVersions !== undefined && (!o.languageVersions || Array.isArray(o.languageVersions) || typeof o.languageVersions !== 'object' || !Object.entries(o.languageVersions).every(([code, id]) => /^[a-z]{2}$/.test(code) && typeof id === 'string' && ID.test(id)))) return 'openmw.languageVersions invalide';
  if (o.settings !== undefined && !settingsValid(o.settings)) return 'openmw.settings doit être { section: { réglage: valeur } } (noms et valeurs des réglages d\'OpenMW : lettres, chiffres, espaces ; valeur booléenne, nombre ou texte simple)';
  if (o.multiplayer !== undefined) {
    const mp = o.multiplayer;
    if (!mp || !Number.isInteger(mp.port) || mp.port < 1024 || mp.port > 65535) return 'openmw.multiplayer.port invalide';
    if (mp.maxPlayers !== undefined && (!Number.isInteger(mp.maxPlayers) || mp.maxPlayers < 2 || mp.maxPlayers > 32)) return 'openmw.multiplayer.maxPlayers invalide';
  }
  return null;
}

/** The version's engine release and game files are here (`memo`: resolveGameFile's, the folders' listings kept). */
export function openmwInstalled(man, enginesDir, memo = null) {
  const engine = man.openmw?.engine;
  try {
    const release = JSON.parse(fs.readFileSync(engineFile(enginesDir, engine, 'release.json'), 'utf8'));
    return release.runtime === 'openmw' && Array.isArray(release.files) && release.files.length > 0
      && ['index.html', 'launcher.html', ...release.files].every((f) => engineFile(enginesDir, engine, f))
      && (man.openmw.mods ?? []).every((m) => m.installed && m.parts?.length > 0)
      && (man.openmw.mods ?? []).flatMap((m) => m.parts ?? []).every((p) => resolveGameFile(man, `${p.dir}/${p.sentinel}`, memo))
      && man.openmw.files.every((f) => resolveGameFile(man, f, memo));
  } catch { return false; }
}

/**
 * The engine release's files a page downloads for the engine itself at its first launch (its build's openmw.js,
 * openmw.wasm and openmw.data),
 * release-relative: those installed.
 */
export function openmwEngineFiles(man, enginesDir) {
  try {
    const release = JSON.parse(fs.readFileSync(engineFile(enginesDir, man.openmw.engine, 'release.json'), 'utf8'));
    // (the engine's own: its script, WebAssembly and package — not the release's streamfs.js, which Orthros' replaces)
    return (release.files ?? []).filter((f) => /^e\/[^/]+\/openmw\.(js|wasm|data)$/.test(f) && engineFile(enginesDir, man.openmw.engine, f));
  } catch { return []; }
}

/**
 * A multiplayer gateway's two data lists built as it starts, not for its first player (tools/openmw/server.mjs; docs/openmw.md
 * "The gateway's lists"): the gateway walks its game tree for mwdata-manifest.json (7392 files) and each mod for
 * mwdata-mods.json on the first request after each start, kept in its memory until those folders change — 1.5-2.8 s
 * each, paid by the first player after every restart (a deploy restarts them). Polls the manifest every `every` ms until
 * it answers (200, or a final 404: the gateway does not serve the data — its deliveryModel —, nothing to build), the
 * gateway not up yet (refused, 5xx) waited for; then the mods' list (404: no mods). Gives up after `limit` ms or once
 * `alive()` is false (the gateway exited). Resolves { manifest: { status, ms }, mods: { status, ms } } (null: not reached).
 * @param {{ port: number, alive?: () => boolean, log?: (line: string) => void, every?: number, limit?: number,
 *   fetch?: typeof fetch, host?: string }} o
 */
export async function warmGatewayLists({ port, alive = () => true, log = () => {}, every = 500, limit = 120000, fetch: get = globalThis.fetch, host = '127.0.0.1' }) {
  const t0 = Date.now(), url = (p) => `http://${host}:${port}/${p}`;
  const ask = async (p) => {
    const t = Date.now();
    try { const r = await get(url(p), { signal: AbortSignal.timeout(Math.max(1000, limit - (t - t0))) }); await r.arrayBuffer().catch(() => {}); return { status: r.status, ms: Date.now() - t }; }
    catch { return null; }
  };
  const out = { manifest: null, mods: null };
  while (alive() && Date.now() - t0 < limit) {
    const a = await ask('mwdata-manifest.json');
    if (a && (a.status === 200 || a.status === 404)) { out.manifest = a; break; }
    await new Promise((r) => setTimeout(r, every));
  }
  if (!out.manifest) { log(`openmw.lists_warm gave up after ${Date.now() - t0} ms (${alive() ? 'no answer' : 'gateway exited'})`); return out; }
  if (alive()) out.mods = await ask('mwdata-mods.json');
  log(`openmw.lists_warm manifest ${out.manifest.status} in ${out.manifest.ms} ms, mods ${out.mods?.status ?? 'none'} in ${out.mods?.ms ?? '-'} ms (${Date.now() - t0} ms after the start)`);
  return out;
}

const UPSTREAM_IMAGE = /^ghcr\.io\/virtastic\/openmw-web-server@sha256:[a-f0-9]{64}$/;
/**
 * The native multiplayer gateway's Docker image for an engine release (tools/openmw/server.mjs): its upstream release's
 * pinned image (`serverImage`; a release built here from the pinned source, build.sh, changes the browser engine only),
 * or, when tools/openmw/lock.json derives an image from that one (`serverBuild`: its Node.js replaced,
 * build-server-image.sh), the derived image's pinned ID — never the base then. `releaseOf(id)`: a release's release.json.
 * @returns {{ image: string, base: string, tag: string|null }}
 */
export function openmwGatewayImage(release, releaseOf, lock) {
  const upstreamId = release.upstream?.id ?? release.id;
  const base = release.serverImage ?? (release.upstream?.id ? releaseOf(release.upstream.id).serverImage : null);
  if (!UPSTREAM_IMAGE.test(base ?? '')) throw new Error('No pinned server image in this engine release');
  const b = lock?.serverBuild;
  if (!b || lock.id !== upstreamId || b.base !== base) return { image: base, base, tag: null };
  if (!/^sha256:[a-f0-9]{64}$/.test(b.image ?? '')) throw new Error('lock.json serverBuild.image is not pinned');
  return { image: b.image, base, tag: b.tag ?? null };
}

export const openmwBase = (id) => `/ports/openmw/${encodeURIComponent(id)}/app`;
export const openmwModes = (o) => ['solo', ...(o.multiplayer ? ['multiplayer'] : [])];

// Only the upstream browser pages are adapted. Guest filesystem paths (/mwdata, /userdata)
// and the generated Emscripten JS must retain their original meaning.
/**
 * An engine page with the Orthros page's meter (src/ports/openmw/frame-meter.js: its frame rate, the mouse and the
 * engine's loading status), the indicator of the game data it waits for (src/host/web/data-meter.js, every game's) and the
 * engine interface's texts in the Orthros page's language (src/ports/openmw/ui-l10n.js).
 */
export const withFrameMeter = (html) => html
  .replace('<head>', '<head><script src="/src/ports/openmw/frame-meter.js"></script><script src="/src/host/web/data-meter.js"></script><script src="/src/ports/openmw/ui-l10n.js"></script>')
  .replace('setStatus: (t)=>{ if(t){', 'setStatus: (t)=>{ window.orthrosStatus?.(t); if(t){');

/**
 * The engine build's files from the release's own URL (/engines/<release>/e/<hash>/, immutable) instead of beneath
 * each installation's: one browser copy for every version of a game, never downloaded again.
 */
/**
 * The engine page's file streaming: Orthros' own (src/ports/openmw/streamfs.js) in place of the release's, unless the
 * page is asked for the upstream one (?sfs=upstream: a comparison, a way around a fault).
 */
export const withStreaming = (html, upstream = false) => upstream ? html
  : html.replace(/<script src="e\/[0-9a-f]+\/streamfs\.js"><\/script>/, '<script src="/src/ports/openmw/streamfs.js"></script>');

/**
 * The engine page's view distance and Orthros' script in the engine (src/ports/openmw/view-grow.js, view.lua): the
 * module loaded before the engine (its load waits for it), the boot viewing distance its choice (short on a link that
 * is not fast, then raised as the game data allows; distant terrain and object paging as the tier says), and Orthros'
 * content (orthros.omwscripts) in every single-player openmw.cfg the page writes, whatever the link (saves list their
 * content files). Multiplayer and the baked example world (?nomw) keep the tier's distance and their own content list:
 * a world refuses a client whose content its own list lacks (BAD_CONTENT). Each hook falls back to the page's own when
 * the module did not load.
 */
export const withProgressiveView = (html) => html
  .replace('<head>', `<head><script>window.orthrosViewReady = import('/src/ports/openmw/view-grow.js').then(function (m) { return m.install(window); }).catch(function (e) { console.warn('[orthros view]', e); });</script>`)
  .replace("'viewing distance = ' + ((/[?&]vd=(\\d+)/.exec(location.search)||[])[1] || TIER.vd)",
    "'viewing distance = ' + ((/[?&]vd=(\\d+)/.exec(location.search)||[])[1] || (window.orthrosViewBoot ? window.orthrosViewBoot(TIER.vd) : TIER.vd))")
  .replace(/FS\.writeFile\('\/openmw\.cfg',\s*cfg\.join\('\\n'\)\)/g, "FS.writeFile('/openmw.cfg', (window.orthrosContent ? window.orthrosContent(FS, cfg) : cfg).join('\\n'))")
  .replace('document.body.appendChild(s);', 'Promise.all([window.orthrosViewReady, window.orthrosTierReady, window.orthrosInputReady]).then(function () { document.body.appendChild(s); });');

/**
 * The engine page's quality tier from the GPU and the frames measured (src/ports/openmw/tier.js) instead of
 * navigator.deviceMemory alone: the module loaded before the engine (withProgressiveView's hold waits for it too), the
 * page's tier choice asking it (?tier= first, as before), its log line saying the GPU's kind, the water's refraction as
 * the tier says (tierSettings: 'high' only; ?norefr=1 / ?refr=1 force it). The page's own rule when the module did not
 * load.
 */
export const withQualityTier = (html) => html
  .replace('<head>', `<head><script>window.orthrosTierReady = import('/src/ports/openmw/tier.js').then(function (m) { return m.install(window); }).catch(function (e) { console.warn('[orthros tier]', e); });</script>`)
  .replace("|| (__devMem >= 8 ? 'high' : (__devMem > 0 && __devMem <= 4 ? 'low' : 'mid'));",
    "|| (window.orthrosTier ? window.orthrosTier(__devMem) : (__devMem >= 8 ? 'high' : (__devMem > 0 && __devMem <= 4 ? 'low' : 'mid')));")
  .replace("append('[tier] '+__tier+' (navigator.deviceMemory='", "append('[tier] '+__tier+(window.orthrosTierChoice ? ' (gpu: '+window.orthrosTierChoice.kind+')' : '')+' (navigator.deviceMemory='")
  .replace("'refraction = ' + (/[?&]norefr=1\\b/.test(location.search) ? 'false' : 'true')",
    "'refraction = ' + (/[?&]norefr=1\\b/.test(location.search) || (!/[?&]refr=1\\b/.test(location.search) && window.orthrosTierSettings && !window.orthrosTierSettings(__tier).refraction) ? 'false' : 'true')");

/**
 * The keyboard layout every player gets (src/ports/openmw/input-keys.js: Activate on E, Jump on Space): the module loaded
 * before the engine (withProgressiveView's hold waits for it too), and a player's saved bindings that still hold the
 * old pair swapped once their user files are in place — the account's copy and IDBFS restored, before the engine
 * reads them. Nothing when the module did not load.
 */
export const withInputKeys = (html) => html
  .replace('<head>', `<head><script>window.orthrosInputReady = import('/src/ports/openmw/input-keys.js').then(function (m) { return m.install(window); }).catch(function (e) { console.warn('[orthros keys]', e); });</script>`)
  .replace("FS.mkdirTree('/userdata/config/openmw');   // XDG user config (persistent)",
    "FS.mkdirTree('/userdata/config/openmw');   // XDG user config (persistent)\n" +
    "               if (window.orthrosInputKeys && window.orthrosInputKeys(FS) === 'swapped') append('[orthros] saved bindings: Activate on E, Jump on Space');");

/**
 * OpenMW's language list for a version (its [General] preferred locales): the version's languages (manifest `languages`,
 * its masters' language) first, then English, the fallback every l10n context ships. OpenMW's own default is `en`
 * alone, so a French game showed OpenMW's menus and every Lua mod's texts in English. ['fr'] → 'fr,en', ['en'] → 'en'.
 * Only locale codes (the manifest schema's `xx` / `xx-YY`) are kept.
 */
export function openmwLocales(man) {
  const codes = (Array.isArray(man?.languages) ? man.languages : []).filter((c) => typeof c === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(c));
  return [...new Set([...codes, 'en'])].join(',');
}

/**
 * A version's own settings defaults (manifest `openmw.settings`: { section: { key: value } }, OpenMW's settings-default.cfg
 * names — a game's rules such as [Game] best attack, or its interface such as [GUI] subtitles), their values as a
 * settings file writes them (true → 'true', 3 → '3'). {} without them, or when they are not valid (openmwProblem).
 */
export function openmwVersionSettings(man) {
  const s = man?.openmw?.settings;
  if (!settingsValid(s)) return {};
  return Object.fromEntries(Object.entries(s).map(([section, kv]) => [section, Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, settingText(v)]))]));
}

/**
 * The settings Orthros adds to the engine page's defaults for a version: { section: { key: value } } — Orthros' own for
 * every version, then the version's (openmwVersionSettings: a key of both is the version's).
 */
export function openmwSettingsDefaults(man) {
  const out = {
    General: { 'preferred locales': openmwLocales(man) },
    // dialogue topics coloured by what they hold (an answer of the speaker's own, or already read), in OpenMW's default
    // colours ([GUI] color topic specific / exhausted); the Options menu has no switch for it
    GUI: { 'color topic enable': 'true' },
  };
  for (const [section, kv] of Object.entries(openmwVersionSettings(man))) out[section] = { ...out[section], ...kv };
  return out;
}

/** Settings { section: { key: value } } as the lines of an OpenMW settings file (a section without keys: none). */
export const openmwSettingsCfg = (sections) => Object.entries(sections).filter(([, kv]) => Object.keys(kv).length)
  .map(([s, kv]) => `[${s}]\n${Object.entries(kv).map(([k, v]) => `${k} = ${v}\n`).join('')}`).join('');

/** The page writing its settings defaults (settingsCfg: [Video] … [General], [Post Processing]) to /settings.cfg. */
const SETTINGS_WRITE = "FS.writeFile('/settings.cfg', settingsCfg);";
/** A string as a script literal inside the page's HTML (no `</script>` can end it). */
const scriptLiteral = (s) => JSON.stringify(s).replace(/</g, '\\u003c');
/**
 * The engine page's settings defaults with a version's (openmwSettingsDefaults(man)) after its own. They are appended to
 * what the page writes to /settings.cfg, the first of the engine's config dirs. OpenMW reads that file as additional
 * defaults, where a section may be opened again and a later key overrides an earlier one
 * (components/settings/settings.cpp: loadSettingsFile(…, overrideExisting = true)). The player's own settings.cfg
 * (/userdata/config/openmw, the last config dir, where the Options menu writes, its Language choice among them) still
 * wins over them. A line in the page's log lists them.
 */
export function withSettingsDefaults(html, man) {
  const sections = openmwSettingsDefaults(man), cfg = openmwSettingsCfg(sections);
  const said = Object.entries(sections).flatMap(([s, kv]) => Object.entries(kv).map(([k, v]) => `[${s}] ${k} = ${v}`)).join('; ');
  return html.replace(SETTINGS_WRITE, () => `FS.writeFile('/settings.cfg', settingsCfg + ${scriptLiteral('\n' + cfg)}); append(${scriptLiteral('[orthros] settings defaults: ' + said)});`);
}

/**
 * Where the multiplayer gateway image's simulation peers read additional settings defaults: the native engine's global
 * config dir (/usr/local/etc/openmw — its defaults.bin and openmw.cfg; no settings.cfg in the image), the first of a
 * peer's two config dirs. The gateway starts each peer with `--config <world>/peer-config --replace config` and rewrites
 * that dir's settings.cfg (its pacing: framerate limit, shadows and water off…) at every world start; being the last
 * config dir, it is the peer's own settings file and its keys win. OpenMW reads settings.cfg from every config dir but
 * the last as additional defaults (components/settings/settings.cpp), over defaults.bin. tools/openmw/server.mjs mounts
 * openmwSimSettings(man) there, read-only.
 */
export const OPENMW_SIM_SETTINGS = '/usr/local/etc/openmw/settings.cfg';
/**
 * The simulation peers' settings defaults: the version's own (openmwVersionSettings — the same rules as its players':
 * combat, AI, prices…; an interface one is inert on a peer that draws nothing), not Orthros' page defaults.
 */
export const openmwSimSettings = (man) => '# Orthros: the version\'s settings defaults (manifest openmw.settings), written by tools/openmw/server.mjs at each start.\n'
  + openmwSettingsCfg(openmwVersionSettings(man));

export const withSharedEngine =(html, release) => html.replace('("e/" + __ENGINE_VER + "/")', `(${JSON.stringify(`/engines/${release}/e/`)} + __ENGINE_VER + "/")`);

/**
 * The engine page loading the engine's files by their content (engine-content.js): `urls` { basename: URL } —
 * openmw.js (its script, and the pthread workers it starts from its own address), openmw.wasm and openmw.data through
 * Module.locateFile (after withLeanPackage: the lean package keeps its own address) —, a file without one from the
 * release's build directory as before.
 */
export const withEngineUrls = (html, urls) => !urls || !Object.keys(urls).length ? html : html
  .replace(/var __ENGINE_DIR = [^\n]*;/, (m) => `${m}\n function __orthrosEngineUrl(p){ var u = ${JSON.stringify(urls)}; return Object.prototype.hasOwnProperty.call(u, p) ? u[p] : __ENGINE_DIR + p; }`)
  .replace(/(locateFile: function\(path\)\{ return [^}]*?)__ENGINE_DIR \+ path; \}/, '$1__orthrosEngineUrl(path); }')
  .replace("s.src = __ENGINE_DIR + 'openmw.js';", "s.src = __orthrosEngineUrl('openmw.js');");

/** The engine page's fetch of its gateway's file list, and the one of its mods' list (mountServerMods, after the mounts). */
const MANIFEST_FETCH = "fetch('mwdata-manifest.json')", MODS_FETCH = "var r = await fetch('mwdata-mods.json');";
/**
 * The page's two gateway lists asked together: mwdata-mods.json fetched beside mwdata-manifest.json (the page asked it
 * only after mounting the manifest's 7392 files: a round trip and the gateway's time in series before the engine's
 * start, docs/openmw.md "The gateway's lists"), its answer taken by mountServerMods. Only a page that has both (else
 * nothing would take it), not with ?nomods=1 (the page skips the list). The early request marked handled as made (a
 * no-op catch beside it): a network failure before mountServerMods awaits it — seconds later, or never (no manifest) —
 * is no unhandled rejection (the page's handler logs it as an error, ships it, opens the log with ?hud=1); its await,
 * in its own try, still turns the failure into "no mods" as before.
 */
export const withModsListEarly = (html) => !html.includes(MANIFEST_FETCH) || !html.includes(MODS_FETCH) ? html : html
  .replace(MANIFEST_FETCH, "(window.__orthrosModsList = /[?&]nomods=1\\b/.test(location.search) ? null : fetch('mwdata-mods.json'), "
    + 'window.__orthrosModsList && window.__orthrosModsList.catch(function(){}), ' + MANIFEST_FETCH + ')')
  .replace(MODS_FETCH, "var r = await (window.__orthrosModsList || fetch('mwdata-mods.json')); window.__orthrosModsList = null;");

export function openmwWebText(text, base, saveKey) {
  // Native EM_ASM in the untouched engine glue uses the upstream storage keys too.
  // HTML-only replacements would clear a different resume token than the engine reads.
  if (text.includes('async function rebootIntoWorld(wsUrl){') || text.includes('omw-mp-session')) text = text.replace('<script>', `<script>
    (function(){ ['getItem', 'setItem', 'removeItem'].forEach(function(method){
      var original = Storage.prototype[method];
      Storage.prototype[method] = function(){
        var args = Array.prototype.slice.call(arguments);
        if (typeof args[0] === 'string' && args[0].indexOf('omwmp:') === 0)
          args[0] = ${JSON.stringify(saveKey + ':mp:')} + args[0].slice(6);
        return original.apply(this, args);
      };
    }); })();
  `);
  return withModsListEarly(text).replace(/ · <a href="\/admin">server administration<\/a>/, '')
    .replace(/(["'`])\/(auth(?:\/|["'`])|worlds(?:\/|["'`])|locker(?:\/|["'`])|saves(?:\/|["'`])|w\/|ws(?=["'`])|clientlog(?=["'`])|admin(?:\/|["'`])|mwdata-(?:manifest|mods)\.json|index\.html|launcher\.html|join(?=["'`])|play(?=["'`]))/g, `$1${base}/$2`)
    .replace(/(location\.(?:href\s*=\s*|replace\(\s*))["']\/["']/g, `$1'${base}/'`)
    .replace(/(['"])omwmp:([^'"]+)\1/g, (_m, q, k) => `${q}${saveKey}:mp:${k}${q}`)
    .replace(/(['"])omw-mp-session\1/g, (_m, q) => `${q}${saveKey}:session${q}`)
    .replace(/(['"])omw-launcher\1/g, (_m, q) => `${q}${saveKey}:launcher${q}`)
    // The pieces of the served game files the engine streams are kept in its browser cache only for URLs without a
    // query (streamfs.js): the upstream's ?v=2 (a workaround for its CDN) kept none of Morrowind's own, so every
    // session read Morrowind.esm and the archives over the network again, the page frozen meanwhile.
    .replace("'mwdata/' + encodeURI(f.p) + '?v=2'", "'mwdata/' + encodeURI(f.p)")
    // IDBFS normally names the database after its guest mount point (/userdata).
    .replace("FS.mount(IDBFS, {}, '/userdata');", `var orthrosGetDB = IDBFS.getDB; IDBFS.getDB = function(name, callback) { return orthrosGetDB.call(IDBFS, name === '/userdata' ? ${JSON.stringify(saveKey)} : name, callback); }; FS.mount(IDBFS, {}, '/userdata');`)
    // JoinFriend also arrives inside the engine's WebSocket protocol, beyond the HTTP JSON
    // adaptation below. Scope its destination at the page's world-travel boundary, before
    // it is parked in the next boot fragment. Already scoped and foreign targets stay intact.
    .replace('async function rebootIntoWorld(wsUrl){', `async function rebootIntoWorld(wsUrl){
      var orthrosWorld = new URL(wsUrl, location.href);
      if (/^wss?:$/.test(orthrosWorld.protocol) && orthrosWorld.host === location.host
          && /^\\/w\\/[a-zA-Z0-9_-]+$/.test(orthrosWorld.pathname)) {
        orthrosWorld.pathname = ${JSON.stringify(base)} + orthrosWorld.pathname;
        wsUrl = orthrosWorld.href;
      }`);
}

function responseJson(body, base) {
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (['wsPath', 'joinWsPath'].includes(k) && typeof v[k] === 'string' && v[k].startsWith('/w/')) v[k] = base + v[k];
      else visit(v[k]);
    }
  };
  const value = JSON.parse(body); visit(value); return JSON.stringify(value);
}

const proxyPath = (p) => /^\/(auth|worlds|locker|saves)(\/|$)/.test(p) || p === '/clientlog'
  || /^\/mwdata\//.test(p) || /^\/mwdata-(manifest|mods)\.json$/.test(p);
const OMIT_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'content-security-policy', 'x-frame-options']);
const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
function upstreamHeaders(req) {
  const headers = { ...req.headers, 'accept-encoding': 'identity', 'x-forwarded-for': clientAddress(req) };
  for (const key of ['cf-connecting-ip', 'true-client-ip', 'x-omw-client-ip', 'forwarded', 'cookie']) delete headers[key];
  return headers;
}

/** A namespaced bridge to one manifest's localhost gateway. Never accepts a target URL from a visitor. */
export function openmwProxy({ getManifest, session, ownsToken }) {
  function target(url) {
    const m = /^\/ports\/openmw\/([^/]+)\/app(\/.*)$/.exec(url.pathname);
    if (!m) return null;
    const man = getManifest(m[1]);
    return man?.runtime === 'openmw' && man.openmw?.multiplayer ? { man, id: m[1], path: m[2], base: openmwBase(m[1]) } : null;
  }
  return {
    handle(req, res, url) {
      const t = target(url);
      if (t?.path === '/admin/api/state' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { ...isolation, 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ serverName: t.man.name, setup: { deploymentMode: 'multiplayer', deliveryModel: 'serve' } })); return true;
      }
      if (!t || !proxyPath(t.path)) return false;
      // Hosted data is public for solo. Game sessions and lockers require Orthros identity.
      if (session && /^\/(auth|worlds|locker|saves)(\/|$)/.test(t.path)) {
        const user = session(req);
        if (!user || t.path.startsWith('/auth/') && !/^\/auth\/(profile|ticket|characters|friends-playing|providers)$/.test(t.path)) {
          res.writeHead(user ? 403 : 401, { ...isolation, 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'Connexion Orthros requise depuis la page du jeu.' })); return true;
        }
        const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (bearer && ownsToken && !ownsToken(user, t.id, bearer)) {
          res.writeHead(403, { ...isolation, 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cette partie appartient à un autre compte ou doit être relancée.' })); return true;
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
          let origin; try { origin = new URL(req.headers.origin); } catch { /* refused below */ }
          if (!origin || origin.host !== req.headers.host || !['https:', 'http:'].includes(origin.protocol)) {
            res.writeHead(403, isolation); res.end('Origine refusée.'); return true;
          }
        }
      }
      const upstream = http.request({ hostname: '127.0.0.1', port: t.man.openmw.multiplayer.port,
        path: t.path + url.search, method: req.method, headers: upstreamHeaders(req) }, (reply) => {
        const headers = { ...isolation, 'cache-control': 'no-store' };
        for (const [k, v] of Object.entries(reply.headers)) if (!OMIT_HEADERS.has(k) && v !== undefined) headers[k] = v;
        if (headers.location?.startsWith('/') && !headers.location.startsWith('//')) headers.location = t.base + headers.location;
        if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map((c) => c.replace(/;\s*Path=\/([^;]*)/i, `; Path=${t.base}/$1`));
        const type = String(reply.headers['content-type'] ?? '');
        if (req.method === 'HEAD' || !/text\/html|javascript|application\/json/.test(type)) {
          res.writeHead(reply.statusCode, headers); reply.pipe(res); return;
        }
        const chunks = []; let bytes = 0;
        reply.on('data', (c) => { bytes += c.length; if (bytes > 8 * 1024 * 1024) reply.destroy(new Error('OpenMW response too large')); else chunks.push(c); });
        reply.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          try { body = /application\/json/.test(type) ? responseJson(body, t.base) : openmwWebText(body, t.base, t.man.saveKey); if (/text\/html/.test(type)) body = withFrameMeter(body); }
          catch { res.writeHead(502, isolation); res.end('Invalid OpenMW response'); return; }
          res.writeHead(reply.statusCode, headers); res.end(body);
        });
        reply.on('error', () => { if (!res.headersSent) res.writeHead(502, isolation); res.end('OpenMW gateway response failed'); });
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, isolation); res.end('OpenMW multiplayer is not running.'); });
      upstream.setTimeout(30000, () => upstream.destroy(new Error('timeout')));
      req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
      return true;
    },
    upgrade(req, socket, url, head) {
      const t = target(url);
      if (!t || !/^\/w\/[a-zA-Z0-9_-]+$/.test(t.path)) return false;
      if (session && !session(req)) { socket.destroy(); return true; }
      // Same origin is required before forwarding a player's credentials or opening a world.
      let origin; try { origin = new URL(req.headers.origin); } catch { socket.destroy(); return true; }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) { socket.destroy(); return true; }
      const up = http.request({ hostname: '127.0.0.1', port: t.man.openmw.multiplayer.port,
        path: t.path + url.search, headers: upstreamHeaders(req) });
      up.on('upgrade', (reply, peer, first) => {
        let lines = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
        for (let i = 0; i < reply.rawHeaders.length; i += 2) lines += `${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}\r\n`;
        socket.write(lines + '\r\n'); if (first.length) socket.write(first); if (head?.length) peer.write(head);
        socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
        socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
        socket.pipe(peer).pipe(socket);
      });
      up.on('response', (reply) => { reply.resume(); socket.destroy(); });
      up.on('error', () => socket.destroy()); socket.on('close', () => up.destroy()); up.end();
      return true;
    },
  };
}
