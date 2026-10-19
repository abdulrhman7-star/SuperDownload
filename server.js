'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

// Concurrency and limits
const MAX_DOWNLOADS = 4;
const MAX_INFO = 6;
const MAX_OUTPUT_BYTES = 350 * 1024 * 1024;      // hard post-download cap
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const INFO_TIMEOUT_MS = 60 * 1000;
const MIN_FREE_DISK_BYTES = 400 * 1024 * 1024;

// Track active work so SIGTERM can kill it cleanly
const activeDownloads = new Map();   // id -> { dir, child, phase: 'starting'|'downloading'|'serving' }
const activeInfoChildren = new Set(); // child processes for /api/info

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
app.disable('x-powered-by');

// Render sits one hop in front. Without this, req.ip is the proxy's IP
// (rate limiter collapses all users into one bucket) and req.protocol is
// 'http' (sitemap advertises the wrong origin).
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

app.use(express.json({ limit: '12kb' }));
app.use(express.urlencoded({ extended: false, limit: '12kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Health check — BEFORE the rate limiter so Render's probes never get 429'd
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'SuperDownload' }));

// Now apply rate limiting to everything else under /api/
app.use('/api/', rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ---------------------------------------------------------------------------
// Sitemap / robots
// ---------------------------------------------------------------------------
const publicPages = [
  '/', '/about.html', '/contact.html', '/faq.html', '/privacy.html', '/terms.html',
  '/guides/', '/guides/instagram.html', '/guides/facebook.html', '/guides/tiktok.html',
  '/guides/threads.html', '/guides/x.html', '/guides/youtube.html', '/guides/other-sites.html',
  '/services/', '/services/video-downloader.html', '/services/audio-extraction.html',
  '/services/quality-formats.html', '/services/supported-sites.html',
];

function siteBase(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

app.get('/sitemap.xml', (req, res) => {
  const base = siteBase(req);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    publicPages.map(p => `<url><loc>${base}${p}</loc></url>`).join('') +
    '</urlset>';
  res.type('application/xml').send(xml);
});

app.get('/robots.txt', (req, res) => {
  const base = siteBase(req);
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`
  );
});

// ---------------------------------------------------------------------------
// Private-address detection (IPv4 + IPv6, with CGNAT and IPv4-mapped coverage)
// ---------------------------------------------------------------------------
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||     // CGNAT 100.64/10
    (p[0] === 169 && p[1] === 254) ||                  // link-local
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||      // RFC 1918
    (p[0] === 192 && p[1] === 168) ||                  // RFC 1918
    p[0] >= 224                                         // multicast + reserved
  );
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/%.*$/, '');     // strip zone id
  if (s === '::1' || s === '::') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);        // any IPv4-mapped
  if (/^f[cd]/.test(s)) return true;                   // ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return true;                // link-local fe80::/10
  return false;
}

async function validatePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Enter a valid video URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS links are supported.');
  if (u.username || u.password) throw new Error('URLs containing usernames or passwords are not accepted.');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private network URLs are not supported.');
  }

  if (net.isIP(host)) {
    const bad = net.isIPv4(host) ? isPrivateIPv4(host) : isPrivateIPv6(host);
    if (bad) throw new Error('Private network URLs are not supported.');
  } else {
    let records;
    try { records = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('The website host could not be resolved.'); }
    if (!records.length) throw new Error('This host does not appear to be a public website.');
    if (records.some(r => net.isIPv4(r.address) ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address))) {
      throw new Error('This host does not appear to be a public website.');
    }
  }
  return u.href;
}

// ---------------------------------------------------------------------------
// Process management helpers
// ---------------------------------------------------------------------------
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // Windows: no process groups via negative PID; use taskkill /T
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Run yt-dlp, resolving with stdout or rejecting with a user-safe message.
 *
 * opts.signal   AbortSignal — kills the process tree on abort
 * opts.timeoutMs
 * opts.onSpawn  (child) => void — for tracking / graceful shutdown
 */
function runYtDlp(args, { timeoutMs = 45_000, signal, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',   // own process group
    });

    if (onSpawn) onSpawn(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      killTree(child);
      finish(new Error('The request timed out. Try another link.'));
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      finish(new Error('Request cancelled.'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(result);
    }

    child.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > 1_000_000) {
        killTree(child);
        finish(new Error('Response from yt-dlp was too large.'));
      }
    });

    child.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });

    child.on('error', () => finish(
      new Error('yt-dlp could not be started. Check the deployment logs.')
    ));

    child.on('close', code => {
      if (settled) return;
      if (code === 0) {
        finish(null, stdout.trim());
      } else {
        // Keep raw stderr server-side; return a fixed message to the user
        // so we don't leak yt-dlp version / extractor details.
        console.error('[yt-dlp] exit', code, '\n', stderr.slice(-2000));
        finish(new Error('Unable to process this link. It may be unsupported or temporarily unavailable.'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// /api/info
// ---------------------------------------------------------------------------
app.post('/api/info', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    if (activeInfoChildren.size >= MAX_INFO) {
      return res.status(503).json({ error: 'Server is busy. Please try again shortly.' });
    }

    const url = await validatePublicUrl(String(req.body?.url || '').trim());
    const raw = await runYtDlp(
      ['--no-warnings', '--no-playlist', '--dump-single-json', '--skip-download', '--', url],
      {
        timeoutMs: INFO_TIMEOUT_MS,
        signal: ac.signal,
        onSpawn: (child) => {
          activeInfoChildren.add(child);
          child.on('close', () => activeInfoChildren.delete(child));
        },
      }
    );

    const data = JSON.parse(raw);
    res.json({
      title: String(data.title || 'Video').slice(0, 250),
      duration: Number.isFinite(data.duration) ? data.duration : null,
      uploader: String(data.uploader || data.channel || data.extractor_key || 'Unknown source').slice(0, 120),
      thumbnail: /^https:\/\//.test(data.thumbnail || '') ? data.thumbnail : null,
      formats: (data.formats || [])
        .filter(f => f.url && ((f.vcodec && f.vcodec !== 'none') || (f.acodec && f.acodec !== 'none')))
        .slice(-30)
        .map(f => ({
          format_id: String(f.format_id),
          ext: String(f.ext || 'mp4'),
          quality: String(f.format_note || (f.height ? `${f.height}p` : 'Default')).slice(0, 40),
          hasVideo: !!(f.vcodec && f.vcodec !== 'none'),
          hasAudio: !!(f.acodec && f.acodec !== 'none'),
        })),
    });
  } catch (e) {
    if (ac.signal.aborted) return;
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.status(400).json({ error: e.message || 'Unable to inspect this URL.' });
    }
  }
});

// ---------------------------------------------------------------------------
// /api/download
// ---------------------------------------------------------------------------
app.post('/api/download', async (req, res) => {
  let id = null;
  let dir = null;
  let ac = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (id) activeDownloads.delete(id);
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
  };

  try {
    if (activeDownloads.size >= MAX_DOWNLOADS) {
      return res.status(503).json({ error: 'Server is busy. Please try again shortly.' });
    }

    const url = await validatePublicUrl(String(req.body?.url || '').trim());
    const format = String(req.body?.format || 'best');
    if (!['best', 'mp4', '720', '480', '360', 'audio'].includes(format)) {
      return res.status(400).json({ error: 'Unsupported format option.' });
    }

    // Free-disk pre-check. --max-filesize does not stop streaming/HLS formats,
    // so the disk can actually fill up.
    try {
      const stats = await fs.promises.statfs(os.tmpdir());
      const freeBytes = stats.bavail * stats.bsize;
      if (freeBytes < MIN_FREE_DISK_BYTES) {
        return res.status(503).json({ error: 'Server storage is temporarily unavailable.' });
      }
    } catch { /* statfs not supported; proceed */ }

    id = crypto.randomUUID();
    dir = path.join(os.tmpdir(), 'superdownload-' + id);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

    ac = new AbortController();
    activeDownloads.set(id, { dir, child: null, phase: 'starting' });

    // Abort yt-dlp if the client hangs up mid-download.
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    const output = path.join(dir, '%(title).100B-%(id)s.%(ext)s');
    const args = [
      '--no-warnings', '--no-playlist', '--restrict-filenames',
      '--max-filesize', '300M',
      '--socket-timeout', '20', '--retries', '1',
      '-o', output,
    ];

    if (format === 'audio') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
    } else if (['720', '480', '360'].includes(format)) {
      args.push(
        '-f', `bestvideo[height<=${format}]+bestaudio/best[height<=${format}]/best`,
        '--merge-output-format', 'mp4'
      );
    } else if (format === 'mp4') {
      args.push('-f', 'best[ext=mp4]/best', '--merge-output-format', 'mp4');
    } else {
      args.push('-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4');
    }
    args.push('--', url);

    const entry = activeDownloads.get(id);
    entry.phase = 'downloading';

    await runYtDlp(args, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      signal: ac.signal,
      onSpawn: (child) => {
        const e = activeDownloads.get(id);
        if (e) e.child = child;
      },
    });

    if (ac.signal.aborted) { cleanup(); return; }

    // Pick output file. --max-filesize isn't a hard cap for streamed formats,
    // so enforce it on disk too.
    const candidates = fs.readdirSync(dir).filter(f =>
      !/\.(part|ytdl|info\.json)$/i.test(f) && !/\.temp\./i.test(f)
    );
    if (!candidates.length) throw new Error('No downloadable file was produced for this link.');

    const sized = candidates
      .map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    const chosen = sized.find(c => c.size > 1024) || sized[0];
    if (chosen.size > MAX_OUTPUT_BYTES) {
      throw new Error('The downloaded file exceeds the size limit.');
    }

    const file = path.join(dir, chosen.f);
    const ext = path.extname(file).toLowerCase();
    const type =
      ext === '.mp3' ? 'audio/mpeg' :
      ext === '.m4a' ? 'audio/mp4' :
      ext === '.webm' ? 'video/webm' :
      ext === '.mkv' ? 'video/x-matroska' :
      'video/mp4';

    res.setHeader('Content-Type', type);

    const liveEntry = activeDownloads.get(id);
    if (liveEntry) liveEntry.phase = 'serving';

    res.download(file, path.basename(file), () => cleanup());
  } catch (e) {
    cleanup();
    if (ac && ac.signal.aborted) return;
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.status(400).json({ error: e.message || 'Download failed.' });
    }
  }
});

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SuperDownload listening on port ${PORT}`);
});

// Sweep stale temp dirs from previous crashed/force-killed boots.
// Only delete dirs older than 1 hour so a concurrent replica isn't disturbed.
fs.readdir(os.tmpdir(), async (err, entries) => {
  if (err) return;
  for (const name of entries) {
    if (!name.startsWith('superdownload-')) continue;
    const full = path.join(os.tmpdir(), name);
    try {
      const st = await fs.promises.stat(full);
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) {
        await fs.promises.rm(full, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: draining ${activeDownloads.size} download(s), ${activeInfoChildren.size} info process(es)`);

  // 1. Kill /api/info children
  for (const child of activeInfoChildren) killTree(child);
  activeInfoChildren.clear();

  // 2. Kill in-progress downloads (not ones already streaming to the client)
  const toKill = [];
  for (const [id, task] of activeDownloads) {
    if (task.phase !== 'serving') toKill.push([id, task]);
  }
  for (const [id, task] of toKill) {
    killTree(task.child);
    await fs.promises.rm(task.dir, { recursive: true, force: true }).catch(() => {});
    activeDownloads.delete(id);
  }

  // 3. Let in-flight responses finish, then exit
  server.close(() => {
    console.log('[shutdown] clean exit');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[shutdown] force exit');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
