import { and, asc, desc, eq, sql } from "drizzle-orm";
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
import { formatPrice } from "~/lib/utils";

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

export function listRefundRequestsForLearner(db: Db, userId: number) {
  return db
    .select({
      id: refunds.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refunds.reason,
      status: refunds.status,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      declineNote: refunds.declineNote,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, userId))
    .orderBy(
      // Open Refund Requests first, then Closed ones newest decision first.
      sql`case when ${refunds.status} = ${RefundStatus.Open} then 0 else 1 end`,
      desc(refunds.resolvedAt),
      desc(refunds.requestedAt)
    )
    .all();
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

export class DeclineNoteRequiredError extends Error {
  constructor() {
    super("A Decline Note is required to decline a Refund Request");
    this.name = "DeclineNoteRequiredError";
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

export function declineRefundRequest(
  db: Db,
  {
    refundRequestId,
    staffUserId,
    declineNote,
  }: { refundRequestId: number; staffUserId: number; declineNote: string }
) {
  const note = declineNote.trim();
  if (note === "") throw new DeclineNoteRequiredError();

  return db.transaction((tx) => {
    // Conditional on the request still being Open, so a concurrent second
    // decision changes no rows and is refused: the first decision wins.
    const { changes } = tx
      .update(refunds)
      .set({
        status: RefundStatus.Declined,
        declineNote: note,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: staffUserId,
      })
      .where(
        and(
          eq(refunds.id, refundRequestId),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .run();
    if (changes === 0) throw new RefundRequestAlreadyDecidedError();

    const declined = tx
      .select({
        learner: { name: users.name, email: users.email },
        courseTitle: courses.title,
      })
      .from(refunds)
      .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
      .innerJoin(users, eq(purchases.userId, users.id))
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(refunds.id, refundRequestId))
      .get();
    if (!declined) throw new RefundRequestAlreadyDecidedError();

    return { ...declined, declineNote: note };
  });
}

/**
 * The learner's email when Staff approve their Refund Request. There is no
 * mail transport yet, so the caller writes the built message to the server log.
 */
export function buildApprovedRefundRequestEmail(decision: {
  learner: { name: string; email: string };
  courseTitle: string;
  amountRefunded: number;
}) {
  return {
    to: decision.learner.email,
    subject: `Refund request approved — ${decision.courseTitle}`,
    body: [
      `Hi ${decision.learner.name},`,
      "",
      `We have approved your refund request for "${decision.courseTitle}".`,
      `Your refund of ${formatPrice(decision.amountRefunded)}, the full amount you paid, is on its way.`,
      "",
      "You no longer have access to the course. Your progress is kept, so if you buy it again you will pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/**
 * The learner's email when Staff decline their Refund Request. There is no
 * mail transport yet, so the caller writes the built message to the server log.
 */
export function buildDeclinedRefundRequestEmail(decision: {
  learner: { name: string; email: string };
  courseTitle: string;
  declineNote: string;
}) {
  return {
    to: decision.learner.email,
    subject: `Refund request declined — ${decision.courseTitle}`,
    body: [
      `Hi ${decision.learner.name},`,
      "",
      `We have reviewed your refund request for "${decision.courseTitle}" and declined it.`,
      "",
      "Note from our team:",
      decision.declineNote,
      "",
      "You still have access to the course. If something has changed, you can raise a new refund request from the course page.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
