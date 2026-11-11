import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { redeemTeamSeat, TEAM_SEAT_VOIDED_MESSAGE } from "./team-seats.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function buyTeamSeat(code: string, country: string | null = null) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: base.instructor.id,
      courseId: base.course.id,
      amountPaid: 7900,
      country,
    })
    .returning()
    .get();
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      purchaseId: purchase.id,
      code,
    })
    .run();
}

function findSeat(code: string) {
  return testDb
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.code, code))
    .get();
}

function enrolledLearnerIds() {
  return testDb
    .select({ userId: schema.enrollments.userId })
    .from(schema.enrollments)
    .where(eq(schema.enrollments.courseId, base.course.id))
    .all()
    .map((row) => row.userId);
}

describe("redeemTeamSeat", () => {
  it("claims an unclaimed Team Seat for the learner and enrolls them", () => {
    buyTeamSeat("SEAT-1");

    const result = redeemTeamSeat(testDb, {
      code: "SEAT-1",
      learnerId: base.user.id,
      learnerCountry: "PL",
    });

    expect(result.ok).toBe(true);
    expect(findSeat("SEAT-1")?.redeemedByUserId).toBe(base.user.id);
    expect(enrolledLearnerIds()).toEqual([base.user.id]);
  });

  it("refuses a Team Seat voided by an approved Refund, and enrolls nobody", () => {
    buyTeamSeat("SEAT-1");
    testDb
      .update(schema.coupons)
      .set({ voidedAt: "2026-11-04T09:00:00.000Z" })
      .where(eq(schema.coupons.code, "SEAT-1"))
      .run();

    const result = redeemTeamSeat(testDb, {
      code: "SEAT-1",
      learnerId: base.user.id,
      learnerCountry: "PL",
    });

    expect(result).toEqual({ ok: false, error: TEAM_SEAT_VOIDED_MESSAGE });
    expect(findSeat("SEAT-1")?.redeemedByUserId).toBeNull();
    expect(enrolledLearnerIds()).toEqual([]);
  });

  it("refuses a Team Seat someone else already claimed, and keeps their claim", () => {
    buyTeamSeat("SEAT-1");
    redeemTeamSeat(testDb, {
      code: "SEAT-1",
      learnerId: base.instructor.id,
      learnerCountry: "PL",
    });

    const result = redeemTeamSeat(testDb, {
      code: "SEAT-1",
      learnerId: base.user.id,
      learnerCountry: "PL",
    });

    expect(result).toEqual({
      ok: false,
      error: "Coupon has already been redeemed",
    });
    expect(findSeat("SEAT-1")?.redeemedByUserId).toBe(base.instructor.id);
    expect(enrolledLearnerIds()).toEqual([base.instructor.id]);
  });

  it("refuses a learner outside the purchaser's country", () => {
    buyTeamSeat("SEAT-1", "US");

    const result = redeemTeamSeat(testDb, {
      code: "SEAT-1",
      learnerId: base.user.id,
      learnerCountry: "PL",
    });

    expect(result.ok).toBe(false);
    expect(enrolledLearnerIds()).toEqual([]);
  });
});
