# Rondevu Server Development Guidelines

## WebRTC Signaling Best Practices

### ICE Candidate Storage

**IMPORTANT: Store ICE candidates as raw JSON without enforcing structure.**

When handling ICE candidates in the signaling server:

- ✅ **DO** store candidates as `JSON.stringify(candidate)` in the database
- ✅ **DO** retrieve candidates as `JSON.parse(candidate)` from the database
- ✅ **DO** use generic types like `any` in TypeScript for candidate data
- ❌ **DON'T** define strict types for ICE candidate structure
- ❌ **DON'T** validate or modify candidate properties
- ❌ **DON'T** assume you know what properties clients will send

**Why?** The server is just a relay - it doesn't need to understand the candidate structure. Different browsers and future WebRTC versions may include different properties. By keeping the server agnostic, we maintain maximum compatibility.

### Server Role Filtering

The server MUST filter ICE candidates by role:
- Offerers receive only answerer candidates (`WHERE role = 'answerer'`)
- Answerers receive only offerer candidates (`WHERE role = 'offerer'`)

This prevents peers from receiving their own candidates, which would cause connection failures.

## Security

- Always validate authentication tokens before allowing operations
- Verify ownership before allowing modifications
- Rate limit API endpoints to prevent abuse
- Clean up expired offers regularly

## Performance

- Use transactions for batch operations (SQLite)
- Index frequently queried columns (offer_id, role, created_at)
- Set appropriate TTLs for offers
- Implement pagination for large result sets

## Code Quality

- Handle errors gracefully with informative HTTP status codes
- Log important events for debugging
- Use TypeScript types for API contracts, but keep data types generic
- Write tests for critical paths
