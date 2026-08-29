# NAS Agent (protocol cloud-nas-v1)

This agent exposes only one explicitly chosen directory. It is not an arbitrary HTTP, SMB or WebDAV connector. Use Node.js 22+ and run under a dedicated OS account whose filesystem permissions are restricted to that directory. Do not choose your whole drive, home directory, or a directory writable by untrusted local users. Symlinks, Windows reserved names and path traversal are rejected.

## Configuration

Set the following environment variables in the service configuration (keep the token private):

- `NAS_ROOT`: existing absolute directory to share.
- `NAS_TOKEN`: cryptographically random secret, at least 32 characters.
- `APP_ORIGIN`: `https://cloud.salvadev.space`.
- `NAS_PUBLIC_URL`: your HTTPS tunnel hostname, with no trailing slash.
- `PORT`: optional, default `8787`.

Run `node nas-agent/server.mjs`. It binds to **127.0.0.1**, not your LAN. Configure your Cloudflare Tunnel to forward the chosen hostname to `http://127.0.0.1:8787`. Keep the PC, agent and tunnel running. Do not expose this localhost port directly on your router. Add the public HTTPS origin and agent token using **Add storage → NAS Agent API** in the web app.

The control API requires the agent token. Browser uploads/downloads use short-lived signed transfer URLs, without exposing the agent token. Anyone holding a signed URL can use it until expiry; revoking a share prevents new URLs, not already issued URLs. Do not place an interactive login challenge in front of the transfer endpoint: it would block signed downloads and browser uploads. Restrict allowed browser origins to your app origin. Tunnel account configuration and provider upload limits must be checked for your plan; large transfers may need smaller parts or another transport.

## Files and capacity

Folders are real directories. File names and extensions are preserved. Uploads never overwrite an existing path. `.cloud-agent` is private staging state and is excluded from listing. Do not modify staging files while uploads are running. Abandoned multipart sessions can remain when a connection is disconnected; reconnect and run application cleanup, or stop the agent and remove only expired staging sessions after confirming no active uploads.

The optional connection capacity is an application limit, not your NAS disk's physical capacity. Actual free space still constrains uploads. A disconnected connection keeps files untouched. Deleting a file permanently through the UI deletes it on the NAS.

## Verification

`npm test` exercises an actual local agent with a temporary directory, including authentication, path confinement, folder creation, direct/multipart upload, range download and deletion. This does not verify your own PC, Cloudflare Tunnel or production NAS endpoint until paired and tested separately.
