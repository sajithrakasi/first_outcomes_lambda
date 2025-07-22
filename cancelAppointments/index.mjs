import dotenv from 'dotenv';
import Redis from 'ioredis';
import {cancelAppointment , validateRequestBody} from './cancelAppointment.mjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const environment = process.env.ENVIRONMENT;
const redis_name = process.env.REDIS_NAME;
const redisName = process.env.CLIENT_REDISNAME;
const storedClientId = process.env.CLIENT_ID;
let redisClient;


async function verifyToken(token) {
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
  console.log("Firstoutcome lambda started");
  if (environment === 'LOCAL'){
    // Redis client setup for local
    redisClient = new Redis({
      host: '127.0.0.1',
      port: 6379,
       db: 0,
     });  
  }else{
    redisClient = new Redis({
      port: 6379,
      host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
      password: 'zi8I$y#ify8fYpWu',
      tls: {},
    });
  };
  
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
    return {
      statusCode: 400,
      body: JSON.stringify({
        code: '400',
        status: 'fail',
        message: 'Missing request body'
      })
    };
  }

 const tokenCheck = await verifyToken(token);
  if (!tokenCheck.valid) {
    return {
      statusCode: 401,
      body: JSON.stringify({
        code: '401',
        status: 'fail',
        message: 'Unauthorized access, please call your IT support',
        details: tokenCheck.error,
      }),
    };
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
      await redisClient.quit();
      return {
        statusCode: 400,
        body: JSON.stringify({
          code: matchResult.code || '400',
          status: 'fail',
          message: matchResult.message || 'Invalid request parameters'
        })
      };
    }

    const input = {
      ...requestParams,
      redisClient:redisClient,
      emr_id: matchResult.details?.emr_id,
      ...(matchResult.details?.emr_practice_id != null && {
        emr_practice_id: matchResult.details.emr_practice_id
      })
    };

    const cancelResponse = await cancelAppointment(input);
    await redisClient.quit();

    if (cancelResponse.count === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          code: '200',
          status: 'success',
          message: cancelResponse.message || 'No patient data found',
          count: 0,
          data: []
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        code: '200',
        status: 'success',
        message: cancelResponse.message || 'Appointment cancelled successfully',
        data: cancelResponse.data
      })
    };

  } catch (error) {
    await redisClient.quit();
    console.error('Handler Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        code: '500',
        status: 'error',
        message: 'Handler failed during patient lookup.',
        details: error.message ?? 'Unknown error'
      })
    };
  }
}

