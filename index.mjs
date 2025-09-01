import ServiceDiscoveryAdapter from './adapter.mjs'

export default {
    async use(robot) {
        const adapter = new ServiceDiscoveryAdapter(robot)
        return adapter
    }
}
