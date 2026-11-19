import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyJson } from '../agy-cli.mjs';

// Contoh output ASLI dari `agy --output-format json` (ditangkap saat pengujian).
const SUCCESS = '{"conversation_id":"314821b1-b2e8-4bcc-a354-007f2540ba9d","status":"SUCCESS","response":"OK.\\n","duration_seconds":6.19,"num_turns":1}';
const TIMEOUT_STDOUT = '{"conversation_id":"ff12c9e3-febe-4640-afa5-76bb57494ec9","status":"ERROR","response":"","error":"print timeout after 5s with the turn still in progress; the response is partial","finished_reason":"print_timeout"}';
const TIMEOUT_STDERR = '[agy] print timeout after 5s with turn in progress; returning partial output\nerror: print timeout after 5s\nAGY_ERROR: {"short_error":"print timeout after 5s","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}';
const NOT_FOUND = 'warning: conversation "00000000-0000-0000-0000-000000000000" not found\n{"conversation_id":"a2d9fdd8-da6f-4067-ade8-c89ed4974347","status":"SUCCESS","response":"Halo!\\n"}';

test('[#5] parse output JSON agy', () => {
  assert.equal(parseAgyJson(SUCCESS).conversation_id, '314821b1-b2e8-4bcc-a354-007f2540ba9d');
  assert.equal(parseAgyJson(SUCCESS).response, 'OK.\n');
  assert.equal(parseAgyJson(TIMEOUT_STDOUT).finished_reason, 'print_timeout');
  assert.equal(parseAgyJson(TIMEOUT_STDERR).status, 'DEADLINE_EXCEEDED');
  assert.equal(parseAgyJson(NOT_FOUND).conversation_id, 'a2d9fdd8-da6f-4067-ade8-c89ed4974347');
  assert.equal(parseAgyJson('bukan json'), null);
  assert.equal(parseAgyJson(''), null);
});
