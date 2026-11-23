const axios = require('axios');
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
    if (!cached.active) throw new ForbiddenError('The user account is not active');
    return true;
  }
  if (!config.USER_SERVICE_INTERNAL_KEY) throw new ServiceUnavailableError('User account verification is not configured');
  let response;
  try {
    response = await axios.get(config.USER_SERVICE_URL.replace(/\/$/, '') + '/user/internal/' + encodeURIComponent(userId), {
      timeout: config.USER_SERVICE_TIMEOUT_MS,
      headers: { 'x-internal-service-key': config.USER_SERVICE_INTERNAL_KEY },
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch {
    throw new ServiceUnavailableError('User account verification is temporarily unavailable');
  }
  if (response.status === 404) {
    statusCache.set(userId, { active: false, checkedAt: now });
    throw new NotFoundError('The invited user does not exist');
  }
  if (response.status < 200 || response.status >= 300 || typeof response.data?.data?.active !== 'boolean') {
    throw new ServiceUnavailableError('User account verification returned an invalid response');
  }
  const active = response.data.data.active === true;
  statusCache.set(userId, { active, checkedAt: now });
  pruneCache(now);
  if (!active) throw new ForbiddenError('The user account is suspended or inactive');
  return true;
};
const clearUserStatusCache = (userId) => statusCache.delete(userId);
module.exports = { assertActiveUser, clearUserStatusCache };
