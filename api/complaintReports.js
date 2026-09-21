// Complaint Report Deployer — auth, team management, and report lifecycle.
// Mounted at /complaint-reports in api/index.js. Talks to the shared olly-backend
// Supabase project (service-role key, server-side only) and to n8n (webhook URL
// never reaches the browser).
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const COOKIE_NAME = 'cr_session';
const COOKIE_PATH = '/complaint-reports';
const SESSION_TTL = '12h';

function buildComplaintReportsRouter() {
  const router = express.Router();

  let supabase = null;
  function getSupabase() {
    if (supabase) return supabase;
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for /complaint-reports');
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    return supabase;
  }

  function sessionSecret() {
    const secret = process.env.CR_SESSION_SECRET;
    if (!secret) throw new Error('CR_SESSION_SECRET env var is not set');
    return secret;
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  function baseUrl(req) {
    const site = process.env.SITE_URL;
    if (site) return site.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
  }

  function parseCookies(req) {
    return Object.fromEntries(
      (req.headers.cookie || '').split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k.trim(), decodeURIComponent(v.join('='))];
      }).filter(([k]) => k)
    );
  }

  // The app-level middleware in api/index.js parses application/json bodies as
  // a raw string (see express.text() there), so JSON.parse it ourselves.
  function parseJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);
    return {};
  }

  function signSession(user) {
    return jwt.sign(
      { sub: user.id, role: user.role, name: user.name, email: user.email },
      sessionSecret(),
      { expiresIn: SESSION_TTL }
    );
  }

  function setSessionCookie(res, token) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict${secure}; Max-Age=43200`);
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  function readSession(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    try {
      return jwt.verify(token, sessionSecret());
    } catch (e) {
      return null;
    }
  }

  function requireAuth(req, res, next) {
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Sign in required' });
    req.crUser = session;
    next();
  }

  function requireAdminRole(req, res, next) {
    if (req.crUser?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  }

  function publicUser(row) {
    return { id: row.id, name: row.name, email: row.email, role: row.role };
  }

  // Shared by the real n8n callback and the local dev mock below.
  async function finishReport(sb, id, { status, report_url, error }) {
    const { data: existing, error: findErr } = await sb
      .from('complaint_report_reports')
      .select('started_at')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return false;

    const finishedAt = new Date();
    const update = {
      status,
      finished_at: finishedAt.toISOString(),
      took_ms: finishedAt - new Date(existing.started_at),
    };
    if (status === 'ready') update.report_url = report_url || null;
    if (status === 'failed') update.error = error || 'The workflow stopped before it finished.';

    const { error: updateErr } = await sb.from('complaint_report_reports').update(update).eq('id', id);
    if (updateErr) throw updateErr;
    return true;
  }

  function publicReport(row) {
    return {
      id: row.id,
      place: row.place,
      image_url: row.image_url,
      by: row.requested_by_name,
      by_email: row.requested_by_email,
      started: row.started_at,
      status: row.status,
      report_url: row.report_url,
      error: row.error,
      took: row.took_ms,
    };
  }

  // ── dashboard page ───────────────────────────────────────────────────────
  const dashboardPath = path.join(__dirname, '../views/complaint-reports.html');
  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(dashboardPath);
  });

  // ── auth ─────────────────────────────────────────────────────────────────
  router.get('/api/me', (req, res) => {
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    res.json({ id: session.sub, name: session.name, email: session.email, role: session.role });
  });

  router.post('/api/login', async (req, res) => {
    let body;
    try { body = parseJsonBody(req); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    try {
      const sb = getSupabase();
      const { data: user, error } = await sb
        .from('complaint_report_users')
        .select('*')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: "That email and password don't match an account. Ask an admin to check it." });
      }
      setSessionCookie(res, signSession(user));
      res.json(publicUser(user));
    } catch (err) {
      console.error('complaint-reports login error:', err);
      res.status(500).json({ error: 'Sign-in is unavailable right now.' });
    }
  });

  router.post('/api/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ status: 'ok' });
  });

  // ── team management (admin only) ────────────────────────────────────────
  router.get('/api/team', requireAuth, requireAdminRole, async (req, res) => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('complaint_report_users')
        .select('id, name, email, role, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;
      res.json({ users: data });
    } catch (err) {
      console.error('complaint-reports team list error:', err);
      res.status(500).json({ error: 'Could not load the team.' });
    }
  });

  router.post('/api/team', requireAuth, requireAdminRole, async (req, res) => {
    let body;
    try { body = parseJsonBody(req); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'member';

    if (!name) return res.status(400).json({ error: 'Add a name so the team knows who ran a report.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That doesn't look like a valid email address." });
    if (password.length < 6) return res.status(400).json({ error: 'Passwords need at least 6 characters.' });

    try {
      const sb = getSupabase();
      const password_hash = await bcrypt.hash(password, 10);
      const { data, error } = await sb
        .from('complaint_report_users')
        .insert({ name, email, password_hash, role })
        .select('id, name, email, role, created_at')
        .single();
      if (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'Someone already uses that email.' });
        throw error;
      }
      res.status(201).json(data);
    } catch (err) {
      console.error('complaint-reports add member error:', err);
      res.status(500).json({ error: 'Could not add that team member.' });
    }
  });

  // Passwords are bcrypt-hashed and one-way — there is no "show the current
  // password" endpoint by design. This lets an admin set a new one instead,
  // which the client shows back once so it can be shared with that person.
  router.put('/api/team/:id/password', requireAuth, requireAdminRole, async (req, res) => {
    let body;
    try { body = parseJsonBody(req); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const password = String(body.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Passwords need at least 6 characters.' });

    try {
      const sb = getSupabase();
      const password_hash = await bcrypt.hash(password, 10);
      const { data, error } = await sb
        .from('complaint_report_users')
        .update({ password_hash })
        .eq('id', req.params.id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Team member not found.' });
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('complaint-reports reset password error:', err);
      res.status(500).json({ error: 'Could not update that password.' });
    }
  });

  router.delete('/api/team/:id', requireAuth, requireAdminRole, async (req, res) => {
    if (req.params.id === req.crUser.sub) {
      return res.status(400).json({ error: "You can't remove your own account." });
    }
    try {
      const sb = getSupabase();
      const { error } = await sb.from('complaint_report_users').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ status: 'deleted' });
    } catch (err) {
      console.error('complaint-reports remove member error:', err);
      res.status(500).json({ error: 'Could not remove that team member.' });
    }
  });

  // ── reports ──────────────────────────────────────────────────────────────
  // Admins see the whole team's history; members see only reports they requested.
  router.get('/api/reports', requireAuth, async (req, res) => {
    try {
      const sb = getSupabase();
      let query = sb.from('complaint_report_reports').select('*').order('started_at', { ascending: false }).limit(200);
      if (req.crUser.role !== 'admin') query = query.eq('requested_by_id', req.crUser.sub);
      const { data, error } = await query;
      if (error) throw error;
      res.json({ reports: data.map(publicReport) });
    } catch (err) {
      console.error('complaint-reports list error:', err);
      res.status(500).json({ error: 'Could not load reports.' });
    }
  });

  router.get('/api/reports/:id', requireAuth, async (req, res) => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('complaint_report_reports')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Report not found' });
      if (req.crUser.role !== 'admin' && data.requested_by_id !== req.crUser.sub) {
        return res.status(404).json({ error: 'Report not found' });
      }
      res.json(publicReport(data));
    } catch (err) {
      console.error('complaint-reports status error:', err);
      res.status(500).json({ error: 'Could not check that report.' });
    }
  });

  router.post('/api/reports', requireAuth, async (req, res) => {
    let body;
    try { body = parseJsonBody(req); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const title = String(body.title || '').trim();
    const address = String(body.address || '').trim();
    const image_url = String(body.image_url || '').trim();

    if (!title) return res.status(400).json({ error: 'A place title is required.' });
    if (!address) return res.status(400).json({ error: 'A place address is required.' });
    if (image_url && !/^https?:\/\//i.test(image_url)) {
      return res.status(400).json({ error: 'That image link needs to start with http:// or https://' });
    }

    const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
    const row = {
      id: jobId,
      place: { title, address },
      image_url,
      requested_by_id: req.crUser.sub,
      requested_by_name: req.crUser.name,
      requested_by_email: req.crUser.email,
      status: 'running',
    };

    try {
      const sb = getSupabase();
      const { error: insertErr } = await sb.from('complaint_report_reports').insert(row);
      if (insertErr) throw insertErr;
    } catch (err) {
      console.error('complaint-reports create error:', err);
      return res.status(500).json({ error: 'Could not start the report.' });
    }

    res.status(202).json({ job_id: jobId });

    // Fire the n8n workflow after responding — CONFIG.N8N_WEBHOOK_URL never reaches the browser.
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      // Local/dev convenience: with no webhook configured, auto-complete after
      // ~8s with a sample link so the whole flow is testable without n8n.
      console.warn('N8N_WEBHOOK_URL is not set — simulating completion for', jobId, 'in ~8s.');
      setTimeout(async () => {
        try {
          const sb = getSupabase();
          await finishReport(sb, jobId, {
            status: 'ready',
            report_url: `${baseUrl(req)}/complaint-report-92c368e1-186e-46fb-81be-37ee6ae1a1e8`,
          });
        } catch (err) {
          console.error('complaint-reports mock completion error:', err);
        }
      }, 8000);
      return;
    }
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          requested_by: { name: req.crUser.name, email: req.crUser.email },
          // Field names match what the existing n8n workflow already expects,
          // so no mapping/Set node is needed on the n8n side.
          'Maps title': title,
          'Maps address': address,
          'image_url': image_url,
          requested_at: new Date().toISOString(),
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`n8n replied with ${resp.status}${text ? ': ' + text.slice(0, 300) : ''}`);
      }
    } catch (err) {
      console.error('complaint-reports n8n dispatch error:', err);
      try {
        const sb = getSupabase();
        await sb.from('complaint_report_reports').update({
          status: 'failed',
          error: "Couldn't reach the report workflow. Try again.",
          finished_at: new Date().toISOString(),
        }).eq('id', jobId);
      } catch (updateErr) {
        console.error('complaint-reports failed to record dispatch failure:', updateErr);
      }
    }
  });

  // n8n calls this when a report finishes — guarded by a shared secret, not the session cookie.
  router.post('/api/reports/:id/callback', async (req, res) => {
    const expected = process.env.N8N_CALLBACK_SECRET;
    if (!expected || req.headers['x-callback-secret'] !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    let body;
    try { body = parseJsonBody(req); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    const status = body.status === 'ready' ? 'ready' : body.status === 'failed' ? 'failed' : null;
    if (!status) return res.status(400).json({ error: 'status must be "ready" or "failed"' });

    try {
      const sb = getSupabase();
      const ok = await finishReport(sb, req.params.id, { status, report_url: body.report_url, error: body.error });
      if (!ok) return res.status(404).json({ error: 'Report not found' });
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('complaint-reports callback error:', err);
      res.status(500).json({ error: 'Could not record the callback.' });
    }
  });

  return router;
}

module.exports = { buildComplaintReportsRouter };
