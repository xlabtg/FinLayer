/**
 * Regression tests for duplicate PostgreSQL pool configuration (issue #35).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests') return [];
      return collectSourceFiles(path);
    }

    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  }));

  return files.flat();
}

describe('database connection factory (issue #35)', () => {
  test('creates postgres pools only through the shared factory', async () => {
    const files = await collectSourceFiles(sourceRoot);
    const directImportFiles: string[] = [];
    const directCallFiles: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const path = relative(sourceRoot, file);

      if (/import\s+postgres\s+from\s+['"]postgres['"]/.test(source)) {
        directImportFiles.push(path);
      }
      if (/\bpostgres\(/.test(source)) {
        directCallFiles.push(path);
      }
    }

    expect(directImportFiles.sort()).toEqual(['db/connection.ts']);
    expect(directCallFiles.sort()).toEqual(['db/connection.ts']);
  });
});
