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
  console.log("Refresh token request received");

  const redisClient = createRedisClient();

  try {
    const requestParams = isLocal ? event.fileData : event || null;
    const token = requestParams?.token;

    if (!token) {
      return errorResponse(400, 'Missing token in request');
    }

    const value = await redisClient.get(redisName);
    if (!value) {
      return errorResponse(404, 'Key is missing');
    }

    const parsedData = JSON.parse(value);
    const jwtData = parsedData[storedClientId];

    if (!jwtData) {
      return errorResponse(404, 'Client configuration not found');
    }

    const { jwtSecret, jwtExpiry } = jwtData;

    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      return errorResponse(401, 'Invalid or expired token', err.message);
    }

    if (decoded.clientId !== storedClientId) {
      return errorResponse(403, 'Token clientId mismatch');
    }

    const access_token = jwt.sign({ clientId: decoded.clientId }, jwtSecret, {
      expiresIn: jwtExpiry,
    });

    return {
      status: 'success',
      data: {
        access_token,
        expires_in: parseInt(jwtExpiry, 10),
      },
    };

  } catch (error) {
    console.error('Token refresh failed:', error);
    return errorResponse(500, 'Token refresh failed', error.message);
  } finally {
    await redisClient.quit();
  }
}

function errorResponse(statusCode, message, details = '') {
  return {
    code: String(statusCode),
    status: statusCode === 200 ? 'success' : 'fail',
    message,
    ...(details && { details }),
  };
}
