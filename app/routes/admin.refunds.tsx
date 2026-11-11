import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { RefundStatus, UserRole, users } from "~/db/schema";
import { db } from "~/db";
import {
  approveRefundRequest,
  buildApprovedRefundRequestEmail,
  buildDeclinedRefundRequestEmail,
  declineRefundRequest,
  DeclineNoteRequiredError,
  listRefundRequestsForStaff,
  RefundRequestAlreadyDecidedError,
  RefundRequestNotFoundError,
  TeamSeatClaimedError,
} from "~/lib/refund-decisions.server";
import { sendEmail } from "~/lib/email.server";
import { RefundRequestStatusBadge } from "~/components/refund-request-status-badge";
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
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, ReceiptText } from "lucide-react";

const refundDecisionActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineNote: z
      .string()
      .trim()
      .min(1, "Write a Decline Note so the learner knows why."),
  }),
]);

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Decide learners' Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
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

  const { open, closed } = listRefundRequestsForStaff(db);

  return { open, closed };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data(
      "Select a user from the DevUI panel to decide Refund Requests.",
      {
        status: 401,
      }
    );
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Staff can decide Refund Requests.", { status: 403 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionActionSchema);

  if (!parsed.success) {
    throw data(Object.values(parsed.errors)[0] ?? "Invalid input.", {
      status: 400,
    });
  }

  try {
    if (parsed.data.intent === "approve") {
      const decision = approveRefundRequest(db, {
        refundRequestId: parsed.data.refundRequestId,
        staffUserId: currentUser.id,
      });
      sendEmail(buildApprovedRefundRequestEmail(decision));

      return {
        message: `Approved the ${formatPrice(decision.amountRefunded)} refund to ${decision.learner.name}.`,
      };
    }

    const decision = declineRefundRequest(db, {
      refundRequestId: parsed.data.refundRequestId,
      staffUserId: currentUser.id,
      declineNote: parsed.data.declineNote,
    });
    sendEmail(buildDeclinedRefundRequestEmail(decision));

    return { message: "Refund Request declined." };
  } catch (e) {
    if (e instanceof RefundRequestNotFoundError) {
      throw data(e.message, { status: 404 });
    }
    if (
      e instanceof RefundRequestAlreadyDecidedError ||
      e instanceof TeamSeatClaimedError
    ) {
      throw data(e.message, { status: 409 });
    }
    if (e instanceof DeclineNoteRequiredError) {
      throw data(e.message, { status: 400 });
    }
    throw e;
  }
}

/** Shows a toast with the decision once the fetcher's action succeeds. */
function useDecisionToast(
  fetcher: ReturnType<typeof useFetcher<typeof action>>
) {
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);
}

function DeclineRefundRequestForm({ requestId }: { requestId: number }) {
  const [declineNote, setDeclineNote] = useState("");
  const fetcher = useFetcher<typeof action>();

  useDecisionToast(fetcher);

  const noteId = `decline-note-${requestId}`;

  return (
    <fetcher.Form method="post" className="space-y-2 border-t pt-4">
      <input type="hidden" name="intent" value="decline" />
      <input type="hidden" name="refundRequestId" value={requestId} />
      <Label htmlFor={noteId}>Decline Note</Label>
      <Textarea
        id={noteId}
        name="declineNote"
        value={declineNote}
        onChange={(e) => setDeclineNote(e.target.value)}
        placeholder="Tell the learner why their Refund Request is declined."
        required
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="outline"
          disabled={!declineNote.trim() || fetcher.state !== "idle"}
        >
          Decline
        </Button>
      </div>
    </fetcher.Form>
  );
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

  useDecisionToast(fetcher);

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

        <div className="flex justify-end">
          <ApproveRefundRequestButton request={request} />
        </div>

        <DeclineRefundRequestForm requestId={request.id} />
      </CardContent>
    </Card>
  );
}

type ClosedRefundRequest = Route.ComponentProps["loaderData"]["closed"][number];

function ClosedRefundRequestCard({
  request,
}: {
  request: ClosedRefundRequest;
}) {
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
            <dt className="text-muted-foreground">Outcome</dt>
            <dd>
              <RefundRequestStatusBadge status={request.status} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Closed by</dt>
            <dd>{request.closedBy?.name ?? "Unknown"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Closed</dt>
            <dd>{request.closedAt ? formatDate(request.closedAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Requested</dt>
            <dd>{formatDate(request.requestedAt)}</dd>
          </div>
        </dl>

        <div className="text-sm">
          <p className="mb-1 text-muted-foreground">Reason</p>
          <p className="whitespace-pre-wrap">{request.reason}</p>
        </div>

        {request.status === RefundStatus.Declined && request.declineNote && (
          <div className="text-sm">
            <p className="mb-1 text-muted-foreground">Decline Note</p>
            <p className="whitespace-pre-wrap">{request.declineNote}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function StaffRefundRequests({
  loaderData,
}: Route.ComponentProps) {
  const { open, closed } = loaderData;

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
          Open Refund Requests oldest first, then Closed ones most recently
          closed first
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

      <h2 className="mt-10 mb-4 text-lg font-semibold">
        Closed ({closed.length})
      </h2>

      {closed.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              No Closed Refund Requests yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {closed.map((request) => (
            <ClosedRefundRequestCard key={request.id} request={request} />
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
    } else if (error.status === 409) {
      title = "Refund Request not changed";
      message = typeof error.data === "string" ? error.data : error.statusText;
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
          <Link to="/admin/refunds">
            <Button>Back to Refund Requests</Button>
          </Link>
          <Link to="/">
            <Button variant="outline">Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
