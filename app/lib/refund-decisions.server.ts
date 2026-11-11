import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { getHoursWatched } from "~/lib/hours-watched.server";

function countLessons(db: Db, courseId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .get();

  return result?.count ?? 0;
}

function countLessonsCompleted(db: Db, learnerId: number, courseId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(
      and(
        eq(lessonProgress.userId, learnerId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        eq(modules.courseId, courseId)
      )
    )
    .get();

  return result?.count ?? 0;
}

export function listRefundRequestsForStaff(db: Db) {
  const rows = db
    .select({
      id: refunds.id,
      learner: { id: users.id, name: users.name, email: users.email },
      courseId: courses.id,
      courseTitle: courses.title,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      requestedAt: refunds.requestedAt,
      reason: refunds.reason,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt))
    .all();

  const open = rows.map(({ courseId, ...request }) => ({
    ...request,
    hoursWatched: getHoursWatched(db, request.learner.id, courseId),
    lessonsCompleted: countLessonsCompleted(db, request.learner.id, courseId),
    totalLessons: countLessons(db, courseId),
  }));

  return { open };
}

export class RefundRequestAlreadyDecidedError extends Error {
  constructor() {
    super("This Refund Request has already been decided");
    this.name = "RefundRequestAlreadyDecidedError";
  }
}

export class RefundRequestNotFoundError extends Error {
  constructor() {
    super("Refund Request not found");
    this.name = "RefundRequestNotFoundError";
  }
}

/**
 * Approves an Open Refund Request. The full amount paid becomes the Refund
 * (an approved request with `amountRefunded` set is the Pending Refund), and
 * the learner loses access by losing every enrollment row for the course.
 * Progress, watch events, quiz attempts and ratings are kept (ADR 0001).
 *
 * The update only matches an Open request, so when two Staff decide at once
 * the first decision wins and the second is refused.
 *
 * Returns what the learner's approved email needs.
 */
export function approveRefundRequest(
  db: Db,
  input: { refundRequestId: number; staffUserId: number }
) {
  return db.transaction((tx) => {
    const request = tx
      .select({
        amountPaid: purchases.amountPaid,
        courseId: purchases.courseId,
        courseTitle: courses.title,
        learner: { id: users.id, name: users.name, email: users.email },
      })
      .from(refunds)
      .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
      .innerJoin(users, eq(purchases.userId, users.id))
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(refunds.id, input.refundRequestId))
      .get();

    if (!request) throw new RefundRequestNotFoundError();

    const approved = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: request.amountPaid,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: input.staffUserId,
      })
      .where(
        and(
          eq(refunds.id, input.refundRequestId),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .returning({ amountRefunded: refunds.amountRefunded })
      .get();

    if (!approved) throw new RefundRequestAlreadyDecidedError();

    // Nothing enforces one enrollment per learner and course, so remove them all.
    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, request.learner.id),
          eq(enrollments.courseId, request.courseId)
        )
      )
      .run();

    return {
      learner: request.learner,
      courseTitle: request.courseTitle,
      amountRefunded: request.amountPaid,
    };
  });
}
