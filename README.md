# Hubot Service Discovery

A hubot service discovery service to scale Hubot instances with built-in load balancing.

Chat provider → Hubot Service Discovery (with load balancing) → Hubot instances with Service Discovery Adapter

## Overview

This package provides comprehensive service discovery and load balancing for Hubot instances:

- **Service Registration**: Automatic registration and health monitoring of Hubot instances
- **Load Balancing**: Distribute incoming messages across healthy instances using configurable strategies
- **Message Routing**: Route messages to available instances with response tracking
- **Health Monitoring**: Real-time health checks and automatic failover
- **Brain Synchronization**: Optional peer-to-peer brain connections for shared state

The Hubot Service Discovery script provides WebSocket-based service discovery for distributed Hubot instances. It allows Hubot bots to:

- Register themselves with a central discovery service
- Discover other Hubot instances in the cluster
- Send heartbeats to maintain service health
- Automatically deregister when shutting down

The script can operate in two modes:
- **Server Mode**: When `HUBOT_DISCOVERY_URL` is not set, starts its own discovery server
- **Client Mode**: When `HUBOT_DISCOVERY_URL` is set, connects to an existing discovery server

## Environment Variables

### Service Discovery Server Configuration

- `HUBOT_DISCOVERY_PORT` - Port for the discovery server (default: 3100)
- `HUBOT_DISCOVERY_STORAGE` - Storage directory for event store (default: ./discovery-data)
- `HUBOT_DISCOVERY_TIMEOUT` - Heartbeat timeout in ms (default: 30000)
- `HUBOT_LB_STRATEGY` - Load balancing strategy: round-robin, random, least-connections (default: round-robin)

### Service Registration Configuration

- `HUBOT_SERVICE_NAME` - Service name for registration (default: 'hubot')
- `HUBOT_INSTANCE_ID` - Unique instance identifier (default: hostname-timestamp)
- `HUBOT_HOST` - Host address for this instance (default: 'localhost')
- `HUBOT_PORT` - Port for this Hubot instance (default: 8080)
- `HUBOT_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 15000)

### Client Mode Configuration

- `HUBOT_DISCOVERY_URL` - URL of discovery server to connect to (e.g., 'ws://discovery-server:3100')

### Auto-Reconnection Configuration

- `HUBOT_DISCOVERY_RECONNECT_INTERVAL` - Initial reconnection interval in milliseconds (default: 5000)
- `HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS` - Maximum reconnection attempts, 0 for infinite (default: 0)

## Installation

Add the script to your Hubot project:

```bash
npm install hubot-service-discovery
```

Then load it in your Hubot:

```javascript
// In your hubot's main file or external-scripts.json
import serviceDiscovery from 'hubot-service-discovery'

export default function(robot) {
  serviceDiscovery(robot)
}
```

Or add to `external-scripts.json`:
```json
["hubot-service-discovery"]
```

## Basic Usage

### Starting the Discovery Server (First Instance)

```bash
# This instance will start the discovery server
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=hubot-server \
HUBOT_DISCOVERY_PORT=3100 \
HUBOT_HOST=localhost \
HUBOT_PORT=8080 \
npm start
```

### Starting Client Instances

```bash
# These instances will connect to the discovery server
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=hubot-client-1 \
HUBOT_DISCOVERY_URL=ws://localhost:3100 \
HUBOT_HOST=localhost \
HUBOT_PORT=8081 \
npm start
```

### Using the Built-in Commands

Once your Hubot instances are running, you can use these commands in chat:

```
# Discover all services
hubot discover services

# Discover only Hubot instances  
hubot discover hubots

# Check discovery status
hubot discovery status

# Connect brain to a peer (if supported)
hubot connect to hostname:port

# Check brain peer connections
hubot brain peers

# Load balancing commands (server instance only)
hubot load balancer status    # Show load balancer statistics
hubot lb strategy round-robin # Change to round-robin strategy
hubot lb strategy random      # Change to random strategy  
hubot lb strategy least-connections # Change to least-connections strategy
hubot lb reset               # Reset round-robin counter
hubot test routing hello     # Test message routing
```

## Load Balancing

The service discovery server includes intelligent load balancing to distribute incoming messages across healthy client instances.

### Load Balancing Strategies

- **round-robin** (default): Cycles through instances in order
- **random**: Selects instances randomly  
- **least-connections**: Routes to instance with fewest active connections

### Configuration

Set the load balancing strategy via environment variable:
```bash
HUBOT_LB_STRATEGY=round-robin  # or random, least-connections
```

Or change it dynamically via chat commands:
```
hubot lb strategy random
```

### Message Flow

1. **Chat Provider** → Server Hubot instance
2. **Load Balancer** selects healthy client instance using configured strategy
3. **Message** routed to selected client with unique tracking ID
4. **Client** processes message and sends response back
5. **Server** forwards response to chat provider

### Health Monitoring

- Client instances send heartbeats every 15 seconds (configurable)
- Instances are considered unhealthy if heartbeat is older than 30 seconds (configurable)
- Unhealthy instances are automatically excluded from load balancing
- Server instances are never included in load balancing (they handle routing)

## WebSocket API

The service discovery uses WebSocket communication on the configured discovery port. Messages are JSON formatted.

### Message Types

#### Register a Service
```json
{
  "type": "register",
  "data": {
    "serviceName": "hubot",
    "instanceId": "hubot-pod-1", 
    "host": "10.0.1.10",
    "port": 8080,
    "metadata": {
      "adapter": "slack",
      "brain": "automerge", 
      "version": "1.0.0",
      "name": "mybot"
    }
  }
}
```

#### Discover Services
```json
{
  "type": "discover",
  "data": {
    "serviceName": "hubot"  // optional, omit to discover all
  }
}
```

#### Send Heartbeat
```json
{
  "type": "heartbeat",
  "data": {
    "serviceName": "hubot",
    "instanceId": "hubot-pod-1"
  }
}
```

#### Deregister Service
```json
{
  "type": "deregister", 
  "data": {
    "serviceName": "hubot",
    "instanceId": "hubot-pod-1"
  }
}
```

#### Health Check
```json
{
  "type": "health",
  "data": {}
}
```

### Response Format

All responses follow this structure:
```json
{
  "success": true|false,
  "message": "description",
  "data": { /* response data */ },
  "error": "error message if success=false"
}
```

## Kubernetes Examples

### Deployment YAML

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: service-discovery
  labels:
    app: service-discovery
spec:
  replicas: 1
  selector:
    matchLabels:
      app: service-discovery
  template:
    metadata:
      labels:
        app: service-discovery
    spec:
      containers:
      - name: service-discovery
        image: node:24-alpine
        workingDir: /app
        command: ["npm", "start"]
        ports:
        - containerPort: 3100
          protocol: TCP
        env:
        - name: NODE_ENV
          value: "production"
        volumeMounts:
        - name: data-volume
          mountPath: /data
        livenessProbe:
          httpGet:
            path: /health
            port: 3100
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3100
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: data-volume
        persistentVolumeClaim:
          claimName: discovery-data-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: service-discovery
spec:
  selector:
    app: service-discovery
  ports:
  - port: 3100
    targetPort: 3100
    protocol: TCP
  type: ClusterIP
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: discovery-data-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

### ConfigMap for Hubot Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubot-config
data:
  HUBOT_SERVICE_DISCOVERY_URL: "http://service-discovery:3100"
  HUBOT_SERVICE_NAME: "hubot"
  HUBOT_HEARTBEAT_INTERVAL: "15000"
```

## JavaScript Client Example

### WebSocket Client for Service Discovery

```javascript
import WebSocket from 'ws'

class ServiceDiscoveryClient {
  constructor(discoveryUrl, serviceName, instanceId) {
    this.discoveryUrl = discoveryUrl
    this.serviceName = serviceName
    this.instanceId = instanceId
    this.ws = null
    this.heartbeatInterval = null
    this.isRegistered = false
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.discoveryUrl.replace('http', 'ws')
      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        console.log(`Connected to service discovery at ${wsUrl}`)
        resolve()
      })

      this.ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString())
          this.handleMessage(response)
        } catch (error) {
          console.error('Error parsing message:', error)
        }
      })

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error)
        reject(error)
      })

      this.ws.on('close', () => {
        console.log('Disconnected from service discovery')
        this.cleanup()
      })
    })
  }

  async register(host, port, metadata = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to service discovery')
    }

    const message = {
      type: 'register',
      data: {
        serviceName: this.serviceName,
        instanceId: this.instanceId,
        host,
        port,
        metadata
      }
    }

    this.ws.send(JSON.stringify(message))
    // Start heartbeat after registration
    this.startHeartbeat()
  }

  async discover(serviceName = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to service discovery')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discovery request timeout'))
      }, 5000)

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data.toString())
          if (response.success && response.data) {
            clearTimeout(timeout)
            this.ws.removeListener('message', messageHandler)
            resolve(response.data)
          }
        } catch (error) {
          // Ignore parse errors, might be other messages
        }
      }

      this.ws.on('message', messageHandler)

      const message = {
        type: 'discover',
        data: { serviceName }
      }

      this.ws.send(JSON.stringify(message))
    })
  }

  startHeartbeat(intervalMs = 15000) {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const message = {
          type: 'heartbeat',
          data: {
            serviceName: this.serviceName,
            instanceId: this.instanceId
          }
        }
        this.ws.send(JSON.stringify(message))
      }
    }, intervalMs)
  }

  async deregister() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'deregister',
        data: {
          serviceName: this.serviceName,
          instanceId: this.instanceId
        }
      }
      this.ws.send(JSON.stringify(message))
    }
    this.cleanup()
  }

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.isRegistered = false
  }

  handleMessage(response) {
    if (response.success) {
      if (response.message && response.message.includes('registered')) {
        this.isRegistered = true
        console.log(`Registered as ${this.instanceId}`)
      }
    } else {
      console.error('Service discovery error:', response.error)
    }
  }
}

// Usage Example
const client = new ServiceDiscoveryClient(
  'ws://localhost:3100',
  'my-service',
  'instance-1'
)

try {
  await client.connect()
  await client.register('10.0.1.100', 8080, { 
    version: '1.0.0',
    environment: 'production'
  })

  // Discover other services
  const hubotInstances = await client.discover('hubot')
  console.log('Available hubot instances:', hubotInstances)

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    await client.deregister()
    process.exit(0)
  })
} catch (error) {
  console.error('Failed to connect:', error)
}
```

## Docker Compose Example

```yaml
version: '3.8'

services:
  # Discovery server (first Hubot instance)
  hubot-discovery:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./:/app
    ports:
      - "3100:3100"  # Discovery WebSocket server
      - "8080:8080"   # Hubot HTTP server
    environment:
      - NODE_ENV=development
      - HUBOT_DISCOVERY_PORT=3100
      - HUBOT_SERVICE_NAME=hubot
      - HUBOT_INSTANCE_ID=hubot-discovery
      - HUBOT_HOST=hubot-discovery
      - HUBOT_PORT=8080
      - HUBOT_LOG_LEVEL=debug
    command: npm start
    volumes:
      - discovery-data:/app/discovery-data

  # Additional Hubot instances
  hubot-worker-1:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./:/app
    environment:
      - NODE_ENV=development
      - HUBOT_SERVICE_NAME=hubot
      - HUBOT_INSTANCE_ID=hubot-worker-1
      - HUBOT_HOST=hubot-worker-1
      - HUBOT_PORT=8080
      - HUBOT_LOG_LEVEL=debug
    command: npm start
    depends_on:
      - hubot-discovery

  hubot-worker-2:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./:/app
    environment:
      - NODE_ENV=development
      - HUBOT_SERVICE_NAME=hubot
      - HUBOT_INSTANCE_ID=hubot-worker-2
      - HUBOT_HOST=hubot-worker-2
      - HUBOT_PORT=8080
      - HUBOT_LOG_LEVEL=debug
    command: npm start
    depends_on:
      - hubot-discovery

volumes:
  discovery-data:
```

## Kubernetes Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubot-discovery
  labels:
    app: hubot-discovery
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hubot-discovery
  template:
    metadata:
      labels:
        app: hubot-discovery
    spec:
      containers:
      - name: hubot
        image: your-hubot-image:latest
        ports:
        - containerPort: 3100
          name: discovery
        - containerPort: 8080
          name: http
        env:
        - name: HUBOT_DISCOVERY_PORT
          value: "3100"
        - name: HUBOT_SERVICE_NAME
          value: "hubot"
        - name: HUBOT_INSTANCE_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: HUBOT_HOST
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: HUBOT_PORT
          value: "8080"
        volumeMounts:
        - name: discovery-data
          mountPath: /app/discovery-data
        livenessProbe:
          tcpSocket:
            port: 3100
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          tcpSocket:
            port: 3100
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: discovery-data
        persistentVolumeClaim:
          claimName: discovery-data-pvc

---
apiVersion: v1
kind: Service
metadata:
  name: hubot-discovery
spec:
  selector:
    app: hubot-discovery
  ports:
  - name: discovery
    port: 3100
    targetPort: 3100
  - name: http
    port: 8080
    targetPort: 8080
  type: ClusterIP

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubot-workers
  labels:
    app: hubot-workers
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hubot-workers
  template:
    metadata:
      labels:
        app: hubot-workers
    spec:
      containers:
      - name: hubot
        image: your-hubot-image:latest
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: HUBOT_SERVICE_NAME
          value: "hubot"
        - name: HUBOT_INSTANCE_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: HUBOT_HOST
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: HUBOT_PORT
          value: "8080"
        livenessProbe:
          tcpSocket:
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: discovery-data-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

## Testing the Setup

1. **Start the services:**
   ```bash
   docker-compose up -d
   ```

2. **Check discovery status in any Hubot:**
   ```
   hubot discovery status
   ```

3. **Discover other instances:**
   ```
   hubot discover hubots
   ```

4. **View logs:**
   ```bash
   docker-compose logs -f hubot-discovery
   ```

The WebSocket-based service discovery provides real-time registration, heartbeats, and discovery for your distributed Hubot cluster.
