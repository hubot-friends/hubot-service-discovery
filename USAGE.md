# Hubot Service Discovery - Usage Guide

This package provides both a **script** (for server instances) and an **adapter** (for client instances) to enable horizontal scaling of Hubot through service discovery.

## Architecture Overview

```
Chat Provider → Hubot Server (Script) → Multiple Hubot Clients (Adapter)
                    ↓
               Service Discovery
                    ↓
              Load Balancing
```

## Setup Options

### Option 1: Server Instance (Script Mode)
The server instance runs the chat provider adapter AND the service discovery script.

#### Installation
```bash
npm install hubot-service-discovery
```

#### Configuration
Add to your `external-scripts.json`:
```json
[
  "hubot-service-discovery/service-discovery.mjs"
]
```

#### Environment Variables
```bash
# Service Discovery Server Configuration
HUBOT_DISCOVERY_PORT=3100                    # Port for service discovery server
HUBOT_DISCOVERY_STORAGE=./data     # Storage directory for event store
HUBOT_DISCOVERY_TIMEOUT=30000               # Heartbeat timeout in ms

# Instance Configuration  
HUBOT_SERVICE_NAME=hubot                     # Service name for registration
HUBOT_INSTANCE_ID=server                     # Unique instance identifier
HUBOT_HOST=localhost                         # Host address for this instance
HUBOT_PORT=8080                             # Port for this instance
HUBOT_HEARTBEAT_INTERVAL=15000              # Heartbeat interval in ms
```

#### Start Command
```bash
# Start with your chat provider adapter (e.g., Slack)
HUBOT_DISCOVERY_PORT=3100 hubot -a slack
```

### Option 2: Client Instance (Adapter Mode)
Client instances connect to the server and receive load-balanced messages.

#### Installation
```bash
npm install hubot-service-discovery
```

#### Environment Variables
```bash
# Required: Service Discovery Server URL
HUBOT_DISCOVERY_URL=ws://your-server:3100

# Instance Configuration
HUBOT_SERVICE_NAME=hubot                     # Must match server service name
HUBOT_INSTANCE_ID=client-1                   # Unique identifier for this client
HUBOT_HOST=localhost                         # Host where this client runs
HUBOT_PORT=8080                             # Port where this client runs
HUBOT_HEARTBEAT_INTERVAL=15000              # Heartbeat interval in ms
```

#### Start Command
```bash
# Start with the service discovery adapter
HUBOT_DISCOVERY_URL=ws://your-server:3100 \\
HUBOT_INSTANCE_ID=client-1 \\
hubot -a hubot-service-discovery
```

## Complete Example Setup

### Server Instance (handles chat provider)
```bash
# Terminal 1 - Server with Slack adapter
export HUBOT_SLACK_TOKEN=xoxb-your-token
export HUBOT_DISCOVERY_PORT=3100
export HUBOT_SERVICE_NAME=hubot
export HUBOT_INSTANCE_ID=server
export HUBOT_HOST=192.168.1.100
export HUBOT_PORT=8080

hubot -a slack
```

### Client Instance 1
```bash
# Terminal 2 - First client
export HUBOT_DISCOVERY_URL=ws://192.168.1.100:3100
export HUBOT_SERVICE_NAME=hubot
export HUBOT_INSTANCE_ID=client-1
export HUBOT_HOST=192.168.1.101
export HUBOT_PORT=8081

hubot -a hubot-service-discovery
```

### Client Instance 2
```bash
# Terminal 3 - Second client
export HUBOT_DISCOVERY_URL=ws://192.168.1.100:3100
export HUBOT_SERVICE_NAME=hubot
export HUBOT_INSTANCE_ID=client-2
export HUBOT_HOST=192.168.1.102
export HUBOT_PORT=8082

hubot -a hubot-service-discovery
```

## Available Commands

When using the script (server mode), these commands are available in chat:

- `hubot discover services` - Show all registered services
- `hubot discover hubots` - Show all registered Hubot instances  
- `hubot discovery status` - Show service discovery status
- `hubot brain peers` - Show brain peer connections

## How Messages Flow

1. **User sends message** → Chat Provider (Slack, etc.)
2. **Chat Provider** → Server Hubot instance (with chat adapter + script)
3. **Server Hubot** → Processes message OR forwards to available client
4. **Client Hubot** → Processes message and responds
5. **Response flows back** → Server → Chat Provider → User

## Load Balancing

The server instance automatically load balances messages across healthy client instances using:
- **Instance availability**: Based on heartbeat status (instances are healthy if heartbeat within timeout window)
- **Configurable strategies**: Round-robin (default), random, or least-connections
- **Instance capabilities**: Metadata-based routing considerations
- **Automatic failover**: Unhealthy instances are excluded automatically

### Load Balancing Strategies

1. **Round-Robin** (default): Distributes messages evenly across all healthy instances in order
2. **Random**: Randomly selects from available healthy instances
3. **Least-Connections**: Routes to the instance with the fewest active connections (based on metadata)

### Configuration

```bash
# Set strategy via environment variable
HUBOT_LB_STRATEGY=round-robin  # or random, least-connections

# Or change dynamically via chat commands
hubot lb strategy random
hubot lb status
hubot lb reset  # Reset round-robin counter
```

## Monitoring

Check service discovery status:
```bash
# In your chat
@hubot discovery status
@hubot discover hubots
```

View logs for connection status, heartbeats, and message routing.

## Troubleshooting

### Common Issues

1. **Client can't connect**: Check `HUBOT_DISCOVERY_URL` points to server
2. **No load balancing**: Ensure clients are registering (check heartbeats)
3. **Messages not routing**: Verify `HUBOT_SERVICE_NAME` matches across instances
4. **Connection drops**: Check network connectivity and firewall settings

### Debug Mode
```bash
HUBOT_LOG_LEVEL=debug hubot -a <adapter>
```

This will show detailed service discovery activity including connections, registrations, and message routing.
