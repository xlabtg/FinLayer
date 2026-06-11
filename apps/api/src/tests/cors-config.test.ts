import { describe, expect, test } from 'bun:test';

import { resolveCorsOrigins } from '../config/cors.js';

describe('CORS configuration (issue #24)', () => {
  test('requires an explicit origin allow-list when credentials are enabled', () => {
    expect(() => resolveCorsOrigins(undefined)).toThrow('CORS_ORIGINS');
    expect(() => resolveCorsOrigins('')).toThrow('CORS_ORIGINS');
    expect(() => resolveCorsOrigins(' , ')).toThrow('CORS_ORIGINS');
  });

  test('rejects wildcard origins when credentials are enabled', () => {
    expect(() => resolveCorsOrigins('*')).toThrow('must not include "*"');
    expect(() => resolveCorsOrigins('https://app.example.com,*')).toThrow('must not include "*"');
  });

  test('parses a comma-separated explicit allow-list', () => {
    expect(resolveCorsOrigins(' https://app.example.com,https://admin.example.com ')).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
  });
});
