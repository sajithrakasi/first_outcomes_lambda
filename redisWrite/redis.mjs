import Redis from 'ioredis';

// Lambda handler function
export const handler = async (event) => {
    // Redis keys to retrieve

    // Creating Redis client
    const redisClient = new Redis({
        port: 6379,
        host: "master.yosi-preprod-redis-server.iszdkc.usw2.cache.amazonaws.com",
        password: 'zi8I$y#ify8fYpWu',
        tls: {},
    });

    let retrievalResults = {};

    try {
          await redisClient.set('customergroup', JSON.stringify(
        
            { 
                "101101": {customer_id:"101101", emr_id:"1", practice_id:"101101"},
                "646901": {customer_id:"646901", emr_id:"1", practice_id:"646901"}, //preprod
                "566601": {customer_id:"566601", emr_id:"13", practice_id:"566601", emr_practice_id: "140739005579268", department_id: "143091854475511", timezone_id: "America/Los_Angeles"},
                "577701": {customer_id:"577701", emr_id:"1", practice_id:"577701"},
                "226602": {customer_id:"226602", emr_id:"1", practice_id:"226602"},
                "777201": {customer_id:"777201", emr_id:"1", practice_id:"777201"},
                "101100": {customer_id:"101100", emr_id:"1", practice_id:"996001"},
                "145501": {customer_id:"145501", emr_id:"13", practice_id:"145501", emr_practice_id: "140739005579268"} ,
                "755501": {customer_id:"755501", emr_id:"13", practice_id:"755501", emr_practice_id: "140739005579268" },
                "588801": {customer_id:"588801", emr_id:"1", practice_id:"588801"},
                "599901": {customer_id:"599901", emr_id:"1", practice_id:"599901"},
                "899901": {customer_id:"899901", emr_id:"13", practice_id:"899901", emr_practice_id: "140739005579268"}, 
                "552201": {customer_id:"552201", emr_id:"13", practice_id:"552201", emr_practice_id: "140739005579268"}, //262300
                "262300": {customer_id:"262300", emr_id:"1", practice_id:"262300"}, //262300

            }
        ));

        retrievalResults = await redisClient.get('customergroup');

        const rediskey = { 
        "yosi_ex_0001": {
            "clientSecret": "Xy9$%vW78!qEr2L",
            "jwtSecret": "Xz8!gF$12@qW%7T@$$%1123gfg",
            "jwtExpiry": "10d"
        }
        }
        await redisClient.set('clientgroup', JSON.stringify(rediskey));

            // Get the value of the key from Redis
            const clientgroupvalue = await redisClient.get('clientgroup');
            console.log('Value from Redis:', clientgroupvalue);

     
    } catch (error) {
        console.error('Error retrieving values from Redis:', error);
    } finally {
        // Close the Redis client connection
        await redisClient.quit();
    }

    // Return response
    return {
        statusCode: 200,
        body: JSON.stringify(retrievalResults),
    };
};