// The server must refuse look-alike origins (http://localhost.evil.com) and foreign Host headers (DNS rebinding).
// Needs the server running (AUTOJOB_URL, default http://localhost:8787).
import http from 'node:http';
import assert from 'node:assert/strict';
const { hostname, port } = new URL(process.env.AUTOJOB_URL || 'http://localhost:8787');
const status = (headers) => new Promise((ok, fail) => http.get({ hostname, port, path: '/api/health', headers }, (r) => (r.resume(), ok(r.statusCode))).on('error', fail));
assert.equal(await status({}), 200);
assert.equal(await status({ Origin: `http://localhost:${port}` }), 200);
assert.equal(await status({ Origin: 'http://localhost.evil.com' }), 403);
assert.equal(await status({ Origin: 'https://example.com' }), 403);
assert.equal(await status({ Host: `evil.com:${port}` }), 403);
console.log('security: ok');
