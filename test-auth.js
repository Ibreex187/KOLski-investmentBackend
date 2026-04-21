const axios = require('axios');

const port = process.env.PORT || 4080;
const BASE_URL = process.env.API_BASE_URL || `http://localhost:${port}/api/v1`;
const runId = Date.now();
const credentials = {
  name: process.env.TEST_AUTH_NAME || 'Test User',
  username: process.env.TEST_AUTH_USERNAME || `testuser${runId}`,
  email: process.env.TEST_AUTH_EMAIL || `testuser+${runId}@example.com`,
  password: process.env.TEST_AUTH_PASSWORD || 'TestPassword123'
};

async function registerUser() {
  try {
    const registerRes = await axios.post(`${BASE_URL}/register`, credentials);
    console.log('Register response:', registerRes.data);
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data || err.message;

    if (status === 409) {
      console.log('Register skipped: user already exists');
      return;
    }

    throw new Error(`Register failed: ${JSON.stringify(message)}`);
  }
}

async function testAuthFlow() {
  try {
    await registerUser();

    const loginRes = await axios.post(`${BASE_URL}/login`, {
      email: credentials.email,
      password: credentials.password
    });
    console.log('Login response:', loginRes.data);

    const token = loginRes.data.token;
    const meRes = await axios.get(`${BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Me response:', meRes.data);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

testAuthFlow();
