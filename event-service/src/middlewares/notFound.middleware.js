const { NotFoundError } = require('../utils/error');

module.exports = (req, res, next) => {
  next(new NotFoundError('Route not found: ' + req.method + ' ' + req.originalUrl));
};