import axios from 'axios';
import defaults from '/opt/Plugins/defaults/defaults.mjs';

class AthenaAPIConnection {
    constructor(practiceId, athena_access_token = '') {
        this.version = defaults.ATHENA_API_VERSION;
        this.key = defaults.ATHENA_API_KEY;
        this.secret = defaults.ATHENA_API_SECRET;
        this.practiceId = practiceId;
        this.baseurl = `${defaults.ATHENA_API_BASEURL}/${this.version}`;
        this.authurl = defaults.ATHENA_API_AUTHURL;
        this.token = athena_access_token;
        this.refreshToken = '';
        this.authenticate(athena_access_token);
    }

    async authenticate(athena_access_token = '') {
        if (this.token) {
            return this.token;
        }
        const url = this.authurl;
        const parameters = { grant_type: 'client_credentials', scope: 'athena/service/Athenanet.MDP.*' };

        try {
            const response = await axios.post(url, new URLSearchParams(parameters).toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${Buffer.from(`${this.key}:${this.secret}`).toString('base64')}`,
                },
            });

            this.token = response.data.access_token || '';
            this.refreshToken = response.data.refresh_token || '';
            return this.token;
        } catch (error) {
            console.error('Authentication failed:', error.message);
            throw error;
        }
    }


    async authorizedCall(verb, url, body, headers) {
        try {
            const response = await axios({
                method: verb,
                url: `${this.baseurl}/${this.practiceId}${url}`,
                data: body,
                headers: { 'Authorization': `Bearer ${this.token}`, ...headers },
            });

            return response.data;
        } catch (error) {
            console.error('API Call Error:', error.message);
            throw error;
        }
    }

    async GET(url, parameters = null, headers = null) {
        await this.authenticate(); // Ensure authentication before making the GET request

        const finalUrl = `${url.startsWith('/') ? '' : '/'}${url}?${new URLSearchParams(parameters).toString()}`;
        const jsonResponse = await this.authorizedCall('GET', finalUrl, null, headers);

        return jsonResponse;
    }

    async PUT(url, body = null, headers = null) {
        await this.authenticate();
        const finalUrl = `${url.startsWith('/') ? '' : '/'}${url}`;
        const jsonResponse = await this.authorizedCall('PUT', finalUrl, body, headers);
        return jsonResponse;
    }
}
export default AthenaAPIConnection;
