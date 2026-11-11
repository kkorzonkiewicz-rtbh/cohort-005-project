import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import {
  approveRefundRequest,
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

  it("returns who to email, about which course and for how much", () => {
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

    expect(approved).toEqual({
      learner: {
        id: base.user.id,
        name: "Test User",
        email: "test@example.com",
      },
      courseTitle: "Test Course",
      amountRefunded: 7900,
    });
  });
});
