import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import {
  approveRefundRequest,
  buildApprovedRefundRequestEmail,
  buildDeclinedRefundRequestEmail,
  declineRefundRequest,
  isTeamSeatRedeemable,
  listRefundRequestsForLearner,
  listRefundRequestsForStaff,
  RefundRequestAlreadyDecidedError,
} from "./refund-decisions.server";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function buy(learnerId: number, courseId: number, purchasedAt: string) {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: learnerId,
      courseId,
      amountPaid: 7900,
      createdAt: purchasedAt,
    })
    .returning()
    .get();
}

function raiseRefundRequest(
  purchaseId: number,
  requestedAt: string,
  status = schema.RefundStatus.Open
) {
  return testDb
    .insert(schema.refunds)
    .values({
      purchaseId,
      status,
      reason: "Bought the wrong one.",
      requestedAt,
    })
    .returning()
    .get();
}

function addLesson(courseId: number) {
  const module = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  return testDb
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function watch(learnerId: number, lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: learnerId,
      lessonId,
      eventType: "pause",
      positionSeconds,
    })
    .run();
}

function markLesson(
  learnerId: number,
  lessonId: number,
  status: schema.LessonProgressStatus
) {
  testDb
    .insert(schema.lessonProgress)
    .values({ userId: learnerId, lessonId, status })
    .run();
}

describe("listRefundRequestsForStaff", () => {
  it("lists an Open Refund Request with what Staff need to decide it", () => {
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const { open } = listRefundRequestsForStaff(testDb);

    expect(open).toEqual([
      expect.objectContaining({
        id: request.id,
        learner: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
        },
        courseTitle: "Test Course",
        amountPaid: 7900,
        purchasedAt: "2026-11-01T10:00:00.000Z",
        requestedAt: "2026-11-03T09:00:00.000Z",
        reason: "Bought the wrong one.",
      }),
    ]);
  });

  it("lists the oldest Open Refund Request first, so nobody waits longest", () => {
    const first = buy(base.user.id, base.course.id, "2026-11-01T10:00:00.000Z");
    const second = buy(
      base.instructor.id,
      base.course.id,
      "2026-10-20T10:00:00.000Z"
    );
    const newer = raiseRefundRequest(first.id, "2026-11-05T09:00:00.000Z");
    const older = raiseRefundRequest(second.id, "2026-10-25T09:00:00.000Z");

    const { open } = listRefundRequestsForStaff(testDb);

    expect(open.map((request) => request.id)).toEqual([older.id, newer.id]);
  });

  it("shows how many hours of the course the learner has watched", () => {
    const first = addLesson(base.course.id);
    const second = addLesson(base.course.id);
    watch(base.user.id, first.id, 3600);
    watch(base.user.id, second.id, 1800);
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const [request] = listRefundRequestsForStaff(testDb).open;

    expect(request.hoursWatched).toBe(1.5);
  });

  it("shows how many of the course's lessons the learner has completed", () => {
    const done = addLesson(base.course.id);
    const started = addLesson(base.course.id);
    addLesson(base.course.id);
    markLesson(base.user.id, done.id, schema.LessonProgressStatus.Completed);
    markLesson(
      base.user.id,
      started.id,
      schema.LessonProgressStatus.InProgress
    );
    // Someone else finishing a lesson is not this learner's progress.
    markLesson(
      base.instructor.id,
      started.id,
      schema.LessonProgressStatus.Completed
    );
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const [request] = listRefundRequestsForStaff(testDb).open;

    expect(request.lessonsCompleted).toBe(1);
    expect(request.totalLessons).toBe(3);
  });

  it("does not count lessons the learner completed in another course", () => {
    const otherCourse = testDb
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "Another course",
        salesCopy: "## Other Course",
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    addLesson(base.course.id);
    const elsewhere = addLesson(otherCourse.id);
    markLesson(
      base.user.id,
      elsewhere.id,
      schema.LessonProgressStatus.Completed
    );
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const [request] = listRefundRequestsForStaff(testDb).open;

    expect(request.lessonsCompleted).toBe(0);
    expect(request.totalLessons).toBe(1);
  });

  it("shows no progress for a course with no lessons", () => {
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const [request] = listRefundRequestsForStaff(testDb).open;

    expect(request.hoursWatched).toBe(0);
    expect(request.lessonsCompleted).toBe(0);
    expect(request.totalLessons).toBe(0);
  });

  it("leaves out Closed Refund Requests", () => {
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    raiseRefundRequest(
      purchase.id,
      "2026-11-02T09:00:00.000Z",
      schema.RefundStatus.Declined
    );
    raiseRefundRequest(
      purchase.id,
      "2026-11-03T09:00:00.000Z",
      schema.RefundStatus.Approved
    );
    const open = raiseRefundRequest(purchase.id, "2026-11-04T09:00:00.000Z");

    const result = listRefundRequestsForStaff(testDb);

    expect(result.open.map((request) => request.id)).toEqual([open.id]);
  });

  describe("Closed Refund Requests", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function addStaff() {
      return testDb
        .insert(schema.users)
        .values({
          name: "Staff Member",
          email: "staff@example.com",
          role: schema.UserRole.Admin,
        })
        .returning()
        .get();
    }

    function decideAt(iso: string) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(iso));
    }

    it("lists a Declined Refund Request with the outcome, decider, time and Decline Note", () => {
      const staff = addStaff();
      const purchase = buy(
        base.user.id,
        base.course.id,
        "2026-11-01T10:00:00.000Z"
      );
      const request = raiseRefundRequest(
        purchase.id,
        "2026-11-03T09:00:00.000Z"
      );
      decideAt("2026-11-04T12:00:00.000Z");
      declineRefundRequest(testDb, {
        refundRequestId: request.id,
        staffUserId: staff.id,
        declineNote: "You've watched most of the course.",
      });

      const { open, closed } = listRefundRequestsForStaff(testDb);

      expect(open).toEqual([]);
      expect(closed).toEqual([
        {
          id: request.id,
          learner: {
            id: base.user.id,
            name: "Test User",
            email: "test@example.com",
          },
          courseTitle: "Test Course",
          amountPaid: 7900,
          requestedAt: "2026-11-03T09:00:00.000Z",
          reason: "Bought the wrong one.",
          status: schema.RefundStatus.Declined,
          decidedAt: "2026-11-04T12:00:00.000Z",
          decidedBy: { id: staff.id, name: "Staff Member" },
          declineNote: "You've watched most of the course.",
        },
      ]);
    });

    it("lists the newest decision first and leaves out Open Refund Requests", () => {
      const staff = addStaff();
      const learnersPurchase = buy(
        base.user.id,
        base.course.id,
        "2026-10-01T10:00:00.000Z"
      );
      const instructorsPurchase = buy(
        base.instructor.id,
        base.course.id,
        "2026-10-02T10:00:00.000Z"
      );
      // Raised first but decided last.
      const decidedLast = raiseRefundRequest(
        learnersPurchase.id,
        "2026-10-05T09:00:00.000Z"
      );
      const decidedFirst = raiseRefundRequest(
        instructorsPurchase.id,
        "2026-10-06T09:00:00.000Z"
      );

      decideAt("2026-10-07T12:00:00.000Z");
      approveRefundRequest(testDb, {
        refundRequestId: decidedFirst.id,
        staffUserId: staff.id,
      });
      decideAt("2026-10-09T12:00:00.000Z");
      declineRefundRequest(testDb, {
        refundRequestId: decidedLast.id,
        staffUserId: staff.id,
        declineNote: "Most of the course is watched.",
      });
      const stillOpen = raiseRefundRequest(
        learnersPurchase.id,
        "2026-10-10T09:00:00.000Z"
      );

      const { open, closed } = listRefundRequestsForStaff(testDb);

      expect(open.map((request) => request.id)).toEqual([stillOpen.id]);
      expect(closed).toEqual([
        expect.objectContaining({
          id: decidedLast.id,
          status: schema.RefundStatus.Declined,
          decidedAt: "2026-10-09T12:00:00.000Z",
        }),
        expect.objectContaining({
          id: decidedFirst.id,
          learner: expect.objectContaining({ name: "Test Instructor" }),
          status: schema.RefundStatus.Approved,
          decidedAt: "2026-10-07T12:00:00.000Z",
          decidedBy: { id: staff.id, name: "Staff Member" },
          declineNote: null,
        }),
      ]);
    });
  });
});

describe("declineRefundRequest", () => {
  function findRefundRequest(id: number) {
    return testDb
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get();
  }

  function addStaff() {
    return testDb
      .insert(schema.users)
      .values({
        name: "Staff Member",
        email: "staff@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
  }

  it("stores the outcome, Decline Note, decider and time, and keeps the learner's access", () => {
    const staff = addStaff();
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    testDb
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    declineRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: staff.id,
      declineNote: "  You've watched most of the course.  ",
    });

    const declined = findRefundRequest(request.id);
    expect(declined).toMatchObject({
      status: schema.RefundStatus.Declined,
      declineNote: "You've watched most of the course.",
      resolvedByUserId: staff.id,
      amountRefunded: null,
    });
    expect(declined?.resolvedAt).toEqual(expect.any(String));
    // Declining never touches access: the learner keeps the course.
    const enrollments = testDb
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.userId, base.user.id))
      .all();
    expect(enrollments).toHaveLength(1);
  });

  // No learner is turned down without a reason.
  it.each(["", "   \n\t "])(
    "refuses a Decline Note of %j and leaves the request Open",
    (declineNote) => {
      const staff = addStaff();
      const purchase = buy(
        base.user.id,
        base.course.id,
        "2026-11-01T10:00:00.000Z"
      );
      const request = raiseRefundRequest(
        purchase.id,
        "2026-11-03T09:00:00.000Z"
      );

      expect(() =>
        declineRefundRequest(testDb, {
          refundRequestId: request.id,
          staffUserId: staff.id,
          declineNote,
        })
      ).toThrow("A Decline Note is required");

      expect(findRefundRequest(request.id)).toMatchObject({
        status: schema.RefundStatus.Open,
        declineNote: null,
        resolvedAt: null,
        resolvedByUserId: null,
      });
    }
  );

  // The first decision wins, so two Staff can't give conflicting answers.
  it.each([schema.RefundStatus.Approved, schema.RefundStatus.Declined])(
    "refuses to decline a request that is already %s, and changes nothing",
    (status) => {
      const staff = addStaff();
      const purchase = buy(
        base.user.id,
        base.course.id,
        "2026-11-01T10:00:00.000Z"
      );
      const request = raiseRefundRequest(
        purchase.id,
        "2026-11-03T09:00:00.000Z",
        status
      );

      expect(() =>
        declineRefundRequest(testDb, {
          refundRequestId: request.id,
          staffUserId: staff.id,
          declineNote: "Too late.",
        })
      ).toThrow(RefundRequestAlreadyDecidedError);

      expect(findRefundRequest(request.id)).toEqual(request);
    }
  );

  it("refuses a second decline of the same request", () => {
    const staff = addStaff();
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");
    declineRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: staff.id,
      declineNote: "First answer.",
    });

    expect(() =>
      declineRefundRequest(testDb, {
        refundRequestId: request.id,
        staffUserId: staff.id,
        declineNote: "Second answer.",
      })
    ).toThrow("This Refund Request has already been decided");

    expect(findRefundRequest(request.id)?.declineNote).toBe("First answer.");
  });

  it("returns a declined email for the learner that carries the Decline Note", () => {
    const staff = addStaff();
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const decision = declineRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: staff.id,
      declineNote: "You've watched most of the course.",
    });
    const email = buildDeclinedRefundRequestEmail(decision);

    expect(email.to).toBe("test@example.com");
    expect(email.subject).toContain("Test Course");
    expect(email.body).toContain("Hi Test User,");
    expect(email.body).toContain("You've watched most of the course.");
  });
});

describe("listRefundRequestsForLearner", () => {
  function closedRefundRequest(
    purchaseId: number,
    {
      status,
      requestedAt,
      resolvedAt,
      declineNote = null,
    }: {
      status: schema.RefundStatus;
      requestedAt: string;
      resolvedAt: string;
      declineNote?: string | null;
    }
  ) {
    return testDb
      .insert(schema.refunds)
      .values({
        purchaseId,
        status,
        reason: "Bought the wrong one.",
        requestedAt,
        resolvedAt,
        declineNote,
      })
      .returning()
      .get();
  }

  it("lists only the learner's own Refund Requests, with the course and amount", () => {
    const own = buy(base.user.id, base.course.id, "2026-11-01T10:00:00.000Z");
    const someoneElses = buy(
      base.instructor.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(own.id, "2026-11-03T09:00:00.000Z");
    raiseRefundRequest(someoneElses.id, "2026-11-04T09:00:00.000Z");

    const requests = listRefundRequestsForLearner(testDb, base.user.id);

    expect(requests).toEqual([
      {
        id: request.id,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        amountPaid: 7900,
        reason: "Bought the wrong one.",
        status: schema.RefundStatus.Open,
        requestedAt: "2026-11-03T09:00:00.000Z",
        resolvedAt: null,
        declineNote: null,
      },
    ]);
  });

  it("lists Open Refund Requests first, then Closed ones newest decision first", () => {
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-09-01T10:00:00.000Z"
    );
    const olderDecision = closedRefundRequest(purchase.id, {
      status: schema.RefundStatus.Declined,
      requestedAt: "2026-09-02T09:00:00.000Z",
      resolvedAt: "2026-09-05T09:00:00.000Z",
      declineNote: "Most of the course is watched.",
    });
    const newerDecision = closedRefundRequest(purchase.id, {
      status: schema.RefundStatus.Approved,
      requestedAt: "2026-10-01T09:00:00.000Z",
      resolvedAt: "2026-10-03T09:00:00.000Z",
    });
    const open = raiseRefundRequest(purchase.id, "2026-08-01T09:00:00.000Z");

    const requests = listRefundRequestsForLearner(testDb, base.user.id);

    expect(requests.map((request) => request.id)).toEqual([
      open.id,
      newerDecision.id,
      olderDecision.id,
    ]);
  });

  it("shows a Declined Refund Request with its Decline Note and decision date", () => {
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");
    declineRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: base.instructor.id,
      declineNote: "You've watched most of the course.",
    });

    const [declined] = listRefundRequestsForLearner(testDb, base.user.id);

    expect(declined).toMatchObject({
      id: request.id,
      status: schema.RefundStatus.Declined,
      declineNote: "You've watched most of the course.",
      resolvedAt: expect.any(String),
    });
  });
});

describe("approveRefundRequest", () => {
  function staff() {
    return testDb
      .insert(schema.users)
      .values({
        name: "Staff Member",
        email: "staff@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
  }

  function findRefundRequest(id: number) {
    return testDb
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get();
  }

  it("approves the request for the full amount paid, recording who decided and when", () => {
    const decider = staff();
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: decider.id,
    });

    const approved = findRefundRequest(request.id);
    expect(approved).toMatchObject({
      status: schema.RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: decider.id,
    });
    expect(approved?.resolvedAt).toEqual(expect.any(String));
  });

  function enroll(learnerId: number, courseId: number) {
    testDb
      .insert(schema.enrollments)
      .values({ userId: learnerId, courseId })
      .run();
  }

  function enrolledLearnerIds(courseId: number) {
    return testDb
      .select({ userId: schema.enrollments.userId })
      .from(schema.enrollments)
      .where(eq(schema.enrollments.courseId, courseId))
      .all()
      .map((row) => row.userId);
  }

  it("removes every enrollment the learner has for the course, so they lose access", () => {
    const decider = staff();
    // Nothing enforces one enrollment per learner and course, so a learner
    // can hold two rows. Leaving either behind would keep the course open.
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, base.course.id);
    // Another learner on the same course keeps their access.
    enroll(base.instructor.id, base.course.id);
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: decider.id,
    });

    expect(enrolledLearnerIds(base.course.id)).toEqual([base.instructor.id]);
  });

  it("keeps the learner's progress, watch history, quiz attempts and rating", () => {
    // ADR 0001: approval removes the enrollment only. The history is kept in
    // case the refund is disputed, and so a re-purchase picks up where it left off.
    const decider = staff();
    const lesson = addLesson(base.course.id);
    markLesson(base.user.id, lesson.id, schema.LessonProgressStatus.Completed);
    watch(base.user.id, lesson.id, 600);
    const quiz = testDb
      .insert(schema.quizzes)
      .values({ lessonId: lesson.id, title: "Quiz", passingScore: 0.7 })
      .returning()
      .get();
    testDb
      .insert(schema.quizAttempts)
      .values({
        userId: base.user.id,
        quizId: quiz.id,
        score: 0.9,
        passed: true,
      })
      .run();
    testDb
      .insert(schema.courseRatings)
      .values({ userId: base.user.id, courseId: base.course.id, rating: 4 })
      .run();
    enroll(base.user.id, base.course.id);
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: decider.id,
    });

    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(1);
    expect(testDb.select().from(schema.videoWatchEvents).all()).toHaveLength(1);
    expect(testDb.select().from(schema.quizAttempts).all()).toHaveLength(1);
    expect(testDb.select().from(schema.courseRatings).all()).toHaveLength(1);
  });

  it("refuses a Closed request and changes nothing, so the first decision wins", () => {
    const decider = staff();
    enroll(base.user.id, base.course.id);
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const declined = raiseRefundRequest(
      purchase.id,
      "2026-11-03T09:00:00.000Z",
      schema.RefundStatus.Declined
    );

    expect(() =>
      approveRefundRequest(testDb, {
        refundRequestId: declined.id,
        staffUserId: decider.id,
      })
    ).toThrow(new RefundRequestAlreadyDecidedError());

    expect(findRefundRequest(declined.id)).toEqual(declined);
    expect(enrolledLearnerIds(base.course.id)).toEqual([base.user.id]);
  });

  it("refuses a second approval of the same request", () => {
    const decider = staff();
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");
    approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: decider.id,
    });
    const afterFirst = findRefundRequest(request.id);

    expect(() =>
      approveRefundRequest(testDb, {
        refundRequestId: request.id,
        staffUserId: base.instructor.id,
      })
    ).toThrow("This Refund Request has already been decided");
    expect(findRefundRequest(request.id)).toEqual(afterFirst);
  });

  it("returns what the learner's approved email needs: who, which course and how much", () => {
    const decider = staff();
    const purchase = buy(
      base.user.id,
      base.course.id,
      "2026-11-01T10:00:00.000Z"
    );
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    const approved = approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: decider.id,
    });
    const email = buildApprovedRefundRequestEmail(approved);

    expect(email.to).toBe("test@example.com");
    expect(email.subject).toContain("Test Course");
    expect(email.body).toContain("Hi Test User,");
    expect(email.body).toContain("$79.00");
  });
});

describe("approving a Team purchase", () => {
  function buyTeamSeats(buyerId: number, seats: number) {
    const team = testDb.insert(schema.teams).values({}).returning().get();
    const purchase = buy(buyerId, base.course.id, "2026-11-01T10:00:00.000Z");
    const codes = Array.from({ length: seats }, (_, i) => {
      const code = `SEAT-${purchase.id}-${i}`;
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          purchaseId: purchase.id,
          code,
        })
        .run();
      return code;
    });
    return { purchase, codes };
  }

  it("voids every unclaimed Team Seat of the purchase, so none can be redeemed", () => {
    const { purchase, codes } = buyTeamSeats(base.user.id, 3);
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: base.instructor.id,
    });

    expect(codes.map((code) => isTeamSeatRedeemable(testDb, code))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("leaves Team Seats of other purchases redeemable", () => {
    const refunded = buyTeamSeats(base.user.id, 2);
    const other = buyTeamSeats(base.instructor.id, 2);
    const request = raiseRefundRequest(
      refunded.purchase.id,
      "2026-11-03T09:00:00.000Z"
    );

    approveRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: base.instructor.id,
    });

    expect(
      other.codes.map((code) => isTeamSeatRedeemable(testDb, code))
    ).toEqual([true, true]);
  });

  it("treats an unvoided, unclaimed Team Seat as redeemable", () => {
    const { codes } = buyTeamSeats(base.user.id, 1);

    expect(isTeamSeatRedeemable(testDb, codes[0])).toBe(true);
  });

  it("does not void Team Seats when the Refund Request is declined", () => {
    const { purchase, codes } = buyTeamSeats(base.user.id, 1);
    const request = raiseRefundRequest(purchase.id, "2026-11-03T09:00:00.000Z");

    declineRefundRequest(testDb, {
      refundRequestId: request.id,
      staffUserId: base.instructor.id,
      declineNote: "Seats were shared already.",
    });

    expect(isTeamSeatRedeemable(testDb, codes[0])).toBe(true);
  });
});
