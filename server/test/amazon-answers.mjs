import assert from 'node:assert/strict';
import fs from 'node:fs';
import { answerFields } from '../src/answer.js';

const profile = JSON.parse(fs.readFileSync(new URL('./fixtures/profile.json', import.meta.url), 'utf8'));
profile.answers = {
  ...profile.answers,
  firstLocationPreference: 'Pune',
  secondLocationPreference: 'Bengaluru',
  thirdLocationPreference: 'Hyderabad',
  cgpaScale: '10',
  currentCGPA: '8.7',
  activeBacklogs: 'No',
  computerScienceFundamentals: 'Yes',
};

const fields = [
  { id: 'degree', type: 'radio', label: "Are you enrolled in or have you completed a Bachelor's degree?", options: ['Yes', 'No'] },
  { id: 'fundamentals', type: 'radio', label: 'Do you have knowledge of computer science fundamentals such as algorithms and data structures?', options: ['Yes', 'No'] },
  { id: 'first', type: 'radio', label: 'What is your first location preference?', options: ['Bangalore', 'Pune', 'Hyderabad'] },
  { id: 'second', type: 'radio', label: 'What is your second location preference? Please do not select the option selected in the first location preference', options: ['Bengaluru', 'Pune', 'Hyderabad'] },
  { id: 'third', type: 'radio', label: 'What is your third location preference? Please do not select the option selected in the first and second location preference', options: ['Bangalore', 'Bengaluru', 'Hyderabad'] },
  { id: 'scale', type: 'radio', label: 'Please select the CGPA scale (how much is your CGPA out of?)', options: ['4', '8', '10', '100'] },
  { id: 'cgpa', type: 'number', label: 'What is your current CGPA (cumulative)?' },
  { id: 'backlogs', type: 'radio', label: 'Do you have any active arrears/backlogs?', options: ['Yes', 'No'] },
];

const out = await answerFields({ fields, profile, job: {} });
assert.equal(out.values.degree, 'Yes');
assert.equal(out.values.fundamentals, 'Yes');
assert.equal(out.values.first, 'Pune');
assert.equal(out.values.second, 'Bengaluru');
assert.equal(out.values.third, 'Hyderabad');
assert.equal(out.values.scale, '10');
assert.equal(out.values.cgpa, '8.7');
assert.equal(out.values.backlogs, 'No');
assert.deepEqual(out.needsReview, []);
console.log('AMAZON ANSWERS: passed');
