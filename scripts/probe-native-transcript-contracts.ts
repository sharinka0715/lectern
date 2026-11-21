import { readFile } from 'node:fs/promises';
import { MessageDisplay } from '../src/core/message-display';

// Reproduce audited native record shapes without launching Claude Code.
interface ProjectionCase {
  name: string;
  sessionId: string;
  records: Record<string, unknown>[];
  expected: { role: string; text: string }[];
}
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/native-contracts/transcript-projections.json', import.meta.url), 'utf8')) as {
  scope: string;
  cases: ProjectionCase[];
};
const results = fixture.cases.map(({ name, sessionId, records, expected }) => {
  const display = new MessageDisplay(sessionId);
  display.ingestJsonl(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const actual = display.getMessages().map(({ role, text }) => ({ role, text }));
  return { name, matches: JSON.stringify(actual) === JSON.stringify(expected), expected, actual };
});
console.log(JSON.stringify({ scope: fixture.scope, passed: results.filter(result => result.matches).length,
  total: results.length, results }, null, 2));
if (results.some(result => !result.matches)) process.exitCode = 2;
