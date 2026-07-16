import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export default class SafeJsonReporter {
  #outputFile;
  #tests = [];

  constructor(options = {}) {
    this.#outputFile = options.outputFile ?? 'playwright-report/results.json';
  }

  onTestEnd(test, result) {
    this.#tests.push({
      title: test.titlePath().filter(Boolean).join(' > '),
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
    });
  }

  onEnd(result) {
    const tests = this.#tests.slice().sort((left, right) => left.title.localeCompare(right.title));
    const summary = {
      schemaVersion: 1,
      status: result.status,
      counts: tests.reduce((counts, test) => ({
        ...counts,
        [test.status]: (counts[test.status] ?? 0) + 1,
      }), {}),
      tests,
    };
    mkdirSync(dirname(this.#outputFile), { recursive: true });
    writeFileSync(this.#outputFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
}
