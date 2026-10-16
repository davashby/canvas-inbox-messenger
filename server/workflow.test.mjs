import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow } from './server.mjs';

function fixture() {
  let selections = 0;
  const course = { id: '76', course_code: 'SPAN101', name: 'Spanish' };
  const client = {
    selectRecipients: async (courseId, criteria) => {
      selections++;
      return { recipients: [
        { user: { id: '1', name: 'Ana One' }, grade_percent: 55, last_activity_at: null }
      ], exclusions: {}, evaluated: 2, criteria };
    }
  };
  const courseScope = { assertAllowed: async () => course, configure: async () => ({ courses: [course] }) };
  return { ...createWorkflow({ client, courseScope }), selections: () => selections };
}

test('audience approval is required before drafting and freezes the reviewed students', async () => {
  const workflow = fixture();
  const list = await workflow.callTool('preview_recipients', { course_id: '76', criteria: { grade: { scope: 'course', comparison: 'below', percent: 60 } } });
  assert.equal(list.total, 1);
  assert.equal(list.recipients[0].name, 'Ana One');
  const message = { recipient_list_id: list.recipient_list_id, subject: 'Checking in', body_template: 'Hello {{first_name}}!' };
  await assert.rejects(workflow.callTool('preview_message', message), /approve the student list/);
  await workflow.callTool('approve_recipient_list', { recipient_list_id: list.recipient_list_id });
  const preview = await workflow.callTool('preview_message', message);
  assert.equal(workflow.selections(), 1);
  assert.equal(preview.selected_count, 1);
  assert.equal(preview.sample_message.body, 'Hello Ana!');
  await assert.rejects(workflow.callTool('send_preview', { preview_id: preview.preview_id, confirmation: 'wrong' }), /Confirmation/);
  const revised = await workflow.callTool('preview_message', { ...message, body_template: 'Revised {{first_name}}' });
  assert.notEqual(preview.confirmation, revised.confirmation);
  await assert.rejects(workflow.callTool('get_preview_recipients', { preview_id: preview.preview_id }), /expired or not found/);
  await workflow.callTool('configure_course_codes', { course_codes: ['SPAN101'] });
  await assert.rejects(workflow.callTool('preview_message', message), /Recipient list expired/);
  await assert.rejects(workflow.callTool('get_preview_recipients', { preview_id: revised.preview_id }), /expired or not found/);
});
