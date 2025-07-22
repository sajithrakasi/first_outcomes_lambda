import dotenv from 'dotenv';
import Redis from 'ioredis';
import { checkPatient , validateRequestBody} from './patientSearch.mjs';

import jwt from 'jsonwebtoken';

dotenv.config();

const environment = process.env.ENVIRONMENT;
const redis_name = process.env.REDIS_NAME;
const redisName = process.env.CLIENT_REDISNAME;
const storedClientId = process.env.CLIENT_ID;
let redisClient;

function createRedisClient() {
  return environment === 'LOCAL'
    ? new Redis({ host: '127.0.0.1', port: 6379, db: 0 })
    : new Redis({
        port: 6379,
        host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
        password: 'zi8I$y#ify8fYpWu',
        tls: {},
      });
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
  console.log("Firstoutcome lambda started");

  const redisClient = createRedisClient(); 

  try {
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
      return response(400, 'Missing request body');
    }


    const tokenCheck = await verifyToken(token, redisClient); 
    if (!tokenCheck.valid) {
      return response(401, 'Unauthorized access, please call your IT support', null, '401', null, tokenCheck.error);
    }

    const redisKey = requestParams.customer_id;

    const matchResult = await validateRequestBody({
      redisClient,
      redisName: redis_name,
      redisKey,
      requestParams
    });

    if (matchResult.code !== '200') {
      return response(400, matchResult.message || 'Invalid request parameters', null, matchResult.code);
    }

    const patientSearch = {
      ...requestParams,
      redisClient,
      emr_id: matchResult.details?.emr_id,
      ...(matchResult.details?.emr_practice_id != null && {
        emr_practice_id: matchResult.details.emr_practice_id
      })
    };

    const patientResponse = await checkPatient(patientSearch);

    if (patientResponse.count === 0) {
      return response(200, patientResponse.message || 'No patient data found', [], '200', 0);
    }

    return response(200, patientResponse.message || 'Patient data retrieved successfully.', patientResponse.patientDetails, '200', patientResponse.count);

  } catch (error) {
    console.error('Handler Error:', error);
    return response(500, 'Handler failed during patient lookup.', null, '500', null, error.message);
  } finally {
    await redisClient.quit(); 
  }
}


function response(statusCode, message, data = null, code = null, count = null, details = null) {
  return {
    statusCode,
    body: JSON.stringify({
      code: code || String(statusCode),
      status: statusCode === 200 ? 'success' : 'fail',
      message,
      ...(data !== null ? { data } : {}),
      ...(count !== null ? { count } : {}),
      ...(details ? { details } : {})
    }),
  };
}

