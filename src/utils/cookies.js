'use strict';

/**
 * Hand-rolled cookie parsing/serialization — the project has no `cookie-parser` dependency and
 * only ever needs to read/write a single session cookie, so a small dependency-free utility
 * fits the codebase's existing preference for minimal dependencies (see architecture.md §6 on
 * avoiding native-compiled packages) better than pulling in a library for this.
 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  });
  return cookies;
}

function serializeCookie(name, value, { maxAgeSeconds, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { parseCookies, serializeCookie };
