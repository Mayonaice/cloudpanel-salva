# Cloud Salva VPS — active deployment

Domain `https://cloud.salvadev.space`; app `/home/ubuntu/Salva/Apps/CloudSalva`; service `cloud-salva`; loopback 8791.
Node 24 `/home/ubuntu/Salva/Dependencies/node/current/bin/node`; app dependency link targets `/home/ubuntu/Salva/Dependencies/cloud-salvaweb/node_modules`.
Environment `.env.production` mode 600. Database `salva_shared_production`, localhost 5433, role `cloud_api`; private-CA TLS verified. Runtime role cannot upgrade schema; use separately reviewed migrations.

## Source-only release

1. Run tests, typecheck, lint/build locally. Verify installed package/lockfile parity. Dependency changes require fresh dependency/release directories; never npm ci through the live symlink.
2. BEFORE upload, preserve prior app/Next build and protected env. Preserve STORAGE_ENCRYPTION_KEY, SESSION_SECRET, Google OAuth, CRON_SECRET and storage/NAS settings. Never regenerate them or deploy masked Vercel exports.
3. Upload reviewed source/public/config and deploy kit only. Exclude `.env*`, `.git`, `.vercel`, `.next`, dependencies, local NAS state, logs/backups.
4. During planned maintenance pause job timer and stop `cloud-salva`; build with VPS Node 24 using `npm run build -- --webpack`. Turbopack does not support this dependency layout. Preserve old `.next` for rollback. No legacy backfill/import or storage recreation.
5. Start after successful build; validate health, session/storage reads, anonymous files/cron=401, downloads and external storage. Resume timer after success. On failure restore old source/Next build and restart old service; no automatic DB rollback.

Reviewed nginx/service templates live here. Validate nginx before reload and preserve existing HTTPS certificates/renewal.

## Daily jobs and legacy

`cloud-salva-jobs.timer` runs at 00:00 UTC / 07:00 WIB. Runner belongs to THIS project at `deploy/vps/cloud-jobs.mjs`, not Linia. Do not force jobs to smoke-test deployment: maintenance may mutate/purge eligible data. Inspect timer/logs instead.
Vercel production stays paused; config/old cron is archived in `deploy/legacy/vercel.json`. Do not reactivate Vercel cron in parallel. Preserve rollback artifacts.
External media/NAS is not migrated by code deploy; known missing object is out of scope. Tunnel startup and SMTP are deferred. PostgreSQL backups are enabled separately by salva-postgres-backup.timer at 02:00 WIB; media backup remains separate.


## Share collections release (6 October 2026)

Apply `migrations/20261006-share-collections.sql` with the database administrator in a transaction before starting the new application. The runtime role must not perform DDL. Record this migration in the existing `cloud_migrations.cloud_migrations` ledger using the SHA-256 of the SQL and timestamp `1791259200000`; preserve existing ledger rows. The migration is additive except that `cloud_shares.file_id` becomes nullable; the target check requires exactly one file or folder. Legacy links keep their token/password hashes, but their original URL and password cannot be recovered.

New links retain separately encrypted tokens/passwords using the existing STORAGE_ENCRYPTION_KEY with share-specific authenticated context. Owner/admin can retrieve passwords; Full Access cannot receive password fields; Read Only cannot list/create/revoke links. Folder shares include current descendants in the same owner/storage and exclude trash. Files added later are included; moving files outside the shared subtree removes access. Unlocked shares use a separate HttpOnly grant for at most one hour, bounded by share expiry; every request rechecks revocation and membership.

Preview routes stream protected bytes through the app. PDF uses the vendored PDF.js worker/cmaps/fonts/wasm in `public/workers`, pinned to the package version. Update these assets together when changing pdfjs-dist. MKV requires Ubuntu's `ffmpeg` executable, available through PATH. It streams a 720p-class H.264/AAC MP4 rendition without storing media, one conversion per application process, for up to two hours; seeking is limited to buffered content. MP4 streams original byte ranges; unusual MP4 codecs may still depend on browser support. No new permanent media cache is introduced.

This release changes dependencies. Install the reviewed lockfile into a fresh dependency directory, then point the app's node_modules symlink at it during maintenance. Do not run npm ci through the live symlink. Back up source/build, environment and database before migration; stop the job timer during maintenance and resume it after checks. A rollback restores the old source/build/dependency link; keep additive schema changes and avoid rolling back unrelated data.
