import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.BASE_URL;
if (!baseUrl) throw new Error('BASE_URL is required');
const vus = Number(__ENV.VUS || 50);
const duration = __ENV.DURATION || '3m';

export const options = {
  stages: [
    { duration: '30s', target: Math.max(1, Math.floor(vus / 4)) },
    { duration, target: vus },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  const response = http.get(baseUrl.replace(/\/$/, '') + '/api/events/catalog?limit=20');
  check(response, {
    'catalog responds with HTTP 200': (r) => r.status === 200,
    'catalog response is JSON': (r) => String(r.headers['Content-Type'] || '').includes('application/json'),
  });
  sleep(0.2);
}
