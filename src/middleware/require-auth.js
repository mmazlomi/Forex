'use strict';

const { parseCookies } = require('../utils/cookies');
const sessionsRepository = require('../database/repositories/sessions-repository');
const usersRepository = require('../database/repositories/users-repository');
const { sendError } = require('../utils/http-response');

const SESSION_COOKIE_NAME = 'session_token';

/** Shared by requireAuth (must be logged in) and the /api/auth/me check (fine either way). */
function resolveUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const session = sessionsRepository.getSession(token);
  if (!session || new Date(session.expires_at_utc).getTime() < Date.now()) return null;

  const user = usersRepository.getUserById(session.user_id);
  if (!user) return null;

  return { id: user.id, username: user.username };
}

function requireAuth(req, res, next) {
  const user = resolveUserFromRequest(req);
  if (!user) return sendError(res, 'UNAUTHENTICATED', 'Login required.');
  req.user = user;
  next();
}

module.exports = { requireAuth, resolveUserFromRequest, SESSION_COOKIE_NAME };
