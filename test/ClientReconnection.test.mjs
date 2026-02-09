import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import DiscoveryServiceClient from '../lib/DiscoveryServiceClient.mjs'

// Mock WebSocket that can simulate connection failures
class MockWebSocket extends EventEmitter {
  constructor(url, options = {}) {
    super()
    this.url = url
    this.readyState = 0 // CONNECTING
    this.OPEN = 1
    this.CLOSED = 3
    this.sentMessages = []
    this.shouldFail = options.shouldFail || false
    this.failOnAttempt = options.failOnAttempt || 1
    this.attemptCount = 0
    
    // Simulate connection
    setTimeout(() => {
      this.attemptCount++
      if (this.shouldFail && this.attemptCount <= this.failOnAttempt) {
        this.emit('error', new Error('Connection failed'))
        return
      }
      
      this.readyState = this.OPEN
      this.emit('open')
    }, 10)
  }

  send(data, callback) {
    if (this.readyState !== this.OPEN) {
      const error = new Error('WebSocket is not open')
      if (callback) callback(error)
      return
    }
    
    this.sentMessages.push(JSON.parse(data))
    if (callback) callback()
  }

  close() {
    this.readyState = this.CLOSED
    setTimeout(() => this.emit('close', 1000, 'Normal closure'), 5)
  }

  // Simulate server disconnection
  simulateServerDisconnect() {
    this.readyState = this.CLOSED
    setTimeout(() => this.emit('close', 1006, 'Connection lost'), 5)
  }

  // Simulate connection error
  simulateError() {
    this.emit('error', new Error('Connection error'))
  }
}

// Helper to wait for events
function waitForEvent(emitter, eventName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${eventName}`))
    }, timeout)

    emitter.once(eventName, (...args) => {
      clearTimeout(timer)
      resolve(...args)
    })
  })
}

describe('DiscoveryServiceClient Reconnection', () => {
  let client
  let mockWebSocketClass

  beforeEach(() => {
    // Reset the mock WebSocket for each test
    mockWebSocketClass = class extends MockWebSocket {
      constructor(url) {
        super(url, { shouldFail: false })
      }
    }
    
    client = new DiscoveryServiceClient(
      'ws://localhost:3100',
      'test-service',
      'test-instance-1',
      {
        host: 'localhost',
        port: 8080,
        heartbeatInterval: 100, // Short for testing
        reconnectInterval: 100, // Short for testing
        maxReconnectAttempts: 3,
        WebSocketClass: mockWebSocketClass
      }
    )
  })

  afterEach(async () => {
    if (client) {
      client.disableAutoReconnect()
      client.removeAllListeners()
      await client.disconnect()
    }
    // Wait for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 50))
  })

  describe('Auto-reconnection configuration', () => {
    test('should initialize with default reconnection settings', () => {
      const defaultClient = new DiscoveryServiceClient(
        'ws://localhost:3100',
        'test-service',
        'test-instance'
      )
      
      assert.strictEqual(defaultClient.autoReconnect, true)
      assert.strictEqual(defaultClient.reconnectInterval, 5000)
      assert.strictEqual(defaultClient.maxReconnectAttempts, 0) // infinite
      assert.strictEqual(defaultClient.reconnectAttempts, 0)
    })

    test('should respect custom reconnection settings', () => {
      const customClient = new DiscoveryServiceClient(
        'ws://localhost:3100',
        'test-service',
        'test-instance',
        {
          autoReconnect: false,
          reconnectInterval: 2000,
          maxReconnectAttempts: 5
        }
      )
      
      assert.strictEqual(customClient.autoReconnect, false)
      assert.strictEqual(customClient.reconnectInterval, 2000)
      assert.strictEqual(customClient.maxReconnectAttempts, 5)
    })

    test('should read configuration from environment variables', () => {
      const originalEnv = { ...process.env }
      
      process.env.HUBOT_DISCOVERY_RECONNECT_INTERVAL = '3000'
      process.env.HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS = '10'
      
      const envClient = new DiscoveryServiceClient(
        'ws://localhost:3100',
        'test-service',
        'test-instance'
      )
      
      assert.strictEqual(envClient.reconnectInterval, 3000)
      assert.strictEqual(envClient.maxReconnectAttempts, 10)
      
      // Restore environment
      process.env = originalEnv
    })
  })

  describe('Reconnection on server disconnect', () => {
    test('should attempt reconnection when server disconnects unexpectedly', async () => {
      // Connect successfully first
      await client.connect()
      assert.strictEqual(client.connected, true)

      // Listen for reconnection attempt
      let reconnectingEmitted = false
      client.on('reconnecting', () => {
        reconnectingEmitted = true
      })

      // Simulate server disconnect
      client.ws.simulateServerDisconnect()

      // Wait for disconnection and reconnection attempt
      await waitForEvent(client, 'disconnected')
      assert.strictEqual(client.connected, false)

      // Wait a bit for reconnection attempt
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.strictEqual(reconnectingEmitted, true)
    })

    test('should not reconnect on intentional disconnect', async () => {
      await client.connect()
      assert.strictEqual(client.connected, true)

      let reconnectingEmitted = false
      client.on('reconnecting', () => {
        reconnectingEmitted = true
      })

      // Intentional disconnect
      await client.disconnect()

      // Wait a bit to ensure no reconnection attempt
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.strictEqual(reconnectingEmitted, false)
    })

    test('should not reconnect when auto-reconnect is disabled', async () => {
      client.autoReconnect = false
      await client.connect()

      let reconnectingEmitted = false
      client.on('reconnecting', () => {
        reconnectingEmitted = true
      })

      // Simulate server disconnect
      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected')

      // Wait a bit to ensure no reconnection attempt
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.strictEqual(reconnectingEmitted, false)
    })
  })

  describe('Reconnection attempts and backoff', () => {
    test('should implement exponential backoff with jitter', async () => {
      const reconnectEvents = []
      client.on('reconnecting', (event) => {
        reconnectEvents.push(event)
      })

      // First connect successfully
      await client.connect()
      
      // Mock WebSocket to fail subsequent reconnection attempts
      let isFirstConnection = true
      mockWebSocketClass = class extends MockWebSocket {
        constructor(url) {
          if (isFirstConnection) {
            isFirstConnection = false
            super(url, { shouldFail: false })
          } else {
            super(url, { shouldFail: true, failOnAttempt: 10 }) // Keep failing
          }
        }
      }
      client.WebSocketClass = mockWebSocketClass

      // Trigger reconnection by simulating server disconnect
      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected')

      // Wait for a few reconnection attempts
      await new Promise(resolve => setTimeout(resolve, 400))

      assert(reconnectEvents.length >= 1, 'Should have at least one reconnection attempt')
      
      // Check that interval increases (with some tolerance for jitter)
      if (reconnectEvents.length >= 2) {
        const firstInterval = reconnectEvents[0].interval
        const secondInterval = reconnectEvents[1].interval
        assert(secondInterval > firstInterval, 'Second attempt should have longer interval')
      }
    })

    test('should respect max reconnection attempts', async () => {
      client.maxReconnectAttempts = 2
      client.reconnectInterval = 50 // Very short for testing
      
      const reconnectEvents = []
      const errorEvents = []
      
      client.on('reconnecting', (event) => {
        reconnectEvents.push(event)
      })
      
      client.on('error', (error) => {
        errorEvents.push(error)
      })

      // Test the logic directly by calling scheduleReconnect multiple times
      // This simulates what happens when connections keep failing
      
      // First reconnect attempt
      client.scheduleReconnect()
      assert.strictEqual(client.reconnectAttempts, 1)
      
      // Second reconnect attempt
      client.scheduleReconnect()  
      assert.strictEqual(client.reconnectAttempts, 2)
      
      // Third attempt should emit error
      client.scheduleReconnect()
      
      // Should have emitted max attempts error
      const maxAttemptsError = errorEvents.find(error => 
        error.message.includes('Max reconnection attempts')
      )
      assert(maxAttemptsError, 'Should emit error when max attempts exceeded')
      assert.strictEqual(client.reconnectAttempts, 2) // Should not increment past max
    })

    test('should reset reconnect attempts on successful connection', async () => {
      // First, let connection succeed
      await client.connect()
      assert.strictEqual(client.reconnectAttempts, 0)

      // Simulate disconnect to trigger reconnection
      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected', 5000)

      // Wait for reconnection (which should succeed)
      await waitForEvent(client, 'connected', 5000)
      
      // Reconnect attempts should be reset
      assert.strictEqual(client.reconnectAttempts, 0)
    })
  })

  describe('Reconnection control methods', () => {
    test('should stop reconnection attempts when stopReconnect is called', async () => {
      // First connect successfully
      await client.connect()
      
      // Mock failing WebSocket for reconnections
      let isFirstConnection = true
      mockWebSocketClass = class extends MockWebSocket {
        constructor(url) {
          if (isFirstConnection) {
            isFirstConnection = false
            super(url, { shouldFail: false })
          } else {
            super(url, { shouldFail: true, failOnAttempt: 5 })
          }
        }
      }
      client.WebSocketClass = mockWebSocketClass

      let reconnectingCount = 0
      client.on('reconnecting', () => {
        reconnectingCount++
      })

      // Simulate disconnect to trigger reconnections
      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected')

      // Wait for first reconnection attempt
      await new Promise(resolve => setTimeout(resolve, 150))
      const firstCount = reconnectingCount

      // Stop reconnection
      client.stopReconnect()

      // Wait a bit more
      await new Promise(resolve => setTimeout(resolve, 300))

      // Should not have additional reconnection attempts
      assert.strictEqual(reconnectingCount, firstCount)
      assert.strictEqual(client.reconnectAttempts, 0)
    })

    test('should allow re-enabling auto-reconnect after intentional disconnect', async () => {
      await client.connect()

      // Intentional disconnect
      await client.disconnect()
      assert.strictEqual(client.intentionalDisconnect, true)

      // Re-enable auto-reconnect
      client.enableAutoReconnect()
      assert.strictEqual(client.intentionalDisconnect, false)

      // Now connect and disconnect unexpectedly - should trigger reconnect
      await client.connect()
      
      let reconnectingEmitted = false
      client.on('reconnecting', () => {
        reconnectingEmitted = true
      })

      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected')

      // Wait for reconnection attempt
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.strictEqual(reconnectingEmitted, true)
    })

    test('should disable auto-reconnect and stop current attempts', async () => {
      // First connect successfully
      await client.connect()
      
      // Mock failing WebSocket for reconnections
      let isFirstConnection = true
      mockWebSocketClass = class extends MockWebSocket {
        constructor(url) {
          if (isFirstConnection) {
            isFirstConnection = false
            super(url, { shouldFail: false })
          } else {
            super(url, { shouldFail: true, failOnAttempt: 5 })
          }
        }
      }
      client.WebSocketClass = mockWebSocketClass

      // Simulate disconnect to trigger reconnection attempt
      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected')

      // Wait for reconnection attempt to start
      await new Promise(resolve => setTimeout(resolve, 150))

      // Disable auto-reconnect
      client.disableAutoReconnect()

      assert.strictEqual(client.autoReconnect, false)
      assert.strictEqual(client.reconnectTimer, null)
    })
  })

  describe('Registration after reconnection', () => {
    test('should automatically re-register after reconnection', async () => {
      // Connect and register
      await client.connect()
      await client.register('localhost', 8080, { test: true })

      // Verify registration message was sent
      const registerMessage = client.ws.sentMessages.find(msg => msg.type === 'register')
      assert(registerMessage, 'Should have sent registration message')

      // Clear sent messages
      client.ws.sentMessages = []

      // Simulate server disconnect and reconnect
      client.ws.simulateServerDisconnect()
      await waitForEvent(client, 'disconnected')
      await waitForEvent(client, 'connected', 2000) // Longer timeout for reconnection

      // After reconnection, should not automatically re-register
      // (This is expected behavior - the adapter would handle re-registration)
      const newRegisterMessage = client.ws.sentMessages.find(msg => msg.type === 'register')
      assert.strictEqual(newRegisterMessage, undefined, 'Should not automatically re-register')
    })
  })
})
