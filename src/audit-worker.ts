// audit-worker Cloudflare Worker
// Issue #727: Receives deployment events from ArgoCD Notifications
// Performs lightweight orchestration tasks (Linear updates, DNS sync, Slack alerts, audit logging)

export interface Env {
  WORKER_TOKEN: string; // Bearer token for authentication (set via wrangler secret)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Validate Bearer token authentication
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' }),
        { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix
    if (token !== env.WORKER_TOKEN) {
      return new Response(
        JSON.stringify({ error: 'Forbidden', message: 'Invalid token' }),
        { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Handle deployment event endpoint
    if (url.pathname === '/deploy-event' && request.method === 'POST') {
      try {
        const event = await request.json();
        
        console.log('Received deployment event:', {
          event: event.event,
          app: event.app,
          status: event.status,
          timestamp: event.timestamp,
        });

        // Process deployment event based on type
        const result = await processDeploymentEvent(event);

        return new Response(
          JSON.stringify({ 
            status: 'processed',
            event: event.event,
            app: event.app,
            result 
          }),
          {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          }
        );
      } catch (error) {
        console.error('Error processing deployment event:', error);
        return new Response(
          JSON.stringify({ 
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Unknown error'
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
    }

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ 
          status: 'healthy',
          service: 'audit-worker',
          timestamp: new Date().toISOString()
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Not Found', message: 'Endpoint not found' }),
      { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};

/**
 * Process deployment event from ArgoCD Notifications
 * Performs lightweight orchestration tasks:
 * - Linear issue updates
 * - DNS synchronization
 * - Slack alerts
 * - Audit logging
 */
async function processDeploymentEvent(event: any): Promise<any> {
  const tasks: string[] = [];

  switch (event.event) {
    case 'deployment':
      // Application successfully deployed
      tasks.push('Update Linear issue status');
      tasks.push('Log successful deployment to audit system');
      // TODO: Implement Linear API call
      // TODO: Implement audit logging
      break;

    case 'sync-failed':
      // Application sync failed
      tasks.push('Create/update Linear issue for sync failure');
      tasks.push('Send Slack alert');
      tasks.push('Log failure to audit system');
      // TODO: Implement Linear API call
      // TODO: Implement Slack webhook
      // TODO: Implement audit logging
      break;

    case 'health-degraded':
      // Application health degraded
      tasks.push('Create/update Linear issue for health degradation');
      tasks.push('Send Slack alert');
      tasks.push('Log health issue to audit system');
      // TODO: Implement Linear API call
      // TODO: Implement Slack webhook
      // TODO: Implement audit logging
      break;

    default:
      tasks.push('Unknown event type - log for review');
  }

  return {
    processed: true,
    tasks,
    timestamp: new Date().toISOString(),
  };
}
