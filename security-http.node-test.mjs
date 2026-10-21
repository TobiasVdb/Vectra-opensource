import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { installSecurityObserver, classify } from './security-http.mjs';

test('portable request observer protects its feed, omits query secrets, and uses the documented App Platform client header', async () => {
  const key = 'test-only-observer-key';
  const restore = installSecurityObserver({ sourceId: 'test', keyHash: createHash('sha256').update(key).digest('hex'), digitalOcean: true,
    bindings: [{ hosts: ['app.example'], prefix: '/', target: 'App' }], fallbackTarget: 'App' });
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end('missing'); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/__directorate_security')).status, 401);
    await fetch(base+'/.env?password=must-not-be-stored', { headers: { Host: 'app.example', 'do-connecting-ip': '87.58.199.133', 'User-Agent': 'scanner' } });
    // An arbitrary forwarded-for value is not used as source identity.
    await fetch(base+'/.git/config', { headers: { 'x-forwarded-for': '8.8.8.8' } });
    const response = await fetch(base+'/__directorate_security', { headers: { Authorization: 'Bearer '+key } });
    const data = await response.json();
    assert.equal(data.events.length, 1); assert.equal(data.events[0].ip, '87.58.199.133');
    assert.equal(data.events[0].path, '/.env'); assert.equal(data.events[0].port, null);
    assert.equal(data.events[0].status, 404); assert.equal(data.events[0].target, 'App');
    assert.ok(!JSON.stringify(data).includes('must-not-be-stored'));
    const next = await (await fetch(base+'/__directorate_security?cursor='+encodeURIComponent(data.cursor), { headers: { Authorization: 'Bearer '+key } })).json();
    assert.equal(next.events.length, 0);
    assert.equal(classify('/.well-known/security.txt'), null);
  } finally { restore(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
