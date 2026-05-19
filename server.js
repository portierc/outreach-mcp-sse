import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

// CORS for n8n compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// API Key Authentication Middleware
const API_KEY = process.env.MCP_API_KEY;

function authenticateRequest(req, res, next) {
  if (!API_KEY) {
    return next();
  }
  const authHeader = req.headers.authorization;
  const queryKey = req.query.api_key;
  const providedKey = authHeader?.replace('Bearer ', '') || queryKey;
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid or missing API key' });
  }
  next();
}

// Outreach API client
const OUTREACH_BASE_URL = 'https://api.outreach.io/api/v2';
let accessToken = process.env.OUTREACH_ACCESS_TOKEN;
const refreshToken = process.env.OUTREACH_REFRESH_TOKEN;
const clientId = process.env.OUTREACH_CLIENT_ID;
const clientSecret = process.env.OUTREACH_CLIENT_SECRET;
const redirectUri = process.env.OUTREACH_REDIRECT_URI || 'https://localhost/callback';

async function refreshAccessToken() {
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Cannot refresh token - missing OUTREACH_REFRESH_TOKEN, OUTREACH_CLIENT_ID, or OUTREACH_CLIENT_SECRET');
  }
  const res = await fetch('https://api.outreach.io/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  console.log('Outreach access token refreshed');
  return accessToken;
}

async function outreachFetch(path, options = {}) {
  if (!accessToken) {
    await refreshAccessToken();
  }

  const url = path.startsWith('http') ? path : `${OUTREACH_BASE_URL}${path}`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/vnd.api+json',
    ...options.headers,
  };

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401 && refreshToken) {
    await refreshAccessToken();
    headers['Authorization'] = `Bearer ${accessToken}`;
    res = await fetch(url, { ...options, headers });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Outreach API error: ${res.status} ${err}`);
  }

  if (res.status === 204) return { data: null };
  return res.json();
}

// Create MCP Server with tools
function createMcpServer() {
  const server = new McpServer({
    name: 'outreach-mcp',
    version: '1.0.0',
  });

  // List Prospects
  server.tool(
    'list_prospects',
    'List prospects from Outreach with optional filtering',
    {
      filter: z.string().optional().describe('Filter query (e.g., "filter[emails]=john@example.com")'),
      page_size: z.number().optional().describe('Number of results per page (max 1000)'),
      page_offset: z.number().optional().describe('Pagination offset'),
    },
    async ({ filter, page_size, page_offset }) => {
      const params = new URLSearchParams();
      if (page_size) params.set('page[size]', String(page_size));
      if (page_offset) params.set('page[offset]', String(page_offset));
      // Parse filter string like "filter[emails]=john@example.com"
      if (filter) {
        const match = filter.match(/^filter\[(.+?)\]=(.+)$/);
        if (match) params.set(`filter[${match[1]}]`, match[2]);
      }
      const qs = params.toString();
      const result = await outreachFetch(`/prospects${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Get Prospect
  server.tool(
    'get_prospect',
    'Get a specific prospect by ID',
    { id: z.number().describe('Prospect ID') },
    async ({ id }) => {
      const result = await outreachFetch(`/prospects/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Create Prospect
  server.tool(
    'create_prospect',
    'Create a new prospect in Outreach',
    {
      emails: z.array(z.string()).describe('Email addresses'),
      firstName: z.string().optional().describe('First name'),
      lastName: z.string().optional().describe('Last name'),
      title: z.string().optional().describe('Job title'),
      company: z.string().optional().describe('Company name'),
      tags: z.array(z.string()).optional().describe('Tags to apply'),
      customFields: z.record(z.any()).optional().describe('Custom field values — maps to Outreach {{variable N}} placeholders (e.g., {"custom1": "value", "custom34": "personalized text"})'),
    },
    async ({ emails, firstName, lastName, title, company, tags, customFields }) => {
      const attributes = { emails };
      if (firstName) attributes.firstName = firstName;
      if (lastName) attributes.lastName = lastName;
      if (title) attributes.title = title;
      if (company) attributes.company = company;
      if (tags) attributes.tags = tags;
      if (customFields) Object.assign(attributes, customFields);

      const result = await outreachFetch('/prospects', {
        method: 'POST',
        body: JSON.stringify({ data: { type: 'prospect', attributes } }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Update Prospect
  server.tool(
    'update_prospect',
    'Update an existing prospect',
    {
      id: z.number().describe('Prospect ID'),
      data: z.record(z.any()).describe('Attributes to update (e.g., {"firstName": "Jane", "title": "VP Sales"})'),
    },
    async ({ id, data }) => {
      const result = await outreachFetch(`/prospects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'prospect', id, attributes: data } }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // List Sequences
  server.tool(
    'list_sequences',
    'List sequences from Outreach',
    {
      page_size: z.number().optional().describe('Number of results per page'),
    },
    async ({ page_size }) => {
      const params = new URLSearchParams();
      if (page_size) params.set('page[size]', String(page_size));
      const qs = params.toString();
      const result = await outreachFetch(`/sequences${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Get Sequence
  server.tool(
    'get_sequence',
    'Get a specific sequence by ID',
    { id: z.number().describe('Sequence ID') },
    async ({ id }) => {
      const result = await outreachFetch(`/sequences/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Add Prospect to Sequence
  server.tool(
    'add_prospect_to_sequence',
    'Add a prospect to a sequence',
    {
      prospectId: z.number().describe('Prospect ID'),
      sequenceId: z.number().describe('Sequence ID'),
      mailboxId: z.number().optional().describe('Mailbox ID to send from'),
    },
    async ({ prospectId, sequenceId, mailboxId }) => {
      const body = {
        data: {
          type: 'sequenceState',
          relationships: {
            prospect: { data: { type: 'prospect', id: prospectId } },
            sequence: { data: { type: 'sequence', id: sequenceId } },
          },
        },
      };
      if (mailboxId) {
        body.data.relationships.mailbox = { data: { type: 'mailbox', id: mailboxId } };
      }
      const result = await outreachFetch('/sequenceStates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Check if Prospect is in a Sequence
  server.tool(
    'check_prospect_in_sequence',
    'Check if a prospect is already enrolled in a specific sequence (or any sequence)',
    {
      prospectId: z.number().describe('Prospect ID'),
      sequenceId: z.number().optional().describe('Sequence ID (omit to check all sequences)'),
    },
    async ({ prospectId, sequenceId }) => {
      const params = new URLSearchParams();
      params.set('filter[prospect][id]', String(prospectId));
      if (sequenceId) {
        params.set('filter[sequence][id]', String(sequenceId));
      }
      const result = await outreachFetch(`/sequenceStates?${params.toString()}`);
      const states = result.data || [];
      if (states.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ enrolled: false, message: 'Prospect is not in this sequence' }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ enrolled: true, sequenceStates: states }, null, 2) }] };
    }
  );

  // List Accounts
  server.tool(
    'list_accounts',
    'List accounts from Outreach',
    {
      filter: z.string().optional().describe('Filter query (e.g., "filter[domain]=example.com")'),
      page_size: z.number().optional().describe('Number of results per page'),
    },
    async ({ filter, page_size }) => {
      const params = new URLSearchParams();
      if (page_size) params.set('page[size]', String(page_size));
      if (filter) {
        const match = filter.match(/^filter\[(.+?)\]=(.+)$/);
        if (match) params.set(`filter[${match[1]}]`, match[2]);
      }
      const qs = params.toString();
      const result = await outreachFetch(`/accounts${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Get Account
  server.tool(
    'get_account',
    'Get a specific account by ID',
    { id: z.number().describe('Account ID') },
    async ({ id }) => {
      const result = await outreachFetch(`/accounts/${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // List Mailings (sent emails)
  server.tool(
    'list_mailings',
    'List mailings (sent emails) from Outreach',
    {
      page_size: z.number().optional().describe('Number of results per page'),
      filter: z.string().optional().describe('Filter query'),
    },
    async ({ page_size, filter }) => {
      const params = new URLSearchParams();
      if (page_size) params.set('page[size]', String(page_size));
      if (filter) {
        const match = filter.match(/^filter\[(.+?)\]=(.+)$/);
        if (match) params.set(`filter[${match[1]}]`, match[2]);
      }
      const qs = params.toString();
      const result = await outreachFetch(`/mailings${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // List Tasks
  server.tool(
    'list_tasks',
    'List tasks from Outreach',
    {
      page_size: z.number().optional().describe('Number of results per page'),
      filter: z.string().optional().describe('Filter query (e.g., "filter[state]=incomplete")'),
    },
    async ({ page_size, filter }) => {
      const params = new URLSearchParams();
      if (page_size) params.set('page[size]', String(page_size));
      if (filter) {
        const match = filter.match(/^filter\[(.+?)\]=(.+)$/);
        if (match) params.set(`filter[${match[1]}]`, match[2]);
      }
      const qs = params.toString();
      const result = await outreachFetch(`/tasks${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // Search (generic endpoint query)
  server.tool(
    'api_request',
    'Make a generic GET request to any Outreach API v2 endpoint',
    {
      endpoint: z.string().describe('API endpoint path (e.g., "/users", "/mailboxes", "/templates")'),
      params: z.record(z.string()).optional().describe('Query parameters as key-value pairs'),
    },
    async ({ endpoint, params }) => {
      const searchParams = new URLSearchParams(params || {});
      const qs = searchParams.toString();
      const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
      const result = await outreachFetch(`${path}${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  return server;
}

// Store transports by session ID
const transports = {};

// MCP endpoint - Streamable HTTP transport
app.post('/mcp', authenticateRequest, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });
    transports[newSessionId] = transport;

    const server = createMcpServer();
    await server.connect(transport);

    console.log('New MCP session:', newSessionId);
  } else if (sessionId && !transports[sessionId]) {
    res.status(400).json({ error: 'Invalid session ID' });
    return;
  } else {
    res.status(400).json({ error: 'Missing session ID or not an initialize request' });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', authenticateRequest, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

app.delete('/mcp', authenticateRequest, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].close();
    delete transports[sessionId];
    console.log('Session closed:', sessionId);
  }
  res.status(200).json({ status: 'ok' });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'outreach-mcp', transport: 'streamable-http' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Outreach MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp (Streamable HTTP)`);
});
