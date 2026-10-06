# Salva Cloud

Salva Cloud adalah panel pengelola penyimpanan pribadi untuk S3, Salva Agent, dan WebDAV melalui Salva Gateway.

## Fitur

- Kelola beberapa storage dalam satu dashboard
- Upload, download, preview, folder, trash, dan share link
- Login Google serta guest key dengan pembatasan akses
- Dukungan S3, disk PC/server, dan Synology/WebDAV

## Akses

Buka [cloud.salvadev.space](https://cloud.salvadev.space), masuk, lalu tambahkan storage dari menu **Manage connections**.

Untuk WebDAV, unduh Salva Gateway dan ikuti setup guide yang tersedia saat menambahkan storage.

## Deployment aktif: Ubuntu VPS

Next.js berjalan sebagai `cloud-salva.service`, bind `127.0.0.1:8791`, di belakang nginx/HTTPS. PostgreSQL `salva_shared_production` berada di VPS yang sama, memakai role `cloud_api` dan private-CA TLS terverifikasi. Object storage/NAS, OAuth Google, session secret, dan kunci enkripsi storage dipertahankan.

Panduan deploy/rollback: [deploy/vps/README.md](deploy/vps/README.md). Konfigurasi Vercel beserta cron lama diarsipkan ke `deploy/legacy/vercel.json`; tidak dipakai untuk deployment berikutnya. Cron aktif adalah systemd timer pada 00:00 UTC / 07:00 WIB.

Development Windows memakai SSH tunnel `localhost:54330`; production tidak bergantung pada tunnel laptop. Jangan menjalankan kembali import/backfill storage lama atau mengganti `STORAGE_ENCRYPTION_KEY` saat redeploy.
