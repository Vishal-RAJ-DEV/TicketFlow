import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.BASE_URL;
const token = __ENV.ACCESS_TOKEN;
const occurrenceId = __ENV.OCCURRENCE_ID;
const sectionId = __ENV.GA_SECTION_ID;
const salesStartsAt = __ENV.SALES_STARTS_AT;
const salesEndsAt = __ENV.SALES_ENDS_AT;
if (!baseUrl || !token || !occurrenceId || !sectionId || !salesStartsAt || !salesEndsAt) {
  throw new Error('BASE_URL, ACCESS_TOKEN, OCCURRENCE_ID, GA_SECTION_ID, SALES_STARTS_AT and SALES_ENDS_AT are required');
}
const vus = Number(__ENV.VUS || 20);
const duration = __ENV.DURATION || '1m';
const allocation = Number(__ENV.ALLOCATION_PER_REQUEST || 1);
if (!Number.isInteger(allocation) || allocation < 1) throw new Error('ALLOCATION_PER_REQUEST must be a positive integer');

export const options = {
  scenarios: { ga_configuration_contention: { executor: 'constant-vus', vus, duration, gracefulStop: '30s' } },
  thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<1200'] },
};

export default function () {
  const code = ('K6' + __VU.toString(36) + 'I' + __ITER.toString(36)).toUpperCase().slice(0, 32);
  const body = JSON.stringify({
    name: 'Load Test GA ' + code,
    code,
    mode: 'GENERAL_ADMISSION',
    priceMinorUnits: '100',
    currency: 'INR',
    capacity: allocation,
    minPerOrder: 1,
    maxPerOrder: 6,
    salesStartsAt,
    salesEndsAt,
    sectionAllocations: [{ sectionId, capacity: allocation }],
  });
  const response = http.post(
    baseUrl.replace(/\/$/, '') + '/api/events/ticket-types/occurrences/' + encodeURIComponent(occurrenceId),
    body,
    { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
  );
  check(response, {
    'GA config is accepted or safely rejected by capacity guard': (r) => [201, 400, 409].includes(r.status),
  });
  sleep(0.1);
}
