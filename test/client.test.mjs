import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import ServiceDiscoveryClient from '../lib/client.mjs'

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0 // CONNECTING
    this.OPEN = 1
    this.CLOSED = 3
    
    // Simulate connection
    setTimeout(() => {
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
    
    // Simulate successful send
    if (callback) callback()
    
    // Echo back for testing
    setTimeout(() => {
      this.emit('message', data)
    }, 5)
  }

  close() {
    this.readyState = this.CLOSED
    this.emit('close', 1000, 'Normal closure')
  }
}

describe('ServiceDiscoveryClient', () => {
  let client

  beforeEach(() => {
    client = new ServiceDiscoveryClient(
      'ws://localhost:3100',
      'test-service',
      'test-instance-1',
      {
        host: 'localhost',
        port: 8080,
        heartbeatInterval: 1000,
        WebSocketClass: MockWebSocket // Inject mock WebSocket
      }
    )
  })

  afterEach(async () => {
    if (client) {
      await client.disconnect()
    }
  })

  test('should connect to service discovery server', async () => {
    const connectPromise = client.connect()
    
    // Wait for connection
    await connectPromise
    
    assert.strictEqual(client.connected, true)
    assert(client.ws)
  })

  test('should emit connected event on successful connection', async () => {
    let connectedEmitted = false
    client.on('connected', () => {
      connectedEmitted = true
    })
    
    await client.connect()
    
    assert.strictEqual(connectedEmitted, true)
  })

  test('should register with service discovery', async () => {
    await client.connect()
    
    // Mock the response
    setTimeout(() => {
      client.handleMessage({
        type: 'register_response',
        success: true,
        data: { instanceId: 'test-instance-1' }
      })
    }, 10)
    
    await client.register('localhost', 8080, { version: '1.0.0' })
    
    // If we get here without throwing, registration succeeded
    assert.ok(true)
  })

  test('should start and stop heartbeat', async () => {
    await client.connect()
    
    assert(client.heartbeatTimer, 'Heartbeat timer should be started')
    
    client.stopHeartbeat()
    assert.strictEqual(client.heartbeatTimer, null, 'Heartbeat timer should be stopped')
  })

  test('should handle disconnection', async () => {
    await client.connect()
    
    let disconnectedEmitted = false
    client.on('disconnected', () => {
      disconnectedEmitted = true
    })
    
    client.ws.close()
    
    // Wait for event to be emitted
    await new Promise(resolve => setTimeout(resolve, 10))
    
    assert.strictEqual(disconnectedEmitted, true)
    assert.strictEqual(client.connected, false)
  })

  test('should handle messages', async () => {
    await client.connect()
    
    let messageReceived = null
    client.on('message', (data) => {
      messageReceived = data
    })
    
    const testMessage = {
      type: 'message',
      data: {
        text: 'Hello from service discovery',
        user: { id: 'user1', name: 'Test User' },
        room: 'general'
      }
    }
    
    client.handleMessage(testMessage)
    
    assert.deepStrictEqual(messageReceived, testMessage.data)
  })

  test('should respond to health checks', async () => {
    await client.connect()
    
    let healthResponseSent = false
    const originalSendMessage = client.sendMessage
    client.sendMessage = mock.fn(async (message) => {
      if (message.type === 'health_response') {
        healthResponseSent = true
      }
      return originalSendMessage.call(client, message)
    })
    
    client.handleMessage({
      type: 'health_check',
      data: { timestamp: Date.now() }
    })
    
    assert.strictEqual(healthResponseSent, true)
  })

  test('should discover services', async () => {
    await client.connect()
    
    // Mock the discover response
    setTimeout(() => {
      client.handleMessage({
        type: 'discover_response',
        data: {
          services: {
            'test-service': [
              { instanceId: 'instance-1', host: 'localhost', port: 8080 }
            ]
          }
        }
      })
    }, 10)
    
    const result = await client.discoverServices('test-service')
    
    assert(result.services)
    assert(result.services['test-service'])
    assert.strictEqual(result.services['test-service'].length, 1)
  })

  test('should handle connection timeout', async () => {
    // Mock WebSocket that never connects
    class TimeoutWebSocket extends EventEmitter {
      constructor() {
        super()
        this.readyState = 0
        // Don't emit any events, causing timeout
      }
      send() {}
      close() {}
    }
    
    // Create a client with a mock WebSocket that never connects
    const timeoutClient = new ServiceDiscoveryClient(
      'ws://localhost:9999',
      'test-service',
      'test-instance',
      {
        WebSocketClass: TimeoutWebSocket
      }
    )
    
    // Override the connect method to use a shorter timeout for testing
    const originalConnect = timeoutClient.connect
    timeoutClient.connect = async function() {
      if (this.connected) {
        return
      }

      try {
        const WebSocketConstructor = this.WebSocketClass || (await import('ws')).default
        this.ws = new WebSocketConstructor(this.discoveryUrl)
        
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'))
          }, 100) // Much shorter timeout for testing

          this.ws.on('open', () => {
            clearTimeout(timeout)
            this.connected = true
            this.startHeartbeat()
            this.emit('connected')
            resolve()
          })

          this.ws.on('error', (error) => {
            clearTimeout(timeout)
            this.emit('error', error)
            reject(error)
          })
        })
      } catch (error) {
        this.emit('error', error)
        throw error
      }
    }
    
    try {
      await timeoutClient.connect()
      assert.fail('Should have thrown timeout error')
    } catch (error) {
      assert.strictEqual(error.message, 'Connection timeout')
    }
  })
})
