require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { config } = require('./config');
const logger = require('./config/logger');

const authRoutes = require('./routes/auth.route');
const userRoutes = require('./routes/user.route');

const { corsMiddleware } = require('./middlewares/cors.middleware');
const errorHandler = require('./middlewares/error.middleware');
const { reqLogger } = require('./middlewares/req.middleware');
const { disconnectProducer } = require('./config/kafka');
const { doubleCsrfProtection } = require('./middlewares/csrf.middleware');

// Inline double-submit check makes the cookie/header contract explicit at the
// service boundary. The csrf-csrf middleware below also verifies the token HMAC
// and binds it to the Gateway-issued browser session cookie.
function validateUserServiceCsrfCookie(req, res, next) {
     const authorization = req.headers.authorization;
     const isBearerRequest = typeof authorization === 'string' && /^Bearer\\s+\\S+$/i.test(authorization);
     if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isBearerRequest) return next();

     const csrfCookie =
          (req.cookies && req.cookies['x-csrf-token']) ||
          (req.cookies && req.cookies['__Host-psifi.x-csrf-token']);
     const csrfHeader = req.headers['x-csrf-token'];
     req.csrfHeaderMatchesCookie = csrfCookie === csrfHeader;

     if (typeof csrfCookie !== 'string' || typeof csrfHeader !== 'string' || !req.csrfHeaderMatchesCookie) {
          const error = new Error('Invalid CSRF token');
          error.statusCode = 403;
          error.code = 'EBADCSRFTOKEN';
          return next(error);
     }
     return next();
}

const app = express();

app.use(corsMiddleware);
app.use(helmet({
     crossOriginOpenerPolicy: false,
     crossOriginEmbedderPolicy: false,
}));
app.use(reqLogger);
app.use(express.json());
app.use(cookieParser());
app.use(validateUserServiceCsrfCookie);
app.use(doubleCsrfProtection);
app.use("/auth", authRoutes);
app.use("/user", userRoutes);

app.get("/", (req, res) => {
     res.send("Hello from index.js of user-service");
})

app.get("/health", (req, res) => {
     res.status(200).json({
          message: "ok"
     })
})

app.use(errorHandler)

const startServer = async () => {
     try {
          const server = app.listen(config.PORT, () => {
               logger.info(
                    `${config.SERVICE_NAME} is running on http://localhost:${config.PORT}`
               );
          })
          // Graceful shutdown
          const shutdown = async () => {
               logger.info('Shutting down gracefully...');

               server.close(async () => {
                    await disconnectProducer();
                    logger.info('Server closed');
                    process.exit(0);
               });
          };

          process.on('SIGTERM', shutdown);
          process.on('SIGINT', shutdown);
     } catch (error) {
          logger.error("Failed to Start Server", error);
          process.exit(1);
     }
}
if (require.main === module) startServer();
module.exports = { app, startServer, validateUserServiceCsrfCookie };