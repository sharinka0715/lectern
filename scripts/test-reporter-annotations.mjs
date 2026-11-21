// node:test reporter that adds nothing locally and, in GitHub Actions, prints an
// `::error` annotation per failed test once the run ends (test name, file and line,
// the first lines of the assertion or error), so a failed unit test step can be
// read from the run page without the log. `npm test` runs it next to the spec
// reporter. A test file that fails before or outside any test (an import error, a
// crash) is reported with the last lines its process wrote to stderr.
import path from 'node:path';
import { ANNOTATIONS_PER_STEP, errorSummary, failureAnnotations, inGitHubActions, tailSummary } from './gh-annotations.mjs';

// Failure types that only repeat a failure reported on its own.
const echoes = new Set(['subtestsFailed', 'cancelledByParent']);

export default async function* annotations(source) {
  const failures = [];
  const stderr = new Map();
  for await (const event of source) {
    // stderr events name the file as given on the command line, failures with its absolute path.
    if (event.type === 'test:stderr' && event.data.file) {
      const key = path.resolve(event.data.file);
      stderr.set(key, ((stderr.get(key) ?? '') + event.data.message).slice(-4000));
    }
    if (event.type !== 'test:fail' || !inGitHubActions) continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    if (echoes.has(error?.failureType)) continue;
    const cause = error?.cause ?? error;
    let message = errorSummary(cause);
    // Whole-file failures carry only the string 'test failed'; the child's stderr says why.
    const text = typeof cause === 'string' ? cause : String(cause?.message ?? '');
    if (!line || (file && path.resolve(name) === path.resolve(file)) || text === 'test failed') {
      const output = file && stderr.get(path.resolve(file));
      if (output) message = `${message}\n${tailSummary(output, 8)}`;
    }
    const timeout = error?.failureType === 'testTimeoutFailure';
    failures.push({ title: `${timeout ? 'Timed out' : 'Failed'}: ${name}`, file, line, message });
  }
  if (!failures.length) return;
  for (const text of failureAnnotations(failures, { limit: ANNOTATIONS_PER_STEP, what: 'failed tests' })) yield `${text}\n`;
}
