const { UnauthorizedError } = require('../utils/error');

function getUserContext(req, res, next) {
  if (!req.user?.id) {
    return next(new UnauthorizedError('Authenticated user context is required'));
  }
  next();
}

module.exports = { getUserContext };
