import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import serviceDiscoveryScript from '../scripts/service-discovery.mjs'

// Mock robot for testing
class MockRobot extends EventEmitter {
  constructor(name = 'test-bot') {
    super()
    this.name = name
    this.adapterName = 'shell'
    this.version = '1.0.0'
    this.logger = {
      info: mock.fn(),
      debug: mock.fn(),
      error: mock.fn(),
      warn: mock.fn()
    }
    this.serviceDiscovery = null
    this.brain = {
      connectToPeer: mock.fn(),
      getPeerCount: mock.fn(() => 0)
    }
    this.commands = []
  }

  parseHelp(fileName) {
    // Mock help parsing
  }

  respond(pattern, callback) {
    // Mock respond method for command registration
    this.commands.push({ pattern, callback })
  }

  hear(pattern, callback) {
    // Mock hear method for command registration  
    this.commands.push({ pattern, callback })
  }
}

// Mock response for testing commands
class MockResponse {
  constructor() {
    this.replies = []
    this.match = null
  }

  async reply(message) {
    this.replies.push(message)
  }

  async send(message) {
    this.replies.push(message)
  }
}

describe('ServiceDiscovery Script', () => {
  let robot
  let testDir
  let originalEnv

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env }
    
    // Setup test environment with more unique directory naming
    const timestamp = Date.now()
    const random = Math.floor(Math.random() * 10000)
    testDir = join(process.cwd(), 'test-data', `script-test-${timestamp}-${random}`)
    mkdirSync(testDir, { recursive: true })
    
    process.env.HUBOT_DISCOVERY_STORAGE = testDir
    process.env.HUBOT_DISCOVERY_PORT = '0' // Use random port
    process.env.HUBOT_INSTANCE_ID = 'test-instance'
    process.env.HUBOT_HOST = 'localhost'
    process.env.HUBOT_PORT = '8080'
    process.env.NODE_ENV = 'test'
    
    robot = new MockRobot()
  })

  afterEach(async () => {
    // Restore environment
    process.env = originalEnv
    
    // Cleanup service discovery
    if (robot.serviceDiscovery) {
      await robot.serviceDiscovery.stop()
    }
    
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should initialize service discovery script', async () => {
    await serviceDiscoveryScript(robot)
    assert(robot.serviceDiscovery, 'Should attach serviceDiscovery to robot')
    assert.strictEqual(robot.serviceDiscovery.instanceId, 'test-instance')
    assert.strictEqual(robot.serviceDiscovery.serviceName, 'hubot')
    assert.strictEqual(robot.serviceDiscovery.isServer, true) // No discovery URL, so acts as server
  })

  test('should register commands', async () => {
    await serviceDiscoveryScript(robot)
    
    // Simulate robot ready event to start service discovery
    
    // Allow some time for async operations

    // Check that commands were registered
    assert(robot.commands.length > 0, 'Should have registered some commands')
    
    // Check for specific command patterns
    const patterns = robot.commands.map(cmd => cmd.pattern.toString())
    assert(patterns.some(p => p.includes('discover')), 'Should register discover command')
    assert(patterns.some(p => p.includes('status')), 'Should register status command')
    assert(patterns.some(p => p.includes('connect')), 'Should register connect command')
    assert(patterns.some(p => p.includes('brain')), 'Should register brain peers command')
  })

  test('should start as server when no discovery URL provided', async () => {
    await serviceDiscoveryScript(robot)
    
    assert.strictEqual(robot.serviceDiscovery.isServer, true)
    assert.strictEqual(robot.serviceDiscovery.discoveryUrl, undefined)
  })

  test('should start as client when discovery URL provided', async () => {
    process.env.HUBOT_DISCOVERY_URL = 'ws://localhost:3100'
    
    await serviceDiscoveryScript(robot)
    
    assert.strictEqual(robot.serviceDiscovery.isServer, false)
    assert.strictEqual(robot.serviceDiscovery.discoveryUrl, 'ws://localhost:3100')
  })

  test('should handle discovery messages as server', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    const serviceDiscovery = robot.serviceDiscovery

    // Test register message
    const registerMessage = {
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1',
        host: 'localhost',
        port: 8080,
        metadata: { version: '1.0.0' }
      }
    }

    const response = await serviceDiscovery.handleDiscoveryMessage(registerMessage)
    assert.strictEqual(response.success, true)
    assert(response.message.includes('registered'))

    // Test discover message
    const discoverMessage = {
      type: 'discover',
      data: { serviceName: 'test-service' }
    }

    const discoverResponse = await serviceDiscovery.handleDiscoveryMessage(discoverMessage)
    assert.strictEqual(discoverResponse.success, true)
    assert.strictEqual(discoverResponse.data.serviceName, 'test-service')
    assert(Array.isArray(discoverResponse.data.instances))
  })

  test('should handle heartbeat messages', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    const serviceDiscovery = robot.serviceDiscovery

    // Register a service first
    await serviceDiscovery.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1',
        host: 'localhost',
        port: 8080
      }
    })

    // Send heartbeat
    const heartbeatResponse = await serviceDiscovery.handleDiscoveryMessage({
      type: 'heartbeat',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1'
      }
    })

    assert.strictEqual(heartbeatResponse.success, true)
  })

  test('should handle health check messages', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    const serviceDiscovery = robot.serviceDiscovery

    const healthResponse = await serviceDiscovery.handleDiscoveryMessage({
      type: 'health',
      data: {}
    })

    assert.strictEqual(healthResponse.success, true)
    assert.strictEqual(healthResponse.data.status, 'healthy')
    assert(typeof healthResponse.data.uptime === 'number')
    assert(typeof healthResponse.data.totalServices === 'number')
    assert(typeof healthResponse.data.totalInstances === 'number')
  })

  test('should list healthy instances when 2 out of 3 are healthy', async () => {
    await serviceDiscoveryScript(robot)

    const serviceDiscovery = robot.serviceDiscovery

    // Register 3 instances, 2 healthy and 1 unhealthy
    await serviceDiscovery.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1',
        host: 'localhost',
        port: 8080
      }
    })

    await serviceDiscovery.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-2',
        host: 'localhost',
        port: 8081
      }
    })

    await serviceDiscovery.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-3',
        host: 'localhost',
        port: 8082
      }
    })

    // Simulate heartbeats for only 2 instances (making the 3rd unhealthy)
    await serviceDiscovery.handleDiscoveryMessage({
      type: 'heartbeat',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1'
      }
    })

    await serviceDiscovery.handleDiscoveryMessage({
      type: 'heartbeat',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-2'
      }
    })

    // Make test-instance-3 unhealthy by setting an old heartbeat timestamp
    const oldTimestamp = Date.now() - 70000 // 70 seconds ago (past the 60-second timeout)
    serviceDiscovery.registry.instanceHeartbeats.set('test-instance-3', oldTimestamp)

    // List healthy instances using the new pattern
    const healthyInstances = serviceDiscovery.registry.getHealthyInstances('test-service')
    assert.strictEqual(healthyInstances.length, 2)
    assert(healthyInstances.some(instance => instance.instanceId === 'test-instance-1'))
    assert(healthyInstances.some(instance => instance.instanceId === 'test-instance-2'))
  })

  test('should execute discover services command', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    // Find the discover command
    const discoverCommand = robot.commands.find(cmd => 
      cmd.pattern.toString().includes('discover')
    )
    assert(discoverCommand, 'Should have discover command')

    // Mock response
    const res = new MockResponse()
    res.match = ['discover services', 'services']

    // Execute command
    await discoverCommand.callback(res)

    assert(res.replies.length > 0, 'Should have sent a reply')
    assert(res.replies[0].includes('services'), 'Reply should mention services')
  })

  test('should execute discovery status command', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    // Find the status command
    const statusCommand = robot.commands.find(cmd => 
      cmd.pattern.toString().includes('status')
    )
    assert(statusCommand, 'Should have status command')

    // Mock response
    const res = new MockResponse()
    res.match = ['discovery status']

    // Execute command
    await statusCommand.callback(res)

    assert(res.replies.length > 0, 'Should have sent a reply')
    assert(res.replies[0].includes('Instance ID'), 'Reply should include instance ID')
    assert(res.replies[0].includes('test-instance'), 'Reply should include the test instance ID')
  })

  test('should execute brain peers command', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    // Find the brain peers command
    const brainCommand = robot.commands.find(cmd => 
      cmd.pattern.toString().includes('brain')
    )
    assert(brainCommand, 'Should have brain peers command')

    // Mock response
    const res = new MockResponse()
    res.match = ['brain peers']

    // Execute command
    await brainCommand.callback(res)

    assert(res.replies.length > 0, 'Should have sent a reply')
    assert(res.replies[0].includes('0'), 'Reply should mention 0 peers')
  })

  test('should clean up properly', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    const serviceDiscovery = robot.serviceDiscovery

    // Verify everything is initialized
    assert(serviceDiscovery.registry)
    assert(serviceDiscovery.wss)

    // Stop and verify cleanup
    await serviceDiscovery.stop()
    
    assert.strictEqual(serviceDiscovery.registry, null)
    assert.strictEqual(serviceDiscovery.wss, null)
    assert.strictEqual(serviceDiscovery.heartbeatTimer, null)
  })

  test('should handle unknown message types', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    const serviceDiscovery = robot.serviceDiscovery

    try {
      await serviceDiscovery.handleDiscoveryMessage({
        type: 'unknown-type',
        data: {}
      })
      assert.fail('Should have thrown an error')
    } catch (error) {
      assert(error.message.includes('Unknown message type'))
    }
  })

  test('should register self when acting as server', async () => {
    await serviceDiscoveryScript(robot)
    
    // Start as server

    const serviceDiscovery = robot.serviceDiscovery

    // Should be registered
    assert.strictEqual(serviceDiscovery.isRegistered, true)

    // Should be able to discover itself
    const result = await serviceDiscovery.discoverServices('hubot')
    assert(result.instances.length >= 1, 'Should find at least itself')
    
    const selfInstance = result.instances.find(i => i.instanceId === 'test-instance')
    assert(selfInstance, 'Should find itself in the registry')
    assert.strictEqual(selfInstance.host, 'localhost')
    assert.strictEqual(selfInstance.port, 8080)
  })
})
