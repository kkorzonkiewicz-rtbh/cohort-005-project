# An Approved Refund Request removes the enrollment and nothing else

When Staff approve a Refund Request, the learner loses access to the course straight away. We do this by deleting only their enrollment row. Their lesson progress, video watch events, quiz attempts and course rating stay. Removing the enrollment is enough to block the course, because every access check reads it. Keeping the history means a learner who buys the course again picks up where they left off, and the record of what they watched before asking for their money back is preserved.

## Considered Options

- **Wipe all course data for the learner.** Rejected. It destroys history we may need if a refund is disputed, and makes re-purchase start from zero.
- **Replace enrollment with Access derived from purchases and refunds.** Deferred. It's the cleaner model, but it touches about 20 read sites that have no tests, so it is out of scope for refund decisions.

## Consequences

- Rows that look orphaned are expected. Progress, watch events, quiz attempts and ratings can exist for a learner with no enrollment. Don't add a cleanup job or a foreign-key cascade that deletes them.
- Anything counting learners per course (student lists, counts, analytics) should count enrollments, not progress rows. Otherwise refunded learners will show up.
- Ratings left by a refunded learner stay on the course.
