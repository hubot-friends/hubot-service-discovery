import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import DiscoveryServiceAdapter from '../DiscoveryServiceAdapter.mjs'

// Mock robot for testing
class MockRobot extends EventEmitter {
  constructor() {
    super()
    this.name = 'test-bot'
    this.logger = {
      info: mock.fn(),
      debug: mock.fn(),
      error: mock.fn(),
      warn: mock.fn()
    }
    this.brain = {
      userForId: mock.fn((id, userData) => ({ id, ...userData }))
    }
    this.TextMessage = class TextMessage {
      constructor(user, text, id) {
        this.user = user
        this.text = text
        this.id = id
      }
    }
    this.receivedMessages = []
  }

  receive(message) {
    this.receivedMessages.push(message)
  }
}

// Mock DiscoveryServiceClient
class MockDiscoveryServiceClient extends EventEmitter {
  constructor(url, serviceName, instanceId, options) {
    super()
    this.url = url
    this.serviceName = serviceName
    this.instanceId = instanceId
    this.options = options
    this.connected = false
    this.registered = false
    this.timers = []
  }

  async connect() {
    this.connected = true
    const timer = setTimeout(() => this.emit('connected'), 10)
    this.timers.push(timer)
  }

  async register(host, port, metadata) {
    if (!this.connected) {
      throw new Error('Not connected')
    }
    this.registered = true
    this.registrationData = { host, port, metadata }
  }

  async sendMessage(message) {
    if (!this.connected) {
      throw new Error('Not connected')
    }
    this.lastSentMessage = message
  }

  async disconnect() {
    this.connected = false
    this.registered = false
    const timer = setTimeout(() => this.emit('disconnected', { code: 1000, reason: 'Normal' }), 10)
    this.timers.push(timer)
  }

  cleanup() {
    // Clear all pending timers
    this.timers.forEach(timer => clearTimeout(timer))
    this.timers = []
    this.removeAllListeners()
  }

  enableAutoReconnect() {
    // Mock implementation
  }

  disableAutoReconnect() {
    // Mock implementation
  }

  stopReconnect() {
    // Mock implementation
  }
}

describe('DiscoveryServiceAdapter', () => {
  let adapter
  let robot
  let originalEnv

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env }
    
    // Set required environment variables
    process.env.HUBOT_DISCOVERY_URL = 'ws://localhost:3100'
    process.env.HUBOT_SERVICE_NAME = 'test-service'
    process.env.HUBOT_INSTANCE_ID = 'test-instance'
    process.env.HUBOT_HOST = 'localhost'
    process.env.HUBOT_PORT = '8080'
    
    robot = new MockRobot()
    
    // Mock the client in the adapter
    const originalClient = adapter?.client
    if (originalClient) {
      originalClient.disconnect?.()
    }
    
    adapter = new DiscoveryServiceAdapter(robot)
    adapter.client = new MockDiscoveryServiceClient(
      adapter.discoveryUrl,
      adapter.serviceName,
      adapter.instanceId,
      {
        host: adapter.host,
        port: adapter.port,
        heartbeatInterval: 1000,
        metadata: { adapter: 'service-discovery', version: '1.0.0' }
      }
    )
    
    // Re-setup event handlers with the mock client
    adapter.setupEventHandlers()
  })

  afterEach(async () => {
    // Restore environment
    process.env = originalEnv
    
    // Cleanup adapter and mock client
    if (adapter) {
      if (adapter.client && typeof adapter.client.cleanup === 'function') {
        adapter.client.cleanup()
      }
      await adapter.close()
    }
  })

  test('should require HUBOT_DISCOVERY_URL', () => {
    delete process.env.HUBOT_DISCOVERY_URL
    
    assert.throws(() => {
      new DiscoveryServiceAdapter(new MockRobot())
    }, /HUBOT_DISCOVERY_URL is required/)
  })

  test('should initialize with correct configuration', () => {
    assert.strictEqual(adapter.discoveryUrl, 'ws://localhost:3100')
    assert.strictEqual(adapter.serviceName, 'test-service')
    assert.strictEqual(adapter.instanceId, 'test-instance')
    assert.strictEqual(adapter.host, 'localhost')
    assert.strictEqual(adapter.port, 8080)
  })

  test('should connect and register on run', async () => {
    adapter.on('connected', () => {
      assert.strictEqual(adapter.client.connected, true)
      assert.strictEqual(adapter.client.registered, true)
      assert(adapter.client.registrationData)
      assert.strictEqual(adapter.client.registrationData.host, 'localhost')
      assert.strictEqual(adapter.client.registrationData.port, 8080)
    })
    await adapter.run()
  })

  test('should emit connected event when client connects', async () => {
    let connectedEmitted = false
    adapter.on('connected', () => {
      connectedEmitted = true
    })
    
    await adapter.run()
    
    // Wait for the connected event to be emitted
    await new Promise(resolve => setTimeout(resolve, 20))
    
    assert.strictEqual(connectedEmitted, true)
  })

  test('should handle incoming messages', async () => {
    await adapter.run()
    
    const messageData = {
      user: { id: 'user1', name: 'Test User', room: 'general' },
      text: 'Hello from service discovery',
      room: 'general',
      id: 'msg-123'
    }
    
    adapter.client.emit('message', messageData)
    
    // Check that the robot received the message
    assert.strictEqual(robot.receivedMessages.length, 1)
    
    const receivedMessage = robot.receivedMessages[0]
    assert.strictEqual(receivedMessage.text, 'Hello from service discovery')
    assert.strictEqual(receivedMessage.user.id, 'user1')
    assert.strictEqual(receivedMessage.room, 'general')
  })

  test('should send messages through client', async () => {
    await adapter.run()
    
    const envelope = {
      room: 'general',
      user: { id: 'user1', name: 'Test User' },
      message: { id: 'msg-123', messageId: 'msgId-456' }
    }
    
    await adapter.send(envelope, 'Hello', 'World')
    
    // Check that messages were sent through the client
    assert(adapter.client.lastSentMessage)
    assert.strictEqual(adapter.client.lastSentMessage.type, 'message_response')
    
    // The last message should be "World"
    const messageData = adapter.client.lastSentMessage.data
    assert.strictEqual(messageData.text, 'World')
    assert.strictEqual(messageData.room, 'general')
    assert.strictEqual(messageData.instanceId, 'test-instance')
  })

  test('should handle replies with mentions', async () => {
    await adapter.run()
    
    const envelope = {
      room: 'general',
      user: { id: 'user1', name: 'Test User', mention_name: 'testuser' },
      message: { id: 'msg-123', messageId: 'msgId-456' }
    }
    
    await adapter.reply(envelope, 'Thanks for the message')
    
    const messageData = adapter.client.lastSentMessage.data
    assert.strictEqual(messageData.text, '@testuser: Thanks for the message')
  })

  test('should handle emotes', async () => {
    await adapter.run()
    
    const envelope = {
      room: 'general',
      user: { id: 'user1', name: 'Test User' },
      message: { id: 'msg-123', messageId: 'msgId-456' }
    }
    
    await adapter.emote(envelope, 'waves hello')
    
    const messageData = adapter.client.lastSentMessage.data
    assert.strictEqual(messageData.text, '*waves hello*')
  })

  test('should handle topic changes', async () => {
    await adapter.run()
    
    const envelope = {
      room: 'general',
      user: { id: 'user1', name: 'Test User' }
    }
    
    await adapter.topic(envelope, 'New topic for the room')
    
    const messageData = adapter.client.lastSentMessage.data
    assert.strictEqual(messageData.type, 'topic_change')
    assert.strictEqual(messageData.topic, 'New topic for the room')
    assert.strictEqual(messageData.room, 'general')
  })

  test('should close cleanly', async () => {
    await adapter.run()
    
    await adapter.close()
    
    assert.strictEqual(adapter.client.connected, false)
  })

  test('should handle client errors', async () => {
    let errorLogged = false
    robot.logger.error = mock.fn(() => {
      errorLogged = true
    })
    
    await adapter.run()
    
    // Simulate a client error
    adapter.client.emit('error', new Error('Connection failed'))
    
    assert.strictEqual(errorLogged, true)
  })

  test('should handle client disconnection', async () => {
    let disconnectionLogged = false
    robot.logger.warn = mock.fn(() => {
      disconnectionLogged = true
    })
    
    let disconnectedEmitted = false
    adapter.on('disconnected', () => {
      disconnectedEmitted = true
    })
    
    await adapter.run()
    
    // Simulate client disconnection
    adapter.client.emit('disconnected', { code: 1001, reason: 'Going away' })
    
    assert.strictEqual(disconnectionLogged, true)
    assert.strictEqual(disconnectedEmitted, true)
  })
})
