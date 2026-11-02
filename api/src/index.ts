/**
 * Entry point. Azure Functions v4 discovers routes by side effect of the
 * app.http() call in each module, so every function file must be required here
 * or its route silently 404s.
 */
import { app } from '@azure/functions';
import { registerGuestGate } from './lib/guest-gate';

// Guest accounts are refused on every route before any handler runs (Nov 2026):
// see lib/guest-gate.ts. Registered first so no function module can come before it.
registerGuestGate(app, 'The Punch List Assistant');

import './functions/health';
import './functions/me';
import './functions/projects';
import './functions/inspect';
import './functions/probe';
import './functions/extract';
import './functions/push';
import './functions/quota';
import './functions/procore-auth';
