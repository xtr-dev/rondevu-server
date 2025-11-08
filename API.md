# HTTP API

This API provides peer signaling and tracking endpoints for distributed peer-to-peer applications. Uses JSON request/response bodies with Origin-based session isolation.

All endpoints require an `Origin` header and accept `application/json` content type.

---

## Overview

Sessions are organized by:
- **Origin**: The HTTP Origin header (e.g., `https://example.com`) - isolates sessions by application
- **Topic**: A string identifier for grouping related peers (max 256 chars)
- **Info**: User-provided metadata (max 1024 chars) to uniquely identify each peer

This allows multiple peers from the same application (origin) to discover each other through topics while preventing duplicate connections by comparing the info field.

---

## GET `/`

Returns server version information including the git commit hash used to build the server.

### Response

**Content-Type:** `application/json`

**Success (200 OK):**
```json
{
  "version": "a1b2c3d"
}
```

**Notes:**
- Returns the git commit hash from build time
- Returns "unknown" if git information is not available

### Example

```bash
curl -X GET http://localhost:3000/
```

---

## GET `/topics`

Lists all topics with the count of available peers for each (paginated). Returns only topics that have unanswered sessions.

### Request

**Headers:**
- `Origin: https://example.com` (required)

**Query Parameters:**

| Parameter | Type   | Required | Default | Description                     |
|-----------|--------|----------|---------|---------------------------------|
| `page`    | number | No       | `1`     | Page number (starting from 1)   |
| `limit`   | number | No       | `100`   | Results per page (max 1000)     |

### Response

**Content-Type:** `application/json`

**Success (200 OK):**
```json
{
  "topics": [
    {
      "topic": "my-room",
      "count": 3
    },
    {
      "topic": "another-room",
      "count": 1
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 100,
    "total": 2,
    "hasMore": false
  }
}
```

**Notes:**
- Only returns topics from the same origin as the request
- Only includes topics with at least one unanswered session
- Topics are sorted alphabetically
- Counts only include unexpired sessions
- Maximum 1000 results per page

### Examples

**Default pagination (page 1, limit 100):**
```bash
curl -X GET http://localhost:3000/topics \
  -H "Origin: https://example.com"
```

**Custom pagination:**
```bash
curl -X GET "http://localhost:3000/topics?page=2&limit=50" \
  -H "Origin: https://example.com"
```

---

## GET `/:topic/sessions`

Discovers available peers for a given topic. Returns all unanswered sessions from the requesting origin.

### Request

**Headers:**
- `Origin: https://example.com` (required)

**Path Parameters:**

| Parameter | Type   | Required | Description                   |
|-----------|--------|----------|-------------------------------|
| `topic`   | string | Yes      | Topic identifier to query     |

### Response

**Content-Type:** `application/json`

**Success (200 OK):**
```json
{
  "sessions": [
    {
      "code": "550e8400-e29b-41d4-a716-446655440000",
      "info": "peer-123",
      "offer": "<SIGNALING_DATA>",
      "offerCandidates": ["<SIGNALING_DATA>"],
      "createdAt": 1699564800000,
      "expiresAt": 1699565100000
    },
    {
      "code": "660e8400-e29b-41d4-a716-446655440001",
      "info": "peer-456",
      "offer": "<SIGNALING_DATA>",
      "offerCandidates": [],
      "createdAt": 1699564850000,
      "expiresAt": 1699565150000
    }
  ]
}
```

**Notes:**
- Only returns sessions from the same origin as the request
- Only returns sessions that haven't been answered yet
- Sessions are ordered by creation time (newest first)
- Use the `info` field to avoid answering your own offers

### Example

```bash
curl -X GET http://localhost:3000/my-room/sessions \
  -H "Origin: https://example.com"
```

---

## POST `/:topic/offer`

Announces peer availability and creates a new session for the specified topic. Returns a unique session code (UUID) for other peers to connect to.

### Request

**Headers:**
- `Content-Type: application/json`
- `Origin: https://example.com` (required)

**Path Parameters:**

| Parameter | Type   | Required | Description                                  |
|-----------|--------|----------|----------------------------------------------|
| `topic`   | string | Yes      | Topic identifier for grouping peers (max 256 characters) |

**Body Parameters:**

| Parameter | Type   | Required | Description                                  |
|-----------|--------|----------|----------------------------------------------|
| `info`    | string | Yes      | Peer identifier/metadata (max 1024 characters) |
| `offer`   | string | Yes      | Signaling data for peer connection           |

### Response

**Content-Type:** `application/json`

**Success (200 OK):**
```json
{
  "code": "550e8400-e29b-41d4-a716-446655440000"
}
```

Returns a unique UUID session code.

### Example

```bash
curl -X POST http://localhost:3000/my-room/offer \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{
    "info": "peer-123",
    "offer": "<SIGNALING_DATA>"
  }'

# Response:
# {"code":"550e8400-e29b-41d4-a716-446655440000"}
```

---

## POST `/answer`

Connects to an existing peer session by sending connection data or exchanging signaling information.

### Request

**Headers:**
- `Content-Type: application/json`
- `Origin: https://example.com` (required)

**Body Parameters:**

| Parameter   | Type   | Required | Description                                              |
|-------------|--------|----------|----------------------------------------------------------|
| `code`      | string | Yes      | The session UUID from the offer                          |
| `answer`    | string | No*      | Response signaling data for connection establishment     |
| `candidate` | string | No*      | Additional signaling data for connection negotiation     |
| `side`      | string | Yes      | Which peer is sending: `offerer` or `answerer`           |

*Either `answer` or `candidate` must be provided, but not both.

### Response

**Content-Type:** `application/json`

**Success (200 OK):**
```json
{
  "success": true
}
```

**Notes:**
- Origin header must match the session's origin
- Sessions are isolated by origin to group topics by domain

### Examples

**Sending connection response:**
```bash
curl -X POST http://localhost:3000/answer \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{
    "code": "550e8400-e29b-41d4-a716-446655440000",
    "answer": "<SIGNALING_DATA>",
    "side": "answerer"
  }'

# Response:
# {"success":true}
```

**Sending additional signaling data:**
```bash
curl -X POST http://localhost:3000/answer \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{
    "code": "550e8400-e29b-41d4-a716-446655440000",
    "candidate": "<SIGNALING_DATA>",
    "side": "offerer"
  }'

# Response:
# {"success":true}
```

---

## POST `/poll`

Retrieves session data including offers, responses, and signaling information from the other peer.

### Request

**Headers:**
- `Content-Type: application/json`
- `Origin: https://example.com` (required)

**Body Parameters:**

| Parameter | Type   | Required | Description                                     |
|-----------|--------|----------|-------------------------------------------------|
| `code`    | string | Yes      | The session UUID                                |
| `side`    | string | Yes      | Which side is polling: `offerer` or `answerer`  |

### Response

**Content-Type:** `application/json`

**Success (200 OK):**

Response varies by side:

**For `side=offerer` (the offerer polls for response from answerer):**
```json
{
  "answer": "<SIGNALING_DATA>",
  "answerCandidates": [
    "<SIGNALING_DATA_1>",
    "<SIGNALING_DATA_2>"
  ]
}
```

**For `side=answerer` (the answerer polls for offer from offerer):**
```json
{
  "offer": "<SIGNALING_DATA>",
  "offerCandidates": [
    "<SIGNALING_DATA_1>",
    "<SIGNALING_DATA_2>"
  ]
}
```

**Notes:**
- `answer` will be `null` if the answerer hasn't responded yet
- Candidate arrays will be empty `[]` if no additional signaling data has been sent
- Use this endpoint for polling to check for new signaling data
- Origin header must match the session's origin

### Examples

**Answerer polling for signaling data:**
```bash
curl -X POST http://localhost:3000/poll \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{
    "code": "550e8400-e29b-41d4-a716-446655440000",
    "side": "answerer"
  }'

# Response:
# {
#   "offer": "<SIGNALING_DATA>",
#   "offerCandidates": ["<SIGNALING_DATA>"]
# }
```

**Offerer polling for response:**
```bash
curl -X POST http://localhost:3000/poll \
  -H "Content-Type: application/json" \
  -H "Origin: https://example.com" \
  -d '{
    "code": "550e8400-e29b-41d4-a716-446655440000",
    "side": "offerer"
  }'

# Response:
# {
#   "answer": "<SIGNALING_DATA>",
#   "answerCandidates": ["<SIGNALING_DATA>"]
# }
```

---

## GET `/health`

Health check endpoint.

### Response

**Content-Type:** `application/json`

**Success (200 OK):**
```json
{
  "status": "ok",
  "timestamp": 1699564800000
}
```

---

## Error Responses

All endpoints may return the following error responses:

**400 Bad Request:**
```json
{
  "error": "Missing or invalid required parameter: topic"
}
```

**404 Not Found:**
```json
{
  "error": "Session not found, expired, or origin mismatch"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Internal server error"
}
```

---

## Usage Flow

### Peer Discovery and Connection

1. **Check server version (optional):**
   - GET `/` to see server version information

2. **Discover active topics:**
   - GET `/topics` to see all topics and peer counts
   - Optional: paginate through results with `?page=2&limit=100`

3. **Peer A announces availability:**
   - POST `/:topic/offer` with peer identifier and signaling data
   - Receives a unique session code

4. **Peer B discovers peers:**
   - GET `/:topic/sessions` to list available sessions in a topic
   - Filters out sessions with their own info to avoid self-connection
   - Selects a peer to connect to

5. **Peer B initiates connection:**
   - POST `/answer` with the session code and their signaling data

6. **Both peers exchange signaling information:**
   - POST `/answer` with additional signaling data as needed
   - POST `/poll` to retrieve signaling data from the other peer

7. **Peer connection established**
   - Peers use exchanged signaling data to establish direct connection
   - Session automatically expires after configured timeout
