import db from "/opt/Plugins/dbPlugin/db-connections/db.mjs";
import dotenv from 'dotenv';
dotenv.config();

const {
  REDIS_NAME,
  CMS_DB,
} = process.env;


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

    return { code: '200', message: 'Validation successful.', details: group };
  } catch (err) {
    console.error('Redis error:', err);
    return { code: '500', message: 'Redis error.', details: err.message };
  }
}

export async function getAppointmentTypes(appointmentTypeParams) {
  const {
    customer_id,
    appointment_type_id,
    appointment_type_name,
    duration,
    limit,
    offset
  } = appointmentTypeParams;

  try {
    const query = db(`${CMS_DB}.master_appointment_type as mat`)
      .select(
        'mat.practice_id',
        'mat.appointment_type_name',
        'mat.duration',
        'mat.appointment_type_id'
      )
      .where('mat.delete_flag', 'N')
      .andWhere('mat.self_scheduling_flag', 'Y');

    // Dynamic filters
    if (customer_id) {
      query.andWhere('mat.practice_id', customer_id);
    }

    if (appointment_type_id) {
      query.andWhere('mat.appointment_type_id', appointment_type_id);
    }

    if (appointment_type_name) {
      query.andWhere('mat.appointment_type_name', appointment_type_name);
    }

    if (duration) {
      query.andWhere('mat.duration', duration);
    }

    query.groupBy(
      'mat.appointment_type_name',
      'mat.duration',
      'mat.practice_id',
      'mat.appointment_type_id'
    );

    const result = await query;

    if (result.length === 0) {
      return {
        code: 204,
        message: 'No appointment types found.',
        data: []
      };
    }

    // Transform results
    const appointment_type = result.map(appt => ({
      appointment_type_id: appt.appointment_type_id,
      appointment_type_name: appt.appointment_type_name,
      duration: appt.duration,
      customer_id: appt.practice_id
    }));

    let filteredAppType =[...appointment_type]

    // Pagination logic
    const offset_assign = Number(offset || 1) - 1;
    const limit_assign = Number(limit || 200) - 1;
    const paginatedAppointmentTypes = filteredAppType.slice(offset_assign, offset_assign + limit_assign);

    return {
      code: 200,
      message:
      filteredAppType.length === 1
          ? 'Matched 1 appointment type.'
          : `Matched ${filteredAppType.length} appointment types limit: ${limit_assign + 1}, offset: ${offset_assign + 1}.`,
      count: paginatedAppointmentTypes.length,
      data: paginatedAppointmentTypes
    };

  } catch (error) {
    console.error('Error fetching appointment types:', error.message);
    return {
      code: 500,
      message: 'Internal server error while fetching appointment types.',
      error: error.message
    };
  }
}
