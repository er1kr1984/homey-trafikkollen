'use strict';

// Small HTTP client on Node's https module. Global fetch (undici) costs ~30 MB of extra memory per app process;
// this costs ~10 MB. Follows redirects, has a total time limit, and returns { status, ok, text(), json(), stream }.

const https = require('https');
const http = require('http');

const MAX_REDIRECTS = 3;

function request(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const data = body == null ? null : Buffer.from(String(body));
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': 'Trafikkollen Homey app (com.erikrichardson.trafik)', ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      res.on('close', () => clearTimeout(timer));
      res.on('error', () => {}); // a timeout mid-body must not crash the app; readers see it via text()/the stream
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
        res.resume();
        resolve(request(new URL(res.headers.location, u).toString(), { method, headers, body, timeout }, redirects + 1));
        return;
      }
      let used = false;
      const text = () => new Promise((ok, no) => {
        if (used) { no(new Error('Response body already read')); return; }
        used = true;
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { out += c; });
        res.on('end', () => ok(out));
        res.on('error', no);
        res.on('aborted', () => no(new Error('Connection closed before the whole response arrived')));
      });
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: res.headers,
        stream: res,
        text,
        json: async () => JSON.parse(await text()),
      });
    });
    // a total time limit (request + whole body), like fetch with AbortSignal.timeout
    const timer = setTimeout(() => req.destroy(new Error(`Timed out after ${Math.round(timeout / 1000)} s`)), timeout);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { request };
