import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'

// Import real components instead of mocking
import LoadBalancer from '../lib/load-balancer.mjs'
import ServiceRegistry from '../service-registry.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Mock robot
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
    this.sentMessages = []
  }

  receive(message) {
    this.receivedMessages.push(message)
  }

  messageRoom(room, text) {
    this.sentMessages.push({ room, text })
  }

  respond(pattern, callback) {
    // Mock respond for testing
  }
}

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1 // OPEN
    this.sentMessages = []
  }

  send(data) {
    this.sentMessages.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3 // CLOSED
  }
}

describe('ServiceDiscovery Load Balancing Integration', () => {
  let serviceDiscovery
  let mockRobot
  let testDataDir

  beforeEach(async () => {
    // Create temporary directory for test data
    testDataDir = path.join(__dirname, '..', 'test-data')
    await fs.mkdir(testDataDir, { recursive: true })

    // Clean up any existing data files to ensure fresh state
    try {
      await fs.rm(path.join(testDataDir, 'events.ndjson'), { force: true })
      await fs.rm(path.join(testDataDir, 'snapshot.json'), { force: true })
    } catch (err) {
      // Ignore cleanup errors
    }

    mockRobot = new MockRobot()
    mockRobot.parseHelp = mock.fn() // Add missing parseHelp method
    
    // Import and create ServiceDiscovery, but stop it first to clean up any auto-started services
    const serviceDiscoveryFunction = (await import('../scripts/service-discovery.mjs')).default
    serviceDiscovery = await serviceDiscoveryFunction(mockRobot)
    
    // Stop the auto-started service discovery to clean up timers/servers
    await serviceDiscovery.stop()
    
    // Now create fresh real registry and load balancer instances for testing
    serviceDiscovery.registry = new ServiceRegistry({
      eventStore: { storagePath: testDataDir },
      heartbeatTimeoutMs: 30000,
      cleanupInterval: 60000
    })
    
    await serviceDiscovery.registry.initialize()
    
    // Clear any existing instances from the registry to ensure clean state
    const allServices = serviceDiscovery.registry.discoverAll()
    for (const serviceName in allServices) {
      for (const instance of allServices[serviceName]) {
        await serviceDiscovery.registry.deregister(serviceName, instance.instanceId)
      }
    }
    
    serviceDiscovery.loadBalancer = new LoadBalancer({
      strategy: 'round-robin', 
      logger: mockRobot.logger
    })
    
    // Reset round-robin index for consistent test results
    serviceDiscovery.loadBalancer.resetRoundRobin()
    
    serviceDiscovery.connectedClients = new Map()
    serviceDiscovery.pendingResponses = new Map()
  })

  afterEach(async () => {
    // Clean up service discovery and registry
    if (serviceDiscovery) {
      try {
        // Clean up the registry we created
        if (serviceDiscovery.registry) {
          await serviceDiscovery.registry.close()
        }
        
        // Clear maps
        if (serviceDiscovery.connectedClients) {
          serviceDiscovery.connectedClients.clear()
        }
        if (serviceDiscovery.pendingResponses) {
          serviceDiscovery.pendingResponses.clear()
        }
      } catch (error) {
        // Ignore cleanup errors to prevent test failures
        console.log('Cleanup warning:', error.message)
      }
    }
    
    // Clean up test data directory
    if (testDataDir) {
      try {
        await fs.rm(testDataDir, { recursive: true, force: true })
      } catch (error) {
        // Ignore cleanup errors
        console.log('Test data cleanup warning:', error.message)
      }
    }
  })

  describe('Message Routing', () => {
    test('should route message to available instance', async () => {
      // Register a client instance
      await serviceDiscovery.registry.register('hubot', {
        instanceId: 'client-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeat to make instance healthy
      await serviceDiscovery.registry.heartbeat('hubot', 'client-1')

      // Mock WebSocket connection
      const mockWs = new MockWebSocket()
      serviceDiscovery.connectedClients.set('client-1', mockWs)

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await serviceDiscovery.routeMessage(messageData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.routedTo, 'client-1')
      assert(result.messageId)

      // Check that message was sent to client
      assert.strictEqual(mockWs.sentMessages.length, 1)
      assert.strictEqual(mockWs.sentMessages[0].type, 'message')
      assert.strictEqual(mockWs.sentMessages[0].data.text, 'Hello world')
    })

    test('should return error when no healthy instances available', async () => {
      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await serviceDiscovery.routeMessage(messageData)

      assert.strictEqual(result.success, false)
      assert.strictEqual(result.shouldProcessLocally, true)
      assert(result.error.includes('No healthy instances available') || result.error.includes('Client connection not available'))
    })

    test('should return error when client connection not available', async () => {
      // Register instance but don't add WebSocket connection
      await serviceDiscovery.registry.register('hubot', {
        instanceId: 'client-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeat to make instance healthy
      await serviceDiscovery.registry.heartbeat('hubot', 'client-1')

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await serviceDiscovery.routeMessage(messageData)

      assert.strictEqual(result.success, false)
      assert.strictEqual(result.shouldProcessLocally, true)
      assert(result.error.includes('Client connection not available'))
    })

    test('should handle multiple instances with round-robin', async () => {
      // Ensure we start with a completely clean registry
      await serviceDiscovery.registry.close()
      serviceDiscovery.registry = new ServiceRegistry({
        eventStore: { storagePath: testDataDir },
        heartbeatTimeoutMs: 30000,
        cleanupInterval: 60000
      })
      await serviceDiscovery.registry.initialize()
      
      // Register multiple client instances in a specific order
      await serviceDiscovery.registry.register('hubot', {
        instanceId: 'client-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })
      await serviceDiscovery.registry.register('hubot', {
        instanceId: 'client-2',
        host: 'localhost',
        port: 8082,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeats to make instances healthy
      await serviceDiscovery.registry.heartbeat('hubot', 'client-1')
      await serviceDiscovery.registry.heartbeat('hubot', 'client-2')

      // Mock WebSocket connections
      const mockWs1 = new MockWebSocket()
      const mockWs2 = new MockWebSocket()
      serviceDiscovery.connectedClients.set('client-1', mockWs1)
      serviceDiscovery.connectedClients.set('client-2', mockWs2)

      // Reset round-robin index to ensure test determinism
      serviceDiscovery.loadBalancer.resetRoundRobin()

      // Check the order of healthy instances
      const healthyInstances = serviceDiscovery.registry.getHealthyInstances('hubot')

      // Filter out any server instances that shouldn't be there
      const clientOnlyInstances = healthyInstances.filter(i => 
        !i.instanceId.includes('server') && 
        i.isServer !== true && 
        i.metadata?.isServer !== true
      )

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      // Get the first two CLIENT instances that will be selected (filter out server instances)
      const expectedFirst = clientOnlyInstances[0].instanceId
      const expectedSecond = clientOnlyInstances[1].instanceId

      // First message should go to first client instance
      const result1 = await serviceDiscovery.routeMessage(messageData)
      assert.strictEqual(result1.routedTo, expectedFirst)

      // Second message should go to second client instance  
      const result2 = await serviceDiscovery.routeMessage(messageData)
      assert.strictEqual(result2.routedTo, expectedSecond)

      // Third message should go back to first client instance (round-robin)
      const result3 = await serviceDiscovery.routeMessage(messageData)
      assert.strictEqual(result3.routedTo, expectedFirst)
    })
  })

  describe('Message Response Handling', () => {
    test('should handle message response successfully', async () => {
      const messageId = 'test-msg-123'
      
      // Add pending response
      serviceDiscovery.pendingResponses.set(messageId, {
        timestamp: Date.now(),
        originalMessage: { text: 'Hello' },
        selectedInstance: 'client-1'
      })

      const responseData = {
        messageId: messageId,
        text: 'Hello back!',
        room: 'general',
        user: { id: 'bot', name: 'Hubot' }
      }

      const result = serviceDiscovery.handleMessageResponse(responseData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.processed, true)

      // Check that pending response was cleaned up
      assert.strictEqual(serviceDiscovery.pendingResponses.has(messageId), false)

      // Check that response was sent through robot
      assert.strictEqual(mockRobot.sentMessages.length, 1)
      assert.strictEqual(mockRobot.sentMessages[0].text, 'Hello back!')
    })

    test('should handle response without messageId', () => {
      const responseData = {
        text: 'Hello back!',
        room: 'general'
      }

      const result = serviceDiscovery.handleMessageResponse(responseData)

      assert.strictEqual(result.success, false)
      assert(result.error.includes('Missing messageId'))
    })

    test('should handle response for unknown messageId', () => {
      const responseData = {
        messageId: 'unknown-msg-123',
        text: 'Hello back!',
        room: 'general'
      }

      const result = serviceDiscovery.handleMessageResponse(responseData)

      assert.strictEqual(result.success, false)
      assert(result.error.includes('Unknown messageId'))
    })
  })

  describe('Pending Response Cleanup', () => {
    test('should clean up expired pending responses', () => {
      const now = Date.now()
      const oldTime = now - 60000 // 60 seconds ago

      // Add some pending responses
      serviceDiscovery.pendingResponses.set('fresh-msg', {
        timestamp: now,
        originalMessage: { text: 'Fresh' },
        selectedInstance: 'client-1'
      })
      serviceDiscovery.pendingResponses.set('old-msg', {
        timestamp: oldTime,
        originalMessage: { text: 'Old' },
        selectedInstance: 'client-1'
      })

      assert.strictEqual(serviceDiscovery.pendingResponses.size, 2)

      serviceDiscovery.cleanupPendingResponses()

      // Only fresh message should remain
      assert.strictEqual(serviceDiscovery.pendingResponses.size, 1)
      assert.strictEqual(serviceDiscovery.pendingResponses.has('fresh-msg'), true)
      assert.strictEqual(serviceDiscovery.pendingResponses.has('old-msg'), false)
    })
  })

  describe('Client Connection Management', () => {
    test('should handle client registration and deregistration', async () => {
      const mockWs = new MockWebSocket()
      mockWs.instanceId = 'client-1'

      // Test registration
      const registerResponse = await serviceDiscovery.handleDiscoveryMessage({
        type: 'register',
        data: {
          serviceName: 'hubot',
          instanceId: 'client-1',
          isServer: false,
          host: 'localhost',
          port: 8081
        }
      }, mockWs)

      assert.strictEqual(registerResponse.success, true)
      assert.strictEqual(serviceDiscovery.connectedClients.has('client-1'), true)

      // Test deregistration
      const deregisterResponse = await serviceDiscovery.handleDiscoveryMessage({
        type: 'deregister',
        data: {
          serviceName: 'hubot',
          instanceId: 'client-1'
        }
      }, mockWs)

      assert.strictEqual(deregisterResponse.success, true)
      assert.strictEqual(serviceDiscovery.connectedClients.has('client-1'), false)
    })

    test('should not register server instances for load balancing', async () => {
      const mockWs = new MockWebSocket()

      await serviceDiscovery.handleDiscoveryMessage({
        type: 'register',
        data: {
          serviceName: 'hubot',
          instanceId: 'server-1',
          isServer: true,
          host: 'localhost',
          port: 8080
        }
      }, mockWs)

      // Server instance should not be added to connected clients
      assert.strictEqual(serviceDiscovery.connectedClients.has('server-1'), false)
    })
  })

  describe('Health Check with Load Balancer Stats', () => {
    test('should include load balancer stats in health response', async () => {
      // Register some instances
      await serviceDiscovery.registry.register('hubot', {
        instanceId: 'client-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeat to make instance healthy
      await serviceDiscovery.registry.heartbeat('hubot', 'client-1')

      const response = await serviceDiscovery.handleDiscoveryMessage({
        type: 'health'
      })

      assert.strictEqual(response.success, true)
      assert(response.data.loadBalancer)
      assert.strictEqual(response.data.loadBalancer.strategy, 'round-robin')
      assert.strictEqual(response.data.connectedClients, 0)
    })
  })

  describe('Process Message Locally', () => {
    test('should process message locally when no instances available', async () => {
      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general',
        id: 'msg-123'
      }

      await serviceDiscovery.processMessageLocally(messageData)

      // Check that robot received the message
      assert.strictEqual(mockRobot.receivedMessages.length, 1)
      const receivedMessage = mockRobot.receivedMessages[0]
      assert.strictEqual(receivedMessage.text, 'Hello world')
      assert.strictEqual(receivedMessage.user.id, 'user1')
      assert.strictEqual(receivedMessage.room, 'general')
    })

    test('should handle missing robot gracefully', async () => {
      serviceDiscovery.robot = null

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      // Should not throw
      await serviceDiscovery.processMessageLocally(messageData)
    })
  })
})
