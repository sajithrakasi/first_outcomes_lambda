import AthenaAPIConnection from '/opt/Plugins/athanaPlugin/athenaConnection.mjs';
import moment from 'moment-timezone';
import db from "/opt/Plugins/dbPlugin/db-connections/db.mjs";
import dayjs from 'dayjs';
import Redis from 'ioredis';
import ElationAPIPlugin from '/opt/Plugins/elation/apiConnection.mjs';
import {
  emrClientCreds,
  fetchMasterEmrData
} from '/opt/Plugins/dbPlugin/dataProcessing.mjs'; 

const athenaConfig = {
  emrpracticeId: 1959031,
};

const athenaApi = new AthenaAPIConnection(athenaConfig.emrpracticeId);

const dateFormat = 'YYYY-MM-DD';
const isValidDate = (dateTimeStr) => moment(dateTimeStr, dateFormat, true).isValid();
const emr_db = process.env.DB_NAME;
const cms_db = process.env.DB_NAME_CMS;
const sch_db = process.env.DB_NAME_SCH;
const environment = process.env.ENVIRONMENT; 
const elationEmrId = process.env.elationEmrId;
// for elation
let redisClient;

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

    if (!requestParams.appointment_type_id) {
      return { code: '400', message: 'appointment_type_id is required.' };
    }

    const requiresValidation = selectedGroup.emr_id === '1';

    if (requiresValidation && !requestParams.department_id) {
      return { code: '400', message: 'department_id is required.' };
    }  

    if (
      requiresValidation &&
      Array.isArray(requestParams.provider_id) &&
      !requestParams.provider_id.every(id => !isNaN(Number(id)))
      ) {
      return { code: '400', message: 'Each provider_id must be a number or numeric string.' };
     }

   
      const { start_date, end_date } = requestParams;

      if (!start_date || !isValidDate(start_date)) {
        return {
          code: '400',
          message: 'Invalid or missing start_date. Expected format: YYYY-MM-DD'
        };
      }

      if (!end_date || !isValidDate(end_date)) {
        return {
          code: '400',
          message: 'Invalid or missing end_date. Expected format: YYYY-MM-DD'
        };
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
      message: `Customer ID ${selectedGroup.customer_id} is registered and slots found.`,
      details: selectedGroup
    };

  } catch (err) {
    console.error('Error connecting to Redis:', err);
    return { error: 'Redis error', details: err.message };
  }
}

export async function fetchathenaOpenslots(appointmentslotSearchParams) {
  try {
    console.log('Fetching available appointment slots from Athena...');

    let {
      customer_id,
      department_id,
      appointment_type_id,
      provider_id,
      start_date,
      end_date,
      ignoreschedulablepermission,
      bypassscheduletimechecks,
      showfrozenslots,
      limit,
      offset,
      emr_id
    } = appointmentslotSearchParams;

    if(!provider_id) {
      provider_id ='';
    }
 
    
    // Fetch appointment slots
    const get_slots = await athenaApi.GET('/appointments/open', { showfrozenslots:'FALSE',ignoreschedulablepermission: 'TRUE',bypassscheduletimechecks:'FALSE', practiceid: customer_id ,appointmenttypeid: appointment_type_id, departmentid: department_id, providerid: provider_id,enddate: end_date, startdate: start_date});
    console.log('Total slotes :',  get_slots);
    console.log('Total open appointments:', get_slots.totalcount || 0);

    if (!get_slots?.appointments?.length) {
      return {
        code: '200',
        status: 'success',
        message: 'No available slots found for the provided criteria.',
        count: 0,
        data: []
      };
    }
     // Fetch providers
    const providers = await db(`${cms_db}.master_provider as a`)
    .select('a.provider_id', 'a.display_name', 'a.practice_id')
    .where({
      'a.practice_id': customer_id,
      'a.delete_flag': 'N'
    });


    const providerMap = {};
    for (const provider of providers) {
      providerMap[provider.provider_id] = provider.display_name;
    }

    // Fetch departments
    const departments = await db(`${emr_db}.practice as a`)
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
    const appointmentSlots = get_slots.appointments
    // .filter(slot => slot.appointmenttypeid == appointment_type_id)
    .map((slot) => ({
      provider_id: slot.providerid || null,
      name: providerMap[slot.providerid] || '',
      customer_id: customer_id,
      slot_id: slot.appointmentid || null,
      appointmenttype: slot.appointmenttype || null,
      date_time: moment(`${slot.date} ${slot.starttime} `, 'MM/DD/YYYY HH:mm:ss').format('YYYY-MM-DDTHH:mm:ss'),
      department_id: slot.departmentid,
      department_name: departmentMap[slot.departmentid] || ''
    }));

    let filteredSlots = [...appointmentSlots]
    // console.log("filteredSlots: ", filteredSlots);

    filteredSlots.sort((a, b) =>
      new Date(a.date_time) - new Date(b.date_time)
    );
  

    let offset_assign = parseInt(offset);
    offset_assign = (offset_assign == null || isNaN(offset_assign)) ? 0 : offset_assign - 1;
    let limit_assign = parseInt(limit);
    limit_assign = (limit_assign == null || isNaN(limit_assign)) ? 50 : limit_assign;
    const paginatedSlots = filteredSlots.slice(offset_assign, limit_assign);

    return {
      code:200,
      message: filteredSlots.length === 1
      ? 'Matched 1 Appointment slots' 
      : `Multiple ${get_slots.totalcount || filteredSlots.length} slots matched. Limit: ${limit_assign }, Offset: ${offset_assign + 1}`,
    count: paginatedSlots.length,
    data: paginatedSlots
    };
  

  } catch (error) {
    console.error('Error fetching or booking open appointments:', error);
    return {
      code: '500',
      status: 'error',
      message: 'An error occurred while fetching open appointment slots.',
      count: 0,
      data: []
    };
  }
}

export async function fetchElationOpenslots(appointmentslotSearchParams) {

  const {
    department_id, end_date, start_date,
    customer_id, provider_id, emr_id,
    appointment_type_id, duration, emr_practice_id, limit, offset
  } = appointmentslotSearchParams;

  try {
    const dbResults = await db(`${sch_db}.elation_provider_availabilities as a`)
      .select({
        provider_id: 'a.provider_id',
        start_time: 'a.start_time',
        end_time: 'a.end_time',
        weekday: 'a.weekday',
        department_id: 'a.service_location_id',
        duration: 'a.duration',
        elation_timezone: 'a.timezone_id',
        department_timezone: 'a.department_timezone',
        appointment_type_name: 'a.appointment_type_name'
      })
      .where({
        'a.practice_id'        : customer_id,
        'a.appointment_type_id': appointment_type_id,
        'a.service_location_id': department_id,
        'a.provider_id': provider_id,
        'a.delete_flag': 'N',
      })
      .modify(qb => {
        if (duration) qb.where('a.duration', duration);
      })
      .groupBy(
        'a.practice_id', 'a.provider_id', 'a.service_location_id',
        'a.start_time', 'a.end_time', 'a.weekday', 'a.duration'
      )
      .orderBy('a.weekday', 'asc');
    
    const elation_timezone = dbResults[0]?.elation_timezone || null;
    const department_timezone = dbResults[0]?.department_timezone || null;

    const generatedSlots = generateTimeSlots({
      dbResults,
      startDate: start_date,
      endDate: end_date,
      provider_id,
      customer_id,
      emr_id,
      appointment_type_id
    });
    
    
    const recuringeventParams = {
      physician: provider_id, time_slot_type: 'event', start_date: start_date, end_date: end_date,
    };
    let emr_practice_id = appointmentslotSearchParams.emr_practice_id;
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

    const queryParams = new URLSearchParams(recuringeventParams).toString();
   
    const response = await elationApi.GET(`recurring_event_groups/?${queryParams}`);

     const recuringParams = {
      physician: provider_id, time_slot_type: 'appointment_slot', start_date: start_date, end_date: end_date,
    };

    const recuringQueryParams = new URLSearchParams(recuringParams).toString();
    const recuringResponse = await elationApi.GET(`recurring_event_groups/?${recuringQueryParams}`);
    const recurringSlots = [
      ...(recuringResponse?.results || []),
      ...(response?.results || [])
    ];
          
    const { availableSlots } = await getNonrecurringEvents(generatedSlots, recurringSlots, appointmentslotSearchParams);   

    const providerList = await db(`${cms_db}.master_provider as a`)
    .select('a.provider_id', 'a.display_name')
    .where({ 'a.practice_id': customer_id, 'a.delete_flag': 'N' });

    const providerMap = Object.fromEntries(providerList.map(p => [p.provider_id, p.display_name]));

    // Fetch departments
    const departments = await db(`${emr_db}.practice as a`)
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

    const result = availableSlots.map(slot => {
    return {
      provider_id: slot.provider_id,
      name: providerMap[slot.provider_id] || null,
      customer_id: slot.customer_id,
      appointmenttype: slot.appointment_type_name || '',
      date_time: slot.slot_start,
      department_id: slot.service_location_id,
      department_name: departmentMap[slot.service_location_id] || ''
    };
    });
 
    let firstFilteredSlots = [...result];
    
    const eventTimeSlotParams = {
      physician: provider_id, time_slot_type: 'appointment', from_date: start_date, to_date: end_date,
    };
    
    const eventTimeSlotQueryParams = new URLSearchParams(eventTimeSlotParams).toString();
    const eventTimeSlotResponse = await elationApi.GET(`appointments/?${eventTimeSlotQueryParams}`);
    const eventTimeSlots = eventTimeSlotResponse?.results || [];

    const eventTimeSlotResult = eventTimeSlots.map(({ id, scheduled_date, duration }) => {
      const startDate = new Date(scheduled_date);
      const endDate = new Date(startDate.getTime() + duration * 60000); // Add duration in milliseconds

      return {
        id,
        scheduled_date,
        end_date: endDate.toISOString()
      };
    });

    const eventTimeSlotRanges = eventTimeSlotResult.map(({ scheduled_date, end_date }) => ({
      start: new Date(scheduled_date),
      end: new Date(end_date)
    }));

    const secondFilteredSlots = firstFilteredSlots.filter(r1 => {
      const r1Date = new Date(r1.date_time);

      const overlaps = eventTimeSlotRanges.some(r2 => {
        const start = new Date(r2.scheduled_date);
        const end = new Date(r2.end_date);
        return r1Date >= start && r1Date < end;
      });

      return !overlaps;
    });

    const appointmentTimeSlotParams = {
      physician: provider_id, time_slot_type: 'appointment_slot', from_date: start_date, to_date: end_date,
    };
    
    const appointmentTimeSlotQueryParams = new URLSearchParams(appointmentTimeSlotParams).toString();

    const appointmentTimeSlotResponse = await elationApi.GET(`appointments/?${appointmentTimeSlotQueryParams}`);
    const appointmentTimeSlots = appointmentTimeSlotResponse?.results || [];
    const appointmentTimeResult = appointmentTimeSlots.map(({ id, scheduled_date, duration }) => {
      const startDate = new Date(scheduled_date);
      const endDate = new Date(startDate.getTime() + duration * 60000); // Add duration in milliseconds

      return {
        id,
        scheduled_date,
        end_date: endDate.toISOString()
      };
    });

    const appointmentTimeSlotRanges = appointmentTimeResult.map(({ scheduled_date, end_date }) => ({
      start: new Date(scheduled_date),
      end: new Date(end_date)
    }));

    const thirdFilteredSlots = secondFilteredSlots.filter(r1 => {
      const r1Date = new Date(r1.date_time);

      const overlaps = appointmentTimeSlotRanges.some(r2 => {
        const start = new Date(r2.scheduled_date);
        const end = new Date(r2.end_date);
        return r1Date >= start && r1Date < end;
      });

      return !overlaps;
    });

    const slotParams = {
      physician: provider_id, time_slot_type: 'event', from_date: start_date, to_date: end_date,
    };
    
    const slotQueryParams = new URLSearchParams(slotParams).toString();

    const slotResponse = await elationApi.GET(`appointments/?${slotQueryParams}`);
    const timeSlots = slotResponse?.results || [];
    const timeResult = timeSlots.map(({ id, scheduled_date, duration }) => {
      const startDate = new Date(scheduled_date);
      const endDate = new Date(startDate.getTime() + duration * 60000); // Add duration in milliseconds

      return {
        id,
        scheduled_date,
        end_date: endDate.toISOString()
      };
    });

    const timeSlotRanges = timeResult.map(({ scheduled_date, end_date }) => ({
      start: new Date(scheduled_date),
      end: new Date(end_date)
    }));

    const updatedSlots = thirdFilteredSlots.filter(r2 => {
      const r2Date = new Date(r2.date_time);

      const overFlow = timeSlotRanges.some(r2 => {
        const startdate = new Date(r2.scheduled_date);
        const enddate = new Date(r2.end_date);
        return r2Date >= startdate && r2Date < enddate;
      });

      return !overFlow;
    });

     let filteredSlots = updatedSlots.map(slot => {
      const laTime = moment.tz(slot.date_time, elation_timezone);
      const utcTime=  laTime.clone().utc();  
      const ISO = utcTime.format();
      slot.date_time = ISO;

      return {
        ...slot
      };
    });

    filteredSlots.sort((a, b) =>
      new Date(a.converted_date_time) - new Date(b.converted_date_time)
    );

    const offset_assign = Number(offset || 1) - 1;
    const limit_assign = Number(limit || 50) - 1;
    const paginatedSlots = filteredSlots.slice(offset_assign, offset_assign + limit_assign);

    return {
      code:200,
      message: filteredSlots.length === 1
      ? 'Matched 1 Appointment slots' 
      : `Multiple ${filteredSlots.length} slots matched. Limit: ${limit_assign + 1}, Offset: ${offset_assign + 1}`,
    count: paginatedSlots.length,
    data: paginatedSlots
    };

  } catch (err) {
    console.error("DB Error:", err);
    return { code: "500", status: "error", message: "Internal server error." };
  }
}

function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function generateTimeSlots({ dbResults, startDate, endDate, provider_id, customer_id, emr_id, appointment_type_id }) {
  const slots = [];

  let current = dayjs(startDate);
  const end = dayjs(endDate);

  while (current.isBefore(end) || current.isSame(end)) {
    const weekday = current.day(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

    dbResults.forEach(row => {
      if (row.weekday === weekday) {
        const startMin = timeToMinutes(row.start_time);
        const endMin = timeToMinutes(row.end_time);
        const durationMin = parseInt(row.duration, 10);

        for (let min = startMin; min + durationMin <= endMin; min += durationMin) {
          const slotStart = minutesToTime(min);
          const slotEnd = minutesToTime(min + durationMin);

          slots.push({
            customer_id,
            emr_id,
            provider_id,
            appointment_type_id,
            service_location_id: row.department_id,
            appointment_type_name: row.appointment_type_name,
            elation_timezone: row.elation_timezone,
            date: current.format('YYYY-MM-DD'),
            start_time: slotStart,
            end_time: slotEnd,
            weekday,
            duration: row.duration
          });
        }
      }
    });

    current = current.add(1, 'day');
  }
  return slots;
}

const weekdayMap = {
  0: "dow_monday",
  1: "dow_tuesday",
  2: "dow_wednesday",
  3: "dow_thursday",
  4: "dow_friday",
  5: "dow_saturday",
  6: "dow_sunday",
};

const formatTime24h = (timeStr, timezone) => {
  return moment.tz(timeStr, ["hh:mm A", "HH:mm", "HH:mm:ss"], timezone).format("HH:mm");
};

export const getNonrecurringEvents = async (dbSlots, apiSlots, searchParams) => {
  const timezone = dbSlots[0]?.elation_timezone;
  const removedSlotsDebug = [];
  const startDate = moment(searchParams.start_date);
  const endDate = moment(searchParams.end_date);
  let events = [];
  for (const apiSlot of apiSlots) {
    for (const schedule of apiSlot.schedules) {
      const seriesStart = moment(schedule.series_start);
      const seriesStop = schedule.series_stop ? moment(schedule.series_stop) : endDate; // ← Use endDate for endless events

      const rangeStart = moment.max(startDate, seriesStart);
      const rangeEnd = moment.min(endDate, seriesStop);

      let current = rangeStart.clone();
      while (current.isSameOrBefore(rangeEnd, 'day')) {
        const dow = current.format('dddd').toLowerCase(); // e.g., "monday"
        const dowKey = `dow_${dow}`;

        if (schedule[dowKey]) {
          const eventStart = moment(`${current.format('YYYY-MM-DD')} ${schedule.event_time}`, "YYYY-MM-DD HH:mm:ss");
          const eventEnd = eventStart.clone().add(schedule.duration, 'minutes');

          events.push({
            description: schedule.description,
            start: eventStart.format("YYYY-MM-DDTHH:mm:ss"),
            end: eventEnd.format("YYYY-MM-DDTHH:mm:ss")
          });
        }

        current.add(1, 'day');
      }
    }
  }

  const updatedSlots = dbSlots.filter(slot => {
      const tz = slot.elation_timezone;
      const slotStart = moment.tz(`${slot.date} ${slot.start_time}`, 'YYYY-MM-DD HH:mm', tz);
      const slotEnd = moment.tz(`${slot.date} ${slot.end_time}`, 'YYYY-MM-DD HH:mm', tz);

      const hasConflict = events.some(event => {
        const eventStart = moment.tz(event.start, tz);
        const eventEnd = moment.tz(event.end, tz);
        return isOverlap(slotStart, slotEnd, eventStart, eventEnd);
      });

      return !hasConflict;
    })
    .map(slot => {
      const tz = slot.elation_timezone;
      const slotStart = moment.tz(`${slot.date} ${slot.start_time}`, 'YYYY-MM-DD HH:mm', tz);
      const slotEnd = moment.tz(`${slot.date} ${slot.end_time}`, 'YYYY-MM-DD HH:mm', tz);

      return {
        ...slot,
        slot_start: slotStart.format('YYYY-MM-DDTHH:mm:ss'),
        slot_end: slotEnd.format('YYYY-MM-DDTHH:mm:ss')
      };
    });

  return {
    availableSlots: updatedSlots,
  };
};


async function setTokenInRedis(emrPracticeId, tokenData) {
  const ttl = tokenData.expires_in ? tokenData.expires_in - 1 : 3599;
  await redisClient.set(`elation:tokens:${emrPracticeId}`, JSON.stringify(tokenData), 'EX', ttl);
}

function isOverlap(slotStart, slotEnd, eventStart, eventEnd) {
  return slotStart < eventEnd && eventStart < slotEnd;
}