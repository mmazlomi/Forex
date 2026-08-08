'use strict';

const SECRET_KEY_PATTERN = /(api[_-]?key|api[_-]?secret|secret|password|token|credential)/i;

function maskString(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

function maskValue(key, value) {
  if (typeof value === 'string' && SECRET_KEY_PATTERN.test(key)) {
    return maskString(value);
  }
  if (value && typeof value === 'object') {
    return maskObject(value);
  }
  return value;
}

function maskObject(obj) {
  if (Array.isArray(obj)) return obj.map((item) => maskValue('', item));
  if (!obj || typeof obj !== 'object') return obj;
  const masked = {};
  for (const [key, value] of Object.entries(obj)) {
    masked[key] = maskValue(key, value);
  }
  return masked;
}

/**
 * Redacts exact occurrences of known secret values (real API keys/secrets, etc.) inside
 * free-form text such as error messages, without touching unrelated content — a blind
 * "mask every long token" heuristic would also swallow reason codes, symbols, and ids,
 * which defeats the point of logging in the first place.
 */
function maskKnownSecrets(text, secretValues) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const secret of secretValues) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join(maskString(secret));
    }
  }
  return result;
}

module.exports = { maskString, maskObject, maskKnownSecrets };
