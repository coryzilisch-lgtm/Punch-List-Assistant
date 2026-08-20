import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { json } from '../lib/http';
import { procoreConfigured } from '../lib/procore';
import { extractionConfigured } from '../lib/extract';

export async function healthHandler(_request: HttpRequest): Promise<HttpResponseInit> {
  return json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    procoreConfigured: procoreConfigured(),
    extractionConfigured: extractionConfigured(),
  });
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: healthHandler,
});
