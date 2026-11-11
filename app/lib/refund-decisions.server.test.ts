import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { listRefundRequestsForStaff } from "./refund-decisions.server";

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
