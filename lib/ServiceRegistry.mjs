import { EventEmitter } from 'events'
import EventStore from './EventStore.mjs'

export class ServiceRegistry extends EventEmitter {
  constructor(options = {}) {
    super()
    const eventStoreOptions = options.eventStore || {}
    const defaultPersistEventTypes = [
      'SERVICE_REGISTERED',
      'SERVICE_DEREGISTERED',
      'INSTANCE_EXPIRED'
    ]
    this.eventStore = new EventStore({
      persistEventTypes: eventStoreOptions.persistEventTypes || defaultPersistEventTypes,
      ...eventStoreOptions
    })
    this.services = new Map() // serviceName -> Map(instanceId -> serviceInstance)
    this.instanceHeartbeats = new Map() // instanceId -> timestamp
    this.heartbeatTimeout = options.heartbeatTimeout || 60000 // 1 minute
    this.cleanupInterval = options.cleanupInterval || 30000 // 30 seconds
    this.closed = false
    
    this.setupEventHandlers()
    this.startCleanupTimer()
  }
  setupEventHandlers() {
    this.eventStore.on('event', (event) => {
      this.applyEvent(event)
    })

    this.eventStore.on('snapshot-needed', () => {
      this.createSnapshot()
    })

    this.eventStore.on('error', (error) => {
      this.emit('error', error)
    })
  }

  async initialize() {
    try {
      // Initialize the event store first
      await this.eventStore.initialize()
      
      // Load snapshot first to restore state
      const snapshot = await this.eventStore.loadSnapshot()
      if (snapshot && snapshot.state) {
        this.restoreFromSnapshot(snapshot.state)
      }

      // Then load and replay events since snapshot
      const events = await this.eventStore.loadEventsSinceSnapshot()
      for (const event of events) {
        this.applyEvent(event, false) // Don't re-emit events during replay
      }

      this.emit('initialized')
    } catch (error) {
      console.error('Error initializing service registry:', error)
      this.emit('error', error)
    }
  }

  async register(serviceName, instanceData) {
    const { instanceId, host, port, isServer, metadata = {} } = instanceData

    if (!serviceName || !instanceId || !host || !port) {
      throw new Error('Missing required fields: serviceName, instanceId, host, port')
    }

    const event = {
      type: 'SERVICE_REGISTERED',
      serviceName,
      instanceId,
      isServer,
      host,
      port,
      metadata
    }

    await this.eventStore.appendEvent(event)
    this.updateHeartbeat(instanceId)
    
    return { success: true, instanceId, serviceName }
  }

  async deregister(serviceName, instanceId) {
    if (!this.hasInstance(serviceName, instanceId)) {
      return { success: false, reason: 'Instance not found' }
    }

    const event = {
      type: 'SERVICE_DEREGISTERED',
      serviceName,
      instanceId
    }

    await this.eventStore.appendEvent(event)
    this.instanceHeartbeats.delete(instanceId)
    
    return { success: true, instanceId, serviceName }
  }

  async heartbeat(serviceName, instanceId) {
    // Support both old signature (serviceName, instanceId) and new signature (instanceId only)
    if (typeof serviceName === 'string' && typeof instanceId === 'undefined') {
      // Called with just instanceId (new signature)
      instanceId = serviceName
      serviceName = null
    }

    // Check if instance exists in any service
    let found = false
    for (const [svcName, instances] of this.services) {
      if (instances.has(instanceId)) {
        found = true
        break
      }
    }

    if (!found) {
      return { success: false, reason: 'Instance not registered' }
    }

    this.updateHeartbeat(instanceId)
    
    const event = {
      type: 'HEARTBEAT',
      instanceId
    }

    await this.eventStore.appendEvent(event)
    
    return { success: true, instanceId }
  }

  discover(serviceName) {
    if (!this.services.has(serviceName)) {
        return { instances: [], serviceName }
    }

    const instances = Array.from(this.services.get(serviceName).values())
      .filter(instance => this.isInstanceHealthy(instance.instanceId))
      .map(instance => ({
        instanceId: instance.instanceId,
        host: instance.host,
        port: instance.port,
        url: `ws://${instance.host}:${instance.port}`,
        isServer: instance.isServer,
        metadata: instance.metadata || {},
        lastSeen: this.instanceHeartbeats.get(instance.instanceId)
      }))

    return { instances, serviceName }
  }

  /**
   * Get healthy client instances for load balancing (excludes server instances)
   * @param {string} serviceName - Name of the service
   * @returns {Array} Array of healthy client instances
   */
  getHealthyInstances(serviceName) {
    if (!this.services.has(serviceName)) {
      return []
    }

    return Array.from(this.services.get(serviceName).values())
      .filter(instance => {
        // Check if instance is healthy
        if (!this.isInstanceHealthy(instance.instanceId)) {
          return false
        }
        
        // Exclude server instances (they handle routing, not processing)
        const isServer = instance.isServer || (instance.metadata && instance.metadata.isServer)
        return isServer !== true
      })
      .map(instance => ({
        instanceId: instance.instanceId,
        host: instance.host,
        port: instance.port,
        url: `ws://${instance.host}:${instance.port}`,
        isServer: instance.isServer,
        metadata: instance.metadata || {},
        lastSeen: this.instanceHeartbeats.get(instance.instanceId),
        // Spread metadata fields to top-level for compatibility
        ...instance.metadata
      }))
  }

  discoverAll() {
    const allServices = {}
    for (const serviceName of this.services.keys()) {
      const result = this.discover(serviceName)
      allServices[serviceName] = result.instances
    }
    return allServices
  }

  getStatus() {
    const services = {}
    for (const [serviceName, instances] of this.services) {
      services[serviceName] = {
        totalInstances: instances.size,
        healthyInstances: Array.from(instances.keys())
          .filter(instanceId => this.isInstanceHealthy(instanceId)).length
      }
    }

    return {
      services,
      totalInstances: this.getTotalInstanceCount(),
      eventCount: this.eventStore.eventCount,
      lastSnapshotTime: this.eventStore.lastSnapshotTime
    }
  }

  applyEvent(event, emit = true) {
    switch (event.type) {
      case 'SERVICE_REGISTERED':
        this.applyServiceRegistered(event)
        break
      case 'SERVICE_DEREGISTERED':
        this.applyServiceDeregistered(event)
        break
      case 'HEARTBEAT':
        this.applyHeartbeat(event)
        break
      case 'INSTANCE_EXPIRED':
        this.applyInstanceExpired(event)
        break
      default:
        console.warn('Unknown event type:', event.type)
    }

    if (emit) {
      this.emit('event-applied', event)
    }
  }

  applyServiceRegistered(event) {
    const { serviceName, instanceId, host, port, isServer, metadata } = event
    
    if (!this.services.has(serviceName)) {
      this.services.set(serviceName, new Map())
    }

    this.services.get(serviceName).set(instanceId, {
      instanceId,
      host,
      port,
      isServer,
      metadata,
      registeredAt: event.timestamp
    })

    this.updateHeartbeat(instanceId)
  }

  applyServiceDeregistered(event) {
    const { serviceName, instanceId } = event
    
    if (this.services.has(serviceName)) {
      this.services.get(serviceName).delete(instanceId)
      
      // Clean up empty service entries
      if (this.services.get(serviceName).size === 0) {
        this.services.delete(serviceName)
      }
    }

    this.instanceHeartbeats.delete(instanceId)
  }

  applyHeartbeat(event) {
    this.updateHeartbeat(event.instanceId)
  }

  applyInstanceExpired(event) {
    const { serviceName, instanceId } = event
    this.applyServiceDeregistered({ serviceName, instanceId })
  }

  updateHeartbeat(instanceId) {
    this.instanceHeartbeats.set(instanceId, Date.now())
  }

  isInstanceHealthy(instanceId) {
    const lastHeartbeat = this.instanceHeartbeats.get(instanceId)
    if (!lastHeartbeat) return false
    
    return (Date.now() - lastHeartbeat) < this.heartbeatTimeout
  }

  hasInstance(serviceName, instanceId) {
    return this.services.has(serviceName) && 
           this.services.get(serviceName).has(instanceId)
  }

  getTotalInstanceCount() {
    let total = 0
    for (const instances of this.services.values()) {
      total += instances.size
    }
    return total
  }

  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredInstances()
    }, this.cleanupInterval)
  }

  async cleanupExpiredInstances() {
    const now = Date.now()
    const expiredInstances = []

    for (const [serviceName, instances] of this.services) {
      for (const [instanceId, instance] of instances) {
        const lastHeartbeat = this.instanceHeartbeats.get(instanceId)
        if (!lastHeartbeat || (now - lastHeartbeat) >= this.heartbeatTimeout) {
          expiredInstances.push({ serviceName, instanceId })
        }
      }
    }

    for await (const { serviceName, instanceId } of expiredInstances) {
      const event = {
        type: 'INSTANCE_EXPIRED',
        serviceName,
        instanceId,
        reason: 'heartbeat_timeout'
      }

      await this.eventStore.appendEvent(event)
    }
  }

  async createSnapshot() {
    const state = {
      services: Object.fromEntries(
        Array.from(this.services.entries()).map(([serviceName, instances]) => [
          serviceName,
          Object.fromEntries(instances)
        ])
      ),
      heartbeats: Object.fromEntries(this.instanceHeartbeats)
    }

    await this.eventStore.createSnapshot(state)
  }

  restoreFromSnapshot(state) {
    // Restore services
    this.services.clear()
    for (const [serviceName, instances] of Object.entries(state.services || {})) {
      this.services.set(serviceName, new Map(Object.entries(instances)))
    }

    // Restore heartbeats
    this.instanceHeartbeats.clear()
    for (const [instanceId, timestamp] of Object.entries(state.heartbeats || {})) {
      this.instanceHeartbeats.set(instanceId, timestamp)
    }
  }

  async close() {
    if (this.closed) return // Already closed
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }
    
    // Create final snapshot
    await this.createSnapshot()
    this.closed = true
  }
}

export default ServiceRegistry
