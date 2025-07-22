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

// for elation
let redisClient;

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
      console.log("request params: ", requestParams);
      if (!selectedGroup) {
        return { code: '404', message: 'Customer ID is not registered.' };
      }
  
      if (selectedGroup.customer_id !== requestParams.customer_id) {
        return { code: '404', message: 'Customer ID is not registered.' };
      }

      if (!requestParams.patient_id ) {
        return { code: '400', message: 'patient_id is required.' };
      }

      if (!requestParams.cancel_appointment_id ) {
        return { code: '400', message: 'cancel_appointment_id is required.' };
      }

    if(emrId == 1){
      if (!requestParams.new_slot_id ) {
        return { code: '400', message: 'new_slot_id is required.' };
      }   
      if (!requestParams.appointment_cancellation_reason) {
        return { code: '400', message: 'appointment_cancellation_reason is required.' };
      }
    }
    if(emrId === '13'){
    if (!requestParams.slot_date_time ) {
      return { code: '400', message: 'slot_date_time is required.' };
    }

    if (!requestParams.appointment_type ) {
      return { code: '400', message: 'appointment_type is required.' };
    }
  }
    
      return {
        code: '200',
        message: `Customer ID ${selectedGroup.customer_id} is registered and slots found.`,
        details: selectedGroup
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

export async function rescheduleAppointment(input) {
    try {
      const {
        emr_id,
        customer_id,
        new_slot_id,
        cancel_appointment_id,
        department_id,
        patient_id,
        emr_practice_id,
        provider_id,
        appointment_type,
        slot_date_time,
        appointment_cancellation_reason,
        ignoreschedulablepermission
      } = input;
  

      if (emr_id === '1') {
        const headers = {
          'Content-Type': 'application/x-www-form-urlencoded'
        };
  
        try {
          const reschedule = await athenaApi.PUT(
            `/appointments/${cancel_appointment_id}/reschedule`,
            {
              patientid: patient_id,
              newappointmentid: new_slot_id,
              practiceid: customer_id,
              providerid:provider_id,
              departmentid:department_id,
              reschedulereason: appointment_cancellation_reason,
              ignoreschedulablepermission:'TRUE'
            },
            headers
          );

          const resceduleResponse = reschedule[0] ? reschedule[0] : ''
          return {
            code: '200',
            status: 'success',
            message: 'Appointment rescheduled successfully via Athena.',
            data: { appointment_id: resceduleResponse?.appointmentid || null }
          };
        } catch (error) {
          const errStatus = error?.response?.status;
          if (errStatus === 404) {
            return {
              code: 404,
              status: 'failed',
              message: 'The appointment is either already canceled or checked in.',            
            };
          }
  
          return {
            code: '500',
            status: 'error',
            message: 'An error occurred while rescheduling the appointment via Athena.',
            data: error?.response?.data || error.message
          };
        }
      }

      if (emr_id === '13') {
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
  
        // Step 1: Cancel existing appointment
        const cancelResult = await elationApi.PATCH(
          `appointments/${cancel_appointment_id}/`,
          {
            patientid: patient_id,
            practiceid: customer_id,
            practice: emr_practice_id,
            status: { status: 'Cancelled' }
          }
        );
  
        if (!cancelResult || cancelResult.error) {
          return {
            code: '500',
            status: 'error',
            message: 'Elation EMR cancellation failed.',
            data: cancelResult || null
          };
        }
  
        // Step 2: Book new appointment
        const payload = {
          customer_id,
          scheduled_date: slot_date_time,
          patient: patient_id,
          service_location:parseInt(department_id, 10),
          physician: provider_id,
          reason: appointment_type,
          practice: emr_practice_id
        };
        console.log("payload",payload);
        const bookResult = await elationApi.POST('appointments/', payload);
        // console.log("bookResult",bookResult)
    
        if (!bookResult || bookResult.error) {
          return {
            code: '500',
            status: 'error',
            message: 'Elation EMR booking failed.',
            data: bookResult || null
          };
        }
  
        return {
          code: '200',
          status: 'success',
          message: 'Appointment rescheduled successfully via Elation.',
          data: { appointment_id: bookResult.id || null }
        };
      }
  
      // Fallback for unsupported EMR ID
      return {
        code: '400',
        status: 'error',
        message: 'Invalid EMR ID provided.',
        data: []
      };
  
    } catch (error) {
      console.error('Reschedule error:', error);
      const errData = error?.response?.data || error.message;
      const errStatus = error?.response?.status || 500;
  
      return {
        code: errStatus,
        status: 'error',
        message: 'Unexpected error occurred during rescheduling.',
        data: errData
      };
    }
}
  




