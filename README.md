# SuperDownload — Render-ready

A responsive multilingual video downloader website. This version includes a Dockerfile that installs Node.js app dependencies, Python, `yt-dlp`, and FFmpeg, plus a Render Blueprint file.

## Deploy on Render (no local installation required)

1. Download and extract `SuperDownload-Render.zip`.
2. Sign in to GitHub and create a **new empty repository** named `SuperDownload`. Do not add a README/license from GitHub, because this archive already contains project files.
3. Upload all files and folders from the extracted archive to the repository's root. Ensure `Dockerfile`, `render.yaml`, `package.json`, and `server.js` are at the root—not inside an extra nested folder.
4. Open https://dashboard.render.com/ and connect GitHub if prompted.
5. Choose **New → Blueprint** (or create a new Web Service and select Docker runtime). Select the repository containing these files.
6. Render reads `render.yaml` and builds the Docker image. Confirm the service uses the **Free** plan if offered for your account/region.
7. Wait for the build to finish, then open the `onrender.com` URL shown in the dashboard.

## Content pages included

- Homepage with original explanatory content and links to guides/services
- Platform guides: Instagram, Facebook, TikTok, Threads, X, YouTube, and other websites
- Service pages: video downloader, audio extraction/MP3, quality and formats, supported websites
- About, FAQ, Privacy Policy, Terms of Use, and Contact/reporting page
- Dynamically generated `/sitemap.xml` and `/robots.txt`

Before applying for advertising, review every page, set `SUPPORT_EMAIL` in `public/contact.js` to a real monitored address, ensure the privacy policy matches any analytics/ads you actually enable, and verify the deployed site. Content pages improve navigation and usefulness but do not guarantee AdSense approval.

## What's installed by Docker

- Node.js 20
- Python 3 and current `yt-dlp`
- FFmpeg for merging streams and audio conversion
- Express and Helmet

## Important limitations

- Free hosting is intended for demos and light testing. Services may sleep, have limited CPU/RAM, impose bandwidth or build limits, and may not be suitable for large or frequent downloads. Availability and free-plan details can change.
- The current downloader intentionally limits concurrent jobs to two, limits media to 300 MB, and times out extraction after eight minutes. Adjust only after checking your host's limits.
- Some platforms block automated requests or require cookies/login. The application does not bypass DRM, logins, paywalls, or access controls.
- The URL checks are a basic safeguard, not a complete defense against server-side request forgery. For production, use infrastructure-level outbound network restrictions, monitoring, and a sandbox. Do not treat this demo as production-hardened.
- Download only content you own, have permission to save, or are legally allowed to download. Respect copyright, privacy, and each site's terms.
- Before public launch, add a privacy policy, acceptable-use terms, and abuse-reporting process.

## Local run (optional)

Requires Docker:

```bash
docker build -t superdownload .
docker run --rm -p 3000:3000 superdownload
```

Then open http://localhost:3000.

## Structure

```text
SuperDownload-Render/
├── Dockerfile
├── render.yaml
├── .dockerignore
├── .gitignore
├── package.json
├── server.js
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```
