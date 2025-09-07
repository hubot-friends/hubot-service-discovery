import DiscoveryServiceAdapter from './adapter.mjs'

export default {
    async use(robot) {
        const adapter = new DiscoveryServiceAdapter(robot)
        return adapter
    }
}
