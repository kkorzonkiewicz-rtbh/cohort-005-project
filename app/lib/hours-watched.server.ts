import { and, eq, sql } from "drizzle-orm";
import type { Db } from "~/db";
import { lessons, modules, videoWatchEvents } from "~/db/schema";

const SECONDS_PER_HOUR = 60 * 60;

/**
 * How much of a course a learner has watched: for each of the course's
 * lessons, the furthest position they reached, summed. Rewatching a stretch
 * or skipping back does not add to it.
 */
export function getHoursWatched(
  db: Db,
  learnerId: number,
  courseId: number
): number {
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .innerJoin(lessons, eq(videoWatchEvents.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(
      and(
        eq(videoWatchEvents.userId, learnerId),
        eq(modules.courseId, courseId)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  const secondsWatched = furthestPerLesson.reduce(
    (total, row) => total + row.furthest,
    0
  );

  return secondsWatched / SECONDS_PER_HOUR;
}
