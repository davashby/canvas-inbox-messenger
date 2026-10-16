import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function normalizeCode(value) {
  if (typeof value !== 'string') throw new Error('Course codes must be strings');
  const code = value.trim();
  if (!code || code.length > 100) throw new Error('Each course code must be 1 to 100 characters');
  return code.toLocaleUpperCase('en-US');
}

function normalizeId(value) {
  const result = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(result)) throw new Error('course_ids must contain positive Canvas IDs');
  return result;
}

export class CourseScope {
  constructor({ path, client }) {
    this.path = path;
    this.client = client;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(parsed.courses) || !parsed.courses.length) throw new Error('Invalid saved course scope');
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async configure({ course_codes, course_ids }) {
    if (!Array.isArray(course_codes) || !course_codes.length || course_codes.length > 50) {
      throw new Error('Provide 1 to 50 exact Canvas course codes');
    }
    const codes = [...new Set(course_codes.map(normalizeCode))];
    const eligible = await this.client.listCourses();
    const matches = eligible.filter(course => course.course_code && codes.includes(normalizeCode(course.course_code)));
    const missing = codes.filter(code => !matches.some(course => normalizeCode(course.course_code) === code));
    if (missing.length) throw new Error(`No active, available teacher course matches: ${missing.join(', ')}`);
    let selected;
    if (course_ids !== undefined) {
      if (!Array.isArray(course_ids) || !course_ids.length) throw new Error('course_ids must be a nonempty array when provided');
      const selectedIds = new Set(course_ids.map(normalizeId));
      selected = matches.filter(course => selectedIds.has(course.id));
      if (selected.length !== selectedIds.size || codes.some(code => !selected.some(course => normalizeCode(course.course_code) === code))) {
        throw new Error('Every course ID must match a requested code, and every code must have at least one selected active course');
      }
    } else {
      const ambiguous = codes.filter(code => matches.filter(course => normalizeCode(course.course_code) === code).length !== 1);
      if (ambiguous.length) {
        const choices = matches.filter(course => ambiguous.includes(normalizeCode(course.course_code)))
          .map(course => `${course.course_code}: ${course.name} (ID ${course.id})`).join('; ');
        throw new Error(`Course code matches multiple active courses. Ask the teacher to choose course IDs: ${choices}`);
      }
      selected = matches;
    }
    const config = {
      version: 1,
      updated_at: new Date().toISOString(),
      courses: selected.map(course => ({ id: course.id, course_code: course.course_code, name: course.name }))
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    return config;
  }

  async available() {
    const config = await this.load();
    const courses = await this.client.listCourses();
    return {
      configured: Boolean(config),
      courses: courses.map(course => ({
        ...course,
        selected: Boolean(config?.courses.some(saved => saved.id === course.id &&
          normalizeCode(saved.course_code) === normalizeCode(course.course_code)))
      }))
    };
  }

  async current() {
    const config = await this.load();
    if (!config) return { configured: false, courses: [] };
    const eligible = await this.client.listCourses();
    const active = config.courses.filter(saved => eligible.some(course =>
      course.id === saved.id && normalizeCode(course.course_code) === normalizeCode(saved.course_code)));
    return {
      configured: true, courses: active,
      unavailable_courses: config.courses.filter(saved => !active.some(course => course.id === saved.id)),
      updated_at: config.updated_at
    };
  }

  async assertAllowed(courseId) {
    const config = await this.load();
    if (!config) throw new Error('Course scope is not configured. Call list_available_courses, ask the teacher to choose courses, then call configure_course_codes with their exact codes and IDs.');
    const allowed = config.courses.find(course => course.id === String(courseId));
    if (!allowed) throw new Error('Course is outside the teacher-selected course scope');
    const eligible = await this.client.listCourses();
    const current = eligible.find(course => course.id === allowed.id &&
      normalizeCode(course.course_code) === normalizeCode(allowed.course_code));
    if (!current) throw new Error('Selected course is no longer an active, available teacher course. Reconfigure course codes.');
    return current;
  }
}
