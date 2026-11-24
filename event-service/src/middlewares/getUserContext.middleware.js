const { UnauthorizedError } = require('../utils/error');
const { assertActiveUser } = require('../services/userDirectory.service');
async function getUserContext(req, res, next) {
  if (!req.user?.id) return next(new UnauthorizedError('Authenticated user context is required'));
  try {
    await assertActiveUser(String(req.user.id));
    return next();
  } catch (error) {
    return next(error);
  }
}
module.exports = { getUserContext };
