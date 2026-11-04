# Per-server residential proxy credentials

The local residential controller uses a server-specific username/password pair when one exists. Other servers continue to use `PROXY_USER` and `PROXY_PASS`. A new install needs no overrides.

Overrides are stored in the private SQLite table `residential_credentials`, not in `probe_settings` or GitHub. Treat database backups as secrets. The table is created automatically on normal API initialization after upgrading; existing server and node records are retained.

## Administrator API

All requests below require an authenticated administrator session (`Authorization: Bearer <session>`). Agent tokens and ordinary user sessions cannot manage credentials. This API applies to the local controller; external controller mode rejects it.

- `GET /api/proxy/credentials?ip=<server-ip>` returns only `{ ip, source: "server" | "global", configured: boolean }`. It never returns a username or password.
- `PUT /api/proxy/credentials` with JSON `{ "ip": "192.0.2.1", "user": "example-user", "pass": "example-password" }` saves a complete pair for an existing server.
- `PUT /api/proxy/credentials` with JSON `{ "ip": "192.0.2.1", "inherit": true }` deletes the override and restores global fallback. Do not include `user` or `pass` in this request.

Both values must contain 1–255 UTF-8 bytes, without control characters. Usernames cannot contain a colon. Incomplete or invalid pairs are rejected without modifying the saved pair. Successful writes return status metadata only and do not send an Agent refresh command, allowing an override to be staged before a pilot migration. A connected Agent will use it at its next configuration fetch; changing credentials on an already migrated server can therefore affect that server's clients.

The same credential selection is used by residential controller config responses, authenticated Agent `residential_outbound` config, administrator SOCKS5 endpoint lists, and administrator standard/Clash subscriptions. Ordinary user subscriptions do not include residential endpoints. Deleting a server deletes its override as well.

## Existing deployment migration

Do not change the global credentials to migrate one server. First read that server's old controller config locally, save its complete credential pair through the administrator API, and verify from that server that the new controller returns the same pair, country, port, and enabled state. Do not paste credentials into a chat or commit them to this repository.

Only then back up the pilot's `/etc/proxy-lite/env`, switch that pilot's controller, and restart its residential service. A restart may interrupt connections and change the residential exit IP. Verify actual authenticated SOCKS5 traffic and status reporting separately; service `active` and ordinary monitoring heartbeats do not establish that the residential tunnel works. Preserve the old environment backup for rollback. This feature alone does not fix the separate frontend real-time status merge issue.

## Validation

Run `node test/residential-credentials.mjs` with Node 22.13+ or Node 24. The test checks global fallback, two-server isolation, administrator-only management, input validation, secret-free status/settings responses, Agent config, endpoint encoding, both subscription formats, restart persistence, override removal, and server deletion.
