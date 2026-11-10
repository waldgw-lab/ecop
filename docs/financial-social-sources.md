# Financial social-source access

## Working in this mirror

- Financial Times (`financialtimes.com`), Bloomberg (`bloomberg.com`), and The Economist (`economist.com`) have accessible public Bluesky author feeds. These domain-based account handles were checked against the public API.
- The application retrieves up to 50 recent posts per account every 15 minutes, excludes replies and unrelated-author reposts, and applies the same deterministic financial/security relevance screening used for news. Original publication dates and original-post links are retained.
- Publisher attribution identifies who posted something; it is not independent verification of the claim.
- Dataminr continues using the existing authorized connection. Only alerts whose destination is an actual social-post permalink appear in the social lane; a generic alert is not presented as a social post. Its text is labeled as a Dataminr report, not reconstructed original post text.
- Coverage is selective, not a complete global social-media firehose. Current account-level collection status appears in the social lane.

Bluesky API reference: https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed

## Meltwater findings

The existing secret was present and a read-only `GET /v3/searches` request succeeded. A dedicated financial-social saved search was not identified among the existing search names. Existing searches, watchlists, schedules and export jobs were not changed.

Recommended next connection:

1. Approve a separate financial-security Listening search rather than repurposing shared military searches.
2. Combine institutional and specialist accounts (central banks, finance ministries, IMF, energy authorities, monetary-policy reporters, energy reporters and sovereign-financing analysts) with financial-security topics.
3. Separate source credibility from event significance: institutional releases first for official decisions, specialist reporting for context, unconfirmed posts as leads only. Apply recency decay and deduplicate original-post URLs.
4. Confirm the account's Listening search/export entitlements, provider-specific redistribution rules, quotas and permitted retention before activating collection.
5. Retrieve permitted post text and metadata through Listening search/export; retain source attribution. Meltwater's documentation states that X exports may provide tweet IDs rather than text, requiring authorized X API rehydration for the text. Do not fabricate or infer omitted post text.

Meltwater Social Analytics is for owned accounts and is not a substitute for earned-media Listening searches covering outside commentators.

Official references:

- https://developer.meltwater.com/docs/meltwater-api/guides/concepts/
- https://developer.meltwater.com/guides/listening/exporting-mentions/
- https://developer.meltwater.com/guides/getting-started/overview/

## Market graph limitations

The S&P 500 cash index is collected separately from S&P 500 futures. Commodity futures include WTI, Brent, gold, U.S. natural gas, copper and wheat, each in its actual quoted units with daily absolute and percentage changes.

CNN's public Fear & Greed chart endpoint rejected the access check with HTTP 418. The dashboard therefore links to CNN and explicitly reports that this series is unavailable; VIX and OFR stress are not substitutes for it. A licensed or explicitly permitted historical source is needed before charting this particular index.
