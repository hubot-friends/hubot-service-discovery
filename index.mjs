import DiscoveryServiceAdapter from './DiscoveryServiceAdapter.mjs'

export default {
    async use(robot) {
        const adapter = new DiscoveryServiceAdapter(robot)
        return adapter
    }
}
