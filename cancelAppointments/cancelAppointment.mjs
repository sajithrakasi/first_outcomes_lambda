import AthenaAPIConnection from './athenaConnection.mjs';
import ElationAPIPlugin from '/opt/Plugins/elation/apiConnection.mjs';
import { fetchMasterEmrData, emrClientCreds } from '/opt/Plugins/dbPlugin/dataProcessing.mjs';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import moment from 'moment';

dotenv.config();
const environment = process.env.ENVIRONMENT;


// Redis client setup
let redisClient;
if (environment === 'LOCAL') {
  redisClient = new Redis({ host: '127.0.0.1', port: 6379, db: 0 });
} else {
  redisClient = new Redis({
    port: 6379,
    host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
    password: 'zi8I$y#ify8fYpWu',
    tls: {},
  });
}
redisClient.on('error', (err) => console.error('Redis error:', err));

// Athena config and instance
const athenaConfig = { emrpracticeId: 1959031 };
const athenaApi = new AthenaAPIConnection(athenaConfig.emrpracticeId);

export async function validateRequestBody({ redisClient, redisName, redisKey, requestParams }) {
  try {
    const value = await redisClient.get(redisName);

    if (!value) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    const parsedData = JSON.parse(value);
    const selectedGroup = parsedData[redisKey];

    const emrId = selectedGroup.emr_id;

    if (!selectedGroup) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    if (selectedGroup.customer_id !== requestParams.customer_id) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    if (!requestParams.patient_id) {
      return { code: '400', message: 'patient_id is required.' };
    }

    if (!requestParams.appointment_id) {
        return { code: '400', message: 'appointment_id is required.' };
    }

    if(emrId === '1'){
      if (!requestParams.appointment_cancellation_reason) {
        return { code: '400', message: 'appointment_cancellation_reason is required.' };
      }
    }

    return {
      code: '200',
      message: `Customer ID ${selectedGroup.customer_id} is registered and request parameters are valid.`,
      details: selectedGroup,
    };

  } catch (err) {
    console.error('Error connecting to Redis:', err);
    return { error: 'Redis error', details: err.message };
  }
}

async function setTokenInRedis(emr_practice_id, tokenData) {
  const ttl = tokenData.expires_in ? tokenData.expires_in - 1 : 3599;
  await redisClient.set(`elation:tokens:${emr_practice_id}`, JSON.stringify(tokenData), 'EX', ttl);
}

export async function cancelAppointment(input) {
  const {
    customer_id,
    appointment_id,
    patient_id,
    emr_practice_id,
    appointment_cancellation_reason,
    emr_id,
  } = input;

  try {
    if (emr_id === '1') {
      // Athena cancel logic
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const cancelAppt = await athenaApi.PUT(
        `/appointments/${appointment_id}/cancel?patientid=${patient_id}`,
        { practiceid:customer_id,cancellationreason: appointment_cancellation_reason},
        headers
      );


      return {
        code: '200',
        status: 'success',
        message: 'Appointment cancelled successfully via Athena.',
        data: "success",
      };
    }
    else if (emr_id === '13') {
      // Elation cancel logic
      const redisKey = `elation:tokens:${emr_practice_id}`;

      const [tokenStr, emrMeta] = await Promise.all([
        redisClient.get(redisKey),
        fetchMasterEmrData(emr_id)
      ]);

      const tokens = tokenStr ? JSON.parse(tokenStr) : {};

      const elationApi = new ElationAPIPlugin(
        emrMeta?.base_url,
        emrMeta?.url_version,
        emr_practice_id,
        tokens,
        setTokenInRedis,
        emrClientCreds
      );


      const result = await elationApi.PATCH(
        `appointments/${appointment_id}/`,
        { patientid:patient_id,
          practiceid: customer_id,
          practice: emr_practice_id,
          status: { status: 'Cancelled' }
        }
      );
   
      
      if (!result || result.error) {
        return {
          code: '500',
          status: 'error',
          message: 'Elation EMR cancellation failed.',
          data: result || null
        };
      }

      return {
        code: '200',
        status: 'success',
        message: 'Appointment cancelled successfully via Elation.',
        data: "success"
      };
    }
    else {
      return {
        code: '400',
        status: 'error',
        message: 'Unable to cancel Appointment',
        data: []
      };
    }

  } catch (error) {
    const errData = error?.response?.data;
    const errStatus = error?.response?.status;

    if (errStatus === 404) {
      return {
        code: 200,
        status: 'success',
        message: errData?.detailedmessage || 'The appointment is either already canceled or checked in.',
        data: []
      };
    }
    return {
      code: '500',
      status: 'error',
      message: 'An error occurred while cancelling the appointment.',
      data: [],
    };
  }
}

