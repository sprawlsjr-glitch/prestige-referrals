'use strict';
const routes = [];

function on(method, pattern, handler, guard) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, guard });
}

const get = (p, h, g) => on('GET', p, h, g);
const post = (p, h, g) => on('POST', p, h, g);

function match(method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.rx.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

module.exports = { on, get, post, match, routes };
