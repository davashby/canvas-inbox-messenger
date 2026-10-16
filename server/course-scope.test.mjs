import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CourseScope } from './course-scope.mjs';

test('discovery works before setup and leaves the saved scope unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-scope-test-'));
  try {
    const client = { listCourses: async () => [
      { id: '76', name: 'Section A', course_code: 'ABC123' },
      { id: '77', name: 'Section B', course_code: 'ABC123' }
    ] };
    const scope = new CourseScope({ path: join(directory, 'scope.json'), client });
    const initial = await scope.available();
    assert.equal(initial.configured, false);
    assert.deepEqual(initial.courses.map(course => [course.id, course.selected]), [['76', false], ['77', false]]);
    assert.equal(await scope.load(), null);
    await assert.rejects(scope.assertAllowed('76'), /not configured/);
    await scope.configure({ course_codes: ['ABC123'], course_ids: ['77'] });
    const saved = await scope.load();
    const available = await scope.available();
    assert.deepEqual(available.courses.map(course => [course.id, course.selected]), [['76', false], ['77', true]]);
    assert.deepEqual(await scope.load(), saved);
    await assert.rejects(scope.assertAllowed('76'), /outside/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires teacher codes, resolves only live matches, persists IDs, and blocks past courses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-scope-test-'));
  try {
    let courses = [
      { id: '5', name: 'Current Section', course_code: 'ABC123' },
      { id: '6', name: 'Old Section', course_code: 'OLD123' }
    ];
    const client = { listCourses: async () => courses };
    const path = join(directory, 'scope.json');
    const scope = new CourseScope({ path, client });
    await assert.rejects(scope.assertAllowed('5'), /not configured/);
    await assert.rejects(scope.configure({ course_codes: ['NOPE'] }), /No active/);
    const configured = await scope.configure({ course_codes: ['abc123'] });
    assert.deepEqual(configured.courses.map(course => course.id), ['5']);
    const freshProcess = new CourseScope({ path, client });
    assert.equal((await freshProcess.assertAllowed('5')).course_code, 'ABC123');
    await assert.rejects(freshProcess.assertAllowed('6'), /outside/);
    courses = [{ id: '6', name: 'Old Section', course_code: 'OLD123' }];
    await assert.rejects(freshProcess.assertAllowed('5'), /no longer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ambiguous course codes require explicit live course IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-scope-test-'));
  try {
    const client = { listCourses: async () => [
      { id: '5', name: 'Section A', course_code: 'ABC123' },
      { id: '7', name: 'Section B', course_code: 'ABC123' }
    ] };
    const scope = new CourseScope({ path: join(directory, 'scope.json'), client });
    await assert.rejects(scope.configure({ course_codes: ['ABC123'] }), /multiple active courses/);
    const configured = await scope.configure({ course_codes: ['ABC123'], course_ids: ['7'] });
    assert.deepEqual(configured.courses.map(course => course.id), ['7']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
