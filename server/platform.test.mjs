import test from 'node:test';
import assert from 'node:assert/strict';
import { dataDirectory } from './platform.mjs';

test('Windows stores settings in roaming application data, with a profile fallback', () => {
  assert.equal(dataDirectory('win32', { APPDATA: 'D:\\User Data\\Roaming' }, 'C:\\Users\\Teacher'), 'D:\\User Data\\Roaming\\Canvas Inbox Messenger');
  assert.equal(dataDirectory('win32', {}, 'C:\\Users\\Teacher'), 'C:\\Users\\Teacher\\AppData\\Roaming\\Canvas Inbox Messenger');
});

test('Mac settings retain the existing scope location', () => {
  assert.equal(dataDirectory('darwin', {}, '/Users/teacher'), '/Users/teacher/Library/Application Support/Canvas Inbox Messenger');
});
