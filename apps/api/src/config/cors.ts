export function resolveCorsOrigins(value = process.env['CORS_ORIGINS']): string[] {
  const origins = value?.split(',').map(origin => origin.trim()).filter(Boolean) ?? [];

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must define at least one explicit origin when CORS credentials are enabled');
  }

  if (origins.includes('*')) {
    throw new Error('CORS_ORIGINS must not include "*" when CORS credentials are enabled');
  }

  return origins;
}
