const { config } = require('../config');
const { ForbiddenError, NotFoundError, ServiceUnavailableError } = require('../utils/error');

const statusCache = new Map();

const pruneCache = (now) => {
  if (statusCache.size <= 10000) return;
  for (const [userId, entry] of statusCache) {
    if (now - entry.checkedAt > config.USER_STATUS_CACHE_TTL_MS) statusCache.delete(userId);
    if (statusCache.size <= 8000) break;
  }
};

const assertActiveUser = async (userId) => {
  if (typeof userId !== 'string' || !userId.trim()) throw new ForbiddenError('A valid user identity is required');

  const now = Date.now();
  const cached = statusCache.get(userId);
  if (cached && now - cached.checkedAt < config.USER_STATUS_CACHE_TTL_MS) {
    if (!cached.active) {
      if (cached.reason === 'NOT_FOUND') throw new NotFoundError('The invited user does not exist');
      throw new ForbiddenError('The user account is not active');
    }
    return true;
  }

  if (!config.USER_SERVICE_INTERNAL_KEY) throw new ServiceUnavailableError('User account verification is not configured');

  let response;
  try {
    response = await fetch(
      config.USER_SERVICE_URL.replace(/\/$/, '') + '/user/internal/' + encodeURIComponent(userId),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-service-key': config.USER_SERVICE_INTERNAL_KEY,
        },
        signal: AbortSignal.timeout(config.USER_SERVICE_TIMEOUT_MS),
        redirect: 'error',
      }
    );
  } catch {
    throw new ServiceUnavailableError('User account verification is temporarily unavailable');
  }

  if (response.status === 404) {
    statusCache.set(userId, { active: false, reason: 'NOT_FOUND', checkedAt: now });
    pruneCache(now);
    throw new NotFoundError('The invited user does not exist');
  }

  if (!response.ok) throw new ServiceUnavailableError('User account verification returned an unsuccessful response');

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ServiceUnavailableError('User account verification returned an invalid response');
  }
  if (typeof payload?.data?.active !== 'boolean' || payload.data.id !== userId) {
    throw new ServiceUnavailableError('User account verification returned an invalid identity response');
  }

  const active = payload.data.active === true;
  statusCache.set(userId, { active, reason: active ? null : 'INACTIVE', checkedAt: now });
  pruneCache(now);
  if (!active) throw new ForbiddenError('The user account is suspended or inactive');
  return true;
};

const clearUserStatusCache = (userId) => statusCache.delete(userId);
const clearAllUserStatusCache = () => statusCache.clear();

module.exports = { assertActiveUser, clearUserStatusCache, clearAllUserStatusCache };
