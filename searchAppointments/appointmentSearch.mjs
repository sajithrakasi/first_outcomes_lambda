import db from "../../../opt/Plugins/dbPlugin/db-connections/db.mjs";
import dotenv from 'dotenv';
import moment from 'moment';

dotenv.config();

const {
  REDIS_NAME,
  DB_NAME,
  DAYS_TO_ADD = '0',
  cms_db
} = process.env;

const daysToAdd = Number(DAYS_TO_ADD);

export async function validateRequestBody({ redisClient, redisName, redisKey, requestParams }) {
  try {
    const raw = await redisClient.get(redisName);
    if (!raw) {
      return { code: '404', message: 'Customer ID not registered.' };
    }

    const data = JSON.parse(raw);
    const group = data[redisKey];
    if (!group || group.customer_id !== requestParams.customer_id) {
      return { code: '404', message: 'Customer ID not registered.' };
    }

    const { patient_id, limit, offset } = requestParams;
    if (!patient_id) {
      return { code: '400', message: 'Patient ID is required.' };
    }

    if (limit !== undefined && isNaN(limit)) {
      return { code: '400', message: `Invalid limit ${limit}` };
    }

    if (offset !== undefined && isNaN(offset)) {
      return { code: '400', message: `Invalid offset ${offset}` };
    }

    if (offset !== undefined && offset == 0) {
      return { code: '400', message: `Invalid offset ${offset}` };
    }

    return { code: '200', message: 'Validation successful.', details: group };
  } catch (err) {
    console.error('Redis error:', err);
    return { code: '500', message: 'Redis error.', details: err.message };
  }
}

export async function fetchAppointments(appointmentSearch) {
  try {
    const { customer_id, patient_id, emr_id, limit, offset } = appointmentSearch; 
    const startDate = moment().startOf('day').format('YYYY-MM-DD');
    const endDate = moment().add(daysToAdd, 'days').endOf('day').format('YYYY-MM-DD');
    const appointments = await db(`${DB_NAME}.emr_appointment`)
    .select([
      'appointment_id', 'patient_id', 'appointment_date', 'appointment_time',
      'appointment_status', 'appointment_type_id', 'appointment_type',
      'provider_id', 'provider_first_name', 'telehealth_link', 'emr_id','appointment_duration'
    ])
    .where({
      practice_id: customer_id,
      patient_id: patient_id,
      emr_id: emr_id,
      delete_flag: 'N'
    })
    .whereBetween('appointment_date', [startDate, endDate])
    .orderBy('appointment_date', 'asc')
    .limit(100); 

    if (!appointments || !appointments.length) {
      return {
        code: '200', status: 'success', message: 'No appointments found.',
        count: 0, data: []
      };
    }

    const providerList = await db(`${cms_db}.master_provider as a`)
    .select('a.provider_id', 'a.display_name')
    .where({ 'a.practice_id': customer_id, 'a.delete_flag': 'N' });
    const providerMap = Object.fromEntries(providerList.map(p => [p.provider_id, p.display_name]));
    console.log("provider map: ", providerMap);
    const departments = await db(`${DB_NAME}.practice as a`)
    .select('a.emr_department_id', 'a.emr_department_name')
    .where({
      'a.emr_id': emr_id,
      'a.practice_id': customer_id,
      'a.delete_flag': 'N',
      'a.active_status': 'Y'
    });
    const departmentMap = {};
    for (const dept of departments) {
      departmentMap[dept.emr_department_id] = dept.emr_department_name;
    }
    
    const onlyDepartmentName = Object.values(departmentMap)[0]; 
    const onlyDepartmentID = Object.keys(departmentMap)[0];

    const appointment_data = appointments.map(appt => ({
      appointment_id: appt.appointment_id,
      patient_id: appt.patient_id,
      appointment_date: appt.appointment_date?.toISOString().split('T')[0], // Date only, removes time,
      appointment_time: appt.appointment_time,
      appointment_duration:appt.appointment_duration,
      status: appt.appointment_status,
      appointment_type_id: appt.appointment_type_id,
      appointment_type_name: appt.appointment_type,
      provider_id: appt.provider_id,
      provider_name: providerMap[appt.provider_id] || null,
      is_telehealth: Boolean(appt.telehealth_link),
      telehealth_link: appt.telehealth_link,
      department_id: onlyDepartmentID || '',
      department_name: onlyDepartmentName || '',
      customer_id: customer_id
    }));

    let filteredAppointments = [...appointment_data];

  const offset_assign = Number(offset || 1) - 1;
  const limit_assign = Number(limit || 200) - 1;
  const paginatedAppointments = filteredAppointments.slice(offset_assign, offset_assign + limit_assign );

 
  return {
    message : filteredAppointments.length === 1
    ? 'Matched 1 Appointments'
    : `Matched ${filteredAppointments.length} Appointments. Limit: ${limit_assign + 1}, Offset: ${offset_assign + 1}`,
    count: paginatedAppointments.length,
    appointmentDetails: paginatedAppointments
  }

    
  } catch (err) {
    console.error('Fetch error:', err);
    return { code: '500', status: 'error', message: 'Error fetching appointments.', count: 0, data: [] };
  }
}
