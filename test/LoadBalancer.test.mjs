import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import LoadBalancer from '../lib/LoadBalancer.mjs'

describe('LoadBalancer', () => {
  let loadBalancer
  let mockLogger

  beforeEach(() => {
    mockLogger = {
      debug: mock.fn(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn()
    }
    
    loadBalancer = new LoadBalancer({
      strategy: 'round-robin',
      logger: mockLogger
    })
  })

  describe('constructor', () => {
    test('should initialize with default strategy', () => {
      const lb = new LoadBalancer()
      assert.strictEqual(lb.strategy, 'round-robin')
      assert.strictEqual(lb.roundRobinIndex, 0)
    })

    test('should initialize with custom strategy', () => {
      const lb = new LoadBalancer({ strategy: 'random' })
      assert.strictEqual(lb.strategy, 'random')
    })
  })

  describe('selectInstance', () => {
    test('should return null when no instances provided', () => {
      const instance = loadBalancer.selectInstance([])
      assert.strictEqual(instance, null)
    })

    test('should select instance using configured strategy', () => {
      const instances = [
        { instanceId: 'worker-1' },
        { instanceId: 'worker-2' }
      ]

      const instance = loadBalancer.selectInstance(instances)
      assert(instance)
      assert.strictEqual(instance.instanceId, 'worker-1') // First in round-robin
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

    test('should reset counter when approaching MAX_SAFE_INTEGER', () => {
      const instances = [
        { instanceId: 'client-1' },
        { instanceId: 'client-2' },
        { instanceId: 'client-3' }
      ]
      
      // Set counter close to MAX_SAFE_INTEGER
      loadBalancer.roundRobinIndex = Number.MAX_SAFE_INTEGER - 1
      
      // Should reset and continue normally
      const instance = loadBalancer.selectRoundRobin(instances)
      assert(instance)
      assert.strictEqual(instance.instanceId, 'client-1') // Starts from beginning after reset
      assert.strictEqual(loadBalancer.roundRobinIndex, 1) // Incremented to 1 after selecting index 0
      
      // Next call should work normally
      const nextInstance = loadBalancer.selectRoundRobin(instances)
      assert.strictEqual(nextInstance.instanceId, 'client-2')
      assert.strictEqual(loadBalancer.roundRobinIndex, 2)
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

  describe('strategy integration', () => {
    const instances = [
      { instanceId: 'client-1', metadata: { connections: 3 } },
      { instanceId: 'client-2', metadata: { connections: 1 } },
      { instanceId: 'client-3', metadata: { connections: 5 } }
    ]

    test('should use round-robin strategy by default', () => {
      assert.strictEqual(loadBalancer.selectInstance(instances).instanceId, 'client-1')
      assert.strictEqual(loadBalancer.selectInstance(instances).instanceId, 'client-2')
      assert.strictEqual(loadBalancer.selectInstance(instances).instanceId, 'client-3')
      assert.strictEqual(loadBalancer.selectInstance(instances).instanceId, 'client-1')
    })

    test('should use least-connections strategy when configured', () => {
      loadBalancer.setStrategy('least-connections')
      const instance = loadBalancer.selectInstance(instances)
      assert.strictEqual(instance.instanceId, 'client-2') // Has least connections (1)
    })

    test('should fall back to round-robin for unknown strategy', () => {
      loadBalancer.strategy = 'unknown-strategy' // Bypass validation
      const instance = loadBalancer.selectInstance(instances)
      assert(instance) // Should still select an instance
      assert.strictEqual(mockLogger.warn.mock.callCount(), 1)
    })
  })

  describe('edge cases', () => {
    test('should handle empty instances array', () => {
      const instance = loadBalancer.selectInstance([])
      assert.strictEqual(instance, null)
    })

    test('should handle null instances', () => {
      const instance = loadBalancer.selectInstance(null)
      assert.strictEqual(instance, null)
    })

    test('should handle undefined instances', () => {
      const instance = loadBalancer.selectInstance(undefined)
      assert.strictEqual(instance, null)
    })

    test('should handle instances without instanceId', () => {
      const instances = [
        { }, // Missing instanceId
        { instanceId: 'client-1' }
      ]

      // Should still work with valid instances
      const instance = loadBalancer.selectInstance(instances)
      assert(instance) // Should select an instance
    })
  })

  describe('Per-group round-robin', () => {
    const groupAInstances = [
      { instanceId: 'group-a-1' },
      { instanceId: 'group-a-2' }
    ]
    const groupBInstances = [
      { instanceId: 'group-b-1' },
      { instanceId: 'group-b-2' },
      { instanceId: 'group-b-3' }
    ]

    test('should maintain separate round-robin indices per group', () => {
      // Select from group A
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-1')
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-2')
      
      // Select from group B
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-1')
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-2')
      
      // Back to group A - should continue where we left off
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-1')
      
      // Back to group B - should continue where we left off
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-3')
    })

    test('should wrap around correctly for each group', () => {
      // Select twice from group B to cycle through all
      loadBalancer.selectInstance(groupBInstances, 'groupB') // index 0
      loadBalancer.selectInstance(groupBInstances, 'groupB') // index 1
      loadBalancer.selectInstance(groupBInstances, 'groupB') // index 2
      
      // Next should wrap to 0
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-1')
    })

    test('should handle multiple groups independently', () => {
      const groupCInstances = [{ instanceId: 'group-c-1' }]
      
      // Select from all three groups in mixed order
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-1')
      assert.strictEqual(loadBalancer.selectInstance(groupCInstances, 'groupC').instanceId, 'group-c-1')
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-1')
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-2')
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-2')
      assert.strictEqual(loadBalancer.selectInstance(groupCInstances, 'groupC').instanceId, 'group-c-1')
    })

    test('should reset per-group index when specified', () => {
      // Advance group A
      loadBalancer.selectInstance(groupAInstances, 'groupA')
      loadBalancer.selectInstance(groupAInstances, 'groupA')
      
      // Advance group B
      loadBalancer.selectInstance(groupBInstances, 'groupB')
      loadBalancer.selectInstance(groupBInstances, 'groupB')
      
      // Reset only group A
      loadBalancer.resetRoundRobin('groupA')
      
      // Group A should restart
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-1')
      
      // Group B should continue where it left off
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-3')
    })

    test('should reset all group indices when no group specified', () => {
      // Advance both groups
      loadBalancer.selectInstance(groupAInstances, 'groupA')
      loadBalancer.selectInstance(groupBInstances, 'groupB')
      
      // Reset all
      loadBalancer.resetRoundRobin()
      
      // Both should restart
      assert.strictEqual(loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId, 'group-a-1')
      assert.strictEqual(loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId, 'group-b-1')
    })
  })

  describe('Random strategy with groups', () => {
    const groupAInstances = [
      { instanceId: 'group-a-1' },
      { instanceId: 'group-a-2' }
    ]
    const groupBInstances = [
      { instanceId: 'group-b-1' },
      { instanceId: 'group-b-2' }
    ]

    beforeEach(() => {
      loadBalancer.setStrategy('random')
    })

    test('should select random instance from group regardless of groupId', () => {
      const groupAId = loadBalancer.selectInstance(groupAInstances, 'groupA').instanceId
      assert(['group-a-1', 'group-a-2'].includes(groupAId))
      
      const groupBId = loadBalancer.selectInstance(groupBInstances, 'groupB').instanceId
      assert(['group-b-1', 'group-b-2'].includes(groupBId))
    })

    test('should work without groupId for random strategy', () => {
      const instance = loadBalancer.selectInstance(groupAInstances)
      assert(['group-a-1', 'group-a-2'].includes(instance.instanceId))
    })
  })

  describe('Least-connections strategy with groups', () => {
    const groupAInstances = [
      { instanceId: 'group-a-1', metadata: { connections: 5 } },
      { instanceId: 'group-a-2', metadata: { connections: 2 } }
    ]
    const groupBInstances = [
      { instanceId: 'group-b-1', metadata: { connections: 3 } },
      { instanceId: 'group-b-2', metadata: { connections: 1 } }
    ]

    beforeEach(() => {
      loadBalancer.setStrategy('least-connections')
    })

    test('should select instance with least connections per group', () => {
      const groupAInstance = loadBalancer.selectInstance(groupAInstances, 'groupA')
      assert.strictEqual(groupAInstance.instanceId, 'group-a-2') // Has 2 connections
      
      const groupBInstance = loadBalancer.selectInstance(groupBInstances, 'groupB')
      assert.strictEqual(groupBInstance.instanceId, 'group-b-2') // Has 1 connection
    })

    test('should ignore groupId for least-connections strategy', () => {
      // groupId should be ignored for least-connections
      const instance = loadBalancer.selectInstance(groupAInstances, 'anyGroupId')
      assert.strictEqual(instance.instanceId, 'group-a-2')
    })
  })
})