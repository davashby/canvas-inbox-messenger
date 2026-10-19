import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, renderMessage } from './canvas.mjs';

function mockClient(routes) {
  const requests = [];
  const client = new CanvasClient({
    baseUrl: 'https://byui.instructure.com', token: 'test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), ...options });
      const key = `${options.method} ${new URL(url).pathname}`;
      if (!(key in routes)) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  return { client, requests };
}

test('filters active students by posted assignment grade and course inactivity', async () => {
  const { client } = mockClient({
    'GET /api/v1/courses/5/enrollments': [
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', last_activity_at: '2026-09-01T00:00:00Z', user: { name: 'Ada Lovelace' } },
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', last_activity_at: '2026-09-01T00:00:00Z', user: { name: 'Ada Lovelace' } },
      { user_id: '2', type: 'StudentEnrollment', enrollment_state: 'active', last_activity_at: '2026-10-14T00:00:00Z', user: { name: 'Grace Hopper' } },
      { user_id: '3', type: 'StudentEnrollment', enrollment_state: 'inactive', last_activity_at: null, user: { name: 'Inactive Student' } }
    ],
    'GET /api/v1/courses/5/assignments/9': { name: 'Quiz 1', published: true, points_possible: 20 },
    'GET /api/v1/courses/5/assignments/9/submissions': [
      { user_id: '1', score: 10, posted_at: '2026-09-02T00:00:00Z' },
      { user_id: '2', score: 19, posted_at: '2026-10-14T00:00:00Z' }
    ]
  });
  const result = await client.selectRecipients('5', {
    combine: 'all', grade: { scope: 'assignment', assignment_id: '9', comparison: 'below', percent: 60 },
    activity: { kind: 'inactive_for_days', days: 7, include_never_active: false }
  }, new Date('2026-10-15T00:00:00Z'));
  assert.deepEqual(result.recipients.map(x => x.user.id), ['1']);
  assert.equal(result.evaluated, 2);
  assert.equal(result.assignment_name, 'Quiz 1');
});

test('missing course grade is excluded rather than treated as zero', async () => {
  const { client } = mockClient({
    'GET /api/v1/courses/5/enrollments': [
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', user: { name: 'Ada' }, grades: { current_score: null } },
      { user_id: '2', type: 'StudentEnrollment', enrollment_state: 'active', user: { name: 'Grace' }, grades: { current_score: 59 } }
    ]
  });
  const result = await client.selectRecipients('5', { grade: { scope: 'course', comparison: 'below', percent: 60 } });
  assert.deepEqual(result.recipients.map(x => x.user.id), ['2']);
  assert.equal(result.exclusions.missing_grade, 1);
});

test('calendar inactivity respects the exact timezone boundary and never-active choice', async () => {
  const { client } = mockClient({
    'GET /api/v1/courses/5/enrollments': [
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', user: { name: 'Before' }, last_activity_at: '2020-10-12T05:59:59Z' },
      { user_id: '2', type: 'StudentEnrollment', enrollment_state: 'active', user: { name: 'At midnight' }, last_activity_at: '2020-10-12T06:00:00Z' },
      { user_id: '3', type: 'StudentEnrollment', enrollment_state: 'active', user: { name: 'Never active' }, last_activity_at: null }
    ]
  });
  const activity = { kind: 'inactive_since', since: '2020-10-12T00:00:00-06:00', include_never_active: false };
  const now = new Date('2020-10-15T00:00:00Z');
  assert.deepEqual((await client.selectRecipients('5', { activity }, now)).recipients.map(x => x.user.id), ['1']);
  assert.deepEqual((await client.selectRecipients('5', { activity: { ...activity, include_never_active: true } }, now)).recipients.map(x => x.user.id).sort(), ['1', '3']);
  await assert.rejects(client.selectRecipients('5', { activity: { ...activity, since: '2020-10-12T00:00:00' } }), /timezone/);
});

test('renders a personal greeting and sends to one recipient', async () => {
  const { client, requests } = mockClient({ 'POST /api/v1/conversations': [] });
  const recipient = { user: { id: '123', name: 'Ada Lovelace' } };
  const body = renderMessage('Please check the course update.', recipient.user);
  assert.equal(body, 'Hi Ada,\n\nPlease check the course update.');
  assert.equal(renderMessage('Hello {{first_name}}, welcome!', recipient.user), 'Hello Ada, welcome!');
  await client.sendOne('5', recipient, 'Course update', body);
  const request = requests[0];
  const form = new URLSearchParams(request.body);
  assert.deepEqual(form.getAll('recipients[]'), ['123']);
  assert.equal(form.get('group_conversation'), 'false');
  assert.equal(form.get('context_code'), 'course_5');
});

test('course discovery requests active teacher enrollments in available courses', async () => {
  const { client, requests } = mockClient({
    'GET /api/v1/courses': [
      { id: '5', name: 'Live Course', course_code: 'ABC123', workflow_state: 'available' },
      { id: '6', name: 'Past Course', course_code: 'ABC123', workflow_state: 'completed' }
    ]
  });
  assert.deepEqual((await client.listCourses()).map(course => course.id), ['5']);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('enrollment_state'), 'active');
  assert.equal(url.searchParams.get('enrollment_type'), 'teacher');
  assert.deepEqual(url.searchParams.getAll('state[]'), ['available']);
});

test('all-students audience includes active students without grades or activity and deduplicates enrollments', async () => {
  const { client } = mockClient({
    'GET /api/v1/courses/5/enrollments': [
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', course_section_id: '10', user: { name: 'Ada' } },
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', course_section_id: '11', user: { name: 'Ada' } },
      { user_id: '2', type: 'StudentEnrollment', enrollment_state: 'active', user: { name: 'Grace' }, grades: { current_score: null } },
      { user_id: '3', type: 'StudentEnrollment', enrollment_state: 'inactive', user: { name: 'Inactive' } },
      { user_id: '4', type: 'TeacherEnrollment', enrollment_state: 'active', user: { name: 'Teacher' } }
    ]
  });
  const result = await client.selectRecipients('5', { audience: 'all_students', combine: 'any' });
  assert.deepEqual(result.recipients.map(x => x.user.id), ['1', '2']);
  assert.equal(result.evaluated, 2);
  assert.deepEqual(result.selected_sections, []);
  await assert.rejects(client.selectRecipients('5', {}), /explicitly choose/);
  await assert.rejects(client.selectRecipients('5', { audience: 'all_students', grade: { scope: 'course', comparison: 'below', percent: 60 } }), /filtered/);
});

test('section audiences verify ownership and filter before deduplication, including with any conditions', async () => {
  const { client } = mockClient({
    'GET /api/v1/courses/5/sections': [
      { id: '10', course_id: '5', name: 'SPAN101-01' },
      { id: '11', course_id: '5', name: 'SPAN101-02' },
      { id: '99', course_id: '6', name: 'Other course' }
    ],
    'GET /api/v1/courses/5/enrollments': [
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', course_section_id: '10', user: { name: 'Ada' }, grades: { current_score: 50 } },
      { user_id: '1', type: 'StudentEnrollment', enrollment_state: 'active', course_section_id: '11', user: { name: 'Ada' }, grades: { current_score: 90 }, last_activity_at: '2026-10-19T00:00:00Z' },
      { user_id: '2', type: 'StudentEnrollment', enrollment_state: 'active', course_section_id: '11', user: { name: 'Grace' }, grades: { current_score: 40 } }
    ]
  });
  const result = await client.selectRecipients('5', { audience: 'all_students', section_ids: ['10'] });
  assert.deepEqual(result.recipients.map(x => x.user.id), ['1']);
  assert.equal(result.selected_sections[0].name, 'SPAN101-01');
  const filtered = await client.selectRecipients('5', { section_ids: ['10'], combine: 'any', grade: { scope: 'course', comparison: 'below', percent: 60 } });
  assert.deepEqual(filtered.recipients.map(x => x.user.id), ['1']);
  await assert.rejects(client.selectRecipients('5', { audience: 'all_students', section_ids: ['99'] }), /belong/);
  await assert.rejects(client.selectRecipients('5', { audience: 'all_students', section_ids: [] }), /1 to 50/);
  const combined = await client.selectRecipients('5', { audience: 'all_students', section_ids: ['10', '11', '10'] });
  assert.deepEqual(combined.recipients.map(x => x.user.id), ['1', '2']);
});
