const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const analyticsPath = path.join(root, 'analytics-data.json');
const port = Number(process.env.PORT || 4173);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function loadAnalytics() {
  try {
    return JSON.parse(fs.readFileSync(analyticsPath, 'utf8'));
  } catch {
    return {
      totalVisits: 0,
      uniqueVisitors: 0,
      visitors: {},
      byDay: {},
      recentVisits: [],
      updatedAt: null,
    };
  }
}

function saveAnalytics(data) {
  fs.writeFileSync(analyticsPath, JSON.stringify(data, null, 2));
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function localDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      body += chunk;
      if (body.length > 4096) { done = true; resolve({}); req.destroy(); }
    });
    req.on('error', () => { if (!done) { done = true; resolve({}); } });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}

async function handleVisit(req, res) {
  const body = await readBody(req);
  const data = loadAnalytics();
  const now = new Date();
  const day = localDay(now);
  let visitorId = getCookie(req, 'oww_visitor');
  const isNew = !visitorId || !data.visitors[visitorId];

  if (!visitorId) {
    visitorId = crypto.randomUUID();
  }

  data.totalVisits += 1;
  data.byDay[day] = (data.byDay[day] || 0) + 1;
  data.updatedAt = now.toISOString();

  if (isNew) {
    data.uniqueVisitors += 1;
    data.visitors[visitorId] = {
      firstSeen: now.toISOString(),
      visits: 0,
      userAgent: req.headers['user-agent'] || '',
    };
  }

  data.visitors[visitorId].lastSeen = now.toISOString();
  data.visitors[visitorId].visits += 1;

  data.recentVisits.unshift({
    at: now.toISOString(),
    path: String(body.path || '/').slice(0, 120),
    referrer: String(body.referrer || '').slice(0, 240),
  });
  data.recentVisits = data.recentVisits.slice(0, 50);
  saveAnalytics(data);

  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': `oww_visitor=${encodeURIComponent(visitorId)}; Path=/; SameSite=Lax; Max-Age=31536000`,
  });
}

function publicAnalytics() {
  const data = loadAnalytics();
  return {
    totalVisits: data.totalVisits,
    uniqueVisitors: data.uniqueVisitors,
    byDay: data.byDay,
    recentVisits: data.recentVisits,
    updatedAt: data.updatedAt,
  };
}

// Files that live in the repo but must never be served to visitors.
const PRIVATE_FILES = new Set(['analytics-data.json', 'server.js', 'package.json', 'package-lock.json']);

function serveStatic(req, res) {
  let filePath;
  try {
    const url = new URL(req.url, 'http://localhost');
    filePath = path.normalize(decodeURIComponent(url.pathname));
  } catch {
    send(res, 400, 'Bad request', {'Content-Type': 'text/plain; charset=utf-8'});
    return;
  }
  if (filePath === '/' || filePath === '.') filePath = '/index.html';
  const abs = path.join(root, filePath);
  const rel = path.relative(root, abs);
  const hidden = rel.split(path.sep).some(part => part.startsWith('.'));

  if (rel.startsWith('..') || path.isAbsolute(rel) || hidden || PRIVATE_FILES.has(rel)) {
    send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
    return;
  }

  fs.readFile(abs, (err, content) => {
    if (err) {
      send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
      return;
    }
    send(res, 200, content, {
      'Content-Type': types[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error', {'Content-Type': 'text/plain; charset=utf-8'});
    else res.end();
  }
});

async function route(req, res) {
  if (req.method === 'POST' && req.url === '/api/visit') {
    await handleVisit(req, res);
    return;
  }
  if (req.method === 'GET' && req.url === '/api/analytics') {
    sendJson(res, 200, publicAnalytics());
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  send(res, 405, 'Method not allowed', {'Content-Type': 'text/plain; charset=utf-8'});
}

server.listen(port, '0.0.0.0', () => {
  console.log(`One Wish Willow running on port ${port}`);
  console.log(`Analytics available at http://127.0.0.1:${port}/api/analytics`);
});
