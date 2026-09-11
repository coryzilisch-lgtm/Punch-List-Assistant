/**
 * Entry point. Azure Functions v4 discovers routes by side effect of the
 * app.http() call in each module, so every function file must be required here
 * or its route silently 404s.
 */
import './functions/health';
import './functions/me';
import './functions/projects';
import './functions/inspect';
import './functions/probe';
import './functions/extract';
import './functions/push';
import './functions/resend';
