import AthenaAPIConnection from './athenaConnections.mjs';
import ElationAPIPlugin from '/opt/Plugins/elation/apiConnection.mjs';
import { fetchMasterEmrData, emrClientCreds } from '/opt/Plugins/dbPlugin/dataProcessing.mjs';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import moment from 'moment';


dotenv.config();
const environment = process.env.ENVIRONMENT;
const cms_db = process.env.DB_NAME_CMS;

const athenaConfig = {
  emrpracticeId: 1959031,
};

const athenaApi = new AthenaAPIConnection(athenaConfig.emrpracticeId);


// for elation
let redisClient;

export async function validateRequestBody({ redisClient, redisName, redisKey, requestParams }) {
  try {
    const value = await redisClient.get(redisName);
    if (!value) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    const parsedData = JSON.parse(value);
    const selectedGroup = parsedData[redisKey];

    if (!selectedGroup?.customer_id) {
      return { code: '404', message: 'Customer ID is required.' };
    }

    if (selectedGroup.customer_id !== requestParams.customer_id) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    const {
      patient_id,
      slot_id,
      department_id,
      appointment_type_id,
      slot_date_time,
      appointment_type,
      provider_id,
    } = requestParams;

    const emrId = selectedGroup.emr_id;

    // Common required field
    if (!patient_id) {
      return { code: '400', message: 'patient_id is required.' };
    }

  
    const numericFields = [
      { field: provider_id, name: 'provider_id' },
    ];

    for (const { field, name } of numericFields) {
      if (field === undefined || isNaN(Number(field))) {
        return { code: '400', message: `${name} is required and must be a number.` };
      }
    }

    if(emrId === '1'){
      if (!slot_id) {
        return { code: '400', message: 'slot_id is required.' };
      }
      if (!appointment_type_id) {
        return { code: '400', message: 'appointment_type_id is required.' };
      }
    }
    if (emrId === '13') {
      if (!slot_date_time) {
        return { code: '400', message: 'slot_date_time is required.' };
      }
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
      if (!iso8601Regex.test(slot_date_time)) {
        return {
          code: '400',
          message: 'Invalid slot_date_time format. Must be in ISO 8601 format like "2025-05-29T11:00:00Z".',
        };
      }

      if (!appointment_type || typeof appointment_type !== 'string') {
        return { code: '400', message: 'appointment_type is required and must be a string.' };
      }

    }

    return { code: '200', message: 'Validation successful.', details: selectedGroup };
  } catch (err) {
    console.error('Redis error:', err);
    return { code: '500', message: 'Redis error.', details: err.message };
  }
}


async function setTokenInRedis(emr_practice_id, tokenData) {
  const ttl = tokenData.expires_in ? tokenData.expires_in - 1 : 3599;
  await redisClient.set(`elation:tokens:${emr_practice_id}`, JSON.stringify(tokenData), 'EX', ttl);
}

export async function bookAppointment(input) {
  const { ignoreschedulablepermission,emr_id, department_id, customer_id,slot_id,patient_id,appointment_type_id,emr_practice_id,slot_date_time,provider_id,appointment_type
  } = input;

  try {
    if (emr_id === '1') {
      // Athena Booking
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded'
      };

      const bookAppt = await athenaApi.PUT(
        `/appointments/${slot_id}?`,
        {
          practiceid:customer_id,
          patientid: patient_id,
          departmentid:department_id,
          appointmenttypeid: appointment_type_id,
          ignoreschedulablepermission:'TRUE'
        },
        headers
      );
    

      return {
        code: '200',
        status: 'success',
        message: 'Appointment booked successfully via Athena.',
        data: { appointment_id: bookAppt?.[0]?.appointmentid || null }
      };

    } else if (emr_id === '13') {
      if (environment === 'LOCAL') {
        // Redis client setup for local
        redisClient = new Redis({
          host: '127.0.0.1',
          port: 6379,
          db: 0,
        });
      } else {
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
      
      
      let emr_practice_id = input.emr_practice_id;
 
      let tokens = await redisClient.get(`elation:tokens:${emr_practice_id}`);
      tokens = tokens ? JSON.parse(tokens) : null;
      const { base_url, url_version } = await fetchMasterEmrData(emr_id);
  
      const elationApi = new ElationAPIPlugin(
        base_url,
        url_version,
        emr_practice_id,
        tokens ?? {},
        setTokenInRedis, 
        emrClientCreds    
      );
      if (!tokens || !tokens.access_token) {
        await elationApi.authenticate();
      }
  
      const payload = {
        service_location:parseInt(department_id, 10),
        patient:patient_id,
        physician: provider_id,
        reason:appointment_type,
        practice: emr_practice_id,
        scheduled_date: slot_date_time
      };
      
      const result = await elationApi.POST('appointments/',payload);
      console.log('result ' , result); 
  
      return {
        code: '200',
        status: 'success',
        message: 'Appointment booked successfully via Elation.',
        data: { appointment_id: result.id || null }
      };
    }

    return {
      code: '400',
      status: 'error',
      message: 'Appointment booking failed.',
      data: []
    };

  } catch (error) {
    const errData = error?.response?.data;
    const errStatus = error?.response?.status;


    if (errStatus === 409) {
      return {
        code: 200,
        status: 'success',
        message: errData?.detailedmessage || 'That appointment time was already booked or not available for booking.',
        data: []
      };
    }

    return {
      code: 500,
      status: 'error',
      message: 'Appointment booking failed.',
      data: []
    };
  }
}

