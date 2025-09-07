import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import ServiceRegistry from '../ServiceRegistry.mjs'

describe('ServiceRegistry', () => {
  let registry
  let testDir

  beforeEach(async () => {
    const timestamp = Date.now()
    const random = Math.floor(Math.random() * 10000)
    testDir = join(process.cwd(), 'test-data', `registry-test-${timestamp}-${random}`)
    // Don't create the directory here - let EventStore.initialize() handle it
    
    registry = new ServiceRegistry({
      eventStore: {
        storageDir: testDir
      },
      heartbeatTimeout: 1000 // 1 second for testing
    })
    registry.on('error', (error) => {
      console.error('ServiceRegistry error:', error)
    })
    
    // Initialize the registry to ensure EventStore is ready
    await registry.initialize()
  })

  afterEach(async () => {
    try {
      // Only close if registry is still active
      if (registry && !registry.closed) {
        await registry.close()
      }
    } catch (error) {
      // Ignore close errors during cleanup
    }
    
    // Wait a moment for any async cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 50))
    
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should register a service instance', async () => {
    const serviceInfo = {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000,
      metadata: { version: '1.0.0' }
    }

    await registry.register('test-service', serviceInfo)

    const result = registry.discover('test-service')
    assert.strictEqual(result.instances.length, 1)
    assert.strictEqual(result.instances[0].instanceId, 'instance-1')
    assert.strictEqual(result.instances[0].host, '192.168.1.100')
    assert.strictEqual(result.instances[0].port, 3000)
    assert.deepStrictEqual(result.instances[0].metadata, { version: '1.0.0' })
  })

  test('should discover all services', async () => {
    await registry.register('service-a', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    await registry.register('service-b', {
      instanceId: 'instance-1',
      host: '192.168.1.101',
      port: 3001
    })

    const allServices = registry.discoverAll()
    assert.strictEqual(Object.keys(allServices).length, 2)
    assert(allServices['service-a'])
    assert(allServices['service-b'])
  })

  test('should handle heartbeats', async () => {
    await registry.register('test-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    // Send heartbeat
    const result = await registry.heartbeat('test-service', 'instance-1')
    assert.strictEqual(result.success, true, 'Heartbeat should succeed for registered instance')

    const instances = registry.discover('test-service')
    assert.strictEqual(instances.instances.length, 1)
    assert(instances.instances[0].lastSeen > Date.now() - 1000)
  })

  test('should reject heartbeat for unregistered instance', async () => {
    const result = await registry.heartbeat('nonexistent-service', 'nonexistent-instance')
    assert.strictEqual(result.success, false, 'Heartbeat should fail for unregistered instance')
  })

  test('should deregister service instances', async () => {
    await registry.register('test-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    await registry.register('test-service', {
      instanceId: 'instance-2',
      host: '192.168.1.101',
      port: 3001
    })

    let instances = registry.discover('test-service')
    assert.strictEqual(instances.instances.length, 2)

    await registry.deregister('test-service', 'instance-1')

    instances = registry.discover('test-service')
    assert.strictEqual(instances.instances.length, 1)
    assert.strictEqual(instances.instances[0].instanceId, 'instance-2')
  })

  test('should remove stale instances on cleanup', async () => {
    await registry.register('test-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    // Manually set an old heartbeat (older than the 1 second timeout)
    registry.instanceHeartbeats.set('instance-1', Date.now() - 1500) // 1.5 seconds ago

    await registry.cleanupExpiredInstances()

    const currentInstances = registry.discover('test-service')
    assert.strictEqual(currentInstances.instances.length, 0, 'Stale instance should be removed')
  })

  test('should emit events on registration', async () => {
    let emittedEvent = null
    registry.on('event-applied', (event) => {
      if (event.type === 'SERVICE_REGISTERED') {
        emittedEvent = event
      }
    })

    await registry.register('test-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    assert(emittedEvent)
    assert.strictEqual(emittedEvent.serviceName, 'test-service')
    assert.strictEqual(emittedEvent.instanceId, 'instance-1')
  })

  test('should emit events on deregistration', async () => {
    await registry.register('test-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    let emittedEvent = null
    registry.on('event-applied', (event) => {
      if (event.type === 'SERVICE_DEREGISTERED') {
        emittedEvent = event
      }
    })

    await registry.deregister('test-service', 'instance-1')

    assert(emittedEvent)
    assert.strictEqual(emittedEvent.serviceName, 'test-service')
    assert.strictEqual(emittedEvent.instanceId, 'instance-1')
  })

  test('should persist and restore state', async () => {
    // Register a service
    await registry.register('persistent-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000,
      metadata: { persistent: true }
    })

    // Wait a moment to ensure the registration is fully processed
    await new Promise(resolve => setTimeout(resolve, 10))

    // Close and recreate registry
    await registry.close()

    // Wait a moment for the close operation to complete
    await new Promise(resolve => setTimeout(resolve, 10))

    const newRegistry = new ServiceRegistry({
      eventStore: {
        storageDir: testDir
      },
      heartbeatTimeout: 60000 // 60 seconds to avoid any timing issues
    })

    // Initialize to load state from storage
    await newRegistry.initialize()

    // Refresh heartbeat after restoration to ensure instance is considered healthy
    const heartbeatResult = await newRegistry.heartbeat('instance-1')
    
    // Ensure heartbeat was successful
    if (!heartbeatResult.success) {
      throw new Error(`Heartbeat failed: ${heartbeatResult.reason}`)
    }

    const instances = newRegistry.discover('persistent-service')
    if (instances.instances.length === 0) {
        newRegistry.debug()
    }
    assert.strictEqual(instances.instances.length, 1)
    assert.strictEqual(instances.instances[0].instanceId, 'instance-1')
    assert.deepStrictEqual(instances.instances[0].metadata, { persistent: true })

    await newRegistry.close()
    
    // Update registry reference so afterEach doesn't try to close the old one
    registry = newRegistry
  })

  test('should handle multiple instances of same service', async () => {
    await registry.register('multi-instance-service', {
      instanceId: 'instance-1',
      host: '192.168.1.100',
      port: 3000
    })

    await registry.register('multi-instance-service', {
      instanceId: 'instance-2',
      host: '192.168.1.101',
      port: 3001
    })

    await registry.register('multi-instance-service', {
      instanceId: 'instance-3',
      host: '192.168.1.102',
      port: 3002
    })

    const instances = registry.discover('multi-instance-service')
    await registry.heartbeat('instance-1')
    await registry.heartbeat('instance-2')
    await registry.heartbeat('instance-3')

    assert.strictEqual(instances.instances.length, 3)

    const instanceIds = instances.instances.map(i => i.instanceId).sort()
    assert.deepStrictEqual(instanceIds, ['instance-1', 'instance-2', 'instance-3'])
  })
})
