import { describe, expect, test } from 'bun:test';
import { readdir } from 'fs/promises';

const migrationsDir = new URL('../db/migrations/', import.meta.url);
const migrationFilenamePattern = /^(\d{3})_[a-z0-9_]+\.sql$/;

describe('migration filenames', () => {
  test('use unique increasing numeric prefixes in application order', async () => {
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const versions = files.map((file) => {
      const match = file.match(migrationFilenamePattern);

      expect(match, `${file} must start with a zero-padded migration number`).not.toBeNull();

      return Number(match![1]);
    });

    for (let index = 1; index < versions.length; index++) {
      expect(versions[index]!).toBeGreaterThan(versions[index - 1]!);
    }
  });
});
