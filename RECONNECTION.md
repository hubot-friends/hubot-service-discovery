# Client Auto-Reconnection Implementation

## Overview

The ServiceDiscoveryClient now includes robust auto-reconnection capabilities with configurable retry intervals and exponential backoff. This ensures the client maintains connectivity to the service discovery server even during network interruptions or server restarts.

## Features

### Auto-Reconnection Configuration

The client supports the following reconnection options:

```javascript
const client = new ServiceDiscoveryClient(url, serviceName, instanceId, {
  autoReconnect: true,              // Enable/disable auto-reconnection (default: true)
  reconnectInterval: 5000,          // Initial retry interval in ms (default: 5000)
  maxReconnectAttempts: 0,          // Max attempts, 0 = infinite (default: 0)
  // ... other options
})
```

### Environment Variables

You can configure reconnection behavior via environment variables:

- `HUBOT_DISCOVERY_RECONNECT_INTERVAL` - Initial reconnection interval in milliseconds (default: 5000)
- `HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS` - Maximum reconnection attempts, 0 for infinite (default: 0)

Example:
```bash
# Retry every 3 seconds, maximum 10 attempts
export HUBOT_DISCOVERY_RECONNECT_INTERVAL=3000
export HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS=10
```

### Exponential Backoff with Jitter

The reconnection system implements exponential backoff with jitter to prevent thundering herd problems:

- **Base interval**: Configured via `reconnectInterval` option
- **Exponential growth**: Each attempt doubles the interval (capped at 60 seconds)
- **Jitter**: Random ±25% variation to spread out reconnection attempts
- **Reset on success**: Successful connections reset the attempt counter

### Intelligent Reconnection Logic

The client only attempts reconnection in appropriate scenarios:

- ✅ **Unexpected disconnections** (server shutdown, network issues)
- ✅ **Connection errors** during normal operation
- ❌ **Intentional disconnects** (manual `disconnect()` calls)
- ❌ **When auto-reconnect is disabled**

### Events

The client emits the following reconnection-related events:

```javascript
client.on('reconnecting', (event) => {
  console.log(`Reconnection attempt ${event.attempt}/${event.maxAttempts}`)
  console.log(`Next attempt in ${event.interval}ms`)
})

client.on('connected', () => {
  console.log('Successfully reconnected to service discovery')
})

client.on('error', (error) => {
  if (error.message.includes('Max reconnection attempts')) {
    console.log('Gave up reconnecting after maximum attempts')
  }
})
```

### Control Methods

The client provides methods to control reconnection behavior:

```javascript
// Stop current reconnection attempts
client.stopReconnect()

// Re-enable auto-reconnection after intentional disconnect
client.enableAutoReconnect()

// Disable auto-reconnection and stop current attempts
client.disableAutoReconnect()
```

## Implementation Details

### Connection States

The client tracks several internal states:

- `connected`: Whether the WebSocket is currently connected
- `autoReconnect`: Whether auto-reconnection is enabled
- `intentionalDisconnect`: Whether the last disconnect was intentional
- `reconnectAttempts`: Current number of reconnection attempts
- `reconnectTimer`: Timer for the next reconnection attempt

### Adapter Integration

The ServiceDiscoveryAdapter automatically integrates with the client's reconnection system:

- Configures reconnection options from environment variables
- Handles reconnection events for logging and monitoring
- Ensures proper cleanup on adapter shutdown

### Testing

Comprehensive test coverage includes:

- Configuration validation (environment variables, constructor options)
- Reconnection triggers (server disconnect, connection errors)
- Exponential backoff behavior with jitter
- Maximum attempt limits and error handling
- Control method functionality
- Integration with the adapter

## Usage Examples

### Basic Usage

```javascript
// Client with default reconnection settings
const client = new ServiceDiscoveryClient(
  'ws://discovery-server:3100',
  'my-service',
  'instance-1'
)

// Client will automatically reconnect on disconnection
await client.connect()
```

### Custom Configuration

```javascript
// Client with custom reconnection behavior
const client = new ServiceDiscoveryClient(
  'ws://discovery-server:3100',
  'my-service',
  'instance-1',
  {
    reconnectInterval: 2000,    // Start with 2-second intervals
    maxReconnectAttempts: 5,    // Give up after 5 attempts
    autoReconnect: true
  }
)

client.on('reconnecting', (event) => {
  console.log(`Reconnecting... attempt ${event.attempt}`)
})

client.on('error', (error) => {
  if (error.message.includes('Max reconnection attempts')) {
    console.log('Failed to reconnect, switching to offline mode')
    // Handle offline operation
  }
})

await client.connect()
```

### Hubot Adapter Usage

```javascript
// In your Hubot script or configuration
process.env.HUBOT_DISCOVERY_RECONNECT_INTERVAL = '3000'  // 3 seconds
process.env.HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS = '10' // 10 attempts

// The adapter will automatically use these settings
module.exports = (robot) => {
  robot.adapter // ServiceDiscoveryAdapter with auto-reconnection configured
}
```

## Reliability Benefits

1. **Automatic Recovery**: Services maintain connectivity without manual intervention
2. **Graceful Degradation**: Exponential backoff prevents overwhelming a recovering server
3. **Configurable Behavior**: Adapt reconnection strategy to your infrastructure needs
4. **Event-Driven Monitoring**: Track connection health and reconnection events
5. **Intelligent Logic**: Only reconnects when appropriate, respects intentional disconnects

The auto-reconnection system ensures your distributed Hubot instances remain connected and operational even in the face of network instability or server maintenance.
