import { and, asc, eq, sql } from "drizzle-orm";
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
