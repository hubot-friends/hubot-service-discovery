import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'

// Instead of mocking imports, let's test the individual components
import LoadBalancer from '../lib/load-balancer.mjs'

class MockServiceRegistry extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.services = {}
      this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs || 30000
    }

    async register(serviceName, data) {
      if (!this.services[serviceName]) {
        this.services[serviceName] = { instances: [] }
      }
      this.services[serviceName].instances.push(data)
    }

    async deregister(serviceName, instanceId) {
      if (this.services[serviceName]) {
        this.services[serviceName].instances = this.services[serviceName].instances
          .filter(instance => instance.instanceId !== instanceId)
      }
    }

    discover(serviceName) {
      return this.services[serviceName] || { instances: [] }
    }

    discoverAll() {
      return this.services
    }

    async heartbeat(serviceName, instanceId) {
      const service = this.services[serviceName]
      if (service) {
        const instance = service.instances.find(i => i.instanceId === instanceId)
        if (instance) {
          instance.lastHeartbeat = Date.now()
          return { success: true }
        }
      }
      return { success: false, error: 'Instance not found' }
    }

    async close() {
      // Mock close
    }
  }

class MockLoadBalancer extends EventEmitter {
    constructor(registry, options) {
      super()
      this.registry = registry
      this.strategy = options?.strategy || 'round-robin'
      this.logger = options?.logger || console
      this.roundRobinIndex = 0
      this.selectionHistory = []
    }

    selectInstance(serviceName, messageData) {
      const instances = this.getHealthyInstances(serviceName)
      if (instances.length === 0) return null
      
      const selected = instances[this.roundRobinIndex % instances.length]
      this.roundRobinIndex++
      this.selectionHistory.push(selected)
      return selected
    }

    getHealthyInstances(serviceName) {
      const service = this.registry.discover(serviceName)
      if (!service || !service.instances) return []
      
      return service.instances.filter(instance => !instance.isServer)
    }

    getStats() {
      return {
        strategy: this.strategy,
        roundRobinIndex: this.roundRobinIndex,
        totalServices: Object.keys(this.registry.discoverAll()).length,
        totalInstances: Object.values(this.registry.discoverAll())
          .reduce((sum, service) => sum + service.instances.length, 0),
        healthyInstances: Object.keys(this.registry.discoverAll())
          .reduce((sum, serviceName) => sum + this.getHealthyInstances(serviceName).length, 0)
      }
    }

    setStrategy(strategy) {
      this.strategy = strategy
      this.roundRobinIndex = 0
    }

    resetRoundRobin() {
      this.roundRobinIndex = 0
    }
  }

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
  let originalImport

  beforeEach(async () => {
    // Mock the dynamic imports
    originalImport = globalThis.__dynamicImportMock
    globalThis.__dynamicImportMock = (modulePath) => {
      if (modulePath.includes('service-registry')) {
        return Promise.resolve({ default: MockServiceRegistry })
      }
      if (modulePath.includes('load-balancer')) {
        return Promise.resolve({ default: MockLoadBalancer })
      }
      return Promise.resolve({})
    }

    mockRobot = new MockRobot()
    mockRobot.parseHelp = mock.fn() // Add missing parseHelp method
    
    // Import and create ServiceDiscovery
    const serviceDiscoveryFunction = (await import('../service-discovery.mjs')).default
    serviceDiscovery = await serviceDiscoveryFunction(mockRobot)
    
    // Override registry and load balancer with mocks
    serviceDiscovery.registry = new MockServiceRegistry({
      heartbeatTimeoutMs: 30000
    })
    serviceDiscovery.loadBalancer = new MockLoadBalancer(
      serviceDiscovery.registry,
      { strategy: 'round-robin', logger: mockRobot.logger }
    )
    serviceDiscovery.connectedClients = new Map()
    serviceDiscovery.pendingResponses = new Map()
  })

  afterEach(async () => {
    // Clean up service discovery with timeout
    if (serviceDiscovery) {
      try {
        // Set a timeout for cleanup to prevent hanging
        const cleanupPromise = serviceDiscovery.stop()
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Cleanup timeout')), 2000)
        )
        
        await Promise.race([cleanupPromise, timeoutPromise])
      } catch (error) {
        // Ignore cleanup errors to prevent test failures
        console.log('Cleanup warning:', error.message)
      }
    }
    
    // Reset global mocks
    globalThis.__dynamicImportMock = originalImport
  })

  describe('Message Routing', () => {
    test('should route message to available instance', async () => {
      // Register a client instance
      await serviceDiscovery.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false,
        host: 'localhost',
        port: 8081
      })

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
      assert(result.error.includes('No healthy instances available'))
    })

    test('should return error when client connection not available', async () => {
      // Register instance but don't add WebSocket connection
      await serviceDiscovery.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false
      })

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
      // Register multiple client instances
      await serviceDiscovery.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false
      })
      await serviceDiscovery.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-2',
        isServer: false
      })

      // Mock WebSocket connections
      const mockWs1 = new MockWebSocket()
      const mockWs2 = new MockWebSocket()
      serviceDiscovery.connectedClients.set('client-1', mockWs1)
      serviceDiscovery.connectedClients.set('client-2', mockWs2)

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      // First message should go to client-1
      const result1 = await serviceDiscovery.routeMessage(messageData)
      assert.strictEqual(result1.routedTo, 'client-1')

      // Second message should go to client-2
      const result2 = await serviceDiscovery.routeMessage(messageData)
      assert.strictEqual(result2.routedTo, 'client-2')

      // Third message should go back to client-1
      const result3 = await serviceDiscovery.routeMessage(messageData)
      assert.strictEqual(result3.routedTo, 'client-1')
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
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false
      })

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

  // Cleanup test that runs last
  test('cleanup - stop all timers and intervals', async () => {
    try {
      // Stop any cleanup intervals that might be running
      if (serviceDiscovery && serviceDiscovery.registry) {
        await serviceDiscovery.registry.close()
      }
      
      // Clear service discovery timers
      if (serviceDiscovery && serviceDiscovery.cleanupTimer) {
        clearInterval(serviceDiscovery.cleanupTimer)
        serviceDiscovery.cleanupTimer = null
      }
      
      if (serviceDiscovery && serviceDiscovery.heartbeatTimer) {
        clearInterval(serviceDiscovery.heartbeatTimer)
        serviceDiscovery.heartbeatTimer = null
      }
      
      // Clear any pending responses cleanup
      if (serviceDiscovery && serviceDiscovery.pendingResponses) {
        serviceDiscovery.pendingResponses.clear()
      }
      
      // Stop the WebSocket server if it exists
      if (serviceDiscovery && serviceDiscovery.wss) {
        serviceDiscovery.wss.close()
      }
      
      // Wait a bit for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Force clear any remaining timers
      const highestTimeoutId = setTimeout(() => {}, 0)
      for (let i = 0; i <= highestTimeoutId; i++) {
        clearTimeout(i)
        clearInterval(i)
      }
      
    } catch (error) {
      console.log('Cleanup warning:', error.message)
    }
  })
})
