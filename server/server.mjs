import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasClient, renderMessage, id } from './canvas.mjs';
import { CourseScope } from './course-scope.mjs';
import { dataDirectory } from './platform.mjs';
import { listCourseLinks, resolveCourseLinks } from './course-links.mjs';

export function createWorkflow({ client, courseScope }) {
const previews = new Map();
const recipientLists = new Map();
const PREVIEW_AGE_MS = 30 * 60 * 1000;

const tools = [
  {
    name: 'list_available_courses',
    description: 'List active, available courses with active teacher enrollments so the instructor can choose courses. Returns names, exact course codes, Canvas IDs, dates, and whether each course is already selected. Works before setup and does not change the saved course scope. Ask the instructor which courses to use, then call configure_course_codes with their selected codes and IDs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'configure_course_codes',
    description: 'Save the courses the instructor chose from list_available_courses, or exact course codes they supplied. Resolve codes only against current active teacher enrollments in available courses. Pass the selected Canvas IDs to distinguish sections sharing a code. Replaces the previous selection and invalidates message previews.',
    inputSchema: {
      type: 'object', properties: {
        course_codes: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
        course_ids: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Optional exact IDs to disambiguate codes that match multiple live courses.' }
      }, required: ['course_codes'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'get_course_scope',
    description: 'Show the teacher-selected courses currently allowed by this plugin, including any that are no longer active.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_courses',
    description: 'List only the teacher-selected courses that are still active and available. For all courses available to choose from, including before setup, use list_available_courses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_assignments',
    description: 'List published assignments and possible points in a course.',
    inputSchema: {
      type: 'object', properties: { course_id: { type: 'string' } }, required: ['course_id'], additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_course_links',
    description: 'Find published pages, assignments, quizzes, and discussions in a teacher-selected course to link in an Inbox message. Search by title or ID. Return browser URLs, types, IDs, and availability dates. New Quizzes are returned as assignment references. Use these exact references in preview_message.course_links; resolve ambiguous titles with the teacher.',
    inputSchema: {
      type: 'object', properties: {
        course_id: { type: 'string' },
        types: { type: 'array', minItems: 1, items: { type: 'string', enum: ['page', 'assignment', 'quiz', 'discussion'] } },
        search: { type: 'string', maxLength: 255 },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
      }, required: ['course_id'], additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'preview_recipients',
    description: 'Find students matching the instructor criteria before drafting any message. Returns a frozen recipient list for one selected course. Present all names and the interpreted criteria, then ask the instructor to approve the list. Does not send or draft a message.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', description: 'Canvas course ID' },
        criteria: {
          type: 'object',
          properties: {
            combine: { type: 'string', enum: ['all', 'any'], description: 'How to combine grade and activity rules. Defaults to all.' },
            grade: {
              type: 'object',
              properties: {
                scope: { type: 'string', enum: ['course', 'assignment'] },
                metric: { type: 'string', enum: ['current_score', 'final_score'], description: 'For course grade; default current_score.' },
                assignment_id: { type: 'string', description: 'Required for assignment grade.' },
                comparison: { type: 'string', enum: ['below', 'above', 'at_or_below', 'at_or_above'] },
                percent: { type: 'number', minimum: 0, maximum: 100 }
              },
              required: ['scope', 'comparison', 'percent'], additionalProperties: false
            },
            activity: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['inactive_for_days', 'inactive_since'] },
                days: { type: 'integer', minimum: 1, maximum: 3650 },
                since: { type: 'string', description: 'For inactive_since: exact ISO 8601 cutoff with timezone, e.g. Monday at midnight in the instructor timezone.' },
                include_never_active: { type: 'boolean', description: 'Whether students with no recorded course activity match.' }
              },
              required: ['kind', 'include_never_active'], additionalProperties: false
            }
          }, additionalProperties: false
        }
      },
      required: ['course_id', 'criteria'], additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_recipient_list',
    description: 'Read a page of a student list from preview_recipients before asking the instructor to approve it. Retrieve every page so the instructor can review all students.',
    inputSchema: {
      type: 'object', properties: {
        recipient_list_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
      }, required: ['recipient_list_id'], additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'approve_recipient_list',
    description: 'Record the instructor approval of the exact displayed student list. Call only after the instructor approves that list; then ask what the message should say. Does not send.',
    inputSchema: {
      type: 'object', properties: { recipient_list_id: { type: 'string' } }, required: ['recipient_list_id'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'preview_message',
    description: 'Draft personalized messages for a previously approved recipient list, keeping exactly those students without rerunning criteria. Requires recipient approval first. Present the subject, personalized message, courses and recipient counts, then ask for final approval to send.',
    inputSchema: {
      type: 'object', properties: {
        recipient_list_id: { type: 'string' },
        subject: { type: 'string', description: 'Canvas Inbox subject, at most 255 characters.' },
        body_template: { type: 'string', description: 'Use {{first_name}} or {{full_name}} for the greeting. Optional {{link:key}} inserts a selected course link; other selected links are appended with labels and full URLs.' },
        course_links: {
          type: 'array', maxItems: 20, description: 'Optional references chosen from list_course_links for this audience course. The server resolves and checks them before rendering.',
          items: {
            type: 'object', properties: {
              key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$', description: 'Unique key used in {{link:key}}.' },
              type: { type: 'string', enum: ['page', 'assignment', 'quiz', 'discussion'] },
              id: { type: 'string', description: 'Exact item ID from list_course_links; pages use their URL slug, not page_id.' },
              label: { type: 'string', minLength: 1, maxLength: 255, description: 'Optional display label; defaults to the Canvas item title.' }
            }, required: ['key', 'type', 'id'], additionalProperties: false
          }
        }
      }, required: ['recipient_list_id', 'subject', 'body_template'], additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_preview_recipients',
    description: 'Review a page of the exact students selected by a prior preview. Does not send.',
    inputSchema: {
      type: 'object', properties: {
        preview_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
      }, required: ['preview_id'], additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'send_preview',
    description: 'Send the exact previewed message to each selected student, separately. Requires an explicit confirmation string obtained from preview_message. Never call before the instructor approves the preview.',
    inputSchema: {
      type: 'object', properties: { preview_id: { type: 'string' }, confirmation: { type: 'string' } },
      required: ['preview_id', 'confirmation'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }
];

function getPreview(previewId) {
  const preview = previews.get(previewId);
  if (!preview || Date.now() - preview.createdAt > PREVIEW_AGE_MS) {
    previews.delete(previewId);
    throw new Error('Preview expired or not found. Create a new preview.');
  }
  return preview;
}

function getRecipientList(listId) {
  const list = recipientLists.get(listId);
  if (!list || Date.now() - list.createdAt > PREVIEW_AGE_MS) {
    recipientLists.delete(listId);
    throw new Error('Recipient list expired or not found. Select recipients again and obtain approval of the new list.');
  }
  return list;
}

function recipientPage(list, args) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid offset or limit');
  return {
    recipient_list_id: list.id, approved: list.approved,
    course_id: list.courseId, course_code: list.course.course_code, course_name: list.course.name,
    criteria: list.selection.criteria, assignment_name: list.selection.assignment_name,
    evaluated_active_students: list.selection.evaluated,
    excluded_data_counts: list.selection.exclusions,
    total: list.selection.recipients.length,
    recipients: list.selection.recipients.slice(offset, offset + limit).map(x => ({
      id: x.user.id, name: x.user.name, grade_percent: x.grade_percent, last_activity_at: x.last_activity_at
    })),
    next_offset: offset + limit < list.selection.recipients.length ? offset + limit : null,
    expires_at: new Date(list.createdAt + PREVIEW_AGE_MS).toISOString()
  };
}

async function callTool(name, args) {
  if (name === 'list_available_courses') return courseScope.available();
  if (name === 'configure_course_codes') {
    const configured = await courseScope.configure(args);
    previews.clear();
    recipientLists.clear();
    return { configured: true, ...configured, note: 'Course scope saved locally. Existing message previews were invalidated.' };
  }
  if (name === 'get_course_scope') return courseScope.current();
  if (name === 'list_courses') {
    const current = await courseScope.current();
    return { configured: current.configured, courses: current.courses, unavailable_courses: current.unavailable_courses || [] };
  }
  if (name === 'list_assignments') {
    await courseScope.assertAllowed(args.course_id);
    return { assignments: await client.listAssignments(args.course_id) };
  }
  if (name === 'list_course_links') {
    await courseScope.assertAllowed(args.course_id);
    return listCourseLinks(client, args.course_id, args);
  }
  if (name === 'preview_recipients') {
    const courseId = id(args.course_id, 'course_id');
    const allowedCourse = await courseScope.assertAllowed(courseId);
    const selection = await client.selectRecipients(courseId, args.criteria);
    const list = { id: randomUUID(), createdAt: Date.now(), courseId, course: allowedCourse, selection, approved: false };
    recipientLists.set(list.id, list);
    return recipientPage(list, {});
  }
  if (name === 'get_recipient_list') return recipientPage(getRecipientList(args.recipient_list_id), args);
  if (name === 'approve_recipient_list') {
    const list = getRecipientList(args.recipient_list_id);
    await courseScope.assertAllowed(list.courseId);
    if (!list.selection.recipients.length) throw new Error('No students match. Revise the criteria before continuing.');
    list.approved = true;
    return { recipient_list_id: list.id, approved: true, selected_count: list.selection.recipients.length, next_step: 'Ask the instructor what the message should say, then call preview_message.' };
  }
  if (name === 'preview_message') {
    const list = getRecipientList(args.recipient_list_id);
    if (!list.approved) throw new Error('The instructor must approve the student list before drafting a message.');
    const courseId = list.courseId;
    const allowedCourse = await courseScope.assertAllowed(courseId);
    const subject = String(args.subject || '').trim();
    if (!subject || subject.length > 255) throw new Error('subject must be 1 to 255 characters');
    const selection = list.selection;
    const courseLinks = await resolveCourseLinks(client, courseId, args.course_links);
    const recipientMessages = selection.recipients.map(recipient => ({
      ...recipient, body: renderMessage(args.body_template, recipient.user, courseLinks)
    }));
    const previewId = randomUUID();
    const confirmation = `SEND ${recipientMessages.length} TO COURSE ${courseId} PREVIEW ${previewId}`;
    // A revised message supersedes any unsent draft for the same approved audience.
    for (const [key, prior] of previews) {
      if (prior.recipientListId === list.id && prior.sentIds.length === 0) previews.delete(key);
    }
    previews.set(previewId, {
      recipientListId: list.id,
      createdAt: Date.now(), courseId, subject, recipientMessages, confirmation,
      selection, state: 'ready', sentIds: [], uncertainId: null
    });
    return {
      preview_id: previewId,
      recipient_list_id: list.id,
      expires_in_minutes: 30,
      course_id: courseId,
      course_code: allowedCourse.course_code,
      course_name: allowedCourse.name,
      criteria: selection.criteria,
      assignment_name: selection.assignment_name,
      course_links: courseLinks,
      evaluated_active_students: selection.evaluated,
      selected_count: recipientMessages.length,
      excluded_data_counts: selection.exclusions,
      sample_recipients: recipientMessages.slice(0, 20).map(x => ({ id: x.user.id, name: x.user.name })),
      sample_message: recipientMessages[0] ? { to: recipientMessages[0].user.name, subject, body: recipientMessages[0].body } : null,
      confirmation,
      note: 'Recorded course activity is not a verified login. Every selected student receives a separate private Canvas conversation. The instructor must approve this exact preview before send_preview.'
    };
  }
  if (name === 'get_preview_recipients') {
    const preview = getPreview(args.preview_id);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid offset or limit');
    return {
      preview_id: args.preview_id,
      total: preview.recipientMessages.length,
      recipients: preview.recipientMessages.slice(offset, offset + limit).map(x => ({
        id: x.user.id, name: x.user.name, grade_percent: x.grade_percent, last_activity_at: x.last_activity_at, body: x.body
      })),
      next_offset: offset + limit < preview.recipientMessages.length ? offset + limit : null
    };
  }
  if (name === 'send_preview') {
    const preview = getPreview(args.preview_id);
    await courseScope.assertAllowed(preview.courseId);
    if (!['ready', 'in_progress'].includes(preview.state)) throw new Error(`Preview cannot be sent in state ${preview.state}`);
    if (!preview.recipientMessages.length) throw new Error('Preview has no recipients');
    if (args.confirmation !== preview.confirmation) throw new Error('Confirmation does not match this preview');
    preview.state = 'sending';
    const batch = preview.recipientMessages.slice(preview.sentIds.length, preview.sentIds.length + 20);
    for (const recipient of batch) {
      try {
        await client.sendOne(preview.courseId, recipient, preview.subject, recipient.body);
        preview.sentIds.push(recipient.user.id);
      } catch (error) {
        preview.uncertainId = recipient.user.id;
        preview.state = 'stopped';
        return {
          state: preview.state,
          sent_count: preview.sentIds.length,
          selected_count: preview.recipientMessages.length,
          uncertain_student_id: preview.uncertainId,
          error: error.message,
          next_step: 'Check Canvas Inbox for the uncertain student before any new send. This preview cannot be retried automatically.'
        };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    preview.state = preview.sentIds.length === preview.recipientMessages.length ? 'complete' : 'in_progress';
    return {
      state: preview.state,
      sent_count: preview.sentIds.length,
      selected_count: preview.recipientMessages.length,
      remaining_count: preview.recipientMessages.length - preview.sentIds.length,
      next_step: preview.state === 'in_progress' ? 'Call send_preview again with the same preview_id and confirmation to continue this approved send.' : undefined
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

return { tools, callTool };
}

async function handle(message, workflow) {
  if (!('id' in message)) return;
  const { id: requestId, method, params = {} } = message;
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id: requestId, result: {
        protocolVersion: params.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'canvas-inbox', version: '0.4.0' }
      } };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id: requestId, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id: requestId, result: { tools: workflow.tools } };
    if (method === 'tools/call') {
      const data = await workflow.callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id: requestId, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } };
    }
    return { jsonrpc: '2.0', id: requestId, error: { code: -32601, message: 'Method not found' } };
  } catch (error) {
    return { jsonrpc: '2.0', id: requestId, result: { isError: true, content: [{ type: 'text', text: error.message }] } };
  }
}

export async function runServer() {
const client = new CanvasClient({
  baseUrl: process.env.CANVAS_BASE_URL || 'https://byui.instructure.com',
  token: process.env.CANVAS_ACCESS_TOKEN
});
const courseScope = new CourseScope({
  path: process.env.CANVAS_SCOPE_FILE || join(dataDirectory(), 'course-scope.json'),
  client
});
const workflow = createWorkflow({ client, courseScope });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const response = await handle(JSON.parse(line), workflow);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`MCP input error: ${error.message}\n`);
  }
}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runServer();
