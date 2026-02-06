# Security

## WebSocket Origin Validation

### Overview

The Discovery Service WebSocket server now includes origin validation to prevent unauthorized connections from malicious websites. This is a critical security feature that protects against Cross-Site WebSocket Hijacking (CSWSH) attacks.

### The Vulnerability

Without origin validation, any website could establish a WebSocket connection to your Discovery Service if a user visits that site. This could allow:

- Unauthorized service registration/deregistration
- Discovery of internal service topology
- Message routing exploitation
- Potential denial of service attacks

### The Fix

As of version 1.1.3, the WebSocket server validates the `Origin` header of incoming connections against an allowed list.

### Configuration

Set the `HUBOT_ALLOWED_ORIGINS` environment variable to enable origin validation:

```bash
# Single origin
export HUBOT_ALLOWED_ORIGINS='http://localhost:3000'

# Multiple origins (comma-separated)
export HUBOT_ALLOWED_ORIGINS='http://localhost:3000,https://yourdomain.com,https://app.yourdomain.com'

# Allow all origins (not recommended for production)
export HUBOT_ALLOWED_ORIGINS='*'
```

### Default Behavior (Backward Compatibility)

If `HUBOT_ALLOWED_ORIGINS` is not set, the server will:
- Accept all connections (backward compatible)
- Log a warning message recommending you enable origin validation

**⚠️ Warning:** Running without origin validation is insecure and only recommended for development or trusted internal networks.

### Connection Types

The origin validation handles different connection scenarios:

1. **Browser-based connections**: Origin header is validated against allowed list
2. **Direct WebSocket clients** (Node.js, CLI tools, etc.): Connections without an origin header are allowed
3. **Wildcard configuration**: Setting `*` allows all origins (use with caution)

### Production Recommendations

For production deployments:

1. **Always set `HUBOT_ALLOWED_ORIGINS`** with specific domain(s)
2. Use HTTPS origins when possible (`https://` instead of `http://`)
3. Be as restrictive as possible - only add origins that need access
4. Regularly audit your allowed origins list
5. Consider using a reverse proxy (nginx, HAProxy) for additional security layers

### Example Configurations

#### Development
```bash
export HUBOT_ALLOWED_ORIGINS='http://localhost:3000,http://localhost:8080'
```

#### Production
```bash
export HUBOT_ALLOWED_ORIGINS='https://app.company.com,https://api.company.com'
```

#### Internal Network (trusted environment)
```bash
# If you trust your internal network, you can allow all
export HUBOT_ALLOWED_ORIGINS='*'
# Or omit the variable entirely (not recommended)
```

### Testing

You can test origin validation using the provided test suite:

```bash
npm test -- test/WebSocketOriginValidation.test.mjs
```

### Additional Security Measures

Consider implementing these additional security practices:

1. **Network isolation**: Run the Discovery Service on a private network
2. **Firewall rules**: Restrict access to the WebSocket port (default 3100)
3. **Authentication**: Implement token-based authentication for service registration
4. **TLS/SSL**: Use `wss://` (WebSocket Secure) instead of `ws://`
5. **Rate limiting**: Implement connection rate limiting to prevent DoS attacks

### Reporting Security Issues

If you discover a security vulnerability, please email the maintainer directly rather than opening a public issue.
