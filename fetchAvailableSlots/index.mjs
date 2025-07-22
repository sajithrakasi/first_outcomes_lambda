import dotenv from 'dotenv';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { fetchathenaOpenslots, fetchElationOpenslots, validateRequestBody } from './appointmentSlot.mjs';



dotenv.config();

const environment = process.env.ENVIRONMENT;
const redis_name = process.env.REDIS_NAME;
const redisName = process.env.CLIENT_REDISNAME;
const storedClientId = process.env.CLIENT_ID;


function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  };
}

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

export async function handler(event) {
  console.log(`Firstoutcome FetchSlots lambda started in "${environment}"`);
  // console.log("Full event", JSON.stringify(event, null, 2))

  const redisClient = environment === 'LOCAL'
    ? new Redis({ host: '127.0.0.1', port: 6379, db: 0 })
    : new Redis({
        port: 6379,
        host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
        password: 'zi8I$y#ify8fYpWu',
        tls: {},
      });

  redisClient.on('error', (err) => console.error('Redis error:', err));

  const isLocal = environment === 'LOCAL';
  let requestParams;

  if (isLocal) {
    requestParams = event.fileData;
  } else if (event.body) {
    try {
      requestParams = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (err) {
      return jsonResponse(400, {
        code: '400',
        status: 'fail',
        message: 'Invalid JSON in request body',
        details: err.message,
      });
    }
  } else {
    // Handle raw event (e.g. direct invocation with no body wrapping)
    requestParams = event;
  }
  
  let token = '';
    if (isLocal) {
      token = requestParams?.token || '';
    } else {
      const authHeader = event.headers?.['Authorization'] || '';
      token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
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
      requestParams,
    });

    if (matchResult.code !== '200') {
      return jsonResponse(Number(matchResult.code || 400), {
        code: matchResult.code || '400',
        status: 'fail',
        message: matchResult.message || 'Invalid request parameters',
      });
    }

    const appointmentSlotSearch = {
      ...requestParams,
      emr_id: matchResult.details?.emr_id,
      ...(matchResult.details?.emr_practice_id != null && {
        emr_practice_id: matchResult.details.emr_practice_id,
      }),
    };

   const emr_id = matchResult.details?.emr_id;

    const fetchSlotFunctions = {
      '1': fetchathenaOpenslots,
      '13': fetchElationOpenslots
    };

    const fetchFunction = fetchSlotFunctions[emr_id];
    const slotResponse = fetchFunction ? await fetchFunction(appointmentSlotSearch) : undefined;

    
    console.log('slotResponse', slotResponse);

    if (slotResponse.count === 0) {
      return jsonResponse(200, {
        code: '200',
        status: 'success',
        message: slotResponse.message || 'No slot data found',
        count: 0,
        data: [],
      });
    }

    return jsonResponse(200, {
      code: '200',
      status: 'success',
      message: slotResponse.message || 'Slot data retrieved successfully.',
      count: slotResponse.count,
      data: slotResponse.data,
    });

  } catch (error) {
    console.error('Handler Error:', error);
    return jsonResponse(500, {
      code: '500',
      status: 'error',
      message: 'Handler failed during slot lookup.',
      details: error.message ?? 'Unknown error',
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
