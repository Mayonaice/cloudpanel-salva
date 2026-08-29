# Salva Transfer Gateway (WebDAV)

This optional gateway is required only for WebDAV connections. Run it on the NAS or a machine that can reach the NAS privately. Salva Cloud and browsers talk to the gateway; the WebDAV username and password remain local to it.

Required environment variables:

- `WEBDAV_ENDPOINT`: private HTTPS WebDAV URL, for example `https://192.168.1.20:5006` (certificate must be valid for that host).
- `WEBDAV_USERNAME`, `WEBDAV_PASSWORD`, `WEBDAV_ROOT`.
- `GATEWAY_TOKEN`: random secret of at least 32 characters.
- `APP_ORIGIN=https://cloud.salvadev.space`.
- `GATEWAY_PUBLIC_URL`: public HTTPS URL forwarded to `127.0.0.1:8788`.

Run `node transfer-gateway/server.mjs`, or build the included Dockerfile. In Synology Container Manager, mount a persistent directory at the path set in `GATEWAY_STAGING`, configure the variables above, and publish only to localhost/LAN. Put Cloudflare Tunnel or another TLS reverse proxy in front. Do not enable an interactive Cloudflare Access login on this hostname because browser transfer URLs are already signed and short lived.

In Salva Cloud choose **WebDAV via Transfer Gateway**, then enter `GATEWAY_PUBLIC_URL` and `GATEWAY_TOKEN`. Do not enter the DSM/WebDAV URL or WebDAV password in Salva Cloud.

The gateway supports real folders, listing, direct and multipart upload, ranged download, and delete. Multipart staging is local and capped at 5 GiB per upload; available staging space and the WebDAV server's limits still apply.
