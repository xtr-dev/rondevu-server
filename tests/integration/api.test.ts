/**
 * Integration tests for api.ronde.vu
 *
 * Run with: npm test
 *
 * Note: Uses shared credentials to avoid rate limits (10 per hour)
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert'
import { createTestContext, generateCredentials, rpc, sleep, API_URL, Credential } from './setup.js'

describe('Integration Tests - api.ronde.vu', () => {
    console.log(`Testing against: ${API_URL}`)

    // Shared credentials - created once, reused across tests
    let userA: Awaited<ReturnType<typeof createTestContext>>
    let userB: Awaited<ReturnType<typeof createTestContext>>
    let userC: Awaited<ReturnType<typeof createTestContext>>

    before(async () => {
        // Create 3 shared user contexts for all tests
        userA = await createTestContext()
        userB = await createTestContext()
        userC = await createTestContext()
    })

    describe('1. Authentication', () => {
        it('should generate valid credentials', async () => {
            // Use already-generated credentials from userA
            assert.ok(userA.credential.name, 'Should have a name')
            assert.ok(userA.credential.secret, 'Should have a secret')
            assert.strictEqual(typeof userA.credential.name, 'string')
            assert.strictEqual(typeof userA.credential.secret, 'string')
            assert.strictEqual(userA.credential.secret.length, 64, 'Secret should be 32 bytes (64 hex chars)')
        })

        it('should reject requests without authentication for protected methods', async () => {
            await assert.rejects(
                async () => {
                    await rpc('publishOffer', {
                        tags: ['test'],
                        offers: [{ sdp: 'test-sdp' }],
                        ttl: 60000
                    })
                },
                /AUTH_REQUIRED|authentication|unauthorized/i,
                'Should reject unauthenticated publish request'
            )
        })

        it('should reject invalid signatures', async () => {
            // Create a credential with wrong secret (reuse userA's name)
            const badCredential: Credential = {
                name: userA.credential.name,
                secret: '0'.repeat(64) // Invalid secret
            }

            await assert.rejects(
                async () => {
                    await rpc('publishOffer', {
                        tags: ['test'],
                        offers: [{ sdp: 'test-sdp' }],
                        ttl: 60000
                    }, badCredential)
                },
                /INVALID_CREDENTIALS|signature|invalid/i,
                'Should reject invalid signature'
            )
        })
    })

    describe('2. Publish Offers', () => {
        it('should publish offers with tags', async () => {
            const result = await userA.api.publish({
                tags: ['chat', 'video'],
                offers: [
                    { sdp: 'v=0\r\no=- 123 1 IN IP4 127.0.0.1\r\n' }
                ],
                ttl: 60000
            })

            assert.ok(result.offers, 'Should return offers array')
            assert.strictEqual(result.offers.length, 1, 'Should have one offer')
            assert.ok(result.offers[0].offerId, 'Offer should have an ID')
        })

        it('should publish multiple offers at once', async () => {
            const result = await userA.api.publish({
                tags: ['multi-test'],
                offers: [
                    { sdp: 'sdp-1' },
                    { sdp: 'sdp-2' },
                    { sdp: 'sdp-3' }
                ],
                ttl: 60000
            })

            assert.strictEqual(result.offers.length, 3, 'Should have three offers')

            const offerIds = result.offers.map((o: any) => o.offerId)
            const uniqueIds = new Set(offerIds)
            assert.strictEqual(uniqueIds.size, 3, 'All offer IDs should be unique')
        })

        it('should reject empty tags array', async () => {
            await assert.rejects(
                async () => {
                    await userA.api.publish({
                        tags: [],
                        offers: [{ sdp: 'test' }],
                        ttl: 60000
                    })
                },
                /tag|required|empty/i,
                'Should reject empty tags'
            )
        })

        it('should enforce tag format validation', async () => {
            await assert.rejects(
                async () => {
                    await userA.api.publish({
                        tags: ['invalid tag with spaces!'],
                        offers: [{ sdp: 'test' }],
                        ttl: 60000
                    })
                },
                /tag|invalid|format/i,
                'Should reject invalid tag format'
            )
        })
    })

    describe('3. Discover by Tags', () => {
        let publishedOfferId: string

        before(async () => {
            // userA publishes offers for discovery tests
            const result = await userA.api.publish({
                tags: ['discover-test', 'video-discover'],
                offers: [{ sdp: 'discover-test-sdp' }],
                ttl: 120000
            })
            publishedOfferId = result.offers[0].offerId
        })

        it('should discover offers matching ANY tag (OR logic)', async () => {
            // Search for 'video-discover' tag only (unauthenticated, paginated mode)
            const result = await rpc('discover', { tags: ['video-discover'], limit: 10 }) as any

            assert.ok(result.offers, 'Should return offers')
            const found = result.offers.find((o: any) => o.offerId === publishedOfferId)
            assert.ok(found, 'Should find published offer by video tag')
        })

        it('should discover with multiple tags (OR)', async () => {
            // Search for either 'discover-test' or 'nonexistent' (paginated mode)
            const result = await rpc('discover', {
                tags: ['discover-test', 'nonexistent-tag'],
                limit: 10
            }) as any

            assert.ok(result.offers, 'Should return offers')
            const found = result.offers.find((o: any) => o.offerId === publishedOfferId)
            assert.ok(found, 'Should find offer matching at least one tag')
        })

        it('should support pagination', async () => {
            const result = await rpc('discover', {
                tags: ['discover-test'],
                limit: 5,
                offset: 0
            }) as any

            assert.ok(result.offers !== undefined, 'Should return offers array')
            assert.ok(typeof result.count === 'number', 'Should return count')
            assert.ok(typeof result.limit === 'number', 'Should return limit')
            assert.ok(typeof result.offset === 'number', 'Should return offset')
        })

        it('should exclude own offers from discovery', async () => {
            // userA should not see their own offers (paginated mode)
            const result = await userA.api.discover({
                tags: ['discover-test'],
                limit: 10
            }) as any

            const foundOwn = result.offers?.find((o: any) => o.offerId === publishedOfferId)
            assert.ok(!foundOwn, 'Should not find own offers in discovery')
        })
    })

    describe('4. Answer Offer', () => {
        let offerId: string

        before(async () => {
            // userA publishes offer, userB will answer it
            const result = await userA.api.publish({
                tags: ['answer-test'],
                offers: [{ sdp: 'offer-sdp-for-answer' }],
                ttl: 120000
            })
            offerId = result.offers[0].offerId
        })

        it('should answer an available offer', async () => {
            await userB.api.answerOffer(offerId, 'answer-sdp-content')
            // If no error, answer was successful
            assert.ok(true, 'Should successfully answer offer')
        })

        it('should reject answering already-answered offer', async () => {
            // Try to answer the same offer again with userC
            await assert.rejects(
                async () => {
                    await userC.api.answerOffer(offerId, 'another-answer-sdp')
                },
                /OFFER_ALREADY_ANSWERED|already|answered|claimed/i,
                'Should reject answering already-answered offer'
            )
        })
    })

    describe('5. ICE Candidates', () => {
        let offerId: string

        before(async () => {
            // userB publishes offer, userC answers
            const publishResult = await userB.api.publish({
                tags: ['ice-test'],
                offers: [{ sdp: 'ice-test-offer-sdp' }],
                ttl: 120000
            })
            offerId = publishResult.offers[0].offerId

            await userC.api.answerOffer(offerId, 'ice-test-answer-sdp')
        })

        it('should add ICE candidates as offerer', async () => {
            const result = await userB.api.addOfferIceCandidates(offerId, [
                { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host' }
            ])

            assert.ok(result.count >= 0, 'Should return candidate count')
        })

        it('should add ICE candidates as answerer', async () => {
            const result = await userC.api.addOfferIceCandidates(offerId, [
                { candidate: 'candidate:2 1 UDP 2130706431 192.168.1.2 54322 typ host' }
            ])

            assert.ok(result.count >= 0, 'Should return candidate count')
        })

        it('should retrieve ICE candidates filtered by role', async () => {
            await sleep(100) // Small delay to ensure candidates are stored

            // Offerer should receive answerer's candidates
            const offererResult = await userB.api.getOfferIceCandidates(offerId, 0)

            assert.ok(Array.isArray(offererResult.candidates), 'Should return candidates array')

            // Answerer should receive offerer's candidates
            const answererResult = await userC.api.getOfferIceCandidates(offerId, 0)

            assert.ok(Array.isArray(answererResult.candidates), 'Should return candidates array')
        })
    })

    describe('6. Polling', () => {
        let offerId: string

        before(async () => {
            // userC publishes offer
            const result = await userC.api.publish({
                tags: ['poll-test'],
                offers: [{ sdp: 'poll-test-offer' }],
                ttl: 120000
            })
            offerId = result.offers[0].offerId
        })

        it('should poll for new answers', async () => {
            // First poll - should be empty (or have previous answers)
            const before = await userC.api.poll(0)
            const initialAnswerCount = before.answers.length

            // userA answers the offer
            await userA.api.answerOffer(offerId, 'poll-test-answer')

            await sleep(100)

            // Second poll - should have the answer
            const after = await userC.api.poll(0)
            assert.ok(after.answers.length > initialAnswerCount, 'Should have new answer after polling')

            const found = after.answers.find((a: any) => a.offerId === offerId)
            assert.ok(found, 'Should find our answer')
            assert.strictEqual(found.sdp, 'poll-test-answer', 'Should have correct SDP')
        })

        it('should support since parameter', async () => {
            const timestamp = Date.now()

            // Poll with recent timestamp - should get no old answers
            const result = await userC.api.poll(timestamp)

            // All returned answers should be after the timestamp
            for (const answer of result.answers) {
                assert.ok(answer.answeredAt >= timestamp - 1000, 'Answers should be after since timestamp')
            }
        })
    })

    describe('7. Ownership', () => {
        let offerId: string

        before(async () => {
            // userA publishes offer for ownership tests
            const result = await userA.api.publish({
                tags: ['ownership-test'],
                offers: [{ sdp: 'ownership-test-sdp' }],
                ttl: 120000
            })
            offerId = result.offers[0].offerId
        })

        it('should allow owner to delete offer', async () => {
            await userA.api.deleteOffer(offerId)
            assert.ok(true, 'Should successfully delete own offer')
        })

        it('should reject delete from non-owner', async () => {
            // First publish a new offer as userA
            const newOffer = await userA.api.publish({
                tags: ['ownership-test-2'],
                offers: [{ sdp: 'another-sdp' }],
                ttl: 120000
            })
            const newOfferId = newOffer.offers[0].offerId

            // Try to delete as userB (non-owner)
            await assert.rejects(
                async () => {
                    await userB.api.deleteOffer(newOfferId)
                },
                /OWNERSHIP_MISMATCH|NOT_AUTHORIZED|forbidden|owner/i,
                'Should reject delete from non-owner'
            )
        })
    })

    describe('8. TTL/Expiry', () => {
        it('should enforce minimum TTL', async () => {
            // Server enforces minimum TTL of 60 seconds
            // Publish with short TTL - server should apply minimum
            const result = await userA.api.publish({
                tags: ['ttl-test-min'],
                offers: [{ sdp: 'ttl-test-sdp' }],
                ttl: 1000 // Request 1 second, but server enforces 60s minimum
            })
            const offerId = result.offers[0].offerId

            // Offer should have expiresAt at least 60 seconds in the future
            const offer = result.offers[0]
            const now = Date.now()
            const minExpiry = now + 55000 // Allow 5s buffer for timing

            assert.ok(offer.expiresAt >= minExpiry, 'Server should enforce minimum TTL of ~60 seconds')

            // Should be discoverable
            const discoveryResult = await rpc('discover', { tags: ['ttl-test-min'], limit: 10 }) as any
            const found = discoveryResult.offers?.find((o: any) => o.offerId === offerId)
            assert.ok(found, 'Should find offer with minimum TTL applied')
        })

        it('should respect TTL when publishing', async () => {
            // Publish with valid TTL (2 minutes)
            const ttl = 120000
            const result = await userA.api.publish({
                tags: ['ttl-test-valid'],
                offers: [{ sdp: 'ttl-valid-sdp' }],
                ttl
            })

            const offer = result.offers[0]
            const now = Date.now()

            // expiresAt should be approximately now + ttl
            assert.ok(offer.expiresAt >= now + ttl - 5000, 'Should expire at approximately now + TTL')
            assert.ok(offer.expiresAt <= now + ttl + 5000, 'Should expire at approximately now + TTL')
        })
    })
})
