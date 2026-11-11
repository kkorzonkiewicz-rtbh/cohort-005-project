import { RefundStatus } from "~/db/schema";
import { cn } from "~/lib/utils";

const refundRequestStatusBadges = {
  [RefundStatus.Open]: {
    label: "Open",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  [RefundStatus.Approved]: {
    label: "Approved",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  },
  [RefundStatus.Declined]: {
    label: "Declined",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  },
} satisfies Record<RefundStatus, { label: string; className: string }>;

/** Whether a Refund Request is Open, or Closed as Approved or Declined. */
export function RefundRequestStatusBadge({ status }: { status: RefundStatus }) {
  const badge = refundRequestStatusBadges[status];
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
        badge.className
      )}
    >
      {badge.label}
    </span>
  );
}
