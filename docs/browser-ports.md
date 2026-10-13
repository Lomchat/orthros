# Browser ports on the existing Orthros home

The existing home screen also displays optional browser-native installations. It fetches their
metadata from `/ports/api/manifests`; an unavailable port service leaves Windows games usable.
Original Windows manifest IDs, launch URLs, account routes, game files and saved profiles remain unchanged.

The home accepts local `/ports/<adapter>/<game>/<version>/` launch paths only. Those pages own their
engines, asset loading, input, audio and storage. They do not enter the Win32 worker or import the CPU,
PE loader, graphics or API implementations. The Windows pre-download controls apply only to Windows
installations; port pages manage their own content caches.

The integration service lives in `/srv/game-hub`, in the private repository
`Lomchat/orthros-game-hub`. Upstream engines are cloned in `/srv/game-ports`, compiled releases live in
`/srv/game-releases`, and original port contents in `/srv/game-content/<game>/versions/<version>/files`.
None of these belongs in Orthros' ignored Windows game trees or in this repository.

Caddy keeps the existing domain and proxies `/ports/*`, `/engine/*`, `/content/*` and `/multiplayer/*`
to the sibling service on localhost:8096. The existing Orthros service remains on localhost:8095.
Legacy `/library` and `/library/` links redirect to the original home: there is no second game library.
The sibling repository owns the deployment recipes, pinned upstream references, validation records,
native dedicated servers and WebSocket-to-local-UDP transport.

Port save identities use the game/version pair, independently from the engine release. Future mods
need separate installations and save identities; original files remain read-only.

To roll back the home integration, revert this change. To remove its server routes, remove only the
Caddy matcher for the sibling service and disable its three new systemd services. Preserve all game
data, accounts, browser origin and save IDs. Do not change the original Orthros service.
