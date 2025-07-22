import dotenv from 'dotenv';
import Redis from 'ioredis';
import { validateRequestBody, getAppointmentTypes } from './appTypes.mjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const environment = process.env.ENVIRONMENT;
const redis_name = process.env.REDIS_NAME;
const redisName = process.env.CLIENT_REDISNAME;
const storedClientId = process.env.CLIENT_ID;

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

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  };
}

export async function handler(event) {
  console.log(`Firstoutcome FetchAppointmentTypes lambda started in "${environment}"`);

  const redisClient = environment === 'LOCAL'
    ? new Redis({ host: '127.0.0.1', port: 6379, db: 0 })
    : new Redis({
        port: 6379,
        host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
        password: 'zi8I$y#ify8fYpWu',
        tls: {},
      });

  redisClient.on('error', (err) => {
    console.error('Redis error:', err);
  });

  const isLocal = environment === 'LOCAL';
  const requestParams = isLocal ? event.fileData : (event.body ? JSON.parse(event.body) : null);

  let token = '';
  if (isLocal) {
    token = requestParams?.token || '';
  } else {
    const authHeader = event.headers?.['Authorization'] || '';
    token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  }

  if (!requestParams) {
    return jsonResponse(400, {
      code: '400',
      status: 'fail',
      message: 'Missing request body'
    });
  }

  const tokenCheck = await verifyToken(token, redisClient);
  if (!tokenCheck.valid) {
    return jsonResponse(401, {
      code: '401',
      status: 'fail',
      message: 'Unauthorized access, please call your IT support',
      details: tokenCheck.error,
    });
  }

  try {
    const redisKey = requestParams.customer_id;

    const matchResult = await validateRequestBody({
      redisClient,
      redisName: redis_name,
      redisKey,
      requestParams
    });

    if (matchResult.code !== '200') {
      return jsonResponse(Number(matchResult.code || 400), {
        code: matchResult.code || '400',
        status: 'fail',
        message: matchResult.message || 'Invalid request parameters'
      });
    }

    const appointmentTypeSearch = {
      ...requestParams,
      emr_id: matchResult.details?.emr_id,
      ...(matchResult.details?.practice_id != null && {
        practice_id: matchResult.details.practice_id
      })
    };

    const appointmentTypeResponse = await getAppointmentTypes(appointmentTypeSearch);
    console.log('appointmentTypeResponse', appointmentTypeResponse);

    if (appointmentTypeResponse.count === 0) {
      return jsonResponse(200, {
        code: '200',
        status: 'success',
        message: appointmentTypeResponse.message || 'No appointment types data found',
        count: 0,
        data: []
      });
    }

    return jsonResponse(200, {
      code: '200',
      status: 'success',
      message: appointmentTypeResponse.message || 'Appointment types data retrieved successfully.',
      count: appointmentTypeResponse.count,
      data: appointmentTypeResponse.data
    });

  } catch (error) {
    console.error('Handler Error:', error);
    return jsonResponse(500, {
      code: '500',
      status: 'error',
      message: 'Handler failed during Fetch appointment type lambda.',
      details: error.message ?? 'Unknown error'
    });

  } finally {
    try {
      if (redisClient && typeof redisClient.quit === 'function') {
        if (redisClient.status === 'ready' || redisClient.status === 'connecting') {
          await redisClient.quit();
          console.log('Redis connection closed cleanly.');
        } else {
          console.warn(`Redis not ready (status: ${redisClient.status}), calling disconnect().`);
          redisClient.disconnect();
        }
      }
    } catch (cleanupError) {
      console.error('Redis cleanup error:', cleanupError.message);
    }
  }
}

