import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "~/db";
import { coupons, enrollments, purchases } from "~/db/schema";

/**
 * A Team Seat nobody has claimed and no approved Refund has voided (ADR 0002):
 * the only kind of seat that can still be redeemed, and the only kind an
 * approved Refund voids.
 */
export function isUnclaimedTeamSeat() {
  return and(isNull(coupons.redeemedByUserId), isNull(coupons.voidedAt));
}

/** Whether a Team Seat already loaded from the database can still be redeemed. */
export function isRedeemable(seat: {
  redeemedByUserId: number | null;
  voidedAt: string | null;
}) {
  return seat.redeemedByUserId === null && seat.voidedAt === null;
}

/** Whether any Team Seat bought with this purchase has been claimed. */
export function hasClaimedTeamSeat(db: Pick<Db, "select">, purchaseId: number) {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(
        eq(coupons.purchaseId, purchaseId),
        isNotNull(coupons.redeemedByUserId)
      )
    )
    .get();

  return claimed !== undefined;
}

export const TEAM_SEAT_VOIDED_MESSAGE = "This code no longer works";

export type RedeemTeamSeatResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

/**
 * Claims a Team Seat for a learner and enrolls them in its course. The claim
 * only matches a seat that is still unclaimed and not voided, so a seat voided
 * by an approved Refund, or claimed by someone else, at the same moment is
 * refused rather than claimed twice.
 */
export function redeemTeamSeat(
  db: Db,
  {
    code,
    learnerId,
    learnerCountry,
  }: { code: string; learnerId: number; learnerCountry: string }
): RedeemTeamSeatResult {
  return db.transaction((tx): RedeemTeamSeatResult => {
    const seat = tx.select().from(coupons).where(eq(coupons.code, code)).get();
    if (!seat) return { ok: false, error: "Coupon not found" };

    if (seat.redeemedByUserId !== null) {
      return { ok: false, error: "Coupon has already been redeemed" };
    }
    if (seat.voidedAt !== null) {
      return { ok: false, error: TEAM_SEAT_VOIDED_MESSAGE };
    }

    const existingEnrollment = tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, learnerId),
          eq(enrollments.courseId, seat.courseId)
        )
      )
      .get();
    if (existingEnrollment) {
      return { ok: false, error: "You are already enrolled in this course" };
    }

    const purchase = tx
      .select({ country: purchases.country })
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== learnerCountry) {
      return {
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      };
    }

    const { changes } = tx
      .update(coupons)
      .set({
        redeemedByUserId: learnerId,
        redeemedAt: new Date().toISOString(),
      })
      .where(and(eq(coupons.id, seat.id), isUnclaimedTeamSeat()))
      .run();
    if (changes === 0) {
      return { ok: false, error: TEAM_SEAT_VOIDED_MESSAGE };
    }

    const enrollment = tx
      .insert(enrollments)
      .values({ userId: learnerId, courseId: seat.courseId })
      .returning()
      .get();

    return { ok: true, enrollment };
  });
}
