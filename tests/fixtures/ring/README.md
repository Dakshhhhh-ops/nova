# Ring Partner API fixtures

Responses shaped like the Ring Partner API (JSON:API: `data`, `attributes`, `relationships`, `links.next` with a
`page[key]` cursor, `errors` on failure), following Ring's API documentation and the official starter
(github.com/AmazonAppDev/ring-api-helloworld). Names and ids are fictional.

Event times are written as `"{{YYYY-MM-DDTHH:MM:SS}}"` in the household's local time; `tests/test_ring_api.py`
turns them into epoch milliseconds (what Ring returns) so the tests pass in any time zone.
