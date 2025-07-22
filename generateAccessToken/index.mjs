import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';

dotenv.config();

const storedClientId = process.env.CLIENT_ID;
const redisName = process.env.CLIENT_REDISNAME;
const isLocal = process.env.ENVIRONMENT === 'LOCAL';

function createRedisClient() {
  return isLocal
    ? new Redis({ host: '127.0.0.1', port: 6379, db: 0 })
    : new Redis({
        port: 6379,
        host: 'master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com',
        password: 'zi8I$y#ify8fYpWu',
        tls: {},
      });
}

export async function handler(event) {
  console.log("Token generation request received");

  const redisClient = createRedisClient();

  try {
    const requestParams = isLocal ? event.fileData : event || null;

    console.log('redisname:', redisName);

    if (!requestParams?.clientId || !requestParams?.secret) {
      return errorResponse(400, 'Missing clientId or secret');
    }

    const { clientId, secret } = requestParams;

    const value = await redisClient.get(redisName);
    if (!value) {
      return errorResponse(404, 'No data found for redis key');
    }

    const parsedData = JSON.parse(value);
    const jwtData = parsedData[storedClientId];

    if (!jwtData) {
      return errorResponse(404, 'Client configuration not found in Redis');
    }

    const { jwtSecret, jwtExpiry, clientSecret: storedClientSecret } = jwtData;

    if (clientId !== storedClientId || secret !== storedClientSecret) {
      return errorResponse(401, 'Invalid credentials');
    }

    const access_token = jwt.sign({ clientId }, jwtSecret, { expiresIn: jwtExpiry });

    return {
      status: 'success',
      data: {
        access_token,
        expires_in: parseInt(jwtExpiry, 10),
      },
    };

  } catch (error) {
    console.error("Token generation failed:", error);
    return errorResponse(500, 'Token generation failed', error.message);
  } finally {
    await redisClient.quit();
  }
}

function errorResponse(statusCode, message, details = '') {
  return {
    code: String(statusCode),
    status: 'fail',
    message,
    ...(details && { details }),
  };
}
