# A refunded Team purchase voids its unclaimed Team Seats

A Team purchase pays for several Team Seats at once. A seat that has been claimed belongs to the learner who redeemed it, so a purchase with any claimed seat can't be refunded at all. A purchase where every seat is still unclaimed can be refunded. When Staff approve that Refund Request, all of its unclaimed Team Seats stop working and can no longer be redeemed. The Refund is always the full amount paid, so the Team must not keep anything it was refunded for.

The buyer has no enrollment from a Team purchase, so approval removes no course access. Voiding the seats is the only effect on access.

## Considered Options

- **Refund only the unclaimed seats, pro rata, and allow it after some seats are claimed.** Rejected. It conflicts with "a Refund is always the full amount paid" and would need partial Refunds, which we don't model.
- **Leave unclaimed seats redeemable after the refund.** Rejected. The Team would get seats it was refunded for.
- **Delete the coupon rows.** Rejected. It loses the record of what was bought and refunded. Seats are marked as voided instead.

## Consequences

- Seat codes need a voided marker. Redeeming a code must check it, and the code must say it no longer works rather than "not found".
- A Team that has claimed even one seat can't get a refund through this flow. Such a case needs Staff to handle it outside the app.
