import dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';

const params = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: process.env.DYNAMICS_CLIENT_ID,
  client_secret: process.env.DYNAMICS_CLIENT_SECRET,
  scope: `${process.env.DYNAMICS_ORG_URL}/.default`,
});

console.log('Testing Dynamics 365 CRM authentication...');
console.log('Org URL:', process.env.DYNAMICS_ORG_URL);
console.log('Tenant ID:', process.env.DYNAMICS_TENANT_ID);
console.log('Client ID:', process.env.DYNAMICS_CLIENT_ID);
console.log('Secret:', process.env.DYNAMICS_CLIENT_SECRET?.slice(0, 8) + '...');

try {
  const tokenUrl = `https://login.microsoftonline.com/${process.env.DYNAMICS_TENANT_ID}/oauth2/v2.0/token`;
  const res = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  console.log('\n✅ SUCCESS — Token acquired');
  console.log('Expires in:', res.data.expires_in, 'seconds');

  // Try a simple API call
  const apiRes = await axios.get(`${process.env.DYNAMICS_ORG_URL}/api/data/v9.2/WhoAmI()`, {
    headers: {
      Authorization: `Bearer ${res.data.access_token}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    timeout: 15000,
  });
  console.log('\n✅ API call successful (WhoAmI)');
  console.log('User ID:', apiRes.data.UserId);
  console.log('Org ID:', apiRes.data.OrganizationId);
} catch (err) {
  console.log('\n❌ ERROR:', err.response?.data?.error_description || err.response?.data?.error?.message || err.message);
  if (err.response?.data) {
    console.log('Full error:', JSON.stringify(err.response.data, null, 2));
  }
}

process.exit(0);
