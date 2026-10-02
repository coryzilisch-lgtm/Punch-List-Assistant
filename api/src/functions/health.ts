import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { json } from '../lib/http';
import { procoreConfigured } from '../lib/procore';
import { aiConfigured, modelConfig } from '../lib/model';

export async function healthHandler(_request: HttpRequest): Promise<HttpResponseInit> {
  return json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    procoreConfigured: procoreConfigured(),
    extractionConfigured: aiConfigured(),
    aiProvider: modelConfig()?.provider ?? null,
    aiModel: modelConfig()?.model || null,
  });
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: healthHandler,
});
