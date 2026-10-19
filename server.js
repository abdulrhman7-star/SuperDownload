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
const active = new Map();

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"], imgSrc: ["'self'", "data:", "https:"],
  scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"]
}}}));
app.use(express.json({ limit: '12kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));
const publicPages = [
  '/', '/about.html', '/contact.html', '/faq.html', '/privacy.html', '/terms.html',
  '/guides/', '/guides/instagram.html', '/guides/facebook.html', '/guides/tiktok.html',
  '/guides/threads.html', '/guides/x.html', '/guides/youtube.html', '/guides/other-sites.html',
  '/services/', '/services/video-downloader.html', '/services/audio-extraction.html',
  '/services/quality-formats.html', '/services/supported-sites.html'
];
app.get('/sitemap.xml', (req, res) => {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    publicPages.map(p => `<url><loc>${base}${p}</loc></url>`).join('') + '</urlset>';
  res.type('application/xml').send(xml);
});
app.get('/robots.txt', (req, res) => {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`);
});

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  return p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
    p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] >= 224;
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') ||
    /^fe[89ab]/.test(s) || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.');
}
async function validatePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Enter a valid video URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS links are supported.');
  if (u.username || u.password) throw new Error('URLs containing usernames or passwords are not accepted.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('Private network URLs are not supported.');
  if (net.isIP(host)) {
    if (net.isIPv4(host) ? isPrivateIPv4(host) : isPrivateIPv6(host)) throw new Error('Private network URLs are not supported.');
  } else {
    let records;
    try { records = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('The website host could not be resolved.'); }
    if (!records.length || records.some(r => net.isIPv4(r.address) ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address)))
      throw new Error('This host does not appear to be a public website.');
  }
  return u.href;
}
function runYtDlp(args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('The request timed out. Try another link.')); }, timeoutMs);
    function finish(err, result) {
      if (settled) return; settled = true; clearTimeout(timer);
      err ? reject(err) : resolve(result);
    }
    child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 1_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
    child.on('error', () => finish(new Error('yt-dlp could not be started. Check the deployment logs.')));
    child.on('close', code => code === 0 ? finish(null, stdout.trim()) :
      finish(new Error((stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'Unable to process this link.').slice(0, 450))));
  });
}
app.post('/api/info', async (req, res) => {
  try {
    const url = await validatePublicUrl(String(req.body?.url || '').trim());
    const raw = await runYtDlp(['--no-warnings', '--no-playlist', '--dump-single-json', '--skip-download', '--', url]);
    const data = JSON.parse(raw);
    res.json({
      title: String(data.title || 'Video').slice(0, 250),
      duration: Number.isFinite(data.duration) ? data.duration : null,
      uploader: String(data.uploader || data.channel || data.extractor_key || 'Unknown source').slice(0, 120),
      thumbnail: /^https:\/\//.test(data.thumbnail || '') ? data.thumbnail : null,
      formats: (data.formats || []).filter(f => f.url && (f.vcodec && f.vcodec !== 'none' || f.acodec && f.acodec !== 'none'))
        .slice(-30).map(f => ({ format_id: String(f.format_id), ext: String(f.ext || 'mp4'), quality: String(f.format_note || (f.height ? `${f.height}p` : 'Default')).slice(0, 40), hasVideo: !!(f.vcodec && f.vcodec !== 'none'), hasAudio: !!(f.acodec && f.acodec !== 'none') }))
    });
  } catch (e) { res.status(400).json({ error: e.message || 'Unable to inspect this URL.' }); }
});
app.post('/api/download', async (req, res) => {
  let dir, id, task;
  try {
    const url = await validatePublicUrl(String(req.body?.url || '').trim());
    const format = String(req.body?.format || 'best');
    if (!['best', 'mp4', '720', '480', '360', 'audio'].includes(format)) return res.status(400).json({ error: 'Unsupported format option.' });
    if (active.size >= 2) return res.status(429).json({ error: 'The free server is busy. Please try again shortly.' });
    id = crypto.randomUUID();
    dir = path.join(os.tmpdir(), 'superdownload-' + id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    active.set(id, { dir, child: null });
    const output = path.join(dir, '%(title).100B-%(id)s.%(ext)s');
    const args = ['--no-warnings', '--no-playlist', '--restrict-filenames', '--max-filesize', '300M', '--socket-timeout', '20', '--retries', '1', '-o', output];
    if (format === 'audio') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
    else if (['720', '480', '360'].includes(format)) args.push('-f', `bestvideo[height<=${format}]+bestaudio/best[height<=${format}]/best`, '--merge-output-format', 'mp4');
    else if (format === 'mp4') args.push('-f', 'best[ext=mp4]/best', '--merge-output-format', 'mp4');
    else args.push('-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4');
    args.push('--', url);
    task = runYtDlp(args, 8 * 60 * 1000);
    const current = active.get(id);
    // Track the process indirectly for orderly shutdown.
    await task;
    const files = fs.readdirSync(dir).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
    if (!files.length) throw new Error('No downloadable file was produced for this link.');
    const file = path.join(dir, files[0]);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.mp3' ? 'audio/mpeg' : ext === '.webm' ? 'video/webm' : 'video/mp4';
    res.setHeader('Content-Type', type);
    res.download(file, path.basename(file), () => cleanup());
    function cleanup() { active.delete(id); fs.rm(dir, { recursive: true, force: true }, () => {}); }
    res.on('close', cleanup);
  } catch (e) {
    if (id) active.delete(id);
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) res.status(400).json({ error: e.message || 'Download failed.' });
  }
});
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'SuperDownload' }));
app.listen(PORT, '0.0.0.0', () => console.log(`SuperDownload listening on port ${PORT}`));
