/**
 * Sends a built email. There is no mail transport yet, so the message is
 * written to the server log in the `[email] to=... subject=...` format.
 */
export function sendEmail(email: {
  to: string;
  subject: string;
  body: string;
}) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
