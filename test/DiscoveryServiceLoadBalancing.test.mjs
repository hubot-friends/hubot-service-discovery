import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import DiscoveryServiceFunction from '../DiscoveryService.mjs'


// Import real components instead of mocking
import LoadBalancer from '../lib/LoadBalancer.mjs'
import ServiceRegistry from '../lib/ServiceRegistry.mjs'

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

describe('DiscoveryService Load Balancing Integration', () => {
  let DiscoveryService
  let mockRobot
  let testDataDir

  beforeEach(async () => {
    // Create temporary directory for test data with unique name
    testDataDir = path.join(__dirname, '..', 'test-data', `lb-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
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
    
    // Import and create DiscoveryService, but stop it first to clean up any auto-started services
    DiscoveryService = await DiscoveryServiceFunction(mockRobot)
    
    // Stop the auto-started service discovery to clean up timers/servers
    await DiscoveryService.stop()
    
    // Now create fresh real registry and load balancer instances for testing
    DiscoveryService.registry = new ServiceRegistry({
      eventStore: { storagePath: testDataDir },
      heartbeatTimeoutMs: 30000,
      cleanupInterval: 60000
    })
    
    await DiscoveryService.registry.initialize()
    
    // Clear any existing instances from the registry to ensure clean state
    const allServices = DiscoveryService.registry.discoverAll()
    for (const serviceName in allServices) {
      for (const instance of allServices[serviceName]) {
        await DiscoveryService.registry.deregister(serviceName, instance.instanceId)
      }
    }
    
    DiscoveryService.loadBalancer = new LoadBalancer({
      strategy: 'round-robin', 
      logger: mockRobot.logger
    })
    
    // Reset round-robin index for consistent test results
    DiscoveryService.loadBalancer.resetRoundRobin()
    
    DiscoveryService.connectedWorkers = new Map()
    DiscoveryService.pendingResponses = new Map()
  })

  afterEach(async () => {
    // Clean up service discovery and registry
    if (DiscoveryService) {
      try {
        // Clean up the registry we created
        if (DiscoveryService.registry) {
          await DiscoveryService.registry.close()
        }
        
        // Clear maps
        if (DiscoveryService.connectedWorkers) {
          DiscoveryService.connectedWorkers.clear()
        }
        if (DiscoveryService.pendingResponses) {
          DiscoveryService.pendingResponses.clear()
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
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeat to make instance healthy
      await DiscoveryService.registry.heartbeat('hubot', 'worker-1')

      // Mock WebSocket connection
      const mockWs = new MockWebSocket()
      DiscoveryService.connectedWorkers.set('worker-1', mockWs)

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await DiscoveryService.routeMessage(messageData)
      assert.strictEqual(result[0].success, true)
      assert.strictEqual(result[0].routedTo, 'worker-1')
      assert(result[0].messageId)

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

      const result = await DiscoveryService.routeMessage(messageData)

      assert.strictEqual(result[0].success, false)
      assert.strictEqual(result[0].shouldProcessLocally, true)
      assert(result[0].error.includes('No healthy instances available') || result[0].error.includes('Worker connection not available'))
    })

    test('should return error when worker connection not available', async () => {
      // Register instance but don't add WebSocket connection
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeat to make instance healthy
      await DiscoveryService.registry.heartbeat('hubot', 'worker-1')

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await DiscoveryService.routeMessage(messageData)

      assert.strictEqual(result[0].success, false)
      assert.strictEqual(result[0].shouldProcessLocally, true)
      assert(result[0].error.includes('No healthy instances available'))
    })

    test('should not route to instances with closed sockets', async () => {
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      await DiscoveryService.registry.heartbeat('hubot', 'worker-1')

      const mockWs = new MockWebSocket()
      mockWs.readyState = 3 // CLOSED
      DiscoveryService.connectedWorkers.set('worker-1', mockWs)

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await DiscoveryService.routeMessage(messageData)

      assert.strictEqual(result[0].success, false)
      assert.strictEqual(result[0].shouldProcessLocally, true)
      assert(result[0].error.includes('No healthy instances available'))
      assert.strictEqual(mockWs.sentMessages.length, 0)
    })

    test('should handle multiple instances with round-robin', async () => {
      // Ensure we start with a completely clean registry
      await DiscoveryService.registry.close()
      DiscoveryService.registry = new ServiceRegistry({
        eventStore: { storagePath: testDataDir },
        heartbeatTimeoutMs: 30000,
        cleanupInterval: 60000
      })
      await DiscoveryService.registry.initialize()
      
      // Register multiple client instances in a specific order
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-2',
        host: 'localhost',
        port: 8082,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeats to make instances healthy
      await DiscoveryService.registry.heartbeat('hubot', 'worker-1')
      await DiscoveryService.registry.heartbeat('hubot', 'worker-2')

      // Mock WebSocket connections
      const mockWs1 = new MockWebSocket()
      const mockWs2 = new MockWebSocket()
      DiscoveryService.connectedWorkers.set('worker-1', mockWs1)
      DiscoveryService.connectedWorkers.set('worker-2', mockWs2)

      // Reset round-robin index to ensure test determinism
      DiscoveryService.loadBalancer.resetRoundRobin()

      // Check the order of healthy instances
      const healthyInstances = DiscoveryService.registry.getHealthyInstances('hubot')

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
      const result1 = await DiscoveryService.routeMessage(messageData)
      assert.strictEqual(result1[0].routedTo, expectedFirst)

      // Second message should go to second client instance  
      const result2 = await DiscoveryService.routeMessage(messageData)
      assert.strictEqual(result2[0].routedTo, expectedSecond)
      // Third message should go back to first client instance (round-robin)
      const result3 = await DiscoveryService.routeMessage(messageData)
      assert.strictEqual(result3[0].routedTo, expectedFirst)
    })

    test('should get 1 healthy instance for every group of server/client instances', async () => {
      // Register server and client instances
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'server-1',
        host: 'localhost',
        port: 8080,
        isServer: true,
        metadata: { adapter: 'test', isServer: true }
      })
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test', isServer: false, group: 'A' }
      })
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-2',
        host: 'localhost',
        port: 8082,
        isServer: true,
        metadata: { adapter: 'test', isServer: true, group: 'A' }
      })
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-3',
        host: 'localhost',
        port: 8083,
        isServer: false,
        metadata: { adapter: 'test', isServer: false, group: 'B' }
      })

      // Send initial heartbeats to make instances healthy
      await DiscoveryService.registry.heartbeat('hubot', 'server-1')
      await DiscoveryService.registry.heartbeat('hubot', 'worker-1')
      await DiscoveryService.registry.heartbeat('hubot', 'worker-2')
      await DiscoveryService.registry.heartbeat('hubot', 'worker-3')

      const healthyInstances = Object.groupBy(DiscoveryService.registry.getHealthyInstances('hubot'), i => i.metadata?.group || 'default')
      assert.strictEqual(healthyInstances['A'].length, 1)
      assert.strictEqual(healthyInstances['B'].length, 1)
      assert.strictEqual(healthyInstances['B'][0].instanceId, 'worker-3')
    })
  })

  describe('Message Response Handling', () => {
    test('should require messageId on response data when client replies to message', async () => {
      // This test verifies that Service Discovery requires a messageId on the responseData
      // when a client replies to a message - this is CRITICAL for tracking responses
      
      const responseData = {
        text: 'Hello back!',
        room: 'general',
        user: { id: 'bot', name: 'Hubot' }
        // Note: Missing messageId - this should cause failure
      }

      const result = await DiscoveryService.handleDiscoveryMessage({
        type: 'message_response',
        data: responseData
      })

      // ASSERTION: Service Discovery must reject responses without messageId
      assert.strictEqual(result.success, false)
      assert(result.error.includes('messageId is required'))
    })

    test('should handle message response successfully', async () => {
      const messageId = 'test-msg-123'
      const instanceId = 'worker-1'
      
      // Add pending response with new structure
      DiscoveryService.pendingResponses.set(messageId, {
        timestamp: Date.now(),
        originalMessage: { text: 'Hello' },
        pendingInstances: new Set([instanceId]),
        receivedResponses: new Map()
      })

      const responseData = {
        messageId: messageId,
        instanceId: instanceId,
        text: 'Hello back!',
        room: 'general',
        user: { id: 'bot', name: 'Hubot' }
      }

      const result = DiscoveryService.handleMessageResponse(responseData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.processed, true)

      // Check that pending response was cleaned up (since all instances have responded)
      assert.strictEqual(DiscoveryService.pendingResponses.has(messageId), false)

      // Check that response was sent through robot
      assert.strictEqual(mockRobot.sentMessages.length, 1)
      assert.strictEqual(mockRobot.sentMessages[0].text, 'Hello back!')
    })

    test('should handle response without messageId', () => {
      const responseData = {
        text: 'Hello back!',
        room: 'general'
      }

      const result = DiscoveryService.handleMessageResponse(responseData)

      assert.strictEqual(result.success, false)
      assert(result.error.includes('messageId is required'))
    })

    test('should handle unsolicited message (no pending message)', () => {
      // Clear sent messages from previous tests
      mockRobot.sentMessages = []
      
      const responseData = {
        messageId: 'unsolicited-msg-123',
        instanceId: 'worker-1',
        text: 'Proactive notification from worker!',
        room: 'general'
      }

      const result = DiscoveryService.handleMessageResponse(responseData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.processed, true)
      assert.strictEqual(result.unsolicited, true)
      
      // Message should still be delivered to the room
      assert.strictEqual(mockRobot.sentMessages.length, 1)
      assert.strictEqual(mockRobot.sentMessages[0].text, 'Proactive notification from worker!')
      assert.strictEqual(mockRobot.sentMessages[0].room, 'general')
    })
    
    test('should handle unsolicited message without room (defaults to general)', () => {
      // Clear sent messages from previous tests
      mockRobot.sentMessages = []
      
      const responseData = {
        messageId: 'unsolicited-msg-456',
        instanceId: 'worker-2',
        text: 'Event notification'
      }

      const result = DiscoveryService.handleMessageResponse(responseData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.unsolicited, true)
      
      // Message should be delivered to default room
      assert.strictEqual(mockRobot.sentMessages.length, 1)
      assert.strictEqual(mockRobot.sentMessages[0].room, 'general')
    })
  })

  describe('Pending Response Cleanup', () => {
    test('should clean up expired pending responses', () => {
      const now = Date.now()
      const oldTime = now - 60000 // 60 seconds ago

      // Add some pending responses with new structure
      DiscoveryService.pendingResponses.set('fresh-msg', {
        timestamp: now,
        originalMessage: { text: 'Fresh' },
        pendingInstances: new Set(['worker-1']),
        receivedResponses: new Map()
      })
      DiscoveryService.pendingResponses.set('old-msg', {
        timestamp: oldTime,
        originalMessage: { text: 'Old' },
        pendingInstances: new Set(['worker-1']),
        receivedResponses: new Map()
      })

      assert.strictEqual(DiscoveryService.pendingResponses.size, 2)

      DiscoveryService.cleanupPendingResponses()

      // Only fresh message should remain
      assert.strictEqual(DiscoveryService.pendingResponses.size, 1)
      assert.strictEqual(DiscoveryService.pendingResponses.has('fresh-msg'), true)
      assert.strictEqual(DiscoveryService.pendingResponses.has('old-msg'), false)
    })
  })

  describe('Client Connection Management', () => {
    test('should handle client registration and deregistration', async () => {
      const mockWs = new MockWebSocket()
      mockWs.instanceId = 'worker-1'

      // Test registration
      const registerResponse = await DiscoveryService.handleDiscoveryMessage({
        type: 'register',
        data: {
          serviceName: 'hubot',
          instanceId: 'worker-1',
          isServer: false,
          host: 'localhost',
          port: 8081
        }
      }, mockWs)

      assert.strictEqual(registerResponse.success, true)
      assert.strictEqual(DiscoveryService.connectedWorkers.has('worker-1'), true)

      // Test deregistration
      const deregisterResponse = await DiscoveryService.handleDiscoveryMessage({
        type: 'deregister',
        data: {
          serviceName: 'hubot',
          instanceId: 'worker-1'
        }
      }, mockWs)

      assert.strictEqual(deregisterResponse.success, true)
      assert.strictEqual(DiscoveryService.connectedWorkers.has('worker-1'), false)
    })

    test('should not register server instances for load balancing', async () => {
      const mockWs = new MockWebSocket()

      await DiscoveryService.handleDiscoveryMessage({
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
      assert.strictEqual(DiscoveryService.connectedWorkers.has('server-1'), false)
    })
  })

  describe('Health Check with Load Balancer Stats', () => {
    test('should include load balancer stats in health response', async () => {
      // Register some instances
      await DiscoveryService.registry.register('hubot', {
        instanceId: 'worker-1',
        host: 'localhost',
        port: 8081,
        isServer: false,
        metadata: { adapter: 'test' }
      })

      // Send initial heartbeat to make instance healthy
      await DiscoveryService.registry.heartbeat('hubot', 'worker-1')

      const response = await DiscoveryService.handleDiscoveryMessage({
        type: 'health'
      })

      assert.strictEqual(response.success, true)
      assert(response.data.loadBalancer)
      assert.strictEqual(response.data.loadBalancer.strategy, 'round-robin')
      assert.strictEqual(response.data.connectedWorkers, 0)
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

      await DiscoveryService.processMessageLocally(messageData)

      // Check that robot received the message
      assert.strictEqual(mockRobot.receivedMessages.length, 1)
      const receivedMessage = mockRobot.receivedMessages[0]
      assert.strictEqual(receivedMessage.text, 'Hello world')
      assert.strictEqual(receivedMessage.user.id, 'user1')
      assert.strictEqual(receivedMessage.room, 'general')
    })

    test('should handle missing robot gracefully', async () => {
      DiscoveryService.robot = null

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      // Should not throw
      await DiscoveryService.processMessageLocally(messageData)
    })
  })
})
