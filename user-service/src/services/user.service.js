const { config } = require("../config");
const {redis} = require("../config/redis");
const prisma = require('../config/prisma');
const logger = require('../config/logger');



const getProfile = async(userId) =>{
     logger.info("First check user in Redis");

     const storedUser = await redis.get(`user:${userId}`);
     if(storedUser){
          logger.info("Fetched user profile from redis");
          return JSON.parse(storedUser);
     }
     logger.info("If user is not in redis, fetch user from DB");
     const userProfile = await prisma.user.findUnique({
          where: {
               id: userId
          }
     })
     
     logger.info("Exclude password field from the user");
     if (!userProfile) return null;
     const {password: _password, ...safeUser} = userProfile;
     logger.info("Store user profile in redis for future lookups");
     await redis.set(`user:${userId}`, JSON.stringify(safeUser), 'EX', config.REDIS_USER_TTL);
     return safeUser;
}

const getInternalUserStatus = async (userId) => prisma.user.findUnique({
     where: { id: userId },
     select: { id: true, status: true, emailVerified: true, firstName: true, lastName: true, email: true },
});

module.exports = {getProfile, getInternalUserStatus}