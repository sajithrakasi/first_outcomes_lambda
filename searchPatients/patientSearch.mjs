import db from "/opt/Plugins/dbPlugin/db-connections/db.mjs";
import CryptographyPlugin from '/opt/Plugins/CryptoPlugin/cryptoPlugin.mjs';
import AthenaAPIConnection from '/opt/Plugins/athanaPlugin/athenaConnection.mjs';
import ElationAPIPlugin from '/opt/Plugins/elation/apiConnection.mjs';
import moment from 'moment';
import { fetchMasterEmrData, emrClientCreds } from '/opt/Plugins/dbPlugin/dataProcessing.mjs';
import Redis from 'ioredis';
import dotenv from 'dotenv';


dotenv.config();
const environment = process.env.ENVIRONMENT;
const Cryptography = new CryptographyPlugin();
const emr_db = process.env.DB_NAME;

// for athena
const athenaConfig = {
  emrpracticeId: 1959031,
};

const athenaApi = new AthenaAPIConnection(athenaConfig.emrpracticeId);

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

//validate input params
export async function validateRequestBody({ redisClient, redisName, redisKey, requestParams }) {
  try {
    const value = await redisClient.get(redisName);

    if (!value) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    const parsedData = JSON.parse(value);
    const selectedGroup = parsedData[redisKey];

    if (!selectedGroup) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    if (selectedGroup.customer_id !== requestParams.customer_id) {
      return { code: '404', message: 'Customer ID is not registered.' };
    }

    if (!requestParams.phone_number && !requestParams.dob) {
      return { code: '400', message: 'Either phone number or date of birth is required.' };
    }

    if (requestParams.dob) {
      const dob = requestParams.dob;
      const dateFormat = 'YYYY-MM-DD';

      const [yearStr, monthStr, dayStr] = dob.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      const day = parseInt(dayStr, 10);

      if (isNaN(year) || year < 1000 || year > 9999) {
        return { code: '400', message: `Invalid year in DOB: "${yearStr}".` };
      }

      if (isNaN(month) || month < 1 || month > 12) {
        return { code: '400', message: `Invalid month in DOB: "${monthStr}". Must be between 01 and 12.` };
      }

      const maxDay = moment(`${year}-${month}`, 'YYYY-M').daysInMonth();
      if (isNaN(day) || day < 1 || day > maxDay) {
        return { code: '400', message: `Invalid day in DOB: "${dayStr}". Month ${month} has ${maxDay} days.` };
      }

      // Validate if the dob is a valid date
      if (!moment(dob, dateFormat, true).isValid()) {
        return { code: '400', message: 'Invalid date of birth format. Please use YYYY-MM-DD.' };
      }


    }


    const { limit, offset } = requestParams;

    if (limit !== undefined && isNaN(limit)) {
      return { code: '400', message: `Invalid limit ${limit}` };
    }

    if (offset !== undefined && isNaN(offset)) {
      return { code: '400', message: `Invalid offset ${offset}` };
    }

    if (offset !== undefined && offset == 0) {
      return { code: '400', message: `Invalid offset ${offset}` };
    }


    return {
      code: '200',
      message: `Customer ID ${selectedGroup.customer_id} is registered and patient found.`,
      details: selectedGroup
    };

  } catch (err) {
    console.error('Error connecting to Redis:', err);
    return { error: 'Redis error', details: err.message };
  }
}


//elation token
async function setTokenInRedis(emrPracticeId, tokenData) {
  const ttl = tokenData.expires_in ? tokenData.expires_in - 1 : 3599;
  await redisClient.set(`elation:tokens:${emrPracticeId}`, JSON.stringify(tokenData), 'EX', ttl);
}

async function extractPhonesByType(phones = [], phone_number) {
  const result = {};
  for (const entry of phones) {
    if (entry.deleted_date === null && entry.phone_type && entry.phone) {
      if (phone_number == entry.phone) {
        const type = entry.phone_type.toLowerCase();
        result[type] = entry.phone;
      }
    }
  }
  return result;
}

//patient check from db and emr
export async function checkPatient(patientSearch) {
  const { customer_id, phone_number, dob, first_name, last_name, emr_id, limit, offset } = patientSearch;

  const encryptedPhone = await Cryptography.encode(phone_number);
  const encryptedDob = dob ? await Cryptography.encode(dob) : null;

  const dbPatientRecords = await checkPatientExist(db, customer_id, encryptedPhone, encryptedDob, emr_id);
  let patient_response_list = [];

  // If DB records exist, decode and populate patient_response_list
  if (dbPatientRecords && dbPatientRecords.length > 0) {
    patient_response_list = await Promise.all(
      dbPatientRecords.map(async (record) => {
        const [firstname, lastname, decodedDob, phonenum, zipdtl] = await Promise.all([
          record.first_name ? Cryptography.decode(record.first_name) : null,
          record.last_name ? Cryptography.decode(record.last_name) : null,
          record.dob ? Cryptography.decode(record.dob) : null,
          record.phone ? Cryptography.decode(record.phone) : null,
          record.zip ? Cryptography.decode(record.zip) : null,
        ]);

        return {
          customer_id,
          patient_id: record.patient_id,
          first_name: firstname,
          last_name: lastname,
          dob: decodedDob,
          phone_number: phonenum,
          zip_code: zipdtl
        };
      })
    );
  }

  let filteredPatients = [...patient_response_list];

  if (dob && filteredPatients.length > 1) {
    filteredPatients = filteredPatients.filter(p => p.dob === dob);
  }

  filteredPatients = filteredPatients.filter(p => {
    return (!first_name || p.first_name?.toUpperCase() === first_name.toUpperCase()) &&
      (!last_name || p.last_name?.toUpperCase() === last_name.toUpperCase());
  });

  // If no result after DB filtering, call Athena API
  if (filteredPatients.length === 0 && emr_id === '1') {
    console.log('No DB match found, falling back to Athena API');
    let athenaResponse = null;
    let athena_error = '';

    try {
      const formattedDate = dob ? moment(dob).format('MM/DD/YYYY') : null;

      if (phone_number && !dob) {
        athenaResponse = await athenaApi.GET('/patients', { mobilephone: phone_number });
      } else if (dob && !phone_number) {
        athenaResponse = await athenaApi.GET('/patients', { dob: formattedDate });
      } else if (dob && phone_number) {
        athenaResponse = await athenaApi.GET('/patients', {
          mobilephone: phone_number,
          dob: formattedDate
        });
      }
    } catch (error) {
      athena_error = error.response?.data?.error || 'Unknown Athena API error';
      console.log(athena_error);
    }

    if (
      athena_error ||
      !athenaResponse ||
      !athenaResponse.patients
    ) {
      return {
        message: 'Patient not found.',
        count: 0,
        patientDetails: []
      };
    }

    patient_response_list = athenaResponse.patients.map((athena) => ({
      patient_id: athena.patientid || null,
      first_name: athena.firstname || null,
      last_name: athena.lastname || null,
      dob: athena.dob ? moment(athena.dob, 'MM/DD/YYYY').format('YYYY-MM-DD') : null,
      phone_number: athena.homephone || athena.mobilephone || athena.phone || null,
      zip_code: athena.zip || athena.zipcode || null
    }));

    filteredPatients = [...patient_response_list];

    if (dob && filteredPatients.length > 1) {
      filteredPatients = filteredPatients.filter(p => p.dob === dob);
    }

    filteredPatients = filteredPatients.filter(p => {
      return (!first_name || p.first_name?.toUpperCase() === first_name.toUpperCase()) &&
        (!last_name || p.last_name?.toUpperCase() === last_name.toUpperCase());
    });
    if (filteredPatients.length > 0) {
      const limit_assign = (limit ?? 200) - 1;
      const offset_assign = (offset ?? 1) - 1;
      const paginatedPatients = filteredPatients.slice(offset_assign, offset_assign + limit_assign + 1);

      return {
        message: filteredPatients.length === 1
          ? 'Matched 1 patient from Athena'
          : `Multiple ${filteredPatients.length} patients matched from Athena. Limit: ${limit_assign + 1}, Offset: ${offset_assign + 1}`,
        count: paginatedPatients.length,
        patientDetails: paginatedPatients
      };
    }
  }

  if (filteredPatients.length === 0 && emr_id === '13') {
    console.log('No DB match found, falling back to Elation API');
    let elationError = '';
    const {
      emr_practice_id: emrPracticeId,
      emr_id: elationEmrId,
      dob,
      first_name: firstName,
      last_name: lastName,
    } = patientSearch;

    if (!emrPracticeId || !elationEmrId) {
      elationError = {
        code: '400',
        status: 'error',
        message: 'Missing required parameter.',
        count: 0,
        data: []
      };
    }

    try {

      let tokens = await redisClient.get(`elation:tokens:${emrPracticeId}`);
      tokens = tokens ? JSON.parse(tokens) : null;
      const { base_url, url_version } = await fetchMasterEmrData(emr_id);

      const elationApi = new ElationAPIPlugin(
        base_url,
        url_version,
        emrPracticeId,
        tokens ?? {},
        setTokenInRedis,
        emrClientCreds
      );

      if (!tokens || !tokens.access_token) {
        await elationApi.authenticate();
      }
      if (!elationApi.token) {
        throw new Error('Elation authentication failed - token is still null.');
      }
      const queryParams = [];


      if (dob?.trim()) queryParams.push(`dob=${encodeURIComponent(dob.trim())}`);
      if (firstName?.trim()) queryParams.push(`first_name=${encodeURIComponent(firstName.trim())}`);
      if (lastName?.trim()) queryParams.push(`last_name=${encodeURIComponent(lastName.trim())}`);
      if (!queryParams.length) {
        elationError = {
          code: '400',
          status: 'error',
          message: 'Missing required parameter',
          count: 0,
          data: []
        };
      }
      else {
        const action = `patients?${queryParams.join('&')}`;
        const apiResponse = await elationApi.GET(action);
        const patientResults = apiResponse?.results ?? [];

        if (!patientResults.length) {
          elationError = {
            code: '200',
            status: 'patient not found',
            message: 'patient not found',
            count: 0,
            data: []
          };
        }
        else {
          let patientResponseList = await Promise.all(
            patientResults.map(async ({ id, first_name, last_name, dob, phones }) => {
              const phoneInfo = await extractPhonesByType(phones ?? [], phone_number);
              console.log("phone info: ", phoneInfo);
              if (phoneInfo.mobile?.length > 0) {
                return {
                  patient_id: id ?? null,
                  emr_id: elationEmrId,
                  first_name: first_name ?? null,
                  last_name: last_name ?? null,
                  dob: dob ?? null,
                  phone: phoneInfo.mobile ?? null
                };
              }
              return null;
            })
          );

          const filteredPatients = patientResponseList.filter(Boolean);

          if (filteredPatients.length > 0) {
            const limit_assign = (limit ?? 200) - 1;
            const offset_assign = (offset ?? 1) - 1;
            const paginatedPatients = filteredPatients.slice(offset_assign, offset_assign + limit_assign + 1);

            return {
              message: filteredPatients.length === 1
                ? 'Matched 1 patient from Elation'
                : `Multiple ${filteredPatients.length} patients matched from Elation. Limit: ${limit_assign + 1}, Offset: ${offset_assign + 1}`,
              count: paginatedPatients.length,
              patientDetails: paginatedPatients
            };
          }
        }
      }

      if (elationError) {
        return {
          message: 'Patient not found.',
          count: 0,
          patientDetails: []
        };
      }
    }
    catch (error) {
      const errMsg = error?.response?.data?.error || 'Unknown Elation API error';
      console.error(errMsg);
      return {
        message: 'Patient not found.',
        count: 0,
        patientDetails: []
      };
    }
  }


  const limit_assign = (limit ?? 200) - 1;
  const offset_assign = (offset ?? 1) - 1;
  const paginatedPatients = filteredPatients.slice(offset_assign, offset_assign + limit_assign + 1);


  return {
    message: filteredPatients.length === 1
      ? 'Matched 1 patient from Yosi'
      : filteredPatients.length > 1
        ? `Multiple ${filteredPatients.length} patients matched from yosi. Limit: ${limit_assign + 1}, Offset: ${offset_assign + 1}`
        : 'Patient not found.',
    count: paginatedPatients.length,
    patientDetails: paginatedPatients
  };
}

// Get patients by encrypted phone from db
async function checkPatientExist(db, customer_id, encryptedPhone, encryptedDob, emr_id) {
  try {
    let patients = [];

    //check for phone number search

    if (encryptedPhone !== undefined && encryptedPhone && encryptedPhone.trim() !== "") {
      const patients = await db(emr_db + ".emr_patient as a")
        .select("a.patient_id", "a.first_name", "a.last_name", "a.dob", "a.phone", "a.zip")
        .where({ practice_id: customer_id, phone: encryptedPhone, emr_id: emr_id, delete_flag: 'N' })
        .orderBy("a.patient_id", "asc");
      if (patients.length > 0) {
        return patients;
      }
    }

    //check for phone number not provided search and search by dob

    if (encryptedDob !== undefined && encryptedDob && encryptedDob.trim() !== "") {
      const patients = await db(emr_db + ".emr_patient as a")
        .select("a.patient_id", "a.first_name", "a.last_name", "a.dob", "a.phone", "a.zip")
        .where({ practice_id: customer_id, dob: encryptedDob, emr_id: emr_id, delete_flag: 'N' })
        .orderBy("a.patient_id", "asc");
      if (patients.length > 0) {
        return patients;
      }
    }

    return patients;

  } catch (error) {
    console.error('Error in getPatientsByPhone:', error);
    throw error;
  }
}
