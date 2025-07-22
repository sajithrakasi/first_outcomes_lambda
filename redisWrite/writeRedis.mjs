import dotenv from 'dotenv';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';

dotenv.config();

const redisName = process.env.REDIS_NAME;        
const storedClientId = process.env.CLIENT_ID;   

// Function to verify JWT using secret from Redis
async function verifyToken(token, redisClient) {
  try {
    const value = await redisClient.get(redisName);
    if (!value) return { valid: false, error: 'No data found for Redis key' };

    const parsedData = JSON.parse(value);
    const jwtData = parsedData[storedClientId];
    if (!jwtData) return { valid: false, error: 'Client config not found in Redis' };

    const decoded = jwt.verify(token, jwtData.jwtSecret);
    return { valid: true, decoded };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// Lambda handler for production
export const handler = async (event) => {
  const redisClient = new Redis({
    port: 6379,
    host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
    password: 'zi8I$y#ify8fYpWu',
    tls: {},
  });

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid JSON input');
    }

    // Extract Bearer token from Authorization header
    const authHeader = event.headers?.['Authorization'] || event.headers?.['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          code: '401',
          status: 'fail',
          message: 'Missing or invalid authorization token'
        }),
      };
    }

    // Verify token using secret stored in Redis
    const tokenCheck = await verifyToken(token, redisClient);
    if (!tokenCheck.valid) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          code: '401',
          status: 'fail',
          message: 'Unauthorized access, please contact IT support',
          details: tokenCheck.error,
        }),
      };
    }

    // Save customer data to Redis under 'customergroup'
    await redisClient.set('customergroup', JSON.stringify(body));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Redis updated successfully',
        customergroup: body,
      }),
    };

  } catch (error) {
    console.error('Redis error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  } finally {
    await redisClient.quit();
  }
};
