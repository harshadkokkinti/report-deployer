require('dotenv').config();
const express = require('express');
const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();

// Admin path — set ADMIN_PATH in .env to something hard to guess
const ADMIN_PATH = (process.env.ADMIN_PATH || 'admin').replace(/^\/|\/$/g, '');
const A = '/' + ADMIN_PATH; // shorthand helper

const templatePath = path.join(__dirname, '../views/report.ejs');
let reportTemplate = null;
try {
  reportTemplate = fs.readFileSync(templatePath, 'utf-8');
} catch (e) {
  console.warn('EJS template not found at', templatePath);
}

function loadHtml(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8').replace(/__ADMIN_PATH__/g, ADMIN_PATH);
  } catch (e) {
    return '';
  }
}
const loginHtml = loadHtml(path.join(__dirname, '../views/login.html'));
const dashHtml  = loadHtml(path.join(__dirname, '../public/index.html'));

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ limit: '20mb', type: ['application/json', 'text/html', 'text/*'] }));
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ── Auth helpers ──────────────────────────────────────────────────────────────
function sessionToken() {
  const secret = (process.env.ADMIN_PASS || '') + (process.env.ADMIN_USER || '');
  return crypto.createHmac('sha256', secret).update('olly-admin-v1').digest('hex');
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), decodeURIComponent(v.join('='))];
    }).filter(([k]) => k)
  );
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(500).send('ADMIN_USER and ADMIN_PASS env vars are not set');
  }
  if (parseCookies(req).admin_token === sessionToken()) return next();
  res.redirect(A + '/login');
}

// ── Manifest helpers ──────────────────────────────────────────────────────────
async function readManifest(octokit, owner, repo) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: 'pages/manifest.json' });
    return { content: JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8')), sha: data.sha };
  } catch (err) {
    if (err.status === 404) return { content: {}, sha: null };
    throw err;
  }
}

async function writeManifest(octokit, owner, repo, content, sha) {
  const opts = {
    owner, repo,
    path: 'pages/manifest.json',
    message: 'chore: update manifest',
    content: Buffer.from(JSON.stringify(content, null, 2), 'utf-8').toString('base64'),
  };
  if (sha) opts.sha = sha;
  await octokit.repos.createOrUpdateFileContents(opts);
}

function extractBrandName(html) {
  const m = html.match(/<title>([^<]+)/i);
  if (!m) return 'Unknown';
  return m[1].replace(/\s*Reputation Report.*$/i, '').trim() || 'Unknown';
}

function convertImageUrl(url) {
  const gd = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (gd) return `https://drive.google.com/uc?export=download&id=${gd[1]}`;
  return url;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'brand';
}

function mimeToExt(mime) {
  const m = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
  return m[mime.split(';')[0].trim()] || 'jpg';
}

function downloadImageBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImageBuffer(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from image URL`));
      const mime = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Admin login/logout ────────────────────────────────────────────────────────
app.get(A + '/login', (req, res) => {
  if (process.env.ADMIN_USER && parseCookies(req).admin_token === sessionToken()) {
    return res.redirect(A);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(loginHtml);
});

app.post(A + '/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    res.setHeader('Set-Cookie', `admin_token=${sessionToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.redirect(A);
  }
  res.redirect(A + '/login?error=1');
});

app.get(A + '/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.redirect(A + '/login');
});

app.get('/', (req, res) => res.status(404).send('<h1>404</h1>'));
app.get(A, requireAdmin, (req, res) => {
  const rawSheet = process.env.GOOGLE_SHEET_URL || '';
  const sheetEmbed = rawSheet
    ? rawSheet.replace(/\/(edit|pub|htmlview)[^]*$/, '/htmlview')
    : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashHtml.replace('__SHEET_EMBED_URL__', () => sheetEmbed));
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function cleanJson(raw) {
  let s = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (arr[0] && typeof arr[0].output === 'string') {
        s = arr[0].output.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
      }
    } catch (_) {}
  }
  return s;
}

function getOctokit() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    throw new Error('Missing GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO env vars');
  }
  return { octokit: new Octokit({ auth: token }), owner, repo };
}

function baseUrl(req) {
  const site = process.env.SITE_URL;
  if (site) return site.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// ── Report routes ─────────────────────────────────────────────────────────────
app.get('/brand-images/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^[a-z0-9_-]+\.(jpg|jpeg|png|webp|gif|svg)$/i.test(filename)) {
    return res.status(400).send('Invalid filename');
  }
  try {
    const { octokit, owner, repo } = getOctokit();
    const { data } = await octokit.repos.getContent({ owner, repo, path: `brand-images/${filename}` });
    const ext = filename.split('.').pop().toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
    res.setHeader('Content-Type', mimeMap[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(data.content, 'base64'));
  } catch (err) {
    if (err.status === 404) return res.status(404).send('Not found');
    res.status(500).send('Error');
  }
});

app.get('/complaint-report-:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    return res.status(400).send('<h1>400 — Invalid ID</h1>');
  }
  try {
    const { octokit, owner, repo } = getOctokit();
    const { data } = await octokit.repos.getContent({ owner, repo, path: `pages/${uuid}.html` });
    const html = Buffer.from(data.content, 'base64').toString('utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    if (err.status === 404) return res.status(404).send('<h1>404 — Page not found</h1>');
    console.error(err);
    res.status(500).send('<h1>500 — Server error</h1>');
  }
});

app.post('/api/deploy', async (req, res) => {
  let html;
  let brandName = 'Unknown';

  if (req.is('application/json')) {
    if (!reportTemplate) return res.status(500).json({ error: 'EJS template not found on server' });
    let data;
    try {
      data = JSON.parse(cleanJson(String(req.body)));
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid JSON: ' + parseErr.message });
    }
    brandName = data.brand_name || 'Unknown';
    let brandImageUrl = null;
    if (data.image_url) {
      try {
        const { octokit: gio, owner: go, repo: gr } = getOctokit();
        const { buffer, mime } = await downloadImageBuffer(convertImageUrl(data.image_url));
        const ext = mimeToExt(mime);
        const imgSlug = slugify(brandName);
        const imgPath = `brand-images/${imgSlug}.${ext}`;
        let imgSha = null;
        try { const { data: ex } = await gio.repos.getContent({ owner: go, repo: gr, path: imgPath }); imgSha = ex.sha; } catch (_) {}
        const imgOpts = { owner: go, repo: gr, path: imgPath, message: `asset: brand image for ${brandName}`, content: buffer.toString('base64') };
        if (imgSha) imgOpts.sha = imgSha;
        await gio.repos.createOrUpdateFileContents(imgOpts);
        brandImageUrl = `/brand-images/${imgSlug}.${ext}`;
      } catch (imgErr) {
        console.warn('Brand image upload failed:', imgErr.message);
      }
    }
    try {
      html = ejs.render(reportTemplate, { d: { ...data, brand_image_url: brandImageUrl } });
    } catch (ejsErr) {
      return res.status(400).json({ error: 'Template render failed: ' + ejsErr.message });
    }
  } else if (typeof req.body === 'string' && req.body.trim()) {
    html = req.body;
    brandName = extractBrandName(html);
  } else {
    return res.status(400).json({ error: 'Send report JSON (application/json) or raw HTML (text/html)' });
  }

  if (!html.trim()) return res.status(400).json({ error: 'HTML cannot be empty' });

  try {
    const { octokit, owner, repo } = getOctokit();
    const uuid = uuidv4();

    await octokit.repos.createOrUpdateFileContents({
      owner, repo,
      path: `pages/${uuid}.html`,
      message: `deploy: report ${uuid}`,
      content: Buffer.from(html, 'utf-8').toString('base64'),
    });

    const { content: manifest, sha: manifestSha } = await readManifest(octokit, owner, repo);
    manifest[uuid] = { brand_name: brandName, deployed_at: new Date().toISOString() };
    await writeManifest(octokit, owner, repo, manifest, manifestSha);

    const base = baseUrl(req);
    res.status(201).json({
      uuid,
      brand_name: brandName,
      url: `${base}/complaint-report-${uuid}`,
      status: 'deployed',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pages', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));

  try {
    const { octokit, owner, repo } = getOctokit();
    const [dirResult, manifestResult] = await Promise.allSettled([
      octokit.repos.getContent({ owner, repo, path: 'pages' }),
      readManifest(octokit, owner, repo),
    ]);

    if (dirResult.status === 'rejected' && dirResult.reason?.status === 404) {
      return res.json({ total: 0, page, totalPages: 0, pages: [] });
    }
    if (dirResult.status === 'rejected') throw dirResult.reason;

    const { content: manifest, sha: manifestSha } =
      manifestResult.status === 'fulfilled' ? manifestResult.value : { content: {}, sha: null };

    const files = (Array.isArray(dirResult.value.data) ? dirResult.value.data : [])
      .filter(f => f.type === 'file' && f.name.endsWith('.html'));

    // Build full page list — never block on HTML fetches
    const base = baseUrl(req);
    const allPages = files.map(f => {
      const uuid = f.name.replace('.html', '');
      const meta = manifest[uuid] || {};
      return {
        uuid,
        brand_name: meta.brand_name || 'Unknown',
        deployed_at: meta.deployed_at || null,
        url: `${base}/complaint-report-${uuid}`,
        sha: f.sha,
      };
    });

    // Sort newest → oldest (nulls at bottom)
    allPages.sort((a, b) => {
      if (!a.deployed_at && !b.deployed_at) return 0;
      if (!a.deployed_at) return 1;
      if (!b.deployed_at) return -1;
      return new Date(b.deployed_at) - new Date(a.deployed_at);
    });

    const total      = allPages.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const safePage   = Math.min(page, totalPages);
    const slice      = allPages.slice((safePage - 1) * limit, safePage * limit);

    res.json({ total, page: safePage, totalPages, pages: slice });

    // Background: backfill brand names for any entry missing from manifest (fire-and-forget)
    const missing = files.map(f => f.name.replace('.html', '')).filter(u => !manifest[u]);
    if (missing.length > 0) {
      Promise.all(missing.map(async (uuid) => {
        try {
          const { data } = await octokit.repos.getContent({ owner, repo, path: `pages/${uuid}.html` });
          const html = Buffer.from(data.content, 'base64').toString('utf-8');
          manifest[uuid] = { brand_name: extractBrandName(html), deployed_at: null };
        } catch (_) {
          manifest[uuid] = { brand_name: 'Unknown', deployed_at: null };
        }
      })).then(() => writeManifest(octokit, owner, repo, manifest, manifestSha)).catch(console.error);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pages/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID' });
  }
  try {
    const { octokit, owner, repo } = getOctokit();
    const { data } = await octokit.repos.getContent({ owner, repo, path: `pages/${uuid}.html` });
    await octokit.repos.deleteFile({
      owner, repo,
      path: `pages/${uuid}.html`,
      message: `delete: report ${uuid}`,
      sha: data.sha,
    });

    const { content: manifest, sha: manifestSha } = await readManifest(octokit, owner, repo);
    delete manifest[uuid];
    await writeManifest(octokit, owner, repo, manifest, manifestSha);

    res.json({ status: 'deleted', uuid });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Page not found' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nReport Deployer running at http://localhost:${PORT}`);
    console.log(`  GET  /admin        — dashboard (login required)`);
    console.log(`  POST /api/deploy   — deploy report`);
    console.log(`  GET  /api/pages    — list all`);
    console.log(`  DELETE /api/pages/:uuid — remove\n`);
  });
}

module.exports = app;
