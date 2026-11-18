// The frozen builds' addresses (src/server/build-store.js, docs/builds.md): a page loads all its code from one immutable
// build, /b/<id>/src/... — its modules, workers and worklets name each other relative to their own address
// (import.meta.url), so the build a module was loaded from is the one everything it loads comes from, and a deploy during
// the session cannot hand it a module of another version. Without builds (a development server: --builds off, no
// --learn) the same code is served from the live tree, /src/....
//
// Read by the server and by the pages (no Node or browser API here).

/** A build's id: 16 hex digits, the start of the SHA-256 of its files' paths and contents. */
export const BUILD_ID = /^[0-9a-f]{16}$/;
/** The address of build `id`'s file `rel` ('src/...'). */
export const buildUrl = (id, rel) => `/b/${id}/${rel}`;
/** The build an address of a build's file names (a URL, a path, a Referer), or null (the live tree's /src/, anything else). */
export const buildOf = (url) => /\/b\/([0-9a-f]{16})\/src\//.exec(String(url ?? ''))?.[1] ?? null;
/** The build this module — so the page or worker that loaded it — runs, null when it runs the live tree. */
export const OWN_BUILD = buildOf(import.meta.url);
/** An /api/ address `u` naming this page's build (`build=`): the answers that depend on the code (the snapshot sources' hash, the version) are its build's. */
export const withBuild = (u) => (OWN_BUILD ? `${u}${u.includes('?') ? '&' : '?'}build=${OWN_BUILD}` : u);
