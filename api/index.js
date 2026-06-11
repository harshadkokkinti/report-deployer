require('dotenv').config();
const express = require('express');
const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

const app = express();

const templatePath = path.join(__dirname, '../views/report.ejs');
let reportTemplate = null;
try {
  reportTemplate = fs.readFileSync(templatePath, 'utf-8');
} catch (e) {
  console.warn('EJS template not found at', templatePath);
}

app.use(cors());
// Accept all bodies as raw text so we can sanitize before parsing
app.use(express.text({ limit: '20mb', type: ['application/json', 'text/html', 'text/*'] }));
// Serve static assets (logo, etc.) but NOT index.html at root
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

function requireAdmin(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  if (!user || !pass) return res.status(500).send('ADMIN_USER and ADMIN_PASS env vars are not set');
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Olly Admin"');
    return res.status(401).send('Unauthorized');
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  const u = decoded.slice(0, colon);
  const p = decoded.slice(colon + 1);
  if (u !== user || p !== pass) {
    res.set('WWW-Authenticate', 'Basic realm="Olly Admin"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

app.get('/', (req, res) => res.redirect(301, '/admin'));
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

function cleanJson(raw) {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let s = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

  // Handle LLM output wrapper: [{"output": "```json\n{...}\n```"}]
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (arr[0] && typeof arr[0].output === 'string') {
        s = arr[0].output.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
      }
    } catch (_) { /* fall through to parse as-is */ }
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

// Serve deployed pages dynamically (no wait for redeploy)
app.get('/complaint-report-:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    return res.status(400).send('<h1>400 — Invalid ID</h1>');
  }
  try {
    const { octokit, owner, repo } = getOctokit();
    const { data } = await octokit.repos.getContent({
      owner, repo, path: `pages/${uuid}.html`,
    });
    const html = Buffer.from(data.content, 'base64').toString('utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    if (err.status === 404) return res.status(404).send('<h1>404 — Page not found</h1>');
    console.error(err);
    res.status(500).send('<h1>500 — Server error</h1>');
  }
});

// Deploy endpoint
// - application/json body → clean markdown fences, parse JSON, render EJS template, deploy
// - text/html body → deploy raw HTML directly
app.post('/api/deploy', async (req, res) => {
  let html;

  if (req.is('application/json')) {
    if (!reportTemplate) return res.status(500).json({ error: 'EJS template not found on server' });
    let data;
    try {
      data = JSON.parse(cleanJson(String(req.body)));
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid JSON: ' + parseErr.message });
    }
    try {
      html = ejs.render(reportTemplate, { d: data });
    } catch (ejsErr) {
      return res.status(400).json({ error: 'Template render failed: ' + ejsErr.message });
    }
  } else if (typeof req.body === 'string' && req.body.trim()) {
    html = req.body;
  } else {
    return res.status(400).json({
      error: 'Send report JSON (application/json) or raw HTML (text/html)',
    });
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

    const base = baseUrl(req);
    res.status(201).json({
      uuid,
      url: `${base}/complaint-report-${uuid}`,
      status: 'deployed',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List all deployed pages
app.get('/api/pages', async (req, res) => {
  try {
    const { octokit, owner, repo } = getOctokit();
    const { data } = await octokit.repos.getContent({ owner, repo, path: 'pages' });
    const base = baseUrl(req);
    const pages = (Array.isArray(data) ? data : [])
      .filter(f => f.type === 'file' && f.name.endsWith('.html'))
      .map(f => {
        const uuid = f.name.replace('.html', '');
        return { uuid, url: `${base}/complaint-report-${uuid}`, sha: f.sha };
      });
    res.json({ count: pages.length, pages });
  } catch (err) {
    if (err.status === 404) return res.json({ count: 0, pages: [] });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a page
app.delete('/api/pages/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
    return res.status(400).json({ error: 'Invalid UUID' });
  }
  try {
    const { octokit, owner, repo } = getOctokit();
    const { data } = await octokit.repos.getContent({
      owner, repo, path: `pages/${uuid}.html`,
    });
    await octokit.repos.deleteFile({
      owner, repo,
      path: `pages/${uuid}.html`,
      message: `delete: report ${uuid}`,
      sha: data.sha,
    });
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
    console.log(`  POST /api/deploy   — deploy HTML`);
    console.log(`  GET  /p/:uuid      — view page`);
    console.log(`  GET  /api/pages    — list all`);
    console.log(`  DELETE /api/pages/:uuid — remove\n`);
  });
}

module.exports = app;
