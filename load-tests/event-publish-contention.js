import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.BASE_URL;
const token = __ENV.ACCESS_TOKEN;
const eventId = __ENV.EVENT_ID;
if (!baseUrl || !token || !eventId) throw new Error('BASE_URL, ACCESS_TOKEN and EVENT_ID are required');
const vus = Number(__ENV.VUS || 20);
const duration = __ENV.DURATION || '1m';

export const options = {
  scenarios: { publish_contention: { executor: 'constant-vus', vus, duration, gracefulStop: '30s' } },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<1000'] },
};

export default function () {
  const response = http.post(
    baseUrl.replace(/\/$/, '') + '/api/events/events/' + encodeURIComponent(eventId) + '/publish',
    null,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  check(response, {
    'publish succeeds or is idempotently already published': (r) => r.status === 200 || r.status === 202,
  });
  sleep(0.1);
}
