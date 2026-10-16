import { id } from './canvas.mjs';

const endpoints = { page: 'pages', assignment: 'assignments', quiz: 'quizzes', discussion: 'discussion_topics' };

function itemId(type, value) {
  if (!Object.hasOwn(endpoints, type)) throw new Error('Unsupported course link type');
  if (type !== 'page') return id(value, 'course link id');
  const slug = String(value ?? '').trim();
  if (!slug || slug.length > 255 || /[/?#\\]/.test(slug) || ['.', '..'].includes(slug)) throw new Error('Invalid page slug');
  return slug;
}

function describe(client, course, type, item) {
  if (item.published !== true || (item.course_id !== undefined && String(item.course_id) !== course)) return null;
  const resourceId = type === 'page' ? itemId(type, item.url) : itemId(type, item.id);
  const raw = type === 'page'
    ? `${client.origin}/courses/${course}/pages/${encodeURIComponent(resourceId)}`
    : item.html_url;
  if (!raw) return null;
  const url = new URL(raw, client.origin);
  const expected = `/courses/${course}/${endpoints[type]}/${encodeURIComponent(resourceId)}`;
  if (url.origin !== client.origin || url.username || url.password || url.pathname !== expected) {
    throw new Error('Canvas returned a course link outside the expected course item');
  }
  // Use the permanent course URL, without navigation or tracking parameters.
  url.search = '';
  url.hash = '';
  return {
    type, id: resourceId, title: String(item.title || item.name || resourceId), url: url.toString(),
    published: true, unlock_at: item.unlock_at || null, lock_at: item.lock_at || null,
    due_at: item.due_at || null
  };
}

export async function listCourseLinks(client, courseId, { types = Object.keys(endpoints), search = '', offset = 0, limit = 50 } = {}) {
  const course = id(courseId, 'course_id');
  if (!Array.isArray(types) || !types.length || types.some(type => !Object.hasOwn(endpoints, type))) throw new Error('Choose page, assignment, quiz, or discussion link types');
  if (typeof search !== 'string' || search.length > 255) throw new Error('Search must be at most 255 characters');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid offset or limit');
  const sources = [...new Set(types)].map(type => ({ type, params: type === 'page' ? { published: true } : type === 'assignment' ? { bucket: 'published' } : {} }));
  if (types.includes('quiz')) sources.push({ type: 'assignment', params: { bucket: 'published', new_quizzes: true }, newQuiz: true });
  const outcomes = await Promise.allSettled(sources.map(async source => {
    const items = await client.all(`/api/v1/courses/${course}/${endpoints[source.type]}`, source.params);
    return items.map(item => {
      const link = describe(client, course, source.type, item);
      return link && { ...link, ...(source.newQuiz ? { quiz_engine: 'new' } : {}) };
    }).filter(Boolean);
  }));
  const links = new Map();
  const unavailable = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      if (![403, 404].includes(outcome.reason.httpStatus)) throw outcome.reason;
      unavailable.push({ type: sources[index].newQuiz ? 'new_quiz' : sources[index].type, http_status: outcome.reason.httpStatus });
    } else for (const link of outcome.value) {
      const key = `${link.type}:${link.id}`;
      links.set(key, { ...links.get(key), ...link });
    }
  });
  const query = search.trim().toLocaleLowerCase();
  const matching = [...links.values()].filter(link => !query || `${link.title} ${link.id}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.title.localeCompare(b.title) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return {
    course_id: course, total: matching.length, links: matching.slice(offset, offset + limit),
    next_offset: offset + limit < matching.length ? offset + limit : null, unavailable_types: unavailable,
    note: 'Only published items are listed. Student access can still depend on dates, prerequisites, and differentiated assignments. New Quizzes use assignment links.'
  };
}

export async function resolveCourseLinks(client, courseId, references = []) {
  const course = id(courseId, 'course_id');
  if (!Array.isArray(references) || references.length > 20) throw new Error('Use at most 20 course links');
  const keys = new Set();
  const links = [];
  for (const reference of references) {
    if (!reference || typeof reference.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(reference.key) || keys.has(reference.key)) throw new Error('Each course link needs a unique lowercase key');
    keys.add(reference.key);
    const resourceId = itemId(reference.type, reference.id);
    const { data } = await client.request('GET', `/api/v1/courses/${course}/${endpoints[reference.type]}/${encodeURIComponent(resourceId)}`);
    const link = describe(client, course, reference.type, data);
    if (!link) throw new Error(`Course link ${reference.key} is unpublished, unavailable, or missing its browser URL`);
    if (reference.type !== 'page' && link.id !== resourceId) throw new Error('Canvas returned a different course item');
    const label = reference.label === undefined ? link.title : reference.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 255 || /[\r\n]/.test(label)) throw new Error('Course link label must be one line, 1 to 255 characters');
    links.push({ ...link, key: reference.key, label: label.trim() });
  }
  return links;
}
