// VideoShare deploy configuration.
//
// DEPLOYERS: edit the one line below. `publicBaseUrl` is the URL where your
// bucket's objects are publicly readable — the player fetches
// `{publicBaseUrl}/{id}/meta.json` and `{publicBaseUrl}/{id}/video.bin` with no
// credentials. No trailing slash.
//
//   MinIO (local compose stack) : http://localhost:9000/videoshare
//   Cloudflare R2               : https://pub-<hash>.r2.dev
//   AWS S3                      : https://<bucket>.s3.<region>.amazonaws.com
//   Behind a CDN                : https://cdn.example.com
//
// This file is copied verbatim into dist/ and loaded by index.html and
// view.html, so it can be changed after a build without rebuilding.
window.VIDEOSHARE = {
  publicBaseUrl: "http://localhost:9000/videoshare",
};
