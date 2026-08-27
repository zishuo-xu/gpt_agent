import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from '../src/greeting.js';
import { renderGreeting } from '../src/index.js';

test('renders a greeting with the requested name', () => {
  assert.equal(greeting('Ada'), 'Hello, Ada.');
  assert.equal(renderGreeting('Ada'), 'Hello, Ada!');
});
