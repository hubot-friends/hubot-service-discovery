import { EventEmitter } from 'events'

export default class LoadBalancer extends EventEmitter {
  constructor(registry, options = {}) {
    super()
    this.registry = registry
    this.strategy = options.strategy || 'round-robin'
    this.roundRobinIndex = 0
    this.logger = options.logger || console
  }

  /**
   * Select an instance for message routing based on the configured strategy
   * @param {string} serviceName - Name of the service to route to
   * @param {Object} messageData - The message data (for potential routing decisions)
   * @returns {Object|null} Selected instance or null if none available
   */
  selectInstance(serviceName, messageData = {}) {
    const instances = this.getHealthyInstances(serviceName)
    
    if (instances.length === 0) {
      this.logger.debug(`No healthy instances available for service: ${serviceName}`)
      return null
    }

    switch (this.strategy) {
      case 'round-robin':
        return this.selectRoundRobin(instances)
      case 'random':
        return this.selectRandom(instances)
      case 'least-connections':
        return this.selectLeastConnections(instances)
      default:
        this.logger.warn(`Unknown strategy: ${this.strategy}, falling back to round-robin`)
        return this.selectRoundRobin(instances)
    }
  }

  /**
   * Get healthy instances for a service (excluding the server instance)
   * @param {string} serviceName - Name of the service
   * @returns {Array} Array of healthy instances
   */
  getHealthyInstances(serviceName) {
    const allInstances = this.registry.discover(serviceName)
    
    if (!allInstances || !allInstances.instances) {
      return []
    }

    // Filter out server instances and unhealthy instances
    return allInstances.instances.filter(instance => {
      // Exclude server instances (they handle routing, not processing)
      if (instance.isServer === true) {
        return false
      }
      
      // Check if instance is healthy (has recent heartbeat)
      const now = Date.now()
      const lastHeartbeat = instance.lastHeartbeat || instance.registeredAt || 0
      const timeSinceHeartbeat = now - lastHeartbeat
      
      // Consider instance healthy if heartbeat is within timeout window
      return timeSinceHeartbeat < (this.registry.heartbeatTimeoutMs || 30000)
    })
  }

  /**
   * Round-robin instance selection
   * @param {Array} instances - Available instances
   * @returns {Object} Selected instance
   */
  selectRoundRobin(instances) {
    if (instances.length === 0) return null
    
    const selectedInstance = instances[this.roundRobinIndex % instances.length]
    this.roundRobinIndex = (this.roundRobinIndex + 1) % instances.length
    
    this.logger.debug(`Round-robin selected instance: ${selectedInstance.instanceId}`)
    return selectedInstance
  }

  /**
   * Random instance selection
   * @param {Array} instances - Available instances
   * @returns {Object} Selected instance
   */
  selectRandom(instances) {
    if (instances.length === 0) return null
    
    const randomIndex = Math.floor(Math.random() * instances.length)
    const selectedInstance = instances[randomIndex]
    
    this.logger.debug(`Random selected instance: ${selectedInstance.instanceId}`)
    return selectedInstance
  }

  /**
   * Least connections instance selection
   * @param {Array} instances - Available instances
   * @returns {Object} Selected instance
   */
  selectLeastConnections(instances) {
    if (instances.length === 0) return null
    
    // Sort by connection count (assume metadata.connections or default to 0)
    const sortedInstances = instances.sort((a, b) => {
      const aConnections = a.metadata?.connections || 0
      const bConnections = b.metadata?.connections || 0
      return aConnections - bConnections
    })
    
    const selectedInstance = sortedInstances[0]
    this.logger.debug(`Least connections selected instance: ${selectedInstance.instanceId}`)
    return selectedInstance
  }

  /**
   * Get load balancing statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const stats = {
      strategy: this.strategy,
      roundRobinIndex: this.roundRobinIndex,
      totalServices: 0,
      totalInstances: 0,
      healthyInstances: 0
    }

    const allServices = this.registry.discoverAll()
    stats.totalServices = Object.keys(allServices).length
    
    // Count total instances correctly
    stats.totalInstances = Object.values(allServices).reduce((sum, service) => {
      return sum + (service.instances ? service.instances.length : 0)
    }, 0)
    
    // Count healthy instances across all services
    Object.keys(allServices).forEach(serviceName => {
      const healthy = this.getHealthyInstances(serviceName)
      stats.healthyInstances += healthy.length
    })

    return stats
  }

  /**
   * Reset round-robin counter
   */
  resetRoundRobin() {
    this.roundRobinIndex = 0
  }

  /**
   * Change load balancing strategy
   * @param {string} strategy - New strategy ('round-robin', 'random', 'least-connections')
   */
  setStrategy(strategy) {
    const validStrategies = ['round-robin', 'random', 'least-connections']
    if (!validStrategies.includes(strategy)) {
      throw new Error(`Invalid strategy: ${strategy}. Valid strategies: ${validStrategies.join(', ')}`)
    }
    
    this.strategy = strategy
    this.resetRoundRobin()
    this.logger.info(`Load balancing strategy changed to: ${strategy}`)
  }
}
