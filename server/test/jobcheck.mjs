// Open-job check: the verdict rules and the Workday API address (no network).
import assert from 'node:assert/strict';
import { verdict, workdayApi } from '../src/jobcheck.js';

const v = (from, to, status = 200, text = '') => verdict({ from, to, status, text });
assert.equal(v('https://jobs.lever.co/tri/abc', 'https://jobs.lever.co/tri/abc', 404), 'closed');
assert.equal(v('https://zapply.jobs/l/d/x-R1', 'https://zapply.jobs/jobs/'), 'closed'); // expired zapply link
assert.equal(v('https://www.samsara.com/company/careers/roles/8226608?gh_jid=8226608', 'https://www.samsara.com/company/careers/roles'), 'closed');
assert.equal(v('https://job-boards.greenhouse.io/acme/jobs/1', 'https://job-boards.greenhouse.io/acme?error=true'), 'closed');
assert.equal(v('https://zapply.jobs/l/d/x-R1', 'https://bose.wd5.myworkdayjobs.com/Bose/job/MA/Intern_R1'), 'open');
assert.equal(v('http://acme.com/careers-123', 'https://acme.com/careers-123/'), 'open'); // https / trailing slash only
assert.equal(v('https://acme.com/j/1', 'https://acme.com/j/1', 200, 'Sorry, this job has expired.'), 'closed');
assert.equal(v('https://acme.com/j/1', 'https://acme.com/j/1', 200, 'We are no longer accepting applications'), 'closed');
assert.equal(v('https://acme.com/j/1', 'https://acme.com/j/1', 200, 'Apply now for this role'), 'open');
assert.equal(v('https://linkedin.com/jobs/1', 'https://linkedin.com/jobs/1', 999), 'unknown');
assert.equal(v('https://acme.com/j/1', 'https://acme.com/j/1', 403), 'unknown');
assert.equal(workdayApi('https://bose.wd503.myworkdayjobs.com/Bose_Careers/job/US-MA/Co-op_R29372'), 'https://bose.wd503.myworkdayjobs.com/wday/cxs/bose/Bose_Careers/job/US-MA/Co-op_R29372');
assert.equal(workdayApi('https://ngc.wd1.myworkdayjobs.com/en-US/NG/job/CA/Intern_R1'), 'https://ngc.wd1.myworkdayjobs.com/wday/cxs/ngc/NG/job/CA/Intern_R1');
assert.equal(workdayApi('https://acme.com/job/1'), null);
console.log('jobcheck: ok');
