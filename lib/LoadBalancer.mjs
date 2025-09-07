export default class LoadBalancer {
  constructor(options = {}) {
    this.strategy = options.strategy || 'round-robin'
    this.roundRobinIndex = 0
    this.logger = options.logger || console
  }

  /**
   * Select an instance for load balancing based on the configured strategy
   * @param {Array} instances - Array of instances to select from
   * @returns {Object|null} Selected instance or null if none available
   */
  selectInstance(instances) {
    if (!instances || instances.length === 0) {
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
   * Reset round-robin counter
   */
  resetRoundRobin() {
    this.roundRobinIndex = 0
  }

  /**
   * Get load balancing statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      strategy: this.strategy,
      roundRobinIndex: this.roundRobinIndex
    }
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
