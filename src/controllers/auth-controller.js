'use strict';

const usersRepository = require('../database/repositories/users-repository');
const sessionsRepository = require('../database/repositories/sessions-repository');
const assetsRepository = require('../database/repositories/assets-repository');
const { hashPassword, verifyPassword } = require('../services/auth/password');
const { generateSessionToken, SESSION_TTL_MS } = require('../services/auth/session');
const { resolveUserFromRequest, SESSION_COOKIE_NAME } = require('../middleware/require-auth');
const { serializeCookie, parseCookies } = require('../utils/cookies');
const { sendSuccess, sendError } = require('../utils/http-response');
const logger = require('../services/logging/logger');

const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, token, { maxAgeSeconds: SESSION_TTL_MS / 1000, secure: isSecureRequest(req) })
  );
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, '', { maxAgeSeconds: 0, secure: isSecureRequest(req) }));
}

function startSession(req, res, user) {
  const token = generateSessionToken();
  const expiresAtUtc = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  sessionsRepository.createSession(token, user.id, expiresAtUtc);
  setSessionCookie(req, res, token);
}

async function signup(req, res) {
  const { username: rawUsername, password } = req.body || {};
  const username = String(rawUsername || '').trim().toLowerCase();

  if (!USERNAME_PATTERN.test(username)) {
    return sendError(res, 'VALIDATION_ERROR', 'Username must be 3-32 characters: lowercase letters, numbers, "_" or "-" only.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return sendError(res, 'VALIDATION_ERROR', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (usersRepository.getUserByUsername(username)) {
    return sendError(res, 'USERNAME_TAKEN', `Username "${username}" is already taken.`);
  }

  // Whoever creates the very first account inherits any watchlist entries that existed before
  // this feature shipped (see assets-repository.js#claimOrphanedAssets and schema.js's
  // migrateAssetsUserId) — otherwise pre-existing watchlist data would become permanently
  // invisible to everyone the moment accounts were introduced.
  const isFirstAccount = usersRepository.countUsers() === 0;

  const user = usersRepository.createUser(username, hashPassword(password));
  if (isFirstAccount) assetsRepository.claimOrphanedAssets(user.id);

  startSession(req, res, user);
  logger.info('auth', `New account created: ${username}${isFirstAccount ? ' (first account — claimed pre-existing watchlist)' : ''}`);
  sendSuccess(res, { id: user.id, username: user.username }, 'Account created.', 201);
}

async function login(req, res) {
  const { username: rawUsername, password } = req.body || {};
  const username = String(rawUsername || '').trim().toLowerCase();

  // Same generic error for "no such user" and "wrong password" — never reveal which one it was
  // (avoids username enumeration).
  const genericFailure = () => sendError(res, 'INVALID_CREDENTIALS', 'Incorrect username or password.');

  if (!username || typeof password !== 'string') return genericFailure();

  const user = usersRepository.getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) return genericFailure();

  startSession(req, res, user);
  logger.info('auth', `Login: ${username}`);
  sendSuccess(res, { id: user.id, username: user.username }, 'Logged in.');
}

async function logout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) sessionsRepository.deleteSession(token);
  clearSessionCookie(req, res);
  sendSuccess(res, null, 'Logged out.');
}

async function me(req, res) {
  const user = resolveUserFromRequest(req);
  sendSuccess(res, user ? { authenticated: true, id: user.id, username: user.username } : { authenticated: false });
}

module.exports = { signup, login, logout, me };
