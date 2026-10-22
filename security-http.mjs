// Portable Node HTTP observer. Configuration contains only a public key digest;
// the per-app read key stays on the Directorate collector, never in app source.
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function blockedProbe(path) {
  let normalized = path.split(/[?#]/, 1)[0];
  for (let pass = 0; pass < 2; pass++) normalized = normalized.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  normalized = normalized.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)\.{2,}(\/|$)|\x00/.test(normalized)) return 'traversal';
  if (/(^|\/)\.(git|svn|hg)(\/|[.;]|$)/.test(normalized)) return 'git';
  if (/(^|\/)\.(env([./_;-]|$)|aws(\/|$)|ssh(\/|$)|npmrc([.;]|$)|pypirc([.;]|$)|netrc([.;]|$)|htpasswd([.;]|$)|htaccess([.;]|$))/.test(normalized)) return 'environment';
  if (/(^|\/)phpunit\/(?:phpunit\/)*src\/util\/php\/eval-stdin\.php(\/|$)|(^|\/)_(?:ignition\/execute-solution)(\/|$)|(^|\/)actuator\/(env|heapdump|configprops)(\/|$)|(^|\/)(?:etc\/(?:passwd|shadow)|proc\/self)(\/|$)/.test(normalized)) return 'exploit';
  return null;
}

export function createRequestLimiter({ rate = 200, burst = 400, maxKeys = 4096, now = () => performance.now() } = {}) {
  const clients = new Map();
  return key => {
    const time = now();
    const prior = clients.get(key);
    const available = prior ? Math.min(burst, prior.tokens + Math.max(0, time - prior.at) * rate / 1000) : burst;
    if (!prior && clients.size >= maxKeys) clients.delete(clients.keys().next().value);
    clients.set(key, { at: time, tokens: available >= 1 ? available - 1 : available });
    return available >= 1;
  };
}

export function classify(path, agent = '') {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Preserve malformed probes. */ }
  const rules = [
    ['environment', /(^|\/)(\.env([./_-]|$)|env\.(json|yaml|yml)$|\.aws\/|\.ssh\/)/i],
    ['git', /(^|\/)\.(git|svn|hg)(\/|$)/i], ['wordpress', /(^|\/)(wp-|wordpress|xmlrpc\.php)/i],
    ['php', /\.php([/.]|$)|phpmyadmin|phpunit/i], ['traversal', /\.\.\/|%2e%2e|etc\/(passwd|shadow)/i],
    ['exploit', /(^|\/)(cgi-bin|actuator|boaform|HNAP1|server-status|_ignition)(\/|$)/i],
    ['admin', /^\/(admin|administrator|manager\/html|console|login\.action|config\.(json|yaml|yml))(\/|$)/i],
  ];
  for (const [category, pattern] of rules) if (pattern.test(decoded)) return category;
  return /sqlmap|nikto|nuclei|masscan|zgrab|gobuster|dirbuster/i.test(agent) ? 'scanner_claim' : null;
}
export function installSecurityObserver({ sourceId, keyHash, bindings, fallbackTarget, digitalOcean = false }) {
  if (!/^[a-f0-9]{64}$/.test(keyHash)) throw new Error('Security observer needs a SHA-256 read-key digest');
  const boot = randomUUID(); let sequence = 0;
  const observations = [];
  const allowRequest = createRequestLimiter();
  const emit = http.Server.prototype.emit;
  function observe(request, response) {
    const requestPath = (request.url || '/').split(/[?#]/, 1)[0];
    const path = requestPath.slice(0, 512).replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted]');
    if (/^\/(?:[a-z0-9-]+\/)*__directorate_security$/.test(path)) {
      const supplied = String(request.headers.authorization || '').replace(/^Bearer /, '');
      const authorized = supplied.length <= 128 && timingSafeEqual(Buffer.from(createHash('sha256').update(supplied).digest('hex')), Buffer.from(keyHash));
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (!authorized || request.method !== 'GET') { response.statusCode = 401; response.end('{"error":"Unauthorized"}'); return true; }
      const cursor = new URL(request.url, 'http://local').searchParams.get('cursor') || '';
      const [previousBoot, previousSequence] = cursor.split(':');
      const after = previousBoot === boot ? Math.max(0, Number(previousSequence) || 0) : 0;
      const events = observations.filter(row => row.sequence > after).slice(0, 100);
      const next = events.at(-1)?.sequence ?? sequence;
      const truncated = Boolean(after && observations.length && observations[0].sequence > after + 1);
      response.end(JSON.stringify({ events: events.map(({ sequence: _sequence, ...row }) => row), cursor: `${boot}:${next}`, more: observations.some(row => row.sequence > next), restarted: Boolean(previousBoot && previousBoot !== boot), truncated }));
      return true;
    }
    const agent = String(request.headers['user-agent'] || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
    // Inspect the full path before shortening/redacting it for storage.
    const blocked = blockedProbe(requestPath);
    const category = blocked || classify(path, agent);
    // App Platform documents do-connecting-ip as the actual client address.
    // Never trust arbitrary X-Forwarded-For headers on a direct server.
    let ip = digitalOcean ? String(request.headers['do-connecting-ip'] || '') : request.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    const validIp = Boolean(isIP(ip));
    const rateLimited = !blocked && validIp && !allowRequest(ip);
    const reject = () => {
      if (!blocked && !rateLimited) return false;
      response.statusCode = blocked ? 403 : 429;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (rateLimited) response.setHeader('Retry-After', '1');
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: blocked ? 'Forbidden' : 'Too many requests' }));
      return true;
    };
    // Path rejection does not depend on a forwarded IP header being present.
    // App Platform rate limiting uses only its documented client header.
    if (!category || !validIp) return reject();
    const host = String(request.headers.host || '').split(':')[0].toLowerCase().slice(0, 253);
    const target = [...bindings].sort((a, b) => b.prefix.length - a.prefix.length)
      .find(binding => binding.hosts.includes(host) && path.startsWith(binding.prefix))?.target ?? fallbackTarget;
    const started = performance.now();
    response.once('finish', () => {
      const id = createHash('sha256').update(`${sourceId}:${boot}:${++sequence}`).digest('hex');
      observations.push({ id, sequence, time: new Date().toISOString(), ip, transport: 'http', category,
        host: host || null, target, port: digitalOcean ? null : request.socket.localPort ?? null,
        sourcePort: digitalOcean ? null : request.socket.remotePort ?? null, method: String(request.method || '').slice(0, 16), path,
        status: response.statusCode, bytes: Number(response.getHeader('content-length')) || null,
        agent: agent || null, protocol: `HTTP/${request.httpVersion}`, tls: null, cipher: null,
        duration: (performance.now() - started) / 1000, log: 'Node HTTP security observer', attribution: 'observed' });
      while (observations.length > 10_000 || (observations.length && Date.parse(observations[0].time) < Date.now() - 24 * 3_600_000)) observations.shift();
    });
    return reject();
  }
  http.Server.prototype.emit = function (name, ...args) {
    if (name === 'request' && observe(args[0], args[1])) return true;
    return Reflect.apply(emit, this, [name, ...args]);
  };
  return () => { http.Server.prototype.emit = emit; };
}
