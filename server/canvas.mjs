const MAX_PAGES = 2000;

function id(value, label) {
  const result = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(result)) throw new Error(`${label} must be a positive Canvas ID`);
  return result;
}

function percentage(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 to 100`);
  }
  return value;
}

function validateCriteria(criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) throw new Error("criteria is required");
  const audience = criteria.audience ?? 'filtered';
  if (!['all_students', 'filtered'].includes(audience)) throw new Error('Invalid audience');
  if (audience === 'filtered' && !criteria.grade && !criteria.activity) throw new Error('Add a grade or activity criterion, or explicitly choose audience all_students');
  if (audience === 'all_students' && (criteria.grade || criteria.activity)) throw new Error('Use audience filtered when adding grade or activity conditions');
  let sectionIds;
  if (criteria.section_ids !== undefined) {
    if (!Array.isArray(criteria.section_ids) || !criteria.section_ids.length || criteria.section_ids.length > 50) throw new Error('Choose 1 to 50 section IDs');
    sectionIds = [...new Set(criteria.section_ids.map(value => id(value, 'section_id')))];
  }
  const combine = criteria.combine ?? "all";
  if (!['all', 'any'].includes(combine)) throw new Error("combine must be all or any");
  if (criteria.grade) {
    const grade = criteria.grade;
    if (!['course', 'assignment'].includes(grade.scope)) throw new Error("grade.scope must be course or assignment");
    if (!['below', 'above', 'at_or_below', 'at_or_above'].includes(grade.comparison)) throw new Error("Invalid grade comparison");
    percentage(grade.percent, "grade.percent");
    if (grade.scope === 'assignment') id(grade.assignment_id, 'assignment_id');
    if (grade.scope === 'course' && !['current_score', 'final_score'].includes(grade.metric ?? 'current_score')) {
      throw new Error("grade.metric must be current_score or final_score");
    }
  }
  if (criteria.activity) {
    const activity = criteria.activity;
    if (!['inactive_for_days', 'inactive_since'].includes(activity.kind)) throw new Error("Invalid activity.kind");
    if (activity.kind === 'inactive_for_days' && (!Number.isInteger(activity.days) || activity.days < 1 || activity.days > 3650)) {
      throw new Error("activity.days must be an integer from 1 to 3650");
    }
    if (activity.kind === 'inactive_since' && (typeof activity.since !== 'string' ||
        !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(activity.since) || !Number.isFinite(Date.parse(activity.since)) || Date.parse(activity.since) > Date.now())) {
      throw new Error('activity.since must be a past ISO 8601 timestamp with timezone');
    }
    if (typeof activity.include_never_active !== 'boolean') throw new Error("activity.include_never_active must be true or false");
  }
  return { ...criteria, audience, combine, ...(sectionIds ? { section_ids: sectionIds } : {}) };
}

function compare(value, comparison, threshold) {
  if (comparison === 'below') return value < threshold;
  if (comparison === 'above') return value > threshold;
  if (comparison === 'at_or_below') return value <= threshold;
  return value >= threshold;
}

function firstName(user) {
  const source = (user.short_name || user.name || '').trim();
  return source.split(/\s+/)[0] || 'there';
}

export function renderMessage(template, user, links = []) {
  if (typeof template !== 'string' || !template.trim()) throw new Error('body_template is required');
  if (template.length > 10000) throw new Error('body_template is too long');
  const full = (user.name || user.short_name || '').trim() || firstName(user);
  const first = firstName(user);
  const personalized = /\{\{(?:first_name|full_name)\}\}/.test(template);
  const linkMap = new Map(links.map(link => [link.key, link]));
  const used = new Set();
  for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    if (!['first_name', 'full_name'].includes(match[1]) && !(match[1].startsWith('link:') && linkMap.has(match[1].slice(5)))) throw new Error('Unsupported or unresolved message placeholder');
  }
  const rendered = template.replace(/\{\{(first_name|full_name|link:[^}]+)\}\}/g, (_, key) => {
    if (key === 'first_name') return first;
    if (key === 'full_name') return full;
    const link = linkMap.get(key.slice(5));
    used.add(link.key);
    return `${link.label}: ${link.url}`;
  }).trim();
  const remaining = links.filter(link => !used.has(link.key));
  const appendix = remaining.length ? `\n\nCourse links:\n${remaining.map(link => `${link.label}: ${link.url}`).join('\n')}` : '';
  const body = (personalized ? rendered : `Hi ${first},\n\n${rendered}`) + appendix;
  if (body.length > 10000) throw new Error('Personalized message with course links is too long');
  return body;
}

export class CanvasClient {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CANVAS_BASE_URL must be an HTTPS origin');
    }
    if (!token) throw new Error('Canvas token is unavailable. Run scripts/set-token.ps1 on Windows or scripts/set-token.sh on macOS.');
    this.origin = url.origin;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(method, path, params = {}, body) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid Canvas API URL');
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) value.forEach(item => url.searchParams.append(`${key}[]`, String(item)));
      else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json+canvas-string-ids',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const error = new Error(`Canvas API returned HTTP ${response.status} for ${method} ${url.pathname}`);
      error.httpStatus = response.status;
      throw error;
    }
    return { data: await response.json(), next: this.nextLink(response.headers.get('link')) };
  }

  nextLink(header) {
    if (!header) return null;
    const part = header.split(',').find(x => /rel="next"/.test(x));
    if (!part) return null;
    const match = part.match(/<([^>]+)>/);
    if (!match) return null;
    const url = new URL(match[1], this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Unsafe Canvas pagination link');
    return url.toString();
  }

  async all(path, params = {}) {
    let next = path;
    let query = { per_page: 100, ...params };
    const result = [];
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const response = await this.request('GET', next, query);
      if (!Array.isArray(response.data)) throw new Error('Expected a list from Canvas');
      result.push(...response.data);
      next = response.next;
      query = {};
    }
    if (next) throw new Error('Canvas pagination exceeded the supported limit');
    return result;
  }

  async listCourses() {
    const courses = await this.all('/api/v1/courses', {
      enrollment_type: 'teacher', enrollment_state: 'active', state: ['available']
    });
    return courses.filter(course => course.workflow_state === 'available' && course.course_code)
      .map(course => ({
        id: String(course.id), name: course.name, course_code: course.course_code,
        start_at: course.start_at || null, end_at: course.end_at || null
      }));
  }

  async listAssignments(courseId) {
    return (await this.all(`/api/v1/courses/${id(courseId, 'course_id')}/assignments`, { bucket: 'published' }))
      .map(assignment => ({ id: String(assignment.id), name: assignment.name, points_possible: assignment.points_possible, published: assignment.published }));
  }

  async selectRecipients(courseId, rawCriteria, now = new Date()) {
    const course = id(courseId, 'course_id');
    const criteria = validateCriteria(rawCriteria);
    let selectedSections = [];
    if (criteria.section_ids) {
      const sections = await this.listSections(course);
      selectedSections = sections.filter(section => criteria.section_ids.includes(section.id));
      if (selectedSections.length !== criteria.section_ids.length) throw new Error('Every selected section must belong to the selected course and be accessible to the instructor');
    }
    const enrollments = await this.all(`/api/v1/courses/${course}/enrollments`, {
      type: ['StudentEnrollment'], state: ['active']
    });
    const byUser = new Map();
    for (const enrollment of enrollments) {
      if (enrollment.type !== 'StudentEnrollment' || enrollment.enrollment_state !== 'active' || !enrollment.user) continue;
      if (enrollment.course_id !== undefined && String(enrollment.course_id) !== course) continue;
      if (criteria.section_ids && !criteria.section_ids.includes(String(enrollment.course_section_id))) continue;
      const key = String(enrollment.user_id);
      const prior = byUser.get(key);
      if (!prior || Date.parse(enrollment.last_activity_at || 0) > Date.parse(prior.last_activity_at || 0)) byUser.set(key, enrollment);
    }
    let scores = new Map();
    let assignmentName = null;
    if (criteria.grade?.scope === 'assignment') {
      const assignmentId = id(criteria.grade.assignment_id, 'assignment_id');
      const { data: assignment } = await this.request('GET', `/api/v1/courses/${course}/assignments/${assignmentId}`);
      if (!assignment.published || !(Number(assignment.points_possible) > 0)) {
        throw new Error('Assignment must be published and have points_possible greater than zero');
      }
      assignmentName = assignment.name;
      const submissions = await this.all(`/api/v1/courses/${course}/assignments/${assignmentId}/submissions`, { enrollment_state: 'active' });
      scores = new Map(submissions.filter(s => s.posted_at && !s.excused && Number.isFinite(Number(s.score)) && s.score !== null)
        .map(s => [String(s.user_id), Number(s.score) / Number(assignment.points_possible) * 100]));
    }
    const recipients = [];
    const exclusions = { missing_grade: 0, no_recorded_activity: 0 };
    const cutoff = criteria.activity?.kind === 'inactive_since'
      ? Date.parse(criteria.activity.since)
      : now.getTime() - (criteria.activity?.days ?? 0) * 86400000;
    for (const enrollment of byUser.values()) {
      const userId = String(enrollment.user_id);
      const user = { id: userId, name: enrollment.user.name, short_name: enrollment.user.short_name };
      const predicates = [];
      let gradePercent = null;
      if (criteria.grade) {
        const rawGrade = criteria.grade.scope === 'assignment'
          ? scores.get(userId)
          : enrollment.grades?.[criteria.grade.metric ?? 'current_score'];
        gradePercent = rawGrade === undefined || rawGrade === null || rawGrade === '' ? null : Number(rawGrade);
        if (gradePercent === undefined || gradePercent === null || !Number.isFinite(gradePercent)) {
          exclusions.missing_grade++;
          predicates.push(false);
        } else predicates.push(compare(gradePercent, criteria.grade.comparison, criteria.grade.percent));
      }
      if (criteria.activity) {
        const last = enrollment.last_activity_at ? Date.parse(enrollment.last_activity_at) : NaN;
        if (!Number.isFinite(last)) exclusions.no_recorded_activity++;
        predicates.push(Number.isFinite(last)
          ? (criteria.activity.kind === 'inactive_since' ? last < cutoff : last <= cutoff)
          : criteria.activity.include_never_active);
      }
      const matched = criteria.audience === 'all_students' || (criteria.combine === 'all' ? predicates.every(Boolean) : predicates.some(Boolean));
      if (matched) recipients.push({ user, grade_percent: gradePercent, last_activity_at: enrollment.last_activity_at || null });
    }
    recipients.sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
    return { recipients, exclusions, evaluated: byUser.size, assignment_name: assignmentName, criteria, selected_sections: selectedSections };
  }

  async listSections(courseId) {
    const course = id(courseId, 'course_id');
    return (await this.all(`/api/v1/courses/${course}/sections`))
      .filter(section => String(section.course_id) === course)
      .map(section => ({ id: id(section.id, 'section_id'), course_id: course, name: section.name, start_at: section.start_at || null, end_at: section.end_at || null }));
  }

  async sendOne(courseId, recipient, subject, body) {
    const form = new URLSearchParams();
    form.append('recipients[]', id(recipient.user.id, 'student_id'));
    form.set('subject', subject);
    form.set('body', body);
    form.set('group_conversation', 'false');
    form.set('context_code', `course_${id(courseId, 'course_id')}`);
    return this.request('POST', '/api/v1/conversations', {}, form);
  }
}

export { validateCriteria, id };
