import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, renderMessage } from './canvas.mjs';
import { listCourseLinks, resolveCourseLinks } from './course-links.mjs';
import { createWorkflow } from './server.mjs';

function clientFor(routes) {
  return new CanvasClient({ baseUrl: 'https://school.instructure.com', token: 'test-token', fetchImpl: async (url, options) => {
    const value = routes[new URL(url).pathname];
    return new Response(JSON.stringify(typeof value === 'function' ? value(new URL(url), options) : value || {}), { status: value ? 200 : 404 });
  } });
}

test('discovery finds published pages and New Quizzes via assignment URLs, with paging and permission reporting', async () => {
  const assignment = { id: '9', name: 'Practice Quiz', published: true, html_url: 'https://school.instructure.com/courses/76/assignments/9' };
  const client = clientFor({
    '/api/v1/courses/76/pages': [{ url: '76', page_id: '999', title: 'Study Guide', published: true }, { url: 'draft', title: 'Draft', published: false }],
    '/api/v1/courses/76/assignments': (url) => {
      assert.equal(url.searchParams.get('bucket'), 'published');
      return url.searchParams.get('new_quizzes') === 'true' ? [assignment] : [assignment, { ...assignment, id: '10', published: false }];
    },
    '/api/v1/courses/76/quizzes': []
  });
  const result = await listCourseLinks(client, '76', { limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.links[0].quiz_engine, 'new');
  assert.equal(result.next_offset, 1);
  assert.deepEqual(result.unavailable_types, [{ type: 'discussion', http_status: 404 }]);
  const page = await listCourseLinks(client, '76', { search: 'study', types: ['page'] });
  assert.equal(page.links[0].id, '76');
  assert.equal(page.links[0].url, 'https://school.instructure.com/courses/76/pages/76');
});

test('resolving links rejects unpublished, foreign-course and external destinations', async () => {
  const route = '/api/v1/courses/76/assignments/9';
  const ref = [{ key: 'work', type: 'assignment', id: '9' }];
  for (const item of [
    { id: '9', name: 'Draft', published: false },
    { id: '9', name: 'Other course', published: true, html_url: 'https://school.instructure.com/courses/77/assignments/9' },
    { id: '9', name: 'Outside Canvas', published: true, html_url: 'https://example.com/courses/76/assignments/9' },
    { id: '9', course_id: '77', name: 'Wrong object', published: true, html_url: 'https://school.instructure.com/courses/76/assignments/9' }
  ]) await assert.rejects(resolveCourseLinks(clientFor({ [route]: item }), '76', ref));
  const links = await resolveCourseLinks(clientFor({ '/api/v1/courses/76/pages/guide': { url: 'guide', title: 'Study Guide', published: true } }), '76', [{ key: 'guide', type: 'page', id: 'guide' }]);
  assert.equal(links[0].url, 'https://school.instructure.com/courses/76/pages/guide');
  const otherLinks = await resolveCourseLinks(clientFor({
    '/api/v1/courses/76/quizzes/11': { id: '11', title: 'Classic Quiz', published: true, html_url: 'https://school.instructure.com/courses/76/quizzes/11' },
    '/api/v1/courses/76/discussion_topics/12': { id: '12', title: 'Weekly Discussion', published: true, html_url: 'https://school.instructure.com/courses/76/discussion_topics/12?module_item_id=123' }
  }), '76', [{ key: 'quiz', type: 'quiz', id: '11' }, { key: 'discussion', type: 'discussion', id: '12' }]);
  assert.deepEqual(otherLinks.map(link => link.url), ['https://school.instructure.com/courses/76/quizzes/11', 'https://school.instructure.com/courses/76/discussion_topics/12']);
  await assert.rejects(resolveCourseLinks(clientFor({}), '76', [{ key: 'work', type: 'page', id: '../guide' }]), /page slug/);
});

test('personalized links can be placed in text or appended without Markdown or HTML', () => {
  const link = { key: 'guide', label: 'Study Guide', url: 'https://school.instructure.com/courses/76/pages/guide' };
  assert.equal(renderMessage('Hello {{first_name}}, review {{link:guide}}.', { name: 'Ana One' }, [link]), `Hello Ana, review Study Guide: ${link.url}.`);
  assert.equal(renderMessage('Please review the guide.', { name: 'Ana One' }, [link]), `Hi Ana,\n\nPlease review the guide.\n\nCourse links:\nStudy Guide: ${link.url}`);
  assert.throws(() => renderMessage('See {{link:missing}}', { name: 'Ana' }, [link]), /unresolved/);
  assert.throws(() => renderMessage('x'.repeat(9990), { name: 'Ana' }, [link]), /too long/);
});

test('workflow scopes link lookup, previews exact URLs and sends that approved content unchanged', async () => {
  const client = clientFor({ '/api/v1/courses/76/assignments/9': { id: '9', name: 'Practice', published: true, html_url: 'https://school.instructure.com/courses/76/assignments/9' } });
  let sent;
  client.selectRecipients = async () => ({ recipients: [{ user: { id: '1', name: 'Ana One' } }], criteria: {}, evaluated: 1, exclusions: {} });
  client.sendOne = async (...args) => { sent = args; };
  const workflow = createWorkflow({ client, courseScope: { assertAllowed: async courseId => {
    if (courseId !== '76') throw new Error('outside scope');
    return { id: '76', course_code: 'SPAN101', name: 'Spanish' };
  } } });
  await assert.rejects(workflow.callTool('list_course_links', { course_id: '77' }), /outside scope/);
  const list = await workflow.callTool('preview_recipients', { course_id: '76', criteria: {} });
  await workflow.callTool('approve_recipient_list', { recipient_list_id: list.recipient_list_id });
  const draft = { recipient_list_id: list.recipient_list_id, subject: 'Practice', body_template: 'Hi {{first_name}}, see {{link:practice}}', course_links: [{ key: 'practice', type: 'assignment', id: '9' }] };
  const preview = await workflow.callTool('preview_message', draft);
  assert.equal(preview.course_links[0].url, 'https://school.instructure.com/courses/76/assignments/9');
  await workflow.callTool('send_preview', { preview_id: preview.preview_id, confirmation: preview.confirmation });
  assert.equal(sent[3], preview.sample_message.body);
  assert(sent[3].includes(preview.course_links[0].url));
});
