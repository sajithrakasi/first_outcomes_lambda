import db from "/opt/Plugins/dbPlugin/db-connections/db.mjs";
import dotenv from 'dotenv';
dotenv.config();

const {
  CMS_DB, 
} = process.env;
export async function validateRequestBody({ redisClient, redisName = REDIS_NAME, redisKey, requestParams }) {
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
export async function getProviderTypes(providerSearchParams) {
  const {
    customer_id,
    provider_id,
    provider_name,
    limit,
    offset
  } = providerSearchParams;

  try {
    const query = db(`${CMS_DB}.master_provider as mp`)
      .select(
        'mp.provider_id',
        'mp.display_name',
        'mp.practice_id'
      )
      .where('mp.delete_flag', 'N')
      .andWhere('mp.self_scheduling_flag', 'Y');

    // Optional filters
    if (customer_id) {
      query.andWhere('mp.practice_id', customer_id);
    }

    if (provider_id) {
      query.andWhere('mp.provider_id', provider_id);
    }

    if (provider_name) {
      query.andWhere('mp.display_name', provider_name);
    }

    query.groupBy(
      'mp.provider_id',
      'mp.display_name',
      'mp.practice_id'
    );

    const result = await query;

    if (result.length === 0) {
      return {
        code: 204,
        message: 'No provider types found.',
        data: []
      };
    }

    const providerList = result.map(p => ({
      provider_id: p.provider_id,
      provider_name: p.display_name,
      customer_id: p.practice_id
    }));
    
let filteredProvider = [...providerList]
    // Pagination
    const offset_assign = Number(offset || 1) - 1;
    const limit_assign = Number(limit || 200) - 1;
    const paginatedProviders = filteredProvider.slice(offset_assign, offset_assign + limit_assign);

    return {
      code: 200,
      message:
      filteredProvider.length === 1
          ? 'Matched 1 provider.'
          : `Matched ${filteredProvider.length} providers. Limit: ${limit_assign + 1}, Offset: ${offset_assign + 1}`,
      count: paginatedProviders.length,
      data: paginatedProviders
    };

  } catch (error) {
    console.error('Error fetching provider types:', error.message);
    return {
      code: 500,
      message: 'Internal server error while fetching provider types.',
      error: error.message
    };
  }
}