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
// OPTIONAL: `gatewayUrl` turns on gateway mode (docs/gateway-setup.md). Point it
// at a deployed VideoShare gateway and the recorder stops holding bucket
// credentials altogether: the storage settings panel disappears, recording
// requires Google sign-in, and every upload uses a presigned URL the gateway
// hands out. Objects still travel browser↔bucket — the gateway never carries a
// byte of video. No trailing slash.
//
//   Same origin (site and gateway behind one host) : "/api"
//   Cloudflare Worker                              : "https://videoshare-gateway.<you>.workers.dev/api"
//   Lambda function URL                            : "https://<id>.lambda-url.<region>.on.aws/api"
//
// Note the "/api": the gateway serves GET {gatewayUrl}/config and
// POST {gatewayUrl}/sign, so gatewayUrl is the prefix those hang off.
//
// Leave it out (as below) for legacy mode: credentials in this browser's
// localStorage, no sign-in, no server of any kind. Viewing is identical either
// way — view.html only ever needs publicBaseUrl.
//
// This file is copied verbatim into dist/ and loaded by index.html and
// view.html, so it can be changed after a build without rebuilding.
window.VIDEOSHARE = {
  publicBaseUrl: "http://localhost:9000/videoshare",
  // gatewayUrl: "/api",
};
