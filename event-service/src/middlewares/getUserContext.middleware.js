const { UnauthorizedError } = require('../utils/error');

function getUserContext(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return next(new UnauthorizedError('User context missing - request must pass through the API Gateway'));
  }
  req.user = { id: userId.toString() };
  next();
}

module.exports = { getUserContext };