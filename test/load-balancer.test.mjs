import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import LoadBalancer from '../lib/load-balancer.mjs'

// Mock registry for testing
class MockRegistry {
  constructor() {
    this.services = {}
    this.heartbeatTimeoutMs = 30000
  }

  discover(serviceName) {
    return this.services[serviceName] || { instances: [] }
  }

  discoverAll() {
    return this.services
  }

  addService(serviceName, instances) {
    this.services[serviceName] = { instances }
  }

  clear() {
    this.services = {}
  }
}

describe('LoadBalancer', () => {
  let loadBalancer
  let mockRegistry
  let mockLogger

  beforeEach(() => {
    mockRegistry = new MockRegistry()
    mockLogger = {
      debug: mock.fn(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn()
    }
    
    loadBalancer = new LoadBalancer(mockRegistry, {
      strategy: 'round-robin',
      logger: mockLogger
    })
  })

  afterEach(() => {
    mockRegistry.clear()
  })

  describe('constructor', () => {
    test('should initialize with default strategy', () => {
      const lb = new LoadBalancer(mockRegistry)
      assert.strictEqual(lb.strategy, 'round-robin')
      assert.strictEqual(lb.roundRobinIndex, 0)
    })

    test('should initialize with custom strategy', () => {
      const lb = new LoadBalancer(mockRegistry, { strategy: 'random' })
      assert.strictEqual(lb.strategy, 'random')
    })
  })

  describe('getHealthyInstances', () => {
    test('should return empty array when no instances exist', () => {
      const instances = loadBalancer.getHealthyInstances('nonexistent-service')
      assert.deepStrictEqual(instances, [])
    })

    test('should filter out server instances', () => {
      const now = Date.now()
      mockRegistry.addService('test-service', [
        { instanceId: 'server-1', isServer: true, lastHeartbeat: now },
        { instanceId: 'client-1', isServer: false, lastHeartbeat: now },
        { instanceId: 'client-2', lastHeartbeat: now } // isServer undefined = false
      ])

      const instances = loadBalancer.getHealthyInstances('test-service')
      assert.strictEqual(instances.length, 2)
      assert.strictEqual(instances[0].instanceId, 'client-1')
      assert.strictEqual(instances[1].instanceId, 'client-2')
    })

    test('should filter out unhealthy instances', () => {
      const now = Date.now()
      const oldTime = now - 60000 // 60 seconds ago
      
      mockRegistry.addService('test-service', [
        { instanceId: 'healthy-1', lastHeartbeat: now },
        { instanceId: 'unhealthy-1', lastHeartbeat: oldTime },
        { instanceId: 'healthy-2', registeredAt: now }
      ])

      const instances = loadBalancer.getHealthyInstances('test-service')
      assert.strictEqual(instances.length, 2)
      assert.strictEqual(instances[0].instanceId, 'healthy-1')
      assert.strictEqual(instances[1].instanceId, 'healthy-2')
    })
  })

  describe('selectInstance', () => {
    test('should return null when no healthy instances available', () => {
      const instance = loadBalancer.selectInstance('nonexistent-service')
      assert.strictEqual(instance, null)
    })

    test('should select instance using configured strategy', () => {
      const now = Date.now()
      mockRegistry.addService('test-service', [
        { instanceId: 'client-1', lastHeartbeat: now },
        { instanceId: 'client-2', lastHeartbeat: now }
      ])

      const instance = loadBalancer.selectInstance('test-service')
      assert(instance)
      assert.strictEqual(instance.instanceId, 'client-1') // First in round-robin
    })
  })

  describe('selectRoundRobin', () => {
    test('should return null for empty array', () => {
      const instance = loadBalancer.selectRoundRobin([])
      assert.strictEqual(instance, null)
    })

    test('should cycle through instances in order', () => {
      const instances = [
        { instanceId: 'client-1' },
        { instanceId: 'client-2' },
        { instanceId: 'client-3' }
      ]

      assert.strictEqual(loadBalancer.selectRoundRobin(instances).instanceId, 'client-1')
      assert.strictEqual(loadBalancer.selectRoundRobin(instances).instanceId, 'client-2')
      assert.strictEqual(loadBalancer.selectRoundRobin(instances).instanceId, 'client-3')
      assert.strictEqual(loadBalancer.selectRoundRobin(instances).instanceId, 'client-1') // Wraps around
    })

    test('should handle index overflow correctly', () => {
      const instances = [{ instanceId: 'client-1' }]
      
      // Select multiple times to test overflow
      for (let i = 0; i < 5; i++) {
        const instance = loadBalancer.selectRoundRobin(instances)
        assert.strictEqual(instance.instanceId, 'client-1')
      }
    })
  })

  describe('selectRandom', () => {
    test('should return null for empty array', () => {
      const instance = loadBalancer.selectRandom([])
      assert.strictEqual(instance, null)
    })

    test('should select an instance from the array', () => {
      const instances = [
        { instanceId: 'client-1' },
        { instanceId: 'client-2' }
      ]

      const instance = loadBalancer.selectRandom(instances)
      assert(instance)
      assert(['client-1', 'client-2'].includes(instance.instanceId))
    })
  })

  describe('selectLeastConnections', () => {
    test('should return null for empty array', () => {
      const instance = loadBalancer.selectLeastConnections([])
      assert.strictEqual(instance, null)
    })

    test('should select instance with least connections', () => {
      const instances = [
        { instanceId: 'client-1', metadata: { connections: 5 } },
        { instanceId: 'client-2', metadata: { connections: 2 } },
        { instanceId: 'client-3', metadata: { connections: 8 } }
      ]

      const instance = loadBalancer.selectLeastConnections(instances)
      assert.strictEqual(instance.instanceId, 'client-2')
    })

    test('should handle instances without connection metadata', () => {
      const instances = [
        { instanceId: 'client-1', metadata: { connections: 5 } },
        { instanceId: 'client-2' }, // No metadata
        { instanceId: 'client-3', metadata: {} } // Empty metadata
      ]

      const instance = loadBalancer.selectLeastConnections(instances)
      // Should select client-2 or client-3 (both have 0 connections)
      assert(['client-2', 'client-3'].includes(instance.instanceId))
    })
  })

  describe('setStrategy', () => {
    test('should change strategy successfully', () => {
      loadBalancer.setStrategy('random')
      assert.strictEqual(loadBalancer.strategy, 'random')
    })

    test('should reset round-robin index when changing strategy', () => {
      // Advance round-robin index
      loadBalancer.roundRobinIndex = 5
      
      loadBalancer.setStrategy('least-connections')
      assert.strictEqual(loadBalancer.roundRobinIndex, 0)
    })

    test('should throw error for invalid strategy', () => {
      assert.throws(() => {
        loadBalancer.setStrategy('invalid-strategy')
      }, /Invalid strategy/)
    })

    test('should accept all valid strategies', () => {
      const validStrategies = ['round-robin', 'random', 'least-connections']
      
      validStrategies.forEach(strategy => {
        assert.doesNotThrow(() => {
          loadBalancer.setStrategy(strategy)
        })
        assert.strictEqual(loadBalancer.strategy, strategy)
      })
    })
  })

  describe('resetRoundRobin', () => {
    test('should reset round-robin index to zero', () => {
      loadBalancer.roundRobinIndex = 10
      loadBalancer.resetRoundRobin()
      assert.strictEqual(loadBalancer.roundRobinIndex, 0)
    })
  })

  describe('getStats', () => {
    test('should return basic stats when no services exist', () => {
      const stats = loadBalancer.getStats()
      
      assert.strictEqual(stats.strategy, 'round-robin')
      assert.strictEqual(stats.roundRobinIndex, 0)
      assert.strictEqual(stats.totalServices, 0)
      assert.strictEqual(stats.totalInstances, 0)
      assert.strictEqual(stats.healthyInstances, 0)
    })

    test('should calculate stats correctly with services', () => {
      const now = Date.now()
      mockRegistry.addService('service-1', [
        { instanceId: 'client-1', lastHeartbeat: now },
        { instanceId: 'server-1', isServer: true, lastHeartbeat: now }
      ])
      mockRegistry.addService('service-2', [
        { instanceId: 'client-2', lastHeartbeat: now }
      ])

      const stats = loadBalancer.getStats()
      
      assert.strictEqual(stats.totalServices, 2)
      assert.strictEqual(stats.totalInstances, 3)
      assert.strictEqual(stats.healthyInstances, 2) // Excludes server instances
    })
  })

  describe('strategy integration', () => {
    beforeEach(() => {
      const now = Date.now()
      mockRegistry.addService('test-service', [
        { instanceId: 'client-1', lastHeartbeat: now, metadata: { connections: 3 } },
        { instanceId: 'client-2', lastHeartbeat: now, metadata: { connections: 1 } },
        { instanceId: 'client-3', lastHeartbeat: now, metadata: { connections: 5 } }
      ])
    })

    test('should use round-robin strategy by default', () => {
      assert.strictEqual(loadBalancer.selectInstance('test-service').instanceId, 'client-1')
      assert.strictEqual(loadBalancer.selectInstance('test-service').instanceId, 'client-2')
      assert.strictEqual(loadBalancer.selectInstance('test-service').instanceId, 'client-3')
      assert.strictEqual(loadBalancer.selectInstance('test-service').instanceId, 'client-1')
    })

    test('should use least-connections strategy when configured', () => {
      loadBalancer.setStrategy('least-connections')
      const instance = loadBalancer.selectInstance('test-service')
      assert.strictEqual(instance.instanceId, 'client-2') // Has least connections (1)
    })

    test('should fall back to round-robin for unknown strategy', () => {
      loadBalancer.strategy = 'unknown-strategy' // Bypass validation
      const instance = loadBalancer.selectInstance('test-service')
      assert(instance) // Should still select an instance
      assert.strictEqual(mockLogger.warn.mock.callCount(), 1)
    })
  })

  describe('edge cases', () => {
    test('should handle service with no instances', () => {
      mockRegistry.addService('empty-service', [])
      const instance = loadBalancer.selectInstance('empty-service')
      assert.strictEqual(instance, null)
    })

    test('should handle registry returning null', () => {
      // Mock discover to return null
      mockRegistry.discover = mock.fn(() => null)
      
      const instance = loadBalancer.selectInstance('test-service')
      assert.strictEqual(instance, null)
    })

    test('should handle instances without instanceId', () => {
      const now = Date.now()
      mockRegistry.addService('test-service', [
        { lastHeartbeat: now }, // Missing instanceId
        { instanceId: 'client-1', lastHeartbeat: now }
      ])

      // Should still work with valid instances
      const instance = loadBalancer.selectInstance('test-service')
      assert(instance) // Should select an instance
      // Note: Could be either the one without instanceId or client-1, both are valid
    })
  })
})
