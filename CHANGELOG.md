# Changelog

## 0.1.2 — 2026-10-11

### Added

- **`new GnarlClient()` finds the Gnarly app on this machine.** With no `url`
  and no `$GNARL_URL`, the client reads the endpoint the local node recorded
  when it started — `$LUCENIA_DATA_DIR/runtime/endpoint.json`, then
  `~/.lucenia/runtime/endpoint.json` — and otherwise uses
  `http://127.0.0.1:43300`. A recorded plain-HTTP endpoint is used only on
  loopback, nothing is dialled at construction, and an https address you
  configure is never downgraded. Files are read only under Node (and Bun);
  browser and edge bundles import nothing from Node and use the default.

### Fixed

- The default address was `https://localhost:8080`, a port no node listens on,
  and the README said 8080 throughout. A node's default port is **43300**.
- `memory.recall` in a namespace nothing was written to: nodes up to
  0.1.0-rc29 omit `embedder` from that answer, which the type declares as a
  string. The client fills it with `""`.

## 0.1.1 — 2026-10-10

- Published as `gnarl-client` by npm trusted publishing alone.

## 0.1.0 — 2026-10-09

- The TypeScript client for Gnarl.
