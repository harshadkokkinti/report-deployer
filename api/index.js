const express = require('express');
const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ limit: '20mb', type: 'text/html' }));
app.use(express.static(path.join(__dirname, '../public')));

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
app.get('/p/:uuid', async (req, res) => {
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

// Deploy endpoint — accepts raw HTML (text/html) or JSON { html: "..." }
app.post('/api/deploy', async (req, res) => {
  let html;
  if (typeof req.body === 'string') {
    html = req.body;
  } else if (req.body?.html) {
    html = req.body.html;
  } else {
    return res.status(400).json({
      error: 'Send raw HTML as text/html body, or JSON { "html": "..." }',
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
      url: `${base}/p/${uuid}`,
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
        return { uuid, url: `${base}/p/${uuid}`, sha: f.sha };
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
