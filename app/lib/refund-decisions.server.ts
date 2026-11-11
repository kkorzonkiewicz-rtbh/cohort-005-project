import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
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

export class DeclineNoteRequiredError extends Error {
  constructor() {
    super("A Decline Note is required to decline a Refund Request");
    this.name = "DeclineNoteRequiredError";
  }
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
