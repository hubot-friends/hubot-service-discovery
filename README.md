# Hubot Service Discovery

**hubot-service-discovery** is a Hubot service discovery system with built-in load balancing and multi-group message routing to horizontally scale Hubot instances across worker groups.

## Architecture Overview
![](architecture-image.png)

The system consists of two main components:

1. **Discovery Service Server** - A Hubot instance loaded with the `DiscoveryService.mjs` script that:
   - Connects to a chat platform (Discord, Slack, Teams, etc.)
   - Receives messages from the chat adapter
   - Routes messages to worker instances for processing
   - Manages worker registration and health tracking

2. **Worker Instances** - Hubot instances that:
   - Connect to the Discovery Service via WebSocket
   - Register themselves with a service group
   - Receive and process routed messages
   - Send responses back through the Discovery Service

## Message Routing with Groups

Worker instances are organized into **service groups**. When a message is received:

1. The Discovery Service groups available workers by their `HUBOT_SERVICE_GROUP`
2. One worker is selected from each group using the configured load balancing strategy
3. The message is routed to the selected workers
4. Each worker processes the message and sends back a response
5. All responses are aggregated and sent back to the chat platform

This design allows you to:
- **Scale horizontally** by adding more worker instances
- **Organize workers logically** via groups (e.g., 'smart-features', 'basic-features', 'admin-only')
- **Ensure fairness** - multiple workers across different groups can respond to the same message
- **Use load balancing** - each group independently uses round-robin, random, or least-connections selection

## Setup: Discovery Service Server

The Discovery Service Server is a Hubot instance that connects to your chat platform and routes messages to worker instances.

### Installation

1. Create or use an existing Hubot instance with your chat adapter:
   ```sh
   npx hubot --create mybot --adapter @hubot-friends/hubot-discord
   ```

2. Install the service discovery package:
   ```sh
   npm i @hubot-friends/hubot-service-discovery
   ```

3. Add `hubot-service-discovery/DiscoveryService.mjs` to your `external-scripts.json`:
   ```json
   [
       "hubot-service-discovery/DiscoveryService.mjs"
   ]
   ```

### Starting the Server

Start the Hubot instance with your chat adapter. The DiscoveryService script will automatically:
- Start a WebSocket server on `HUBOT_DISCOVERY_PORT` (default: 3100)
- Register itself as the server instance
- Begin accepting connections from worker instances
- Route incoming messages to worker instances

```sh
HUBOT_ALLOWED_ORIGINS=http://localhost,https://yourdomain.com hubot -a @hubot-friends/hubot-discord -n mybot
```

## Setup: Worker Instances

Worker instances process messages routed from the Discovery Service. These typically contain your Hubot scripts and logic.

### Installation

1. Create a Hubot instance:
   ```sh
   npx hubot --create mybot-worker
   ```

2. Install the service discovery package:
   ```sh
   npm i @hubot-friends/hubot-service-discovery
   ```

3. Set the adapter to use the DiscoveryServiceAdapter:
   Update your `package.json` start script:
   ```json
   {
       "scripts": {
           "start": "HUBOT_DISCOVERY_URL=ws://localhost:3100 hubot -a @hubot-friends/hubot-service-discovery"
       }
   }
   ```

### Starting a Worker

```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 \
HUBOT_SERVICE_NAME=hubot \
HUBOT_SERVICE_GROUP=smart \
HUBOT_INSTANCE_ID=worker-1 \
npm start
```

Multiple workers in the same group will rotate handling messages (via load balancing). Workers in different groups will all receive copies of messages routed to their group.


## Configuration

### Discovery Service Server Environment Variables

These variables control the server that routes messages to workers:

- `HUBOT_DISCOVERY_PORT` - Port for the WebSocket server (default: 3100)
- `HUBOT_DISCOVERY_STORAGE` - Directory to store event store data (default: ./.data). Stores snapshots plus durable events (register, deregister, expired) for crash recovery
- `HUBOT_DISCOVERY_TIMEOUT` - Heartbeat timeout before marking worker as unhealthy (default: 30000 ms)
- `HUBOT_LB_STRATEGY` - Load balancing strategy per group: `round-robin`, `random`, `least-connections` (default: `round-robin`)
- `HUBOT_ALLOWED_ORIGINS` - Comma-separated list of allowed WebSocket origins (e.g., `http://localhost,https://yourdomain.com`). Only validated for browser connections. If not set, all origins are allowed (insecure but backward compatible)
- `HUBOT_DISCOVERY_TOKEN` - Shared secret token for authentication. If set, all clients must provide this token (recommended for production)
- `HUBOT_MAX_CONNECTIONS_PER_IP` - Maximum simultaneous connections per IP address (default: 5)
- `HUBOT_RATE_LIMIT_MAX_ATTEMPTS` - Maximum connection attempts per rate limit window (default: 10)
- `HUBOT_RATE_LIMIT_WINDOW_MS` - Rate limit window in milliseconds (default: 60000 = 1 minute)
- `HUBOT_SERVICE_NAME` - Service name for registration (default: 'hubot')
- `HUBOT_INSTANCE_ID` - Unique instance identifier (default: generated as `hubot-<Date.now()>`)
- `HUBOT_HOST` - Host address for this instance (default: 'localhost')
- `HUBOT_PORT` - Port for HTTP server (default: 8080)
- `HUBOT_HEARTBEAT_INTERVAL` - Heartbeat interval (default: 15000 ms)

### Worker Instance Environment Variables

These variables control worker instances that process messages:

- `HUBOT_DISCOVERY_URL` - URL of the Discovery Service (e.g., `ws://localhost:3100` or `wss://yourdomain.com:3100`)
- `HUBOT_SERVICE_NAME` - Service name for registration (default: 'hubot')
- `HUBOT_SERVICE_GROUP` - Worker group identifier (default: 'hubot-group'). Workers in the same group rotate handling messages. Each group independently selects one worker per message
- `HUBOT_INSTANCE_ID` - Unique instance identifier (default: generated as `hubot-<Date.now()>`)
- `HUBOT_HOST` - Hostname (default: localhost)
- `HUBOT_PORT` - Port for HTTP server (default: 8080)
- `HUBOT_HEARTBEAT_INTERVAL` - Heartbeat interval (default: 15000 ms)
- `HUBOT_DISCOVERY_RECONNECT_INTERVAL` - Time between reconnection attempts (default: 5000 ms)
- `HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS` - Maximum reconnection attempts, 0 = unlimited (default: 0)
- `HUBOT_DISCOVERY_TOKEN` - Shared secret token for authentication (optional, but recommended)

## Load Balancing Strategies

The load balancer selects one worker per group for each message:

- **`round-robin`** (default) - Cycles through workers in the group sequentially. Each group maintains its own counter, ensuring fair distribution of messages across workers
- **`random`** - Randomly selects a worker from each group
- **`least-connections`** - Selects the worker with the fewest active connections (requires `connections` metadata)

## Security Configuration

The discovery service includes multiple security layers to prevent unauthorized access:

### Shared Secret Token Authentication

Require all clients to provide a valid token when connecting. This is the primary defense against unauthorized access.

**Server Configuration:**
```bash
export HUBOT_DISCOVERY_TOKEN='your-secret-token-here'
```

**Worker Clients:**
```bash
export HUBOT_DISCOVERY_TOKEN='your-secret-token-here'
```

**Browser Console:**
Enter the token in the "Auth Token" field before connecting.

### Origin Validation

For browser-based connections, validate the WebSocket origin header to prevent cross-site attacks:

```bash
# Allow specific origins
export HUBOT_ALLOWED_ORIGINS='http://localhost:8080,https://yourdomain.com'

# Allow all origins (not recommended)
export HUBOT_ALLOWED_ORIGINS='*'
```

**Note:** Direct WebSocket clients (Node.js, CLI) are allowed regardless of origin validation — only browser-based connections are validated.

### Rate Limiting

Limit the number of connection attempts per IP address to prevent brute force attacks:

```bash
# Maximum connection attempts per IP per window (default: 10)
export HUBOT_RATE_LIMIT_MAX_ATTEMPTS=10

# Rate limit window in milliseconds (default: 60000 = 1 minute)
export HUBOT_RATE_LIMIT_WINDOW_MS=60000
```

### Connection Limits Per IP

Restrict the number of simultaneous connections from a single IP address:

```bash
# Maximum concurrent connections per IP (default: 5)
export HUBOT_MAX_CONNECTIONS_PER_IP=5
```

### Recommended Production Setup

For a secure production deployment:

```bash
# On the Discovery Service Server
export HUBOT_DISCOVERY_TOKEN='generate-a-strong-secret-key'
export HUBOT_ALLOWED_ORIGINS='https://yourdomain.com,https://admin.yourdomain.com'
export HUBOT_MAX_CONNECTIONS_PER_IP=10
export HUBOT_RATE_LIMIT_MAX_ATTEMPTS=20
export HUBOT_RATE_LIMIT_WINDOW_MS=60000

# On Worker Instances
export HUBOT_DISCOVERY_TOKEN='generate-a-strong-secret-key'
export HUBOT_DISCOVERY_URL='wss://yourdomain.com:3100'
```

## How Groups Work

Example scenario with 3 workers:
- Worker 1: `HUBOT_SERVICE_GROUP=smart`
- Worker 2: `HUBOT_SERVICE_GROUP=hubot-group` (default)
- Worker 3: `HUBOT_SERVICE_GROUP=hubot-group` (default)

When a message is received:
1. Workers are grouped: `{ smart: [worker1], hubot-group: [worker2, worker3] }`
2. One worker is selected per group:
   - From "smart": worker1 is selected
   - From "hubot-group": worker2 (or worker3, rotating)
3. Message is routed to worker1 and worker2
4. Both workers process the message and send responses
5. Both responses are aggregated and sent back to the chat platform

This allows you to:
- Separate concerns (e.g., admin commands vs. user commands)
- Scale some groups independently (more workers for high-demand groups)
- Ensure specialized workers always see certain messages

