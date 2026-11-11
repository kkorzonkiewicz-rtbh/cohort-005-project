import { useEffect } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { eq } from "drizzle-orm";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { UserRole, users } from "~/db/schema";
import { db } from "~/db";
import {
  approveRefundRequest,
  listRefundRequestsForStaff,
  RefundRequestAlreadyDecidedError,
  RefundRequestNotFoundError,
} from "~/lib/refund-decisions.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { AlertTriangle, ReceiptText } from "lucide-react";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Decide learners' Refund Requests" },
  ];
}

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
]);

async function requireStaff(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to see Refund Requests.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Staff can see Refund Requests.", { status: 403 });
  }

  return currentUser;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireStaff(request);

  const { open } = listRefundRequestsForStaff(db);

  return { open };
}

/**
 * The learner's approved email. There is no mail transport wired up yet, so
 * the built message goes to the server log.
 */
function buildRefundApprovedEmail(approved: {
  learner: { name: string; email: string };
  courseTitle: string;
  amountRefunded: number;
}) {
  return {
    to: approved.learner.email,
    subject: `Refund approved — ${approved.courseTitle}`,
    body: [
      `Hi ${approved.learner.name},`,
      "",
      `We've approved your Refund Request for "${approved.courseTitle}".`,
      `Your Refund of ${formatPrice(approved.amountRefunded)}, the full amount you paid, is on its way.`,
      "",
      "You no longer have access to the course. Your progress is kept, so if you buy it again you'll pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const staff = await requireStaff(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  if (parsed.data.intent === "approve") {
    try {
      const approved = approveRefundRequest(db, {
        refundRequestId: parsed.data.refundRequestId,
        staffUserId: staff.id,
      });

      const email = buildRefundApprovedEmail(approved);
      console.log(
        `[email] to=${email.to} subject=${email.subject}\n${email.body}`
      );

      return {
        success: true,
        message: `Approved the ${formatPrice(approved.amountRefunded)} refund to ${approved.learner.name}.`,
      };
    } catch (e) {
      if (e instanceof RefundRequestAlreadyDecidedError) {
        return data({ error: e.message }, { status: 409 });
      }
      if (e instanceof RefundRequestNotFoundError) {
        return data({ error: e.message }, { status: 404 });
      }
      throw e;
    }
  }

  throw data("Invalid action.", { status: 400 });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatHours(hours: number) {
  return `${hours.toFixed(1)} ${hours === 1 ? "hour" : "hours"}`;
}

type OpenRefundRequest = Route.ComponentProps["loaderData"]["open"][number];

function ApproveRefundRequestButton({
  request,
}: {
  request: OpenRefundRequest;
}) {
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data) toast.error(fetcher.data.error);
    else toast.success(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  function approve() {
    fetcher.submit(
      { intent: "approve", refundRequestId: request.id },
      { method: "post" }
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" disabled={fetcher.state !== "idle"}>
          Approve
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve this Refund Request?</AlertDialogTitle>
          <AlertDialogDescription>
            Approve the {formatPrice(request.amountPaid)} refund to{" "}
            {request.learner.name}? They'll lose access to {request.courseTitle}
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={approve}>
            Approve refund
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OpenRefundRequestCard({ request }: { request: OpenRefundRequest }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-medium">{request.learner.name}</p>
            <p className="text-sm text-muted-foreground">
              {request.learner.email}
            </p>
          </div>
          <div className="text-right">
            <p className="font-medium">{formatPrice(request.amountPaid)}</p>
            <p className="text-sm text-muted-foreground">
              {request.courseTitle}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Purchased</dt>
            <dd>{formatDate(request.purchasedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Requested</dt>
            <dd>{formatDate(request.requestedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Watched</dt>
            <dd>{formatHours(request.hoursWatched)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lessons completed</dt>
            <dd>
              {request.lessonsCompleted} of {request.totalLessons}
            </dd>
          </div>
        </dl>

        <div className="text-sm">
          <p className="mb-1 text-muted-foreground">Reason</p>
          <p className="whitespace-pre-wrap">{request.reason}</p>
        </div>

        <div className="flex justify-end gap-2">
          <ApproveRefundRequestButton request={request} />
        </div>
      </CardContent>
    </Card>
  );
}

export default function StaffRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { open } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Open Refund Requests, oldest first
        </p>
      </div>

      <h2 className="mb-4 text-lg font-semibold">Open ({open.length})</h2>

      {open.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No Open Refund Requests. Nobody is waiting.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {open.map((request) => (
            <OpenRefundRequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only Staff can see Refund Requests.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
